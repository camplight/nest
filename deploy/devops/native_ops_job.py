"""Detached native job lifecycle. Live release and SSH wiring are not enabled."""
from collections.abc import Callable
from dataclasses import dataclass
import fcntl
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tempfile
import time

from native_ops_release import ReleaseRejected, ReleaseSource, prepare_release, read_active
from native_ops_v2 import DeployRequest, Ledger, StatusRecord

FORWARD_SECONDS = 1500
LOCK_WAIT_SECONDS = 3
RECONCILE_COMMAND = '/usr/bin/python3 -E -s /usr/local/lib/nest-ops/native_ops_job.py'


@dataclass(frozen=True)
class Outcome:
    state: str
    reason_code: str | None = None


@dataclass(frozen=True)
class JobDependencies:
    ledger: Ledger
    lock: Path
    marker: Path
    activate: Callable[[DeployRequest, str, int, float], Outcome]
    clear_verified: Callable[[str], None]
    clock: Callable[[], float] = time.monotonic


def systemd_command(operation_id: str, worker: Path) -> list[str]:
    if not re.fullmatch('[a-f0-9]{32}', operation_id) or not worker.is_absolute():
        raise ValueError('Invalid job configuration')
    return ['/usr/bin/systemd-run', '--quiet', '--collect', '--unit=nest-deploy-v2-' + operation_id,
            '--property=Type=exec', '--property=ExitType=cgroup', '--property=RuntimeMaxSec=1770',
            '--property=TimeoutStopSec=30', '--property=KillMode=control-group',
            f'--property=ExecStopPost={RECONCILE_COMMAND} reconcile-exit {operation_id}',
            '--', str(worker), operation_id]


def terminal(ledger: Ledger, operation_id: str, expected: str, outcome: Outcome) -> StatusRecord:
    details = {'reason_code': outcome.reason_code} if outcome.reason_code else {}
    return ledger.update(operation_id, expected, state=outcome.state, phase='complete', **details)


def acquire_briefly(lock, *, deadline: float) -> bool:
    # A watchdog health check also takes this flock. Don't mistake a short
    # inspection for a deployment, nor wait behind a busy host indefinitely.
    while (remaining := deadline - time.monotonic()) > 0:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return True
        except BlockingIOError:
            time.sleep(min(0.05, remaining))
    return False


def run_job(operation_id: str, deps: JobDependencies) -> None:
    deadline = deps.clock() + FORWARD_SECONDS
    with deps.lock.open('a') as lock:
        wait = min(LOCK_WAIT_SECONDS, deadline - deps.clock())
        if not acquire_briefly(lock, deadline=time.monotonic() + wait):
            # Never update a claimed running operation, including our own replay.
            terminal(deps.ledger, operation_id, 'queued', Outcome('rejected', 'busy'))
            return
        request = deps.ledger.claim(operation_id)
        if request is None:
            return
        if deps.marker.exists():
            terminal(deps.ledger, operation_id, 'running', Outcome('rejected', 'recovery_gate'))
            return
        try:
            outcome = deps.activate(request, operation_id, lock.fileno(), deadline)
        except ReleaseRejected:
            outcome = (Outcome('recovery_required', 'activation_interrupted') if deps.marker.exists()
                       else Outcome('rejected', 'release_preflight_failed'))
        except Exception:
            outcome = (Outcome('recovery_required', 'activation_interrupted') if deps.marker.exists()
                       else Outcome('rejected', 'job_failed_before_activation'))
        terminal(deps.ledger, operation_id, 'running', outcome)
        if outcome.state in {'succeeded', 'rolled_back'} and deps.marker.exists():
            deps.clear_verified(operation_id)


def reconcile(operation_id: str, deps: JobDependencies, *, lock_deadline: float | None = None) -> StatusRecord:
    """Called only after the supervisor establishes that this job is no longer alive."""
    record = terminal(deps.ledger, operation_id, 'queued', Outcome('rejected', 'worker_not_started'))
    if record['state'] != 'running':
        return record
    with deps.lock.open('a') as lock:
        if lock_deadline is None:
            lock_deadline = time.monotonic() + LOCK_WAIT_SECONDS
        if not acquire_briefly(lock, deadline=lock_deadline):
            # The supervisor has already reaped our worker; another job's lock
            # cannot establish whether this operation reached its cutoff.
            return terminal(deps.ledger, operation_id, 'running', Outcome('recovery_required', 'worker_lost'))
        if deps.marker.exists():
            return terminal(deps.ledger, operation_id, 'running', Outcome('recovery_required', 'worker_lost'))
        return terminal(deps.ledger, operation_id, 'running', Outcome('rejected', 'worker_lost_before_activation'))


