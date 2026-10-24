# Claude Code agents in deployed Nest instances: design

Date: 2026-10-23. Branch: `feat/claude-code-wrapped-runtime`.

## 1. Intent

Camplight deploys a dedicated Nest instance per client (for example Kibrit). The client runs agent sessions in Nest channels to get work done on their project. Claude Code is the main working agent: it writes and changes code and does operational work on the client's project, from chat.

The goal is that every Nest instance ships with everything needed to run Claude Code agents, and an operator can add one from Admin without hand work inside containers. The deployed (container) environment is the target. A developer's local machine is a secondary environment used to develop Nest itself.

## 2. Success criteria

On a test instance shaped like a client deployment, an operator creates a Claude Code agent from Admin, adds its credentials in Admin → Secrets, and in a channel Claude Code can:

1. Chat: one Claude Code session per channel, with memory across turns, live progress while it works, and a clear one-line message when a turn fails.
2. Connect to the client's servers over SSH, and read and write there.
3. Clone the project, read and edit code, commit.
4. Push to git so the client's CI/CD runs, open pull requests and read CI status.
5. Develop and test changes with the tools available in the agent container (see non-goals for app runtimes).

## 3. Goals, non-goals, anti-goals

Goals:

1. Claude Code runs in a separate agent container next to the Nest container, created from the same image.
2. The Claude Code subscription token (from `claude setup-token`) never reaches Claude Code's process, its tool subprocesses, files Claude can read, or the chat.
3. Tool credentials (GitHub, servers, cloud) come from Admin → Secrets and reach Claude Code as environment variables or files.
4. Creating a Claude Code agent is a choice in Admin → Agents → Create Agent, not pasted JSON.
5. Stopping a turn reliably ends Claude Code and every process it started.

Non-goals for this version:

1. Project-specific runtimes in the image (PHP, Composer, databases, Docker inside the agent container). A per-client image extension can add them later.
2. Clients creating Claude Code agents themselves from the user workspace.
3. An OS-level sandbox or network allowlist inside the agent container.
4. Changing NestSystem's Codex setup.

Anti-goals (failure even if it works):

1. The subscription token, an API key, or Nest's admin password, master key or runner token appearing in chat, in Claude Code's environment, or in files Claude Code can read.
2. One runaway agent turn taking the client's Nest instance down.
3. Any step that requires a hand-run `docker exec` per client instance.

## 4. Constraints and verified facts

Verified on 2026-10-23 with Claude Code 2.1.309 and a locally built image (Colima, Ubuntu 6.8 kernel):

1. The runner executes a wrapped agent's `runtime.command` per turn, passing its whole environment (including Nest's admin password, master key and global runner token), the turn variables and the agent's secrets filtered by `wrappedConfig.secrets.allowedKeys`. Stdout is the reply; stderr of a failed turn is shown verbatim in chat; all output is stored as events channel members can read.
2. The runner sends a single SIGTERM to its shell on timeout and never escalates; there is no cancel path for an in-flight turn.
3. Claude Code refuses `bypassPermissions` as root, so it must run as a non-root account (`node`, uid 1000, in the image).
4. Claude Code's Linux sandbox and its subprocess credential scrubbing both require `bubblewrap`. In Docker it fails: the host kernel setting `apparmor_restrict_unprivileged_userns=1` (Ubuntu 24.04 default) blocks it even with `--privileged`. There is therefore no OS sandbox in the agent container; the container and the `node` account are the boundary.
5. With `ANTHROPIC_BASE_URL` set, Claude Code sends all its API traffic (a `HEAD /api/hello` check and `POST /v1/messages`) to that URL, using `Authorization: Bearer` plus the OAuth beta header for `CLAUDE_CODE_OAUTH_TOKEN`, or `x-api-key` for `ANTHROPIC_API_KEY`. It runs with a dummy credential, so a local proxy can inject the real one.
6. A runner-only container (`NEST_COMPONENTS=runner`, `NEST_API_URL=http://nest:8787`, `NEST_RUNNER_TOKEN`) registers with the Nest container over HTTP. The image's health check probes the API and must be disabled for it.
7. Claude Code is a 290 MB native binary; baking it in grows the image from about 850 MB to about 1.3 GB.
8. Claude Code passes its environment to tool subprocesses, so any credential in its environment can be printed by a shell command.
9. Engine secrets support scopes `public`, `team`, `human` and `private` (one agent, `scopeId` = agent name), are encrypted with the master key, and are set from Admin → Secrets.

## 5. Design

