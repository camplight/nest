#!/usr/bin/env python3
"""Durable activation state and guard for independently installed systemd drop-ins."""
from contextlib import closing
from dataclasses import asdict, dataclass, replace
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import sys
import tempfile
import time
from urllib.request import Request, urlopen

OPERATIONS = Path('/opt/nest/operations')
CHECKPOINT = OPERATIONS / 'activation.json'
MARKER = Path('/var/lib/nest-watchdog/recovery-required')
DATA = Path('/var/lib/nest')
APP = Path('/app')
BOOT_ID = Path('/proc/sys/kernel/random/boot_id')
AREAS = ('engine', 'product')
LIVE_UNITS = {'nest-caddy.service', 'nest-runner.service', 'nest-livekit.service'}
API_UNITS = {'nest-api.service', 'nest-engine.service'}
STEPS = {'pre_cutoff', 'snapshot_verified', 'cutoff', 'restore_complete', 'restored', 'verified', 'blocked'}


@dataclass(frozen=True)
class ActivationCheckpoint:
    operation_id: str
    old_release: str
    new_release: str
    backup: str
    stage: str
    readiness_boot: str = ''
    outcome: str = ''


def sync_dir(path: Path) -> None:
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def write_json(path: Path, value) -> None:
    with tempfile.NamedTemporaryFile(mode='w', dir=path.parent, delete=False) as file:
        tmp = Path(file.name)
        try:
            json.dump(value, file)
            file.flush()
            os.fsync(file.fileno())
            tmp.replace(path)
            sync_dir(path.parent)
        finally:
            tmp.unlink(missing_ok=True)


def read_checkpoint(path: Path) -> ActivationCheckpoint | None:
    try:
        checkpoint = ActivationCheckpoint(**json.loads(path.read_text()))
    except FileNotFoundError:
        return None
    except TypeError as error:
        raise ValueError('Invalid activation checkpoint') from error
    if checkpoint.stage not in STEPS or not all(isinstance(value, str) for value in asdict(checkpoint).values()):
        raise ValueError('Invalid activation checkpoint')
    if not re.fullmatch('[0-9a-f]{32}', checkpoint.operation_id):
        raise ValueError('Invalid operation ID')
    return checkpoint


def write_checkpoint(path: Path, checkpoint: ActivationCheckpoint) -> None:
    write_json(path, asdict(checkpoint))


def mark_recovery() -> None:
    MARKER.parent.mkdir(mode=0o700, exist_ok=True)
    write_json(MARKER, {})
    sync_dir(MARKER.parent.parent)


def may_start_live_units(checkpoint: ActivationCheckpoint | None, marker_present: bool,
                         active_release: Path) -> bool:
    if checkpoint is None:
        return not marker_present
    if checkpoint.stage == 'verified':
        if checkpoint.outcome not in {'succeeded', 'rolled_back', 'resolved_unhealthy'}:
            return False
        expected = checkpoint.old_release if checkpoint.outcome == 'rolled_back' else checkpoint.new_release
    elif marker_present and checkpoint.stage in {'cutoff', 'restored'}:
        expected = checkpoint.old_release if checkpoint.stage == 'restored' else checkpoint.new_release
    else:
        return False
    return bool(expected) and str(active_release) == expected


def may_start_readiness_units(checkpoint: ActivationCheckpoint | None, marker_present: bool,
                              active_release: Path, boot_id: str) -> bool:
    return (may_start_live_units(checkpoint, marker_present, active_release)
            or bool(checkpoint and checkpoint.stage == 'snapshot_verified' and marker_present
                    and checkpoint.readiness_boot and checkpoint.readiness_boot == boot_id
                    and checkpoint.new_release == str(active_release)))


def fresh_runner(rows, runner_id: str, previous_ms: int, started_ms: int) -> bool:
    return any(row.get('id') == runner_id and row.get('online') is True
               and type(row.get('lastSeenAt')) is int
               and row['lastSeenAt'] > previous_ms and row['lastSeenAt'] >= started_ms
               for row in rows)


