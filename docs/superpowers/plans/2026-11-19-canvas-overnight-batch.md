# Canvas Overnight Batch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix automatic chat naming, finish the Phase 1 leftovers and Phase 3 follow-ups that need no engine change,
add the missing mockup pieces, and drop the curled tinted card border.

**Architecture:** Each task is self-contained on `feat/switchyard-canvas`, behind `NEST_ENABLE_CANVAS` where it is
canvas work. Decisions are in the spec; the owner delegated every call ("implement everything according to your
understanding and recommendations").

**Tech Stack:** TypeScript, Hono, better-sqlite3, zod, React 18, Vitest, npm workspaces.

**Spec:** `docs/superpowers/specs/2026-11-19-canvas-overnight-batch-design.md`

## Global Constraints

- Repo rules (`AGENTS.md`): npm, never pnpm; never edit `vendor/orgops`; no engine DB reads in `apps/api`; product state
  only in `packages/db` with numbered migrations (next is `019`); product types in `packages/schemas`; functional
  factories + DI; colocated tests that exercise the real adapter/engine boundary; keep `docs/SPEC.md` and
  `docs/ROADMAP.md` in sync with behaviour changes.
- Conventional commits; **no AI attribution lines** (no `Co-Authored-By`); never push.
- Never print, log or commit credentials or provider keys; provider errors are never logged raw.
- Preserve the `switchyard.agent` setting and the stopped engine agent it names: never start, rename or delete it
  (reading its provider env through the engine is allowed).
- Do not touch `.nest-product/` or `.nest-data/` (live local data); do not start/stop dev servers; no full builds.
- Verify with focused `npx vitest run <files>` and `npx tsc --noEmit -p <package>` for each touched package; run
  `npm test` once per task before committing.

---

### Task 1: Automatic chat naming and summaries work without a management agent

**Files:**
- Modify: `apps/api/src/app.ts` (naming source ~105, summarizer ~116-124, naming worker context ~154-166),
  `apps/api/src/project-naming-worker.ts`, `docs/SPEC.md` (project naming section, ~478 and ~3077), `.env.example`
  (naming comments ~128-143)
- Test: `apps/api/src/project-naming-worker.test.ts` (and the app-level naming test if one exists)

**Root cause (controller diagnosis):** on this install `NEST_MANAGEMENT_AGENT_NAME` and
`NEST_PROJECT_NAMING_AGENT_NAME` are unset, so `namingSource` is undefined. The default model is
`openai-compatible:accounts/fireworks/models/glm-5p3`; its keys (`OPENAI_COMPATIBLE_API_KEY`/`_BASE_URL`) exist only
as **public-scope engine secrets**, not in the API's process env. `projectNamingEnv` therefore throws
"Project naming provider is unavailable", the worker swallows it, and after 5 attempts every job is `failed`. The
canvas summarizer has the same `!namingSource → null` gap.

**Interfaces:**
- Produces: a resolved naming source = `NEST_PROJECT_NAMING_AGENT_NAME ?? NEST_MANAGEMENT_AGENT_NAME ?? <the Switchyard
  agent name>` (the name the existing `switchyard` factory resolves from the `switchyard.agent` setting /
  `NEST_SWITCHYARD_AGENT_NAME`, default `Switchyard`), used by both naming and the summarizer. The Switchyard agent is
  only read through `/api/secrets/env` (its `allowOwnerHumanSecrets` is false, so the existing guard holds); it is
  never started, renamed or modified.
- Produces: one sanitized log line per failed attempt category (e.g. `project naming: provider unavailable`,
  `project naming: model unavailable`, `project naming: generation failed`), never the raw error, prompt or keys.

- [ ] **Step 1: Write failing tests**: naming succeeds when only the Switchyard agent is available as the secrets
  source (engine fake/real boundary as existing tests do); the summarizer gets a model+env in the same setup; a
  failure logs exactly one category line and no raw error text (assert the logger received no substring of the thrown
  message).
- [ ] **Step 2: Run** them — FAIL.
- [ ] **Step 3: Implement** the fallback source (resolve the Switchyard name lazily through the existing switchyard
  factory/setting, not a hard-coded string) and the sanitized categories (classify by which step failed, not by
  parsing messages). Update SPEC and `.env.example` to say naming/summaries fall back to the Switchyard agent's
  provider env when no naming/management agent is set.
- [ ] **Step 4: Run** the tests, `npx tsc --noEmit -p apps/api`, `npm test` — PASS.
- [ ] **Step 5: Commit** `fix(api): name chats and summarise with the Switchyard agent's provider keys`.

### Task 2: Flat card border, legend, summary line, share avatars

**Files:**
- Modify: `apps/user-ui/src/canvas/canvas.css` (`.canvas-card.in-area` ~2879-2889), `apps/user-ui/src/canvas/CanvasView.tsx`
  (top bar ~1580-1608, share button ~1595), `apps/user-ui/src/canvas/pulse.ts` (aggregate next to `areaSummaries` ~143),
  `apps/user-ui/src/canvas/area-summary.ts` (wording), `docs/SPEC.md`
- Create: `apps/user-ui/src/canvas/Legend.tsx`, `apps/user-ui/src/canvas/ShareAvatars.tsx` (or inline if tiny), tests
  `Legend.test.tsx`, `pulse.test.ts` additions, `ShareAvatars.test.tsx`

**Interfaces:**
- Produces: `canvasSummary(cards, pulses): {chats: number; moving: number; quiet: number}` in `pulse.ts`;
  `summaryText(s): string` → `"5 chats · 2 moving · 1 quiet"` / `"5 chats · 2 moving"` (quiet omitted at 0; singular
  `1 chat`), reusing `area-summary.ts` formatting.

- [ ] **Step 1: Write failing tests**: `canvasSummary` counts only open cards and maps pulse states (working → moving,
  quiet → quiet) exactly like `areaSummaries` does; `summaryText` cases above; `Legend` renders the three labels
  `working`, `waiting on you`, `gone quiet` and the hint naming the tray's real heading; `ShareAvatars` renders at most 3
  initials then `+N`, excludes the viewer, and renders nothing with no other members.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement**. Border: replace the 4 px top stripe with a uniform 1.5 px border in
  `color-mix(in srgb, var(--tint) 45%, var(--nest-border))` (keep radius; needs-you keeps coral; delete the
  `.in-area.needs-you { border-top-color }` rule). Legend: bottom-right pill above the zoom buttons using the existing
  status colour tokens (lime, coral, dashed `--canvas-quiet`), hidden in split mode and on phones, `aria-label="Legend"`,
  pointer events only on itself. Summary line after `<h1 className="canvas-name">`, `className="canvas-summary"`, hidden
  below 1200 px. Share avatars inside the share pill from `getMembers` (only where the viewer may read members; check
  the API), tooltip `People with access`. Update `docs/SPEC.md` (card border, legend, summary, avatars).
- [ ] **Step 4: Run** focused tests, `npx tsc --noEmit -p apps/user-ui`, `npm test` — PASS.
- [ ] **Step 5: Commit** `feat(canvas): flat area border, legend, summary line and share avatars`.

### Task 3: Invite agents with drag labels and an Add agent picker

**Files:**
- Modify: `apps/user-ui/src/canvas/Surface.tsx` (agent drag over/drop ~341-415), `apps/user-ui/src/canvas/CanvasView.tsx`
  (`dropAgent` ~1040, chat More menu), `apps/user-ui/src/canvas/AgentTray.tsx` (agent source list), `canvas.css`,
  `docs/SPEC.md`
- Create: `apps/user-ui/src/canvas/invite-label.ts` (+ test), `apps/user-ui/src/canvas/AddAgentPicker.tsx` (+ test)

**Interfaces:**
- Produces: `inviteLabel(input: {agent: string; card: {title: string; access: string; manageable: boolean; members:
  string[]}}): string` → `Invite Moss to "Title"` | `Moss is already here` | `You can't add agents to this chat`.

- [ ] **Step 1: Write failing tests** for `inviteLabel` (the three cases; locked/unavailable cards → the "can't" text)
  and `AddAgentPicker` (lists the tray's agents, filters by typed text case-insensitively, marks agents already in the
  chat as "In this chat" and disabled, calls `onPick(name)`).
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement**: a floating label (`position: fixed`, `pointer-events: none`) that follows the pointer
  during an agent `dragover` on the surface, updated per target card, removed on leave/drop/dragend (dataTransfer type
  is readable in dragover; the agent name is not — keep the dragged name in a module ref set by `AgentTray`'s
  `startDrag`). The open chat's More menu gets `Add agent…`, opening the picker; picking runs `dropAgent(channelId,
  name)` (same checks/errors). Keyboard: Arrow/Enter/Escape in the picker; focus returns to the menu button.
- [ ] **Step 4: Run** focused tests, tsc, `npm test` — PASS.
- [ ] **Step 5: Commit** `feat(canvas): invite agents with drag labels or the Add agent picker`.

### Task 4: Move cards and areas with the keyboard

**Files:**
- Modify: `apps/user-ui/src/canvas/Card.tsx`, `apps/user-ui/src/canvas/Area.tsx`, `apps/user-ui/src/canvas/Surface.tsx`
  (pointer-up commit ~597-615 — share it), `docs/SPEC.md`, `docs/ROADMAP.md` (Phase 1 deferred line)
- Create: `apps/user-ui/src/canvas/keyboard-move.ts` (+ test)

**Interfaces:**
- Produces: `nudge(key: string, shift: boolean): {dx: number; dy: number} | null` (8 / 40 world px; null for other
  keys); `createMoveBurst({commit, revert, delayMs = 400, setTimer, clearTimer})` → `{step(dx, dy), cancel()}` that
  accumulates presses and calls `commit(totalDx, totalDy)` once after `delayMs` idle, or `revert()` on `cancel()`.

- [ ] **Step 1: Write failing tests**: `nudge` for the four arrows with and without Shift and `null` for `a`/`Tab`;
  `createMoveBurst` with a fake timer: three steps → one commit with the summed delta; cancel → revert, no commit.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement**: card and area elements handle `onKeyDown` when the event target is the card/area element
  itself (not inputs, buttons inside, or menus); preview the offset locally, commit through the same code path as the
  pointer-up (extract a shared `commitCardMove`/`commitAreaMove` from `Surface.tsx` rather than duplicating), Escape
  cancels. Announce via a polite live region (`Moved into <area>` / `Moved`). Editors only.
- [ ] **Step 4: Run** focused tests, tsc, `npm test` — PASS.
- [ ] **Step 5: Commit** `feat(canvas): move cards and areas with the arrow keys`.

### Task 5: Archived chats in search, Apps here filter

**Files:**
- Modify: `apps/user-ui/src/canvas/CanvasView.tsx` (search index ~993), `apps/user-ui/src/canvas/search.ts`,
  `apps/user-ui/src/canvas/CanvasSearch.tsx`, `apps/user-ui/src/chat/AppsHere.tsx`, `apps/user-ui/src/chat/ChatThread.tsx`
  (~361, timeline), `docs/SPEC.md`, `docs/ROADMAP.md`
- Test: `search.test.ts`, `AppsHere.test.tsx` (create if absent), a pure filter test

**Interfaces:**
- Produces: search entries for archived loose chats with `archived: true`, ranked after non-archived matches;
  `filterTimelineByApp(items, app: string | null)` (pure, in `src/chat/`) returning only that app's `tool.*` items when
  `app` is set, all items otherwise.

- [ ] **Step 1: Write failing tests**: the index includes archived loose chats even with Show archived off, tagged and
  ordered last; `filterTimelineByApp` keeps only matching app tool events and drops messages; `null` keeps all;
  `AppsHere` chips render as `aria-pressed` toggles and a `Show all` control when one is active.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** (search result shows an `Archived` tag; opening does not unarchive; filter state lives in
  the thread per channel, resets when the channel changes; the bar reads `Showing only <App> · Show all`).
- [ ] **Step 4: Run** focused tests, tsc, `npm test` — PASS.
- [ ] **Step 5: Commit** `feat(canvas): archived chats in search and Apps here filter`.

### Task 6: Team and viewer-share access in flow checks

**Files:**
- Modify: `apps/api/src/flows/access.ts` (`channelAccess` ~20-26), its callers in `flows/handoff.ts` (~105),
  `flows/scheduler.ts` (~106, ~473, ~544), `flows/hooks.ts` (~157, ~287), `flows/routes.ts` (~145), `flows/forks.ts`
  (~65, ~117); `packages/orgops-client/src/index.ts` if a teams/shares read is needed; `docs/SPEC.md` (~1343),
  `docs/ROADMAP.md` (~670)
- Test: `apps/api/src/flows/access.test.ts`, `flows/links.test.ts` (~116-122 flips to allowed), `flows/schedules.test.ts`

**Interfaces:**
- Produces: `channelAccess(channel, human, extra: {teamIds: Set<string>; viewerShare: boolean})` →
  `{member, read, post}` with **post** = not archived and (owner | human subscription | TEAM subscription whose team the
  human belongs to | public) and **read** = post-eligible membership | public | viewer share. A loader
  `accessExtras(orgops, token)` returning `(channelId, human) => Promise<{teamIds, viewerShare}>` that reads
  `/api/teams` + members and `/api/channels/:id/shares` through engine HTTP with the service token, cached per tick.

- [ ] **Step 1: Write failing tests** against the real engine (as the existing flow tests do): a private chat reached
  only through a team now allows a link/schedule (post); a viewer share allows reading a hand-off source but not
  posting into a target or scheduling; leaving the team pauses the schedule with the existing access wording.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement**; `linkRights` unchanged. Confirm the engine endpoints accept the service token (read
  `vendor/orgops/apps/api/src/routes/collab.ts` ~314-440 and ~938); if one does not, use the nearest service-token
  route and say so in the report.
- [ ] **Step 4: Run** the flows tests, tsc, `npm test` — PASS.
- [ ] **Step 5: Commit** `feat(flows): count team and viewer-share access the way the engine does`.

### Task 7: App-event triggers — provider, storage, receiver

**Composio facts (verified from docs.composio.dev, base `https://backend.composio.dev/api/v3.1`, header `x-api-key`):**
- Trigger types: `GET /triggers_types?toolkit_slugs=<slug>&limit=50&cursor=` → `{items, next_cursor}`; item
  `{slug, name, description, instructions, types, toolkit{slug,name,logo}, config (JSON schema), payload, version,
  requires_webhook_endpoint_setup}`. Single: `GET /triggers_types/{slug}`.
