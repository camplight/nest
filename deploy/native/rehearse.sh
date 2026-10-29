#!/usr/bin/env bash
# Fresh disposable Ubuntu VM/container ONLY. Synthetic secrets, no provider spend.
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")/../.."
artifact=${1:?Usage: deploy/native/rehearse.sh /path/release.tar.gz}
digest=$(sha256sum "$artifact" | cut -d ' ' -f1)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cat > "$work/runtime.env" <<'ENV'
NEST_ADMIN_USER=synthetic-admin
NEST_ADMIN_PASS=synthetic-rehearsal-password
NEST_RUNNER_TOKEN=synthetic-runner-token
NEST_MASTER_KEY=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=
OPENROUTER_API_KEY=synthetic-not-real
OPENROUTER_BASE_URL=http://127.0.0.1:19991/v1
NEST_GOOGLE_CLIENT_ID=synthetic.apps.googleusercontent.com
NEST_GOOGLE_CLIENT_SECRET=synthetic-not-real
NEST_GOOGLE_REDIRECT_URI=http://127.0.0.1:8080/api/auth/google/callback
ENV
chmod 600 "$work/runtime.env"
install_host() { bash scripts/install-host.sh --release "$artifact" --sha256 "$digest" --domain http://127.0.0.1:8080 "$@"; }
install_host --env-file "$work/runtime.env" --enable-livekit
voice_smoke() {
  systemctl is-active --quiet nest-livekit
  runuser -u node -- /opt/nest/node/bin/node --env-file=/etc/nest/runtime.env /app/deploy/native/livekit-smoke.mjs
}
voice_smoke
cp /etc/nest/livekit.yaml "$work/livekit.yaml"
# Saved wrapped bridges deliberately give Codex this restricted PATH. Its Node
# shebang and agent-invoked npm/npx must work without the service's extended PATH.
runuser -u node -- env -i HOME=/home/node PATH=/usr/local/bin:/usr/bin:/bin sh -ec '
  test "$(node --version)" = v22.23.2
  npm --version >/dev/null
  npx --version >/dev/null
  codex --version
  claude --version
'
python3 deploy/native/smoke.py
python3 - <<'PY'
import http.cookiejar,json,urllib.request
opener=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
def request(path,body,method='POST'):
    req=urllib.request.Request('http://127.0.0.1:8787'+path,data=json.dumps(body).encode(),method=method,headers={'Content-Type':'application/json'})
    with opener.open(req,timeout=5) as response: return json.load(response)
request('/api/auth/login',{'username':'synthetic-admin','password':'synthetic-rehearsal-password'})
request('/api/auth/google/settings',{'enabled':True,'allowedDomain':'example.com','teamName':'Synthetic team'},'PUT')
PY
cp /app/.nest-data/runner-id "$work/runner-id"
# Re-running the exact installer is the upgrade path; it must preserve state.
install_host
cmp /app/.nest-data/runner-id "$work/runner-id"
cmp /etc/nest/livekit.yaml "$work/livekit.yaml"
voice_smoke
python3 deploy/native/smoke.py
python3 - <<'PY'
import json,urllib.request
with urllib.request.urlopen('http://127.0.0.1:8787/api/auth/google/config',timeout=5) as response:
    config=json.load(response)
assert config.get('enabled') and config.get('allowedDomain')=='example.com','Google sign-in did not survive reinstall'
PY
# Accidental OAuth credential removal must fail activation and restore the saved
# provider settings/configuration rather than silently shipping password-only UI.
sed '/^NEST_GOOGLE_/d' "$work/runtime.env" > "$work/missing-google.env"
if install_host --env-file "$work/missing-google.env"; then
  echo 'FAIL: removal of enabled Google credentials was accepted'; exit 1
fi
python3 - <<'PY'
import json,urllib.request
with urllib.request.urlopen('http://127.0.0.1:8787/api/auth/google/config',timeout=5) as response:
    config=json.load(response)
assert config.get('enabled') and config.get('allowedDomain')=='example.com','Google sign-in rollback failed'
PY
cmp /etc/nest/livekit.yaml "$work/livekit.yaml"
voice_smoke
# Configuration failure after the snapshot must restore the previous DB pair/config.
printf 'NEST_RUNNER_TOKEN=synthetic\n' > "$work/invalid.env"
if install_host --env-file "$work/invalid.env"; then
  echo 'FAIL: invalid configuration was accepted'; exit 1
fi
curl --fail --silent http://127.0.0.1:8787/health >/dev/null
cmp /app/.nest-data/runner-id "$work/runner-id"
python3 deploy/native/smoke.py
# SFU failure is recovered independently, without restarting APIs or the runner.
engine_pid=$(systemctl show nest-engine --property=MainPID --value)
before=$(systemctl show nest-livekit --property=MainPID --value)
systemctl kill --kill-whom=main --signal=SIGKILL nest-livekit
for attempt in $(seq 1 30); do
  after=$(systemctl show nest-livekit --property=MainPID --value)
  if [[ $after != 0 && $after != "$before" ]] && systemctl is-active --quiet nest-livekit; then break; fi
  sleep 1
done
[[ $after != 0 && $after != "$before" ]]
[[ $(systemctl show nest-engine --property=MainPID --value) == "$engine_pid" ]]
curl --fail --silent --max-time 3 --retry 10 --retry-all-errors --retry-delay 1 http://127.0.0.1:7880/ >/dev/null
voice_smoke
# Pausing execution must survive upgrades and explicit start requests. Resume
# must reuse the same identity and still complete a real synthetic agent turn.
install_host --pause-runner
test -f /etc/nest/runner-paused
! systemctl is-active --quiet nest-runner
python3 - <<'PY'
import importlib.util
spec=importlib.util.spec_from_file_location('watchdog','/usr/local/lib/nest-watchdog.py')
watchdog=importlib.util.module_from_spec(spec);spec.loader.exec_module(watchdog)
assert watchdog.inspect_native()['health']=='healthy','Paused execution disabled API monitoring'
PY
install_host
systemctl start nest-runner
! systemctl is-active --quiet nest-runner
curl --fail --silent http://127.0.0.1:8787/health >/dev/null
install_host --resume-runner
test ! -e /etc/nest/runner-paused
cmp /app/.nest-data/runner-id "$work/runner-id"
python3 deploy/native/smoke.py
# Crash the main process; KillMode=control-group cleans up its descendants.
before=$(systemctl show nest-runner --property=MainPID --value)
systemctl kill --kill-whom=main --signal=SIGKILL nest-runner
for attempt in $(seq 1 30); do
  after=$(systemctl show nest-runner --property=MainPID --value)
  if [[ $after != 0 && $after != "$before" ]] && systemctl is-active --quiet nest-runner; then break; fi
  sleep 1
done
[[ $after != 0 && $after != "$before" ]]
systemctl is-active --quiet nest-runner
cmp /app/.nest-data/runner-id "$work/runner-id"
python3 deploy/native/smoke.py
for path in / /admin/ /api/branding /health; do curl --fail --silent "http://127.0.0.1:8080$path" >/dev/null; done
for path in /demo/kibrit-software-factory /demo/not-real /api/agents; do
  [[ $(curl --silent -o /dev/null -w '%{http_code}' "http://127.0.0.1:8080$path") == 401 ]]
done
# Actual bounded units, not just rendered fixture strings.
systemctl show nest.slice -p MemoryMax -p MemorySwapMax -p CPUQuotaPerSecUSec -p TasksMax
systemctl is-enabled nest-api nest-engine nest-runner nest-caddy nest-livekit nest-native-watchdog.timer
python3 - <<'PY'
import pathlib,sqlite3
for area in ('engine','product'):
    with sqlite3.connect(f'file:/var/lib/nest/{area}/nest.sqlite?mode=ro',uri=True) as db:
        assert db.execute('PRAGMA quick_check').fetchone()[0]=='ok'
print('PASS: both databases pass integrity checks')
PY
echo 'PASS: repeatable native installation, agent turn, state/identity preservation, rollback, crash recovery and protected demo/UI routing'
