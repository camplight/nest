# Agent Activity Lines Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the per-event icon strip under agent replies with one short line per connected-app change, plain-language failures, and a Details control for the raw events.

**Architecture:** OrgOps gives agent shells `ORGOPS_CHANNEL_ID`; Nest's connections helper forwards it as `x-nest-channel-id`; Nest's execute route classifies the tool by its provider hint tags and posts a `telemetry.nest.connection.action` event (declared by the `nest-connections` skill) into that chat. The chat UI groups each turn's events with the agent's reply and renders lines, failure and Details.

**Tech Stack:** TypeScript, Hono (Nest API), React 19 + assistant-ui (user UI), vitest, Playwright browser scripts against the real engine, zod event shapes.

**Spec:** `docs/superpowers/specs/2026-11-14-agent-activity-lines-design.md`

## Global Constraints

- Never edit `vendor/orgops`. The engine change is made in `~/www/orgops` on branch `try/stop-and-auto-compact`, then the local checkout is moved with `git -C vendor/orgops fetch /home/slamnation/www/orgops try/stop-and-auto-compact && git -C vendor/orgops checkout FETCH_HEAD` (uncommitted pointer, local only).
- Event type: `telemetry.nest.connection.action`. Source: `system:nest-connections`. Status: `DELIVERED`.
- Payload exactly: `agentName`, `connectionId`, `app`, `tool`, `title`, `change` (`create`|`update`|`delete`), `outcome` (`ok`|`failed`|`unknown`), `requestId`. No arguments, results, account IDs or provider error text.
- Change classification: `destructiveHint` → `delete`, else `updateHint` → `update`, else `createHint` → `create`; `readOnlyHint` or none of these → no line.
- Recording a line never changes the response, status or timing beyond about 2 seconds of the execute call, and never throws out of the route.
- Line copy: ok "Miro · Create image item from URL"; failed "Miro · Create image item from URL failed"; unknown "Miro · Create image item from URL may not have finished. Check Miro before trying again".
- Use npm. Conventional commits ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Nothing is pushed or opened as a PR until the owner has tested locally.
- Keep `docs/SPEC.md` (Nest) and OrgOps `docs/SPEC.md` in sync with behaviour.

## Review Focus

- A forged or stale `x-nest-channel-id` (chat the agent is not in, archived chat, unknown ID): the tool still runs and returns as before; no line appears anywhere. (Task 3 test.)
- The engine is down or slow when the line is posted: the agent still gets the tool result unchanged and within the timeout. (Task 3 test.)
- A tool with no hint tags at all (older or custom catalog entries): no line. (Task 3 test.)
- Two agents with overlapping turns in one chat: each agent's lines go under its own reply, never the other's. (Task 4 test.)
- An action event whose turn's reply is not in the loaded history window (older page): it renders as a standalone group instead of disappearing or attaching to an unrelated message. (Task 4 test.)

---

### Task 1: OrgOps shells know their chat

Repository: `~/www/orgops`, branch `try/stop-and-auto-compact`.

**Files:**
- Modify: `apps/agent-runner/src/tools/shell.ts` (the `mergedEnv` object in `spawnTrackedProcess`, beside `ORGOPS_AGENT_NAME`)
- Test: `apps/agent-runner/src/tools/shell.test.ts`
- Modify: `docs/SPEC.md` (the line listing `ORGOPS_AGENT_NAME`, `ORGOPS_AGENT_WORKSPACE`)

**Interfaces:**
- Produces: env var `ORGOPS_CHANNEL_ID` in every agent shell whose tool context has `ctx.channelId`; absent otherwise.

