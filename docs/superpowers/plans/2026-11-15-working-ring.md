# Working Ring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hovering or focusing a chat's working row opens a live ring of what the agent is doing this turn, and app reads are recorded so the ring can name them.

**Architecture:** The Nest API records every connected-app call (reads too) as `telemetry.nest.connection.action`; the UI only turns create/update/delete into reply lines. A pure `ringState` function derives stations, counts, failures and a short feed from the open turn's events; `WorkingRing` draws it as SVG inside a radix `HoverCard` on `WorkingRow`.

**Tech Stack:** Hono API, vitest, React 19, `radix-ui` HoverCard, `motion/react`, lucide icons, Playwright browser suite.

**Spec:** `docs/superpowers/specs/2026-11-15-working-ring-design.md`

## Global Constraints

- `vendor/orgops` is never edited. No engine change in this plan.
- The card shows action names only: never commands, arguments, file paths, provider results or process output.
- Reduced motion (`useReducedMotion()`): no pulses, no breathing; stations and list still show.
- Lines under replies keep showing only `create` / `update` / `delete`; `read` and `other` never become lines.
- Colours from Nest tokens in light and dark; app logos via `IntegrationLogo`; centre avatar via `AgentAvatar`.
- Desktop hover and keyboard focus only; nothing new on touch.
- npm, conventional commits ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; nothing pushed before the owner tests.

## Review Focus

- Two agents working in the same chat at once: each row's card shows only its own agent's actions. (Task 2 test.)
- Page opened or reloaded mid-turn: the card shows the actions so far without a burst of pulses for old events. (Task 3 browser check.)
- More than eight different stations in one turn: the ring stays readable, extra stations fold into "Other". (Task 2 test.)
- Tool arguments and outputs present in event payloads: none of their text appears in the card. (Task 3 browser check.)
- A shell command recorded both as `tool.*` and `process.*`: counted once. (Task 2 test.)

---

### Task 1: Record app reads; lines stay changes-only

**Files:**
- Modify: `apps/api/src/integrations/action-lines.ts` (`actionChange`, `record`)
- Modify: `skills/nest-connections/event-shapes.ts` (change enum), `skills/nest-connections/skill.json` (version `1.4.0`)
- Modify: `apps/user-ui/src/activity.ts` (`connectionActionLine`)
- Test: `apps/api/src/integrations/integrations.test.ts`, `apps/user-ui/src/activity.test.ts`, `scripts/connections.test.mjs` (event-shape test: add a `read` payload that validates)
- Docs: `docs/SPEC.md` connected-app paragraph

**Interfaces:**
- Produces: `type ActionChange = "create" | "update" | "delete" | "read" | "other"`; `actionChange(tags: readonly string[]): ActionChange` (never null); event payload `change` accepts all five.
- Produces: `connectionActionLine(event)` returns `null` when `change` is `read` or `other`.

- [ ] **Step 1: Failing tests.**
  - integrations: rename the existing "no line for a read-only/untagged tool" cases to `records reads and untagged tools for the working ring`; assert one event each with `change: "read"` (`readOnlyHint`) and `change: "other"` (no hint tags), same payload keys, no argument/result text.
  - integrations: forged/archived/missing channel still posts nothing for a read (extend the existing rejection test with `toolTags = ["readOnlyHint"]`).
  - activity.test: `connectionActionLine` returns `null` for `change: "read"` and `change: "other"`, still returns the line for `create`.
- [ ] **Step 2: Run** `npx vitest run apps/api/src/integrations/integrations.test.ts apps/user-ui/src/activity.test.ts` — Expected: the new cases FAIL (no event posted / line returned for read).
- [ ] **Step 3: Implement.** `actionChange`: `readOnlyHint` → `read`, else `destructiveHint` → `delete`, `updateHint` → `update`, `createHint` → `create`, else `other`. Move the `actionChange` call inside `record`'s `try` (closes the deferred "never throws" minor). Event shape enum gains `read`, `other`; bump `skill.json` to `1.4.0`. UI line guard. SPEC: reads and untagged tools are recorded with `change: read|other` for the working ring and never shown as lines.
- [ ] **Step 4: Run** the same command — Expected: PASS except the known `renewal preserves other skills…` failure.
- [ ] **Step 5: Commit** `feat(connections): record app reads for the working ring`.