- Create/enable: `POST /trigger_instances/{slug}/upsert` body `{connected_account_id, trigger_config, egress_url}` →
  200/201 `{trigger_id, type, fallback_reason, polling_interval}`.
- Disable/enable: `PATCH /trigger_instances/manage/{triggerId}` body `{status: 'enable'|'disable'}` (409 = already).
  Delete: `DELETE /trigger_instances/manage/{triggerId}` (409/410 = already gone → treat as success).
- Delivery (V3): `{id, type: 'composio.trigger.message', metadata: {log_id, trigger_slug, trigger_id,
  connected_account_id, auth_config_id, user_id}, data, timestamp}`; other `type`s (e.g.
  `composio.connected_account.expired`) arrive at the same URL — acknowledge 200 and ignore.
- Signature: headers `webhook-id`, `webhook-timestamp` (Unix seconds), `webhook-signature`; signed string
  `${id}.${timestamp}.${rawBody}`; HMAC-SHA256 with the secret string as-is, base64; the header holds one or more
  space-separated `v1,<b64>` values — accept if any matches (`timingSafeEqual`); reject timestamps more than 300 s from
  now.

**Files:**
- Create: `packages/db/migrations/019_app_triggers.sql` (adds to `product_triggers`: `kind TEXT NOT NULL DEFAULT
  'webhook' CHECK (kind IN ('webhook','app'))`, `app_slug`, `trigger_slug`, `composio_trigger_id` (unique when not null),
  `connected_account_id`, `trigger_config_json`; and table `product_app_trigger_events(event_id TEXT PRIMARY KEY,
  received_at INTEGER NOT NULL)` for dedupe, pruned after 7 days), `apps/api/src/flows/app-triggers.ts` (+ test),
  `apps/api/src/integrations/composio-triggers.ts` (+ test, injectable fetch like `composio.ts`)
