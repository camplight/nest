from dataclasses import replace
from hashlib import sha256
import io
import json
from pathlib import Path
import tarfile
import tempfile
import time
import unittest
from unittest.mock import patch

import native_ops_job as job
from native_ops_release import ReleaseIdentity, ReleaseRejected, prepare_release, read_active
from native_ops_v2 import ControllerPolicy, Ledger, parse_request
from test_native_ops_v2 import request


class FixtureSource:
    def __init__(self, bundle):
        self.bundle = bundle
        self.ancestor = True
        self.verified = True
        self.opened = 0

    def open_asset(self, artifact):
        self.opened += 1
        return self.bundle.open('rb')

    def verify_provenance(self, artifact, path):
        if not self.verified:
            raise ReleaseRejected('provenance')

    def is_ancestor(self, active_commit, target_commit):
        return self.ancestor


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.active = ReleaseIdentity('d' * 40, 'e' * 64)
        self.bundle = self.root / 'fixture.tar.gz'
        self.stage = self.root / 'stage'
        self.stage.mkdir(mode=0o700)
        self.source = FixtureSource(self.bundle)

    def make_bundle(self, *, installer='# verified installer\n', **overrides):
        manifest = dict(commit='a' * 40, platform='linux', arch='x64', format=1, activationProtocol=2)
        items = {'nest-release.json': json.dumps(manifest | overrides),
                 'scripts/install-host.sh': installer,
                 'deploy/native/storage.py': '# verified storage\n',
                 'deploy/native/versions.env': '# verified pins\n',
                 'deploy/native/activation.py': '# verified helper\n'}
        with tarfile.open(self.bundle, 'w:gz') as archive:
            for name, text in items.items():
                data = text.encode()
                member = tarfile.TarInfo(name)
                member.size = len(data)
                archive.addfile(member, io.BytesIO(data))
        self.req = parse_request(json.dumps(request(sha256(self.bundle.read_bytes()).hexdigest())).encode(),
                                 ControllerPolicy('test', '100', request()['workflow_ref'], 'example/nest'))

    def test_rejection_precedes_release_execution(self):
        self.make_bundle()
        with patch('native_ops_release.require_space', side_effect=RuntimeError('disk')):
            with self.assertRaises(ReleaseRejected):
                prepare_release(self.req, self.active, self.source, self.stage)
        self.assertEqual(self.source.opened, 0)
        for reason in ('not_ancestor', 'provenance', 'commit', 'arch', 'legacy', 'digest'):
            with self.subTest(reason=reason), patch('native_ops_release.require_space'):
                self.make_bundle(**{'commit': {'commit': 'f' * 40}, 'arch': {'arch': 'arm64'},
                                    'legacy': {'activationProtocol': 1}}.get(reason, {}))
                self.source.ancestor = reason != 'not_ancestor'
                self.source.verified = reason != 'provenance'
                if reason == 'digest':
                    self.req = replace(self.req, release=replace(self.req.release, sha256='f' * 64))
                self.stage = self.root / reason
                self.stage.mkdir(mode=0o700)
                with self.assertRaises(ReleaseRejected):
                    prepare_release(self.req, self.active, self.source, self.stage)
                self.assertFalse((self.stage / 'tree/scripts/install-host.sh').exists())

    def test_exact_match_never_stages(self):
        self.make_bundle()
        same = ReleaseIdentity(self.req.release.commit, self.req.release.sha256)
        self.assertIsNone(prepare_release(self.req, same, self.source, self.stage))
        with self.assertRaises(ReleaseRejected):
            prepare_release(self.req, replace(same, sha256='f' * 64), self.source, self.stage)
        self.assertEqual(self.source.opened, 0)

    def test_installer_runs_from_verified_stage(self):
        self.make_bundle()
        checkout = self.root / 'unrelated-checkout'
        checkout.mkdir()
        (checkout / 'install-host.sh').write_text('unverified copy')
        with patch('native_ops_release.require_space'):
            prepared = prepare_release(self.req, self.active, self.source, self.stage)
        self.assertEqual(prepared.installer.read_text(), '# verified installer\n')
        self.assertEqual((prepared.installer.parent.parent / 'deploy/native/storage.py').read_text(), '# verified storage\n')
        self.assertEqual(prepared.artifact.read_bytes(), self.bundle.read_bytes())

    def test_handoff_preserves_post_cutoff_write(self):
        operations = self.root / 'operations'
        operations.mkdir()
        app = self.root / 'app'
        releases = self.root / 'releases'
        old = releases / self.active.commit
        old.mkdir(parents=True)
        (old / '.artifact-sha256').write_text(self.active.sha256)
        app.symlink_to(old)
        config = self.root / 'native.json'
        config.write_text(json.dumps({'commit': self.active.commit, 'domain': 'nest.example.com'}))
        marker = self.root / 'recovery-required'
        new = releases / ('a' * 40)
        written = self.root / 'post-cutoff-write'
        installer = f'''set -eu
cd "$(dirname "$0")/.."
grep -q 'verified storage' deploy/native/storage.py
mkdir '{new}'
printf %s "$4" > '{new}/.artifact-sha256'
ln -sfn '{new}' '{app}'
printf '%s' '{{"commit":"{'a' * 40}","domain":"nest.example.com"}}' > '{config}'
touch '{marker}'
printf '{{"operation_id":"%s","stage":"cutoff","outcome":""}}' "$NEST_HOST_OPERATION_ID" > '{operations}/activation.json'
printf '%s' 'work received' > '{written}'
exit 12
'''
        self.make_bundle(installer=installer)
        ledger = Ledger(operations / 'v2.sqlite')
        record, _ = ledger.reserve(self.req)
        paths = job.InstallPaths(operations, config, app, releases, marker)

        def activate(request, operation_id, lock_fd, deadline):
            return job.invoke_installer(self.source, ledger, request, operation_id, lock_fd, deadline, paths=paths)

        with patch('native_ops_release.require_space'):
            job.run_job(record['operation_id'], job.JobDependencies(ledger, operations / 'lock', marker,
                activate, lambda _: self.fail('Unhealthy job cleared the recovery gate'), time.monotonic))
        self.assertEqual(ledger.status('100:200')['state'], 'active_unhealthy')
        self.assertTrue(marker.exists())
        self.assertEqual(written.read_text(), 'work received')
        self.assertEqual(app.resolve(), new)

    def test_active_identity_needs_matching_receipt(self):
        release = self.root / 'releases' / self.active.commit
        release.mkdir(parents=True)
        app = self.root / 'app'
        app.symlink_to(release)
        config = self.root / 'native.json'
        config.write_text(json.dumps({'commit': self.active.commit}))
        with self.assertRaises(ReleaseRejected):
            read_active(config, app, release.parent)
        (release / '.artifact-sha256').write_text(self.active.sha256 + '\n')
        self.assertEqual(read_active(config, app, release.parent), self.active)