### Task 2: `ringState` — stations, counts, failures and feed

**Files:**
- Create: `apps/user-ui/src/chat/ring.ts`
- Test: `apps/user-ui/src/chat/ring.test.ts`

**Interfaces:**
- Consumes: `connectionAppName(app)` from `components/ConnectionActions`, `friendly` titles already in the action payload.
- Produces:
  ```ts
  export type RingStation={key:string;label:string;app?:string;count:number;failed:boolean};
  export type RingEntry={id:string;station:string;text:string;failed:boolean;at:number};
  export type RingState={stations:RingStation[];feed:RingEntry[];actions:number;thinking:boolean};
  export function ringState(events:readonly EventRow[],agent:string,since:number):RingState;
  export const RING_MAX_STATIONS=8;
  ```

Rules (pinned by the tests):
- Only events at or after `since` whose agent is `agent` (payload `agentName`, `ownerAgentName`, `targetAgentName`, else `agent:` source). Others ignored.
- `tool.started` = one action: its station's `count` +1, `actions` +1, tool in flight. `tool.executed` / `tool.failed` end it and add a feed entry (✗ and `failed` for `tool.failed`, which also marks the station failed).
- Station by tool prefix: `shell_` Shell, `fs_` Files, `memory_` Memory, `events_` Messages, `agents_` Agents, anything else Other. Feed text `"<Station> · <verb>"`; verbs pinned: `shell_run` "ran a command", `fs_read` "read a file", `fs_write` "wrote a file"; others a short past-tense phrase of the builder's choice, never the tool's arguments.
- `telemetry.nest.connection.action`: station `app:<app>` labelled `connectionAppName(app)`, `app` set; count +1, actions +1; feed `"<App> · <title>"`; `outcome: failed` marks it failed.
- `process.*` adds no action; `process.exited` with a numeric non-zero `exitCode` marks Shell failed and adds a ✗ entry "Shell · a command stopped with an error".
- Stations in first-use order; when more than `RING_MAX_STATIONS`, the first seven stay and the rest merge into one `other` station (counts and failure summed).
- `feed`: newest first, at most 5. `thinking`: no tool in flight.

- [ ] **Step 1: Failing tests** in `ring.test.ts`:
  - `counts a shell command once although the engine records tool and process events` — `tool.started{tool:'shell_run'}`, `process.started`, `process.output`, `process.exited{exitCode:0}`, `tool.executed` → Shell count 1, actions 1, feed `['Shell · ran a command']`.
  - `shows an app read and a failed change on the app station` — two action events (`read` ok "Get board", `create` failed "Create card") → one station `app:miro` label `Miro`, count 2, failed true; feed `['Miro · Create card', 'Miro · Get board']` with the first `failed`.
  - `keeps each agent's actions apart` — Ann and Bob events interleaved → `ringState(...,'Ann',0)` sees only Ann's.
  - `ignores events from before the turn` — event at `since-1` not counted.
  - `marks a failing command` — `process.exited{exitCode:2}` → Shell failed, entry failed.
  - `thinks between actions` — after `tool.started` thinking false; after `tool.executed` true.
  - `folds extra stations into Other` — ten distinct apps → 8 stations, last key `other`, counts sum to 10.
  - `never puts arguments or output in the feed` — `tool.started{tool:'fs_read',args:{path:'/secret/x'}}`, `tool.executed{output:'secret'}` → no feed text contains `secret`.
  - `keeps the last five actions` — seven actions → feed length 5, newest first.
- [ ] **Step 2: Run** `npx vitest run apps/user-ui/src/chat/ring.test.ts` — Expected: FAIL (module missing; add an empty export stub so failures are behavioural).
- [ ] **Step 3: Implement** `ringState` in `ring.ts`.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(chat): derive the working ring from the turn's events`.

### Task 3: The ring card on the working row

