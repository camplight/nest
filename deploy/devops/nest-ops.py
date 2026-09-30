#!/usr/bin/env python3
"""Host-owned, forced-command SSH endpoint for Nest's self-deployment."""
import fcntl
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import sqlite3
from contextlib import closing
import subprocess
import sys
import time
import uuid

ROOT = Path('/opt/nest')
STATE = ROOT / 'operations'
SOURCE = ROOT / 'source'
DATA = Path('/var/lib/docker/volumes/nest_nest-data/_data')
PRODUCT_DATA = Path('/var/lib/docker/volumes/nest_nest-product/_data')
COMPOSE = ['docker', 'compose', '--project-directory', str(ROOT)]
REPO = 'https://github.com/camplight/nest.git'


def run(*args, capture=False):
    return subprocess.run(args, check=True, text=True,
                          stdout=subprocess.PIPE if capture else None).stdout


def save(job, **values):
    path = STATE / (job + '.json')
    record = json.loads(path.read_text()) if path.exists() else {'id': job}
    record.update(values, updatedAt=time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()))
    temp = path.with_suffix('.tmp')
    temp.write_text(json.dumps(record))
    temp.replace(path)


def restore_tools():
    # Fixed commands only: do not execute agent-writable setup scripts as root.
    run('docker', 'exec', 'nest-nest-1', 'sh', '-ec', '''
for base in /app/apps/user-ui/public /app/apps/user-ui/dist; do
  if [ -d /app/.nest-data/demos ] && [ ! -e "$base/demo" ] && [ ! -L "$base/demo" ]; then
    ln -s /app/.nest-data/demos "$base/demo"
  fi
done
if [ -f /app/.nest-data/codex-home/gitconfig ]; then
  ln -sfn /app/.nest-data/codex-home/gitconfig /home/node/.gitconfig
fi
if ! grep -q 'codex-home/tools/git/env.sh' /home/node/.profile; then
  printf '\\n[ ! -f /app/.nest-data/codex-home/tools/git/env.sh ] || . /app/.nest-data/codex-home/tools/git/env.sh\\n' >> /home/node/.profile
fi
''')


def health():
    run(*COMPOSE, 'up', '-d', '--wait', '--wait-timeout', '120', 'nest')
    restore_tools()
    for path in ('/health', '/api/branding', '/', '/admin/'):
        run('curl', '--fail', '--silent', '--show-error', '--max-time', '15',
            '--retry', '10', '--retry-all-errors', '--retry-delay', '2',
            '--output', '/dev/null', 'https://nest.camplight.net' + path)
    if (DATA / 'demos/kibrit/index.html').exists():
        import hashlib
        body = subprocess.check_output(['curl', '-fsS', '--max-time', '15',
                                        '--retry', '10', '--retry-all-errors', '--retry-delay', '2',
                                        'https://nest.camplight.net/demo/kibrit'])
        if hashlib.sha256(body).digest() != hashlib.sha256((DATA / 'demos/kibrit/index.html').read_bytes()).digest():
            raise RuntimeError('Published Kibrit page did not survive deployment')


