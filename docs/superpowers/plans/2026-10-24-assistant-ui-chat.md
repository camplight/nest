# Chat on assistant-ui Implementation Plan

> **For agentic workers:** this plan is the input of an Orca relay run (`orca-software-factory-relay:prepare`, coding profile) together with its spec. Each task is one ledger row: ID, dependencies, verify level, owned files, its test files and acceptance clauses are given so `prepare` can turn them into rows and briefs directly. Code shown is an interface or a seam pointer, never text to paste. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Rebuild the Nest user UI chat area (message list and composer) on assistant-ui with full parity and the new features in the spec.

**Architecture:** Nest keeps owning chat data: a pure converter turns engine events into timeline items, a framework-free core plus a hook own loading, paging, dedup and realtime merge, and assistant-ui's `useExternalStoreRuntime` renders the list through copied, Nest-themed styled components. The composer stays Nest's own component with assistant-ui's look. A switch keeps the classic chat available until the new one passes every existing browser test, then the classic code and the switch are removed.

**Tech Stack:** React 18.3, TypeScript, Vite 8, `@assistant-ui/react` 0.15.31, `@assistant-ui/react-markdown` 0.14.24, `@assistant-ui/react-syntax-highlighter` 0.14.7, Tailwind CSS v4 via `@tailwindcss/vite` (user UI only), vitest, Playwright scripts, npm workspaces.

**Spec:** `docs/superpowers/specs/2026-10-24-assistant-ui-chat-design.md`. Read it first; "spec 6.9" means its section 6 item 9.

