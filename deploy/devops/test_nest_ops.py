import importlib.util
import json
import os
from pathlib import Path
import sqlite3
from contextlib import closing
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('ops', Path(__file__).with_name('nest-ops.py'))
ops = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ops)


class DeploymentTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        for name, value in {'ROOT': root, 'STATE': root / 'operations',
                            'SOURCE': root / 'source', 'DATA': root / 'data', 'PRODUCT_DATA': root / 'product'}.items():
            p = patch.object(ops, name, value)
            p.start()
            self.addCleanup(p.stop)
            value.mkdir(exist_ok=True)
        (root / 'compose.override.yaml').write_text('services:\n  nest:\n    image: nest:previous\n')
        with closing(sqlite3.connect(str(ops.DATA / 'nest.sqlite'))) as db, db:
            db.execute('CREATE TABLE original (id INTEGER)')
        self.job = 'a' * 32
        self.sha = 'b' * 40

    def test_non_main_commit_never_stops_service(self):
        with patch.object(ops, 'run', return_value='c' * 40 + '\n') as run:
            with self.assertRaisesRegex(RuntimeError, 'current .* main'):
                ops.execute(self.job, 'deploy', self.sha)
        self.assertFalse(any('stop' in call.args for call in run.call_args_list))
        self.assertEqual(json.loads((ops.STATE / (self.job + '.json')).read_text())['state'], 'failed')

    def test_failed_start_restores_previous_image_and_database(self):
        count = 0
        with closing(sqlite3.connect(str(ops.PRODUCT_DATA / 'nest.sqlite'))) as db, db:
            db.execute('CREATE TABLE branding (value TEXT)')
            db.execute("INSERT INTO branding VALUES ('Camplight')")

        def health():
            nonlocal count
            count += 1
            if count == 1:
                with closing(sqlite3.connect(str(ops.DATA / 'nest.sqlite'))) as db, db:
                    db.execute('CREATE TABLE new_migration (id INTEGER)')
                with closing(sqlite3.connect(str(ops.PRODUCT_DATA / 'nest.sqlite'))) as db, db:
                    db.execute("UPDATE branding SET value='Changed'")
                raise RuntimeError('New image failed health check')

        with patch.object(ops, 'run', return_value=self.sha + '\n'), patch.object(ops, 'health', side_effect=health):
            with self.assertRaisesRegex(RuntimeError, 'failed health'):
                ops.execute(self.job, 'deploy', self.sha)
        self.assertIn('nest:previous', (ops.ROOT / 'compose.override.yaml').read_text())
        with closing(sqlite3.connect(str(ops.DATA / 'nest.sqlite'))) as db, db:
            tables = db.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
        self.assertEqual(tables, [('original',)])
        with closing(sqlite3.connect(str(ops.PRODUCT_DATA / 'nest.sqlite'))) as db, db:
            self.assertEqual(db.execute('SELECT value FROM branding').fetchone(), ('Camplight',))
        record = json.loads((ops.STATE / (self.job + '.json')).read_text())
        self.assertEqual(record['rollback'], 'succeeded')
        self.assertEqual(count, 2)

    def test_forced_endpoint_rejects_shell_and_internal_run(self):
        for command in ('sh', 'deploy main', 'restart; id', 'run abc restart', 'logs ../../etc/passwd'):
            with self.subTest(command=command), patch.dict(os.environ, {'SSH_ORIGINAL_COMMAND': command}), patch.object(ops, 'run') as run:
                with self.assertRaises(ValueError):
                    ops.main()
                run.assert_not_called()


if __name__ == '__main__':
    unittest.main()