def execute(job, action, sha=None):
    with (STATE / 'deployment.lock').open('w') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            save(job, state='failed', error='Another operation is running')
            return
        save(job, state='running', action=action, commit=sha)
        backup = ROOT / 'backups' / ('ops-' + job)
        changed = False
        stopped = False
        product_existed = False
        try:
            if action == 'deploy':
                if not SOURCE.exists():
                    run('git', 'clone', '--no-checkout', REPO, str(SOURCE))
                run('git', '-C', str(SOURCE), 'fetch', 'origin', 'main')
                head = run('git', '-C', str(SOURCE), 'rev-parse', 'FETCH_HEAD', capture=True).strip()
                if head != sha:
                    raise RuntimeError('Only the current camplight/nest main commit may be deployed')
                run('git', '-C', str(SOURCE), 'checkout', '--detach', sha)
                run('git', '-C', str(SOURCE), 'submodule', 'update', '--init', '--recursive')
                image = 'nest:git-' + sha[:12]
                save(job, phase='building', image=image)
                run('docker', 'build', '--label', 'org.opencontainers.image.revision=' + sha,
                    '-t', image, str(SOURCE))
            backup.mkdir(mode=0o700, parents=True)
            shutil.copy2(ROOT / 'compose.override.yaml', backup / 'compose.override.yaml')
            save(job, phase='snapshot', backup=str(backup))
            run(*COMPOSE, 'stop', '-t', '30', 'nest')
            stopped = True
            # SQLite backup includes committed WAL contents and supports schema rollback.
            with closing(sqlite3.connect(str(DATA / 'nest.sqlite'))) as src, src:
                with closing(sqlite3.connect(str(backup / 'nest.sqlite'))) as dest, dest:
                    src.backup(dest)
            if action == 'deploy':
                product_existed = (PRODUCT_DATA / 'nest.sqlite').exists()
                if product_existed:
                    with closing(sqlite3.connect(str(PRODUCT_DATA / 'nest.sqlite'))) as src, src:
                        with closing(sqlite3.connect(str(backup / 'product.sqlite'))) as dest, dest:
                            src.backup(dest)
                # The deployment override is deliberately image-only.
                override = ROOT / 'compose.override.yaml'
                original = override.read_text()
                updated, count = re.subn(r'(?m)^(\s+image:)\s*\S+\s*$', r'\g<1> ' + image, original)
                if count != 1:
                    raise RuntimeError('Expected one image entry in compose.override.yaml')
                override.write_text(updated + '\n')
                changed = True
                run('docker', 'volume', 'create', 'nest_nest-product')
                # The current product image exposes an explicit offline migration.
                run('docker', 'run', '--rm', '--entrypoint', 'node',
                    '-v', 'nest_nest-data:/app/.nest-data',
                    '-v', 'nest_nest-product:/app/.nest-product',
                    '-v', str(backup) + ':/backup', image, '--import', 'tsx',
                    'scripts/migrate-product-data.ts', '/app/.nest-data/nest.sqlite',
                    '/app/.nest-product/nest.sqlite', '--apply', '--services-stopped', '/backup/migration')
            save(job, phase='starting')
            health()
            save(job, state='succeeded', phase='healthy')
        except Exception as error:
            print(str(error), flush=True)
            rollback = 'not-needed'
            if stopped:
                try:
                    run(*COMPOSE, 'stop', '-t', '30', 'nest')
                    if changed:
                        shutil.copy2(backup / 'compose.override.yaml', ROOT / 'compose.override.yaml')
                    if changed and (backup / 'nest.sqlite').exists():
                        for suffix in ('-wal', '-shm'):
                            (DATA / ('nest.sqlite' + suffix)).unlink(missing_ok=True)
                        shutil.copyfile(backup / 'nest.sqlite', DATA / 'nest.sqlite')
                        for suffix in ('-wal', '-shm'):
                            (PRODUCT_DATA / ('nest.sqlite' + suffix)).unlink(missing_ok=True)
                        if product_existed:
                            shutil.copyfile(backup / 'product.sqlite', PRODUCT_DATA / 'nest.sqlite')
                        else:
                            (PRODUCT_DATA / 'nest.sqlite').unlink(missing_ok=True)
                    health()
                    rollback = 'succeeded'
                except Exception as recovery_error:
                    rollback = 'failed: ' + str(recovery_error)
            save(job, state='failed', error=str(error), rollback=rollback)
            raise


def main():
    os.umask(0o077)
    STATE.mkdir(mode=0o700, exist_ok=True)
    if len(sys.argv) >= 4 and sys.argv[1] == 'run' and not os.environ.get('SSH_ORIGINAL_COMMAND'):
        execute(*sys.argv[2:])
        return
    args = shlex.split(os.environ.get('SSH_ORIGINAL_COMMAND', 'status'))
    if args and args[0] in ('status', 'logs') and len(args) <= 2:
        job = args[1] if len(args) == 2 else ((STATE / 'latest').read_text().strip() if (STATE / 'latest').exists() else '')
        if not job:
            print('{"state":"idle"}')
            return
        if not re.fullmatch(r'[a-f0-9]{32}', job):
            raise ValueError('Invalid operation ID')
        if args[0] == 'status':
            print((STATE / (job + '.json')).read_text())
        else:
            print('\n'.join((STATE / (job + '.log')).read_text(errors='replace').splitlines()[-80:]))
        return
    if args == ['restart'] or (len(args) == 2 and args[0] == 'deploy' and re.fullmatch(r'[a-f0-9]{40}', args[1])):
        job = uuid.uuid4().hex
        save(job, state='queued', action=args[0], commit=args[1] if len(args) == 2 else None)
        (STATE / 'latest').write_text(job)
        run('systemd-run', '--quiet', '--collect', '--unit=nest-ops-' + job,
            '--property=StandardOutput=append:' + str(STATE / (job + '.log')),
            '--property=StandardError=append:' + str(STATE / (job + '.log')),
            '/usr/local/lib/nest-ops.py', 'run', job, *args)
        print(json.dumps({'id': job, 'state': 'queued', 'note': 'Host job continues through Nest restart; poll status with this ID.'}))
        return
    raise ValueError('Allowed commands: status [id], logs [id], restart, deploy <40-character main SHA>')


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