- Modify: `packages/db/src/index.ts` (register 019), `packages/db/src/schedules.ts` (trigger rows carry the new fields),
  `packages/db/src/projects.test.ts` (migration list), `packages/schemas/src/schedules.ts` (`NewAppTriggerSchema`,
  `RuleLike` gains `{kind: 'app'}`), `apps/api/src/integrations/provider.ts` (optional `triggers?` capability),
  `apps/api/src/flows/hooks.ts` (reuse `deliver`/`check`; register `POST /api/hooks/composio` before `/api/hooks/:token`),
  `apps/api/src/app.ts`, `.env.example` (`NEST_COMPOSIO_WEBHOOK_SECRET`), `docs/SPEC.md` (~1880, ~1967-1970)

**Interfaces:**
- Produces (provider): `triggers: {types(toolkit): Promise<AppTriggerType[]>; create(input: {slug; accountId; config;
  egressUrl}): Promise<{triggerId: string}>; setEnabled(triggerId, enabled): Promise<void>; remove(triggerId):
  Promise<void>}` with `AppTriggerType = {slug, name, description, config: JSONSchema}`.
- Produces (routes, owner of the trigger = creator, same permission as webhook triggers):
  `GET /api/flows/app-triggers/types?app=<toolkit>` (only toolkits the creator has an active connected account for),
  `POST /api/flows/triggers` accepting `kind: 'app'` with `{channelId, agent, prompt, label, app, triggerSlug, config}`;
  pause/resume/delete of an app trigger disables/enables/deletes at Composio first (a Composio failure → 502, Nest row
  unchanged). Availability (`flows-api` `webhooks`-style flag) gains `appEvents: boolean` = secret set && provider has
  `triggers`.
