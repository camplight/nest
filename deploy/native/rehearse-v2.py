#!/usr/bin/env python3
"""Disposable-VM driver for protocol v2. Never imported by the installed controller."""
from contextlib import closing
import hashlib
import io
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import sys
import tarfile
import time
from urllib.request import Request, urlopen

OPS = Path('/opt/nest/operations')
HOST_LIB = Path('/usr/local/lib/nest-ops')
CONTROLLER = Path('/usr/local/lib/nest-ops.py')
FIXTURE = HOST_LIB / 'rehearsal'
NATIVE = Path('/etc/nest/native.json')
MARKER = Path('/var/lib/nest-watchdog/recovery-required')
BOOT = Path('/proc/sys/kernel/random/boot_id')
LOOPBACK = 'http://127.0.0.1:8080'
TEST_UNITS = ('nest-api', 'nest-engine', 'nest-runner', 'nest-caddy', 'nest-livekit')


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def run(*args, timeout=30, **options):
    return subprocess.run(args, check=True, timeout=timeout, **options)


def sha256(path):
    with path.open('rb') as file:
        return hashlib.file_digest(file, 'sha256').hexdigest()


def make_upgrade(source, target):
    """Repack with a distinct synthetic identity, leaving app payloads unchanged."""
    found = False
    # Exclusive creation avoids replacing the CI artifact even if paths are wrong.
    with source.open('rb') as original, target.open('xb') as output:
        try:
            with tarfile.open(fileobj=original, mode='r|gz') as incoming, \
                    tarfile.open(fileobj=output, mode='w|gz') as outgoing:
                for member in incoming:
                    stream = incoming.extractfile(member) if member.isreg() else None
                    if member.name == 'nest-release.json':
                        require(not found and stream is not None and member.size <= 1024 * 1024, 'Invalid fixture manifest')
                        found = True
                        manifest = json.load(stream)
                        commit = manifest.get('commit', '')
                        require(re.fullmatch('[a-f0-9]{40}', commit) and manifest.get('format') == 1
                                and manifest.get('activationProtocol') == 2 and manifest.get('platform') == 'linux'
                                and manifest.get('arch') == 'x64', 'Fixture must be a native protocol-v2 x64 bundle')
                        manifest['commit'] = hashlib.sha256(f'fixture-upgrade:{commit}'.encode()).hexdigest()[:40]
                        member.pax_headers.pop('size', None)
                        content = json.dumps(manifest).encode() + b'\n'
                        member.size = len(content)
                        stream = io.BytesIO(content)
                    outgoing.addfile(member, stream)
                require(found, 'Fixture manifest is missing')
        except BaseException:
            target.unlink(missing_ok=True)
            raise
    return manifest['commit']


def check_vm():
    require(os.geteuid() == 0 and os.uname().machine == 'x86_64', 'Rehearsal requires root on an isolated x64 VM')
    run('/usr/bin/systemd-detect-virt', '--vm', stdout=subprocess.DEVNULL, timeout=5)
    os_release = dict(line.split('=', 1) for line in Path('/etc/os-release').read_text().splitlines()
                      if line and not line.startswith('#') and '=' in line)
    require(os_release.get('ID', '').strip('"') == 'ubuntu'
            and os_release.get('VERSION_ID', '').strip('"') == '24.04', 'Expected Ubuntu 24.04')
    require(json.loads(NATIVE.read_text())['domain'] == LOOPBACK, 'Expected a loopback-only Nest fixture')


def check_synthetic_login():
    data = json.dumps({'username': 'synthetic-admin', 'password': 'synthetic-rehearsal-password'}).encode()
    req = Request('http://127.0.0.1:8787/api/auth/login', data=data, headers={'Content-Type': 'application/json'})
    with urlopen(req, timeout=5) as res:
        require(res.status == 200, 'Expected an authenticated synthetic fixture')


def require_enrolled():
    info = FIXTURE.stat()
    require(FIXTURE.is_dir() and not FIXTURE.is_symlink() and info.st_uid == 0
            and info.st_mode & 0o077 == 0, 'Host was not enrolled for disposable rehearsal')


