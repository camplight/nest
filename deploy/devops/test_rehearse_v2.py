import io
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest

REHEARSAL = Path(__file__).resolve().parents[1] / 'native' / 'rehearse-v2.py'


class FixtureArchiveTests(unittest.TestCase):
    def test_builds_distinct_fixture_without_changing_payload_or_input(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / 'original.tar.gz'
            target = Path(tmp) / 'fixture.tar.gz'
            with tarfile.open(source, 'w:gz') as archive:
                for name, body in (
                    ('app/file', b'keep these bytes'),
                    ('nest-release.json', json.dumps({'commit': 'a' * 40, 'engine': 'b' * 40,
                        'platform': 'linux', 'arch': 'x64', 'format': 1, 'activationProtocol': 2}).encode()),
                ):
                    member = tarfile.TarInfo(name)
                    member.size = len(body)
                    archive.addfile(member, io.BytesIO(body))
            original = source.read_bytes()
            result = subprocess.run(['/usr/bin/python3', str(REHEARSAL), 'fixture', str(source), str(target)],
                                    capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            with tarfile.open(target) as archive:
                manifest = json.load(archive.extractfile('nest-release.json'))
                self.assertRegex(manifest['commit'], '^[a-f0-9]{40}$')
                self.assertNotEqual(manifest['commit'], 'a' * 40)
                self.assertEqual(manifest['engine'], 'b' * 40)
                self.assertEqual(archive.extractfile('app/file').read(), b'keep these bytes')
            self.assertEqual(source.read_bytes(), original)
            result = subprocess.run(['/usr/bin/python3', str(REHEARSAL), 'fixture', str(source), str(target)],
                                    capture_output=True, text=True, timeout=10)
            self.assertNotEqual(result.returncode, 0)
