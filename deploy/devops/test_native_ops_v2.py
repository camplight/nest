import io
import json
import os
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from native_ops_v2 import ControllerPolicy, Ledger, ProtocolError, handle


def request(digest='b' * 64):
    return dict(protocol=2, action='deploy', target='test', request_id='100:200',
                repository_id='100', run_id='200', actor='operator', actor_id='300',
                workflow_ref='example/ops/.github/workflows/deploy.yml@refs/heads/main',
                workflow_sha='c' * 40, release=dict(repository='example/nest', commit='a' * 40,
                    tag='native-' + 'a' * 40, asset='nest-host-linux-x64.tar.gz', sha256=digest))


class ProtocolTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.path = Path(tmp.name) / 'ledger.sqlite'
        self.ledger = Ledger(self.path)
        self.policy = ControllerPolicy('test', '100', request()['workflow_ref'], 'example/nest')
        self.enqueued = []

    def call(self, command, payload=None, enqueue=True):
        return handle(command, io.BytesIO(payload or b''), self.policy, self.ledger,
                      self.enqueued.append if enqueue else None)

    def test_protocol_is_bounded(self):
        self.assertEqual(self.call('v2 capabilities'), dict(protocol=2, target='test',
            platform='linux-x64', max_job_seconds=1800,
            features=['verified_digest', 'durable_dedup', 'status_by_request_id']))
        for payload in (b' ' * 8193, b'\xff', b'{"protocol":2,"protocol":2}', b'[' * 8192):
            with self.subTest(prefix=payload[:25]), self.assertRaises(ProtocolError):
                self.call('v2 submit', payload)
        for command in ('restart', 'logs', 'v2 run', 'deploy ' + 'a' * 40,
                        'v2 status ../private', 'v2 status 100:200\n'):
            with self.subTest(command=command), self.assertRaises(ProtocolError):
                self.call(command)
        self.assertEqual(self.enqueued, [])

    def test_caller_policy_and_missing_backend(self):
        for overrides in (dict(target='other'), dict(request_id='100:201'), dict(repository_id='101'),
                          dict(workflow_ref='elsewhere'), dict(run_attempt='2'), dict(protocol=2.0)):
            with self.subTest(overrides=overrides), self.assertRaises(ProtocolError):
                self.call('v2 submit', json.dumps(request() | overrides).encode())
        self.assertEqual(self.call('v2 status 100:200'), {'protocol': 2, 'request_id': '100:200', 'state': 'not_found'})
        with self.assertRaises(ProtocolError):
            self.call('v2 status 101:200')
        self.assertEqual(self.call('v2 capabilities', enqueue=False)['features'], [])
        with self.assertRaises(ProtocolError):
            self.call('v2 submit', json.dumps(request()).encode(), enqueue=False)
        self.assertEqual(self.enqueued, [])

    def test_duplicate_or_conflicting_submit(self):
        raw = json.dumps(request()).encode()
        with ThreadPoolExecutor(max_workers=2) as pool:
            first, second = pool.map(lambda _: self.call('v2 submit', raw), range(2))
        self.assertEqual(first, second)
        self.assertEqual(first['state'], 'queued')
        self.assertEqual(self.enqueued, [first['operation_id']])
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)
        self.ledger = Ledger(self.path)
        self.assertEqual(self.call('v2 status 100:200'), first)
        self.assertNotIn('actor', first)
        self.assertNotIn('workflow_ref', first)
        with self.assertRaises(ProtocolError):
            self.call('v2 submit', json.dumps(request('a' * 64)).encode())
        self.assertEqual(self.call('v2 status 100:200'), first)
        self.assertEqual(self.enqueued, [first['operation_id']])

    def test_failed_enqueue_records_a_sanitized_non_retryable_outcome(self):
        raw = json.dumps(request()).encode()

        def failed_enqueue(operation_id):
            self.enqueued.append(operation_id)
            raise OSError('private scheduler diagnostics')

        failed = handle('v2 submit', io.BytesIO(raw), self.policy, self.ledger, failed_enqueue)
        self.assertEqual(failed['state'], 'rejected')
        self.assertEqual(failed['reason_code'], 'schedule_failed')
        self.assertEqual(failed['phase'], 'complete')
        self.assertNotIn('private scheduler diagnostics', json.dumps(failed))
        self.ledger = Ledger(self.path)
        self.assertEqual(self.call('v2 status 100:200'), failed)
        self.assertEqual(self.call('v2 submit', raw), failed)
        self.assertIsNone(self.ledger.claim(failed['operation_id']))
        self.assertEqual(self.enqueued, [failed['operation_id']])

    def test_installed_entrypoint_cannot_fall_back_when_v2_is_disabled(self):
        path = Path(__file__).with_name('nest-ops.py')
        for command in ('deploy ' + 'a' * 40, 'v2 submit'):
            with self.subTest(command=command):
                result = subprocess.run([sys.executable, str(path), 'v2-ssh'], input=b'',
                    env={**os.environ, 'SSH_ORIGINAL_COMMAND': command}, capture_output=True, timeout=5)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(result.stdout, b'')
                self.assertIn(b'Nest deployment request rejected', result.stderr)
