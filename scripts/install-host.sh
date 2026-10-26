#!/usr/bin/env bash
# Root-owned, repeatable native installer. All application builds happen in CI.
set -euo pipefail
umask 077
root=$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)
usage() { echo 'Usage: sudo scripts/install-host.sh --release FILE --sha256 HEX --domain HOST [--env-file PRIVATE_FILE] [--import-docker]'; }
artifact= digest= domain= env_file=
import_docker=0
while (($#)); do
  case "$1" in
    --release|--sha256|--domain|--env-file)
      (($# >= 2)) || { usage >&2; exit 2; }
      case "$1" in --release) artifact=$2;; --sha256) digest=$2;; --domain) domain=$2;; --env-file) env_file=$2;; esac
      shift 2;;
    --import-docker) import_docker=1; shift;;
    --help|-h) usage; exit 0;;
    *) usage >&2; exit 2;;
  esac
done
[[ $EUID == 0 && $(uname -s) == Linux ]] || { echo 'Requires root on Linux.' >&2; exit 1; }
[[ -f "$artifact" && $digest =~ ^[a-f0-9]{64}$ && $domain =~ ^([a-zA-Z0-9.-]+|http://127\.0\.0\.1:[0-9]+)$ ]] || { usage >&2; exit 2; }
# shellcheck source=/dev/null
source /etc/os-release
[[ $ID == ubuntu && $VERSION_ID == 24.04 ]] || { echo 'Supported host: Ubuntu 24.04.' >&2; exit 1; }
[[ ! -e /app || -L /app ]] || { echo '/app must be absent or an existing managed symlink.' >&2; exit 1; }
[[ -z $env_file || -f $env_file ]] || { echo 'Private environment file missing.' >&2; exit 1; }
[[ -n $env_file || -f /etc/nest/runtime.env || $import_docker == 1 ]] || { echo 'Provide --env-file on first installation.' >&2; exit 1; }
if [[ $import_docker == 0 ]] && command -v docker >/dev/null && [[ $(docker inspect -f '{{.State.Running}}' nest-nest-1 2>/dev/null || true) == true ]]; then
  echo 'Docker Nest is running. Follow the offline migration procedure before native activation.' >&2; exit 1
fi
# shellcheck source=../deploy/native/versions.env
source "$root/deploy/native/versions.env"
case $(uname -m) in x86_64) arch=amd64; node_arch=x64;; aarch64) arch=arm64; node_arch=arm64;; *) echo 'Unsupported CPU architecture.' >&2; exit 1;; esac
install -d -m 700 /opt/nest/operations /opt/nest/backups
if [[ ${NEST_HOST_LOCK_FD:-} =~ ^[0-9]+$ && $(readlink "/proc/$$/fd/$NEST_HOST_LOCK_FD") == /opt/nest/operations/deployment.lock ]]; then
  exec 9<&"$NEST_HOST_LOCK_FD"
else
  exec 9>/opt/nest/operations/deployment.lock
fi
flock -n 9 || { echo 'Another deployment is active.' >&2; exit 1; }
printf '%s  %s\n' "$digest" "$artifact" | sha256sum --check --status
work=$(mktemp -d /opt/nest/host-stage.XXXXXX)
trap 'rm -rf "$work"' EXIT
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends ca-certificates curl xz-utils python3 rsync git openssh-client >/dev/null
install -d -m 755 /opt/nest/releases /opt/nest/tools /etc/nest
python3 - "$artifact" "$work/release" <<'PY'
import pathlib,sys,tarfile
p=pathlib.Path(sys.argv[2]); p.mkdir()
with tarfile.open(sys.argv[1]) as tar:
    tar.extractall(p,filter='data')