### 5.1 Deployment shape

1. The Nest container is unchanged apart from using the new image.
2. A new optional Compose file, `deploy/compose.claude-agents.yaml`, adds a `nest-agents` service from the same image:
   1. `NEST_COMPONENTS=runner`, `NEST_API_URL=http://nest:8787`, `NEST_RUNNER_TOKEN` and `NEST_RUNNER_ID_FILE` only. It does not load Nest's `.env`, so the admin password and master key never enter it.
   2. Its own volume mounted at `/app/.nest-data` (workspaces, Claude Code config and history, session state). Nest's data, product and files volumes are not mounted.
   3. Health check disabled; memory limit configurable, default 2 GB.
3. Operators enable it with `docker compose -f compose.yaml -f compose.claude-agents.yaml up -d`. The runner registers as a second runner; Claude Code agents are assigned to it.

### 5.2 Image

The runtime stage installs, pinned by build arguments:

1. Claude Code (`@anthropic-ai/claude-code`), with its auto-updater disabled at run time by the bridge.
2. `git`, `openssh-client` and the GitHub CLI (`gh`).
3. The bridge (`deploy/claude-code-bridge.mjs`), readable by `node`, checked at build time like the existing bridge helpers.

### 5.3 The bridge

`deploy/claude-code-bridge.mjs` stays the runtime command, with its colocated tests in `deploy/claude-code-bridge.test.mjs`. It keeps what is built and verified:

1. Per-channel session mapping in a state folder outside the workspace, with recovery when Claude Code's history is gone.
2. Stream-json parsing: interim top-level assistant text becomes `wrapped-progress` events through `packages/orgops-client/src/wrapped-progress.mjs`; subagent messages, thinking, tool input and output and hook output are never posted; the `result` is the reply.
3. One classified line on failure (sign-in, usage limit, sandbox unavailable, stopped, no written reply), never raw CLI output or a stack trace.
4. Claude Code in its own process group, SIGTERM forwarded, SIGKILL after 10 seconds, leftover tool processes killed when the turn ends.
5. Environment allowlist: only host basics, never Nest's or the runner's variables.

Changes in this version:

