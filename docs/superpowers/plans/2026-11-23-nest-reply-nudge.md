# Reply Nudge and Unanswered Turns Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When an agent ends a turn without answering a person who was waiting, Nest shows it plainly and asks the agent once to reply.

**Architecture:** A Nest API worker scans engine `agent.turn.completed` events through a new `replyNudges` engine client. When the rule matches, it posts one targeted `message.created` from `system:nest`, deduplicated with an engine idempotency key. The chat timeline marks an agent turn that finished with no reply as "unanswered" and draws it as the agent's row. It shows the nudge as a small system line.

**Tech Stack:** TypeScript, Hono, better-sqlite3, React, vitest; tests use the in-process OrgOps engine.

**Spec:** `docs/superpowers/specs/2026-11-23-nest-reply-nudge-design.md`

## Global Constraints

- Branch `feat/agent-providers-and-connected-apps`, primary checkout. Commit locally and never push. Never commit `vendor/orgops`, which is pinned to the local Stop branch for testing.
- Do not edit `vendor/orgops`. Engine access goes only through `packages/orgops-client`. No product migration: the cursor lives in `product_settings` under key `reply_nudge_cursor`.
- Nudge event: `type: "message.created"`, `source: "system:nest"`, `parentEventId: <triggerEventId>`, `payload: { text, targetAgentName: <agent>, nestReplyNudge: { triggerEventId, requestedFor: "human:<name>" } }`, `idempotencyKey: "nest-reply-nudge:<agent>:<triggerEventId>"`.
- Nudge text: ``You ended your turn without replying to ${name}. Reply to them now, or say why you can't.``
- Chat copy: "Ended without replying", "It said: “<reason>”", and "Nest asked <agent> to reply."
- Worker tick every 15 s. On its first run the cursor starts at the newest `agent.turn.completed`. Never log raw errors.
- Conventional commits, with no AI attribution lines.

## Review Focus

1. **Running two API processes, or restarting one, must not nudge twice.** Engine idempotency handles this; covered by a test in Task 2.
2. **A group chat where a person talks to another agent.** That agent's silent turn must not be nudged; covered in Task 2.
3. **The person has already asked again ("so what's the answer?").** No nudge; covered in Task 2.
4. **The nudge turn ends silently too.** No second nudge, and the chat shows the unanswered row; covered in Tasks 2 and 3.
5. **Older history pages load a turn's events without its completion.** It must not be marked unanswered; covered in Task 3.

---

### Task 1: Engine client and cursor store

**Files:**
- Modify: `packages/orgops-client/src/index.ts` (add `replyNudges`, export the `ReplyNudgeEngine` type)
- Create: `packages/db/src/reply-nudges.ts`; Modify: `packages/db/src/index.ts` (add `replyNudges` to `openProductDb`)

**Interfaces (produces):**
```ts
// orgops-client, created with Nest's runner token
replyNudges(serviceToken: string): {
  turnCompletions(after: number, limit?: number): Promise<CompactionEvent[]>; // type agent.turn.completed, asc
  latestTurnCompletionAt(): Promise<number>;
  event(id: string): Promise<CompactionEvent | null>;
  channelAgents(channelId: string): Promise<string[]>;                       // AGENT participant ids; [] if missing or archived
  messagesAfter(channelId: string, afterExclusive: number): Promise<CompactionEvent[]>; // message.created, asc, up to 200
  postNudge(input: { agentName: string; channelId: string; triggerEventId: string; requestedFor: string; text: string }): Promise<'posted' | 'duplicate'>;
};
export type ReplyNudgeEngine = ReturnType<OrgOpsClient['replyNudges']>;
// packages/db
createReplyNudgeStore(db): { cursor(): number | null; setCursor(value: number): void };
```
`postNudge` returns `'duplicate'` for any 409 or UNIQUE answer, and throws on other errors. These pieces are exercised only through Task 2's tests, against the real engine.

- [ ] **Step 1:** Implement both, following `contextCompaction` and `createContextCompactionStore`. Share the `read`/`events` helpers by lifting them out of `contextCompaction` into the client scope.
- [ ] **Step 2:** Run `npm run lint`.
  Expected: PASS.
- [ ] **Step 3:** Commit, together with Task 2.

### Task 2: Reply nudge worker

**Files:**
- Create: `apps/api/src/reply-nudge-worker.ts`, `apps/api/src/reply-nudge-worker.test.ts`
- Modify: `apps/api/src/app.ts` (create the worker with the same engine token as compaction and return it as `replyNudges`); `apps/api/src/server.ts` (15 s timer, cleared on close)

**Interfaces:**
- Consumes: Task 1.
- Produces: `createReplyNudgeWorker({store, engine, now}): { tick(): Promise<void> }`.

The rule, per completion (from `agent:<name>`, with `payload.triggerEventId`):
1. Skip when `payload.cancelled === true`.
2. The trigger must be a `message.created` from `human:`.
3. The agent must be addressed: `targetAgentName` / `targetAgentNames`, or `mentions[]` with `{kind:"AGENT", name}`. Otherwise it must be the chat's only agent.
4. No `message.created` from `agent:<name>` may fall between the trigger and the completion (`createdAt <= completion.createdAt`).
5. No `human:` message may come after the trigger.

