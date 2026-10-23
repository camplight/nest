#!/usr/bin/env bash
# Re-runnable container check for Claude Code agents: builds the image, starts Nest plus the
# runner-only agent container, and runs scripted turns against a mock Anthropic API.
# See tests/container/README.md. KEEP=1 leaves the stack running; SKIP_BUILD=1 reuses the image.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export NEST_IMAGE="${NEST_IMAGE:-nest:claude-check}"
PROJECT=nest-claude-check
MOCK_PORT=4010
WORK="$(mktemp -d "${TMPDIR:-/tmp}/nest-claude-check.XXXXXX")"
JAR="$WORK/cookies"
COMPOSE=(docker compose -p "$PROJECT" --project-directory "$WORK" -f "$ROOT/deploy/compose.yaml" -f "$ROOT/deploy/compose.claude-agents.yaml" -f "$WORK/override.yaml")
STEPS=() RESULTS=() NOTES=()
STARTED=0 FAILED=0 FAKE=""

# Notes and logs quote agent replies; a broken bridge could put the credential in them.
redact() { if [[ -n "$FAKE" ]]; then printf '%s' "${1//"$FAKE"/<credential>}"; else printf '%s' "$1"; fi; }
record() { STEPS+=("$1"); RESULTS+=("$2"); NOTES+=("$(redact "${3:-}")"); [[ "$2" == FAIL ]] && FAILED=1; return 0; }
log() { printf '  %s\n' "$(redact "$*")" >&2; }