def setup():
    check_synthetic_login()
    require(not MARKER.exists(), 'Recovery is already pending')
    source = Path(__file__).resolve().parent
    require(not HOST_LIB.is_symlink() and not FIXTURE.exists() and not (OPS / 'v2.sqlite').exists(),
            'Use a fresh disposable VM')
    FIXTURE.mkdir(mode=0o700, parents=True)
    for name in ('native_ops_v2.py', 'native_ops_release.py', 'native_ops_job.py', 'nest-deploy-v2-reconcile.service'):
        run('install', '-m', '0644', str(source.parent / 'devops' / name), str(HOST_LIB / name))
    run('install', '-m', '0644', str(source / 'activation.py'), str(HOST_LIB / 'activation.py'))
    for unit in TEST_UNITS:
        dest = Path(f'/etc/systemd/system/{unit}.service.d/nest-activation.conf')
        require(not dest.exists(), 'VM already has an activation guard')
        run('install', '-D', '-m', '0644', str(source / 'activation-guard.conf'), str(dest))
    run('install', '-m', '0644', str(HOST_LIB / 'nest-deploy-v2-reconcile.service'), '/etc/systemd/system/nest-deploy-v2-reconcile.service')
    run('install', '-m', '0644', str(Path(__file__).resolve()), str(FIXTURE / 'rehearse-v2.py'))
    for mode in ('worker', 'park'):
        entry = FIXTURE / mode
        entry.write_text(f'#!/bin/sh\nexec /usr/bin/python3 -I {FIXTURE}/rehearse-v2.py {mode} "$@"\n')
        entry.chmod(0o700)
    run('systemctl', 'daemon-reload')
    run('systemctl', 'enable', 'nest-deploy-v2-reconcile.service')


def fixture_request(run_id, commit, digest):
    return dict(protocol=2, action='deploy', target='rehearsal', request_id=f'100:{run_id}',
                repository_id='100', run_id=run_id, actor='fixture', actor_id='300',
                workflow_ref='example/ops/.github/workflows/deploy.yml@refs/heads/main',
                workflow_sha='c' * 40, release=dict(repository='example/nest', commit=commit,
                    tag=f'native-{commit}', asset='nest-host-linux-x64.tar.gz', sha256=digest))


def policy():
    from native_ops_v2 import ControllerPolicy
    return ControllerPolicy('rehearsal', '100', 'example/ops/.github/workflows/deploy.yml@refs/heads/main', 'example/nest')


def clear_verified(operation_id):
    run('/usr/bin/python3', '-I', str(HOST_LIB / 'activation.py'), 'clear', operation_id)


def worker(operation_id):
    from native_ops_job import JobDependencies, invoke_installer, ReleaseRejected, run_job
    from native_ops_v2 import Ledger

    info = json.loads((FIXTURE / 'upgrade.json').read_text())
    fixture = FIXTURE / 'upgrade.tar.gz'

    class FixtureSource:
        def open_asset(self, artifact):
            if artifact.commit != info['commit'] or artifact.sha256 != info['digest']:
                raise ReleaseRejected('Unexpected fixture identity')
            return fixture.open('rb')

        def verify_provenance(self, artifact, path):
            if artifact.sha256 != info['digest'] or sha256(path) != info['digest']:
                raise ReleaseRejected('Fixture trust check failed')

        def is_ancestor(self, active, target):
            return (active, target) == (info['baseline'], info['commit'])

    ledger = Ledger(OPS / 'v2.sqlite')
    run_job(operation_id, JobDependencies(ledger, OPS / 'deployment.lock', MARKER,
            lambda request, op, lock, deadline: invoke_installer(FixtureSource(), ledger, request, op, lock, deadline),
            clear_verified))


def status_until_terminal(read, timeout=1800):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        state = read()
        if state['state'] not in {'running', 'queued'}:
            return state
        time.sleep(1)
    raise TimeoutError('No terminal deployment status within job deadline')


def assert_healthy():
    with urlopen(LOOPBACK + '/health', timeout=5) as res:
        require(res.status == 200, 'Rehearsal ingress is not healthy')