- [ ] **Step 1: Write the failing tests** `shell_run exposes the turn's channel as ORGOPS_CHANNEL_ID` (command prints the variable; assert output equals the context's `channelId`) and `shell_run without a channel sets no ORGOPS_CHANNEL_ID` (assert the printed value is empty), following the existing shell test harness in that file.
- [ ] **Step 2: Run** `npx vitest run apps/agent-runner/src/tools/shell.test.ts` — expect the two new tests to FAIL.
- [ ] **Step 3: Implement** `...(ctx.channelId ? { ORGOPS_CHANNEL_ID: ctx.channelId } : {})` placed after `ORGOPS_AGENT_WORKSPACE` and before `...ctx.injectionEnv`. Add `ORGOPS_CHANNEL_ID` (the chat the turn runs in, when there is one) to the SPEC line.
- [ ] **Step 4: Run** the shell tests, then `npm test` and `npm run lint` in `~/www/orgops` — expect PASS (428+ tests).
- [ ] **Step 5: Commit** in `~/www/orgops`: `feat(runner): tell agent shells which channel the turn runs in`. Then move Nest's local `vendor/orgops` checkout to the new commit (command in Global Constraints).

### Task 2: Helper forwards the chat; skill declares the event

Repository: Nest.

**Files:**
- Modify: `skills/nest-connections/scripts/connections.mjs` (`request()` headers)
- Create: `skills/nest-connections/event-shapes.ts`
- Modify: `skills/nest-connections/skill.json` (`version` → `1.3.0`)
- Test: `scripts/connections.test.mjs`

**Interfaces:**
- Consumes: `ORGOPS_CHANNEL_ID` (Task 1).
- Produces: request header `x-nest-channel-id` on `execute` only; `export const eventShapes: EventShapeDefinition[]` with one definition for `telemetry.nest.connection.action`, `source: "skill:nest-connections"`, an `eventSchema` requiring `source: z.literal("system:nest-connections")`, `channelId: z.string().min(1)` and the payload in Global Constraints (`.strict()` payload object).

- [ ] **Step 1: Write failing tests** in `scripts/connections.test.mjs`:
  - `execute forwards the agent's chat as x-nest-channel-id`: run with `{...env, ORGOPS_CHANNEL_ID: "channel-1"}`; assert `init.headers["x-nest-channel-id"] === "channel-1"`.
  - `execute without a chat sends no channel header` and `list never sends a channel header`: assert the header is `undefined`.
  - `connection action shape accepts only Nest as the source`: import `eventShapes` from the skill and `validateEventAgainstShapes` from `@orgops/schemas`; a valid draft with `source: "system:nest-connections"` → `ok: true`; same draft with `source: "agent:NikiPA"` → `ok: false`; a payload with an extra `arguments` field → `ok: false`; `outcome: "maybe"` → `ok: false`.
- [ ] **Step 2: Run** `npx vitest run scripts/connections.test.mjs` — expect the new tests to FAIL.
- [ ] **Step 3: Implement** the header (`...(action === "execute" && env.ORGOPS_CHANNEL_ID ? {"x-nest-channel-id": env.ORGOPS_CHANNEL_ID} : {})`; read `env` the way the helper already does for `NEST_CONNECTION_TOKEN`), the shape module (pattern: OrgOps `skills/slack/event-shapes.ts`, with a `description` and `payloadExample`), and the version bump. The version bump is what makes `scripts/orgops-env.ts` refresh the runtime copy.
- [ ] **Step 4: Run** the same test file — expect PASS; also `npx vitest run scripts/orgops-env.test.ts`.
- [ ] **Step 5: Commit**: `feat(connections): forward the agent's chat and declare the action event`.

### Task 3: Nest API records changes in the right chat

**Files:**
- Modify: `apps/api/src/integrations/provider.ts` (`IntegrationTool` gains `tags: string[]`)
- Modify: `apps/api/src/integrations/composio.ts` (`tool()` mapper copies string entries of `value.tags`, else `[]`)
- Create: `apps/api/src/integrations/action-lines.ts`
- Modify: `packages/orgops-client/src/index.ts` (new `connectionActivity`)
- Modify: `apps/api/src/integrations/routes.ts` (execute branch of the `/skill/${action}` route)
- Test: `apps/api/src/integrations/integrations.test.ts`
- Modify: `docs/SPEC.md` (connected-app section)

**Interfaces:**
- Consumes: header `x-nest-channel-id`, event shape (Task 2).
- Produces:
  - `actionChange(tags: readonly string[]): "create" | "update" | "delete" | null`
  - `createActionLines(deps: { orgops: OrgOpsClient; engineToken?: string; audit(type: string, ownerId: string, data: Record<string, unknown>): void; timeoutMs?: number }): { record(input: ActionLineInput): Promise<void> }` where `ActionLineInput = { channelId?: string; ownerId: string; agentName: string; connectionId: string; tool: IntegrationTool; outcome: "ok" | "failed" | "unknown"; requestId: string }`. `record` resolves in every case and logs failures without secrets; default `timeoutMs` 2000.
  - `orgops.connectionActivity(serviceToken: string): { channel(id: string): Promise<{ id: string; archivedAt?: number | null; participants: { subscriberType: string; subscriberId: string }[] } | null>; post(event: { type: string; source: string; channelId: string; status: "DELIVERED"; idempotencyKey: string; payload: Record<string, unknown> }, signal?: AbortSignal): Promise<void> }` using the `x-orgops-runner-token` header like `agentManagement`; `channel` reads `/api/channels?includeArchived=1` and finds the ID.
  - `title` in the payload is the provider tool `name`, cleaned with the same rule as `actionName` in `apps/user-ui/src/components/ConnectionActions.tsx` (move that function to `packages/schemas` as `friendlyActionName(name: string, slug: string, toolkit: string): string` and import it in both places).

- [ ] **Step 1: Write failing tests** in `integrations.test.ts`. Setup changes: copy `skills/nest-connections` into `join(dir, "skills", "nest-connections")` before `createEngine`; the `/tools/TRELLO_GET_BOARDS` fixture returns `tags: toolTags` (a `let`, default `["readOnlyHint"]`); add a fixture branch returning `{ successful: false, error: "secret-provider-detail" }` when `providerSaysNo` is set; add `engineDown` that makes the product's OrgOps fetch reject `POST /api/events`. A helper `actionLines(channelId)` reads `/api/events?channelId=…` as the owner and filters `type === "telemetry.nest.connection.action"`. Tests:
  - `posts one line for a change in the agent's chat`: `toolTags = ["createHint"]`, execute with header `x-nest-channel-id: channel`; expect exactly one event, `source: "system:nest-connections"`, `status: "DELIVERED"`, payload `{ agentName: "PuffOwner", connectionId: localId, app: "trello", tool: "TRELLO_GET_BOARDS", change: "create", outcome: "ok", requestId: expect.any(String), title: expect.any(String) }`; `JSON.stringify(event)` contains neither `private-argument` nor `private-result`.
  - `classifies delete over update over create`: unit-test `actionChange` with `["createHint","updateHint","destructiveHint"]` → `delete`, `["createHint","updateHint"]` → `update`, `["readOnlyHint"]` → `null`, `[]` → `null`.
  - `posts no line for a read or for a call without a chat`: read tags with header → 0 lines; change tags without header → 0 lines; both executes return 200 with the provider result.
  - `posts no line into a chat the agent is not in`: create a second channel as the owner without PuffOwner; execute with that ID → 200, 0 lines in both channels, and an `audit.connection.tool.line_rejected` row in the product audit. Same for an archived chat and for `"no-such-channel"`.
  - `marks provider refusals as failed and lost responses as unknown`: `failExecute` (HTTP 500 → `ProviderRequestError`) → `outcome: "failed"`, route still 502; `providerSaysNo` → `outcome: "failed"`, route still 200 with the body; make the provider fetch throw a `TypeError` → `outcome: "unknown"`, route 502.
  - `returns the tool result even when the line cannot be posted`: `engineDown = true`, change tags → execute 200 with the same body; 0 lines.
- [ ] **Step 2: Run** `npx vitest run apps/api/src/integrations` — expect the new tests to FAIL (the pre-existing `renewal preserves other skills…` failure against the local engine branch is known and unrelated).
- [ ] **Step 3: Implement** in this order: `tags` on `IntegrationTool` and the Composio mapper; `friendlyActionName` in `packages/schemas` (switch `ConnectionActions.tsx` to it); `connectionActivity` in the client; `action-lines.ts`; then in the route, after the provider call settles, `await lines.record({...})` with `outcome` from: success and `result?.successful !== false` → `ok`; success with `successful === false` → `failed`; `ProviderRequestError` → `failed`; anything else → `unknown`. Record before returning or throwing, so the line lands inside the agent's turn. Rejected-channel audit data: `{ requestId, agentId, reason: "not_participant" | "archived" | "missing" }`. Update the Nest SPEC connected-app section.
- [ ] **Step 4: Run** `npx vitest run apps/api/src/integrations scripts/connections.test.mjs apps/user-ui/src` and `npm run lint` — expect PASS apart from the known renewal test.
- [ ] **Step 5: Commit**: `feat(connections): show account changes as lines in the agent's chat`.

### Task 4: Group each turn's events with the agent's reply

**Files:**
- Modify: `apps/user-ui/src/chat/timeline.ts` (`TRACE_TYPES`, `buildTimeline`)
- Test: `apps/user-ui/src/chat/timeline.test.ts`

**Interfaces:**
- Produces: `buildTimeline` emits, for each agent turn, one `activity` item placed directly after that agent's last `message.created` inside the turn, so the existing `attachesTo` in `ChatThread.tsx` attaches it to the reply. Item shape unchanged.

Grouping rule: a turn for agent A runs from `agent.turn.started` (source `agent:A`, `triggerEventId` T) to the next `agent.turn.completed` or `agent.turn.failed` from A with T. Trace events in between whose agent is A belong to that turn. The agent of an event is: `payload.agentName` if a string, else the `agent:` source, else the agent of the only open turn; with several open turns and no agent, the most recently started. Events outside any turn go to the group of their agent's most recent reply before them; with no such reply, they form a standalone group at their own position. Keep `groupId` for stable IDs.

- [ ] **Step 1: Write failing tests** in `timeline.test.ts` (build events with the file's existing helpers):
  - `puts a turn's activity after the agent's reply, not after the question`: human message, turn.started(A), tool events, action event, agent message from A, turn.completed(A) → items `[human message, A message, activity(all turn events incl. turn.completed)]`.
  - `keeps overlapping agents' activity with their own replies`: turns of A and B interleaved, each with an action event carrying `agentName`, replies from both → each activity item holds only its agent's events and follows its agent's reply.
  - `a turn without a reply stays where it ended`: turn.started, action, turn.failed → one standalone activity item after the preceding message.
  - `late events join the agent's previous reply`: an action event for A after turn.completed and after a later human message → it is in A's earlier activity group.
  - `late events with no earlier reply in the window stand alone`.
  - `includes connection action events in activity`: `telemetry.nest.connection.action` is treated as a trace type.
- [ ] **Step 2: Run** `npx vitest run apps/user-ui/src/chat/timeline.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** the rule in `buildTimeline`; add the type to `TRACE_TYPES`.
- [ ] **Step 4: Run** `npx vitest run apps/user-ui` — expect PASS (fix any existing timeline tests whose placement the spec intentionally changes, noting each in the commit body).
- [ ] **Step 5: Commit**: `feat(chat): group each turn's activity with the agent's reply`.

### Task 5: Lines, failure and Details in the chat

**Files:**
- Modify: `apps/user-ui/src/activity.ts`
- Test: `apps/user-ui/src/activity.test.ts`
- Create: `apps/user-ui/src/components/TurnActivity.tsx`
- Modify: `apps/user-ui/src/chat/ChatThread.tsx` (render `TurnActivity` where `AgentActivity` is rendered today)
- Modify: `apps/user-ui/src/styles.css` or `apps/user-ui/src/chat/chat.css` (line, failure and Details styles, theme tokens only)
- Test: `tests/browser/chat.ts`
- Modify: `docs/SPEC.md`, `docs/PERSONAL_AGENTS.md`

**Interfaces:**
- Consumes: event shape (Task 2), grouping (Task 4), `connectionAppName` from `ConnectionActions.tsx`, `IntegrationLogo`.
- Produces:
  - `connectionActionLine(event: EventRow): { app: string; text: string; tone: "neutral" | "danger" | "muted" } | null`
  - `turnFailureText(event: EventRow, agentName: string): string`: "NikiPA couldn't finish: " plus one plain sentence; strip `AI_…Error:` prefixes and JSON; map image-input rejection, step limit, provider credit/suspension and cancellation to fixed sentences; otherwise the first sentence, at most 160 characters.
  - `activity()` gains a title for the new type ("Changed Miro" style, used inside Details).
  - `TurnActivity({ events, agentName, formatTime }): JSX` renders lines in order, then the failure (if any), then a `<details>` labelled "Details" containing the unchanged `AgentActivity`.

- [ ] **Step 1: Write failing unit tests** in `activity.test.ts` for the three line outcomes using the exact copy in Global Constraints; a malformed payload → `null`; `turnFailureText` for `"AI_APICallError: Invalid image or video input"` → "NikiPA couldn't finish: this model can't read images." and for an unknown multi-sentence error → its first sentence.
- [ ] **Step 2: Run** `npx vitest run apps/user-ui/src/activity.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** the helpers and `TurnActivity`; swap it into `ChatThread.tsx`; styles from existing tokens.
- [ ] **Step 4: Update the browser test** `tests/browser/chat.ts`: copy `skills/nest-connections` into `join(dir, "skills", "nest-connections")` before `createEngine`; in the existing seeded turn, also post one `telemetry.nest.connection.action` (source `system:nest-connections`, app `miro`, `outcome: "ok"`) and one with `outcome: "unknown"` via the runner token. Assert: the reply shows "Miro · …" and the "may not have finished" line; no `.trace-chip` is visible until "Details" is opened; after opening Details, the existing chip, tooltip and raw-JSON assertions still hold (move them after the Details click). Keep the mobile checks, opening Details first. Capture desktop and mobile screenshots of a reply with lines.
- [ ] **Step 5: Run** `npx vitest run apps/user-ui`, `npx tsc -p apps/user-ui --noEmit`, `timeout 400 node --import tsx tests/browser/chat.ts` — expect PASS; look at the screenshots at both widths.
- [ ] **Step 6: Update docs**: Nest SPEC chat activity section and `docs/PERSONAL_AGENTS.md` (what owners see when agents change their accounts).
- [ ] **Step 7: Commit**: `feat(chat): show app changes and failures as lines, raw events under Details`.

### Task 6: Local check with the real runner

- [ ] **Step 1:** Confirm `vendor/orgops` is at the Task 1 commit (`git -C vendor/orgops log --oneline -1`).
- [ ] **Step 2:** Run `npm run lint` and `npm test` in Nest; record results, including the known renewal failure.
- [ ] **Step 3:** Ask the owner to restart `npm run dev:all` (the skill version bump refreshes the runtime skill copy and the runner picks up the engine change), then ask NikiPA for a small Miro change (e.g. add a sticky note to a test board). Expected: one "Miro · Create sticky note item" line under the reply, nothing under the owner's question, Details shows the raw events.
- [ ] **Step 4:** Report what was verified and what was not. Nothing is pushed until the owner has tested.