finish() {
  local status=$?
  if [[ "$STARTED" == 1 ]]; then
    if [[ "${KEEP:-}" == 1 ]]; then
      log "KEEP=1: stack left running (project $PROJECT, files in $WORK)"
    else
      "${COMPOSE[@]}" logs --no-color >"$WORK/compose.log" 2>&1 || true
      "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
    fi
  fi
  if [[ -n "$FAKE" ]]; then
    for file in "$WORK"/*.json "$WORK"/*.txt "$WORK"/*.log; do
      [[ -f "$file" ]] || continue
      content="$(<"$file")"; [[ "$content" == *"$FAKE"* ]] && redact "$content" >"$file"
    done
  fi
  printf '\n%-4s  %-52s  %s\n' RES STEP NOTE
  for i in "${!STEPS[@]}"; do printf '%-4s  %-52s  %s\n' "${RESULTS[$i]}" "${STEPS[$i]}" "${NOTES[$i]}"; done
  [[ "${KEEP:-}" == 1 ]] || { [[ "$FAILED" == 1 ]] && log "Logs kept in $WORK" || rm -rf "$WORK"; }
  if [[ "$FAILED" == 1 || "$status" != 0 ]]; then exit 1; fi
  exit 0
}
trap finish EXIT
trap 'exit 130' INT TERM

skip_rest() { for step in "$@"; do record "$step" SKIP "earlier step failed"; done; exit 1; }

api() { # api METHOD PATH [BODY|@-]  -> body on stdout, HTTP status in $WORK/status
  local args=(-sS -m 20 -b "$JAR" -c "$JAR" -X "$1" -o "$WORK/body" -w '%{http_code}' -H 'content-type: application/json')
  [[ -n "${3:-}" ]] && args+=(--data-binary "$3")
  curl "${args[@]}" "$BASE$2" >"$WORK/status" 2>>"$WORK/curl.log" || echo 000 >"$WORK/status"
  cat "$WORK/body" 2>/dev/null
}
ok_status() { [[ "$(cat "$WORK/status")" =~ ^2 ]]; }

# Polls until `jq -e FILTER` holds for the channel's events or the timeout passes; events in $WORK/events.json.
wait_events() { # wait_events CHANNEL_ID FILTER SECONDS
  local deadline=$((SECONDS + $3))
  while ((SECONDS < deadline)); do
    api GET "/api/events?channelId=$1&limit=500" >"$WORK/events.json"
    if ok_status && jq -e "$2" "$WORK/events.json" >/dev/null 2>&1; then return 0; fi
    sleep 3
  done
  return 1
}

agent_events() { jq --arg s "agent:$1" '[.[] | select(.source == $s)]' "$WORK/events.json"; }

# The Admin recipe (apps/admin-ui/src/claudeCodeAgent.ts), pointed at the mock API. ANTHROPIC_BASE_URL
# keeps a bridge without the credential proxy local too; the proxy replaces it in Claude Code's environment.
recipe() { # recipe TIMEOUT_MS
  jq -n --argjson timeout "$1" --arg upstream "http://127.0.0.1:$MOCK_PORT" '{
    kind: "claude-code", harness: "command", session: {scope: "per-channel"},
    setup: {checkCommand: "claude --version"},
    runtime: {command: "exec node", args: ["/app/deploy/claude-code-bridge.mjs"], parse: "text", timeoutMs: $timeout,
      env: {NEST_CLAUDE_PERMISSIONS: "full", NEST_CLAUDE_UID: "1000", NEST_CLAUDE_GID: "1000",
        NEST_CLAUDE_HOME: "/app/.nest-data/claude/home", NEST_CLAUDE_CONFIG_DIR: "/app/.nest-data/claude/home/.claude",
        NEST_CLAUDE_UPSTREAM_URL: $upstream, ANTHROPIC_BASE_URL: $upstream}},
    secrets: {allowedKeys: ["CLAUDE_CODE_OAUTH_TOKEN"]}}'
}

# Creates an agent with its private credential secret and mentions it in a fresh channel; prints the channel id.
start_turn() { # start_turn NAME RUNNER_ID TIMEOUT_MS TEXT
  local name=$1 body channel
  body="$(jq -n --arg name "$name" --arg runner "$2" --argjson config "$(recipe "$3")" \
    '{name: $name, workspacePath: (".nest-data/workspaces/" + $name), mode: "WRAPPED", modelId: "wrapped:none", assignedRunnerId: $runner, wrappedConfig: $config}')"
  api POST /api/agents "$body" >/dev/null; ok_status || { log "create agent $name: HTTP $(cat "$WORK/status") $(head -c 300 "$WORK/body")"; return 1; }
  # The value goes through stdin so it never appears in a process list or this script's output.
  printf '{"name":"CLAUDE_CODE_OAUTH_TOKEN","value":"%s","scopeType":"private","scopeId":"%s"}' "$FAKE" "$name" | api POST /api/secrets @- >/dev/null
  ok_status || { log "create secret for $name: HTTP $(cat "$WORK/status")"; return 1; }
  channel="$(api POST /api/channels "$(jq -n --arg n "claude-check-$(echo "$name" | tr '[:upper:]' '[:lower:]')-$RANDOM" '{name: $n}')" | jq -r '.id // empty')"
  [[ -n "$channel" ]] || { log "create channel: HTTP $(cat "$WORK/status") $(head -c 300 "$WORK/body")"; return 1; }
  api POST "/api/channels/$channel/subscribe" "$(jq -n --arg id "$name" '{subscriberType: "AGENT", subscriberId: $id}')" >/dev/null
  ok_status || { log "subscribe $name: HTTP $(cat "$WORK/status") $(head -c 300 "$WORK/body")"; return 1; }
  api POST /api/messages "$(jq -n --arg id "$(uuidgen | tr '[:upper:]' '[:lower:]')" --arg ch "$channel" --arg name "$name" --arg text "@$name $4" \
    '{id: $id, channelId: $ch, text: $text, mentions: [{kind: "AGENT", name: $name, start: 0, end: (($name | length) + 1)}]}')" >/dev/null
  ok_status || { log "send message: HTTP $(cat "$WORK/status") $(head -c 300 "$WORK/body")"; return 1; }
  echo "$channel"
}

# Waits for the agent's reply or failure; its events land in $WORK/<name>.json and the text in $WORK/<name>.txt.
wait_turn() { # wait_turn NAME CHANNEL SECONDS
  local s="agent:$1"
  wait_events "$2" "any(.[]; .source == \"$s\" and (.type == \"message.created\" or .type == \"agent.turn.failed\"))" "$3" || return 1
  agent_events "$1" >"$WORK/$1.json"
  jq -r '.[] | select(.type == "message.created" or .type == "agent.turn.failed") | (.payload.text // .payload.error // .payload.message // (.payload | tostring))' "$WORK/$1.json" >"$WORK/$1.txt"
}

inside() { docker exec -i "$AGENTS" "$@"; }

# macOS has no timeout(1). The explicit stdin redirect keeps it for the background command.
with_timeout() { # with_timeout SECONDS COMMAND...
  local seconds=$1 pid watcher status; shift
  "$@" 0<&0 & pid=$!
  (sleep "$seconds"; kill "$pid" 2>/dev/null) & watcher=$!
  wait "$pid"; status=$?
  kill "$watcher" 2>/dev/null; wait "$watcher" 2>/dev/null
  return "$status"
}

cd "$ROOT"

# 1. Image and tools.
if [[ "${SKIP_BUILD:-}" == 1 ]] || docker build -t "$NEST_IMAGE" . >"$WORK/build.log" 2>&1; then
  if versions="$(docker run --rm --entrypoint sh "$NEST_IMAGE" -c 'claude --version && gh --version | head -1 && git --version && ssh -V 2>&1')"; then
    record "1 image builds, tools present" PASS "$(echo "$versions" | tr '\n' ';' | cut -c1-110)"
  else record "1 image builds, tools present" FAIL "tool versions did not print"; fi
else
  record "1 image builds, tools present" FAIL "docker build failed, see $WORK/build.log"
fi
[[ "$FAILED" == 0 ]] || skip_rest "2 compose stack up" "3 both runners online" "4 mock API in agent container" "5 agent, secret and turn created"

# 2. Stack: Nest plus the agent container, API on a free localhost port, no Caddy or public host.
PORT="$(node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')"
BASE="http://127.0.0.1:$PORT"
ADMIN_PASS="check-$(openssl rand -hex 12)"
cat >"$WORK/.env" <<EOF
NEST_ADMIN_USER=admin
NEST_ADMIN_PASS=$ADMIN_PASS
NEST_MASTER_KEY=$(openssl rand -base64 32)
NEST_RUNNER_TOKEN=check-$(openssl rand -hex 16)
EOF
cat >"$WORK/override.yaml" <<EOF
services:
  nest:
    image: $NEST_IMAGE
    environment:
      NEST_PUBLIC_HOST: ""
      NEST_COOKIE_SECURE: never
    ports:
      - "127.0.0.1:$PORT:8787"
  nest-agents:
    image: $NEST_IMAGE
EOF
"${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
STARTED=1
if "${COMPOSE[@]}" up -d --wait --wait-timeout 240 nest nest-agents >"$WORK/up.log" 2>&1; then
  AGENTS="$("${COMPOSE[@]}" ps -q nest-agents)"
  record "2 compose stack up" PASS "project $PROJECT, API on $PORT"
else
  record "2 compose stack up" FAIL "compose up failed or unhealthy, see $WORK/up.log"
  skip_rest "3 both runners online" "4 mock API in agent container" "5 agent, secret and turn created"
fi

# 3. Both runners register; the agent container's runner is named nest-agents.
api POST /api/auth/login "$(jq -n --arg p "$ADMIN_PASS" '{username: "admin", password: $p}')" >/dev/null
deadline=$((SECONDS + 120)) AGENTS_RUNNER="" NEST_RUNNER=""
while ((SECONDS < deadline)); do
  runners="$(api GET /api/runners)"
  if ok_status; then
    AGENTS_RUNNER="$(jq -r '[.[] | select(.online and .displayName == "nest-agents")][0].id // empty' <<<"$runners")"
    NEST_RUNNER="$(jq -r '[.[] | select(.online and .displayName != "nest-agents")][0].id // empty' <<<"$runners")"
    [[ -n "$AGENTS_RUNNER" && -n "$NEST_RUNNER" ]] && break
  fi
  sleep 3
done
if [[ -n "$AGENTS_RUNNER" && -n "$NEST_RUNNER" ]]; then record "3 both runners online" PASS "nest-agents=$AGENTS_RUNNER"
else
  record "3 both runners online" FAIL "runners: $(jq -c '[.[]? | {displayName, online}]' <<<"${runners:-[]}" 2>/dev/null | cut -c1-90)"
  skip_rest "4 mock API in agent container" "5 agent, secret and turn created"
fi

# 4. Mock Anthropic API inside the agent container, started as root so its request log stays root-only.
docker cp "$ROOT/tests/container/mock-anthropic.mjs" "$AGENTS:/tmp/mock-anthropic.mjs" >/dev/null
docker exec -d "$AGENTS" sh -c "node /tmp/mock-anthropic.mjs $MOCK_PORT /tmp/mock-anthropic.jsonl >/tmp/mock-anthropic.out 2>&1"
mock_up=0
for _ in $(seq 1 20); do inside curl -fsS -m 2 -I "http://127.0.0.1:$MOCK_PORT/mock-ready" >/dev/null 2>&1 && { mock_up=1; break; }; sleep 0.5; done
if [[ "$mock_up" == 1 ]]; then record "4 mock API in agent container" PASS "127.0.0.1:$MOCK_PORT"
else record "4 mock API in agent container" FAIL "mock did not answer"; skip_rest "5 agent, secret and turn created"; fi

# 5. Agent with the Admin recipe, its private credential secret, a channel and a mention.
FAKE="sk-ant-oat01-check-$(openssl rand -hex 16)"
if CHANNEL="$(start_turn ClaudeCheck "$AGENTS_RUNNER" 7200000 "please check the container")"; then
  record "5 agent, secret and turn created" PASS "channel $CHANNEL"
else
  record "5 agent, secret and turn created" FAIL "see messages above"
  skip_rest "6 reply proves account, env and data isolation" "7 credential unreadable as node" "8 timeout stops Claude Code" "9 full profile refuses Nest container"
fi

# 6. The turn runs as node, sees only the dummy credential and none of Nest's data or settings.
if wait_turn ClaudeCheck "$CHANNEL" 240; then
  reply="$(cat "$WORK/ClaudeCheck.txt")" problems=()
  jq -e 'any(.[]; .type == "agent.turn.phase" and .payload.phase == "wrapped-progress" and .payload.text == "Checking the container.")' "$WORK/ClaudeCheck.json" >/dev/null || problems+=("no progress event")
  [[ "$reply" == *"uid=1000(node)"* ]] || problems+=("not uid 1000")
  # Claude Code drops its own token from tool environments, so the proxy shows as the base URL;
  # a visible token may only ever be the per-turn dummy.
  grep -qE "^ANTHROPIC_BASE_URL=http://127\.0\.0\.1:[0-9]+$" <<<"$reply" && ! grep -q "^ANTHROPIC_BASE_URL=http://127.0.0.1:$MOCK_PORT$" <<<"$reply" || problems+=("base URL is not the per-turn proxy")
  grep -E '^(CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY)=' <<<"$reply" | grep -v '=nest-proxy-' >/dev/null && problems+=("non-dummy credential visible")
  grep -qE '^(NEST|ORGOPS)_[A-Z0-9_]*=' <<<"$reply" && problems+=("NEST_/ORGOPS_ variables visible")
  [[ "$reply" == *"/proc/1/environ: Permission denied"* ]] || problems+=("/proc/1/environ readable")
  [[ "$reply" == *".sqlite"* ]] && problems+=("sqlite file visible")
  grep -qE '^RESULT:' <<<"$reply" || problems+=("no RESULT reply")
  [[ "$(cat "$WORK/events.json")" == *"$FAKE"* ]] && problems+=("credential in events")
  swapped="$(inside sh -c 'read -r V; grep -qF "\"authorization\":\"Bearer $V\"" /tmp/mock-anthropic.jsonl && echo true || echo false' <<<"$FAKE")"
  [[ "$swapped" == true ]] || problems+=("upstream did not see the real credential (swap=$swapped)")
  if ((${#problems[@]} == 0)); then record "6 reply proves account, env and data isolation" PASS
  else record "6 reply proves account, env and data isolation" FAIL "$(IFS=';'; echo "${problems[*]}" | cut -c1-110)"; fi
else
  record "6 reply proves account, env and data isolation" FAIL "no reply or failure within 240 s"
fi
[[ -s "$WORK/ClaudeCheck.txt" ]] && log "ClaudeCheck reply (first lines): $(head -c 300 "$WORK/ClaudeCheck.txt" | tr '\n' ' ')"

# 7. Nothing node can read (files, any process environment) holds the credential.
if found="$(with_timeout 300 docker exec -i -u node "$AGENTS" sh -c 'read -r V; grep -rIlF -- "$V" / --exclude-dir=proc --exclude-dir=sys 2>/dev/null; for f in /proc/[0-9]*/environ; do grep -lF -- "$V" "$f" 2>/dev/null; done; true' <<<"$FAKE")"; then
  if [[ -z "$found" ]]; then record "7 credential unreadable as node" PASS
  else record "7 credential unreadable as node" FAIL "found in: $(echo "$found" | tr '\n' ' ' | cut -c1-90)"; fi
else
  record "7 credential unreadable as node" FAIL "search did not finish within 300 s"
fi

# 8. A turn timeout ends Claude Code and its tool processes.
if STOP_CHANNEL="$(start_turn ClaudeStop "$AGENTS_RUNNER" 20000 "SLEEP")" && wait_turn ClaudeStop "$STOP_CHANNEL" 60; then
  sleep 12 # the bridge's kill grace period
  left="$(inside sh -c 'for p in /proc/[0-9]*; do tr "\0" " " <"$p/cmdline" 2>/dev/null; echo; done' | grep -E 'sleep 600|(^|/)claude( |$)' || true)"
  if ! grep -q "stopped before it finished" "$WORK/ClaudeStop.txt"; then record "8 timeout stops Claude Code" FAIL "no stop line: $(head -c 80 "$WORK/ClaudeStop.txt" | tr '\n' ' ')"
  elif [[ -n "$left" ]]; then record "8 timeout stops Claude Code" FAIL "left running: $(echo "$left" | tr '\n' ' ' | cut -c1-80)"
  else record "8 timeout stops Claude Code" PASS; fi
else
  record "8 timeout stops Claude Code" FAIL "no failure or reply within 60 s"
fi

# 9. The full profile refuses to run in the Nest container, next to its databases.
if REFUSE_CHANNEL="$(start_turn ClaudeRefuse "$NEST_RUNNER" 60000 "please check the container")" && wait_turn ClaudeRefuse "$REFUSE_CHANNEL" 90; then
  if grep -q "Nest's data" "$WORK/ClaudeRefuse.txt"; then record "9 full profile refuses Nest container" PASS
  else record "9 full profile refuses Nest container" FAIL "got: $(head -c 90 "$WORK/ClaudeRefuse.txt" | tr '\n' ' ')"; fi
else
  record "9 full profile refuses Nest container" FAIL "no failure or reply within 90 s"
fi
