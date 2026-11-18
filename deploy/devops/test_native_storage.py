import importlib.util
import io
import json
import os
from pathlib import Path
import tarfile
import tempfile
import types
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('storage', Path(__file__).parents[1] / 'native/storage.py')
storage = importlib.util.module_from_spec(spec)
spec.loader.exec_module(storage)


class StorageTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        (self.root / 'releases').mkdir()
        (self.root / 'backups').mkdir()

    def release(self, number):
        sha = f'{number:040x}'
        path = self.root / 'releases' / sha
        path.mkdir()
        (path / 'nest-release.json').write_text(json.dumps({'commit': sha}))
        (path / '.artifact-sha256').write_text('a' * 64)
        os.utime(path / '.artifact-sha256', (number, number))
        os.utime(path, (number, number))
        return path

    def test_reserve_uses_space_available_to_nonroot(self):
        stat = types.SimpleNamespace(f_bavail=100, f_bfree=100000, f_frsize=4096)
        with patch.object(storage.os, 'statvfs', return_value=stat):
            with self.assertRaisesRegex(RuntimeError, 'Insufficient deployment space'):
                storage.require_space(self.root, 409601, reserve=0)
            storage.require_space(self.root, 409600, reserve=0)

    def test_install_accounts_for_expanded_archive_and_both_db_wals(self):
        artifact = self.root / 'release.tar.gz'
        with tarfile.open(artifact, 'w:gz') as tar:
            info = tarfile.TarInfo('file'); info.size = 8000
            tar.addfile(info, io.BytesIO(b'a' * 8000))
        for area in ('engine', 'product'):
            (self.root / area).mkdir()
            for name in ('nest.sqlite', 'nest.sqlite-wal'):
                (self.root / area / name).write_bytes(b'a' * 100)
        with patch.object(storage, 'require_space') as check:
            storage.check_install(artifact, self.root, self.root)
        self.assertEqual(check.call_args_list[0].args[1], 8192 + 800 + 3 * storage.GIB)
        self.assertEqual(check.call_args_list[1].args[1], 400)

    def test_retention_keeps_active_recent_and_backup_pointers_without_following_links(self):
        releases = [self.release(i) for i in range(1, 9)]
        data = self.root / 'real-data'; data.mkdir()
        (data / 'secret').write_text('preserved')
        (releases[2] / '.nest-data').symlink_to(data, target_is_directory=True)
        os.utime(releases[2], (3, 3))
        backup = self.root / 'backups/host-20261118'; backup.mkdir()
        (backup / 'release').write_text(str(releases[1]))
        removed = storage.prune_releases(self.root, releases[0])
        self.assertEqual(set(removed), {p.name for p in releases[2:5]})
        self.assertTrue((data / 'secret').exists())
        self.assertTrue((backup / 'release').exists())
        self.assertTrue(all(p.exists() for p in releases[:2] + releases[5:]))

    def test_dependency_cleanup_does_not_make_an_old_release_recent(self):
        releases = [self.release(i) for i in range(1, 6)]
        os.utime(releases[0], (1000, 1000))
        os.utime(releases[1], (2000, 2000))
        removed = storage.prune_releases(self.root, releases[-1])
        self.assertEqual(set(removed), {p.name for p in releases[:2]})
        self.assertTrue(all(p.exists() for p in releases[2:]))

    def test_unmanaged_directories_real_runtime_data_and_symlink_releases_are_untouched(self):
        valid = [self.release(i) for i in range(1, 6)]
        (valid[0] / 'files').mkdir()
        (valid[1] / 'nest-release.json').write_text('{broken')
        external = self.root / 'external'; external.mkdir()
        link = self.root / 'releases' / ('f' * 40); link.symlink_to(external)
        (self.root / 'releases/unknown').mkdir()
        self.assertEqual(storage.prune_releases(self.root, valid[-1]), [])
        self.assertTrue(link.is_symlink())
        self.assertTrue((valid[0] / 'files').exists())


if __name__ == '__main__':
    unittest.main()