def run_upgrade(artifact):
    setup()
    sys.path.insert(0, str(HOST_LIB))
    from native_ops_job import systemd_command
    from native_ops_v2 import Ledger, handle

    baseline = json.loads(NATIVE.read_text())['commit']
    receipt = Path('/app/.artifact-sha256').read_text().strip()
    require(receipt == sha256(artifact), 'Baseline fixture bytes do not match the installed release')
    target = FIXTURE / 'upgrade.tar.gz'
    commit = make_upgrade(artifact, target)
    digest = sha256(target)
    (FIXTURE / 'upgrade.json').write_text(json.dumps(dict(baseline=baseline, commit=commit, digest=digest)))
    controller_bytes = sha256(CONTROLLER)
    runner_id = Path('/app/.nest-data/runner-id').read_bytes()
    ledger = Ledger(OPS / 'v2.sqlite')
    enqueued = []

    def schedule(operation_id):
        run(*systemd_command(operation_id, FIXTURE / 'worker'))
        enqueued.append(operation_id)

    payload = json.dumps(fixture_request('200', commit, digest)).encode()
    handle('v2 submit', io.BytesIO(payload), policy(), ledger, schedule)  # discard the acknowledgement
    replay = handle('v2 submit', io.BytesIO(payload), policy(), ledger, schedule)
    require(enqueued == [replay['operation_id']], 'Lost reply generated a duplicate job')
    final = status_until_terminal(lambda: handle('v2 status 100:200', io.BytesIO(), policy(), ledger, schedule))
    require(final['state'] == 'succeeded', f'Expected successful fixture upgrade, got {final["state"]}')
    require(final.get('reason_code') != 'already_active', 'Fixture did not activate')
    # Terminal state is committed before the worker clears a verified gate.
    for _ in range(10):
        if not MARKER.exists():
            break
        time.sleep(1)
    require(Path('/app').resolve().name == commit and not MARKER.exists(), 'Upgrade was not verified')
    require(sha256(CONTROLLER) == controller_bytes, 'App activation replaced the controller')
    require(Path('/app/.nest-data/runner-id').read_bytes() == runner_id, 'Upgrade changed the runner identity')
    assert_healthy()
    print('PASS: detached v2 activation, lost reply/replay, unchanged controller and runner identity')
    rehearse_worker_exit(ledger, commit, digest)


def rehearse_worker_exit(ledger, commit, digest):
    from native_ops_job import systemd_command
    from native_ops_v2 import parse_request

    payload = json.dumps(fixture_request('201', commit, digest)).encode()
    record, created = ledger.reserve(parse_request(payload, policy()))
    require(created, 'Expected a new worker-exit fixture')
    operation = record['operation_id']
    run(*systemd_command(operation, FIXTURE / 'park'))
    for _ in range(10):
        if ledger.status('100:201')['state'] == 'running':
            break
        time.sleep(1)
    require(ledger.status('100:201')['state'] == 'running', 'Fixture worker did not claim its job')
    run('systemctl', 'kill', '--kill-whom=main', '--signal=SIGKILL', f'nest-deploy-v2-{operation}.service')
    final = status_until_terminal(lambda: ledger.status('100:201'), timeout=30)
    require(final['state'] == 'rejected' and final.get('reason_code') == 'worker_lost_before_activation',
            'Exit hook did not reconcile the terminated worker')
    require(not MARKER.exists(), 'A pre-activation exit unexpectedly set the recovery gate')
    print('PASS: systemd exit hook reconciled a killed worker without rerunning it')


def park(operation_id):
    from native_ops_v2 import Ledger
    require(Ledger(OPS / 'v2.sqlite').claim(operation_id) is not None, 'Fixture claim was already used')
    time.sleep(45)


def database_values():
    result = []
    for area in ('engine', 'product'):
        with closing(sqlite3.connect(f'file:/var/lib/nest/{area}/nest.sqlite?mode=ro', uri=True)) as db:
            result.append(db.execute('PRAGMA quick_check').fetchone()[0])
    return result


