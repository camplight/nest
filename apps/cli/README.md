# Nest CLI

`nest` is a deterministic installer/launcher CLI for Nest hosts with an optional agentic chat mode.

- Deterministic commands: `install`, `upgrade`, `doctor`, `start`, `stop`, `status`, `admin open`, `admin stop`, `admin status`, `service register`, `service unregister`, `shortcut create`
- Agentic mode: `chat` command only
- `service register`/`service unregister` and `shortcut create` are available as standalone deterministic commands (without install/upgrade)

## Run

`nest` command surface:

- `nest install [--dir <path>] [--repo <url>] [--ref <git-ref>] [--components <csv>] [--runner-api-url <url>] [--runner-token <token>] [--runner-name <name>] [--runner-invite-url <url>] [--register-service] [--create-shortcut]`
- `nest upgrade [--dir <path>] [--repo <url>] [--ref <git-ref>] [--components <csv>] [--runner-api-url <url>] [--runner-token <token>] [--runner-name <name>] [--runner-invite-url <url>] [--no-restart]`
- `nest doctor`
- `nest start [--dir <path>] [--components <csv>] [--no-open]`
- `nest stop [--dir <path>] [--components <csv>]`
- `nest status [--dir <path>] [--components <csv>]`
- `nest service register [--dir <path>] [--components <csv>]`
- `nest service unregister [--dir <path>] [--components <csv>]`
- `nest shortcut create [--target user-ui|admin-ui] [--url <url>]`
- `nest admin open [--dir <path>]`
- `nest admin stop [--dir <path>]`
- `nest admin status [--dir <path>]`
- `nest chat [--goal "..."]`

`--components` accepts a comma-separated subset of:

- `api`
- `runner`
- `user-ui`
- `admin-ui`

During `install`, Nest CLI checks required host tools (`node`, `npm`, `git`), clones/updates Nest from git, runs `npm ci`, and builds UI assets.
When `runner` is installed/upgraded, Nest CLI can bootstrap config from either:

- `--runner-invite-url <url>` (recommended secure flow from Admin UI runner invite)
- explicit `--runner-api-url` + `--runner-token` (+ optional `--runner-name`)

During `upgrade`, Nest CLI creates a safety backup of `.nest-data`/`files`/`.env` (if present), updates selected components, and optionally restarts only components that were running before upgrade.

`service register` / `service unregister` operate per component and can target any subset of `api`, `runner`, `user-ui`, `admin-ui`. Without `--components`, Nest CLI defaults to saved service components, then installed components, then the default component set.

## Build standalone executable

```bash
npm run --workspace @nest/cli build:release
```

This creates `dist/nest-*` for the current platform. Release workflow builds all 3 platforms.
The built binary embeds docs + build metadata used by `chat`.

For CI smoke tests that include `install` without mutating host services or relying on internet access, set:

- `NEST_CLI_INSTALL_SMOKE_MOCK=1`
- `NEST_CLI_NO_BROWSER=1`

In this mode, `install` creates deterministic marker files in `--dir` instead of cloning/building/registering services.
The same env var is also honored during `upgrade` (because upgrade reuses install internally), which enables deterministic cross-OS upgrade smoke checks in CI.
`NEST_CLI_NO_BROWSER` skips launching URLs while preserving command behavior, which keeps CI smoke checks headless-friendly.

## Chat mode

```bash
nest chat
```

`chat` mode is the only command that requires model credentials.

## Environment

- `OPENAI_API_KEY` (used when model provider is `openai`; prompted on startup if missing; saved to local `.env`)
- `ANTHROPIC_API_KEY` (used when model provider is `anthropic`; prompted on startup if missing; saved to local `.env`)
- `OPENROUTER_API_KEY` (used when model provider is `openrouter`; prompted on startup if missing; saved to local `.env`)
- `OPENROUTER_BASE_URL` (optional; default: `https://openrouter.ai/api/v1`)
- `OPENROUTER_HTTP_REFERER` (optional OpenRouter attribution/referrer header value)
- `OPENROUTER_APP_TITLE` (optional OpenRouter `X-Title` header value)
- `NEST_CLI_MODEL` (default: `openai:gpt-5.2`; supports `openai:<model>`, `anthropic:<model>`/`claude:<model>`, and `openrouter:<model>`/`or:<model>`)
- `NEST_CLI_COMMAND_TIMEOUT_MS` (default: `120000`)
- `NEST_CLI_MAX_CONTEXT_CHARS` (default: `100000`)
- `NEST_CLI_MAX_SUMMARY_CHARS` (default: `14000`)
- `NEST_CLI_SUMMARY_CHUNK_MESSAGES` (default: `8`)
- `NEST_CLI_MIN_RECENT_MESSAGES` (default: `12`)
- `NEST_CLI_MAX_SYSTEM_DOC_CHARS` (default: `40000`)
- `NEST_CLI_SPINNER` (default: enabled; set to `0`, `false`, `off`, or `no` to disable thinking/execution spinner)
- `NEST_CLI_PROGRESS` (default: enabled; set to `0`, `false`, `off`, or `no` to disable live step/repl progress events)
- `NEST_CLI_LOG_PATH` (default: `.nest-output.log` in current working directory; reset on each new session start)
- `NEST_CLI_DOUBLE_SIGINT_MS` (default: `1200`; window for "double Ctrl+C to exit")

If no API keys are configured, `nest chat` prompts to choose OpenAI, Claude, or OpenRouter and saves the selected key to local `.env`.

During an active autonomous run, press `Ctrl+C` to interrupt the current run and return to the `You>` prompt without exiting Nest CLI.
Press `Ctrl+C` twice quickly to exit Nest CLI immediately.

## Repository and state

Installs default to `https://github.com/camplight/nest.git` on `main`. Override with `--repo` or `NEST_REPO_URL`. State is stored in `~/.nest/nest-state.json`; `NEST_CLI_STATE_DIR` overrides that directory for isolated runs. See [migration notes](../../docs/REBRANDING.md) when replacing an existing deployment.
