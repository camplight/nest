# Canvas chat windows (several floating chats) — design

Branch: `feat/switchyard-canvas` (local, behind `NEST_ENABLE_CANVAS`). Builds on the Switchyard canvas spec
(`2026-11-08-switchyard-canvas-design.md`) and changes its "focus" (floating) chat mode.

## Intent

Today the floating chat is a single sheet: opening a chat dims every other card, area and link to .28 (the mock's
`#world.focus`), hides the canvas from assistive tech, and a press on empty canvas or Fit closes it. Only one chat can be
open at a time because the app has one live chat session (`App.tsx`: one events core, one composer, one sending/Stop
state, bound to `activeChannelId`).

The owner wants floating mode to behave like **windows**: several chats open at once over a canvas that stays fully
visible and usable. They named three jobs, all of which must work:

1. **Watching agents work in parallel**: each open window shows its chat live, in full (messages, agent activity,
   working ring), not a summary.
2. **Answering a few people quickly**: moving from one chat to typing in another takes one click.
3. **Comparing or moving things between chats**: windows sit side by side; you can read one while writing in another.
   (Dragging messages or files between windows is a later step, not this one.)

Success: the owner can keep three or four chats open over their canvas, watch them all update, reply in any of them
within one click, and still pan, drag and open cards behind them. If it feels limited by having one message box, the
fallback is "option 1" (a full chat session per window), which this design must not block.

## Goals

- Floating mode holds up to **4 windows**. Opening another chat adds a window; a 5th closes the oldest non-active window.
- **No dimming, no scrim, no inert canvas** while windows are open. Pressing empty canvas or Fit no longer closes chats.
- Every window shows its chat **live and in full** (the same `ChatThread` rendering).
- **One message box**, in the **active** window (the last one clicked or opened). Clicking anywhere in another window makes
  it active: the box, header actions and sending move there. Drafts are already per chat, so text typed in one chat stays
  with it.
- Windows can be **dragged** by their header, **closed** individually, and the clicked window comes to the **front**.
- The open windows of a canvas **survive a reload**.

## Non-goals

- A message box in every window at once (that is option 1).
- Dragging messages or files between windows.
- Resizing windows, minimizing them to a bar, or snapping/tiling layouts.
- Any change to split mode beyond what is stated below, to phones (they keep the list and full-screen chat), or to the
  regular chat page.
- Any API, engine, or database change. This is UI only (`apps/user-ui`).

## Anti-goals (a failure even if it technically works)

- A passive window that goes stale, or needs a click to catch up: watching in parallel is the point.
- Switching the active window that visibly reloads the thread (blank, spinner, scroll jump).
- Losing a half-typed reply when switching windows.
- Regressions in the single-chat behaviours that exist today: split mode, the regular chat page, sending, Stop, `@`
  mentions/invites, files dropped on a card, the digest and Setup line, schedule/connect popovers.
- Windows that cover the canvas so it can't be used (they must leave room and be movable).

## Constraints

- Repository rules (`AGENTS.md`): npm; Nest UI only; no `vendor/orgops` edits; functional factories and dependency
  injection; colocated tests; conventional commits; no AI attribution lines. Stays local until the owner has tested it.
- Feature stays behind the canvas flag; the regular chat page is untouched.
- This deliberately departs from the design mockup (`switchyard-nest-vision.html`), which has one open chat and dims the
  rest. The owner asked for it; the spec text for focus mode is updated to match once accepted.

## Approaches considered

1. **Full windows**: extract the whole chat session (events core, composer session, sending, Stop, invites, huddle)
   from `App.tsx` so every window runs one. Most capable; riskiest (touches sending and drafts app-wide). Kept as the
   fallback if the owner finds one message box limiting.
2. **Live windows, one message box that follows the click** *(chosen by the owner)*: each window gets its own live
   message view; the existing single session (composer, sending, Stop, invites, header actions) stays in `App.tsx` and
   serves whichever window is active. Low risk to sending; the read-side pieces are the first half of option 1.
3. **Peek windows** showing the card digest instead of the thread: dropped, too thin for watching or comparing.

## How it works (decided)

### State

- CanvasView keeps, per canvas, an ordered list of **open windows**: `{channelId, x, y}` in screen (stage) pixels, ordered
  front to back. The **active** window is the chat App already has open (`canvasChat.channelId` with mode `focus`, kept
  in the URL as today). The list also contains the active chat.
- The list is saved in `sessionStorage` per canvas (best effort, wrapped in try/catch), and restored on load, dropping
  chats the person can no longer open. The URL still names only the active chat.
- Opening a chat in floating mode (card click, Open from the drawer, new chat buttons, Needs you, search) adds a window or,
  if it is already open, brings it to the front and makes it active.

### Live message views for passive windows

