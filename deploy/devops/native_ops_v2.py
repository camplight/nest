"""Host-local v2 request validation and durable operation records."""
from collections.abc import Callable
from contextlib import closing, contextmanager
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
import io
import json
import os
from pathlib import Path
import re
import select
import sqlite3
import stat
import time
from typing import BinaryIO
import uuid

MAX_PAYLOAD = 8192
MAX_JOB_SECONDS = 1800
ID = r'[1-9][0-9]{0,19}'
SHA = r'[a-f0-9]{40}'
DIGEST = r'[a-f0-9]{64}'
REPO = r'[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}'
ASSET = 'nest-host-linux-x64.tar.gz'
FEATURES = ['verified_digest', 'durable_dedup', 'status_by_request_id']


class ProtocolError(ValueError):
    """A request failed the public contract."""


@dataclass(frozen=True)
class ControllerPolicy:
    target: str
    repository_id: str
    workflow_ref: str
    publisher: str
    platform: str = 'linux-x64'


@dataclass(frozen=True)
class Release:
    repository: str
    commit: str
    tag: str
    asset: str
    sha256: str


@dataclass(frozen=True)
class DeployRequest:
    protocol: int
    action: str
    target: str
    request_id: str
    repository_id: str
    run_id: str
    actor: str
    actor_id: str
    workflow_ref: str
    workflow_sha: str
    release: Release


StatusRecord = dict


def fields(value: object, expected: set[str]) -> dict:
    if not isinstance(value, dict) or value.keys() != expected:
        raise ProtocolError('Invalid fields')
    return value


def matches(pattern: str, value: object) -> bool:
    return isinstance(value, str) and re.fullmatch(pattern, value) is not None


def unique_object(pairs: list[tuple]) -> dict:
    result = dict(pairs)
    if len(result) != len(pairs):
        raise ProtocolError('Duplicate fields')
    return result


def parse_request(payload: bytes, policy: ControllerPolicy) -> DeployRequest:
    if len(payload) > MAX_PAYLOAD:
        raise ProtocolError('Request too large')
    try:
        raw = json.loads(payload.decode('utf-8'), object_pairs_hook=unique_object)
    except (ValueError, RecursionError) as error:
        raise ProtocolError('Invalid request JSON') from error
    row = fields(raw, set(DeployRequest.__dataclass_fields__))
    artifact = fields(row['release'], set(Release.__dataclass_fields__))
    if (type(row['protocol']) is not int or row['protocol'] != 2 or row['action'] != 'deploy'
            or row['target'] != policy.target or row['repository_id'] != policy.repository_id
            or row['workflow_ref'] != policy.workflow_ref or artifact['repository'] != policy.publisher
            or not all(matches(ID, row[key]) for key in ('repository_id', 'run_id', 'actor_id'))
            or row['request_id'] != f"{row['repository_id']}:{row['run_id']}"
            or not matches(r'[A-Za-z0-9-]{1,100}', row['actor']) or not matches(SHA, row['workflow_sha'])
            or not matches(SHA, artifact['commit']) or artifact['tag'] != f"native-{artifact['commit']}"
            or artifact['asset'] != ASSET or not matches(DIGEST, artifact['sha256'])):
        raise ProtocolError('Request outside deployment policy')
    return DeployRequest(**(row | {'release': Release(**artifact)}))


def read_submission(payload: BinaryIO) -> bytes:
    try:
        fd = payload.fileno()
    except io.UnsupportedOperation:
        return payload.read(MAX_PAYLOAD + 1)
    result = bytearray()
    deadline = time.monotonic() + 10
    while len(result) <= MAX_PAYLOAD:
        remaining = deadline - time.monotonic()
        if remaining <= 0 or not select.select([fd], [], [], remaining)[0]:
            raise ProtocolError('Request read timed out')
        chunk = os.read(fd, MAX_PAYLOAD + 1 - len(result))
        if not chunk:
            break
        result.extend(chunk)
    return bytes(result)


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