def reconcile_boot(deps: JobDependencies) -> None:
    """Reject or mark interrupted work from prior boots; never launch a worker."""
    lock_deadline = time.monotonic() + LOCK_WAIT_SECONDS
    for operation_id in deps.ledger.previous_boot_pending():
        reconcile(operation_id, deps, lock_deadline=lock_deadline)


def classify(stage: str, recorded_outcome: str, matching_release: bool) -> Outcome:
    if matching_release:
        if stage == 'verified' and recorded_outcome in {'succeeded', 'rolled_back'}:
            return Outcome(recorded_outcome)
        if stage == 'cutoff':
            return Outcome('active_unhealthy', 'post_cutoff_check_failed')
    return Outcome('recovery_required', 'activation_unverified')


@dataclass(frozen=True)
class InstallPaths:
    operations: Path = Path('/opt/nest/operations')
    config: Path = Path('/etc/nest/native.json')
    app: Path = Path('/app')
    releases: Path = Path('/opt/nest/releases')
    marker: Path = Path('/var/lib/nest-watchdog/recovery-required')


def invoke_installer(source: ReleaseSource, ledger: Ledger, request: DeployRequest, operation_id: str,
                     fd: int, deadline: float, *, paths: InstallPaths = InstallPaths()) -> Outcome:
    """Compose a verified handoff. Only the disposable-harness adapter calls this in Phase 1."""
    parent, config, app, releases = paths.operations, paths.config, paths.app, paths.releases
    active = read_active(config, app, releases)
    with tempfile.TemporaryDirectory(dir=parent, prefix='v2-stage-') as tmp:
        release = prepare_release(request, active, source, Path(tmp))
        if release is None:
            # Don't report success for an exact match without checking it.
            domain = json.loads(config.read_text())['domain']
            endpoint = domain if domain.startswith('http://127.0.0.1:') else f'https://{domain}'
            try:
                for url in ('http://127.0.0.1:8788/health', *(endpoint + p for p in ('/health', '/', '/admin/'))):
                    subprocess.run(['/usr/bin/curl', '--fail', '--silent', '--max-time', '5', '-o', '/dev/null', url],
                                   check=True, timeout=6)
            except (subprocess.SubprocessError, OSError):
                return Outcome('rejected', 'already_active_unhealthy')
            return Outcome('succeeded', 'already_active')
        if deadline - time.monotonic() < 120:
            return Outcome('rejected', 'insufficient_time')
        domain = json.loads(config.read_text())['domain']
        ledger.update(operation_id, 'running', phase='activate')
        env = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C.UTF-8',
               'NEST_HOST_LOCK_FD': str(fd), 'NEST_HOST_OPERATION_ID': operation_id}
        proc = subprocess.Popen(['/usr/bin/bash', str(release.installer), '--release', str(release.artifact),
                                 '--sha256', release.identity.sha256, '--domain', domain], env=env,
                                pass_fds=(fd,), stdin=subprocess.DEVNULL, start_new_session=True)
        try:
            proc.wait(timeout=max(0, deadline - time.monotonic()))
        except subprocess.TimeoutExpired:
            try:
                os.killpg(proc.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                proc.wait(timeout=240)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(proc.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                proc.wait(timeout=10)
        checkpoint = parent / 'activation.json'
        if not paths.marker.exists():
            return Outcome('rejected', 'installer_preflight_failed')
        try:
            recorded = json.loads(checkpoint.read_text())
            if recorded['operation_id'] != operation_id:
                return Outcome('recovery_required', 'activation_unverified')
            expected = active if recorded['outcome'] == 'rolled_back' else release.identity
            current = read_active(config, app, releases)
            return classify(recorded['stage'], recorded['outcome'], current == expected)
        except (ValueError, OSError, KeyError, ReleaseRejected):
            return Outcome('recovery_required', 'activation_unverified')


def main(args: list[str]) -> int:
    # This pinned entry point only reconciles. It cannot submit or start a job.
    if os.geteuid() != 0 or not (args == ['reconcile-boot'] or (
            len(args) == 2 and args[0] == 'reconcile-exit' and re.fullmatch('[a-f0-9]{32}', args[1]))):
        return 2
    paths = InstallPaths()
    ledger_path = paths.operations / 'v2.sqlite'
    if not ledger_path.exists():
        return 0

    def no_activation(*_):
        raise RuntimeError('Reconciliation cannot activate a release')

    deps = JobDependencies(Ledger(ledger_path), paths.operations / 'deployment.lock',
                           paths.marker, no_activation, no_activation)
    if args[0] == 'reconcile-boot':
        reconcile_boot(deps)
    else:
        reconcile(args[1], deps)
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
