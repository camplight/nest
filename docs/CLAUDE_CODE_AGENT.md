# Claude Code agents

Nest can run [Claude Code](https://code.claude.com/docs) as a `WRAPPED` agent.
People mention it in a channel, and each turn runs `claude -p` on the agent's
runner. `deploy/claude-code-bridge.mjs` is the runtime command; the engine and the
OrgOps submodule are unchanged.

What a turn does:

1. The runner starts the bridge in the agent's workspace with the new message.
2. The bridge resumes the Claude Code session stored for this agent and channel,
   or starts one on the first message.
3. Short assistant text that Claude Code writes before using tools appears as
   live progress in the chat. Thinking, tool input and output, subagent messages,
   hook output and diagnostics are never posted.
4. The final answer is the agent's reply. A failed turn shows one actionable
   line, such as a sign-in or usage-limit problem, never raw CLI output.

The supported setup is a separate agent container next to the Nest container
(sections 1 to 6). Running the bridge on a developer machine is covered in
section 8.

## 1. Enable the agent container

The Nest image includes Claude Code, `git`, `openssh-client`, the GitHub CLI and
the bridge. `deploy/compose.claude-agents.yaml` adds a `nest-agents` service from
the same image that runs only an agent runner:

```sh
# .env next to compose.yaml already holds NEST_RUNNER_TOKEN for the Nest container.
docker compose -f compose.yaml -f compose.claude-agents.yaml up -d
```

The agent container:

- registers with the Nest container over HTTP as the runner `nest-agents`, using
  `NEST_RUNNER_TOKEN`. It does not load Nest's `.env`, so Nest's admin password
  and master key never enter it;
- keeps workspaces and session state on its own volume (`nest-agents-data`, at
  `/app/.nest-data`) and Claude Code's home, config, history and secret files on
  another (`nest-agents-home`, at `/home/node`). `/home/node` is the `node`
  account's home in `/etc/passwd`, which `ssh` uses regardless of `HOME`. Nest's
  data, product and files volumes are not mounted;
- has the image's health check disabled (it runs no API) and a memory limit of
  `NEST_AGENTS_MEMORY`, 2 GB by default, so a runaway turn cannot starve Nest.

Check that **Admin → Runners** lists `nest-agents` as online.

## 2. Create the agent

In **Admin → Agents → New agent**, choose **Claude Code** as the mode. The form
fills in the wrapped recipe for the agent container:

- runner `nest-agents` (preselected when it is online);
- workspace `.nest-data/workspaces/<agent name>`, which follows the name until
  you edit it;
- `full` permission profile, running Claude Code as the `node` account with its
  home at `/home/node` on the agent home volume;
- one Claude Code session per channel;
- a turn limit, 2 hours by default. The engine cannot cancel a running wrapped
  turn, so the limit is what ends a runaway turn; the bridge then stops Claude
  Code and every process it started;
- the subscription token or API key secret, plus the tool secrets you list
  (section 3).

Model and memory settings do not apply: Claude Code chooses its own model and
keeps its own history. The form shows the generated JSON. Through the API,
`POST /api/agents` with mode `WRAPPED` also needs `"modelId": "wrapped:none"`.

Add the agent to a channel with **Add to chat and mention** in the @ menu, or
through project members, then mention it.

## 3. Secrets

Add secrets in **Admin → Secrets** with scope **Private** and the agent's name.
The form lists the names it expects.

| Secret | Purpose |
| --- | --- |
| `CLAUDE_CODE_OAUTH_TOKEN` | Subscription token from `claude setup-token`. |
| `ANTHROPIC_API_KEY` | Alternative: a Claude Console API key. |
| Tool secrets, for example `GH_TOKEN` | Passed to Claude Code as environment variables. |
| File secrets, for example `SSH_PRIVATE_KEY` | Written as files under Claude Code's home. |

**Claude credential.** Claude Code never receives the real token or key. Each
turn, the bridge starts a proxy on `127.0.0.1` and gives Claude Code its address
and a random dummy credential. The proxy replaces the dummy with the real
credential on its way to `api.anthropic.com` and stops when the turn ends. Only
message requests get the real credential; other requests go out without it. A
rejected credential fails the turn at once with a sign-in message.

**Tool secrets as variables.** List names such as `GH_TOKEN` in the form. They
are passed to Claude Code exactly, and Claude Code passes them on to the commands
it runs, so `gh` and `git` over HTTPS can use them. Names starting with `NEST_`,
`ORGOPS_`, `ANTHROPIC_`, `CLAUDE_`, `NODE_`, `LD_` or `DYLD_`, the host basics
(`PATH`, `HOME`, locale, proxy settings), `BASH_ENV` and `ENV` are refused: the
runner also passes secrets to the bridge, which runs as root.

**Tool secrets as files.** Map a secret to a path under Claude Code's home, for
example `SSH_PRIVATE_KEY` to `.ssh/id_ed25519` and `SSH_KNOWN_HOSTS` to
`.ssh/known_hosts`. Before every turn the bridge writes each file with mode 600 in
folders with mode 700, owned by the account Claude Code runs as. Changing a secret
takes effect on the next turn; deleting the secret removes the file. Removing
only the mapping leaves the file in place on the `nest-agents-home` volume; delete
it there, or delete the secret first, to revoke it.

Typical GitHub and SSH setup:

- `GH_TOKEN`: a fine-grained token for the client's repositories (contents and
  pull requests read and write, actions read). Ask the agent to run
  `gh auth setup-git` once so `git push` over HTTPS uses it.
