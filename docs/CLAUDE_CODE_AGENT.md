# Claude Code agents

Nest can run [Claude Code](https://code.claude.com/docs) as a `WRAPPED` agent.
People mention it from any conversation, and each turn runs `claude -p` on the
agent's assigned runner host. `deploy/claude-code-bridge.mjs` is the runtime
command. It follows the same pattern as the Codex bridges: the engine and the
OrgOps submodule are unchanged, and the agent is an ordinary wrapped recipe.

What a turn does:

1. The runner starts the bridge in the agent's workspace with the new message.
2. The bridge resumes the Claude Code session stored for this agent and
   conversation, or starts one on the first message.
3. Short assistant text that Claude Code writes before using tools appears as
   live progress in the chat. Thinking, tool input and output, subagent messages,
   hook output and diagnostics are never posted.
4. The final answer is the agent's reply. A failed turn shows one actionable
   line, such as a sign-in, sandbox or usage-limit problem, never raw CLI output.

This guide covers runner hosts: a developer machine or a Linux server or VM. The
Nest container image does not include the bridge yet; see section 7.

## 1. Requirements

- Claude Code on the runner host, signed in as the runner's OS account
  (section 4). Tested with 2.1.309.
- A registered Nest runner on that host. `npm run dev:all` starts one locally.
- The bridge run from a Nest checkout, at `<checkout>/deploy/`. It protects that
  checkout's data by its location.
- For the default `workspace` profile: macOS, or Linux with `bubblewrap` and
  `socat` and unprivileged user namespaces. Claude Code refuses to start rather
  than run shell commands unsandboxed, and the chat says so.

## 2. Create the agent

In **Admin → Agents**, create an agent with mode **WRAPPED**:

- **Visibility:** Private if it uses your own Claude login (section 4). Public
  agents can be mentioned by every signed-in person.
- **Workspace path:** a folder of its own, for example
  `.nest-data/workspaces/<AgentName>`. Do not share the default workspace. The
  bridge refuses a workspace that contains `HOME`, the Nest checkout or its
  session folder, unless the profile is `full`.
- **Runner:** the host where Claude Code is installed and signed in.
- **Wrapped config:** the recipe below. Replace the bridge path with the absolute
  path of your checkout. The runner joins `command` and `args` with spaces, so the
  path must not contain spaces.

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
    "timeoutMs": 0
  }
}
```

Through the API, `POST /api/agents` also needs `"modelId": "wrapped:none"`, which
the admin UI sends for wrapped agents.

`exec` replaces the runner's shell, so stopping a turn reaches the bridge. The
bridge then stops Claude Code and every tool process it started, escalating to
`SIGKILL` after ten seconds. `timeoutMs: 0` lets long coding turns finish.

Add the agent to a conversation with **Add to chat and mention** in the @ menu,
or through project members, then mention it.

## 3. Permission profiles

`NEST_CLAUDE_PERMISSIONS` is the only security switch. Headless turns cannot ask
anyone for approval, so anything a profile does not allow is denied.

| Profile | File tools | Shell commands | Use for |
| --- | --- | --- | --- |
| `read-only` | Read and search the workspace | None | Questions about files in the workspace. |
| `workspace` (default) | Read and edit inside the workspace | Run in the OS sandbox | Coding and file work on a host with other data. |
| `full` | Unrestricted | Unrestricted | Only on a machine or OS account dedicated to the agent. |

`read-only` and `workspace` name their built-in tools explicitly, so tools that
later Claude Code releases add stay off until the bridge is updated:

- `read-only`: Read, Grep and Glob.
- `workspace`: Bash, Read, Edit, Write, Glob, Grep, NotebookEdit, Skill and Agent.
  Subagents run under the same sandbox.

Both start Claude Code without MCP servers, because MCP tools run outside the
sandbox with the account's own access. `full` keeps the default tools and the
account's MCP servers.

The `workspace` profile runs every shell command in Claude Code's sandbox with
`failIfUnavailable`:

- Writes are limited to the workspace and temporary folders.
- Reads are denied for the Nest checkout (`.env`, both databases, uploads), the
  engine and product data folders, the session state folder and the whole of the
  runner account's `HOME`, including the macOS Keychain. Within `HOME`, only git
  configuration (keep tokens out of `~/.gitconfig`), Claude Code skills and plugin
  code, and common toolchain folders
  (`fnm`, `nvm`, `volta`, `bun`, `cargo`, `rustup`, `pyenv`, `asdf`, `mise` and
  similar) stay readable. If a command reports `Operation not permitted` for a
  toolchain, add its folder to `NEST_CLAUDE_ALLOW_READ`.
- Network access is off unless you list domains in `NEST_CLAUDE_ALLOWED_DOMAINS`,
  for example `registry.npmjs.org,github.com`.
- File tools need approval outside the workspace, so they are denied there.
- Claude Code refuses writes to `.claude/settings*.json` and `.mcp.json`, so a turn
  cannot plant hooks or MCP servers that would later run outside the sandbox.

Limits to plan for:

- Everyone who can mention the agent shares its workspace. Files one conversation
  writes there, including a `CLAUDE.md`, are read by later turns in every other
  conversation. Give agents for different audiences different workspaces.
- Shell commands can read and write the system temporary folder, which other
  programs of the same OS account also use.
- Claude Code itself runs with the account's rights and reads its Claude Code
  settings, skills and plugins. Managed Claude Code policy still takes precedence.
- Tools that normally ask for approval, such as web fetch, are denied.

## 4. Sign-in, billing and terms

The bridge forwards only the host basics (`PATH`, `HOME`, locale, temporary
folder and proxy settings) and Claude Code credentials. Nest's admin password,
master key and runner token never reach Claude Code.

| Method | How | Visible to shell commands |
| --- | --- | --- |
| Your own Claude login | Run `claude` once on the runner host as the runner's account and sign in. | No (Keychain or `HOME`, both denied). |
| API key | Store `ANTHROPIC_API_KEY` as an agent secret. It takes precedence over a login and is billed to that key. | No. The bridge passes it to Claude Code through a per-turn file the sandbox cannot read. |

Limit injected secrets to the key, with
`"secrets": { "allowedKeys": ["ANTHROPIC_API_KEY"] }` in the wrapped config. Other
credential variables, such as `CLAUDE_CODE_OAUTH_TOKEN`, are not forwarded,
because Claude Code would pass them on to shell commands.

Anthropic's [legal and compliance terms](https://code.claude.com/docs/en/legal-and-compliance)
do not permit routing other people's requests through a Free, Pro or Max plan.
Your own login is for a private agent that only you use.
For an agent other people can mention, use an API key from the Claude Console or a
supported cloud provider.

## 5. Conversations and memory

Each conversation has its own Claude Code session. Use `session.scope:
"per-channel"`; `per-agent` is not supported, because the runner can then run two
conversations against one Claude Code session at the same time
([camplight/orgops#71](https://github.com/camplight/orgops/issues/71)).

The bridge stores the Claude Code session ID for each conversation under the
engine project root, in `claude-code/sessions` (by default
`.nest-data/engine/claude-code/sessions`), or in `NEST_CLAUDE_STATE_DIR`. Each file
is named after the SHA-256 of the runner's session key, which appears as
`sessionId` on the conversation's `wrapper.turn.started` events:

```sh
printf %s "<sessionId>" | shasum -a 256
```

To continue a conversation in your terminal, `cd` to the agent's workspace and run
`claude --resume <id>`. That session then runs with your own permissions and
settings, not the agent's sandbox. To reset a conversation's memory, delete its
file. If Claude Code's own history for a session disappears, the next turn starts
a new session and says so in the chat's progress.

Deleting the agent leaves its workspace, its session files and Claude Code's
transcripts in `~/.claude/projects/<workspace path with / and . replaced by ->`.
Remove them by hand when you no longer need them.

## 6. Configuration

Set these in the wrapped config's `runtime.env`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `NEST_CLAUDE_PERMISSIONS` | `workspace` | `read-only`, `workspace` or `full`. |
| `NEST_CLAUDE_MODEL` | Claude Code's default | Passed as `--model`, for example `sonnet`. |
| `NEST_CLAUDE_ALLOWED_DOMAINS` | none | Comma-separated domains shell commands may reach (`workspace`). |
| `NEST_CLAUDE_ALLOW_READ` | none | Comma-separated extra paths shell commands may read (`workspace`). |
| `NEST_CLAUDE_SETTING_SOURCES` | all | Passed as `--setting-sources`. `project,local` ignores the account's own settings, hooks and plugins. |
| `NEST_CLAUDE_BIN` | `claude` | Claude Code executable. |
| `NEST_CLAUDE_STATE_DIR` | see section 5 | Session mapping folder. |

Each turn starts Claude Code with the account's settings and plugins, so their
size and the model set the cost of a turn. A smaller model and `project,local`
setting sources make routine turns cheaper.

## 7. Containers

The Nest image does not ship the bridge yet. Docker's default security profile
does not allow the user namespaces the Linux sandbox needs, so `workspace` cannot
run shell commands there, and `full` refuses to run as root. A container setup
needs a non-root account and its own credential handling; it will be documented
when it has been verified end to end. Until then, run Claude Code agents on a
separate runner host.

## 8. Verification

```sh
npx vitest run deploy/claude-code-bridge.test.mjs packages/orgops-client/src/wrapped-progress.test.mjs apps/user-ui/src/activity.test.ts
node --import tsx tests/browser/claude-code-progress.mjs
```

The unit tests drive the real bridge against a scripted Claude Code process built
from captured CLI output: session start and resume, missing-history recovery,
sign-in, limit and sandbox failures, credential filtering and the API key file,
permission profiles, subagent output and stopping a turn. The engine test posts
progress through the unchanged OrgOps API, and the browser test checks the chat on
desktop and mobile with synthetic events. None of them make a model call.

After setup, mention the agent in a test conversation, check that a follow-up
remembers the first message, and that the chat shows progress during a task that
runs a shell command.
