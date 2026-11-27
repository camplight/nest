from dataclasses import replace
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'native'))
import activation
from activation import (ActivationCheckpoint, fresh_runner, may_start_live_units,
                        may_start_readiness_units, read_checkpoint, snapshot_pair, restore_pair, write_checkpoint)


class ActivationTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.old = self.root / ('a' * 40)
        self.new = self.root / ('b' * 40)
        self.path = self.root / 'activation.json'
        self.check = ActivationCheckpoint('c' * 32, str(self.old), str(self.new),
                                          str(self.root / 'backup'), 'pre_cutoff')

    def test_start_guard_fails_closed(self):
        write_checkpoint(self.path, self.check)
        self.assertEqual(read_checkpoint(self.path), self.check)
        self.assertFalse(may_start_live_units(None, True, self.new))
        self.assertTrue(may_start_live_units(None, False, self.new))
        self.assertFalse(may_start_live_units(self.check, True, self.new))
        cut = replace(self.check, stage='cutoff')
        self.assertTrue(may_start_live_units(cut, True, self.new))
        self.assertFalse(may_start_live_units(cut, True, self.old))
        restored = replace(self.check, stage='restored')
        self.assertTrue(may_start_live_units(restored, True, self.old))
        self.assertFalse(may_start_live_units(restored, True, self.new))
        self.path.write_text('{')
        with self.assertRaises(ValueError):
            read_checkpoint(self.path)
        reading = replace(self.check, stage='snapshot_verified', readiness_boot='abc')
        self.assertTrue(may_start_readiness_units(reading, True, self.new, 'abc'))
        self.assertFalse(may_start_readiness_units(reading, True, self.new, 'next-boot'))
        self.assertFalse(may_start_readiness_units(reading, True, self.old, 'abc'))
        self.assertFalse(may_start_readiness_units(replace(reading, stage='blocked'), True, self.new, 'abc'))

    def test_verified_checkpoint_does_not_authorize_different_release(self):
        for outcome, permitted, denied in (('succeeded', self.new, self.old),
                                           ('rolled_back', self.old, self.new)):
            with self.subTest(outcome=outcome):
                verified = replace(self.check, stage='verified', outcome=outcome)
                self.assertTrue(may_start_live_units(verified, False, permitted))
                self.assertFalse(may_start_live_units(verified, False, denied))
                self.assertFalse(may_start_readiness_units(verified, False, denied, 'abc'))

    def prepare_pair(self):
        data = self.root / 'data'
        backup = self.root / 'backup'
        backup.mkdir()
        for area in ('engine', 'product'):
            path = data / area / 'nest.sqlite'
            path.parent.mkdir(parents=True)
            with sqlite3.connect(path) as db:
                db.execute('CREATE TABLE entries (value TEXT)')
                db.execute('INSERT INTO entries VALUES (?)', ('old-' + area,))
        snapshot_pair(data, backup, required=True)
        for area in ('engine', 'product'):
            with sqlite3.connect(data / area / 'nest.sqlite') as db:
                db.execute('UPDATE entries SET value=?', ('new-' + area,))
        return data, backup

    def db_value(self, data, area):
        with sqlite3.connect(data / area / 'nest.sqlite') as db:
            return db.execute('SELECT value FROM entries').fetchone()[0]

    def test_rollback_validates_wal_mode_pair_without_creating_service_sidecars(self):
        data = self.root / 'wal-data'
        backup = self.root / 'wal-backup'
        backup.mkdir()
        for area in ('engine', 'product'):
            path = data / area / 'nest.sqlite'
            path.parent.mkdir(parents=True)
            with sqlite3.connect(path) as db:
                self.assertEqual(db.execute('PRAGMA journal_mode=WAL').fetchone(), ('wal',))
                db.execute('CREATE TABLE entries (value TEXT)')
                db.execute('INSERT INTO entries VALUES (?)', ('old-' + area,))
            db.close()
        snapshot_pair(data, backup, required=True)
        restore_pair(data, backup)
        for area in ('engine', 'product'):
            self.assertEqual(sorted(p.name for p in (data / area).iterdir()), ['nest.sqlite'])
            self.assertEqual(self.db_value(data, area), 'old-' + area)

    def test_partial_snapshot_is_not_restorable(self):
        data, backup = self.prepare_pair()
        (backup / 'product.sqlite').unlink()
        with self.assertRaises((OSError, ValueError)):
            restore_pair(data, backup)
        self.assertEqual(self.db_value(data, 'engine'), 'new-engine')

    def test_native_restore_rejects_singleton_or_empty_receipt_before_replacing_databases(self):
        data, backup = self.prepare_pair()
        receipt = backup / 'databases.json'
        for present in (['engine'], []):
            with self.subTest(present=present):
                receipt.write_text(json.dumps(present))
                with self.assertRaises(ValueError):
                    restore_pair(data, backup)
                self.assertEqual(self.db_value(data, 'engine'), 'new-engine')
                self.assertEqual(self.db_value(data, 'product'), 'new-product')

    def test_second_replacement_failure_keeps_restore_blocked(self):
        data, backup = self.prepare_pair()
        marker = self.root / 'recovery-required'
        marker.touch()
        app = self.root / 'app'
        app.symlink_to(self.old)
        checkpoint = replace(self.check, stage='snapshot_verified')
        write_checkpoint(self.path, checkpoint)
        replace_path = Path.replace

        def replace_with_failed_product(source, destination):
            if destination == data / 'product' / 'nest.sqlite':
                raise OSError('simulated product replacement failure')
            return replace_path(source, destination)

        with patch.multiple(activation, CHECKPOINT=self.path, MARKER=marker, DATA=data, APP=app), \
                patch.object(activation.os, 'geteuid', return_value=0), \
                patch.object(Path, 'replace', replace_with_failed_product):
            with self.assertRaisesRegex(OSError, 'product replacement'):
                activation.main(['restore', checkpoint.operation_id])
            self.assertEqual(self.db_value(data, 'engine'), 'old-engine')
            self.assertEqual(self.db_value(data, 'product'), 'new-product')
            self.assertTrue(marker.exists())
            self.assertEqual(activation.main(['restored', checkpoint.operation_id]), 2)
            self.assertEqual(activation.main(['guard', 'nest-engine.service']), 1)
            self.assertEqual(activation.main(['clear', checkpoint.operation_id]), 2)

    def test_fresh_heartbeat(self):
        rows = [{'id': 'same', 'lastSeenAt': 500, 'online': True}]
        self.assertFalse(fresh_runner(rows, 'same', 500, 500))
        self.assertFalse(fresh_runner(rows, 'same', 499, 501))
        self.assertTrue(fresh_runner(rows, 'same', 499, 500))
        self.assertFalse(fresh_runner(rows, 'other', 499, 500))
        rows[0]['online'] = False
        self.assertFalse(fresh_runner(rows, 'same', 499, 500))
