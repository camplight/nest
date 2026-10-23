# Claude Code agents in deployed Nest: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. In this repository the plan is executed by Orca workers in worktrees; each worker owns only the files of its task.

**Goal:** Ship Claude Code as a container-first wrapped agent: credential proxy, tool secrets, container account, Admin preset, image tooling, a re-runnable container check, and container-first docs.

**Architecture:** The bridge (`deploy/claude-code-bridge.mjs`, root in the agent container) starts a per-turn localhost proxy that swaps a random dummy credential for the real one, then runs Claude Code as `node` with only an allowlisted environment, forwarded tool secrets and secret files under its home. Admin builds the wrapped recipe from a small form. A runner-only `nest-agents` container from the same image hosts these agents.

**Tech Stack:** Node 22 ESM (`node:http`, `node:https`), vitest (colocated tests), React + Vite admin UI, Playwright browser checks, Docker / Compose.

**Spec:** `docs/superpowers/specs/2026-10-23-claude-code-agent-design.md` (read it fully; section numbers below refer to it).

## Global Constraints

- Never edit `vendor/orgops`. Product changes only in Nest. Read `AGENTS.md`.
- Claude Code version pin: `2.1.309` (`ARG CLAUDE_CODE_VERSION`).
- Permission profiles: exactly `workspace` and `full`; `read-only` is removed everywhere (code, tests, docs).
- Turn limit in the Admin recipe: `timeoutMs: 7200000`. Session scope always `"per-channel"`. `setup.checkCommand: "claude --version"`. Runtime command `exec node`, args `["/app/deploy/claude-code-bridge.mjs"]`.
- Compose agent memory default `2g` (`NEST_AGENTS_MEMORY`).
- Real credential secrets: `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`. Neither ever reaches Claude Code's environment, files it can read, stdout or stderr.
- Do not use `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` or `apiKeyHelper`.
- Failure output: one line on stderr, never raw CLI output or a stack trace.
- Tests: `TMPDIR=/private/tmp npx vitest run <file>` on macOS; compare paths with `realpathSync`.
- Conventional commits ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never push.
- Remove the bridge comment citing `camplight/orgops#70`.

## Review Focus

1. A tool shell in the container reading the bridge's memory or environment (`/proc/<bridge>/environ`, `/proc/1/environ`): must fail because the bridge and runner run as root and Claude runs as `node`. Pinned by Task 4's container check.
2. A listed tool secret named like a protected variable (`NEST_RUNNER_TOKEN`, `ORGOPS_*`, `ANTHROPIC_API_KEY`, `PATH`): never forwarded, never written as a file. Pinned in Task 1 tests.
3. A secret file mapping escaping Claude's home (`../x`, `/etc/x`, `.ssh/../../x`): refused with one line before the turn starts. Pinned in Task 1 tests.
4. A secret removed in Admin after a previous turn wrote it as a file: the file is deleted on the next turn, so rotation and revocation both take effect. Pinned in Task 1 tests.
5. Upstream returning 401 for the real credential: the turn fails within seconds with the sign-in line, and the session is not saved. Pinned in Task 1 tests (proxy against a local fake upstream).

---

### Task 1: Credential proxy and bridge changes (worker A)

**Files:**
- Create: `deploy/claude-code-proxy.mjs`, `deploy/claude-code-proxy.test.mjs`
- Modify: `deploy/claude-code-bridge.mjs`, `deploy/claude-code-bridge.test.mjs`

**Interfaces:**
- Produces (proxy):
  - `startCredentialProxy({ credential, upstream = "https://api.anthropic.com" }) -> Promise<{ url: string, dummy: string, childEnv: Record<string,string>, close(): Promise<void> }>` where `credential = { kind: "oauth" | "apiKey", value: string }`. Listens on `127.0.0.1:0`. `dummy` is a fresh random value per call (`nest-proxy-<uuid>`). `childEnv` is `{ ANTHROPIC_BASE_URL: url, CLAUDE_CODE_OAUTH_TOKEN: dummy }` for oauth or `{ ANTHROPIC_BASE_URL: url, ANTHROPIC_API_KEY: dummy }` for apiKey.
  - `readCredential(env) -> { kind, value } | undefined`: `CLAUDE_CODE_OAUTH_TOKEN` wins over `ANTHROPIC_API_KEY`.