**Base and integration branch:** `feat/assistant-ui-chat`, stacked on `feat/claude-code-wrapped-runtime` (PR #55, not yet merged into `main`). Set `INTEGRATION_BRANCH=feat/assistant-ui-chat` in the relay. Do not rebase the integration branch while the run is live; rebasing onto an updated #55 (or onto `main` after #55 merges, with `git rebase --onto origin/main feat/claude-code-wrapped-runtime feat/assistant-ui-chat` if it was squash-merged) happens between runs. Check before launch: `tests/browser/claude-code-progress.mjs` and `tests/browser/claude-code-agent.mjs` exist on the base; if they are missing at dispatch, a row stops with `blocked: base-missing`.

## Relay setup notes (for `prepare`)

- Seed adapter for every row worktree: `git submodule update --init vendor/orgops && npm ci`. Re-run `npm ci` after a rebase that changes `package-lock.json` (Task 1 does).
- Browser suites use fixed `--strictPort` ports. Give browser-running rows one lane (`LANES` covers the browser layer) so two suites never run at once.
- Every new browser test is written through `runChatTest` from the Task 1 harness (`tests/browser/support/chat-harness.ts`), which turns a Playwright `TimeoutError` or an `AssertionError` into a printed `RELAY-ASSERT <message>` line and exit code 1, so the red-then-green gate sees a red by assertion. Each test's first statement after setup must be an assertion that fails on the tests commit.
- Classic suites are run against the new chat with `VITE_NEST_CHAT_UI=next` in the environment (the suites spawn Vite, which inherits it). Before Task 17 that run is informational; from Task 17 on it gates.
- `TEST_GLOBS` must include `tests/browser/chat-next/**` and `apps/**/src/**/*.test.ts`. The harness lives in `tests/browser/support/`, outside `TEST_GLOBS`, so it is ordinary code rather than a frozen test.
- Rows marked `redgreen:control` (Task 10, Task 17's classic-suite targets) are regression guards: their tests pass on the base and must keep passing.

## Global Constraints

- `vendor/orgops` is never edited. npm only. Dependencies go through the parent `package-lock.json` and only Task 1 edits package manifests or the lockfile.
- Exact versions: `@assistant-ui/react@0.15.31`, `@assistant-ui/react-markdown@0.14.24`, `@assistant-ui/react-syntax-highlighter@0.14.7`; `tailwindcss`, `@tailwindcss/vite`, `@tailwindcss/node` on one exact 4.x version.
- Every `unstable_` or experimental assistant-ui import lives only in `apps/user-ui/src/chat/aui.ts`.
- The chat store is the source of truth. `isRunning` is always `false`. No `onEdit`, `onReload`, `onCancel`, `setMessages`. Never import `useExternalMessageConverter`.
- Nothing outside the chat may change look or motion (spec 5.5, 8.6).
- Selectors and texts existing tests use stay valid in the new chat: textbox `Message`, button `Send` (also after a failed send; there is no "Retry send" in the chat composer), `#message-<eventId>`, `.message-highlight`, `.message-agent`, `.message-human`, `.message-human-avatar`, `.message-agent .agent-portrait img`, `.message-attachments a`, link `Open <file name>`, `img` named by file name (one per preview), `.trace-group` (an `article` named `Agent activity` with no visible text), `.trace-chip`, `.trace-detail-card`, `.trace-progress` (progress text only, no ARIA role), `.composer`, `.composer-attachments article` with text `Ready`, `.composer-attachment-remove` named `Remove <file name>`, `.messages-panel`, `.chat-file-drop`, listbox `Mention people and agents` inside `.mention-popup`, texts `Draft saved on this device`, `Drop files to attach`, `New messages below`, `Load previous messages`, `Loading messages...`, `No messages yet`. Each class appears on exactly one element per message.
- Product schema changes go in `packages/schemas` and stay in sync with `apps/api`.
- No credentials anywhere. Test data is synthetic and labelled so in screenshots.
- Conventional commits; one commit series per task branch.
- Commands: unit `npm test`; lint `npm run lint`; build `npm run build` (builds admin-ui and user-ui); engine `npm run test:engine`; classic browser suites `npm run test:ui:chat`, `npm run test:ui:projects`, `npm run test:ui:images`, `npm run test:ui:onboarding`, `npm run test:ui:agents`, `node --import tsx tests/browser/targeted-mentions.ts`, `node tests/browser/mentions.mjs`, `node tests/browser/claude-code-progress.mjs`, `node tests/browser/claude-code-agent.mjs`; new chat suite `npm run test:ui:chat-next [-- <file filter>]`.

## Review Focus

Inputs the spec implies but no feature test would naturally hit, each pinned by a test in the named task.

1. The same event id arriving twice (status republish, reconnect replay, REST page overlapping realtime): shown once with the newest payload, counted once for unread and `nest-message`. Tasks 2, 5, 7.
2. A long agent turn whose start event is no longer in the loaded page, and a turn whose completion never arrives: the first still shows its row with progress after reload; the second ends when the agent starts a new turn or is stopped. Task 4, Task 9.
3. A very long unbroken string, a 12 column table and a 300 character code line at 390 pixel width: no horizontal page scroll. Task 7.
4. Switching channels while a page load, an upload or a send is in flight: nothing from the previous channel appears, the late upload lands in the original channel's draft, and a late send response never clears the new channel's draft. Tasks 5, 7, 10 (late uploads are already guarded by `chat.ts`).
5. A deep link or reply link to a message far outside the loaded page, then scrolling up: no messages between the target and the loaded window are skipped. Tasks 3, 5, 7.

---

## File Structure

New chat code lives in `apps/user-ui/src/chat/`:

| File | Responsibility | Task |
|---|---|---|
| `chat.css` | Tailwind v4 entry, scoped reset, theme aliases, dark variant, motion rule | 1 |
| `aui.ts` | Only importer of assistant-ui unstable or experimental APIs; re-exports the stable ones used | 1 |
| `ui/*` | Copied and adapted registry components (`*.radix.tsx` variants), `lib/utils.ts`, `hooks/use-copy-to-clipboard.ts`, `README.md` | 6 |
| `ui/KitPreview.tsx` | Dev-only preview at `?preview=chat-kit` | 6, removed in 18 |
| `timeline.ts` | Pure: events to timeline items, stable ids, continuation, day keys, item to `ThreadMessageLike` | 2 |
| `history.ts` | Query set, per-type cursors, page fetch | 3 |
| `working.ts` | Pure: active turns | 4 |
| `channel-events.ts` | Framework-free store core: load, page, dedup, ingest, focus, detached events | 5 |
| `useChannelEvents.ts` | React hook over the core | 5 |
| `format.ts` | `formatTime` moved from `App.tsx` | 5 |
| `switch.ts` | Classic or next selection | 7, removed in 18 |
| `ChatThread.tsx` | Runtime provider, viewport, scroll, message shell | 7, 9 |
| `quote-types.ts` | `ReplyTarget` type | 7 |
| `MessageBody.tsx` | Renders a message's parts through slot components | 7 |
| `attachments-view.tsx` | Slot: message attachments (stub in 7, zoom in 13) | 7, 13 |
| `MessageActions.tsx` | Slot: action bar (stub in 7, filled in 14) | 7, 14 |
| `WorkingRow.tsx` | Slot: working row (stub in 7, filled in 9) | 7, 9 |
| `ReplyLink.tsx`, `SelectionQuote.tsx` | Slots: reply link and selection quote (stubs in 7, filled in 16) | 7, 16 |
| `ExportButton.tsx` | Slot: export button (stub in 7, filled in 14) | 7, 14 |
| `ChatComposer.tsx` | Composer moved out of `App.tsx`, then restyled | 10, 11, 12, 16 |
| `triggers.ts`, `commands.ts` | Trigger detection and slash commands | 12 |
| `export.ts` | Markdown export | 14 |
| `quote.ts` | Quote text and reply target | 16 |

Slot files are created by Task 7 as working stubs so that Tasks 9, 13, 14 and 16 each edit only their own file. `ChatThread.tsx` itself is edited after Task 7 only by Task 9 (and Task 17 for parity fixes). `App.tsx` is edited by Tasks 5, 7, 10, 9, 17 and 18, which form a chain. Task 8 was folded into Task 7. `ChatComposer.tsx` is edited by Tasks 10, 11, 12, 16, which form a chain.

## Dependencies

| Task | Depends on |
|---|---|
| T1 Toolchain, deps, harness | none |
| T2 Timeline | T1 (for the `ThreadMessageLike` type) |
| T4 Active turns | none |
| T15 Reply target API | none |
| T3 History | T2 |
| T5 Events core and hook | T2, T3 |
| T6 UI kit | T1 |
| T7 Thread behind switch | T1, T2, T5, T6 |
| T10 Composer move | T7 |
| T9 Working row | T4, T7, T10 |
| T11 Composer look and uploads | T6, T10 |
| T12 Picker and slash commands | T11 |
| T13 Attachments zoom | T7 |
| T14 Actions and export | T7 |
| T16 Quote-reply UI | T12, T14, T15 |
| T17 Parity and default | T9, T12, T13, T16 |
| T18 Remove classic, docs | T17 |

---

### Task 1: Toolchain, dependencies and browser harness

**ID:** T1 · **Deps:** none · **Verify:** fresh (shared build and test interface)

**Files:**
- Modify: `apps/user-ui/package.json`, `apps/user-ui/vite.config.ts`, `package.json` (script `test:ui:chat-next`: `node --import tsx tests/browser/support/chat-next-run.ts`; an `overrides` entry for `lightningcss`), `package-lock.json`
- Create: `apps/user-ui/src/chat/chat.css`, `apps/user-ui/src/chat/aui.ts`, `tests/browser/support/chat-harness.ts`, `tests/browser/support/chat-next-run.ts`, `tests/browser/support/chat-harness-selftest.ts`
- Test: `apps/user-ui/src/chat/tailwind-scope.test.ts`

**Interfaces:**
- Produces, in `tests/browser/support/chat-harness.ts`:
  ```ts
  export type ChatHarness = {
    page: Page; context: BrowserContext; base: string; apiUrl: string; cookie: string;
    engineDb: import('better-sqlite3').Database; // the engine database, for fixtures
    project: { id: string; channelId: string };
    post(path: string, body: unknown, headers?: Record<string, string>): Promise<Response>;
    emit(type: string, payload: unknown, opts?: { source?: string; channelId?: string; parentEventId?: string }): Promise<{ id: string }>;
    upload(name: string, bytes: Uint8Array, mime: string): Promise<{ fileId: string }>;
    loginAs(username: string): Promise<{ page: Page }>; // creates a synthetic human if needed, with a usable password
    holdNext(path: string): { started: Promise<void>; release(): void }; // holds the next matching request server-side, after the body is received
    closeWebSocket(): Promise<void>; reopenWebSocket(): Promise<void>;
    screenshot(name: string): Promise<string>;
  };
  export function runChatTest(name: string, fn: (h: ChatHarness) => Promise<void>, options?: {
    viewport?: { width: number; height: number }; chatUi?: 'next' | 'classic'; colorScheme?: 'light' | 'dark';
    reducedMotion?: 'reduce'; connections?: unknown /* a ConnectionProvider, as projects.ts builds it */ }): Promise<void>;
  // chatUi also accepts 'unset': no localStorage value is set, so the build-time variable and the default decide (used by Task 17).
  ```
  Model the harness on `tests/browser/codex-progress.mjs` (serves the engine and the product API with `@hono/node-server`, attaches the engine WebSocket, injects `__NEST_USER_UI_CONFIG__.wsBaseUrl`), not on `chat.ts` (which closes `/ws`). It selects the chat with `context.addInitScript` setting `localStorage['nest:chat-ui']` to `chatUi` (default `next`), so every navigation keeps it; until Task 7 adds the switch the value is simply unused. `runChatTest` converts a Playwright `TimeoutError` or `AssertionError` into a printed `RELAY-ASSERT <message>` line and exit code 1. `chat-next-run.ts` runs every `*.ts` file in `tests/browser/chat-next/`, sequentially, one process each, exits non-zero if any fails, and accepts a file-name filter argument.

- [ ] **Step 1: Write the failing tests.**
  - `tailwind-scope.test.ts`, compiling `chat.css` with `@tailwindcss/node` (`compile` with `base` set to `apps/user-ui/src/chat`, then `build(candidates)`), candidates given by the test:
    - `it('marks utilities important')`: candidate `flex` yields `display: flex !important`.
    - `it('emits nothing unscoped except allowed output')`: with candidates `border shadow-sm font-bold ring-1 translate-y-1 animate-in fade-in-0`, every top-level rule is one of: a rule whose selector is a single generated utility class (one class, optionally with pseudo-classes or the `dark` variant), a rule whose declarations are all `--tw-*`, an `@property --tw-*`, an `@keyframes`, the `:root, :host` theme block, or a rule whose every selector contains `.nest-chat`, `.nest-chat-composer` or `.nest-chat-portal`. A rule `button { margin: 0 }` would fail it.
    - `it('maps theme colours to Nest tokens')`: candidate `bg-primary` compiles to a value referencing `var(--nest-forest)` (directly or through `--primary`); `text-muted-foreground` references `var(--nest-muted)`.
    - `it('binds dark mode to data-theme')`: candidate `dark:bg-card` produces a selector containing `[data-theme=dark]` and no `prefers-color-scheme`.
    - `it('orders the motion layer before utilities')`: the first layer order statement that names `nest-chat-motion` lists it before `utilities` (Tailwind may emit its own `@layer properties;` earlier, which is harmless because that layer holds no important declarations); inside layer `nest-chat-motion` there is a `prefers-reduced-motion: reduce` rule for `.nest-chat`, `.nest-chat-composer` and `.nest-chat-portal` (and descendants) setting `animation` and `transition` to `none !important`. (Important declarations in an earlier layer win over important declarations in later layers and over unlayered ones; the computed result is checked in Task 6.)
    - `it('collides with no class used outside the chat')`: `classCollisions(chatCandidates, outsideFiles)` reports `['flex']` for a fixture outside the chat containing `class="flex"`, and `[]` for the real tree (`apps/user-ui/src/**` outside `chat/`, `apps/nest-brand/**`) against the candidates found in `apps/user-ui/src/chat/**`.
    - `it('defines no theme variable Nest already uses')`: no `--*` name in the `:root, :host` block occurs in `apps/nest-brand/brand.css` or `apps/user-ui/src/**/*.css` outside `chat/`.
  - `chat-harness-selftest.ts` (support code, not a frozen test; run as a check in Step 4) via `runChatTest` with `chatUi:'classic'`: an `emit`ted message arrives over the WebSocket without reload within 3 seconds, `upload` returns a file id that `/api/files/<id>/meta` knows, and `loginAs('synthetic-second')` yields a page showing that username.
- [ ] **Step 2: Run** `npx vitest run apps/user-ui/src/chat/tailwind-scope.test.ts`. Expected: FAIL by assertion (the test reads `chat.css` through a helper that returns an empty stylesheet when the file is missing, so the failure is an assertion, not a read error).
- [ ] **Step 3: Implement.**
  - Install with `--save-exact` into `@nest/user-ui`: the three `@assistant-ui/*` packages, `tailwindcss`, `@tailwindcss/vite`, `lucide-react`, `cn`, `class-variance-authority`, `react-syntax-highlighter@16`, `tw-animate-css`; dev: `@tailwindcss/node`, `@types/react-syntax-highlighter`. Add `@tailwindcss/oxide-darwin-arm64`, `@tailwindcss/oxide-linux-x64-gnu`, `@tailwindcss/oxide-linux-arm64-gnu` as `optionalDependencies` next to the existing pins. Add a root `overrides` entry setting `lightningcss` to the version the user UI's existing `lightningcss-*` pins use (1.33.0), so `@tailwindcss/node`'s exact pin is aligned and one set of platform binaries serves both.
  - `vite.config.ts`: add the Tailwind Vite plugin.
  - `chat.css`: `@layer nest-chat-motion, theme, base, utilities;` first; then `@import "tailwindcss/theme.css" layer(theme); @import "tailwindcss/utilities.css" layer(utilities) important source(none); @source "./"; @import "tw-animate-css";`, `@custom-variant dark (&:where([data-theme=dark], [data-theme=dark] *));`, `@theme inline` aliases for the colour names listed in spec 8.6 pointing at `--nest-*` tokens, `@layer base` with the reset scoped to `:where(.nest-chat, .nest-chat-composer, .nest-chat-portal)`, and `@layer nest-chat-motion` with the reduced-motion rule.
  - `aui.ts`: re-export `useExternalStoreRuntime`, `AssistantRuntimeProvider`, `ThreadPrimitive`, `MessagePrimitive`, `ActionBarPrimitive`, `SelectionToolbarPrimitive`, `useAuiState` and the `ThreadMessageLike` type.
  - The three support files.
- [ ] **Step 4: Run** the vitest file, `node --import tsx tests/browser/support/chat-harness-selftest.ts`, `npm run build`, `npm run test:engine`, `npm run lint`, `npm test`, `npm ls lightningcss` (one version), the resolution check `node -e "console.log(require.resolve('tailwindcss/package.json',{paths:['apps/admin-ui']}))"` (3.4.x) and the same from `apps/user-ui` (4.x), `npm ls react --workspace @nest/user-ui` (18.3.x only), and `docker build --target build .` (required; if Docker is unavailable on the machine the row is `blocked: infra`, not passed).
- [ ] **Step 5: Commit** `build(user-ui): add assistant-ui, scoped Tailwind and the chat browser harness`.

**Acceptance:** the vitest clauses pass; the harness self-check passes on the classic chat; build, engine, lint, unit suites and the Docker build stage pass; one `lightningcss` version; admin-ui resolves Tailwind 3.4 and user-ui Tailwind 4; React stays 18.3.

---

### Task 2: Pure timeline conversion

**ID:** T2 · **Deps:** T1 · **Verify:** crit (shared interface every display depends on)

**Files:**
- Create: `apps/user-ui/src/chat/timeline.ts`
- Test: `apps/user-ui/src/chat/timeline.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type AuthorKind = 'human' | 'agent' | 'system' | 'activity';
  export type MessageAttachment = { fileId: string; name: string; mime?: string; size?: number };
  export type ChatMeta = { eventId: string; authorKind: AuthorKind; authorName: string; isMine: boolean;
    displayAt: number; targetAgents: string[]; inReplyTo?: string; detached?: boolean };
  export type TimelineItem =
    | { kind: 'message'; id: string; meta: ChatMeta; text: string; markdown: boolean; attachments: MessageAttachment[]; event: EventRow }
    | { kind: 'activity'; id: string; meta: ChatMeta; tone: 'agent' | 'system'; events: EventRow[] };
  export function isTraceEvent(event: EventRow): boolean;
  export function upsertEvents(current: EventRow[], incoming: EventRow[]): EventRow[];
  export function buildTimeline(events: EventRow[], opts: { currentUsername: string; detachedIds?: ReadonlySet<string> },
    previous?: readonly TimelineItem[]): TimelineItem[];
  export function isContinuation(prev: TimelineItem | undefined, item: TimelineItem): boolean;
  export function dayKey(ts: number): string;
  export function toThreadMessage(item: TimelineItem): ThreadMessageLike;
  ```

- [ ] **Step 1: Write the failing tests** (literal fixtures):
  - `human message becomes user role`: `{id:'e1', type:'message.created', source:'human:alek', payload:{text:'Hi'}, createdAt:1000}` with `currentUsername:'alek'` gives `{kind:'message', id:'e1', meta:{eventId:'e1', authorKind:'human', authorName:'alek', isMine:true, displayAt:1000, targetAgents:[]}}`; `toThreadMessage(...).role === 'user'`.
  - `agent, system and runner messages become assistant role`: sources `agent:Pip`, `system`, `system:runner:wrapper` give authorKind `agent`, `system`, `system`, each `role:'assistant'`, authorName `Pip`, `system`, `system:runner:wrapper`.
  - `trace events form one activity item`: `[msg e1, agent.turn.started t1, tool.started t2, msg e2]` gives ids `['e1','t1','e2']`, the activity holding `[t1,t2]` with tone `agent`; adding `tool.failed` sets tone `system`.
  - `activity id stays when the group grows`: rebuilding with `t3` appended after `t2`, passing the previous items, keeps id `t1`; rebuilding with an older trace event `t0` prepended to the same group, passing the previous items, still gives `t1`.
  - `unchanged items keep object identity`: rebuilding the same events with the previous items returns the same objects for unchanged items (`toBe`).
  - `agent.turn.failed is only an activity chip`.
  - `deliverAt wins for display time`; `targets` (`targetAgentName:'Pip'` gives `['Pip']`, `targetAgentNames:['A','B']` gives `['A','B']`); `inReplyTo` copied; `detachedIds` sets `meta.detached:true`.
  - `markdown flag`: `'plain words'` false, `'see https://x.test'` true, `'**bold**'` true.
  - `attachments` keep only entries with a non-empty `fileId`.
  - `upsertEvents replaces by id`: `PENDING` then `DELIVERED` for `e1` gives one `e1` with `DELIVERED`.
  - `toThreadMessage parts`: agent message with one attachment gives content `[{type:'text', text}, {type:'data-nest-attachments', data:[…]}]` and no `attachments`; activity gives `[{type:'data-nest-activity', data:{events, tone}}]`; `metadata.custom` deep-equals `meta`; `id` equals the item id; no `status` field on any message.
  - `isContinuation`: same human 4 minutes apart same day true; 6 minutes false; different authors false; an activity between them false; across midnight false.
- [ ] **Step 2: Run** `npx vitest run apps/user-ui/src/chat/timeline.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Port rules from `App.tsx` (`messageText`, `shouldRenderMarkdown`, `sourceLabel`, `messageRole`, `messageDisplayTime`, `mergeEventsChronologically`, `parseMessageAttachments`, `timelineItems`) rather than re-inventing them.
- [ ] **Step 4: Run** the tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat(chat): add pure event-to-timeline conversion`.

**Acceptance:** every clause passes; `timeline.ts` imports nothing from React or `App.tsx`; mutation evidence on `buildTimeline` and `toThreadMessage`.

---

### Task 3: History queries and per-type cursors

**ID:** T3 · **Deps:** T2 · **Verify:** fresh (focus: paging gaps)

**Files:**
- Create: `apps/user-ui/src/chat/history.ts`
- Test: `apps/user-ui/src/chat/history.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const CHAT_EVENT_QUERIES: ReadonlyArray<{ key: string; type?: string; typePrefix?: string }>; // 7 entries
  export type Cursors = Readonly<Record<string, number | null>>; // per query key: oldest createdAt in the contiguous window, null = exhausted
  export function chatQueryUrls(channelId: string, limit: number, cursors?: Cursors): Array<{ key: string; url: string }>;
  export async function fetchChannelPage(channelId: string, limit: number, cursors: Cursors | undefined,
    fetchJson: <T>(url: string) => Promise<T>): Promise<{ events: EventRow[]; cursors: Cursors; hasMore: boolean }>;
  export function adaptiveMessageBatchSize(connection?: { downlink?: number; effectiveType?: string; saveData?: boolean }): number;
  ```

- [ ] **Step 1: Write the failing tests:**
  - `seven queries`: `chatQueryUrls('c1',30)` gives 7 URLs with, in order, `type=message.created`, `type=agent.turn.failed`, `typePrefix=agent.turn.`, `typePrefix=tool.`, `type=telemetry.context.window.updated`, `typePrefix=wrapper.turn.`, `typePrefix=process.`, each with `channelId=c1&limit=30&order=desc`.
  - `per-type cursors`: with cursors `{messages:500, tools:200, …}` the message URL has `before=500` and the tool URL `before=200`; a query whose cursor is `null` is not requested.
  - `cursor after a page`: a full page (30 rows) of tool events whose oldest is at 120 sets `tools:120`; a short page sets `tools:null`; `hasMore` is true when any requested query was full.
  - `no gap`: given a fake server with 100 messages at times 1..100 and a first page of 30, then a detached event at time 10 merged by the caller, three older pages fetched with the returned cursors return every time from 1 to 70 exactly once (the detached event never moves a cursor because cursors come only from page results).
  - `adaptive batch size`: `{saveData:true}` 12, `{effectiveType:'2g'}` 10, `{effectiveType:'3g'}` 20, `{downlink:10}` 50, `{downlink:5}` 40, `{}` 30.
- [ ] **Step 2: Run** `npx vitest run apps/user-ui/src/chat/history.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**, merging with `upsertEvents`.
- [ ] **Step 4: Run** the tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat(chat): page channel history with per-type cursors`.

**Acceptance:** clauses pass; every page uses all 7 queries (spec 6.1).

---

### Task 4: Active agent turns

**ID:** T4 · **Deps:** none · **Verify:** fresh (focus: secrets, stale and start-less turns)

**Files:**
- Create: `apps/user-ui/src/chat/working.ts`
- Test: `apps/user-ui/src/chat/working.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type WorkingTurn = { agent: string; triggerEventId: string; since: number; progressText?: string; progressEventId?: string };
  export function activeTurns(events: EventRow[], agents: ReadonlyArray<{ name: string; desiredState?: string; updatedAt?: number }>): WorkingTurn[];
  ```

- [ ] **Step 1: Write the failing tests:**
  - `start makes a turn`: `agent.turn.started` from `agent:Pip`, payload `{triggerEventId:'m1'}`, `createdAt:1000` gives `[{agent:'Pip', triggerEventId:'m1', since:1000}]`.
  - `wrapper events attribute by targetAgentName`: `wrapper.turn.started` with source `system:runner:wrapper` and payload `{targetAgentName:'Pip', triggerEventId:'m1'}` gives a turn for `Pip`; together with an `agent.turn.started` for the same key it gives one turn, not two.
  - `progress without a loaded start makes a turn`: only an `agent.turn.phase` `{phase:'wrapped-progress', text:'Product checks passed.', triggerEventId:'m1'}` from `agent:Pip` gives a turn with that `progressText`.
  - `latest progress wins`; `codex-progress` works the same; other phases and whitespace-only text are ignored.
  - `endings`: `agent.turn.completed`, `agent.turn.failed`, `wrapper.turn.completed`, `wrapper.turn.failed` for the key end it; progress after completion for the same key never revives it.
  - `superseded`: a new `agent.turn.started` by `Pip` for `m2` removes Pip's turn for `m1`.
  - `stop requested after the turn began`: a turn with `since:1000` and `agents:[{name:'Pip', desiredState:'STOPPED', updatedAt:2000}]` gives no turn; `updatedAt:500` (stopped before the turn, the default for agents created without a desired state) keeps it; `desiredState:'RUNNING'` or missing keeps it. (`runtimeState` is deliberately ignored: agents without a live runner report `STOPPED`.)
  - `ordering`: two agents on `m1` give two turns ordered by `since`.
  - `reads only allowed fields`: an event whose payload also has `stderr:'SECRET'`, `args:{token:'SECRET'}` yields a turn whose serialised form does not contain `SECRET`.
- [ ] **Step 2: Run** `npx vitest run apps/user-ui/src/chat/working.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Reads only `type`, `source`, `createdAt`, `id` and payload fields `triggerEventId`, `targetAgentName`, `phase`, `text`.
- [ ] **Step 4: Run** the tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat(chat): compute active agent turns`.

**Acceptance:** clauses pass; mutation evidence on the ending and supersede rules.

---

### Task 5: Channel events core and hook

**ID:** T5 · **Deps:** T2, T3 · **Verify:** crit (moves live behaviour out of `App.tsx`)

**Files:**
- Create: `apps/user-ui/src/chat/channel-events.ts`, `apps/user-ui/src/chat/useChannelEvents.ts`, `apps/user-ui/src/chat/format.ts`
- Modify: `apps/user-ui/src/App.tsx`
- Test: `apps/user-ui/src/chat/channel-events.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type ChannelEventsSnapshot = { channelId: string | null; events: EventRow[]; detachedIds: ReadonlySet<string>;
    loading: boolean; loadingOlder: boolean; hasOlder: boolean; error: string | null };
  export type RefreshResult = { newTimeline: boolean; newestMessageAt: number };
  export function createChannelEventsCore(deps: { fetchJson: <T>(url: string) => Promise<T>; limit: () => number }): {
    switchTo(channelId: string | null): Promise<void>;
    refresh(): Promise<RefreshResult>;          // newest page merge; newTimeline when timeline events newer than before arrived
    loadOlder(): Promise<void>;                 // per-type cursors; sets error 'Unable to load previous messages' on failure
    focus(eventId: string): Promise<'loaded' | 'missing' | 'other-channel'>; // fetches /api/events/<id>, adds it detached if outside the window
    seen(eventId: string, status?: string): 'new' | 'update' | 'duplicate'; // 'new' for an unseen id, 'update' for a known id with a new status, else 'duplicate'
    lookup(eventId: string): Promise<EventRow | null>; // loaded event or GET /api/events/<id>; never changes the snapshot
    ingest(event: EventRow): { accepted: boolean };  // active-channel timeline events only; upserts by id
    snapshot(): ChannelEventsSnapshot; subscribe(listener: () => void): () => void;
  };
  export function useChannelEvents(core: ReturnType<typeof createChannelEventsCore>): ChannelEventsSnapshot;
  export function formatTime(value?: number): string; // moved verbatim from App.tsx
  ```
  `App.tsx` call sites to move onto the core (seams): `loadMessages` (initial load, poll, reconnect, project tab change, post-send reload when the WebSocket is down), `handleLoadOlderMessages`, the deep-link effect (`focusedMessage`, uses `focus` and shows "This mentioned message is no longer available." for `missing` and `other-channel`), `handleIncomingRealtimeEvent` (first `seen`: unread and `nest-message` logic as today only for `'new'`; `ingest` for the active channel for `'new'` and `'update'`), `markChannelSeen` and the `lastLoaded*` refs (fed from `RefreshResult` and ingest). The classic list keeps its scroll logic and renders from the snapshot. A status republish of a known id is passed to `ingest` (so the store holds the newest status) but counts once for unread and fires `nest-message` once.

- [ ] **Step 1: Write the failing tests** with a fake `fetchJson`:
  - `switch loads first page` with the 7 URLs and merged chronological events.
  - `late response from the previous channel is dropped`: held `c1`, then `c2` resolves, then `c1` releases: snapshot `channelId:'c2'`, no `c1` events.
  - `seen classifies`: `seen('e1','PENDING')` gives `'new'`, again `'duplicate'`, `seen('e1','DELIVERED')` gives `'update'`, again `'duplicate'`.
  - `lookup does not mutate`: `lookup` of an id outside the window returns the fetched event and the snapshot is unchanged (same object).
  - `ingest upserts`: two ingests of `e1` with different status leave one `e1` with the newer status.
  - `ingest rejects other channels and non-timeline types`.
  - `refresh reports new timeline events`: after a first page, a refresh returning a newer `tool.started` gives `newTimeline:true`; an identical refresh gives `false`.
  - `focus outside the window adds a detached event` and `loadOlder` afterwards still requests `before=<window cursor>`, not the detached time; once paging reaches it, `detachedIds` no longer contains it.
  - `focus in another channel returns 'other-channel'`; a 404 returns `'missing'`.
  - `loadOlder failure sets the error text`.
- [ ] **Step 2: Run** `npx vitest run apps/user-ui/src/chat/channel-events.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the core, the hook and the `App.tsx` move. Delete moved functions from `App.tsx`.
- [ ] **Step 4: Run** the tests and every classic browser suite in Global Constraints. Expected: PASS with no test file modified.
- [ ] **Step 5: Commit** `refactor(chat): move channel event loading into a store core`.

**Acceptance:** clauses pass; classic suites pass unmodified; `App.tsx` no longer defines `loadMessages`, `handleLoadOlderMessages`, `mergeEventsChronologically` or `rememberWsEvent`.

---

### Task 6: Copied and themed UI kit

**ID:** T6 · **Deps:** T1 · **Verify:** light

**Files:**
- Create: `apps/user-ui/src/chat/ui/` containing adapted copies from the assistant-ui repo at tag `@assistant-ui/react@0.15.31`, path `packages/ui/src/components/react/`: `assistant-ui/elements/syntax-highlighter.tsx`, `tooltip-icon-button.tsx`, `day-separator.tsx` (with its `surfaces.tsx` helper), the shell parts of `thread.aui.tsx` needed for the viewport and scroll-to-bottom only, `ui/radix/button.tsx`, `ui/radix/tooltip.tsx`, `ui/radix/dialog.tsx`, `lib/utils.ts`, `hooks/use-copy-to-clipboard.ts`. Each copied file starts with a comment naming its source path and tag. Radix portals target a `.nest-chat-portal` container.
- Create: `apps/user-ui/src/chat/ui/MarkdownText.tsx`, `apps/user-ui/src/chat/ui/ImageZoom.tsx`, `apps/user-ui/src/chat/ui/KitPreview.tsx`, `apps/user-ui/src/chat/ui/README.md`
- Modify: `apps/user-ui/src/main.tsx` (render `KitPreview` for `?preview=chat-kit` when `import.meta.env.DEV`)
- Test: `tests/browser/chat-next/ui-kit.ts`

**Interfaces:**
- Produces:
  - `MarkdownText(props: { text: string }): JSX.Element`: built on `react-markdown` with `remark-gfm` (already dependencies), not on `MarkdownTextPrimitive` (which needs a message-part context). Code blocks use the copied syntax highlighter with a header that has a button named `Copy code`. Links get `target="_blank" rel="noreferrer"`. Tables scroll inside their own wrapper.
  - `ImageZoom(props: { src: string; alt: string; open: boolean; onOpenChange(open: boolean): void }): JSX.Element`: a Radix dialog named by `alt` showing the image and a link `Open original` to `src`. Written fresh, not copied from the 681-line registry `image.tsx`.
  - `DaySeparator(props: { label: string })`, `TooltipIconButton`, `Button`.

- [ ] **Step 1: Write the failing test** `ui-kit.ts` (via `runChatTest`, page `?preview=chat-kit`): a fenced `ts` block renders a token span with a colour and a `Copy code` button that copies the code (grant clipboard permissions); a link has `target=_blank`; a 12 column table does not widen the page at 390 pixels; `ImageZoom` opens a dialog named after the alt text, contains `Open original`, closes on Escape; with `colorScheme:'light'` and `data-theme="dark"` set on `html`, a `bg-card` surface computes to the dark `--nest-surface` value (dark mode follows `data-theme`, not the OS); with `reducedMotion:'reduce'` the dialog's computed `animation-name` is `none`.
- [ ] **Step 2: Run** `npm run test:ui:chat-next -- ui-kit`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the test and `npx vitest run apps/user-ui/src/chat/tailwind-scope.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(chat): add Nest-themed assistant-ui components`.

**Acceptance:** clauses pass; the scope test still passes; light and dark kit screenshots saved.

---

### Task 7: Thread behind the switch, with slots

**ID:** T7 · **Deps:** T1, T2, T5, T6 · **Verify:** crit (user-facing core)

**Files:**
- Create: `apps/user-ui/src/chat/switch.ts`, `apps/user-ui/src/chat/quote-types.ts`, `apps/user-ui/src/chat/ChatThread.tsx`, `apps/user-ui/src/chat/MessageBody.tsx`, and working stubs `attachments-view.tsx` (renders today's attachment list via `components/MessageAttachment`), `MessageActions.tsx` (renders nothing), `WorkingRow.tsx` (renders nothing), `ReplyLink.tsx` (renders nothing), `SelectionQuote.tsx` (renders nothing), `ExportButton.tsx` (renders nothing; mounted in the toolbar row above the viewport)
- Modify: `apps/user-ui/src/App.tsx` (render `ChatThread` instead of the classic `.messages-panel` and "New messages below" button when `chatUi() === 'next'`; realtime handling uses the core's `seen` result so unread counts and `nest-message` fire only for `'new'`)
- Test: `tests/browser/chat-next/thread.ts`, `tests/browser/chat-next/realtime.ts`

**Interfaces:**
- Consumes: the T5 core and hook, T2 functions, T6 components, `AgentActivity`, `AgentAvatar`, `demoArtifacts`, `formatTime`.
- Produces:
  ```ts
  // switch.ts
  export type ChatUi = 'classic' | 'next';
  export function chatUi(): ChatUi; // ?chatUi=, then localStorage 'nest:chat-ui', then import.meta.env.VITE_NEST_CHAT_UI, then 'classic'
  // ChatThread.tsx
  export function ChatThread(props: {
    snapshot: ChannelEventsSnapshot; core: ChannelEventsCore; currentUsername: string; agents: Agent[];
    focusedMessageId: string | null; isConversationEmpty: boolean;
    onPreviewDemo(path: string): void; onQuote(target: ReplyTarget, quotedText: string): void; footer?: React.ReactNode;
  }): JSX.Element;
  // slot props (stable from this task on)
  export function MessageAttachments(props: { attachments: MessageAttachment[] }): JSX.Element;
  export function MessageActions(props: { item: Extract<TimelineItem, { kind: 'message' }>; onQuote(): void }): JSX.Element | null;
  export function WorkingRow(props: { turn: WorkingTurn; agent?: Agent }): JSX.Element | null;
  export function ReplyLink(props: { inReplyTo: string; channelId: string; core: ChannelEventsCore }): JSX.Element | null; // resolves with core.lookup, never core.focus
  export function SelectionQuote(props: { onQuote(target: ReplyTarget, quotedText: string): void }): JSX.Element | null;
  export function ExportButton(props: { items: readonly TimelineItem[]; channelLabel: string }): JSX.Element | null;
  // quote-types.ts
  export type ReplyTarget = { eventId: string; author: string; excerpt: string };
  ```
  `ChatThread` also takes `channelLabel: string`. Structure: root `div.nest-chat` (not scrolling) containing a toolbar row (with `ExportButton`) and `div.messages-panel`, the only scroll container (the viewport), with `messages-panel-empty` when empty; the composer stays outside the root. `useExternalStoreRuntime({ messages: items, convertMessage: toThreadMessage, isRunning: false, onNew: () => Promise.reject(new Error('The Nest composer sends messages')), hasEarlier: snapshot.hasOlder, onLoadEarlier: () => core.loadOlder() })`, items from `buildTimeline(snapshot.events, …, previousItems)`. `ThreadPrimitive.Viewport` with `turnAnchor="bottom"` and `scrollToBottomOnInitialize={!focusedMessageId}`. Message shell (single element carrying the classes): `article#message-<eventId>.message.message-<human|agent|system>` with `data-message-id`, `tabIndex=-1` when focused, `message-highlight` when focused; avatar and name only when not a continuation (agent portrait via `AgentAvatar` inside `.agent-portrait`, human initials in `.message-human-avatar`, none for system); a small time on every message; "To @x" labels; `MessageBody` renders `MarkdownText` when `markdown` else a `<p>`, demo `Preview` buttons, `MessageAttachments`, `ReplyLink`, `MessageActions`. Activity items render a bare wrapper with `data-aui-quote-selectable="false"` containing only `AgentActivity` (with `formatTime`). `DaySeparator` before the first item of each `dayKey`. The "New messages below" button shows only when new content arrived while scrolled up; a separate unlabeled-text arrow button named `Scroll to latest` shows when far from the bottom with nothing new. Older history auto-loads near the top unless a deep-link focus is pending; the `Load previous messages` button stays while `hasOlder`. `footer` renders `ProjectConnections` in project chats (fed by the last 4 messages from the snapshot). Loading and empty states use the texts in Global Constraints. No `content-visibility` on messages.

- [ ] **Step 1: Write the failing test** `thread.ts` (via `runChatTest`, synthetic data):
  - the root `.nest-chat` exists (first assertion).
  - human and agent messages render with `.message-human` and `.message-agent`, exactly one element each per message; agent portrait image present; human initials present; a `system:runner:wrapper` message shows its label and no avatar.
  - two different agents posting back to back render two `.message-agent` articles.
  - 6 trace events between two messages render one `article` named `Agent activity` with exactly 6 `.trace-chip` of 22 by 22 pixels, no visible text; clicking a chip shows `.trace-detail-card` with the event type, clicking again hides it.
  - three messages from one agent within a minute show the name once and three times.
  - `**bold**` renders `strong`; `plain` renders `p`; a fenced code block shows `Copy code`.
  - two days (via `deliverAt`) give two day separators.
  - no buttons named `Edit`, `Regenerate`, `Reload`, `Stop` or `Cancel` exist in `.nest-chat`.
  - 80 messages: starts at the bottom; scrolling to the top auto-loads older messages and the previously first message stays within 4 pixels of its position; `Load previous messages` exists while more history remains.
  - scrolled up, an incoming message shows `New messages below`; clicking it scrolls to the bottom; at the bottom incoming messages keep it pinned; scrolled up with nothing new shows `Scroll to latest` and no `New messages below`.
  - `?message=<id>` for a message 60 messages back: it is in the viewport, focused and `.message-highlight` immediately and still fully in the viewport after 1 second; scrolling up from there loads every message between it and the window exactly once (count by id).
  - a deep link to a message in another channel shows `This mentioned message is no longer available.`
  - empty channel shows `No messages yet`; while the first page is held, `Loading messages...`.
  - a project chat run with the harness `connections` option set to the synthetic Trello provider used in `projects.ts` shows the `ProjectConnections` footer with `Connect Trello`.
  - `?chatUi=classic` still renders the classic list.
  - at 390 by 844, `document.documentElement.scrollWidth <= 390` with a message containing a 400 character unbroken string, a 12 column table and a 300 character code line.
- [ ] **Step 1b: Write the failing test** `realtime.ts` (its first assertion is `.nest-chat` present):
  - a message posted by a second synthetic human (`loginAs`) appears without reload within 3 seconds.
  - the same event re-published with a new status (emit it, then change its status through the engine route that republishes, `vendor/orgops/apps/api/src/routes/events.ts` near lines 1355 and 1387, called with the runner token) leaves exactly one `#message-<id>`; with that channel not open, it adds 1 to the unread badge, not 2.
  - switching to another channel and back while `/api/events` for the first is held (`holdNext`) never shows events from the other channel.
  - `closeWebSocket()`, emit a message, `reopenWebSocket()`: the message appears without reload.
- [ ] **Step 2: Run** `npm run test:ui:chat-next -- thread` and `-- realtime`. Expected: FAIL on the first assertion.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** both tests, `npm test`, and every classic suite (default classic). Also run the classic suites with `VITE_NEST_CHAT_UI=next` and record the failures in the row report (informational).
- [ ] **Step 5: Commit** `feat(chat): render the channel thread with assistant-ui behind a switch`.

**Acceptance:** clauses pass; classic suites pass unmodified on the classic default; mutation evidence on the author, continuation, highlight and new-content branches.

---

### Task 8: (folded into Task 7)

The realtime clauses are part of Task 7's second test file `realtime.ts`. Numbering is kept so references stay stable.

---

### Task 9: Working row

**ID:** T9 · **Deps:** T4, T7, T10 · **Verify:** fresh (changes what the progress suites observe)

**Files:**
- Modify: `apps/user-ui/src/types.ts` (`Agent` gains `updatedAt?: number`), `apps/user-ui/src/chat/WorkingRow.tsx`, `apps/user-ui/src/chat/ChatThread.tsx` (place rows: after the trigger message, else at the end; this is the only `ChatThread` change), `apps/user-ui/src/components/AgentActivity.tsx` (remove the `progressEvents` prop and its rendering), `apps/user-ui/src/App.tsx` (classic list: render `WorkingRow` after the matching message, replacing the removed progress line, so both lists behave alike)
- Test: `tests/browser/chat-next/working-row.ts`

**Interfaces:**
- `WorkingRow`: root `div.working-row` with `role="status"` and `data-aui-quote-selectable="false"`, the agent avatar and name, then either `p.trace-progress` (no role) with `turn.progressText`, or `p.working-row-placeholder` with `Working…`. Never has class `message` or `message-agent`.

- [ ] **Step 1: Write the failing test** `working-row.ts`:
  - after `agent.turn.started` for trigger `m1`, a `.working-row` naming the agent appears directly after `#message-m1`, and Send is enabled.
  - two `wrapped-progress` phases: exactly one `.trace-progress` with the second text; the first text appears 0 times; `.message-agent` count is 0; `getByRole('status').filter({hasText: <second text>})` resolves to exactly one element.
  - after `agent.turn.completed`: no `.working-row`, also after reload.
  - start-less: 70 progress phases emitted after the start (more than the largest page size of 50, so the start falls out of the first page), then reload: the row with the 70th text is present.
  - wrapper source: `wrapper.turn.started` with source `system:runner:wrapper` and `targetAgentName` shows the row for that agent; `wrapper.turn.completed` ends it.
  - superseded: a new `agent.turn.started` by the same agent for `m2` moves the row after `#message-m2`.
  - stop requested: the fixture agent is created the way `codex-progress.mjs` creates it (no desired state, so `STOPPED` by default) and its row still shows; then `POST /api/agents/<name>/stop` (sets `desiredState` to `STOPPED` and a newer `updatedAt`) and the next agents refresh (within 11 seconds) removes the row.
  - trigger outside the loaded page: the row is the last element of the list.
  - the number of `article.message` elements equals the number of `message.created` events loaded (no extra bubble).
  - the progress text never contains the synthetic secret seeded the way `codex-progress.mjs` seeds it.
- [ ] **Step 2: Run** `npm run test:ui:chat-next -- working-row`. Expected: FAIL.
- [ ] **Step 3: Implement.** The agents list comes from the existing 10 second agents refresh in `App.tsx`.
- [ ] **Step 4: Run** the test, `node tests/browser/codex-progress.mjs` and `node tests/browser/claude-code-progress.mjs` unmodified, on classic and with `VITE_NEST_CHAT_UI=next`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(chat): show a working row per active agent turn`.

**Acceptance:** clauses pass; both progress suites pass unmodified on both chats.

---

### Task 10: Composer out of App.tsx

**ID:** T10 · **Deps:** T7 · **Verify:** crit (send path and drafts)

**Files:**
- Create: `apps/user-ui/src/chat/ChatComposer.tsx`
- Modify: `apps/user-ui/src/App.tsx` (seams: `handleSubmit`, `handleComposerPaste`, `resizeComposerTextarea`, `uploadFiles`, `handlePickFiles`, the draft save effect, the draft restore part of the channel-switch effect, `sendRequestRef`, `useAttachments` wiring, `useMentionPicker` wiring, `draftRecipients`, the `composer` form JSX)
- Test: `tests/browser/chat-next/composer-parity.ts`

**Interfaces:**
- Produces:
  ```ts
  export type ChatComposerHandle = { insertText(text: string): void; enqueueFiles(files: File[]): void; setReplyTarget(target: ReplyTarget | null, quotedText?: string): void; focus(): void };
  export const ChatComposer: React.ForwardRefExoticComponent<{
    userId: string | null; channel: Channel | null; conversationName: string; isConversationEmpty: boolean; canPost: boolean;
    inProject: boolean; mentionCandidates: MentionCandidate[]; canInvite: boolean;
    onInvite(candidate: MentionCandidate): Promise<void>; onAskAssistant(name: string, brief: string): void;
    openInvite(): void; openFiles(): void;
    onStateChange(state: { sending: boolean }): void; onSent(): void; onError(message: string): void;
  } & React.RefAttributes<ChatComposerHandle>>;
  ```
  `ChatFileDrop` stays in `App.tsx` and calls `handle.enqueueFiles`, reading `sending` from `onStateChange` for its disabled reason. `DemoArtifact`'s "Request changes" calls `handle.insertText` and `handle.focus`. `App.tsx` wires `ChatThread`'s `onQuote` to `handle.setReplyTarget`; in this task `setReplyTarget` is accepted and ignored (Task 16 implements it). Behaviour is the classic one exactly (spec 6.8 to 6.12). Both chats render this component.

This row is a behaviour-preserving move, so its test is a regression guard: row note `redgreen:control` (the test must pass on the base, keep passing, and go red under the gate's sabotage run).

- [ ] **Step 1: Write the guard test** `composer-parity.ts` (on `chatUi=next`): the composer is a `.composer` form following `.nest-chat`; a send failing once with HTTP 503 keeps text, mentions and attachments, the button still reads `Send`, and the retry posts the same `id` (capture request bodies); editing the text after the failure produces a new `id`; a held send released after switching channels leaves the second channel's draft intact; `Draft saved on this device` appears after typing; IME composition with Enter does not send; while sending, the textarea and `Attach files` are disabled and Send reads `Sending...`; a file-only send posts text `Attached 1 file for reference.`; `Request changes` in the demo panel appends `\n\nPlease update <url>: ` and focuses the textbox.
- [ ] **Step 2: Run** `npm run test:ui:chat-next -- composer-parity` on the base. Expected: PASS (control).
- [ ] **Step 3: Implement** by moving code, not rewriting it.
- [ ] **Step 4: Run** the test and every classic suite (default classic). Expected: PASS with no classic test modified.
- [ ] **Step 5: Commit** `refactor(chat): move the composer into its own component`.

**Acceptance:** clauses pass; classic suites pass unmodified; `App.tsx` no longer defines `handleSubmit` or contains the composer form.

---

### Task 11: Composer look, thumbnails and upload progress

**ID:** T11 · **Deps:** T6, T10 · **Verify:** light

**Files:**
- Modify: `apps/user-ui/src/chat/ChatComposer.tsx` (markup and classes only), `apps/user-ui/src/styles.css` (plain CSS for the chip thumbnail and progress bar, because `components/` is outside Tailwind's source scope), `apps/user-ui/src/attachments.ts` (upload through `XMLHttpRequest` with `upload.onprogress`, keeping `apiUrl()`, `withCredentials = true` and the error-body parsing of `api.ts`), `apps/user-ui/src/components/ChatAttachments.tsx` (thumbnail and progress, keeping text `Ready` and `Remove <file name>`)
- Test: `tests/browser/chat-next/composer-look.ts`

**Interfaces:**
- `PendingAttachment` gains `progress?: number` (0 to 1). Image chips show an `img` thumbnail from an object URL revoked on removal and unmount. Uploading chips show `role="progressbar"` with `aria-valuenow` from 0 to 100. The textarea carries no Tailwind height, max-height, position or transform classes.

- [ ] **Step 1: Write the failing test** `composer-look.ts`: the composer is inside an element with class `nest-chat-composer` (first assertion) and keeps textbox `Message`, button `Send`; an image chip shows a thumbnail `img`; with the `/api/files` response held server-side (`holdNext`, after the body was received) the chip shows a progressbar whose `aria-valuenow` reaches 100 while the chip is still uploading, then `Ready` after release; a failed upload shows its error and `Remove <file name>`; 21 dropped files show the 20 file limit message; textarea height is 34 to 56 pixels in an empty chat and at least 56 in a non-empty one, and grows with 10 lines of text up to a third of the viewport; at 1440 by 1100 and 390 by 844 the Send button is fully inside the viewport; screenshots saved.
- [ ] **Step 2: Run** `npm run test:ui:chat-next -- composer-look`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the test, `npm run test:ui:chat`, `npm run test:ui:images`, `npm run test:ui:projects` (covers `ProjectStart` uploads). Expected: PASS.
- [ ] **Step 5: Commit** `feat(chat): composer look with thumbnails and upload progress`.

**Acceptance:** clauses pass; the three classic suites pass unmodified.

---

### Task 12: One picker for `@` and `/`

**ID:** T12 · **Deps:** T11 · **Verify:** fresh (mention behaviour is a parity hot spot)

**Files:**
- Create: `apps/user-ui/src/chat/triggers.ts`, `apps/user-ui/src/chat/commands.ts`
- Modify: `apps/user-ui/src/mentions.ts` (`findMention` delegates to `findTrigger`; exports unchanged), `apps/user-ui/src/components/useMentionPicker.tsx` (generalised to triggers; new option `variant: 'chat' | 'default'`, default `'default'` keeps today's look for `ProjectStart`), `apps/user-ui/src/chat/ChatComposer.tsx`
- Test: `apps/user-ui/src/chat/triggers.test.ts`, `tests/browser/chat-next/slash-commands.ts`

**Interfaces:**
- Produces:
  ```ts
  export type TriggerQuery = { trigger: '@' | '/'; start: number; end: number; query: string };
  export function findTrigger(value: string, caret: number, selectionEnd?: number): TriggerQuery | null;
  export type CommandContext = { canInvite: boolean; inProject: boolean; openInvite(): void; openFiles(): void };
  export type SlashCommand = { name: 'invite' | 'files'; label: string; available(ctx: CommandContext): boolean; run(ctx: CommandContext): void };
  export const SLASH_COMMANDS: readonly SlashCommand[];
  ```

- [ ] **Step 1: Write the failing tests.** Unit: `'@pi'` caret 3 gives `{trigger:'@', start:0, end:3, query:'pi'}`; `'/inv'` caret 4 gives `{trigger:'/', start:0, end:4, query:'inv'}`; `'hello\n/fi'` gives a `/` trigger at 6; `'a /inv'` gives `null`; `'mail me@x'` gives `null`; inside a code fence `null`; every existing `mentions.test.ts` case still passes. Browser:
  - in a project chat owned by the user, typing `/` lists `invite` and `files`; choosing `files` opens the Files tab; choosing `invite` opens the existing invite picker.
  - in a standalone channel the user manages, `/` lists only `invite`.
  - as a second synthetic human (`loginAs`) who can post in a project chat but cannot invite, `/` lists only `files`; in a standalone channel without invite rights it shows `No commands available`.
  - typing `/usr/bin/env` then Enter sends the message (the list closed on no match).
  - choosing another person's shared personal agent from `@` opens the direct chat with that agent and seeds the brief only when that chat's draft is empty.
  - the `@` listbox is still named `Mention people and agents`, the `/` listbox `Commands`.
- [ ] **Step 2: Run** `npx vitest run apps/user-ui/src/chat/triggers.test.ts` and `npm run test:ui:chat-next -- slash-commands`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests, `npx vitest run apps/user-ui/src/mentions.test.ts`, `node tests/browser/mentions.mjs`, `node --import tsx tests/browser/targeted-mentions.ts`, `npm run test:ui:projects`. Expected: PASS, those suites unmodified.
- [ ] **Step 5: Commit** `feat(chat): add slash commands to the composer picker`.

**Acceptance:** clauses pass; mention suites and `projects.ts` pass unmodified; `ProjectStart`'s picker looks unchanged (screenshot compared with the base).

---

### Task 13: Attachments with zoom

**ID:** T13 · **Deps:** T7 · **Verify:** fresh (focus: SVG and link handling)

**Files:**
- Modify: `apps/user-ui/src/chat/attachments-view.tsx`
- Test: `tests/browser/chat-next/attachments.ts`

**Interfaces:**
- `MessageAttachments`: root `div.message-attachments` with `ul`, one `li.message-attachment` per file containing, for preview types (`image/png`, `image/jpeg`, `image/gif`, `image/webp`), an `a` named `Open <file name>` with `href=/api/files/<id>` and `target=_blank` wrapping one `img` named by the file name, whose plain left click (no modifier) opens `ImageZoom` and is otherwise a normal link; then a link named exactly the file name; then mime and size; the fallback text on image error.

- [ ] **Step 1: Write the failing test** `attachments.ts`: an agent message with an uploaded png shows the link `Open <name>` with the file URL (first assertion, fails on the stub because the click opens no dialog: assert a dialog appears on plain click); the dialog has `Open original` and closes on Escape; a ctrl or meta click opens a new page and no dialog; exactly one `img` named by the file name is on the page while the dialog is closed; an SVG attachment shows only a link and no `img`; a missing file id shows `Preview unavailable. Open the file using the link above.`; a human message with attachments renders the same way; the text link's name equals the file name.
- [ ] **Step 2: Run** `npm run test:ui:chat-next -- attachments`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the test and `npm run test:ui:images` with `VITE_NEST_CHAT_UI=next`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(chat): open image attachments in a zoom view`.

**Acceptance:** clauses pass; `image-attachments.ts` passes unmodified on the new chat.

---

### Task 14: Message actions and export

**ID:** T14 · **Deps:** T7 · **Verify:** fresh (focus: what can leave the page)

**Files:**
- Modify: `apps/user-ui/src/chat/MessageActions.tsx`
- Create: `apps/user-ui/src/chat/export.ts`
- Modify: `apps/user-ui/src/chat/ExportButton.tsx` (the Task 7 stub, already mounted inside `.nest-chat`)
- Test: `apps/user-ui/src/chat/export.test.ts`, `tests/browser/chat-next/actions.ts`

**Interfaces:**
- Produces:
  ```ts
  export function chatToMarkdown(items: readonly TimelineItem[], opts: { channelLabel: string; timeZone?: string }): string;
  export function messageLink(eventId: string, href: string): string;
  ```
  `MessageActions` renders, for message items only, buttons `Copy message`, `Copy link` and `Quote`, hidden with `display: none` until hover, keyboard focus within the message, or a tap on the message on touch devices (explicit toggle, since assistant-ui's hover state is mouse only).

- [ ] **Step 1: Write the failing tests.** Unit: two messages and one activity item export as a `# <channelLabel>` heading, then for each message `**<author>** · <time>` and its text; the activity item as `_Agent activity: 3 events_` and no event payload text (fixture payload contains `stderr:'SECRET'`; output does not contain `SECRET`); attachments as `[name](/api/files/<id>)`. `messageLink('e1','https://h/?view=projects&project=p&message=old')` returns `https://h/?view=projects&project=p&message=e1`. Browser: hovering a message shows the three buttons; `Copy message` puts the raw text on the clipboard; `Copy link` yields a URL that highlights that message when opened; `Export chat` (inside `.nest-chat`) downloads a `.md` containing both message texts; hovering an activity group shows no actions; at 390 pixels a tap on a message shows the actions and a second tap hides them; `chat.ts`'s `scrollWidth <= clientWidth` check holds with actions present.
- [ ] **Step 2: Run** `npx vitest run apps/user-ui/src/chat/export.test.ts` and `npm run test:ui:chat-next -- actions`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests and `node --import tsx tests/browser/dashboard.ts` with `VITE_NEST_CHAT_UI=next` (its workspace controls count must not change). Expected: PASS.
- [ ] **Step 5: Commit** `feat(chat): add message actions and Markdown export`.

**Acceptance:** clauses pass.

---

### Task 15: Reply target in the send API

**ID:** T15 · **Deps:** none · **Verify:** crit (product API and schema)

**Files:**
- Modify: `packages/schemas/src/messages.ts`, `apps/api/src/messages.ts`, `apps/user-ui/src/drafts.ts`
- Test: `apps/api/src/messages-reply.test.ts`, `apps/user-ui/src/drafts-reply.test.ts` (reuses the localStorage stub pattern of `drafts.test.ts`)

**Interfaces:**
- `SendMessageSchema.replyTo?: string` (1 to 200 chars). Payload `inReplyTo: <eventId>`; `parentEventId` never set by this path. Error body `{ error: string, code: "REPLY_TARGET_INVALID" }` with status 400. Draft schema `replyTo?: { eventId: string; author: string; excerpt: string }` with `excerpt` at most 500 characters.

- [ ] **Step 1: Write the failing tests:**
  - a send with `replyTo` equal to a `message.created` id in the same channel creates an event with `payload.inReplyTo` equal to it and no `parentEventId`.
  - `replyTo` pointing to another channel, to `agent.turn.started`, to a missing id, or into a channel the sender cannot view each return 400 with `code:"REPLY_TARGET_INVALID"`.
  - retrying the same request id and identical content after only the reply target's row was deleted from the engine database (`DELETE FROM events WHERE id=?` through the test's engine handle, as `messages.test.ts` has) still returns the recorded result, not 400 (validation runs only when no intent row exists).
  - same request id with a different `replyTo` returns 409.
  - drafts: `replyTo` round-trips; a 500 character excerpt is accepted; 501 fails and loading returns the empty draft.
- [ ] **Step 2: Run** `npx vitest run apps/api/src/messages-reply.test.ts apps/user-ui/src/drafts-reply.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**, including `replyTo` in the server's content comparison.
- [ ] **Step 4: Run** the tests and `npx vitest run apps/api/src/messages.test.ts apps/user-ui/src/drafts.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(messages): accept a reply target and record it as inReplyTo`.

**Acceptance:** clauses pass with the literal code `REPLY_TARGET_INVALID`; existing tests pass unmodified; mutation evidence on the validation and retry branches.

---

### Task 16: Quote-reply in the UI

**ID:** T16 · **Deps:** T12, T14, T15 · **Verify:** fresh (user path across composer, API and thread)

**Files:**
- Create: `apps/user-ui/src/chat/quote.ts`
- Modify: `apps/user-ui/src/chat/ReplyLink.tsx`, `apps/user-ui/src/chat/SelectionQuote.tsx`, `apps/user-ui/src/chat/ChatComposer.tsx` (reply chip, `replyTo` in send body, draft and client fingerprint), `apps/user-ui/src/chat/MessageActions.tsx` (wire `Quote`)
- Test: `apps/user-ui/src/chat/quote.test.ts`, `tests/browser/chat-next/quote-reply.ts`

**Interfaces:**
- Produces:
  ```ts
  export function quoteMarkdown(author: string, text: string): string; // '> **author** wrote:\n> line1\n> line2\n\n', text cut to 2000 chars
  export function replyExcerpt(text: string): string;                  // at most 500 chars including a trailing '…' when cut
  export function selectionQuote(selection: Selection | null, root: Element): { eventId: string; text: string } | null;
  ```
  `ChatThread` (Task 7) passes the raw message or selection text and a `ReplyTarget` whose `excerpt` is the raw text; `ChatComposer.setReplyTarget` (this task) applies `quoteMarkdown` and `replyExcerpt` before storing anything, so the draft never holds an excerpt over 500 characters.
  `selectionQuote` returns null when the selection is empty, spans two `[data-message-id]` elements, or lies inside an element with `data-aui-quote-selectable="false"`.

- [ ] **Step 1: Write the failing tests.** Unit: `quoteMarkdown('Pip','a\nb')` returns `'> **Pip** wrote:\n> a\n> b\n\n'`; `replyExcerpt` of 600 chars has length 500 and ends with `…`; of 10 chars returns them unchanged; `selectionQuote` cases for empty, two messages and activity. Browser: `Quote` on an agent message puts the blockquote at the top of the composer and shows `Replying to Pip`; sending shows a `Replying to Pip` link on the new message; clicking it highlights the original; selecting part of a message shows `Quote selection` that quotes only that part; selecting text in an activity detail card shows no `Quote selection`; `Cancel reply` removes chip and quote; reload keeps the chip; a failed send keeps the reply target, and cancelling the reply before retrying posts a new `id`; an agent message whose `inReplyTo` points into another channel shows no reply link.
- [ ] **Step 2: Run** `npx vitest run apps/user-ui/src/chat/quote.test.ts` and `npm run test:ui:chat-next -- quote-reply`. Expected: FAIL.
- [ ] **Step 3: Implement.** `SelectionQuote` is placed with `SelectionToolbarPrimitive.Root` (inside `ThreadPrimitive.Root`) and reads the selection itself.
- [ ] **Step 4: Run** the tests and `npm run test:ui:chat-next -- composer-parity`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(chat): quote-reply from messages and selections`.

**Acceptance:** clauses pass; one user path end to end: quote, send, see link, follow link.

---

### Task 17: Parity and default switch

**ID:** T17 · **Deps:** T9, T12, T13, T16 · **Verify:** crit (the parity bar)

**Files:**
- Modify: `apps/user-ui/src/chat/switch.ts` (default `next`); any file under `apps/user-ui/src/chat/`, `apps/user-ui/src/components/` and `apps/user-ui/src/App.tsx` needed for a parity fix (every upstream row is finished, so nothing runs in parallel); test files under `tests/browser/` only where a selector truly changed, each listed in the commit body with its reason
- Test: `tests/browser/chat-next/parity.ts`

- [ ] **Step 1: Write the failing test** `parity.ts`, run with harness option `chatUi:'unset'` and without `VITE_NEST_CHAT_UI`: a project chat has `.nest-chat`.
- [ ] **Step 2: Run** `npm run test:ui:chat-next -- parity`. Expected: FAIL.
- [ ] **Step 3: Implement** the default flip and fix every behaviour the classic suites expose on the new chat. Never weaken an assertion; a needed assertion change is `blocked: spec-conflict`.
- [ ] **Step 4: Run** `npm test`, `npm run lint`, `npm run build`, `npm run test:engine`, every classic suite in Global Constraints (now on the new chat by default), and `npm run test:ui:chat-next`. Expected: all PASS. The relay row carries the classic suites as `redgreen:control` targets.
- [ ] **Step 5: Commit** `feat(chat): make the assistant-ui chat the default`.

**Acceptance:** every suite passes on the new chat; changed test lines only swap selectors; screenshots at 1440 by 1000 and 390 by 844 of a project chat with messages, an activity group, a working row, attachments and the composer, light and dark, synthetic data labelled.

---

### Task 18: Remove the classic chat, update docs

**ID:** T18 · **Deps:** T17 · **Verify:** fresh (deletion and docs)

**Files:**
- Modify: `apps/user-ui/src/App.tsx` (remove the classic list JSX and now-unused helpers and state), `apps/user-ui/src/main.tsx` (remove the kit preview), `apps/user-ui/src/styles.css` (remove rules only the classic list used), `docs/SPEC.md` (chat section), `docs/SUBMODULE_MIGRATION.md` (engine `inReplyTo` use)
- Delete: `apps/user-ui/src/chat/switch.ts`, `apps/user-ui/src/chat/ui/KitPreview.tsx`
- Test: `tests/browser/chat-next/no-classic.ts`

- [ ] **Step 1: Write the failing test** `no-classic.ts`: `?chatUi=classic` renders `.nest-chat`; `git grep -nE "chatUi|VITE_NEST_CHAT_UI|preview=chat-kit" apps/user-ui/src` returns nothing; `git grep -nE "function (messageText|shouldRenderMarkdown|parseMessageAttachments)" apps/user-ui/src/App.tsx` returns nothing.
- [ ] **Step 2: Run** `npm run test:ui:chat-next -- no-classic`. Expected: FAIL.
- [ ] **Step 3: Implement** the removal and the doc updates (SPEC.md covers the working row, slash commands, quote-reply with `replyTo` and `inReplyTo`, export, message actions, the Tailwind scope and the assistant-ui dependency).
- [ ] **Step 4: Run** the full set from Task 17 Step 4. Expected: all PASS.
- [ ] **Step 5: Commit** `refactor(chat): remove the classic chat list`.

**Acceptance:** full set green; the greps return nothing; `docs/SPEC.md` names `replyTo`, the working row, slash commands and export.

---

## Final row (for the relay)

Runs the full set from Task 17 Step 4 on the integration branch; reports bundle size of `apps/user-ui` (`vite build` output, gzip) before and after against the base commit (the tip of `feat/claude-code-wrapped-runtime` the branch was cut from); captures the pull request screenshots (desktop and mobile, light and dark, synthetic data labelled); writes the pull request description (base `feat/claude-code-wrapped-runtime` while #55 is open, so the diff shows only the chat work) noting zod 4 and `assistant-cloud` arriving as transitive dependencies. It does not push.