def runner_rows() -> list[dict]:
    request = Request('http://127.0.0.1:8788/api/runners', headers={
        'x-orgops-runner-token': os.environ['NEST_RUNNER_TOKEN'],
    })
    with urlopen(request, timeout=3) as response:
        rows = json.load(response)
    if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
        raise ValueError('Invalid runner response')
    return rows


def runner_baseline() -> int:
    path = APP / '.nest-data/runner-id'
    expected = path.read_text().strip() if path.is_file() else ''
    seen = next((row.get('lastSeenAt') for row in runner_rows() if row.get('id') == expected), 0)
    if type(seen) is not int:
        raise ValueError('Invalid runner watermark')
    return seen


def wait_runner(previous_ms: int, started_ms: int) -> bool:
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        try:
            runner_id = (APP / '.nest-data/runner-id').read_text().strip()
            if runner_id and fresh_runner(runner_rows(), runner_id, previous_ms, started_ms):
                return True
        except (OSError, ValueError):
            pass
        time.sleep(1)
    return False


def check_db(path: Path) -> None:
    if not path.is_file():
        raise FileNotFoundError(path)
    # These closed snapshots already contain all committed pages. A regular
    # read-only WAL connection can still create root-owned -wal/-shm files.
    with closing(sqlite3.connect(path.as_uri() + '?mode=ro&immutable=1', uri=True)) as db:
        if db.execute('PRAGMA quick_check').fetchone() != ('ok',):
            raise ValueError('Invalid SQLite snapshot')


def snapshot_pair(data: Path, backup: Path, required: bool) -> None:
    present = []
    for area in AREAS:
        src = data / area / 'nest.sqlite'
        if not src.is_file():
            if required:
                raise ValueError('Native snapshot requires both databases')
            continue
        dst = backup / f'{area}.sqlite'
        with closing(sqlite3.connect(src.as_uri() + '?mode=ro', uri=True)) as db, \
                closing(sqlite3.connect(dst)) as copy:
            db.backup(copy)
        check_db(dst)
        with dst.open('rb') as file:
            os.fsync(file.fileno())
        present.append(area)
    if present and present != list(AREAS):
        raise ValueError('Snapshot must contain both databases or represent an empty host')
    write_json(backup / 'databases.json', present)


def restore_pair(data: Path, backup: Path, *, allow_empty: bool = False) -> None:
    present = json.loads((backup / 'databases.json').read_text())
    if present != list(AREAS) and not (allow_empty and present == []):
        raise ValueError('Invalid snapshot receipt')
    # Validate both sources and stage both replacements before replacing either.
    staged = []
    try:
        for area in present:
            src = backup / f'{area}.sqlite'
            check_db(src)
            with tempfile.NamedTemporaryFile(dir=data / area, delete=False) as file, src.open('rb') as source:
                staged.append((area, Path(file.name)))
                shutil.copyfileobj(source, file)
                file.flush()
                os.fsync(file.fileno())
        pending = dict(staged)
        for area in AREAS:
            dest = data / area / 'nest.sqlite'
            for suffix in ('-wal', '-shm'):
                dest.with_name(dest.name + suffix).unlink(missing_ok=True)
            if area in pending:
                pending[area].replace(dest)
            else:
                dest.unlink(missing_ok=True)
            sync_dir(dest.parent)
        for area in present:
            check_db(data / area / 'nest.sqlite')
    finally:
        for _, path in staged:
            path.unlink(missing_ok=True)


