#!/usr/bin/env python3
"""Disposable VM only: a failed post-cutoff probe through the legacy controller."""
import hashlib
import http.cookiejar
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from urllib.request import HTTPCookieProcessor, Request, build_opener


def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def run(*args, **kwargs):
    return subprocess.run(args, check=True, timeout=90, **kwargs)


def main(artifact, controller):
    source = Path(__file__).resolve().parent
    lab = load(source / 'rehearse-v2.py', 'vm_checks')
    lab.check_vm()
    lab.check_synthetic_login()
    assert not lab.MARKER.exists() and not lab.FIXTURE.exists(), 'Run after the baseline and before installing v2 guards'
    artifact = Path(artifact).resolve(strict=True)
    repo = source.parents[1]
    sha = run('git', '-c', f'safe.directory={repo}', '-C', str(repo), 'rev-parse', 'HEAD',
              capture_output=True, text=True).stdout.strip()
    digest = lab.sha256(artifact)
    active = Path('/app').resolve()
    assert active.name == sha and (active / '.artifact-sha256').read_text().strip() == digest
    controller_digest = lab.sha256(lab.CONTROLLER)
    legacy = load(Path(controller).resolve(strict=True), 'legacy_controller')
    helper = ('/usr/bin/python3', '-I', str(source / 'activation.py'))
    job = hashlib.sha256(b'legacy-post-cutoff-fixture').hexdigest()[:32]
    checkpoint = lab.OPS / 'activation.json'
    previous_operation = json.loads(checkpoint.read_text())['operation_id']
    key = 'Native smoke agent replied.'

    with tempfile.TemporaryDirectory(prefix='nest-legacy-fixture-') as directory:
        work = Path(directory)
        origin = work / 'origin'
        legacy.SOURCE = work / 'checkout'
        git_env = os.environ | {'GIT_CONFIG_COUNT': '1', 'GIT_CONFIG_KEY_0': 'safe.directory',
                                'GIT_CONFIG_VALUE_0': str(repo)}
        run('git', 'init', '-q', '--bare', '--initial-branch=main', str(origin))
        # CI's checkout may be shallow. A local branch reference is enough;
        # never actually fetch code or artifacts from the public deploy route.
        run('git', '-C', str(origin), 'fetch', '--update-shallow', str(repo), sha + ':refs/heads/main', env=git_env)
        run('git', 'clone', '-q', '--no-checkout', str(origin), str(legacy.SOURCE))
        legacy.REPO = str(origin)
        (work / 'artifact.sha256').write_text(digest + '\n')
        fault = work / 'curl'
        fault.write_text('''#!/usr/bin/env bash
set -euo pipefail
last=${!#}
url="https://github.com/camplight/nest/releases/download/native-$LEGACY_SHA/nest-host-linux-x64.tar.gz"
if [[ $last == "$url" || $last == "$url.sha256" ]]; then
  prev=
  for arg in "$@"; do
    if [[ $prev == --output ]]; then output=$arg; fi
    prev=$arg
  done
  if [[ $last == "$url" ]]; then cp -- "$LEGACY_ARTIFACT" "$output"
  else cp -- "$LEGACY_WORK/artifact.sha256" "$output"; fi
  exit 0
fi
if [[ $last == http://127.0.0.1:8080/admin/ ]]; then
  /usr/bin/python3 -I -c 'import json; assert json.load(open("/opt/nest/operations/activation.json"))["stage"] == "cutoff"'
  /usr/bin/python3 -I "$LEGACY_SMOKE"
  cp /tmp/nest-native-smoke-record.json "$LEGACY_WORK/write.json"
  echo 'Injected post-cutoff ingress check failure' >&2
  exit 22
fi
exec /usr/bin/curl "$@"
''')
        fault.chmod(0o700)
        # No watchdog race at legacy admission; exercise the gate explicitly below.
        run('systemctl', 'stop', 'nest-native-watchdog.timer', 'nest-native-watchdog.service')
        os.environ.pop('NEST_HOST_OPERATION_ID', None)
        os.environ.update(PATH=f'{work}:/usr/sbin:/usr/bin:/sbin:/bin', LEGACY_SHA=sha,
                          LEGACY_ARTIFACT=str(artifact), LEGACY_WORK=str(work), LEGACY_SMOKE=str(source / 'smoke.py'))
        try:
            legacy.execute_native(job, 'deploy', sha)
        except subprocess.CalledProcessError as error:
            assert error.returncode == 22, error
        else:
            raise AssertionError('Legacy controller did not report a failed deploy')
        status = json.loads((lab.OPS / (job + '.json')).read_text())
        assert status['state'] == 'failed' and status['commit'] == sha
        assert lab.MARKER.is_file() and Path('/app').resolve() == active
        saved = json.loads(checkpoint.read_text())
        operation = saved['operation_id']
        assert operation != previous_operation and (saved['stage'], saved['outcome']) == ('cutoff', 'active_unhealthy')
        record = json.loads((work / 'write.json').read_text())
        browser = build_opener(HTTPCookieProcessor(http.cookiejar.CookieJar()))
        login = Request('http://127.0.0.1:8787/api/auth/login',
                        data=json.dumps({'username': 'synthetic-admin', 'password': 'synthetic-rehearsal-password'}).encode(),
                        headers={'Content-Type': 'application/json'})
        with browser.open(login, timeout=5) as response:
            assert response.status == 200
        with browser.open(f'http://127.0.0.1:8787/api/events?channelId={record["channel"]}&limit=100', timeout=5) as response:
            assert any(e['source'] == 'agent:' + record['agent'] and e['type'] == 'message.created'
                       and e['payload'].get('text') == key for e in json.load(response))
        run('systemctl', 'start', 'nest-native-watchdog.service')
        log = run('journalctl', '-b', '-u', 'nest-native-watchdog.service', '--no-pager', '-n', '10',
                  capture_output=True, text=True).stdout
        assert 'deployment recovery gate set' in log
        assert lab.MARKER.exists() and lab.sha256(lab.CONTROLLER) == controller_digest
        # The injected curl exists only in the installer process path. Verify
        # real health before resolving, then leave the VM ready for the v2 case.
        for path in ('/health', '/', '/admin/'):
            run('/usr/bin/curl', '-fsS', '-o', '/dev/null', lab.LOOPBACK + path)
        run('flock', '-w', '5', str(lab.OPS / 'deployment.lock'), *helper, 'resolve', operation)
        assert json.loads(checkpoint.read_text())['outcome'] == 'resolved_unhealthy'
        run('flock', '-w', '5', str(lab.OPS / 'deployment.lock'), *helper, 'clear', operation)
        assert not lab.MARKER.exists() and json.loads((lab.OPS / (job + '.json')).read_text())['state'] == 'failed'
        run('systemctl', 'start', 'nest-native-watchdog.timer')
    print('PASS: legacy post-cutoff failure preserved the synthetic agent write, gate and failed deploy receipt')


if __name__ == '__main__':
    main(*sys.argv[1:])