PY
release="$work/release"
mapfile -t meta < <(python3 - "$release" "$root/deploy/native/versions.env" "$node_arch" "$NODE_VERSION" <<'PY'
import hashlib,json,pathlib,re,sys
r=pathlib.Path(sys.argv[1]); m=json.loads((r/'nest-release.json').read_text())
assert m['format']==1 and m['platform']=='linux' and m['arch']==sys.argv[3] and m['node']=='v'+sys.argv[4], 'Wrong release platform/Node'
assert re.fullmatch('[a-f0-9]{40}',m['commit']) and re.fullmatch('[a-f0-9]{40}',m['engine'])
for field,name in [('pins','deploy/native/versions.env'),('lock','package-lock.json'),('agentLock','deploy/native/agent-clis/package-lock.json')]:
    assert hashlib.sha256((r/name).read_bytes()).hexdigest()==m[field], 'Release metadata mismatch'
assert hashlib.sha256(pathlib.Path(sys.argv[2]).read_bytes()).hexdigest()==m['pins'], 'Installer and release version pins differ'
for path in ['node_modules/tsx','apps/user-ui/dist/index.html','apps/admin-ui/dist/index.html','vendor/orgops/apps/api/src/app.ts','deploy/native/agent-clis/node_modules/.bin/codex','deploy/native/agent-clis/node_modules/.bin/claude']:
    assert (r/path).exists(), 'Incomplete prebuilt release'
assert '/admin/assets/' in (r/'apps/admin-ui/dist/index.html').read_text(), 'Wrong admin asset base'
print(m['commit'])
PY
)
[[ ${#meta[@]} == 1 && ${meta[0]} =~ ^[a-f0-9]{40}$ ]] || { echo 'Invalid release.' >&2; exit 1; }
sha=${meta[0]}
fetch() { curl --fail --silent --show-error --location --retry 3 --proto '=https' --tlsv1.2 "$1" -o "$2"; }
node_dir="/opt/nest/tools/node-$NODE_VERSION-$arch"
if [[ ! -x "$node_dir/bin/node" ]]; then
  fetch "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-$node_arch.tar.xz" "$work/node.tar.xz"
  node_key="NODE_SHA256_$arch"
  printf '%s  %s\n' "${!node_key}" "$work/node.tar.xz" | sha256sum --check --status
  mkdir "$work/node"
  tar -xJf "$work/node.tar.xz" --strip-components=1 -C "$work/node"
  chmod -R a+rX "$work/node"
  mv "$work/node" "$node_dir"
fi
[[ $("$node_dir/bin/node" --version) == "v$NODE_VERSION" ]]
caddy_dir="/opt/nest/tools/caddy-$CADDY_VERSION-$arch"
if [[ ! -x "$caddy_dir/caddy" ]]; then
  fetch "https://github.com/caddyserver/caddy/releases/download/v$CADDY_VERSION/caddy_${CADDY_VERSION}_linux_$arch.tar.gz" "$work/caddy.tar.gz"
  caddy_key="CADDY_SHA512_$arch"
  printf '%s  %s\n' "${!caddy_key}" "$work/caddy.tar.gz" | sha512sum --check --status
  mkdir "$work/caddy"
  tar -xzf "$work/caddy.tar.gz" -C "$work/caddy" caddy
  chmod -R a+rX "$work/caddy"
  mv "$work/caddy" "$caddy_dir"
fi
[[ $("$caddy_dir/caddy" version) == "v$CADDY_VERSION "* ]]
if ! id node >/dev/null 2>&1; then
  # Existing migrations must pre-create the original UID/GID (1000). Fresh hosts
  # can use the distro's next free UID; units reference the account by name.
  useradd --create-home --user-group --shell /bin/bash node
fi
id caddy >/dev/null 2>&1 || useradd --system --user-group --home-dir /var/lib/nest-caddy --shell /usr/sbin/nologin caddy
install -d -m 700 -o node -g node /var/lib/nest/engine /var/lib/nest/product /var/lib/nest/files
install -d -m 755 /var/lib/nest-caddy
install -d -m 700 -o caddy -g caddy /var/lib/nest-caddy/data /var/lib/nest-caddy/config
# Both releases use the same persistent state and identity, never a fresh DB copy.
for pair in '.nest-data:engine' '.nest-product:product' 'files:files'; do
  name=${pair%%:*}; area=${pair#*:}
  [[ ! -e "$release/$name" && ! -L "$release/$name" ]] || { echo 'Release contains runtime data.' >&2; exit 1; }
  ln -s "/var/lib/nest/$area" "$release/$name"
done
ln -s /etc/nest/runtime.env "$release/.env"
chown -hR root:root "$release"
# Runtime links must not be followed by chmod/chown.
find "$release" -type d -exec chmod 755 {} +
find "$release" -type f -exec chmod a+r,go-w {} +
[[ ! -e /opt/nest/releases/$sha ]] || { [[ $(cat "/opt/nest/releases/$sha/.artifact-sha256") == "$digest" ]] || { echo 'Immutable release already exists with a different checksum.' >&2; exit 1; }; }
if [[ ! -d /opt/nest/releases/$sha ]]; then
  printf '%s\n' "$digest" > "$release/.artifact-sha256"
  cp "$release/nest-release.json" "$release/nest-host.json"
  mv "$release" "/opt/nest/releases/$sha"
fi
release="/opt/nest/releases/$sha"
backup="/opt/nest/backups/host-$(date -u +%Y%m%dT%H%M%S)-$$"
mkdir -m 700 "$backup"
if [[ $import_docker == 1 ]]; then
  [[ ! -f /etc/nest/native.json && $(id -u node) == 1000 && $(id -g node) == 1000 ]] || { echo 'Import requires the original node UID/GID 1000 and no active native installation.' >&2; exit 1; }
  for area in engine product files; do
    [[ -z $(find "/var/lib/nest/$area" -mindepth 1 -maxdepth 1 -print -quit) ]] || { echo 'Import target is not empty; preserve/recover it before retrying.' >&2; exit 1; }
  done
  docker inspect nest-nest-1 nest-caddy-1 > "$backup/docker.json"
  python3 - "$backup/docker.json" "$sha" <<'PYCODE'
import json,sys
rows=json.load(open(sys.argv[1])); app=rows[0]
assert app['Config']['Labels'].get('org.opencontainers.image.revision')==sys.argv[2], 'Import must use the currently deployed revision'
assert len(rows)==2 and rows[1]['Name']=='/nest-caddy-1'
for path in ('/app/.nest-data','/app/.nest-product','/app/files'):
    assert any(m['Destination']==path and m['Type']=='volume' for m in app['Mounts']), 'Unexpected runtime volume'
PYCODE
  df -Pk /var/lib/nest > "$backup/disk-before.txt"
fi
old_release=
if [[ -L /app ]]; then old_release=$(readlink -f /app); fi
for link in node caddy; do readlink "/opt/nest/$link" > "$backup/$link.link" || true; done
cp -a /etc/nest "$backup/config"
[[ ! -f /usr/local/lib/nest-ops.py ]] || cp -a /usr/local/lib/nest-ops.py "$backup/controller"
install -d "$backup/units"
for unit in nest-api.service nest-engine.service nest-runner.service nest-caddy.service nest.slice; do
  [[ ! -f /etc/systemd/system/$unit ]] || cp -a "/etc/systemd/system/$unit" "$backup/units/"
done
printf '%s\n' "$old_release" > "$backup/release"
committed=0
databases_snapshotted=0
recover() {
  result=$?
  trap - ERR
  if [[ $committed == 0 ]]; then
    systemctl stop nest-caddy nest-runner nest-api nest-engine 2>/dev/null || true
    if [[ $databases_snapshotted == 1 ]]; then
    python3 - "$backup" <<'PY'
import pathlib,shutil,sys
b=pathlib.Path(sys.argv[1])
for area in ('engine','product'):
    dest=pathlib.Path('/var/lib/nest')/area/'nest.sqlite'
    for suffix in ('','-wal','-shm'): pathlib.Path(str(dest)+suffix).unlink(missing_ok=True)
    if (b/(area+'.sqlite')).exists(): shutil.copyfile(b/(area+'.sqlite'),dest)
PY
    fi
    for area in engine product; do [[ ! -f /var/lib/nest/$area/nest.sqlite ]] || chown node:node "/var/lib/nest/$area/nest.sqlite"; done
    rsync -a --delete "$backup/config/" /etc/nest/
    [[ ! -f $backup/controller ]] || install -m 755 "$backup/controller" /usr/local/lib/nest-ops.py
    for link in node caddy; do
      if [[ -s $backup/$link.link ]]; then ln -sfn "$(cat "$backup/$link.link")" "/opt/nest/$link"; fi
    done
    rm -f /etc/systemd/system/nest-{api,engine,runner,caddy}.service /etc/systemd/system/nest.slice
    cp -a "$backup/units/." /etc/systemd/system/
    systemctl daemon-reload
    if [[ -n $old_release && -d $old_release ]]; then
      ln -sfn "$old_release" /app
      for tool in codex claude; do ln -sfn "$old_release/deploy/native/agent-clis/node_modules/.bin/$tool" "/usr/local/bin/$tool"; done
      systemctl start nest-engine nest-api nest-runner nest-caddy || true
    else
      systemctl disable nest-engine nest-api nest-runner nest-caddy 2>/dev/null || true
      rm -f /app
    fi
    if [[ -f $backup/docker.json ]]; then
      python3 - "$backup/docker.json" <<'PYCODE'
import json,subprocess,sys
for row in json.load(open(sys.argv[1])):
    policy=row['HostConfig']['RestartPolicy']; value=policy['Name']
    if value=='on-failure' and policy['MaximumRetryCount']: value+=':'+str(policy['MaximumRetryCount'])
    subprocess.run(['docker','update','--restart='+value,row['Id']],check=True,stdout=subprocess.DEVNULL)
    subprocess.run(['docker','start',row['Id']],check=True,stdout=subprocess.DEVNULL)
PYCODE
      if [[ -f $backup/watchdog-enabled ]]; then systemctl enable --now nest-watchdog.timer || true; fi
    fi
    echo "Activation failed; previous release/database pair restored. Backup: $backup" >&2
  fi
  exit "$result"
}
trap recover ERR
# Hold the public proxy closed throughout snapshot, schema migration and checks.
systemctl stop nest-caddy.service nest-runner.service nest-api.service nest-engine.service 2>/dev/null || true
for unit in nest-caddy nest-runner nest-api nest-engine; do
  if systemctl is-active --quiet "$unit"; then echo 'A service did not stop; refusing backup.' >&2; false; fi
done
if [[ $import_docker == 1 ]]; then
  if systemctl is-enabled --quiet nest-watchdog.timer 2>/dev/null; then touch "$backup/watchdog-enabled"; fi
  systemctl disable --now nest-watchdog.timer 2>/dev/null || true
  systemctl stop nest-watchdog.service 2>/dev/null || true
  docker update --restart=no nest-nest-1 nest-caddy-1 >/dev/null
  docker stop --time 30 nest-caddy-1 nest-nest-1 >/dev/null
  # Docker volumes remain the untouched rollback source. Check room before copying.
  python3 - "$backup/docker.json" <<'PYCODE'
import json,pathlib,shutil,subprocess,sys
rows=json.load(open(sys.argv[1])); app=rows[0]
pairs={ '/app/.nest-data':'/var/lib/nest/engine', '/app/.nest-product':'/var/lib/nest/product', '/app/files':'/var/lib/nest/files' }
mounts={m['Destination']:m['Source'] for m in app['Mounts']}
required=sum(int(subprocess.check_output(['du','-s','-B1',mounts[p]]).split()[0]) for p in pairs)
assert shutil.disk_usage('/var/lib/nest').free > required + 1024**3, 'Insufficient space for full runtime copy'
for source,target in pairs.items():
    subprocess.run(['rsync','-aH',mounts[source]+'/',target+'/'],check=True)
    delta=subprocess.check_output(['rsync','-aHnci','--delete',mounts[source]+'/',target+'/'])
    assert not delta, 'Runtime copy verification failed'
for m in rows[1]['Mounts']:
    if m['Destination'] in ('/data','/config'):
        target='/var/lib/nest-caddy/'+('data' if m['Destination']=='/data' else 'config')
        subprocess.run(['rsync','-aH',m['Source']+'/',target+'/'],check=True)
subprocess.run(['docker','cp',app['Id']+':/home/node/.','/home/node/'],check=True)
PYCODE
  chown -R node:node /var/lib/nest /home/node
  chown -R caddy:caddy /var/lib/nest-caddy
  if [[ -z $env_file ]]; then
    "$node_dir/bin/node" --input-type=module - "$backup/docker.json" "$backup/import.env" <<'JSCODE'
import {readFileSync,writeFileSync} from 'node:fs'; import {parseEnv} from 'node:util';
const rows=JSON.parse(readFileSync(process.argv[2],'utf8')); const entries=rows[0].Config.Env.map(v=>[v.slice(0,v.indexOf('=')),v.slice(v.indexOf('=')+1)]);
const lines=entries.map(([k,v])=>{if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw Error('Invalid environment key');const q=["'",'"','`'].find(q=>!v.includes(q));if(!q) throw Error('Cannot serialize environment safely');return k+'='+q+v+q;});
const contents=lines.join('\n')+'\n'; const parsed=parseEnv(contents);if(entries.some(([k,v])=>parsed[k]!==v)) throw Error('Environment round-trip failed');writeFileSync(process.argv[3],contents,{mode:0o600});
JSCODE
    env_file="$backup/import.env"
  fi
fi
python3 - "$backup" <<'PY'
from contextlib import closing
import pathlib,sqlite3,sys
out=pathlib.Path(sys.argv[1])
for area in ('engine','product'):
    src=pathlib.Path('/var/lib/nest')/area/'nest.sqlite'
    if src.exists():
        with closing(sqlite3.connect(f'file:{src}?mode=ro',uri=True)) as db, closing(sqlite3.connect(out/(area+'.sqlite'))) as dest:
            assert db.execute('PRAGMA quick_check').fetchone()[0]=='ok'
            db.backup(dest)
            assert dest.execute('PRAGMA quick_check').fetchone()[0]=='ok'
PY
databases_snapshotted=1
[[ -z $env_file ]] || install -m 600 -o node -g node "$env_file" /etc/nest/runtime.env
# Parse without logging any values. Keys that change state roots require explicit migration.
"$node_dir/bin/node" --env-file=/etc/nest/runtime.env --input-type=module <<'JS'
import {parseEnv} from 'node:util'; import {readFileSync} from 'node:fs';
const e=parseEnv(readFileSync('/etc/nest/runtime.env','utf8'));
for(const k of ['NEST_MASTER_KEY','NEST_RUNNER_TOKEN']) if(!e[k]) throw Error('Required configuration missing: '+k);
for(const [k,v] of Object.entries({NEST_ENGINE_DATA_DIR:'.nest-data',NEST_ENGINE_DB_FILE:'nest.sqlite',NEST_PRODUCT_DB_PATH:'.nest-product/nest.sqlite'}))
  if(e[k] && e[k]!==v && e[k]!=='/app/'+v) throw Error('Explicit data migration required for '+k);
JS
ln -sfn "$node_dir" /opt/nest/node
ln -sfn "$caddy_dir" /opt/nest/caddy
ln -sfn "$release" /app
# Restore durable home/tool access used by existing saved wrapped-agent commands.
if [[ -f /var/lib/nest/engine/codex-home/gitconfig ]]; then ln -sfn /app/.nest-data/codex-home/gitconfig /home/node/.gitconfig; fi
for tool in codex claude; do
  ln -sfn "$release/deploy/native/agent-clis/node_modules/.bin/$tool" "/usr/local/bin/$tool"
done
install -m 644 "$release/deploy/native/Caddyfile" /etc/nest/Caddyfile
printf 'NEST_DOMAIN=%s\n' "$domain" > /etc/nest/host.env
chmod 644 /etc/nest/host.env
install -m 644 "$release"/deploy/native/systemd/* /etc/systemd/system/
NEST_DOMAIN="$domain" "$caddy_dir/caddy" validate --config /etc/nest/Caddyfile --adapter caddyfile >/dev/null
systemd-analyze verify "$release"/deploy/native/systemd/*.service
systemctl daemon-reload
systemctl reset-failed nest-engine nest-api nest-runner nest-caddy 2>/dev/null || true
systemctl start nest-engine nest-api nest-runner
for attempt in $(seq 1 60); do
  if curl --fail --silent --max-time 2 http://127.0.0.1:8787/health >/dev/null; then break; fi
  sleep 1
done
curl --fail --silent --max-time 5 http://127.0.0.1:8787/health >/dev/null
systemctl is-active --quiet nest-engine nest-api nest-runner
"$node_dir/bin/node" --env-file=/etc/nest/runtime.env --input-type=module <<'JS'
import {readFileSync} from 'node:fs';
let expected; for(let i=0;i<30;i++){try{expected=readFileSync('/app/.nest-data/runner-id','utf8').trim();break;}catch{await new Promise(r=>setTimeout(r,1000));}}
if(!expected) throw Error('Runner identity was not created');
let ready=false;
for(let i=0;i<60;i++) {
  const r=await fetch('http://127.0.0.1:8788/api/runners',{headers:{'x-orgops-runner-token':process.env.NEST_RUNNER_TOKEN},signal:AbortSignal.timeout(3000)});
  if(r.ok && (await r.json()).some(x=>x.id===expected && x.online)) {ready=true;break;}
  await new Promise(r=>setTimeout(r,1000));
}
if(!ready) throw Error('Runner registration/heartbeat failed');
JS
# Pre-open checks: public demos must still require a human session.
[[ $(curl --silent --max-time 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:8787/demo/kibrit-software-factory) == 401 ]]
systemctl enable nest-engine nest-api nest-runner nest-caddy >/dev/null
install -m 755 "$release/deploy/devops/nest-ops.py" /usr/local/lib/nest-ops.py
printf '{"commit":"%s","domain":"%s"}\n' "$sha" "$domain" > /etc/nest/native.json
systemctl start nest-caddy
committed=1
trap - ERR
printf 'Native Nest active: %s. Offline database/config backup: %s\n' "$sha" "$backup"