def prepare_reboot(case):
    from native_ops_v2 import Ledger, parse_request
    check_synthetic_login()
    require(not MARKER.exists() and not (FIXTURE / 'reboot.json').exists(), 'Use a fresh rehearsal for each reboot case')
    active = Path('/app').resolve()
    ledger = Ledger(OPS / 'v2.sqlite')
    payload = fixture_request('300', active.name, (active / '.artifact-sha256').read_text().strip())
    record, created = ledger.reserve(parse_request(json.dumps(payload).encode(), policy()))
    require(created and ledger.claim(record['operation_id']) is not None, 'Expected one new recovery fixture job')
    operation = record['operation_id']
    backup = FIXTURE / 'reboot-backup'
    backup.mkdir(mode=0o700)
    helper = ('/usr/bin/python3', '-I', str(HOST_LIB / 'activation.py'))
    run(*helper, 'begin', operation, str(active), str(active), str(backup))
    run('systemctl', 'stop', *(u + '.service' for u in TEST_UNITS), timeout=90)
    run(*helper, 'snapshot', operation)
    if case == 'failed-restore':
        # Invalidate only the harness's copy, not an application backup.
        (backup / 'product.sqlite').rename(backup / 'product.sqlite.fixture-disabled')
        result = subprocess.run([*helper, 'restore', operation], timeout=10, capture_output=True)
        require(result.returncode != 0, 'Incomplete fixture restore was accepted')
        require(json.loads((OPS / 'activation.json').read_text())['stage'] == 'blocked', 'Restore did not keep startup blocked')
    else:
        run(*helper, 'readiness', operation)
    (FIXTURE / 'reboot.json').write_text(json.dumps(dict(boot=BOOT.read_text().strip(), case=case, active=str(active))))
    run('sync', '-f', str(FIXTURE))
    print(f'Prepared {case}; reboot this disposable VM, reconnect, and run --check-reboot.')


def check_reboot():
    from native_ops_v2 import Ledger
    saved = json.loads((FIXTURE / 'reboot.json').read_text())
    require(BOOT.read_text().strip() != saved['boot'], 'No real reboot observed')
    run('systemctl', 'is-active', '--quiet', 'multi-user.target')
    state = Ledger(OPS / 'v2.sqlite').status('100:300')
    require(state['state'] == 'recovery_required', 'Interrupted job was not reconciled at boot')
    require(MARKER.is_file() and str(Path('/app').resolve()) == saved['active'], 'Reboot changed the recovery state')
    run('systemctl', 'start', 'nest-native-watchdog.service', timeout=240)
    watchdog = run('journalctl', '-b', '-u', 'nest-native-watchdog.service', '--no-pager', '-n', '20',
                   capture_output=True, text=True).stdout
    require('deployment recovery gate set' in watchdog, 'Watchdog did not observe the persistent gate')
    for unit in TEST_UNITS:
        pid = run('systemctl', 'show', '-p', 'MainPID', '--value', unit, capture_output=True, text=True).stdout.strip()
        require(pid == '0', f'{unit} started before recovery was verified')
    require(database_values() == ['ok', 'ok'], 'Fixture pair is unreadable')
    print(f'PASS: {saved["case"]}, reboot status reconciled, watchdog and live units stayed blocked')


def main(args):
    if len(args) == 3 and args[0] == 'fixture':
        make_upgrade(Path(args[1]), Path(args[2]))
        return
    check_vm()
    if len(args) == 2 and args[0] == 'upgrade':
        run_upgrade(Path(args[1]).resolve(strict=True))
        return
    require_enrolled()
    sys.path.insert(0, str(HOST_LIB))
    if len(args) == 2 and args[0] in {'worker', 'park'} and re.fullmatch('[a-f0-9]{32}', args[1]):
        (worker if args[0] == 'worker' else park)(args[1])
    elif len(args) == 2 and args[0] == 'prepare-reboot' and args[1] in {'failed-restore', 'interrupted-before-cutoff'}:
        prepare_reboot(args[1])
    elif args == ['check-reboot']:
        check_reboot()
    else:
        raise SystemExit('Use deploy/native/rehearse-v2.sh')


if __name__ == '__main__':
    main(sys.argv[1:])
