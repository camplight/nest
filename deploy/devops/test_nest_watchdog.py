import fcntl
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('watchdog', Path(__file__).with_name('nest-watchdog.py'))
watchdog = importlib.util.module_from_spec(spec)
spec.loader.exec_module(watchdog)


def observed(health='unhealthy', status='running', started='boot-1'):
    return {'status': status, 'startedAt': started, 'health': health, 'oomKilled': False}


class WatchdogTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.state = self.root / 'state/state.json'
        self.lock = self.root / 'operations/deployment.lock'
        for name, value in [('STATE', self.state), ('DEPLOY_LOCK', self.lock)]:
            p = patch.object(watchdog, name, value)
            p.start()
            self.addCleanup(p.stop)

    def test_requires_three_consecutive_known_unhealthy_checks(self):
        state = {}
        for now in [100, 160]:
            state, action = watchdog.evaluate(state, observed(), now)
            self.assertEqual(action, 'observe')
        state, action = watchdog.evaluate(state, observed(), 220)
        self.assertEqual(action, 'restart')
        self.assertEqual(state['lastRestartAt'], 220)
        self.assertEqual(state['failures'], 0)

    def test_healthy_starting_stopped_and_recreated_reset_failure_streak(self):
        for value in [observed('healthy'), observed('starting'), observed(status='exited'),
                      observed(health=None), observed(started='boot-2')]:
            with self.subTest(value=value):
                state, action = watchdog.evaluate({'startedAt': 'boot-1', 'failures': 2}, value, 200)
                self.assertEqual(action, 'observe')
                self.assertLess(state['failures'], 3)

    def test_cooldown_survives_container_restart_and_eventually_expires(self):
        state = {'startedAt': 'boot-1', 'failures': 2, 'lastRestartAt': 100}
        state, action = watchdog.evaluate(state, observed(), 200)
        self.assertEqual(action, 'cooldown')
        state, _ = watchdog.evaluate(state, observed(started='boot-2'), 250)
        self.assertEqual(state['lastRestartAt'], 100)
        for now in [310, 370]:
            state, action = watchdog.evaluate(state, observed(started='boot-2'), now)
        self.assertEqual(action, 'cooldown')
        state, action = watchdog.evaluate(state, observed(started='boot-2'), 3700)
        self.assertEqual(action, 'restart')

    def test_deployment_lock_prevents_inspection_and_restart(self):
        self.lock.parent.mkdir()
        with self.lock.open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with patch.object(watchdog, 'run') as run:
                watchdog.recover()
                run.assert_not_called()
        self.assertFalse(self.state.exists())

    def test_docker_failure_resets_streak_and_never_restarts(self):
        self.state.parent.mkdir()
        self.state.write_text(json.dumps({'startedAt': 'boot-1', 'failures': 2}))
        with patch.object(watchdog, 'run', side_effect=subprocess.TimeoutExpired('docker', 15)) as run:
            watchdog.recover()
        self.assertEqual(run.call_count, 1)
        self.assertEqual(json.loads(self.state.read_text())['failures'], 0)

    def test_corrupt_state_fails_closed_instead_of_disabling_cooldown(self):
        self.state.parent.mkdir()
        for value in ['broken', '[]', '{"lastRestartAt":"bad"}', '{"failures":-1}']:
            self.state.write_text(value)
            with patch.object(watchdog, 'run') as run:
                watchdog.recover()
                run.assert_not_called()

    def test_restart_is_fixed_command_and_failure_cannot_trigger_restart_loop(self):
        self.state.parent.mkdir()
        self.state.write_text(json.dumps({'startedAt': 'boot-1', 'failures': 2}))
        raw = json.dumps({'Status': 'running', 'StartedAt': 'boot-1',
                          'Health': {'Status': 'unhealthy'}, 'OOMKilled': False})
        with patch.object(watchdog.time, 'time', return_value=1000), patch.object(
            watchdog, 'run', side_effect=[raw, '20% 1GiB / 1.5GiB 100', subprocess.TimeoutExpired('restart', 90)]
        ) as run:
            with self.assertRaises(subprocess.TimeoutExpired):
                watchdog.recover()
        self.assertEqual(run.call_args.args, ('docker', 'restart', '--time', '30', 'nest-nest-1'))
        self.assertEqual(json.loads(self.state.read_text())['lastRestartAt'], 1000)
        with patch.object(watchdog.time, 'time', return_value=1100), patch.object(watchdog, 'run', return_value=raw) as run:
            watchdog.recover()
            self.assertEqual(run.call_count, 1)
        self.assertEqual(self.state.stat().st_mode & 0o777, 0o600)

    def test_invalid_inspection_is_not_a_reason_to_restart(self):
        for raw in ['[]', '{}', 'broken']:
            with patch.object(watchdog, 'run', return_value=raw) as run:
                watchdog.recover()
                self.assertEqual(run.call_count, 1)



class NativeWatchdogTests(unittest.TestCase):
    def test_healthy_native_services_use_http_and_systemd_metadata_only(self):
        from contextlib import nullcontext
        from types import SimpleNamespace
        with patch.object(watchdog, 'run', return_value='ActiveState=active\nActiveEnterTimestampMonotonic=123\n') as command, patch.object(watchdog.urllib.request, 'urlopen', side_effect=lambda *a, **k: nullcontext(SimpleNamespace(status=200))):
            result = watchdog.inspect_native()
        self.assertEqual(result['health'], 'healthy')
        self.assertTrue(all(c.args[0] == 'systemctl' for c in command.call_args_list))

    def test_manual_stop_does_not_trigger_health_restart(self):
        with patch.object(watchdog, 'run', return_value='ActiveState=inactive\nActiveEnterTimestampMonotonic=123\n'):
            result = watchdog.inspect_native()
        state, action = watchdog.evaluate({'failures': 2}, result, 10000)
        self.assertEqual(action, 'observe')
        self.assertEqual(state['failures'], 0)

    def test_native_failure_recovers_host_units_without_docker(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            state = root / 'state.json'
            state.write_text(json.dumps({'startedAt': 'boot-1', 'failures': 2}))
            marker = root / 'native.json'
            marker.write_text('{}')
            with patch.object(watchdog, 'STATE', state), patch.object(watchdog, 'DEPLOY_LOCK', root / 'lock'), patch.object(watchdog, 'NATIVE_CONFIG', marker), patch.object(watchdog, 'inspect', return_value=observed()), patch.object(watchdog, 'run') as command:
                watchdog.recover()
            self.assertEqual(command.call_args_list[0].args[:2], ('systemctl', 'stop'))
            self.assertTrue(all('docker' not in c.args for c in command.call_args_list))
            self.assertIn('lastRestartAt', json.loads(state.read_text()))

if __name__ == '__main__':
    unittest.main()
