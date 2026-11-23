# Agent activity: short lines instead of the icon strip

Date: 2026-11-14. Status: draft for approval.

## Intent

Under every agent reply, Nest shows a strip of identical icons: one per engine
event (turn started, each tool start and finish, each shell process start, each
chunk of process output, context updates). The owner clicked them only to see
what was there; the one time an error mattered, it would have been just as clear
from the chat itself. A Miro run produced about 80 icons for one answer, with the
one failed post hidden among them. The strip costs attention and tells nobody
anything.

What people do need at a glance:

1. **What the agent changed in their accounts.** Agents act on real accounts
   through connected apps (posting to a Miro board, sending a Gmail message,
   moving a Trello card). The owner wants each such change as a short line in the
   chat, for example "Miro · Create image item from URL".
2. **When something failed**, in plain words, inside the reply it belongs to.

Everything else (reads, shell commands, telemetry) stays available for
debugging but out of sight.

## Goals

- No icon strip under replies by default.
- One short line in the chat for each connected-app action that **changes**
  something, attached to the agent's reply for that turn.
- Failed changes and failed turns shown in plain words in that reply.
- The full raw event list still reachable from each reply through one small
  "Details" control.
- Correct attribution: every action line appears in the chat whose turn made the
  call, never in another chat, including when one agent works in several chats at
  once.

## Non-goals

- Lines for reads (listing boards, fetching items). Reads produce no line.
- Lines for actions taken outside Nest's connected apps (shell commands, files,
  web requests).
- Showing action arguments or results (board names, email recipients, message
  text). The line names the app and the action only.
- Redesigning the right panel's "Recent Activity" list. It stays as it is for now.
- lot-map-style visualisations (stations, pulses). The owner is not committed to
  that tool; this design replaces it.

## Anti-goals

- A line in the wrong chat. That would be worse than no line, because it leaks
  one conversation's activity into another.
- Action lines that wake an agent or appear to it as a new message.
- Any secret, argument or provider response content in an event payload.
- A failed or missing line ever blocking the action itself. Recording the line
  is best effort; the tool call's result and error handling stay exactly as today.

## Constraints

- `vendor/orgops` is never edited in Nest. The engine change goes to OrgOps
  first (`~/www/orgops`), tested locally on the combined branch
  `try/stop-and-auto-compact` the same way as Stop, then a PR and a reviewed
  submodule bump.
- The engine rejects event types it doesn't know. Core types live in OrgOps;
  skills may add their own through an `event-shapes.ts` module (OrgOps's
  `skills/slack/event-shapes.ts` is the example). Nest's `nest-connections` skill
  is copied into the engine skills folder by `scripts/orgops-env.ts` and
  refreshed when its `skill.json` version changes.
- The connected-app call reaches Nest through the helper
  `skills/nest-connections/scripts/connections.mjs`, which calls
  `POST /api/integrations/skill/execute` with the agent's capability token. That
  route already knows the agent, the connection, the tool, and success or failure
  (`audit.connection.tool.*`), but not the chat.
- Composio labels every tool with MCP-style hints in its `tags`:
  `readOnlyHint`, `createHint`, `updateHint`, `destructiveHint` (Miro: 33
  read-only, 21 create, 18 update, 17 destructive out of 89).
- Composio can answer an execute call with `successful: false` inside a normal
  response; that is a failure for this feature.
- The Nest API can read channels (with participants) and post events with the
  engine service token it already uses for connections
  (`NEST_CONNECTION_METADATA_TOKEN`, falling back to `NEST_RUNNER_TOKEN`).
- Events posted with status `DELIVERED` never wake agents.

## Approaches considered

1. **Parse the chat's recorded shell commands in the UI.** Spot
   `connections.mjs execute CONNECTION TOOL` in `process.started` commands and
   use the exit code. No backend or engine change, but it misses calls the agent
   wraps in its own scripts, and it depends on how the agent types the command
   (one recorded call had its arguments in the wrong order).
2. **The engine tells each shell which chat it is in.** OrgOps passes the chat ID
   to agent shells; the helper forwards it; Nest's execute route posts the line
   into that chat. Catches every call however it is wrapped, using facts Nest
   already has. Needs a small OrgOps change and a submodule bump.
3. **Match Nest's call log to a chat by time.** No engine change, but it has to
   guess when an agent runs turns in two chats at once, and Nest's API would read
   the agent's engine events.

**Chosen: 2** (the owner's pick). It is the only one that is always right rather
than usually right, and the engine change is a few lines that are useful
upstream on their own.

## Design

### 1. OrgOps: shells know their chat

In `apps/agent-runner/src/tools/shell.ts`, the environment built for every agent
shell adds `ORGOPS_CHANNEL_ID` set to `ctx.channelId` when the turn has one. It
sits beside the existing `ORGOPS_AGENT_NAME`, before `ctx.injectionEnv` and the
call's own `env`, matching how `ORGOPS_AGENT_NAME` is placed. Shells without a
channel (maintenance runs) get no variable. Document it in OrgOps
`docs/SPEC.md` next to `ORGOPS_AGENT_NAME`, with a runner test.

### 2. Helper: forward the chat

`connections.mjs` sends `x-nest-channel-id: $ORGOPS_CHANNEL_ID` on `execute`
when the variable is set. Nothing else in the helper changes. Bump the skill's
`skill.json` version so running installs receive the new helper and event shape.

### 3. Event type: `telemetry.nest.connection.action`

Declared by `skills/nest-connections/event-shapes.ts`, with an event schema that
only accepts `source: "system:nest-connections"`. Agents' own `events_emit`
always uses `agent:<name>`, so an agent cannot fake a line.

The `telemetry.` prefix matters: the runner leaves `telemetry.*` events out of
every agent's conversation history (`isMeaningfulEvent` in OrgOps
`context-maintenance.ts`), while the chat already receives them. Without the
prefix, every agent in the chat would read each line as a system message on its
next turn.