def main(args: list[str]) -> int:
    if not args:
        return 2
    if args[0] == 'guard' and len(args) == 2:
        try:
            checkpoint = read_checkpoint(CHECKPOINT)
            active = APP.resolve()
            marked = MARKER.exists()
            if args[1] in LIVE_UNITS:
                return 0 if may_start_live_units(checkpoint, marked, active) else 1
            if args[1] in API_UNITS:
                return 0 if may_start_readiness_units(checkpoint, marked, active, BOOT_ID.read_text().strip()) else 1
        except (OSError, ValueError):
            return 1
        return 2
    if args == ['runner-baseline']:
        print(runner_baseline())
        return 0
    if args[0] == 'runner-wait' and len(args) == 3:
        return 0 if wait_runner(int(args[1]), int(args[2])) else 1
    if os.geteuid() != 0:
        return 2
    if args[0] == 'begin' and len(args) == 5:
        _, operation_id, old, new, backup = args
        if MARKER.exists() or not re.fullmatch('[0-9a-f]{32}', operation_id):
            return 2
        mark_recovery()  # Fsync before any later command can mutate the deployment.
        write_checkpoint(CHECKPOINT, ActivationCheckpoint(operation_id, old, new, backup, 'pre_cutoff'))
        return 0
    checkpoint = read_checkpoint(CHECKPOINT)
    if checkpoint is None or not MARKER.exists() or len(args) != 2 or args[1] != checkpoint.operation_id:
        return 2
    stage = checkpoint.stage
    backup = Path(checkpoint.backup)
    if args[0] == 'snapshot' and stage == 'pre_cutoff':
        snapshot_pair(DATA, backup, required=bool(checkpoint.old_release))
        write_checkpoint(CHECKPOINT, replace(checkpoint, stage='snapshot_verified'))
    elif args[0] == 'readiness' and stage == 'snapshot_verified' and APP.resolve() == Path(checkpoint.new_release):
        write_checkpoint(CHECKPOINT, replace(checkpoint, readiness_boot=BOOT_ID.read_text().strip()))
    elif args[0] == 'cutoff' and stage == 'snapshot_verified' and APP.resolve() == Path(checkpoint.new_release):
        write_checkpoint(CHECKPOINT, replace(checkpoint, stage='cutoff', readiness_boot=''))
    elif args[0] == 'rollback_allowed' and stage in {'pre_cutoff', 'snapshot_verified'}:
        return 0
    elif args[0] == 'restore' and stage in {'pre_cutoff', 'snapshot_verified'}:
        # Revoke all live starts before touching a database; a process death here
        # leaves a blocked checkpoint, never a second automatic restore.
        write_checkpoint(CHECKPOINT, replace(checkpoint, stage='blocked', readiness_boot=''))
        if stage == 'snapshot_verified':
            restore_pair(DATA, backup, allow_empty=not checkpoint.old_release)
        # Only this successful call can attest that neither file is still pending.
        write_checkpoint(CHECKPOINT, replace(checkpoint, stage='restore_complete', readiness_boot=''))
    elif args[0] == 'restored' and stage == 'restore_complete' and (
            (checkpoint.old_release and APP.resolve() == Path(checkpoint.old_release))
            or (not checkpoint.old_release and not APP.exists())):
        write_checkpoint(CHECKPOINT, replace(checkpoint, stage='restored'))
    elif args[0] == 'failed' and stage == 'cutoff':
        write_checkpoint(CHECKPOINT, replace(checkpoint, outcome='active_unhealthy'))
    elif args[0] == 'verify' and (stage == 'restored' or (stage == 'cutoff' and not checkpoint.outcome)):
        write_checkpoint(CHECKPOINT, replace(checkpoint, stage='verified',
            outcome='rolled_back' if stage == 'restored' else 'succeeded'))
    elif args[0] == 'resolve' and stage == 'cutoff' and APP.resolve() == Path(checkpoint.new_release) and APP.is_dir():
        # The root operator has independently checked coherence and health.
        # This is not the installer succeeding or a change to its job receipt.
        write_checkpoint(CHECKPOINT, replace(checkpoint, stage='verified', outcome='resolved_unhealthy'))
    elif args[0] == 'clear' and stage == 'verified':
        MARKER.unlink()
        sync_dir(MARKER.parent)
    else:
        return 2
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