- Produces (receiver): `POST /api/hooks/composio` → 401 bad/missing signature or stale timestamp, 413 over 64 KiB,
  200 for ignored types/unknown trigger ids/duplicates, 202 when delivered. Delivery text = the trigger's prompt plus a
  fenced JSON block of `data` (truncated to the existing webhook body limit), posted exactly like a webhook run
  (`kind: 'app-event'` in meta, idempotency key `nest:app:<triggerId>:<event id>`), after the same `check()`.

- [ ] **Step 1: Write failing tests**: signature verify (valid; wrong secret; tampered body; stale timestamp; multiple
  header values with one valid); the client maps each Composio call (fake fetch asserting method/path/body, 409/410
  delete → success); receiver: unknown trigger → 200 no post, duplicate event id → one post, ignored `type` → 200,
  valid → Switchyard post with the idempotency key, access lost → trigger paused like webhooks; create route refuses an
  app the creator has no connected account for (400) and stores `composio_trigger_id`; delete calls Composio delete.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement**; never log payloads, secrets or connected-account ids; event dedupe in the same
  transaction as marking the delivery.
- [ ] **Step 4: Run** focused tests, tsc (schemas, db, api), `npm test` — PASS.
- [ ] **Step 5: Commit** `feat(flows): app-event triggers through Composio`.

