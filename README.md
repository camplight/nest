# Nest

[Repository](https://github.com/camplight/nest) · [Migration from OrgOps](docs/REBRANDING.md)

Nest is a Node.js multi-host agent system where humans and autonomous agents collaborate via an event bus. Agents can run host shell/filesystem/process operations, manage long-running jobs, and stream outputs back to humans/models. The current deployment model emphasizes deterministic host assignment and a local autonomous bootstrap/maintenance CLI (`nest`).

## Repo layout

```
apps/
  api/            Hono HTTP + WebSocket API
  agent-runner/   Agent supervisor and tool executor
  cli/            Host bootstrap + maintenance CLI agent
  admin-ui/       React + Tailwind admin UI
  user-ui/        Lightweight non-technical user UI
packages/
  crypto/         Envelope encryption helpers
  db/             SQLite schema + migrations
  event-bus/      Pub/sub helpers
  llm/            Vercel AI SDK wrapper
  schemas/        Zod schemas + typed event shapes
  skills/         Skill catalog parser
skills/           Built-in skills (+ optional event-shapes.ts per skill)
files/            Runtime file storage (gitignored)
.nest-data/      Runtime DB + workspaces (gitignored)
```

## Requirements

- Node 22+
- SQLite
- Python 3.11+ for browser automation skills (Playwright/Lightpanda)

## Quickstart

```bash
npm install

# Dev: API + agent-runner + admin UI
npm run dev:all
```

Open `http://localhost:5173` for admin UI, `http://localhost:5190` for user UI,
and API on `http://localhost:8787`.

## Brand your instance

Open **Admin → Branding** as the instance owner to set your organization name,
logo, sidebar color, accent, and workspace background. Preview changes before
saving. Both apps and sign-in screens use the saved identity, with a fixed
**Powered by Nest** footer. Settings persist in SQLite; no rebuild is required.
New instances use Nest defaults. See [white-label configuration](docs/REBRANDING.md#white-label-instances).

## Embed an agent in another product

External apps authenticate with an **API key** and call `/v1/conversations` +
`/v1/chat/completions`. In admin UI → **API keys**, use **Copy prompt** and
paste it into the embedding app’s coding agent.

## Deployment approach

Nest is split into three runtime components plus one bootstrap/maintenance CLI:

- `api`: central API/event system
- `admin-ui`: operator/admin control surface
- `user-ui`: lightweight non-technical user workspace
- `agent-runner`: host-local execution runtime
- `nest`: host bootstrap + maintenance CLI (deterministic commands + optional chat)

Multi-host execution is kept intentionally simple:

- each runner registers at API and gets/persists a stable runner ID in `.agent-runner-id`
- each agent can be assigned to one `assignedRunnerId`
- runners only pick up agents assigned to their own runner ID

This guarantees "same agent, same host" behavior without a complex scheduler.

## Production

```bash
npm run prod:all
```

This builds both UIs and runs the API, runner, and admin UI preview.

If you deploy the UIs separately, they use same-origin `/api` and `/ws` paths in production
builds. Put each UI and API behind the same public origin (or reverse proxy these paths to
the API service) so browser auth cookies and WebSocket traffic work correctly.

### Single-image container deployment

Nest now ships a root `Dockerfile` that builds one reusable image containing API, runner,
admin UI, and user UI. The container entrypoint starts whichever components you choose via
`NEST_COMPONENTS`.

Build:

```bash
docker build -t nest:local .
```

Run API + runner + user UI (default):

```bash
docker run --rm -p 8787:8787 \
  -e NEST_COMPONENTS=api,runner,user-ui \
  -e NEST_MASTER_KEY='<32-byte-base64>' \
  -v nest-data:/app/.nest-data \
  -v nest-files:/app/files \
  nest:local
```

Run API only:

```bash
docker run --rm -p 8787:8787 \
  -e NEST_COMPONENTS=api \
  -e NEST_MASTER_KEY='<32-byte-base64>' \
  -v nest-data:/app/.nest-data \
  -v nest-files:/app/files \
  nest:local
```

Run runner only (against an external API):

```bash
docker run --rm \
  -e NEST_COMPONENTS=runner \
  -e NEST_API_URL='https://nest.example.com' \
  -e NEST_RUNNER_TOKEN='<runner-token>' \
  -e NEST_MASTER_KEY='<32-byte-base64>' \
  -v nest-data:/app/.nest-data \
  -v nest-files:/app/files \
  nest:local
```

Container networking is fronted by HAProxy on port `8787`:

Set `NEST_PUBLIC_HOST` to the public hostname (for example, `nest.camplight.net`)
when serving behind a reverse proxy, so both UI servers accept that Host header.

- `/api`, `/ws`, and `/health` -> API
- `/admin` -> admin UI (when enabled)
- `/` -> user UI (when enabled), then admin UI, then API fallback

## Nest CLI

`apps/cli` is the bootstrap and maintenance CLI for Nest hosts.

```bash
npm run --workspace @nest/cli start
```

Command examples:

- `nest install --register-service --create-shortcut`
- `nest upgrade`
- `nest start` / `nest stop` / `nest status`
- `nest admin open` / `nest admin stop` / `nest admin status`
- `nest service register --components <csv>` (cross-OS per-component auto-start registration without reinstalling)
- `nest service unregister --components <csv>` (cross-OS per-component auto-start removal without reinstalling)
- `nest shortcut create` (cross-OS desktop shortcut for user-ui or admin-ui without reinstalling)
- `nest chat`

Nest CLI keeps a rolling session summary and capped recent history to stay within model context limits.

## Release automation

Pushes to `main` produce versioned rolling GitHub releases through
`.github/workflows/release-main.yml`.

Release tags follow SemVer + date:

- `0.0.1-YYYY-MM-DD` for the first release
- `0.0.N-YYYY-MM-DD` for subsequent releases (patch increments on each release)

The workflow builds self-contained `nest` binaries for Linux/macOS/Windows.
Each release includes:

- platform binaries (`nest-linux`, `nest-macos`, `nest-windows`)
- a release changelog artifact (`CHANGELOG-<release-tag>.md`)
- release notes generated from commits since the previous release tag

Each binary includes deterministic installer/lifecycle commands (`install`, `upgrade`, `doctor`, `start`, `stop`, `status`, `admin open`, `admin stop`, `admin status`) and
an optional agentic `chat` command. Installer mode clones Nest from git, builds runtime
artifacts, and can register OS auto-start services.

On macOS, downloaded binaries may be quarantined by Gatekeeper. After download:

```bash
xattr -d com.apple.quarantine ./nest-macos
chmod +x ./nest-macos
./nest-macos
```

## Environment variables

- `PORT` (API server port, default: `8787`)
- `NEST_ADMIN_USER` / `NEST_ADMIN_PASS` (defaults to `admin`)
- `NEST_RUNNER_TOKEN` (shared token for agent-runner -> API, default: `dev-runner-token`)
- `NEST_MASTER_KEY` (32-byte base64, required for secrets encryption)
- `NEST_COOKIE_SECURE` (`auto|always|never`, default: `auto`; `auto` enables `Secure` cookies on HTTPS requests)
- `NEST_PROJECT_ROOT` (optional monorepo root override)
- `NEST_API_URL` (agent-runner API base URL)
- `NEST_RUNNER_ID_FILE` (optional path for persisted runner identity; default: `.agent-runner-id`)
- `NEST_RUNNER_NAME` (optional runner display name used on registration)
- `NEST_EVENT_MAX_FAILURES` (default: 25)
- `NEST_EVENT_SHAPES_CACHE_TTL_MS` (API event-shapes cache TTL, default: `3000`)
- `NEST_RUNNER_ONLINE_THRESHOLD_MS` (runner online threshold, default: `15000`)
- `OPENAI_API_KEY` (for OpenAI models)
- `ANTHROPIC_API_KEY` (for Anthropic models)
- `OPENROUTER_API_KEY` (for OpenRouter models)
- `OPENROUTER_BASE_URL` (optional; defaults to `https://openrouter.ai/api/v1`)
- `OPENROUTER_HTTP_REFERER` / `OPENROUTER_APP_TITLE` (optional OpenRouter request headers)
- `NEST_LLM_STUB` (`1` to stub `@nest/llm` calls)
- `NEST_LLM_CALL_TIMEOUT_MS` (runner default LLM call timeout; default: `10800000`)
- `NEST_HISTORY_MAX_EVENTS` / `NEST_HISTORY_MAX_CHARS` (runner prompt history bounds)
- `NEST_CHANNEL_RECENT_MEMORY_INTERVAL_MS` / `NEST_CHANNEL_FULL_MEMORY_INTERVAL_MS`
- `NEST_CROSS_RECENT_MEMORY_INTERVAL_MS` / `NEST_CROSS_FULL_MEMORY_INTERVAL_MS`
- `NEST_AGENT_INTENT_TIMEOUT_MS` / `NEST_AGENT_INTENT_MAX_TIMEOUTS`
- `NEST_GIT_BASH_PATH` (optional Windows path to `bash.exe`; defaults to `C:\Program Files\Git\bin\bash.exe`)
- `NEST_SHELL_PATH` / `NEST_SHELL_ARGS` (optional shell override for all `shell_*` tools)
- `NEST_SHELL_TIMEOUT_KILL_GRACE_MS` (optional post-timeout kill grace for `shell_run`)
- RLM controls:
  - `NEST_RLM_MAX_STEPS`
  - `NEST_RLM_MAX_OUTPUT_CHARS`
  - `NEST_RLM_MAX_INPUT_CHARS`
  - `NEST_RLM_PROMPT_PREVIEW_MAX_CHARS`
  - `NEST_RLM_EVAL_TIMEOUT_MS`
  - `NEST_RLM_MAX_SUBAGENT_DEPTH`
  - `NEST_RLM_MAX_SUBAGENTS_PER_EVENT`
- Nest CLI:
  - `NEST_CLI_MODEL`
  - `NEST_CLI_MAX_STEPS`
  - `NEST_CLI_COMMAND_TIMEOUT_MS`
  - `NEST_CLI_EVAL_TIMEOUT_MS`
  - `NEST_CLI_EVAL_CALLBACK_TIMEOUT_MS`
  - `NEST_CLI_MAX_CONTEXT_CHARS`
  - `NEST_CLI_MAX_SUMMARY_CHARS`
  - `NEST_CLI_SUMMARY_CHUNK_MESSAGES`
  - `NEST_CLI_MIN_RECENT_MESSAGES`
  - `NEST_CLI_MAX_SYSTEM_DOC_CHARS`
  - `NEST_CLI_DEBUG`
  - `NEST_CLI_SPINNER` / `NEST_CLI_PROGRESS`
  - `NEST_CLI_LOG_PATH`
  - `NEST_CLI_DOUBLE_SIGINT_MS`
  - `NEST_EXTRACTED_ROOT` (auto-managed extracted path)
- Admin UI (`apps/admin-ui`):
  - `VITE_API_BASE_URL` (optional; default: `/api`)
  - `VITE_WS_BASE_URL` (optional; default: `/ws`, or derived from `VITE_API_BASE_URL` when absolute)
  - runtime override via `window.__NEST_UI_CONFIG__ = { apiBaseUrl, wsBaseUrl }`
  - in dev, Vite proxies `/api` and `/ws` to `http://localhost:8787` when using relative paths
- User UI (`apps/user-ui`):
  - `VITE_API_BASE_URL` (optional; default: `/api`)
  - `VITE_WS_BASE_URL` (optional; default: `/ws`, or derived from `VITE_API_BASE_URL` when absolute)
  - runtime override via `window.__NEST_USER_UI_CONFIG__ = { apiBaseUrl, wsBaseUrl }`
  - in dev, Vite proxies `/api` and `/ws` to `http://localhost:8787` when using relative paths

## Runner behavior notes

- Pending events are coalesced per `(agent, channel)` before model handling, so a burst of same-channel events is processed in one handling sequence.
- The runner executes model turns step-by-step and polls for new pending channel events between model attempts/turns; newly arrived same-channel events can be merged into the next attempt context.
- `shell_run` enforces a timeout (default 45s, configurable per call via `timeoutMs`, bounds 1s..45s) and force-kills timed-out commands. Use `shell_start` for long-running jobs.
- Runner registration/heartbeats are handled via `/api/runners/register` and `/api/runners/:id/heartbeat`.

## Tests

```bash
npm test
```

Scenario e2e checks against running services:

```bash
npm run scenario:test:countdown
```

## Skills

Skills live under `skills/` using `SKILL.md` (OpenCode/OpenClaw-style) frontmatter.
Each skill is a folder with docs plus optional runnable assets.

Built-in skills:

- Nest API events
- Agent collaboration via events
- Local memory init
- Browser automation via Playwright + Lightpanda (`skills/browser-use-lightpanda`)

For Playwright install steps, see the upstream docs: https://playwright.dev/docs/intro

## License

This project is licensed under the Apache License 2.0.
See `LICENSE` for the full text.
