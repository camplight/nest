# Canvas overnight batch — design

Branch: `feat/switchyard-canvas` (local, behind `NEST_ENABLE_CANVAS` for canvas work). The owner asked for five things
and delegated every call: "Please implement everything according your understanding and recommendations." This
document records those calls so the owner can check them in the morning. Builds on
`2026-11-08-switchyard-canvas-design.md` and the mockup `switchyard-nest-vision.html` (kept outside the repo).

## What was asked

1. Phase 1 leftovers (ROADMAP "Switchyard canvas — Phase 1"): a keyboard/touch route to invite agents, a keyboard
   route to move cards and areas, hidden (archived) loose chats searchable with Ctrl/Cmd+K.
2. Phase 3 follow-ups: team and viewer-share access in flow checks, Composio app-event triggers, the canvas on phones.
   Engine recurrence (U3) and fork history (U6) need OrgOps changes and are **not** in this batch.
3. Fix automatic chat naming (every naming job had failed).
4. Cards in an area have a 4 px tinted top border whose ends curl into the rounded corners ("I really hate how all
   the borders have this curly"). Keep the radius, lose the curl.
5. The mockup pieces still missing: the status legend, presence avatars on the share pill, Apps here chips that filter
   a chat to one app, the canvas summary line, and "Invite Moss to …" labels while dragging an agent.

## Decisions

### 1. Chat naming and summaries
Root cause: with no `NEST_MANAGEMENT_AGENT_NAME`/`NEST_PROJECT_NAMING_AGENT_NAME`, the naming worker has no agent to
resolve provider keys through, and this install keeps them only as public-scope engine secrets. Naming falls back to
the Switchyard agent (`switchyard.agent`, default `Switchyard`) as a **read-only** secrets source; the summarizer used
for hand-offs had the same gap and gets the same fallback. Failures log one sanitized category line (never raw errors).
Already-failed jobs are not re-run automatically (no silent changes to existing chats).

### 2. Card border
Drop the 4 px top stripe. A card in an area gets a uniform 1.5 px border in the area's tint (mixed with the border
colour as today); needs-you keeps its coral border. Radius unchanged. No other component uses a thick one-sided border
with a radius (checked).

### 3. Legend, summary line, share avatars
- **Legend** (mockup `.legend`): a small pill at the bottom right above the zoom buttons: working (lime dot), waiting on
  you (coral dot), gone quiet (dashed ring), plus one hint line naming the real tray ("Drag an agent from <tray name>
  onto a chat. Drag its face off a card to remove it."). Hidden in split mode and on phones; does not intercept canvas
  presses beyond its own box.
- **Summary line** next to the canvas name: `N chats · X moving · Y quiet` (quiet omitted at 0), computed from the
  existing pulses over open cards, using the area-summary wording ("chats", not the mockup's "conversations"). Hidden
  when the top bar is narrow (below 1200 px).
- **Share avatars**: up to three stacked initials avatars of the people the canvas is shared with (not the viewer),
  then `+N`, inside the share pill; tooltip "People with access". This is membership, not live presence (Nest has no
  presence signal; adding one is out of scope). Shown only where the viewer can already read members.

### 4. Inviting agents without dragging
- **Drag labels**: while an agent is dragged from the tray over a card, a floating label follows the pointer: `Invite
  Moss to "Title"`, `Moss is already here`, or `You can't add agents to this chat`. Native drag image unchanged.
- **Keyboard/touch route**: the open chat's More menu gets **Add agent…**, opening a searchable picker of the same
  agents the tray offers; choosing one runs the same add as a drop (same checks and errors). Works by keyboard and tap.

### 5. Moving cards and areas by keyboard
A focused card or area moves with the arrow keys: 8 world px per press, 40 with Shift. Presses within 400 ms form one
move, persisted once through the same board operation a pointer drop uses (including growing the target area and
moving an area's cards with it). A polite live region announces the result ("Moved into Research", "Moved"). Escape
during a burst returns it to where the burst started. Arrow keys never act while an input, textarea or menu has focus.

### 6. Archived chats in search
Ctrl/Cmd+K always includes archived (hidden) loose chats, labelled "Archived", after non-archived matches. Opening one
opens the chat; it stays archived.

### 7. Apps here filter
Apps here chips in an open chat become toggles. Choosing one shows only that app's activity lines (tool events of that
app) with a bar "Showing only <App> · Show all"; choosing it again or Show all clears it. Per open chat, not saved.
Messages are hidden while filtered (that is what "only what happened in <App>" means in the mockup).

### 8. Team and viewer-share access in flows
Follow the engine's rules: **post** = owner, a human subscription, or a team subscription the creator belongs to (not
archived); **read** = post rights, public, or a viewer share. Workers read team membership and channel shares through
engine HTTP with the service token (no engine DB reads), cached per tick. `linkRights` (who may manage links) is
unchanged.

### 9. App-event triggers (Composio)
- A new trigger kind **App event** next to Webhook. The creator picks one of their connected apps, then a trigger type
  Composio offers for it, fills its config fields, and picks the agent and prompt like a webhook.
- Nest creates the Composio trigger instance on the creator's connected account and stores its id with the trigger;
  deleting/pausing the Nest trigger disables/deletes it at Composio.
- Events arrive at `POST /api/hooks/composio`, verified with the Composio webhook secret (`NEST_COMPOSIO_WEBHOOK_SECRET`,
  standard-webhooks HMAC with a timestamp tolerance), deduplicated by event id, bounded to the existing 64 KiB body
  limit, then delivered exactly as a webhook run (same access checks, pausing and Switchyard post).
- Nest never creates or changes the Composio project's webhook subscription itself (one subscription per Composio
  project; a dev install must not hijack production). Each trigger instance Nest creates carries its own `egress_url`
  (`<request origin>/api/hooks/composio`), so installs sharing a Composio project deliver to themselves. The operator
  sets `NEST_COMPOSIO_WEBHOOK_SECRET` from the project's subscription (V3 payloads, `composio.trigger.message`
  enabled); the kind is offered whenever that secret is set (the server is set up); a creator with no connected app sees "Connect an app first" in place of the fields.
- Composio API facts used are recorded in the plan task, with their source pages.

### 10. The canvas on phones
At ≤ 760 px the canvas is shown (not the list) with the tablet pinch and pan; the rail, legend and zoom buttons are
hidden; the drawer and an open chat are screen width; a `List` toggle in the top bar switches to today's list and is
remembered per browser. Dragging the `+` port is off on touch (the chat picker covers linking). `SPEC.md` and the
Phase 1 design text that said "phones get a list" are updated.

## Not done (needs the owner)
- Engine recurrence (U3) and fork history (U6): OrgOps changes first.
- Live presence on the share pill.
- Re-running old failed naming jobs.