- Produces (bridge config, read from the recipe's `runtime.env`):
  - `NEST_CLAUDE_PERMISSIONS`: `workspace` (default) | `full`.
  - `NEST_CLAUDE_UID`, `NEST_CLAUDE_GID`, `NEST_CLAUDE_HOME`, `NEST_CLAUDE_CONFIG_DIR` (existing names).
  - `NEST_CLAUDE_SECRETS`: comma list of secret names forwarded as env.
  - `NEST_CLAUDE_SECRET_FILES`: comma list of `NAME:relative/path` under Claude's home.
  - `NEST_CLAUDE_UPSTREAM_URL`: proxy upstream (default `https://api.anthropic.com`).
  - Exported `PERMISSION_PROFILES = ["workspace", "full"]`, `forwardedSecrets(env, names) -> Record<string,string>`, `writeSecretFiles({ env, mappings, home, uid, gid }) -> void`, `isProtectedName(name) -> boolean`.

Proxy behaviour (spec 5.3.1, 9.3): every method and path is forwarded to `upstream + path`. Requests whose `authorization` / `x-api-key` does not carry the per-turn dummy get `401` with a JSON error and are not forwarded. For forwarded requests drop `authorization`, `x-api-key`, `host`, `connection`, `proxy-*` and hop-by-hop headers, then set `authorization: Bearer <real>` (oauth) or `x-api-key: <real>` (apiKey); keep every other header (including `anthropic-beta`). Response status, headers and body are piped unchanged (streaming, no buffering). Upstream connection errors become `502`. `close()` stops listening and destroys open sockets.

- [ ] **Step 1: Proxy tests** in `deploy/claude-code-proxy.test.mjs` against a local `http` fake upstream:
  - `swaps the dummy bearer for the real oauth token and keeps other headers`: upstream sees `authorization: Bearer real-oauth`, `anthropic-beta` unchanged, no `x-api-key`; client gets upstream status and body.
  - `swaps x-api-key for an API key credential`.
  - `streams SSE chunks before the upstream response ends`: upstream writes one chunk, waits for the client to have received it, then ends.
  - `rejects requests without the per-turn dummy and never forwards them`: status 401, upstream request count 0.
  - `surfaces an upstream 401 directly and quickly`: upstream 401, client gets 401 in under 1 s.
  - `forwards non-messages paths such as HEAD /api/hello`.
  - `returns 502 when the upstream is unreachable` and `close() ends the server`.
  - `readCredential prefers CLAUDE_CODE_OAUTH_TOKEN`.
- [ ] **Step 2: Run** `TMPDIR=/private/tmp npx vitest run deploy/claude-code-proxy.test.mjs`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `deploy/claude-code-proxy.mjs` with `node:http` server and `node:http`/`node:https` client chosen by upstream protocol.
- [ ] **Step 4: Run** the proxy tests. Expected: PASS. Commit `feat(agents): add per-turn Claude Code credential proxy`.
- [ ] **Step 5: Bridge tests first** (update `deploy/claude-code-bridge.test.mjs`; delete the `read-only`, key-file and orphaned key-file tests):
  - `starts the proxy for a credential secret and gives Claude Code only the dummy`: scripted CLI records env values; `CLAUDE_CODE_OAUTH_TOKEN` in the child equals neither the real value nor is absent, `ANTHROPIC_BASE_URL` is `http://127.0.0.1:<port>`; the real value appears nowhere in the child env, args, stdout or stderr. Same for `ANTHROPIC_API_KEY`. The proxy is closed after the turn (connecting to its port fails).
  - `uses the account's own login without a credential secret`: no `ANTHROPIC_BASE_URL` set by the bridge, no proxy.
  - `forwards listed tool secrets and refuses protected names`: `NEST_CLAUDE_SECRETS="GH_TOKEN,NEST_RUNNER_TOKEN,ORGOPS_X,ANTHROPIC_API_KEY,CLAUDE_CODE_OAUTH_TOKEN,PATH"` forwards only `GH_TOKEN`; unlisted secrets are not forwarded.
  - `writes secret files under Claude's home with mode 600 in 700 folders`: `SSH_PRIVATE_KEY:.ssh/id_ed25519,SSH_KNOWN_HOSTS:.ssh/known_hosts`; content matches, a trailing newline is added when missing, modes `0o600` / `0o700`; a second turn with a changed value overwrites; a turn where the secret is absent removes the file.
  - `refuses secret file paths outside Claude's home and protected names` (`../x`, `/etc/x`, `.ssh/../../x`, `NEST_RUNNER_TOKEN:.x`, malformed `NAME` without path) with one `NEST_CLAUDE_SECRET_FILES ...` line, exit 1, no CLI spawn.
  - `runs Claude Code with the configured account, home and config folder`: spawn options carry `uid`/`gid` from `NEST_CLAUDE_UID`/`GID`; child env `HOME` = `NEST_CLAUDE_HOME`, `CLAUDE_CONFIG_DIR` = `NEST_CLAUDE_CONFIG_DIR`. Use the current uid so no chown is needed in the test.
  - `refuses the full profile when Nest's product database is visible`: with `{nestRoot}` pointing at a temp dir containing `.nest-product/nest.sqlite` (or `NEST_PRODUCT_DB_PATH` pointing at an existing file), `readBridgeConfig` / `runBridge` fails with one line containing `Nest's data`; the same in `workspace` profile is allowed.
  - `refuses workspaces overlapping protected paths in both directions`: keep the existing "contains" cases for `workspace`; add "inside" cases for both profiles: workspace under the state folder, under `ORGOPS_PROJECT_ROOT`, under the product database folder. `<nest>/.nest-data/workspaces/Claude` stays allowed.
  - `does not save a session for a turn that failed sign-in`: first turn, no saved state; scripted not-signed-in turn with a new session id leaves state unchanged (existing test asserts `kept-session`; add the fresh-chat case asserting no state file).
  - `explains error_max_budget_usd`: one line containing `spending limit`.
  - Update `forwards only host, proxy and Claude authentication variables`: `ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN` are never passed through; `ANTHROPIC_BASE_URL` passes through only when there is no credential secret.
  - The invalid-profile message becomes `NEST_CLAUDE_PERMISSIONS must be one of workspace, full`.
- [ ] **Step 6: Run** `TMPDIR=/private/tmp npx vitest run deploy/claude-code-bridge.test.mjs`. Expected: new tests FAIL.
- [ ] **Step 7: Implement in the bridge:**
  - Remove `read-only`, `READ_ONLY_TOOLS`, `apiKeyHelper`, key files, `removeOrphanedKeyFiles`, the quote check, `SCRUBBED_ENV` and `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`, and the `camplight/orgops#70` comment (keep the sentence that the runner sends one SIGTERM and never escalates).
  - `runBridge`: read the credential with `readCredential(env)`; when present, `startCredentialProxy({ credential, upstream: env.NEST_CLAUDE_UPSTREAM_URL })` before spawning and `close()` in `finally` (after a missing-session retry too); merge `childEnv` into the Claude environment. In `workspace` profile the proxy runs too (spec 5.3.8).
  - Protected names (`isProtectedName`): prefix `NEST_`, `ORGOPS_`, `ANTHROPIC_`, `CLAUDE_`, names in `PASSTHROUGH_ENV`, and `DISABLE_AUTOUPDATER`.
  - Secret files: validate at config time (one-line `NEST_CLAUDE_SECRET_FILES ...` error); write before each turn as root, `chown` file and every folder the bridge creates to the Claude account. Folders the bridge creates above Claude's home (`mkdirSync` recursive creates them `0o700` root-owned) must stay traversable: create parents `0o755`, the home and config dir `0o700` owned by the account.
  - Full-profile guard: refuse when any of `resolve(nestRoot, env.NEST_PRODUCT_DB_PATH || ".nest-product/nest.sqlite")` exists, with `NEST_CLAUDE_PERMISSIONS=full refuses to run next to Nest's data (product database found). Assign this agent to the agents runner.`
  - Sign-in failure: `describeFailure` classification for sign-in (401 or `authentication_failed`) also skips saving the session.
  - `error_max_budget_usd`: `Claude Code stopped after reaching its spending limit for this turn.`
  - Sign-in message no longer mentions running `claude` in the container: `Claude Code is not signed in. Add CLAUDE_CODE_OAUTH_TOKEN (from claude setup-token) or ANTHROPIC_API_KEY as a private secret of this agent.`
- [ ] **Step 8: Run** both test files, then `TMPDIR=/private/tmp npm test` and `npm run lint`. Expected: PASS. Commit `feat(agents): proxy the Claude Code credential and forward tool secrets`.

### Task 2: Admin "Claude Code" option (worker B)

**Files:**
- Create: `apps/admin-ui/src/claudeCodeAgent.ts`, `apps/admin-ui/src/claudeCodeAgent.test.ts`, `tests/browser/claude-code-agent.mjs`, `docs/images/validation/claude-code-agent/` (desktop and mobile PNGs plus a short README naming the test data as mocked)
- Modify: `apps/admin-ui/src/screens/AgentsScreen.tsx`, `package.json` (add the browser check to `test:ui:agents`)

**Interfaces:**
- Produces in `claudeCodeAgent.ts`:
  - `type ClaudeCodeOptions = { credential: "oauth" | "apiKey"; timeoutMinutes: number; secretNames: string[]; secretFiles: { name: string; path: string }[] }`
  - `DEFAULT_CLAUDE_CODE_OPTIONS`: `{ credential: "oauth", timeoutMinutes: 120, secretNames: [], secretFiles: [] }`
  - `buildClaudeCodeWrappedConfig(options) -> Record<string, unknown>` producing exactly:
    `{ kind: "claude-code", harness: "command", session: { scope: "per-channel" }, setup: { checkCommand: "claude --version" }, runtime: { command: "exec node", args: ["/app/deploy/claude-code-bridge.mjs"], parse: "text", timeoutMs: minutes*60000, env: { NEST_CLAUDE_PERMISSIONS: "full", NEST_CLAUDE_UID: "1000", NEST_CLAUDE_GID: "1000", NEST_CLAUDE_HOME: "/app/.nest-data/claude/home", NEST_CLAUDE_CONFIG_DIR: "/app/.nest-data/claude/home/.claude", NEST_CLAUDE_SECRETS: names.join(","), NEST_CLAUDE_SECRET_FILES: files.map(f => `${f.name}:${f.path}`).join(",") } }, secrets: { allowedKeys: [credentialName, ...secretNames, ...fileNames] } }` (de-duplicated; omit empty `NEST_CLAUDE_SECRETS` / `NEST_CLAUDE_SECRET_FILES`).
  - `readClaudeCodeOptions(wrappedConfig) -> ClaudeCodeOptions | null`: `null` unless `kind === "claude-code"`; round-trips `buildClaudeCodeWrappedConfig`.
  - `requiredSecretNames(options) -> string[]`: credential name first, then tool secrets and file secrets.
  - `pickClaudeCodeRunner(runners: RunnerNode[]) -> string`: id of an online runner whose `displayName` is `nest-agents` (set by Task 3's compose file), else `""` (engine default).
  - `isValidSecretName(name)`: `/^[A-Z_][A-Z0-9_]*$/` and not protected (`NEST_`, `ORGOPS_`, `ANTHROPIC_`, `CLAUDE_` prefixes); `isValidSecretPath(path)`: relative, no `..` segment.

UI (spec 5.4; exact control is the builder's call): add `Claude Code` as an option of the Mode select (form keeps `mode: "WRAPPED"` plus a `claudeCode: ClaudeCodeOptions | null` field). Choosing it sets `modelId: "wrapped:none"`, hides model and memory fields (already hidden for WRAPPED), shows: credential kind (subscription token / API key), turn limit in minutes (default 120), tool secret names (add/remove), secret files (name + path under Claude's home, placeholder `SSH_PRIVATE_KEY` / `.ssh/id_ed25519`), a read-only preview of the generated JSON, and a notice: "Add these secrets in Admin → Secrets with scope Private, agent <name>: …". Defaults the assigned runner with `pickClaudeCodeRunner` when creating and the operator has not chosen one; when no `nest-agents` runner exists, show "No agent container runner found. Claude Code agents need the nest-agents container (docs/CLAUDE_CODE_AGENT.md)." Editing an agent whose config has `kind: "claude-code"` opens in this view. Save uses the existing create/update calls with `wrappedConfig = buildClaudeCodeWrappedConfig(...)`.

- [ ] **Step 1: Unit tests** in `claudeCodeAgent.test.ts`: `builds the container recipe` (exact object above for oauth, 120 min, `GH_TOKEN`, `SSH_PRIVATE_KEY:.ssh/id_ed25519`), `uses ANTHROPIC_API_KEY for the API key credential`, `round-trips through readClaudeCodeOptions` and returns `null` for `kind: "custom"`, `de-duplicates allowedKeys`, `rejects protected and malformed names and escaping paths`, `picks the online nest-agents runner and otherwise the engine default`.
- [ ] **Step 2: Run** `npx vitest run apps/admin-ui/src/claudeCodeAgent.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `claudeCodeAgent.ts`, then the form changes in `AgentsScreen.tsx`.
- [ ] **Step 4: Run** unit tests, `npx vitest run apps/admin-ui`, `npm run lint`, `npm run build`. Expected: PASS.
- [ ] **Step 5: Browser check** `tests/browser/claude-code-agent.mjs` following the mocked-API pattern of `tests/browser/agents.mjs`/`agent-runtime-status.ts` against the admin UI: choose Claude Code, add `GH_TOKEN` and an SSH file mapping, assert the runner defaults to `nest-agents`, the secrets notice lists `CLAUDE_CODE_OAUTH_TOKEN, GH_TOKEN, SSH_PRIVATE_KEY`, save, and assert the captured POST `/api/agents` body has `mode: "WRAPPED"`, `modelId: "wrapped:none"`, the exact recipe; reopen the agent and see the Claude Code view. Capture desktop (1440 wide) and mobile (390 wide) screenshots into `docs/images/validation/claude-code-agent/`. No horizontal scroll on mobile.
- [ ] **Step 6: Run** `node tests/browser/claude-code-agent.mjs`. Expected: PASS. Commit `feat(admin): add Claude Code option to agent creation`.

### Task 3: Image, Compose and container check (worker C)

**Files:**
- Modify: `Dockerfile`, `deploy/compose.claude-agents.yaml`
- Create: `tests/container/claude-code-agent.sh` (entry point), `tests/container/mock-anthropic.mjs`, `tests/container/README.md`; add `"check:container:claude": "bash tests/container/claude-code-agent.sh"` to `package.json`.

**Interfaces:**
- Consumes: Task 1's env names (`NEST_CLAUDE_UPSTREAM_URL`, `NEST_CLAUDE_SECRETS`, `NEST_CLAUDE_SECRET_FILES`, account vars) and Task 2's recipe shape (use `buildClaudeCodeWrappedConfig`'s exact JSON, inlined in the script).
- Produces: image tag argument `NEST_IMAGE` (default `nest:claude-check`), compose project `nest-claude-check`.

Image (spec 5.2): runtime stage installs `git` and `openssh-client` via apt and the GitHub CLI pinned by `ARG GH_VERSION` (official release `.deb` for `$(dpkg --print-architecture)`, checksum verified against the release's `checksums.txt`); `gh --version` and `git --version` and `ssh -V` at build. Copy `deploy/claude-code-proxy.mjs` next to the bridge with the same chmod and include it in the `node` import check.

Compose: `mem_limit: ${NEST_AGENTS_MEMORY:-2g}`; add `NEST_RUNNER_NAME: nest-agents`.

Mock Anthropic API (`mock-anthropic.mjs`, runs with `node` inside the agent container, port from argv): `HEAD/GET` anything → 200 `{}`; records every request's method, path and auth headers to a JSON log file. `POST /v1/messages` with `stream: true` answers in Anthropic SSE format (`message_start`, `content_block_start`/`delta`/`stop`, `message_delta` with `stop_reason`, `message_stop`). Requests without a `tools` array (title or summary calls) get a short text reply. Scripted agent: step = number of `tool_result` blocks in the conversation; step 0 replies text `Checking the container.` plus a `Bash` tool_use running one compound command: `id; env | sort; cat /proc/1/environ | tr '\0' '\n'; ls -la /app/.nest-data /app/.nest-product /app/files; find / -name '*.sqlite' -not -path '/proc/*' 2>/dev/null; echo ok > check.txt; cat check.txt`; step 1 replies with final text `RESULT:` followed by the tool result text verbatim. A message containing `SLEEP` instead runs `sleep 600` as the tool.

Check script steps (exits non-zero on any failed assertion, prints a PASS/FAIL table, never prints the fake credential):
1. `docker build -t $NEST_IMAGE .`; `docker run --rm $NEST_IMAGE sh -c 'claude --version && gh --version && git --version && ssh -V'`.
2. Temp dir with `.env` (admin user, generated master key and runner token) and a compose override publishing the API on a free localhost port, removing caddy and the public host settings; `docker compose -p nest-claude-check -f deploy/compose.yaml -f deploy/compose.claude-agents.yaml -f <override> up -d`.
3. Wait for both runners via the API; the agents runner is `nest-agents`.
4. Start the mock inside the agent container (`docker exec -d ... node /tmp/mock-anthropic.mjs 4010`, copied with `docker cp`).
5. Create secret `CLAUDE_CODE_OAUTH_TOKEN` (private to the agent) with a random fake value `sk-ant-oat01-check-<random>` held only in a shell variable; create the agent with the Admin recipe plus `NEST_CLAUDE_UPSTREAM_URL=http://127.0.0.1:4010`, assigned to `nest-agents`; channel, subscribe, mention (facts in the orchestrator brief, section 3 of `tests/container/README.md`).
6. Assert from channel events: a `wrapped-progress` event `Checking the container.`; the reply contains `uid=1000(node)`; the reply's env section contains `CLAUDE_CODE_OAUTH_TOKEN=nest-proxy-`; no `NEST_`/`ORGOPS_` variables; `/proc/1/environ` is unreadable; no `.sqlite` file found and `/app/.nest-product` empty or absent; the fake credential appears nowhere in events; the mock log shows `authorization: Bearer <fake>` (proxy swap; compare inside the container, print only true/false).
7. `docker exec -u node nest-agents sh -c 'grep -rIlF -- "$V" / --exclude-dir=proc --exclude-dir=sys 2>/dev/null; for f in /proc/[0-9]*/environ; do grep -lF -- "$V" $f 2>/dev/null; done'` with the value passed via env of the exec: expect no output.
8. Stop: a second agent with `timeoutMs: 20000` asked `SLEEP`; assert `agent.turn.failed` (or a reply) within 60 s mentioning the stop line, and no `sleep 600` or `claude` process left in the container afterwards.
9. Refusal: a third agent with the same recipe assigned to the Nest container's runner; assert the turn fails with the `Nest's data` line.
10. `docker compose ... down -v` on exit (trap), unless `KEEP=1`.

- [ ] **Step 1:** Dockerfile and compose changes; `docker build` succeeds and the tool versions print. Commit `build(image): add git, ssh and gh for Claude Code agents`.
- [ ] **Step 2:** Mock server; validate it against the real CLI in the built image without Nest: `docker run --rm -i --user node -e ANTHROPIC_BASE_URL=http://127.0.0.1:4010 -e CLAUDE_CODE_OAUTH_TOKEN=dummy $NEST_IMAGE sh -s` that starts the mock and runs `claude -p --output-format stream-json --verbose --permission-mode bypassPermissions 'go'`; expected: the result text starts with `RESULT:` and contains `uid=1000(node)`.
- [ ] **Step 3:** Check script steps 2 to 10. It is expected to fail at steps 6 to 9 until Task 1 is integrated; the orchestrator runs it after integration. Commit `test(agents): add re-runnable Claude Code container check`.

### Task 4: Integration, docs and verification (orchestrator)

**Files:** `docs/CLAUDE_CODE_AGENT.md`, `docs/SPEC.md`, `README.md`, `deploy/DEPLOYMENT.md` (agent container section if deployment steps live there).

- [ ] Merge Tasks 1 to 3 onto `feat/claude-code-wrapped-runtime`; resolve conflicts in `package.json`.
- [ ] Docs (spec 5.5): container-first `CLAUDE_CODE_AGENT.md` (enable the agent container, create the agent in Admin, secrets for token, GitHub and SSH, what the agent can and cannot reach from spec section 6 including the shared `node` account limit, upgrading Claude Code via `CLAUDE_CODE_VERSION`, developer machine setup as the last section); `read-only` removed; SPEC.md and README.md matched.
- [ ] Run `npm run check:container:claude`; all assertions PASS.
- [ ] Developer machine (spec 5.3.8): on macOS with the `workspace` profile and a fake credential, use the mock to run `ps -E -ax`, `ps eww -ax`, and `lsof -p <bridge pid>`; verify the fake value never appears. Record the outcome.
- [ ] Live test (spec 7.4) with the operator's real token and test repository and SSH host.
- [ ] `npm run lint`, `TMPDIR=/private/tmp npm test`, `npm run build`, `npm run test:ui:chat`, `node tests/browser/codex-progress.mjs`.
- [ ] Independent review by fresh agents given the code, fix substantiated findings, re-verify.