Then call `postNudge`.

- [ ] **Step 1: Write the failing tests** in `reply-nudge-worker.test.ts`. Use the same setup as `context-compaction-worker.test.ts`: an in-process engine, owner login, agent `Pip` in a chat, and a `turn(trigger, {reply?, cancelled?})` helper that posts `agent.turn.started`, an optional reply and `agent.turn.completed` with the runner token.
  - `"asks the only agent in a chat once when it ended without replying"`:
    - Exactly one nudge from `system:nest` with `targetAgentName: "Pip"`, `parentEventId` set to the trigger, `nestReplyNudge.requestedFor: "human:owner"`, and text containing "without replying to owner".
    - A second `tick()` does not add one.
    - `store.replyNudges.setCursor(0)` followed by `tick()` does not add one either (Review Focus 1).
  - `"asks an @mentioned agent in a group chat but not an agent nobody addressed"`: add agent `Rex` to the chat. A trigger mentioning Pip gets a nudge for Pip. A trigger with no mention or target, with both silent, gets none (Review Focus 2).
  - `"leaves replied, stopped and followed-up turns alone"`: three triggers. One gets a reply. One is completed with `cancelled: true`. The third is followed by `say('human:owner','so?')` before `tick()` (Review Focus 3). No nudges.
  - `"does not ask again after the nudge's own turn"`: after the first nudge, complete a turn whose trigger is the nudge event, with no reply, then `tick()`. Still one nudge (Review Focus 4).
- [ ] **Step 2:** Run `npx vitest run apps/api/src/reply-nudge-worker.test.ts`.
  Expected: FAIL, because the worker doesn't exist.
- [ ] **Step 3:** Implement the worker. `scan` mirrors the compaction worker's cursor handling. Errors on one completion skip that completion; the worker never logs raw errors.
- [ ] **Step 4:** Run the test file again, then `npm run lint`.
  Expected: PASS.
- [ ] **Step 5: Commit:** `feat(api): ask an agent once to reply when it ended without answering a person`.

### Task 3: Unanswered row and nudge line in the chat

**Files:**
- Modify: `apps/user-ui/src/chat/timeline.ts`, `apps/user-ui/src/chat/timeline.test.ts`, `apps/user-ui/src/chat/ChatThread.tsx`

**Interfaces (produces in `timeline.ts`):**
- The activity item gets `unanswered?: { agent: string; at: number; reason?: string }`. It is set when the group has no reply, contains an `agent.turn.completed` without `cancelled: true`, and has no `agent.turn.failed`. `at` is the completion's display time. `reason` is the turn's `noop` event `payload.reason`; add `'noop'` to `TRACE_TYPES` so it joins the group.
- A group with `unanswered` is shown even when all of its events are quiet.
- `export function replyNudgeLine(event: EventRow): string | null` returns `"Nest asked <agent> to reply."` for a `system:nest` message with `nestReplyNudge`, and null otherwise.

- [ ] **Step 1: Write the failing tests** in `timeline.test.ts`:
  - `"marks a finished turn without a reply as unanswered, with the agent's reason"`: a human message, then Pip's started / tool.executed / `noop` (`{reason:"already delivered"}`) / completed. The activity has `unanswered: {agent:"Pip", at:<completed time>, reason:"already delivered"}`.
  - `"a quiet turn that ended without replying is still shown"`: only started and completed, with no reply. The item exists and is unanswered.
  - `"replied, stopped, failed and partly loaded turns are not unanswered"`:
    - a turn with a reply;
    - a turn with `cancelled: true`;
    - a turn with `agent.turn.failed`;
    - events with no start or completion loaded (Review Focus 5).
  - `"describes Nest's reply nudge"`: `replyNudgeLine` returns "Nest asked Pip to reply." for the nudge event and null for an ordinary system message.
- [ ] **Step 2:** Run `npx vitest run apps/user-ui/src/chat/timeline.test.ts`.
  Expected: FAIL.
- [ ] **Step 3:** Implement the timeline changes.
- [ ] **Step 4:** In `ChatThread.tsx`:
  - An activity item with `unanswered` renders as an `<article>` laid out like `MessageShell`: the `AgentAvatar`, the agent name and `formatTime(at)`. The body is "Ended without replying", "It said: “…”" when there is a reason, and `<TurnActivity …>` (not standalone).
  - A message item whose `replyNudgeLine` is non-null renders as a small centred muted line instead of a `MessageShell`.
- [ ] **Step 5:** Run the timeline tests, `npx vitest run apps/user-ui`, and `npm run lint`.
  Expected: PASS.
- [ ] **Step 6: Commit:** `feat(user-ui): show a turn that ended without replying as the agent's row`.

### Task 4: Docs and full check

- [ ] **Step 1:** In `docs/SPEC.md`, beside "Chat compaction for long agent chats", add a section "Agents that end without replying". It covers the rule, the single nudge with its idempotency key, the `system:nest` source, and the chat row and nudge line.
- [ ] **Step 2:** Run `npm test` and `npm run lint`.
  Expected: PASS.
- [ ] **Step 3: Commit:** `docs(spec): reply nudge for agents that end without answering`.