**Files:**
- Create: `apps/user-ui/src/chat/WorkingRing.tsx`
- Modify: `apps/user-ui/src/chat/WorkingRow.tsx`, `apps/user-ui/src/chat/ChatThread.tsx` (pass `snapshot.events` to the row), `apps/user-ui/src/styles.css` (only if tokens need a class)
- Test: `tests/browser/chat.ts`
- Docs: `docs/SPEC.md` "Chat on assistant-ui" working-row item

**Interfaces:**
- Consumes: `ringState`, `RingState`, `RING_MAX_STATIONS` (Task 2); `IntegrationLogo`, `AgentAvatar`.
- Produces: `WorkingRing({agent,since,events}:{agent:string;since:number;events:readonly EventRow[]})`; `WorkingRow` gains prop `events:readonly EventRow[]`.

Behaviour:
- `WorkingRow` wraps its row in `HoverCard.Root` (`openDelay` 150, `closeDelay` 100); the row is the trigger with `tabIndex={0}` and an accessible name "What <agent> is doing"; content in a portal, `side="bottom" align="start"`, `collisionPadding` 16, max width 380px. Only for working/stopping rows, not interrupted or unavailable ones. Card root class `working-ring`.
- Card: header "<agent> is working" + elapsed (`Ns` / `Nm Ss`, ticking once a second only while open) and "N action(s)"; SVG ring (centre `AgentAvatar`, stations on an ellipse, lucide icons for Shell/Files/Memory/Messages/Agents/Other, `IntegrationLogo` for apps, count "×N", danger stroke when failed); breathing ring when `thinking`; list `ul.working-ring-feed` with ✓/✗ entries and relative time.
- Pulses: `motion` circle from centre to the station for action events that arrive after the card mounted (record the event ids present at mount; never pulse those). None when `useReducedMotion()`.

- [ ] **Step 1: Failing browser check** in `tests/browser/chat.ts`, inside the existing "fresh-trigger" working-row section (before `agent.turn.completed`):
  - emit `tool.started{tool:'shell_run',args:{cmd:'echo synthetic-secret-arg'}}`, `tool.executed{tool:'shell_run',output:'synthetic-secret-output'}`, and one `appChange('Create sticky note item','ok',…)`; reload;
  - hover `.working-row[data-agent=Demo]` → `.working-ring` visible, contains `Shell`, `Miro`, `Shell · ran a command`, `Miro · Create sticky note item`, `2 actions`;
  - `.working-ring` text contains neither `synthetic-secret-arg` nor `synthetic-secret-output`;
  - right after the reload, `.working-ring .ring-pulse` count is 0 (no burst for old events);
  - Escape closes it; focusing the row with the keyboard (`row.focus()`) opens it;
  - screenshots `working-ring-desktop.png` (light) and `working-ring-dark.png` (set `localStorage['nest-theme']='dark'` and reload, as `tests/browser/chat-next/composer-look.ts` does — `colorScheme` alone does not switch Nest's theme).
- [ ] **Step 2: Run** `timeout 450 node --import tsx tests/browser/chat.ts` — Expected: FAIL waiting for `.working-ring`.
- [ ] **Step 3: Implement** `WorkingRing`, the hover card in `WorkingRow`, and pass `snapshot.events` from `ChatThread`. Update the SPEC working-row item (hover/focus card, contents, reduced motion, no touch yet).
- [ ] **Step 4: Run** the browser suite and `npx vitest run apps/user-ui` and `npx tsc -p apps/user-ui --noEmit` — Expected: PASS; view both screenshots.
- [ ] **Step 5: Commit** `feat(chat): live working ring on hover`.

### Task 4: Owner check

- [ ] **Step 1:** `npm run lint`, `npm test`; record results (known: renewal, orgops-upgrade, 7 agent-management failures from the engine checkout).
- [ ] **Step 2:** Ask the owner to restart `npm run dev:all` (skill 1.4.0 reaches the runtime copy) and hover NikiPA's working row during a Miro task. Expected: stations for Shell and Miro appear, reads show as "Miro · Get board"-style entries, finished replies' lines unchanged.
