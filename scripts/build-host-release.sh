#!/usr/bin/env bash
# Build on Linux CI/a build host, never beside production agents.
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")/.."
# shellcheck source=../deploy/native/versions.env
source deploy/native/versions.env
[[ $(uname -s) == Linux ]] || { echo 'Build native releases on Linux.' >&2; exit 1; }
[[ $(node --version) == "v$NODE_VERSION" ]] || { echo "Node $NODE_VERSION required." >&2; exit 1; }
[[ -z $(git status --porcelain --untracked-files=no) ]] || { echo 'Commit changes before packaging.' >&2; exit 1; }
[[ -z $(git -C vendor/orgops status --porcelain) ]] || { echo 'OrgOps must be untouched.' >&2; exit 1; }
output=${1:?Usage: scripts/build-host-release.sh /absolute/output.tar.gz}
[[ "$output" == /* ]] || { echo 'Output must be absolute.' >&2; exit 1; }
npm ci
# Gate the release on the real-engine regression at the production heap budget.
npm run test:engine -- apps/api/src/event-history-memory.test.ts apps/agent-runner/src/tools/types.test.ts
# Keep reviewed engine authorization/realtime contracts in the native release gate.
npm run test:engine -- \
  apps/api/src/security-auth.test.ts \
  apps/api/src/security-controls.test.ts \
  apps/api/src/security-federation.test.ts \
  apps/api/src/security-http.test.ts \
  apps/api/src/security-live-data.test.ts \
  apps/api/src/security-workspaces.test.ts \
  apps/api/src/agent-starts.test.ts \
  apps/api/src/runner-socket.test.ts \
  apps/agent-runner/src/runner/socket.test.ts \
  apps/agent-runner/src/turn-executor.classic.test.ts \
  apps/agent-runner/src/turn-executor.test.ts \
  apps/agent-runner/src/channel-injection.test.ts \
  apps/agent-runner/src/maintenance-loop.test.ts \
  apps/agent-runner/src/realtime-voice.test.ts
node --test deploy/native/livekit.check.mjs
npm ci --prefix deploy/native/agent-clis
VITE_UI_BASE_PATH=/admin/ npm run admin-ui:build
VITE_UI_BASE_PATH=/ npm run user-ui:build
node --input-type=module <<'JS'
import {writeFileSync,readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const sha=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const git=(...args)=>execFileSync('git',args,{encoding:'utf8'}).trim();
writeFileSync('nest-release.json',JSON.stringify({format:1,commit:git('rev-parse','HEAD'),engine:git('-C','vendor/orgops','rev-parse','HEAD'),platform:process.platform,arch:process.arch,node:process.version,pins:sha('deploy/native/versions.env'),lock:sha('package-lock.json'),agentLock:sha('deploy/native/agent-clis/package-lock.json')})+'\n');
JS
list=$(mktemp)
trap 'rm -f "$list" nest-release.json' EXIT
git ls-files --recurse-submodules -z > "$list"
# npm may keep conflicting dependency versions inside selected workspaces.
find apps packages vendor -type d -name node_modules -prune -print0 >> "$list"
printf '%s\0' node_modules apps/admin-ui/dist apps/user-ui/dist deploy/native/agent-clis/node_modules nest-release.json >> "$list"
tar --null --files-from="$list" -czf "$output"
(cd "$(dirname "$output")" && sha256sum "$(basename "$output")") > "$output.sha256"
echo "Built $output"
