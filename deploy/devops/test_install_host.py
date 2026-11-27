"""Run installer control-flow slices with temporary paths and simulated systemd/Docker."""
import json
from pathlib import Path
import re
import sqlite3
import subprocess
import tempfile
import unittest

SOURCE = (Path(__file__).resolve().parents[2] / 'scripts/install-host.sh').read_text()


class InstallerTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        for name in ('etc/nest', 'etc/systemd/system', 'var/lib/nest', 'opt/nest', 'usr/local/bin',
                     'usr/local/lib/nest-ops', 'backup/config', 'backup/units', 'backup/commands'):
            (self.root / name).mkdir(parents=True, exist_ok=True)

    def bash(self, script):
        # Rewrite all privileged paths in the tested slices. No real host units or data.
        script = re.sub(r'(?<![A-Za-z0-9_])(/(?:var/lib|etc|usr/local|opt/nest|app)\b)',
                        lambda match: str(self.root) + match[0], script)
        return subprocess.run(['bash', '-e', '-u', '-o', 'pipefail', '-c', script], cwd=self.root,
                              text=True, capture_output=True, timeout=10)

    def recover(self, *, docker=False, cutoff=False, state='inactive'):
        if docker:
            (self.root / 'backup/docker.json').write_text(json.dumps([
                {'Id': name, 'HostConfig': {'RestartPolicy': {'Name': 'unless-stopped', 'MaximumRetryCount': 0}}}
                for name in ('engine-container', 'caddy-container')]))
        (self.root / 'var/lib/nest-watchdog').mkdir()
        marker = self.root / 'var/lib/nest-watchdog/recovery-required'
        marker.touch()
        if cutoff:
            (self.root / 'opt/nest/candidate').mkdir()
            (self.root / 'app').symlink_to(self.root / 'opt/nest/candidate')
            with sqlite3.connect(self.root / 'var/lib/nest/live.sqlite') as db:
                db.execute("CREATE TABLE events (message TEXT)")
                db.execute("INSERT INTO events VALUES ('written after cutoff')")
        snippet = SOURCE.split('recover() {', 1)[1].split("trap 'false' TERM", 1)[0]
        prelude = f"""
backup=$PWD/backup
operation_id={'a' * 32}
restore_watchdog=0
old_release=
managed_operation=
export PATH="$PWD/bin:$PATH"
activation() {{
  printf 'activation %s\\n' "$1" >> commands
  if [[ $1 == rollback_allowed ]]; then return {1 if cutoff else 0}; fi
  if [[ $1 == clear ]]; then rm /var/lib/nest-watchdog/recovery-required; fi
}}
systemctl() {{
  printf 'systemctl %s\\n' "$*" >> commands
  case $1 in
    stop) return 5;; # e.g. stop when one or more native units are not loaded
    show) printf '%s\\n' {state};;
    *) return 0;;
  esac
}}
rsync() {{ :; }}
sync() {{ :; }}
install() {{ :; }}
"""
        (self.root / 'bin').mkdir()
        docker_stub = self.root / 'bin/docker'
        docker_stub.write_text('#!/bin/sh\nprintf "docker %s\\n" "$*" >> commands\n')
        docker_stub.chmod(0o755)
        result = self.bash(prelude + '\nrecover() {' + snippet + '\nfalse\n')
        return result, (self.root / 'commands').read_text(), marker

    def test_missing_native_units_do_not_abort_first_install_rollback(self):
        result, commands, marker = self.recover()
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn('Activation failed; rollback completed', result.stderr)
        self.assertIn('activation restore\n', commands)
        self.assertFalse(marker.exists())

    def test_missing_native_units_do_not_leave_docker_import_stopped(self):
        result, commands, marker = self.recover(docker=True)
        self.assertEqual(result.returncode, 1, result.stderr)
        for name in ('engine-container', 'caddy-container'):
            self.assertIn(f'docker update --restart=unless-stopped {name}\n', commands)
            self.assertIn(f'docker start {name}\n', commands)
        self.assertFalse(marker.exists())

    def test_rollback_never_replaces_state_if_a_unit_did_not_stop(self):
        result, commands, marker = self.recover(state='active')
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('activation restore\n', commands)
        self.assertTrue(marker.exists())

    def test_post_cutoff_unmanaged_failure_keeps_live_write_and_gate(self):
        result, commands, marker = self.recover(cutoff=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('activation restore\n', commands)
        self.assertIn('activation failed\n', commands)
        self.assertTrue(marker.exists())
        self.assertEqual((self.root / 'app').resolve(), self.root / 'opt/nest/candidate')
        with sqlite3.connect(self.root / 'var/lib/nest/live.sqlite') as db:
            self.assertEqual(db.execute('SELECT message FROM events').fetchone(), ('written after cutoff',))

    def test_managed_installer_uses_host_copy_even_if_bundle_helper_differs(self):
        (self.root / 'bundle/deploy/native').mkdir(parents=True)
        (self.root / 'bundle/deploy/native/activation.py').write_text('raise SystemExit("incompatible bundled helper")\n')
        host = self.root / 'usr/local/lib/nest-ops/activation.py'
        host.write_text('import sys\nprint("host", sys.argv[1])\n')
        snippet = SOURCE.split('managed_operation=${NEST_HOST_OPERATION_ID:-}', 1)[1].split('finish() {', 1)[0]
        prelude = f"""
NEST_HOST_OPERATION_ID={'a' * 32}
NEST_HOST_LOCK_FD=9
root=$PWD/bundle
import_docker=0
node_dir=$PWD/tools
readlink() {{ printf '%s\\n' /opt/nest/operations/deployment.lock; }}
systemctl() {{ printf '/etc/systemd/system/%s.d/nest-activation.conf\\n' "$2"; }}
mkdir -p "$node_dir/bin"
printf '#!/bin/sh\\nfor i in 1 2 3 4; do shift; done\\nexec /usr/bin/python3 -I "$@"\\n' > "$node_dir/bin/node"
chmod +x "$node_dir/bin/node"
for unit in nest-api nest-engine nest-runner nest-caddy nest-livekit; do
  mkdir -p "/etc/systemd/system/$unit.service.d"
  printf '%s\\n' 'ExecCondition=+/usr/bin/python3 -I /usr/local/lib/nest-ops/activation.py guard %n' \\
    > "/etc/systemd/system/$unit.service.d/nest-activation.conf"
done
"""
        result = self.bash(prelude + 'managed_operation=${NEST_HOST_OPERATION_ID:-}' + snippet
                           + '\nactivation begin\nrunner_probe runner-baseline\n')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.splitlines(), ['host begin', 'host runner-baseline'])