1. **Credential proxy.** Each turn, the bridge (which runs as root in the container) starts an HTTP proxy on `127.0.0.1` on a random port. Claude Code receives `ANTHROPIC_BASE_URL` pointing at it and a dummy credential of the same kind. The proxy replaces the dummy with the real credential and forwards to `https://api.anthropic.com` (or to an operator-set upstream), streaming responses unchanged. The real credential is `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` from the agent's secrets. The proxy stops when the turn ends. This replaces the key-file `apiKeyHelper` and the subprocess scrub, and fixes the four-minute retry on a rejected key, because a rejected key now returns 401 directly.
2. **Container account.** `NEST_CLAUDE_UID`, `NEST_CLAUDE_GID`, `NEST_CLAUDE_HOME` and `NEST_CLAUDE_CONFIG_DIR` run Claude Code as `node` with its home and config on the agent volume. The bridge creates those folders and the workspace owned by that account, and refuses `full` as root with a one-line explanation.
3. **Tool secrets as environment variables.** The recipe lists the secret names to forward in `NEST_CLAUDE_SECRETS` (the Admin form keeps this list identical to `secrets.allowedKeys`). The bridge forwards exactly those, and never a `NEST_*`, `ORGOPS_*`, Anthropic credential or runner variable even if listed.
4. **Tool secrets as files.** `NEST_CLAUDE_SECRET_FILES` maps secret names to paths under Claude's home, for example `SSH_PRIVATE_KEY:.ssh/id_ed25519,SSH_KNOWN_HOSTS:.ssh/known_hosts`. Before each turn the bridge writes them with mode 600 (folders 700), owned by Claude's account, so rotation in Admin takes effect on the next turn.
5. **Permission profiles.** `full` (bypassPermissions, the container default) and `workspace` (the macOS or Linux host sandbox for developer machines, unchanged and verified). `read-only` is removed.
6. **Fixes from review.** The workspace must not overlap any protected path in either direction; a turn that fails sign-in does not save its session; `error_max_budget_usd` gets its own message.
7. **Never next to Nest's data.** In the `full` profile the bridge refuses to run, with a one-line explanation, when it can see Nest's product database (for example on the Nest container's own runner). This makes anti-goal 1 hold even if an operator assigns the agent to the wrong runner. (Design call.)
8. **Developer machines.** When an Anthropic credential secret is set, the proxy is used in the `workspace` profile too; verification must show the host sandbox stops shell commands from reading the bridge's environment or memory. Without a credential secret, Claude Code uses the host account's own `claude` login and no proxy runs. (Design call.)

### 5.4 Admin

In Admin → Agents → Create Agent, the operator can choose Claude Code as what the agent runs (as a mode option or a preset under WRAPPED; builder's call on the exact control). Choosing it:

1. Fills the wrapped config for the container: bridge path `/app/deploy/claude-code-bridge.mjs`, `exec node`, `full` profile, `node` account, home and config folder on the agent volume, `session.scope: "per-channel"`, a turn limit of 2 hours (`timeoutMs: 7200000`, editable), `setup.checkCommand: "claude --version"`. The engine has no cancel path, so the turn limit is what ends a runaway turn; the bridge then stops Claude Code and its tools. (Design call.)
2. Hides the model and memory-context fields and does not require an enabled Nest model.
3. Offers a list of tool secret names and file mappings, and writes them into `secrets.allowedKeys`, `NEST_CLAUDE_SECRETS` and `NEST_CLAUDE_SECRET_FILES` together, always including `CLAUDE_CODE_OAUTH_TOKEN` (or `ANTHROPIC_API_KEY`).
4. Defaults the runner to one that is not the Nest container's own runner when one exists, and tells the operator which secrets to add in Admin → Secrets, scoped private to the agent.

The form uses the existing agent API; no new backend endpoint is expected.

### 5.5 Documentation

1. `docs/CLAUDE_CODE_AGENT.md` becomes container-first: enabling the agent container, creating the agent in Admin, adding secrets (token, GitHub, SSH), what the agent can and cannot reach, upgrading Claude Code, and the developer-machine setup as a secondary section.
2. `docs/SPEC.md` and `README.md` are updated to match.

## 6. What the agent can reach in the container

1. Can: its workspace, its Claude Code home and config, the tool secrets listed for it, the network, and the Nest API only through the runner's normal paths (never the runner token).
2. Cannot: the Anthropic credential (proxy), Nest's databases and files (not mounted), the runner token, admin password and master key (root's environment, not forwarded), other channels' Claude Code sessions' processes (process group per turn).
3. Shared by design: all channels of one agent share its workspace and tool credentials. During a turn, a shell command could call the local proxy and spend quota, but cannot read the credential.
4. Shared between agents (documented limit, design call): every Claude Code agent in one agent container runs as the same `node` account, so one agent can read another's workspace, history and tool secret files. This fits one client per instance. Per-agent accounts or containers are a later option if agents ever need to be kept apart.

## 7. Verification

1. Unit tests for the bridge, including the proxy (credential swap, streaming, dummy in the child environment, upstream 401 surfaced quickly), secret forwarding and secret files, container account handling, and the existing behaviours.
2. The existing engine-boundary progress test and browser progress test keep passing; Codex progress is unchanged.
3. A container test using the real image and Compose files, with a scripted mock Anthropic API inside the agent container: Claude Code runs as `node`, `env` and readable files contain only the dummy credential, Nest's volumes are absent, a stopped turn ends, progress and replies reach a channel.
4. A live test on a local Kibrit-shaped stack with a real `setup-token` (the operator saves it to a local file; it is loaded into the agent's secret without being printed): chat with memory and progress, SSH to a test host with a key from secrets, clone, edit, commit and push to a test repository, open a pull request.
5. `npm run lint`, `npm test`, `npm run build`, and an independent review pass before the PR.

## 8. Engine limitations handled in Nest

The design works around these engine behaviours on Nest's side; nothing is filed upstream as part of this work.

1. Wrapped turns cannot be stopped reliably by the engine (a single SIGTERM that stops at the shell on Debian, no escalation, no cancel path). Handled by the bridge's process-group signalling and SIGKILL escalation, `exec node` in the recipe, and the recipe's turn limit.
2. `session.scope: "per-agent"` lets turns from different channels run concurrently against one runtime session. Handled by supporting per-channel scope only, which the Admin option always sets.
3. Agent processes inherit the runner's full environment. Handled by the bridge's environment allowlist and by running Claude Code as a separate account in a separate container that never receives Nest's `.env`.

## 9. Left to the builder

1. The exact Admin control for choosing Claude Code, and the copy on the form.
2. How the GitHub CLI is installed and pinned in the image.
3. The proxy's implementation details (HTTP library, header handling for requests beyond `/v1/messages`), within the behaviour in 5.3.
4. Test structure and fixtures, following the repository's colocated-test conventions.
