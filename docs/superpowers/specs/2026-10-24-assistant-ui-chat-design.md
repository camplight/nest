# Chat on assistant-ui: design

Status: draft for approval, revised after three independent adversarial reviews. Date: 2026-10-24.

## 1. Intent

The Nest channel chat works but feels thin next to modern agent chat interfaces. The goal is to rebuild the chat part of the user UI on [assistant-ui](https://github.com/assistant-ui/assistant-ui) so that it keeps every behaviour it has today and gains a set of quality-of-life features that assistant-ui already provides well. It must be a net positive: nothing users rely on today may get worse.

assistant-ui was chosen because it is built for agent chat (message rendering, scroll behaviour, action bars, markdown with code highlighting), is MIT licensed and very actively maintained, so improvements arrive without hand-writing each one.

## 2. Scope

In scope: inside the `chatWorkspace` block of `apps/user-ui/src/App.tsx`, the message list (`.messages-panel`), the "New messages below" control, the composer form and the demo "Preview" and "Request changes" hooks. That block is used by standalone channels, direct messages and the Chat tab of a project.

Out of scope and unchanged: the workspace topbar, workspace header and error notices inside `chatWorkspace`; the sidebar and channel list; project tabs (Files, tasks); the participants panel including its "Agent is thinking" line; channel management dialogs; the dashboard, agents, community and onboarding screens; `ProjectStart` (project creation form); the admin UI chat (`apps/admin-ui/src/screens/ChatScreen.tsx`); and the engine (`vendor/orgops`, never edited).

## 3. Goals

1. Full parity with the current chat (section 6), proven by the existing browser and unit tests.
2. The new features listed in section 7.
3. Move the chat out of the 2,755-line `App.tsx` into its own module with a pure, unit-tested event-to-timeline conversion.
4. Look like Nest: assistant-ui's styled components re-themed with Nest's tokens, in light and dark mode, following Nest's own theme toggle.

## 4. Non-goals

1. Anything the engine cannot do today: editing, deleting, regenerating or stopping a reply, token streaming, reactions, reply threads, typing indicators, presence. These stay off and may be enabled later if OrgOps adds them upstream.
2. Replacing the channel list with assistant-ui's thread list.
3. Changing the engine event model or the Nest send API beyond the one addition in 7.3.
4. Assistant Cloud or any hosted service.
5. Right-aligning the user's own messages or any other layout change not listed in section 7.

## 5. Anti-goals

The work fails, even if it technically runs, if any of these happen:

1. The activity chips change in shape or meaning, or lose their per-event detail card.
2. Humans cannot post while an agent is working (assistant-ui disables sending while its single "running" flag is on).
3. A stray empty "assistant is typing" bubble appears (assistant-ui inserts one when running and the last message is not from the assistant).
4. Two agents posting back to back merge into one bubble.
5. Tailwind's reset, utilities, theme variables or animations change the look or motion of anything outside the chat, or override Nest's reduced-motion rule inside it.
6. Secrets reach any place they do not reach today. In particular: activity event details (tool arguments, process output, wrapper stderr) can never be quoted, copied with the message actions or exported, and the progress text shows only the `text` field of progress events.
7. Message ownership moves into assistant-ui: our store and our converter stay the source of truth, so a library upgrade or removal never touches data handling.

## 6. Parity bar: what exists today

Everything below must keep working. File references are to `apps/user-ui/src/` unless noted.

1. History: 7 parallel `/api/events` queries per channel (messages, `agent.turn.failed`, `agent.turn.*`, `tool.*`, `telemetry.context.window.updated`, `wrapper.turn.*`, `process.*`) merged chronologically, adaptive page size from the network connection, `before=<createdAt>` paging for older history. Today older pages use only 5 of those queries; the new loader uses the same 7 for every page (decided fix). Messages reload on WebSocket (re)connect and when returning to a project's Chat tab. Load failures show "Unable to load messages" and "Unable to load previous messages".
2. Realtime: one WebSocket, `channel:<id>` topics for visible channels, reconnect with backoff, 10 second polling fallback while disconnected, dedup by event id (a status republish of the same id is ignored, also for unread counts and the `nest-message` window event).
3. Timeline: `message.created` events as messages; consecutive trace events grouped into one activity group, interleaved with messages in time order.
4. Activity chips (`components/AgentActivity.tsx`, `activity.ts`): 22 by 22 pixel icon chip per event, tone colours, tooltip with title and time on hover or focus, click (or tap on mobile, with no tooltip) opens a card with title, time and the full event JSON under "Details", a second click or tap closes it; the group itself has no visible text.
5. Message rendering: sender avatar (the agent's configured portrait, or its initials fallback; humans get the first two characters of the name uppercased, `aria-hidden`), sender name, timestamp (`deliverAt` before `createdAt`), "To @agent" target labels, markdown only when the text looks like markdown or contains a URL, links open in a new tab, long sender names never overflow. System-sourced messages (`system`, `system:runner:*`) show their label and no avatar. `agent.turn.failed` is not a message: it appears only as the red "Agent could not finish" chip in its activity group.
6. Attachments on messages: list with a link named exactly the file name, mime and size; inline previews for png, jpeg, gif, webp, each wrapped in a link named "Open <file name>" to `/api/files/<id>`; a fallback text "Preview unavailable. Open the file using the link above." when the image fails; SVG shown as a link only.
7. Demo artifacts: `/demo/<slug>` links in a message show a "Preview" button that opens the side panel (`DemoArtifact`) tied to the channel it was opened in; "Request changes" appends exactly `\n\nPlease update <absolute url>: ` to the draft and focuses the composer, and is disabled when posting is impossible or a send is in flight.
8. Composer: Enter sends, Shift+Enter newline, IME composition never sends; autosize with different limits for empty and non-empty chats (compact composer and `messages-panel-empty` when the chat is empty); placeholder variants for archived, read-only, no channel, empty and non-empty chats; textarea, Attach and Send disabled while sending; Send also disabled while uploading, inviting or with failed uploads; Send label "Uploading N...", "Sending..." or "Send"; failed-upload hint text.
9. Mentions (`mentions.ts`, `components/useMentionPicker.tsx`): `@` picker with ranking, skipped inside code and in email-like text, keyboard (arrows, Enter, Tab, Escape), invite-on-select for people and agents not in the chat with all existing permission rules and texts (private agents, project owner, read-only, archived), personal agents of other people open a direct conversation and seed the brief only into an empty draft, selected mentions tracked as spans and reconciled on edit, spans shifted by leading whitespace on send, recipient chips ("Ask @x", "Notify @y") with remove buttons, hint text.
10. Sending: through `POST /api/messages` with a client UUID per draft, the same UUID reused while the content fingerprint is unchanged, file-only messages get the text "Attached N file(s) for reference.". On failure the text, mentions and attachments stay and the button stays "Send". After a send: reload when the WebSocket is down, and scroll the composer into view.
11. Drafts (`drafts.ts`): per user and channel in localStorage including mentions, uploaded attachments and the pending send request; "Draft saved on this device" status, and "Draft storage is unavailable. Keep this tab open until you send." when storage fails; cleared on logout; a late send response never clears a newer draft.
12. Uploads (`attachments.ts`, `ChatFileDrop`, `ChatAttachments`): picker, paste of images, drop anywhere on the workspace with folder rejection and the exact blocked-drop alerts ("Choose a conversation before attaching files.", "Restore this conversation before attaching files.", "This conversation is read-only.", "Wait for this message to finish sending."), plain-text and off-screen drops not intercepted, uploads that finish after a channel switch stay in their original channel's draft, 20 file limit with message, chip text "Ready", per-file error, `Remove <file>` buttons.
13. Scroll: start at the bottom, stay pinned when near the bottom, "New messages below" button only when new content arrived while scrolled up, keep position when older history loads, `?message=<id>` deep link (also from the mention inbox) scrolls the message to the centre, focuses it (`tabIndex=-1`) and highlights it even when it is outside the loaded page, skipping the initial scroll to bottom; a deep link to another channel or a missing message shows "This mentioned message is no longer available.".
14. Unread counts for other channels (suppressed for the visible chat) and the `nest-message` window event used elsewhere.
15. Project chat: `ProjectConnections` under the messages, fed by the last 4 messages.
16. Mobile layout without horizontal overflow at 390 pixels; Send and composer visible within the viewport at 1100 and 844 pixel heights.
17. Loading and empty states: "Loading messages..." and "No messages yet".

Tests that define the bar (all must pass, changed only for selectors, never for weaker assertions): `tests/browser/chat.ts`, `codex-progress.mjs`, `claude-code-progress.mjs`, `claude-code-agent.mjs` (both arriving with `feat/claude-code-wrapped-runtime`), `demo-artifacts.mjs`, `targeted-mentions.ts`, `mentions.mjs`, `image-attachments.ts`, `projects.ts`, `onboarding.ts`, `dashboard.ts`, `agent-runtime-status.ts`, `agents.mjs`, `connection-projects.mjs`; unit tests `activity.test.ts`, `mentions.test.ts`, `drafts.test.ts`, `demo-artifacts.test.ts`, `ProjectConnections.test.ts`, `apps/api/src/messages.test.ts`.

## 7. New features

### 7.1 Reading

1. Code blocks with syntax highlighting and a copy button; tables and links styled.
2. Consecutive messages from the same author within 5 minutes on the same day are grouped: avatar and name shown once, each message keeps a small timestamp. Date separators between days.
3. Older history loads automatically when scrolling near the top (the explicit "Load previous messages" button remains), keeping the scroll position. Besides "New messages below" (6.13), a small scroll-to-bottom arrow appears when the user is far from the bottom with nothing new.
4. Image previews open in a zoom view on a plain click; the preview keeps its "Open <file name>" link to the file, so modifier, middle click and keyboard "open in new tab" still work. The zoom view has an "Open original" link.

### 7.2 Message actions

Shown on hover and keyboard focus on desktop, and toggled by a tap on mobile, for `message.created` items only (never on activity groups or working rows):

1. Copy message text.
2. Copy link to message (existing `?message=` deep link format).
3. Quote-reply (see 7.3).
4. Select text inside one message's body and quote just that selection. A Nest button placed by assistant-ui's `SelectionToolbarPrimitive.Root` reads `window.getSelection()` and the closest `[data-message-id]` itself (assistant-ui's own selection context is not public). Activity groups and working rows are marked non-quotable, and a selection spanning two messages offers no quote.

Hidden actions use `display: none`, so they do not change text content or layout measurements.

### 7.3 Quote-reply

Quoting inserts the quoted text (up to 2,000 characters) as a Markdown blockquote with the author at the top of the composer and sets a reply target `{eventId, author, excerpt}` with an excerpt of at most 500 characters including a trailing ellipsis. On send, `SendMessageSchema` (`packages/schemas/src/messages.ts`) gets an optional `replyTo: string` (event id) and the client includes it in the send fingerprint, so changing or cancelling the reply after a failure produces a new message id. `apps/api/src/messages.ts` validates, only when no intent row exists yet for the request id (so the existing "retry unchanged" recovery keeps working), that the target is a `message.created` in the same channel; otherwise it answers 400 with `{ error, code: "REPLY_TARGET_INVALID" }`, also when the sender cannot view the target (existence is not revealed). The payload gets `inReplyTo` (already defined in the engine `message.created` schema). `parentEventId` is not used. A reply adds no targeting: it reaches agents exactly as an unmentioned message does today; the user @mentions to target. The draft stores the reply target.

Rendering: any message with `inReplyTo` (also agent messages, which may set it) shows "Replying to <author>" only when the target resolves to a `message.created` in the same channel, first from loaded events, otherwise through `GET /api/events/<id>` (access-checked by the engine; a different channel or an error shows nothing). Clicking it uses the deep link mechanism.

### 7.4 Composer

The composer stays Nest-owned in behaviour and takes assistant-ui's composer look (its styled composer element as the visual reference: copied markup and classes, no `ComposerPrimitive` send path). Reason: assistant-ui's mention popover inserts directive text and needs a synchronous adapter, while Nest needs plain `@name` text, tracked spans, a network invite before insertion and a redirect for personal agents; and assistant-ui's composer clears on send without restoring on failure, while Nest keeps the text and the same message UUID until the server confirms.

1. The picker logic (`mentions.ts`, `useMentionPicker`) is generalised into one trigger picker serving `@` and `/`. Every rule in 6.9 stays. The chat instance is restyled like assistant-ui's popover; `ProjectStart`'s instance keeps its current look.
2. `/` commands trigger only at the start of a line and the list closes when nothing matches, so a message that starts with a path can still be sent with Enter. Initial set: `/invite` (opens the existing invite flow; offered only when the user may invite) and `/files` (opens the project Files tab; offered only in project chats). When no command is available the list shows "No commands available".
3. Attachment chips with image thumbnails and a real upload progress bar. Uploads move from `fetch` to `XMLHttpRequest` for progress events, keeping the `apiUrl()` base, credentials (`withCredentials`) and error-body parsing. This changes the shared upload path also used by `ProjectStart`, which must keep passing `projects.ts`.
4. Send behaviour exactly as today (6.10), with the reply target kept on failure.
5. Elements whose size or position is set from JavaScript (the autosizing textarea, the selection toolbar) carry no Tailwind size, position or transform utilities.

### 7.5 Agents

1. A working row per active agent turn, with that agent's avatar and name. Turns are keyed by agent and `triggerEventId`; the agent comes from the `agent:` source or, for wrapper events (source `system:runner:wrapper`), from `payload.targetAgentName`. A turn is active from its first start event (`agent.turn.started`, `wrapper.turn.started`) or its first progress event (`agent.turn.phase` with phase `codex-progress` or `wrapped-progress`), so a long turn whose start event fell off the loaded page still shows. It ends at a matching completed or failed event, when a newer turn by the same agent starts (superseded, as today), or when a stop was requested after the turn began: the agent's `desiredState` is `STOPPED` and its `updatedAt` (milliseconds, set by the stop action) is later than the turn's first event. `desiredState` alone is not enough because agents created without one default to `STOPPED`, and `runtimeState` is not used because agents without a live runner, as in tests, report `STOPPED` while their events still arrive. No fixed time limit. The row sits directly after the trigger message, or at the end of the list when that message is not loaded. It shows the latest progress `text` when there is one, otherwise "Working…". The progress line moves from the activity group into this row: the group no longer renders it, the text appears exactly once, and the element keeps the class `trace-progress` (with no ARIA role of its own; the row carries `role="status"`). The participants panel's "Agent is thinking" line stays.
2. Export the chat as Markdown: the loaded `message.created` items with authors, times and attachment links; activity groups appear as one line with their event count and never their details.

### 7.6 Later phase (not in this project)

The interactive message cards from upstream OrgOps: `json-render` blocks and the inline secret input form. They get their own design and security review.

## 8. How it fits together (decided)

1. Runtime: `useExternalStoreRuntime` with `isRunning: false`. Our chat store stays the source of truth. The required `onNew` rejects with an error because the composer is ours (7.4). `hasEarlier` and `onLoadEarlier` drive older history; the callback sets the visible error itself because assistant-ui only logs rejections.
2. Conversion: one pure function from events to timeline items, then a one to one `convertMessage` (never the merging converter).
   - `message.created` from `human:*` becomes `role: "user"`. Every other `message.created` becomes `role: "assistant"` so it may carry data parts.
   - Each group of consecutive trace events becomes its own `role: "assistant"` item whose only part is a `data-nest-activity` data part rendered by the existing `AgentActivity` component.
   - Author kind (`human`, `agent`, `system`, `activity`), author name, target agents, `inReplyTo`, display time and whether the author is the current user go in `metadata.custom`.
   - Attachments from any author become a `data-nest-attachments` data part rendered by Nest's attachment component. assistant-ui image and file parts are not used (image parts drop relative `/api/files/<id>` URLs; `attachments` are allowed only on user messages).
   - Ids: a message's id is its event id. An activity group's id is the id of its earliest event when first built, and stays the same when the group later grows in either direction (older events prepended by paging, newer events appended); the converter takes the previous timeline to keep ids and reuses unchanged item objects so assistant-ui's per-object conversion cache stays valid. Working rows are not timeline items; they render after their trigger message.
3. History paging keeps a cursor per query type from the contiguous loaded window. Events loaded only through a deep link or a reply link are "detached": they render in place with a "Earlier messages not loaded" marker between them and the loaded window, never move a cursor, and disappear into the window once paging reaches them.
4. Disabled handlers: no `onEdit`, `onReload`, `onCancel`, `setMessages`; branch picker, edit, reload and stop never render.
5. Scroll: `turnAnchor="bottom"`; `scrollToBottomOnInitialize` off when a deep link is pending; auto-load of older history paused while a deep-link focus is pending; no `content-visibility: auto` on messages (it makes `scrollIntoView` imprecise).
6. Styling: assistant-ui's styled components (its shadcn registry, Tailwind v4, `*.radix.tsx` variants) are copied into the user UI and themed. Tailwind v4 is added to `apps/user-ui` only, through its Vite plugin:
   - The chat scope is `.nest-chat` (message list), `.nest-chat-composer` (composer) and `.nest-chat-portal` (container for the chat's Radix portals). No global preflight; a small reset scoped to those three provides what the copied components assume.
   - Utilities are generated only from the chat module's files (`source(none)` plus `@source` for the chat folder) with the `important` flag, so Nest's unlayered global rules cannot override them inside the chat. Utilities themselves are unscoped class rules (Tailwind drops `important` when nested), which is safe because they are generated only for classes the chat uses and a unit test fails if any generated class selector equals a class used outside the chat folder.
   - Other unscoped output allowed: rules whose declarations are all `--tw-*` custom properties, `@property --tw-*`, `@keyframes`, and the `:root, :host` theme variables, none of whose names Nest defines. Everything else must be scoped; a unit test enforces this.
   - Theme: `@theme inline` registers the shadcn colour names (`background`, `foreground`, `primary`, `primary-foreground`, `muted`, `muted-foreground`, `accent`, `accent-foreground`, `card`, `card-foreground`, `popover`, `popover-foreground`, `border`, `input`, `ring`, `radius`) as aliases of Nest's `--nest-*` tokens (`apps/nest-brand/brand.css`). Dark mode: `@custom-variant dark` bound to `[data-theme="dark"]`, never `prefers-color-scheme`.
   - Motion: important declarations in a cascade layer beat unlayered important ones, so Nest's own reduced-motion rule (`brand.css`) loses to Tailwind's layered utilities inside the chat. The chat stylesheet therefore declares its layer order with a first layer `nest-chat-motion` holding an important `prefers-reduced-motion: reduce` rule (animation and transition none) for the chat scope, which wins over the later `utilities` layer. `tw-animate-css` is added for the copied components' enter and exit classes.
   - Native bindings: `@tailwindcss/node` pins `lightningcss` to an exact version that differs from the user UI's existing `lightningcss-*` pins; an npm `overrides` entry aligns `lightningcss` on the user UI's version, so one set of platform binaries serves both.
   - `apps/admin-ui` keeps its own Tailwind 3.4 (PostCSS). From `apps/admin-ui` Tailwind resolves to 3.4; from `apps/user-ui` it resolves to 4. Linux and macOS native bindings for Tailwind's oxide are pinned as optional dependencies like the existing ones, and the Docker build is part of the gate.
7. Versions: exact pins of `@assistant-ui/react`, `@assistant-ui/react-markdown` and `@assistant-ui/react-syntax-highlighter`; their caret-ranged internal packages are fixed by the lockfile. Every `unstable_` or experimental assistant-ui API is used only behind one wrapper file in the chat module. The pull request records the bundle growth and that assistant-ui brings zod 4 and `assistant-cloud` alongside Nest's zod 3.

## 9. Constraints

1. `vendor/orgops` is never edited.
2. React 18.3 stays; copied components get `forwardRef` adjustments where needed.
3. Product schema changes go in `packages/schemas` and stay in sync with `apps/api`; `docs/SPEC.md` describes the final chat behaviours and `replyTo`; `docs/SUBMODULE_MIGRATION.md` records the new use of the engine's `inReplyTo` payload field.
4. No credentials in logs, commits or screenshots.
5. The pull request includes desktop and mobile screenshots of the new chat, captured after checks pass, plus the bundle size report.

## 10. Rollout

Build behind a switch: URL parameter `chatUi`, then localStorage `nest:chat-ui`, then the build-time variable `VITE_NEST_CHAT_UI`, then the default. The default stays classic until the new chat passes the whole parity bar, which every classic suite can be run against early by setting `VITE_NEST_CHAT_UI=next`. Then the default flips and the classic code and the switch are removed in the same project. Development happens on `feat/assistant-ui-chat`, stacked on `feat/claude-code-wrapped-runtime` (PR #55); its pull request targets that branch until #55 merges, then `main`.

## 11. Left to the builder

1. File names inside `apps/user-ui/src/chat` beyond those the plan fixes.
2. How auto-loading near the top triggers.
3. Syntax highlighter theme.
4. Exact visual details of grouping, date separators, action bar, working row and the scroll arrow, within Nest's look.

## 12. Calls made without explicit confirmation

1. Nest's look is kept by theming assistant-ui's styled components.
2. Tailwind is scoped to the chat with no global preflight and important utilities.
3. The admin UI chat and `ProjectStart` are out of scope (the shared upload change still reaches `ProjectStart`).
4. Quote-reply uses `payload.inReplyTo`, not `parentEventId`, and adds no targeting.
5. `/files` appears only in project chats; `/invite` only for users who may invite; `/` triggers only at a line start.
6. Interactive upstream cards are deferred.
7. The composer keeps Nest's behaviour and send path; mentions and commands use Nest's picker.
8. The working row owns the progress text; turns end on completion, supersession or a stop requested after the turn began (`desiredState` plus `updatedAt`), with no time limit.
9. All non-human messages and activity groups use the `assistant` role; attachments render through a Nest data part.
10. Every history page uses the 7 queries with per-type cursors; deep-linked events are detached.
11. Message actions and quoting exist only on `message.created` items.
12. "New messages below" keeps today's meaning; the extra scroll arrow is new.