Payload, all required unless noted:

- `agentName`: the agent that made the call.
- `connectionId`: Nest's local connection ID.
- `app`: toolkit slug, e.g. `miro`.
- `tool`: exact tool slug, e.g. `MIRO_CREATE_IMAGE_ITEM_FROM_URL`.
- `title`: the provider's human name for the tool, e.g. "Create image item from
  URL".
- `change`: `create`, `update` or `delete`.
- `outcome`: `ok`, `failed` or `unknown`.
  - `ok`: the provider returned success.
  - `failed`: the provider said no: an error status from the provider
    (`ProviderRequestError`) or `successful: false` in its response.
  - `unknown`: the request was lost or timed out, so it may have completed. This
    matches what the route already tells the agent ("It may have completed;
    verify before retrying").
- `requestId`: the audit request ID, for matching to Nest's audit log.

No arguments, results, account IDs or error text from the provider.

### 4. Nest API: record changes in the right chat

After `POST /api/integrations/skill/execute` finishes (success, provider
failure, or `successful: false`):

1. If there is no `x-nest-channel-id`, stop. No line.
2. Classify the tool from its provider tags: `destructiveHint` → `delete`,
   `updateHint` → `update`, `createHint` → `create`. A tool tagged
   `readOnlyHint`, or with none of these, produces no line. Tags come from the
   provider's tool record, which the route already loads (`service().tool`); add
   `tags` to `IntegrationTool`.
3. Check, with the engine service token, that the channel exists, is not
   archived, and lists this agent as a participant. If not, skip the line and
   write `audit.connection.tool.line_rejected` (no channel ID beyond what is
   needed to investigate).
4. Post the event with `status: "DELIVERED"`, `source: "system:nest-connections"`,
   `channelId` from the header, and an idempotency key from the request ID.
5. Post **before** answering the helper, with a short timeout (about 2 seconds).
   The agent's shell waits for the helper, so the line lands inside the agent's
   turn, before its reply.
6. Any failure in steps 2 to 5 is logged without secrets and never changes the
   response the agent gets.

### 5. Chat UI: lines, failures and Details

Group a turn's events by the engine's turn boundaries: from `agent.turn.started`
to `agent.turn.completed` or `agent.turn.failed` with the same `triggerEventId`
and agent. Today the activity group attaches to whichever message precedes it,
which puts the agent's icons under the human's question; the new grouping puts
them with the agent's reply instead.

Under the agent's reply for that turn (or under the agent's name when the turn
produced no reply):

- **Action lines**, in order, one per `telemetry.nest.connection.action`:
  - `ok`: "Miro · Create image item from URL".
  - `failed`: "Miro · Create image item from URL failed", in the danger tone.
  - `unknown`: "Miro · Create image item from URL may not have finished. Check
    Miro before trying again", in the muted warning tone, so nobody repeats a
    change that went through (a second email, a duplicate card).

  Each line shows the app's logo (the existing `IntegrationLogo`).
- **Turn failure**, when the turn failed: "NikiPA couldn't finish: …" with the
  engine's error reduced to one plain sentence.
- **Details**: a small text control that expands to the existing per-event list
  (`AgentActivity`, unchanged), including the raw JSON on click.

A turn with no action lines and no failure shows only the Details control.

**Events outside any turn.** An action line, or a leftover raw event (a
background process's `process.exited`, `agent.context.compacted`, a stop
request), can arrive outside the agent's turn window. The main case is a
background process started with `shell_start` that calls the helper after the
turn ended. Rule:

- It goes with that agent's most recent reply before it in the same chat, in the
  same lines or Details list.
- If the chat has no earlier reply from that agent, it stands alone under the
  agent's name, like a turn with no reply.

The engine is not asked for the trigger event ID; time order inside one chat is
enough once lines are posted before the helper returns.

## What's decided

- Approach 2, and the line format "App · Action title".
- Lines for changes only; reads never produce a line.
- No arguments or results in lines or payloads.
- The strip is gone by default; the raw list stays behind Details.
- Test the OrgOps change locally on the combined branch before any PR.

## Calls I made (correct any of these)

- Event type name `telemetry.nest.connection.action` (hidden from agents) and
  source `system:nest-connections`.
- Three outcomes rather than ok/failed, so a lost response is never shown as a
  failure.
- Events outside a turn go with the agent's previous reply in that chat.
- Failed **reads** produce no line; the agent usually retries or explains, and
  the raw events stay under Details. Failed **changes** always produce a line.
- Recent Activity in the right panel is unchanged.
- Line text uses the provider's tool name as is, after the existing
  `actionName` clean-up used on the Connected apps page.

## Left to the builder

- Exact wording for turn-failure sentences per known error class, with a generic
  fallback.
- Layout and spacing of the lines and the Details control, following the chat's
  existing tokens; check desktop and phone widths.
- Whether to cache channel participants briefly in the execute route.
- Test layout: the adapter boundary is tested against the real engine as the
  existing browser suites do, not with the engine mocked away.
