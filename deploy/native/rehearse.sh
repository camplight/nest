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
ENV
chmod 600 "$work/runtime.env"
install_host() { bash scripts/install-host.sh --release "$artifact" --sha256 "$digest" --domain http://127.0.0.1:8080 "$@"; }
install_host --env-file "$work/runtime.env"
python3 deploy/native/smoke.py
cp /app/.nest-data/runner-id "$work/runner-id"
# Re-running the exact installer is the upgrade path; it must preserve state.
install_host
cmp /app/.nest-data/runner-id "$work/runner-id"
python3 deploy/native/smoke.py
# Configuration failure after the snapshot must restore the previous DB pair/config.
printf 'NEST_RUNNER_TOKEN=synthetic\n' > "$work/invalid.env"
if install_host --env-file "$work/invalid.env"; then
  echo 'FAIL: invalid configuration was accepted'; exit 1
fi
curl --fail --silent http://127.0.0.1:8787/health >/dev/null
cmp /app/.nest-data/runner-id "$work/runner-id"
python3 deploy/native/smoke.py
# Crash the whole runner cgroup: systemd must recover it with the SAME identity.
systemctl kill --signal=SIGKILL nest-runner
for attempt in $(seq 1 30); do
  if systemctl is-active --quiet nest-runner; then break; fi
  sleep 1
done
sleep 4
systemctl is-active --quiet nest-runner
cmp /app/.nest-data/runner-id "$work/runner-id"
for path in / /admin/ /api/branding /health; do curl --fail --silent "http://127.0.0.1:8080$path" >/dev/null; done
for path in /demo/kibrit-software-factory /demo/not-real /api/agents; do
  [[ $(curl --silent -o /dev/null -w '%{http_code}' "http://127.0.0.1:8080$path") == 401 ]]
done
# Actual bounded units, not just rendered fixture strings.
systemctl show nest.slice -p MemoryMax -p MemorySwapMax -p CPUQuotaPerSecUSec -p TasksMax
systemctl is-enabled nest-api nest-engine nest-runner nest-caddy
python3 - <<'PY'
import pathlib,sqlite3
for area in ('engine','product'):
    with sqlite3.connect(f'file:/var/lib/nest/{area}/nest.sqlite?mode=ro',uri=True) as db:
        assert db.execute('PRAGMA quick_check').fetchone()[0]=='ok'
print('PASS: both databases pass integrity checks')
PY
echo 'PASS: repeatable native installation, agent turn, state/identity preservation, rollback, crash recovery and protected demo/UI routing'
