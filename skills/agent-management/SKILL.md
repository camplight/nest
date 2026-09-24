---
name: agent-management
description: Create, list, and configure Nest agents from native agents. Use when the user asks an agent to create agents, list agents, set up WRAPPED agents, OpenClaw wrappers, sidecars, or Cursor coding harnesses.
---

# Agent Management

Use the native runner tools for agent operations:

- `agents_search`: list or filter existing agents.
- `agents_create`: create `CLASSIC`, `RLM_REPL`, or `WRAPPED` agents.
- `agents_update`: patch an existing agent's config, lifecycle state, skills, model, workspace, or wrapped runtime config.
- `events_channel_participant_add` or `events_channel_join`: add an agent to a channel when it should receive channel events.

## List Agents

Call `agents_search` first when you need to inspect existing agents, avoid duplicate names, or find runner assignments.

Example:

```json
{
  "nameContains": "coordinator",
  "limit": 20
}
```

## Create Native Agents

For a normal Nest-managed LLM agent, use `mode: "CLASSIC"` or omit `mode`. Pick a concrete `modelId`, set a workspace, and enable any required skills.

Example:

```json
{
  "name": "ResearchAgent",
  "mode": "CLASSIC",
  "modelId": "openai:gpt-4o-mini",
  "workspacePath": ".nest-data/workspaces/ResearchAgent",
  "enabledSkills": ["tavily"],
  "alwaysPreloadedSkills": ["tavily"],
  "joinCurrentChannel": true
}
```

## Create Wrapped Agents

For a wrapped agent, set:

- `mode: "WRAPPED"`
- `modelId: "wrapped:none"` if you provide it explicitly
- `memoryContextMode: "OFF"` or omit it; Nest forces wrapped agents to memory OFF
- `enabledSkills: []` and `alwaysPreloadedSkills: []`
- a `wrappedConfig` object with `kind`, `harness`, optional `setup`, optional `sidecars`, and `runtime`

Wrapped agents do not use Nest model calls, prompts, memory, skills, or `allowOutsideWorkspace` for turns. The external runtime owns its session, tools, memory, prompt behavior, and filesystem policy through its own settings.

## Update Existing Agents

Use `agents_update` instead of direct database writes. For wrapped agents, prefer `wrappedConfigJson` when patching a whole config from generated JSON; it must parse to a JSON object.

Example:

```json
{
  "agentName": "NestCoordinator",
  "wrappedConfigJson": "{\"kind\":\"openclaw\",\"harness\":\"command\",\"runtime\":{\"command\":\"./run-openclaw.sh\",\"cwd\":\".nest-data/workspaces/NestCoordinator/wrapper\",\"parse\":\"json-payloads\",\"timeoutMs\":600000}}",
  "desiredState": "RUNNING"
}
```

## OpenClaw With Gateway Sidecar

Use OpenClaw when the wrapped runtime is an OpenClaw agent. The OpenClaw sidecar should be the OpenClaw Gateway; Nest starts it before turns and the runtime command sends each turn through that gateway.

Example `agents_create` arguments:

```json
{
  "name": "NestCoordinator",
  "mode": "WRAPPED",
  "workspacePath": ".nest-data/workspaces/NestCoordinator",
  "wrappedConfig": {
    "kind": "openclaw",
    "harness": "command",
    "session": { "scope": "per-channel" },
    "setup": {
      "checkCommand": "test -x node_modules/.bin/openclaw",
      "command": "npm install --no-save openclaw",
      "cwd": ".nest-data/workspaces/NestCoordinator/wrapper",
      "timeoutMs": 600000
    },
    "sidecars": [
      {
        "name": "gateway",
        "command": "npx openclaw gateway --force",
        "cwd": ".nest-data/workspaces/NestCoordinator/wrapper",
        "restart": true,
        "restartDelayMs": 2000,
        "timeoutMs": 0
      }
    ],
    "runtime": {
      "command": "npx openclaw agent --agent coordinator --session-id \"$NEST_WRAPPED_SESSION_ID\" --message \"$NEST_WRAPPED_MESSAGE\" --json",
      "cwd": ".nest-data/workspaces/NestCoordinator/wrapper",
      "parse": "json-payloads",
      "timeoutMs": 600000
    }
  },
  "joinCurrentChannel": true
}
```

OpenClaw setup notes:

- OpenClaw is optional and is not installed with Nest. Install it in the wrapped agent's workspace during `setup`, or configure `source` to use an OpenClaw checkout.
- Before upgrading an existing OpenClaw agent that relied on Nest' root installation, add an explicit local install to its stored `wrappedConfig.setup`; otherwise `npx openclaw` may fail or download an unpinned version.
- Pin the `openclaw` version in production recipes when reproducible setup is required.
- Store wrapper source in the agent workspace or configure `source` if it comes from a repo.
- Put secrets in Nest package secrets, not in `wrappedConfig`; setup, sidecars, and runtime receive package secrets as env.
- Use `NEST_WRAPPED_SESSION_ID` to keep OpenClaw state stable per channel or per agent.
- Configure OpenClaw's gateway, agents, model allowlist, channel bridges, sandbox, and filesystem policy in OpenClaw itself.
- Keep the gateway sidecar idempotent and restartable.

## Cursor Coding Harness

Use Cursor wrapped mode when the agent should delegate coding work to Cursor tooling rather than the Nest LLM loop. Treat it as a high-power coding harness: give it an isolated workspace, a narrow prompt/message bridge, and a long turn timeout.

Example `agents_create` arguments:

```json
{
  "name": "CursorCoder",
  "mode": "WRAPPED",
  "workspacePath": ".nest-data/workspaces/CursorCoder",
  "wrappedConfig": {
    "kind": "cursor",
    "harness": "command",
    "session": { "scope": "per-agent" },
    "runtime": {
      "command": "cursor-agent -p \"$NEST_WRAPPED_MESSAGE\" --output-format text",
      "cwd": ".",
      "parse": "text",
      "timeoutMs": 1800000
    }
  }
}
```

Cursor setup notes:

- Configure `CURSOR_API_KEY` as a Nest secret in package `cursor`.
- Configure Cursor's filesystem and permission policy in the Cursor harness settings; Nest `allowOutsideWorkspace` does not apply to wrapped agents.
- Prefer `session.scope: "per-agent"` for coding continuity across channels; use `per-channel` when channel isolation matters.
- Ask before creating or modifying repositories outside the configured workspace.
