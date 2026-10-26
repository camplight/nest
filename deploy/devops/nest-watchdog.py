#!/usr/bin/env python3
"""Operator-installed host watchdog; never deploys code or reboots the host."""
import fcntl
import json
from pathlib import Path
import subprocess
import time
import urllib.request
import urllib.error

CONTAINER = 'nest-nest-1'
STATE = Path('/var/lib/nest-watchdog/state.json')
DEPLOY_LOCK = Path('/opt/nest/operations/deployment.lock')
NATIVE_CONFIG = Path('/etc/nest/native.json')
FAILURES_REQUIRED = 3
COOLDOWN_SECONDS = 3600


def run(*args, timeout=15):
    return subprocess.run(args, check=True, capture_output=True, text=True,
                          timeout=timeout).stdout


def inspect_native():
    units = []
    for unit in ('nest-api', 'nest-engine', 'nest-runner'):
        values = dict(line.split('=', 1) for line in run('systemctl', 'show', unit, '--property=ActiveState,ActiveEnterTimestampMonotonic').splitlines() if '=' in line)
        units.append(values)
    if any(u.get('ActiveState') not in ('active', 'failed') for u in units):
        return {'status': 'stopped', 'startedAt': '', 'health': 'none', 'oomKilled': False}
    healthy = all(u.get('ActiveState') == 'active' for u in units)
    for port in (8787, 8788):
        try:
            with urllib.request.urlopen(f'http://127.0.0.1:{port}/health', timeout=4) as response:
                healthy = healthy and response.status == 200
        except (OSError, urllib.error.URLError):
            healthy = False
    return {'status': 'running', 'startedAt': ':'.join(u.get('ActiveEnterTimestampMonotonic', '') for u in units),
            'health': 'healthy' if healthy else 'unhealthy', 'oomKilled': False}


def inspect():
    if NATIVE_CONFIG.exists():
        return inspect_native()
    # Only runtime state: a full inspect would contain environment credentials.
    data = json.loads(run('docker', 'inspect', '--format', '{{json .State}}', CONTAINER))
    if not isinstance(data, dict) or not isinstance(data.get('StartedAt'), str):
        raise ValueError('Invalid Docker state')
    return {'status': data.get('Status'), 'startedAt': data.get('StartedAt'),
            'health': (data.get('Health') or {}).get('Status'),
            'oomKilled': bool(data.get('OOMKilled'))}


def evaluate(state, observed, now):
    """Return durable metadata and a bounded recovery decision, without effects."""
    state = dict(state)
    state['observedAt'] = now
    state['observed'] = observed
    if state.get('startedAt') != observed['startedAt']:
        state['failures'] = 0
        state['startedAt'] = observed['startedAt']
    if observed['status'] != 'running' or observed['health'] != 'unhealthy':
        state['failures'] = 0
        return state, 'observe'
    state['failures'] = state.get('failures', 0) + 1
    if state['failures'] < FAILURES_REQUIRED:
        return state, 'observe'
    if now - state.get('lastRestartAt', -COOLDOWN_SECONDS) < COOLDOWN_SECONDS:
        return state, 'cooldown'
    # Persist before attempting restart so a failed command cannot cause a loop.
    state['lastRestartAt'] = now
    state['failures'] = 0
    return state, 'restart'


def save(state):
    temp = STATE.with_suffix('.tmp')
    temp.write_text(json.dumps(state))
    temp.chmod(0o600)
    temp.replace(STATE)


def recover():
    STATE.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    # Share the controller lock. Never race its stopped-DB snapshot or rollback.
    DEPLOY_LOCK.parent.mkdir(parents=True, exist_ok=True)
    with DEPLOY_LOCK.open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print('Nest watchdog: deployment in progress; skipped')
            return
        try:
            state = json.loads(STATE.read_text()) if STATE.exists() else {}
            if not isinstance(state, dict):
                raise ValueError('Invalid state')
            for field in ('failures', 'lastRestartAt'):
                if field in state and (type(state[field]) is not int or state[field] < 0):
                    raise ValueError('Invalid state counter')
        except (ValueError, OSError):
            print('Nest watchdog: state unreadable; operator review required')
            return
        try:
            observed = inspect()
        except (subprocess.SubprocessError, ValueError, OSError):
            # Unknown state breaks the consecutive-failure sequence.
            state['failures'] = 0
            save(state)
            print('Nest watchdog: runtime state unavailable; no action')
            return
        state, action = evaluate(state, observed, int(time.time()))
        save(state)
        print(json.dumps({'action': action, 'health': observed['health'],
                          'failures': state['failures'], 'oomKilled': observed['oomKilled']}))
        if action == 'restart' and NATIVE_CONFIG.exists():
            run('systemctl', 'stop', 'nest-runner', 'nest-api', 'nest-engine', timeout=100)
            run('systemctl', 'reset-failed', 'nest-runner', 'nest-api', 'nest-engine')
            run('systemctl', 'start', 'nest-engine', 'nest-api', 'nest-runner', timeout=100)
            print('Nest watchdog: native service restart requested')
        elif action == 'restart':
            # Safe fields only; do not collect commands, application logs or env.
            try:
                metrics = run('docker', 'stats', '--no-stream', '--format',
                              '{{.CPUPerc}} {{.MemUsage}} {{.PIDs}}', CONTAINER)
                print('Nest watchdog resource snapshot:', metrics.strip())
            except (subprocess.SubprocessError, OSError):
                print('Nest watchdog resource snapshot unavailable')
            run('docker', 'restart', '--time', '30', CONTAINER, timeout=90)
            print('Nest watchdog: container restart requested')


if __name__ == '__main__':
    recover()