### Task 8: App-event triggers — UI

**Files:**
- Modify: `apps/user-ui/src/canvas/SchedulePopover.tsx` (kinds ~13-15, list ~100), `apps/user-ui/src/canvas/flows-api.ts`,
  `apps/user-ui/src/canvas/ScheduledList.tsx`, `tests/browser/canvas/schedules.ts` (~83 kind list), `docs/SPEC.md`
- Create: `apps/user-ui/src/canvas/AppTriggerFields.tsx` (+ test), `apps/user-ui/src/canvas/trigger-config.ts` (+ test)

**Interfaces:**
- Consumes: Task 7 routes and `appEvents` availability.
- Produces: `configFields(schema): Field[]` turning a trigger's JSON schema into simple fields (string, number, boolean,
  enum; required marked; unsupported nested types shown as a JSON textarea) and `configValue(fields, values)`.

- [ ] **Step 1: Write failing tests** for `configFields`/`configValue` (types, required, defaults, enum, nested
  fallback) and `AppTriggerFields` (app select of connected apps → trigger type select → fields).
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement**: kind `App event` appears after Webhook only when `appEvents`; saving posts `kind: 'app'`;
  the Scheduled list shows the app and trigger name, Pause/Resume/Delete as for webhooks; errors inline. Update the
  browser test's expected kind list accordingly (it asserted "no app events").