class Ledger:
    def __init__(self, path: Path, *, boot_id: str | None = None):
        self.path = path
        self.boot_id = boot_id if boot_id is not None else Path('/proc/sys/kernel/random/boot_id').read_text().strip()
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            db.execute('''CREATE TABLE IF NOT EXISTS operations (
                request_id TEXT PRIMARY KEY,
                operation_id TEXT NOT NULL UNIQUE,
                request TEXT NOT NULL,
                status TEXT NOT NULL,
                boot_id TEXT NOT NULL
            )''')
            if 'boot_id' not in {row[1] for row in db.execute('PRAGMA table_info(operations)')}:
                db.execute("ALTER TABLE operations ADD COLUMN boot_id TEXT NOT NULL DEFAULT ''")

    @contextmanager
    def connect(self):
        # Admission never creates an initially world-readable receipt.
        fd = os.open(self.path, os.O_NOFOLLOW | os.O_CREAT | os.O_RDWR, 0o600)
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
                raise PermissionError('Insecure operations ledger')
        finally:
            os.close(fd)
        with closing(sqlite3.connect(self.path, timeout=5)) as db, db:
            db.execute('PRAGMA synchronous=FULL')
            yield db

    def reserve(self, request: DeployRequest) -> tuple[StatusRecord, bool]:
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            private = json.dumps(asdict(request), sort_keys=True)
            row = db.execute('SELECT request, status FROM operations WHERE request_id = ?',
                             (request.request_id,)).fetchone()
            if row:
                if row[0] != private:
                    raise ProtocolError('Conflicting request ID')
                return json.loads(row[1]), False
            timestamp = now()
            record = dict(protocol=2, request_id=request.request_id, operation_id=uuid.uuid4().hex,
                          target=request.target, release=asdict(request.release), state='queued',
                          phase='queued', created_at=timestamp, updated_at=timestamp)
            db.execute('INSERT INTO operations VALUES (?, ?, ?, ?, ?)',
                       (request.request_id, record['operation_id'], private, json.dumps(record), self.boot_id))
            return record, True

    def previous_boot_pending(self) -> list[str]:
        with self.connect() as db:
            return [row[0] for row in db.execute('''SELECT operation_id FROM operations
                WHERE boot_id != ? AND json_extract(status, '$.state') IN ('queued', 'running')''', (self.boot_id,))]

    def claim(self, operation_id: str) -> DeployRequest | None:
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            row = db.execute('SELECT request, status FROM operations WHERE operation_id = ? AND boot_id = ?',
                             (operation_id, self.boot_id)).fetchone()
            if not row:
                return None
            status = json.loads(row[1])
            if status['state'] != 'queued':
                return None
            status.update(state='running', phase='preflight', updated_at=now())
            db.execute('UPDATE operations SET status = ? WHERE operation_id = ?', (json.dumps(status), operation_id))
            request = json.loads(row[0])
            return DeployRequest(**(request | {'release': Release(**request['release'])}))

    def update(self, operation_id: str, expected: str, **changes) -> StatusRecord:
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            row = db.execute('SELECT status FROM operations WHERE operation_id = ?', (operation_id,)).fetchone()
            if row is None:
                raise ProtocolError('Unknown operation')
            record = json.loads(row[0])
            if record['state'] == expected:
                record.update(changes, updated_at=now())
                db.execute('UPDATE operations SET status = ? WHERE operation_id = ?',
                           (json.dumps(record), operation_id))
            return record

    def status(self, request_id: str) -> StatusRecord | None:
        with self.connect() as db:
            row = db.execute('SELECT status FROM operations WHERE request_id = ?', (request_id,)).fetchone()
        return json.loads(row[0]) if row else None


def handle(command: str, payload: BinaryIO, policy: ControllerPolicy, ledger: Ledger,
           enqueue: Callable[[str], None] | None) -> dict:
    enabled = enqueue is not None and policy.platform == 'linux-x64'
    if command == 'v2 capabilities':
        return dict(protocol=2, target=policy.target, platform=policy.platform,
                    max_job_seconds=MAX_JOB_SECONDS, features=FEATURES.copy() if enabled else [])
    if command == 'v2 submit' and enabled:
        request = parse_request(read_submission(payload), policy)
        record, created = ledger.reserve(request)
        if created:
            try:
                enqueue(record['operation_id'])
            except Exception:
                # Scheduler failure can be ambiguous. Reject only if a worker
                # has not claimed the request; either way, never enqueue again.
                return ledger.update(record['operation_id'], 'queued', state='rejected',
                                     phase='complete', reason_code='schedule_failed')
        return record
    if (match := re.fullmatch(rf'v2 status ({ID}:{ID})', command)):
        request_id = match[1]
        if request_id.split(':')[0] != policy.repository_id:
            raise ProtocolError('Request outside deployment policy')
        status = ledger.status(request_id)
        if status and status['target'] == policy.target:
            return status
        return dict(protocol=2, request_id=request_id, state='not_found')
    raise ProtocolError('Unsupported or unavailable operation')
