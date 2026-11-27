from dataclasses import replace
from pathlib import Path
import fcntl
import json
import tempfile
import unittest

import native_ops_job as job
from native_ops_job import (JobDependencies, Outcome, classify, reconcile, run_job,
                            systemd_command, FORWARD_SECONDS)
from native_ops_v2 import ControllerPolicy, Ledger, parse_request
from test_native_ops_v2 import request


class JobTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.ledger = Ledger(self.root / 'v2.sqlite', boot_id='previous-boot')
        raw = request()
        req = parse_request(json.dumps(raw).encode(), ControllerPolicy('test', '100', raw['workflow_ref'], 'example/nest'))
        self.record, _ = self.ledger.reserve(req)
        self.id = self.record['operation_id']
        self.calls = []
        self.lock = self.root / 'deployment.lock'
        self.marker = self.root / 'recovery-required'
        self.deps = JobDependencies(self.ledger, self.lock, self.marker, self.activate, lambda _: None, lambda: 100)

    def activate(self, req, operation_id, fd, deadline):
        self.calls.append((req.request_id, operation_id, deadline))
        return Outcome('succeeded')

    def test_claim_is_one_shot(self):
        run_job(self.id, self.deps)
        run_job(self.id, self.deps)
        self.assertEqual(self.ledger.status('100:200')['state'], 'succeeded')
        self.assertEqual(self.calls, [('100:200', self.id, 100 + 1500)])
        unit = systemd_command(self.id, Path('/usr/local/lib/nest-ops/worker'))
        self.assertIn('--property=RuntimeMaxSec=1770', unit)
        self.assertIn('--property=TimeoutStopSec=30', unit)
        self.assertIn('--property=ExitType=cgroup', unit)
        self.assertIn('--property=ExecStopPost=/usr/bin/python3 -E -s '
                      '/usr/local/lib/nest-ops/native_ops_job.py reconcile-exit ' + self.id, unit)
        self.assertEqual(FORWARD_SECONDS, 1500)

    def test_interruption_after_reserve(self):
        self.assertEqual(reconcile(self.id, self.deps)['state'], 'rejected')
        run_job(self.id, self.deps)
        self.assertEqual(self.calls, [])
        self.assertFalse(self.marker.exists())

    def test_hard_stop_preserves_gate(self):
        self.ledger.claim(self.id)
        self.marker.touch()
        state = reconcile(self.id, self.deps)
        self.assertEqual(state['state'], 'recovery_required')
        self.assertTrue(self.marker.exists())
        run_job(self.id, self.deps)
        self.assertEqual(self.calls, [])

    def test_boot_reconciles_only_prior_boot_jobs(self):
        self.ledger.claim(self.id)
        self.marker.touch()
        raw = request() | {'run_id': '201', 'request_id': '100:201'}
        never_started = parse_request(json.dumps(raw).encode(), ControllerPolicy('test', '100', raw['workflow_ref'], 'example/nest'))
        self.ledger.reserve(never_started)
        current = Ledger(self.ledger.path, boot_id='new-boot')
        current.reserve(replace(never_started, run_id='202', request_id='100:202'))
        job.reconcile_boot(replace(self.deps, ledger=current))
        self.assertEqual(current.status('100:200')['state'], 'recovery_required')
        self.assertEqual(current.status('100:201')['reason_code'], 'worker_not_started')
        self.assertEqual(current.status('100:202')['state'], 'queued')
        self.assertTrue(self.marker.exists())
        self.assertEqual(self.calls, [])

    def test_exit_without_claim_can_record_rejection_while_other_job_holds_lock(self):
        with self.lock.open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            state = reconcile(self.id, self.deps)
        self.assertEqual(state['reason_code'], 'worker_not_started')
        self.assertEqual(self.calls, [])

    def test_busy_and_recovery_gate(self):
        with self.lock.open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            self.assertEqual(self.ledger.status('100:200')['state'], 'queued')
            run_job(self.id, self.deps)
        self.assertEqual(self.ledger.status('100:200')['reason_code'], 'busy')
        raw = request() | {'run_id': '201', 'request_id': '100:201'}
        req = parse_request(json.dumps(raw).encode(), ControllerPolicy('test', '100', raw['workflow_ref'], 'example/nest'))
        record, _ = self.ledger.reserve(req)
        self.marker.touch()
        run_job(record['operation_id'], self.deps)
        self.assertEqual(self.ledger.status('100:201')['reason_code'], 'recovery_gate')
        self.assertEqual(self.calls, [])

    def test_classification_preserves_known_post_cutoff_and_blocks_ambiguity(self):
        self.assertEqual(classify('cutoff', '', True).state, 'active_unhealthy')
        self.assertEqual(classify('cutoff', '', False).state, 'recovery_required')
        self.assertEqual(classify('restored', '', True).state, 'recovery_required')
        self.assertEqual(classify('verified', 'rolled_back', True).state, 'rolled_back')
        self.assertEqual(classify('verified', 'rolled_back', False).state, 'recovery_required')