- [ ] **Step 4: Run** focused tests, tsc, `npm test` — PASS.
- [ ] **Step 5: Commit** `feat(canvas): create app-event triggers from the schedule popover`.

### Task 9: The canvas on phones

**Files:**
- Modify: `apps/user-ui/src/canvas/CanvasView.tsx` (phone branch ~1548-1553, `usePhoneLayout` use ~169),
  `apps/user-ui/src/canvas/PhoneList.tsx`, `apps/user-ui/src/canvas/Surface.tsx` (touch pinch/pan ~210, ~488-574; `+`
  port drag), `apps/user-ui/src/canvas/canvas.css` (phone rules ~2821), `docs/SPEC.md`,
  `docs/superpowers/specs/2026-11-08-switchyard-canvas-design.md` (phone paragraph)
- Create: `apps/user-ui/src/canvas/phone-view.ts` (+ test)

**Interfaces:**
- Produces: `phoneView(stored: string | null): 'canvas' | 'list'` (default `'canvas'`) and `PHONE_VIEW_KEY =
  'nest-canvas-phone-view'` (localStorage, try/catch).

- [ ] **Step 1: Write failing tests** for `phoneView` (null/garbage → canvas, 'list' → list) and a render test that the
  phone canvas renders the Surface plus a `List` toggle (aria-pressed) and no rail/legend/zoom.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement**: at ≤ 760 px render the canvas by default with the existing touch pinch/pan; hide rail,
  legend and zoom buttons; drawer and open chat (floating or split) take the screen width (one window at a time);
  `List`/`Canvas` toggle in the top bar persists the choice; `+` port dragging disabled for touch pointers.
- [ ] **Step 4: Run** focused tests, tsc, `npm test` — PASS.
- [ ] **Step 5: Commit** `feat(canvas): the canvas on phones, with a List toggle`.

### Task 10: Roadmap and spec sync

**Files:** Modify `docs/ROADMAP.md` (Phase 1 deferred line, Phase 2 mockup follow-ups, Phase 3 follow-ups, add entries
for New chat buttons, chat rename, paste links into context, chat naming fix), `docs/SPEC.md` (paste paragraph
~1079-1085: paste reaches the popover wherever focus is, the hyperlink fallback, the muted hint).

- [ ] **Step 1:** Update the documents to describe what is built and what remains (U3, U6, live presence, re-running old
  naming jobs), without claiming deployment.
- [ ] **Step 2: Commit** `docs: roadmap and spec for the overnight canvas batch`.
