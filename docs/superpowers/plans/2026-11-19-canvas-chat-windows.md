# Canvas Chat Windows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In desktop floating mode, up to 4 chats open as live, draggable windows over a canvas that stays usable; one
message box follows the active window.

**Architecture:** A pure window-list module (`chat-windows.ts`) owns open/activate/close/cap/placement/persistence. Passive
windows render `ChatThread` from their own `ChannelEventsCore`, held in a ref-counted registry (`window-cores.ts`) that
`App.tsx` feeds from its existing realtime handler. The active window is today's `CanvasChat` sheet (App's single chat
session), re-skinned as a non-modal, screen-fixed, draggable window; it shows its own passive thread until App's core has
loaded that chat, so activation never blanks.

**Tech Stack:** React 18 + TypeScript, Vite, Vitest (`renderToStaticMarkup` render tests), npm workspaces.

**Spec:** `docs/superpowers/specs/2026-11-19-canvas-chat-windows-design.md` (read it; its "Calls made after the builder
check" section is binding).

## Global Constraints

- UI only, in `apps/user-ui`. No API, engine, DB or `vendor/orgops` change. npm, not pnpm.
- Phones (`usePhoneLayout()` true) keep today's behaviour exactly: one full-screen chat, canvas inert behind it.
- Split mode keeps today's behaviour exactly for the active chat.
- `MAX_WINDOWS = 4`; `WINDOW_WIDTH = 440`; `WINDOW_MIN_WIDTH = 320`; window max height = `SHEET_MAX_HEIGHT` (720) and
  never taller than the stage bounds; `CASCADE_STEP = 32`.
- Copy, verbatim: passive footer `Click to reply`; passive close button `aria-label="Close chat <title>"`.
- Functional factories + dependency injection; colocated tests; conventional commits; **no AI attribution lines** in
  commits. Never push; the branch stays local.
- Every `sessionStorage` read/write is wrapped in try/catch and the UI works without it.
- Verify with `npx tsc -p apps/user-ui --noEmit` and `npx vitest run apps/user-ui/src` (from the repo root). Do not run
  full builds or restart the running dev servers.

## Review Focus

1. **A windowed chat disappears** (archived, access removed, deleted) while open or before a reload: its window closes
   quietly; the rest stay. → Task 1 `pruneWindows` test; Task 4 wires it to the channel list.
2. **The browser window shrinks** after windows were placed or restored: every window is pulled back fully inside the
   stage. → Task 1 `clampWindow` test; Task 3 re-clamps on resize.
3. **Switching canvases**: each canvas restores only its own windows. → Task 1 storage-key test.
4. **Activating a window before App's core has loaded it** (or clicking two windows quickly): the window keeps showing
   its own live thread, never a blank/loading thread. → Task 4 `ActiveWindowBody` render test.
5. **Status republishes** (a turn event updated in place) reach passive windows, not just first sightings. → Task 2 test
   that `ingest` forwards an already-seen event id.

---

### Task 1: Window list logic

**Files:**
- Create: `apps/user-ui/src/canvas/chat-windows.ts`
- Test: `apps/user-ui/src/canvas/chat-windows.test.ts`

**Interfaces:**
- Consumes: `Bounds` from `./sheet` (`{left, top, right, bottom}`), `Point` from `./geometry`.
- Produces:
  ```ts
  export const MAX_WINDOWS = 4, WINDOW_WIDTH = 440, WINDOW_MIN_WIDTH = 320, CASCADE_STEP = 32;
  export type ChatWindow = {channelId: string; x: number; y: number};   // stage px, top-left
  export type WindowList = readonly ChatWindow[];                       // index 0 = front
  export function windowWidth(bounds: Bounds): number;                  // min(WINDOW_WIDTH, bounds width), >= WINDOW_MIN_WIDTH
  export function windowHeight(bounds: Bounds): number;                 // min(SHEET_MAX_HEIGHT, bounds height)
  export function placeWindow(card: {x: number; y: number; w: number} | null, front: ChatWindow | null, bounds: Bounds): Point;
  export function clampWindow(win: ChatWindow, bounds: Bounds): ChatWindow;
  export function openWindow(list: WindowList, channelId: string, at: Point, activeId: string | null): WindowList;
  export function bringToFront(list: WindowList, channelId: string): WindowList;
  export function closeWindow(list: WindowList, channelId: string): {list: WindowList; next: string | null};
  export function moveWindow(list: WindowList, channelId: string, at: Point, bounds: Bounds): WindowList;
  export function pruneWindows(list: WindowList, allowed: ReadonlySet<string>): WindowList;
  export function readWindows(canvasId: string): WindowList;            // sessionStorage `nest-canvas-windows:<canvasId>`
  export function writeWindows(canvasId: string, list: WindowList): void;
  ```

- [ ] **Step 1: Write the failing tests** in `chat-windows.test.ts` (`bounds = {left: 0, top: 0, right: 1600, bottom: 900}`):
  - `openWindow adds at the front`: `openWindow([], 'a', {x: 10, y: 20}, null)` → `[{channelId: 'a', x: 10, y: 20}]`.
  - `openWindow on an open chat brings it to the front without moving it`: list `[b@(0,0), a@(5,5)]`, open `'a'` at
    `(99,99)` → `[a@(5,5), b@(0,0)]`.
  - `openWindow caps at 4 by closing the back-most non-active window`: list front→back `[d, c, b, a]`, active `'a'`, open
    `'e'` → ids `['e', 'd', 'c', 'a']`.
  - `closeWindow returns the next front window`: `[a, b, c]` close `'a'` → `{list: [b, c], next: 'b'}`; close the only
    window → `{list: [], next: null}`.
  - `bringToFront` moves the window to index 0 and keeps the others' order.
  - `moveWindow clamps into the bounds`: move to `(-50, 2000)` → `x === 0`, `y === 900 - windowHeight(bounds)`.
  - `clampWindow pulls a window back after the stage shrinks`: `{x: 1500, y: 800}` in `{0,0,1000,600}` →
    `x === 1000 - windowWidth`, `y === 600 - windowHeight`.
  - `windowWidth` is 440 in wide bounds, 360 in a 360-wide stage, and 320 in a 200-wide stage.
  - `placeWindow` puts the window right of a visible card (`card {x:100,y:50,w:280}` → `x === 100 + 280 + 16`, `y === 50`);
    left of it when there is no room on the right; at `front + 32/32` when `card` is null and a front window exists; at
    the bounds' top-left plus 16/16 when both are null. Always clamped.
  - `pruneWindows` drops ids not in `allowed` and keeps order.
  - `readWindows/writeWindows round-trip per canvas`: write for `'cv1'`, read `'cv2'` → `[]`; read `'cv1'` → same list.
    Malformed JSON → `[]`; a stub `sessionStorage` that throws → `[]` and `writeWindows` does not throw. `readWindows`
    never returns more than `MAX_WINDOWS` or duplicate ids.

- [ ] **Step 2: Run** `npx vitest run apps/user-ui/src/canvas/chat-windows.test.ts` — expect FAIL (module missing).
- [ ] **Step 3: Implement** `chat-windows.ts` with the signatures above. `SHEET_GUTTER` (16) from `./sheet` is the gap
  next to a card and the inset for the default spot. Lists are never mutated.
- [ ] **Step 4: Run** the test file — expect PASS.
- [ ] **Step 5: Commit** `feat(canvas): window list for floating chats`.

### Task 2: Live cores for passive windows

**Files:**
- Create: `apps/user-ui/src/chat/window-cores.ts`
- Test: `apps/user-ui/src/chat/window-cores.test.ts`
- Modify: `apps/user-ui/src/App.tsx` (`handleIncomingRealtimeEvent` ~line 1039; socket `onopen` ~line 1205; `CanvasView`
  props ~line 2090)

**Interfaces:**
- Consumes: `ChannelEventsCore` (`chat/channel-events.ts`: `switchTo`, `refresh`, `ingest`, `observeLifecycle`).
- Produces:
  ```ts
  export type WindowCores = {
    acquire(channelId: string): ChannelEventsCore;   // ref-counted; first acquire creates a core and calls switchTo(channelId)
    release(channelId: string): void;                // last release drops the core
    ingest(event: EventRow): void;                   // observeLifecycle + ingest on the core for event.channelId, if any
    refreshAll(): void;                              // void core.refresh() on every held core
  };
  export function createWindowCores(create: () => ChannelEventsCore): WindowCores;
  ```
  `App.tsx` creates one with `createSessionChannelEvents` (memoised for the session, recreated with `channelEvents` on
  sign-in, ~line 1386) and passes it to `CanvasView` as prop `windowCores: WindowCores`.

- [ ] **Step 1: Write the failing tests** with fake cores (objects recording calls):
  - `acquire twice shares one core and switches it once`; `release twice drops it` (a third `acquire` creates a new one).
  - `ingest routes by channel`: event for `'c1'` reaches only the `'c1'` core (`observeLifecycle` and `ingest` both
    called); an event with no channel or an unheld channel reaches none.
  - `ingest forwards a repeated event id` (status republish): calling `ingest` twice with the same id calls the core's
    `ingest` twice (dedupe is the core's job via upsert).
  - `refreshAll refreshes every held core`.
- [ ] **Step 2: Run** `npx vitest run apps/user-ui/src/chat/window-cores.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** `createWindowCores`, then wire `App.tsx`: call `windowCoresRef.current.ingest(event)` right
  after `canvasLiveRef.current?.ingest(event)` (before the duplicate-sighting return), and `windowCoresRef.current.refreshAll()`
  next to `void refreshChannelEvents()` in the socket `onopen`. Pass `windowCores` to `CanvasView` (add the prop to
  `CanvasViewProps`; unused until Task 4).
- [ ] **Step 4: Run** the test file and `npx tsc -p apps/user-ui --noEmit` — expect PASS / no errors.
- [ ] **Step 5: Commit** `feat(chat): live event cores for passive canvas windows`.

### Task 3: The floating sheet becomes a window

One window only in this task (the active chat). Desktop floating mode stops being modal.

**Files:**
- Modify: `apps/user-ui/src/canvas/CanvasView.tsx` (`CanvasChat` ~1574-1780, `CanvasMain` ~1499, body classes ~1433,
  `sheetAnchor`/`inPlace`/`presentCard` ~384-456, `jumpTo` ~686, Surface props ~1386-1390)
- Modify: `apps/user-ui/src/canvas/canvas.css` (focus-mode rules ~1555-1640)
- Test: `apps/user-ui/src/canvas/chat-windows.test.ts` (no new pure logic expected; add cases if you extract any)

**Interfaces:**
- Consumes: Task 1 (`ChatWindow`, `placeWindow`, `clampWindow`, `moveWindow`, `windowWidth`, `windowHeight`).
- Produces: `CanvasChat` gains props `win?: ChatWindow` (desktop floating only), `onMove?(at: Point): void`,
  `onActivate?(): void`, `zIndex?: number`. When `win` is set the section renders `role="dialog"` **without**
  `aria-modal`, `data-window="true"`, positioned by `--win-x/--win-y/--win-w/--win-max-h` from Task 1's helpers.

- [ ] **Step 1: Behaviour changes, desktop floating only** (`chatMode === 'focus' && !phone`):
  - Remove the dimming: no `is-in-place` / `is-plain` class on `.canvas-body`; delete those CSS rules' effect for desktop.
  - `CanvasMain behind` is `null` (no `aria-hidden`), still `'inert'` on phones.
  - No Tab trap; no card anchoring (`place`/`cardSheet`/`looseSheet` not used); `presentCard` is not called on open or in
    `jumpTo` (jumpTo still selects the card); the `inPlace` effect does not run.
  - Surface gets `onEmptyPress`/`onFit` = `undefined` (they no longer close the chat) and `onDropChat`/`onDropFiles` as
    when no chat is open.
  - Escape closes the window only when focus is inside it or on `document.body` (still after inner popups and
    `OTHER_DIALOG`).
  - Header drag: pointerdown on `.canvas-chat-bar` outside buttons/inputs captures the pointer and moves the window
    (`moveWindow` clamped); on pointerup the position is kept. The window is re-clamped on `window` resize.
  - Until Task 4, CanvasView holds the single window in local state: placed with `placeWindow` from the card's on-screen
    rect (or `null`) when the chat opens; reset when the chat closes.
- [ ] **Step 2: Run** `npx tsc -p apps/user-ui --noEmit` and `npx vitest run apps/user-ui/src` — expect PASS.
- [ ] **Step 3: Commit** `feat(canvas): floating chat is a movable window, canvas stays usable`.

### Task 4: Several windows, one message box

**Files:**
- Create: `apps/user-ui/src/canvas/PassiveWindow.tsx` (passive window + `ActiveWindowBody`)
- Test: `apps/user-ui/src/canvas/PassiveWindow.test.tsx`
- Modify: `apps/user-ui/src/canvas/CanvasView.tsx`, `apps/user-ui/src/canvas/Surface.tsx`, `apps/user-ui/src/canvas/Card.tsx`,
  `apps/user-ui/src/canvas/canvas.css`, `apps/user-ui/src/App.tsx`

**Interfaces:**
- Consumes: Task 1 (all), Task 2 (`WindowCores` prop), Task 3 (`CanvasChat` window props), `ChatThread`
  (`chat/ChatThread.tsx`), `useChannelEvents` (`chat/useChannelEvents.ts`).
- Produces:
  ```ts
  // PassiveWindow.tsx
  export function PassiveThread(props: {core: ChannelEventsCore; username: string; agents: Agent[]; title: string;
    onActivate(): void}): JSX.Element;      // read-only ChatThread: onQuote/onFocusMessage/onPreviewDemo call onActivate
  export function PassiveWindow(props: {win: ChatWindow; bounds: Bounds; zIndex: number; title: string;
    people: {agent: boolean; name: string; service: boolean}[]; core: ChannelEventsCore; username: string; agents: Agent[];
    onActivate(): void; onClose(): void; onMove(at: Point): void}): JSX.Element;
  export function ActiveWindowBody(props: {ready: boolean; passive: ReactNode; children: ReactNode}): JSX.Element;
  ```
  - `CanvasViewProps.onOpenChat(channelId, mode, opts?: {replace?: boolean})`; App forwards `opts.replace` (default stays
    `channelId === canvasChat.channelId`).
  - New `CanvasViewProps.chatReady: boolean` = `channelSnapshot.channelId === canvasChat.channelId && !channelSnapshot.loading`.
  - `Surface` prop `windowChannelIds?: ReadonlySet<string>` → `Card` prop `windowed?: boolean` → class `is-windowed`.

- [ ] **Step 1: Write the failing render tests** (`renderToStaticMarkup`, a fake core whose `snapshot()` returns one
  message event):
  - `PassiveWindow shows title, close, live thread and "Click to reply", and no composer`: markup contains the title,
    `aria-label="Close chat Launch"`, `Click to reply`, the message text, `class="canvas-chat is-passive"`, and does not
    contain `textarea`.
  - `ActiveWindowBody shows the passive thread until ready`: `ready={false}` → contains the passive marker, not the
    children; `ready={true}` → the children, not the passive marker.
- [ ] **Step 2: Run** `npx vitest run apps/user-ui/src/canvas/PassiveWindow.test.tsx` — expect FAIL.
- [ ] **Step 3: Implement `PassiveWindow.tsx`.** `PassiveWindow` is `role="dialog"` (no `aria-modal`),
  `aria-label="Chat <title>"`, `tabIndex={-1}`; any pointerdown inside it (except the close button) calls `onActivate`;
  focusing into it calls `onActivate`; header drag as in Task 3. Footer copy: `Click to reply`.
- [ ] **Step 4: Wire CanvasView (desktop floating):**
  - State `windows: WindowList` per canvas: restored with `readWindows(canvasId)`, pruned against `channels` ids
    (`pruneWindows`, re-run whenever `channels` changes), written with `writeWindows` on every change. The URL's active
    chat is added (front) if missing.
  - Opening a chat in floating mode (any `openRef.current(id, 'focus')` path) calls `openWindow(...)` with
    `placeWindow(...)`; activating a passive window calls `bringToFront` then `onOpenChat(id, 'focus', {replace: true})`.
  - Closing: `closeWindow`; if it was active and `next` is set → `onOpenChat(next, 'focus', {replace: true})`, else
    `onCloseChat()`. Closing a passive window leaves the active one alone.
  - Each window holds `windowCores.acquire(id)` while open (release on close/unmount). Passive windows render
    `PassiveWindow`; the active one renders `CanvasChat` with `children = <ActiveWindowBody ready={chatReady} passive={<PassiveThread core=…/>}>{chat}</ActiveWindowBody>`.
  - `zIndex` follows front-to-back order (front highest). Passive title uses the same fallback as `chatTitle`
    (extract `titleFor(channelId)`); `people` from that channel's participants (same mapping as `chatSub.people`).
  - Split mode renders only the active chat as today; `windows` is kept, so floating again shows them.
  - Surface/Card: every windowed card gets `is-windowed` (a lighter ring than `is-open`).
- [ ] **Step 5: Run** the new test, `npx tsc -p apps/user-ui --noEmit`, `npx vitest run apps/user-ui/src` — expect PASS.
- [ ] **Step 6: Commit** `feat(canvas): several live chat windows with one message box`.

### Task 5: File drops on windows, and the docs

**Files:**
- Modify: `apps/user-ui/src/components/file-drop.ts` (`insideCanvasChat`), `apps/user-ui/src/canvas/PassiveWindow.tsx`
- Test: `apps/user-ui/src/components/file-drop.test.ts` (create if absent)
- Modify: `docs/SPEC.md` (canvas floating-mode text, if described there), `docs/superpowers/specs/2026-11-08-switchyard-canvas-design.md`
  (the focus-mode paragraphs: point to the windows design), `docs/ROADMAP.md` (note option 1 as the follow-up if one box
  proves limiting)

**Interfaces:**
- Produces: `insideCanvasChat(target)` is true only inside `.canvas-chat:not(.is-passive)`; `outsideCanvasChat` stays
  false anywhere inside `.canvas-chat` (passive included). `PassiveWindow` gains `onFiles(files: File[]): void`.

- [ ] **Step 1: Write the failing tests** (jsdom-free: build minimal `Element`-like targets with `closest`, or use the
  existing test setup's DOM if present): a target inside `.canvas-chat.is-passive` → `insideCanvasChat` false and
  `outsideCanvasChat` false; inside `.canvas-chat` (active) → `insideCanvasChat` true.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement.** `PassiveWindow` handles `dragover`/`drop` of files itself (`dragCarriesFiles`): on drop it
  calls `onFiles(files)`; CanvasView passes `files => { onChatFiles(id, files); activate(id); }` (the existing
  `CanvasChatFilesBridge` queues them once that chat's composer is ready). Folders get `FOLDER_NOTICE` as elsewhere.
- [ ] **Step 4: Update the docs** listed above: floating mode is now up to 4 non-modal windows, one message box in the
  active window, no dimming; a deliberate departure from the mockup at the owner's request.
- [ ] **Step 5: Run** `npx tsc -p apps/user-ui --noEmit` and `npx vitest run apps/user-ui/src` — expect PASS.
- [ ] **Step 6: Commit** `feat(canvas): drop files on any chat window; document chat windows`.