- `SSH_PRIVATE_KEY` and `SSH_KNOWN_HOSTS`: a deploy or server key, and the
  servers' host keys (`ssh-keyscan host`), so connections do not prompt.

Anthropic's [legal and compliance terms](https://code.claude.com/docs/en/legal-and-compliance)
govern which plans may serve requests from other people. Check that the plan
behind the token fits how the agent is used.

## 4. What the agent can and cannot reach

Claude Code runs with `bypassPermissions` as the `node` account. There is no OS
sandbox inside the container: Claude Code's sandbox needs unprivileged user
namespaces, which Docker blocks on Ubuntu hosts. The container and the account are
the boundary.

It can reach:

- its workspace (it works in the workspace's `work/` folder; the workspace itself
  stays owned by root, because the runner writes chat attachments there as root),
  its Claude Code home and history, and the tool secrets listed for it;
- the network;
- the Nest API only through the runner's normal paths.

It cannot reach:

- the Claude credential (the proxy holds it; a shell command could call the proxy
  during a turn and spend quota, but cannot read the credential);
- Nest's databases, uploads, admin password, master key or runner token. The
  bridge and runner run as root, and their environment is not forwarded;
- processes of turns in other channels, beyond what the shared account allows.

Shared by design:

- all channels of one agent share its workspace and tool secrets;
- every Claude Code agent in one agent container runs as `node`, so one agent can
  read another's workspace, history and secret files. This fits one client per
  Nest instance. Use separate agent containers for agents that must be kept
  apart.

The `full` profile refuses to run where it can see Nest's product database, for
example when the agent is assigned to the Nest container's own runner, and it
refuses to run Claude Code as root.

## 5. Conversations and memory

Each channel has its own Claude Code session. Only `session.scope:
"per-channel"` is supported: with `per-agent`, the runner can run two channels
against one session at the same time.

The bridge stores the session ID for each channel under the engine project root,
in `claude-code/sessions` (in the agent container
`/app/.nest-data/engine/claude-code/sessions`), or in `NEST_CLAUDE_STATE_DIR`.
Each file is named after the SHA-256 of the runner's session key, shown as
`sessionId` on the channel's `wrapper.turn.started` events. Delete a file to reset
that channel's memory. If Claude Code's own history disappears, the next turn
starts a new session and says so in the chat's progress. A turn that fails to
sign in does not replace the saved session.

## 6. Upgrading Claude Code

Claude Code is pinned in the image by the `CLAUDE_CODE_VERSION` build argument
(the GitHub CLI by `GH_VERSION`). The bridge turns Claude Code's auto-updater off.
To upgrade, change the pin, rebuild the image and restart both services:

```sh
docker build --build-arg CLAUDE_CODE_VERSION=<version> -t <image> .
NEST_IMAGE=<image> docker compose -f compose.yaml -f compose.claude-agents.yaml up -d
```

Then run the container check (section 9) against the new image.

## 7. Configuration

The Admin form sets the account, home, permission and secret variables in the
recipe's `runtime.env`. Other variables, such as `NEST_CLAUDE_MODEL`, can be added
through the API or raw WRAPPED JSON; the form keeps them when it saves.