- `chat/channel-events.ts` already provides `createChannelEventsCore(deps)` with `switchTo`, `refresh`, `ingest`,
  `subscribe`, `snapshot`. Each passive window creates **its own core** (same deps as `createSessionChannelEvents` in
  `App.tsx`) and renders `ChatThread` from it, read-only: no composer, no quote action, no fork action.
- Realtime: the socket already subscribes to every visible channel. `App.tsx`'s `handleIncomingRealtimeEvent` also feeds
  each event to a **registry of window cores** keyed by channel id (a small factory, injected into CanvasView), so passive
  windows stay live. On socket reconnect, registered cores `refresh()` as the main core does.
- A window keeps its core for as long as it is open, **including while it is the active one**, so becoming passive again
  is instant. While a window is active, it shows App's live thread and composer (the existing `chat` element); while
  passive, it shows its own core's thread. Switching is a swap of what renders, with no reload.

### Activating, closing, focus

- A pointer press anywhere in a passive window activates it (`onOpenChat(channelId, 'focus')`), brings it to the front
  and focuses its composer once App's chat for it is ready. Keyboard: the window is a focusable region; Enter or focusing
  in it activates.
- Closing the active window makes the next window in front-to-back order active; closing the last closes the chat as
  today. Escape closes the **active** window (after inner popups, as today).
- Press on empty canvas, Fit, pan and zoom never close windows.

### Placement and dragging

- Windows are fixed to the screen (they do not follow pan or zoom) and are **440 px wide**, height up to the stage height
  minus gutters, capped at the current `SHEET_MAX_HEIGHT` (720). Narrower stages get narrower windows, down to 320.
- A new window opens near its card's on-screen position when the card is visible (to its right, else left), otherwise
  cascaded 32 px down-right from the front window; always clamped inside the stage bounds already used for sheets
  (`stageBounds`, clear of the bottom box and drawer).
- The header drags the window (pointer events; position clamped to the stage; saved on drop). Buttons in the header do
  not start drags.

### What each window shows

- **Active window**: today's full sheet: title, participants line, digest, Setup line, header actions (split toggle,
  schedule, connect, Open in regular view, More menu), the thread, and the composer.
- **Passive window**: title, participants line, a close button, the live thread, and a footer line "Click to reply"
  where the composer would be. No digest, Setup line or header actions (they belong to the active chat).
- Cards: every card with an open window shows the open ring; the active one keeps today's stronger state.

### Split mode

- Split shows only the active chat, as today. Switching the active window to split keeps the other windows in the list
  but hides them; switching back to floating shows them again.

### Removed from floating mode

- The `.is-in-place` / `.is-plain` dimming rules, the focus sheet's `aria-hidden`/inert canvas, `onEmptyPress` and
  `onFit` closing the chat, and anchoring the sheet to its card's on-screen corner (`--sheet-x/--sheet-y` following the
  view). The phone layout keeps its own full-screen chat.

### Calls made after the builder check (the designer's, open to the owner's correction)

- **No reload on activation.** App's core blanks while `switchTo` loads, so a newly active window keeps rendering its
  own core's thread until App's snapshot is for that channel and no longer loading, then swaps to App's thread and
  composer. Its position is kept if the reader was at the bottom; a reader scrolled up lands at the bottom after the swap
  (accepted for this step). `channel-events.ts` does not change.
- **History.** Activating a window replaces the URL entry (Back does not cycle windows). On reload the URL's chat is the
  active window and is added to the restored list if missing.
- **Drafts, sending and Stop.** Drafts are per chat already (`drafts.ts`: text, attachments and an in-flight send
  request), so switching keeps half-typed replies. Stop, `@` invites and sending belong to the active chat; a passive
  window shows its agents working (the live thread and working ring) but no Stop button: clicking it brings Stop back.
  Activation is not blocked while a send is in flight; the send finishes as it does today when changing chats.
- **Which chats can be windows.** Any chat in the person's channel list (the ones the socket follows). On restore, chats
  no longer in that list are dropped.
- **File drops.** A drop on a window goes to that window's chat (it becomes active and the existing canvas file bridge
  queues the files once its composer is ready); a drop on empty canvas still starts a chat, also while windows are open.
- **Read state.** Only the active window marks its chat read, as today. Passive windows do not change unread counts or
  Needs you.
- **Cap.** A 5th window closes the window at the back of the front-to-back order that is not active.

## Left to the builder

- Exact z-index stacking and focus-ring styling, within the canvas tokens.
- Whether window cores are created lazily on first passive render or at open time (either meets the "no reload on
  switch" goal as long as the core exists before the window first goes passive).
- How the registry hooks into `App.tsx` with the smallest change (a ref passed to CanvasView is fine).
- Tests: unit tests for the window list (open/activate/close/cap/restore), placement clamping, and the realtime fan-out to
  window cores; component render tests for passive vs active windows. Browser checks on desktop by the owner.