| Variable | Default | Purpose |
| --- | --- | --- |
| `NEST_CLAUDE_PERMISSIONS` | `workspace` | `full` (agent container) or `workspace` (developer machine). |
| `NEST_CLAUDE_UID`, `NEST_CLAUDE_GID` | none | Account Claude Code runs as; `1000` (`node`) in the image. |
| `NEST_CLAUDE_HOME`, `NEST_CLAUDE_CONFIG_DIR` | account's `HOME` | Claude Code's home and config folder (`full` only). |
| `NEST_CLAUDE_SECRETS` | none | Comma-separated tool secret names passed as variables. |
| `NEST_CLAUDE_SECRET_FILES` | none | Comma-separated `NAME:path` pairs, paths under `NEST_CLAUDE_HOME` (required with it). |
| `NEST_CLAUDE_UPSTREAM_URL` | `https://api.anthropic.com` | Where the proxy sends Claude Code's API traffic. |
| `NEST_CLAUDE_MODEL` | Claude Code's default | Passed as `--model`, for example `sonnet`. |
| `NEST_CLAUDE_SETTING_SOURCES` | all | Passed as `--setting-sources`. |
| `NEST_CLAUDE_BIN` | `claude` | Claude Code executable. |
| `NEST_CLAUDE_STATE_DIR` | see section 5 | Session mapping folder. |
| `NEST_CLAUDE_ALLOWED_DOMAINS` | none | Domains shell commands may reach (`workspace` only). |
| `NEST_CLAUDE_ALLOW_READ` | none | Extra paths shell commands may read (`workspace` only). |

The recipe's `secrets.allowedKeys` must list every secret the bridge uses; the
Admin form keeps it identical to the credential, `NEST_CLAUDE_SECRETS` and
`NEST_CLAUDE_SECRET_FILES`.

## 8. Developer machines

To develop Nest itself, a Claude Code agent can run on the local runner that
`npm run dev:all` starts, with the `workspace` profile. Create a WRAPPED agent
with this recipe, using the absolute path of your checkout (the runner joins
`command` and `args` with spaces, so the path must not contain any):

```json
{
  "kind": "claude-code",
  "harness": "command",
  "session": { "scope": "per-channel" },
  "setup": { "checkCommand": "claude --version" },
  "runtime": {
    "command": "exec node",
    "args": ["/path/to/nest/deploy/claude-code-bridge.mjs"],
    "env": { "NEST_CLAUDE_PERMISSIONS": "workspace" },
    "parse": "text",
    "timeoutMs": 7200000
  }
}
```

Without a credential secret, Claude Code uses your own `claude` login on the
machine and no proxy runs; keep such an agent Private. With
`CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` as an agent secret (listed in
`secrets.allowedKeys`), the proxy is used as in the container.

The `workspace` profile needs macOS, or Linux with `bubblewrap`, `socat` and
unprivileged user namespaces. It runs file tools with `acceptEdits` inside the
workspace and every shell command in Claude Code's sandbox, which fails closed:

- writes are limited to the workspace and temporary folders;
- reads are denied for the Nest checkout (`.env`, both databases, uploads), the
  engine and product data folders, the session folder and the account's `HOME`,
  apart from git configuration, Claude Code skills and plugin code, and common
  toolchain folders. Add others with `NEST_CLAUDE_ALLOW_READ`;
- network access is off unless you list domains in `NEST_CLAUDE_ALLOWED_DOMAINS`;
- built-in tools are limited to Bash, Read, Edit, Write, Glob, Grep, NotebookEdit,
  Skill and Agent, and MCP servers are off.

The bridge refuses a workspace that contains `HOME`, the Nest checkout, the
engine project root or the session folder, or that lies inside the session
folder, the engine project root or the product database folder. Secret files and
`NEST_CLAUDE_HOME` belong to the `full` profile.

In the agent container, Claude Code runs under `tini` as a subreaper, and the
bridge follows every process a turn starts through `/proc`, so background tools
are stopped with the turn. On macOS the bridge looks for them with `ps` every
half second; a background tool whose shell exits within that time can outlive
the turn.

With a credential secret, the sandbox also keeps shell commands from reading the
bridge's environment: on macOS, verified with Claude Code 2.1.309, `ps`, `sysctl`
and the process list are not permitted inside the sandbox.

## 9. Verification

```sh
TMPDIR=/private/tmp npx vitest run deploy/claude-code-bridge.test.mjs deploy/claude-code-proxy.test.mjs apps/admin-ui/src/claudeCodeAgent.test.ts
node --import tsx tests/browser/claude-code-progress.mjs
node tests/browser/claude-code-agent.mjs
npm run check:container:claude
```

The unit tests drive the real bridge and proxy against a scripted Claude Code
process and a local upstream. The browser tests check chat progress and the Admin
form. The container check (`tests/container/README.md`) builds the image, starts
both Compose files and runs a turn against a scripted Anthropic API inside the
agent container, checking that Claude Code runs as `node`, sees only the dummy
credential, cannot read Nest's data and is stopped by the turn limit. None of them
make a model call.
