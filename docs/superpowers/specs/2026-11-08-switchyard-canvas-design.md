# Switchyard canvas: design

Status: draft for approval, revised after a builder review. Date: 2026-11-08.

Design reference: the HTML spike `switchyard-nest-vision.html`. It is a throwaway prototype made of plain HTML, CSS and JS with fake data. It is attached to the design PR and is not committed. Earlier input: the first Switchyard prototype (`Switchyard Canvas.html`) and its handoff notes.

## 1. Intent

Switchyard is a new view in Nest. It shows a person's work with agents and teammates as an infinite canvas of conversations. It is not a node editor.

Every card on the canvas is a real chat (an OrgOps channel). Cards sit in named areas. They can be connected so that one chat's results flow into another. Each card shows who is in the chat, what they are doing right now, what they have produced and what is waiting on you.

The existing chat UI and huddle UI stay as they are. Switchyard is a more powerful view on the same chats, not a replacement. A chat started anywhere in Nest can appear on a canvas and gain the extra canvas-only data there.

### Why

The problems come from the team, mostly Vitaliy's notes:

- **The chat sidebar stops working as it grows.** This is true in ChatGPT, Claude, Gemini and Nest alike.
- **Multi-agent work is hard to follow.** Scrolling one long thread with three agents in it is cognitively overloading.
- **Agents are a black box.** Their output is invisible unless deployed, and what they touched (apps, files, repos) is hidden.
- **Agent status is hard to follow,** and long tasks hang without anyone noticing.
- **Real work has shape, and nothing shows it.** Examples:
  - a marketer's linear flow: podcast → shorts → blog → LinkedIn
  - an engineer's loop: incident → PR → deploy → monitoring → incident
  - a "software factory" of repeatable, triggered pipelines
  - side discussions forked from a main thread

The first prototype looked like n8n: nodes, wires and a "Run all" button. This design keeps the benefits of a spatial view and drops the automation-editor feel.

## 2. Goals

1. **See everything at a glance:** one canvas shows many chats, their state and what needs you. That works with 30+ agents and 50+ loose chats.
2. **Make agents visible:** for each chat, show
   - live status
   - a "quiet for N min" signal for possible hangs, with a Nudge button
   - what it produced (files, drafts, PRs)
   - which apps it used, and whether anything changed outside Nest
3. **Give work its shape:**
   - areas group related chats
   - links hand results from one chat to the next
   - forks split a side discussion off a message
   - schedules and triggers start work on their own
4. **Share context without copying it:** canvas notes and files, area notes and files, and areas that link another area's context instead of duplicating it.
5. **Set up agents per task without touching their defaults:** extra skills, a different model, narrower or wider app access, extra instructions, and where the work runs (including sandboxes).
6. **Keep simple things simple:**
   - **A one-off email stays a plain chat.** It never has to be placed on the canvas.
   - **Advanced setup stays out of the way.** It sits behind a single collapsed "Setup" line in each chat.

## 3. Non-goals

1. Replacing the existing chat, project or huddle UIs.
2. Real-time multiplayer editing of the canvas layout: live cursors, simultaneous drags. Shared canvases sync, but not live (see Phase 1).
3. Restricting which agent can invite which agent. OrgOps has no such limit and v1 does not add one. Revisit after v1.
4. A template marketplace or reusable flow templates. These come later, if at all.
5. A phone-first canvas. Phones get the canvas with less chrome, and a list behind a `List` toggle (see Phase 1).

## 4. Anti-goals: it must never become these

1. **An automation editor.** It has no "Run" or "Run all" buttons, and agents, inputs and sandboxes are never boxes wired together on the canvas. Agents live inside chats.
2. **A whiteboard.** It has no freehand drawing, sticky notes or shapes. Areas and chats are the only objects.
3. **A dumping ground.** Chats are not placed automatically. The canvas stays curated, and unplaced chats wait in the Loose chats pile.
4. **A visual copy of n8n, Figma or tldraw:**
   - **Background:** no dot grid. Use Nest's own texture, the woven twigs from the spike.
   - **Areas:** rounded "nests", not dashed rectangles.
   - **Chrome:** Nest brand tokens, fonts and characters.

## 5. Constraints

- **The OrgOps submodule** (`vendor/orgops`) is never edited or patched. Engine improvements are proposed upstream first, then adopted through a reviewed submodule bump (see section 10).
- **Nest keeps its boundaries:**
  - `apps/api` holds Nest routes and never reads the engine DB.
  - `packages/orgops-client` handles all engine HTTP.
  - `packages/db` holds product tables with numbered migrations from `011` on.
  - `packages/schemas` holds product types.
- **OrgOps stays the authority** for humans, permissions, channels, events, files, secrets, runners and execution. Canvas data is product state and never changes engine data without an engine API call.
- **Use what exists:**
  - **Chats:** projects and chats. A card points at an engine channel, plus the Nest project when there is one.
  - **Messages, uploads and mentions:** the existing message send path (`POST /api/messages` with mention targeting), the 20-file attachment uploads, and mention notifications.
  - **Voice rooms:** huddles.
  - **Apps:** app connections (Composio) and their per-agent grants.
  - **Models:** the model picker data.
  - **UI:** the assistant-ui chat module and shared avatars and tokens.
- **Process (AGENTS.md):**
  - **Where checks run:** full builds, test suites and browser checks run in CI or on a separate build runner, never on the production VPS.
  - **Commits:** conventional commits.
  - **Screenshots:** only as PR attachments, never committed.
  - **Docs:** SPEC.md and ROADMAP.md are updated with each phase.
- **Release:** each phase ships behind an instance setting (the flag `NEST_ENABLE_CANVAS`, or a product setting) until it is accepted.
- **Engine version:** plan against the OrgOps revision the parent repo pins (`7406b6a`). It includes scheduled-trigger validation and voice transcription. A local checkout may sit at a different commit; that does not change the target.

## 6. Concepts

| Concept | What it is | Backed by |
|---|---|---|
| **Canvas** | A named infinite surface. It is private or shared with chosen people (edit or view). A person can have many canvases. | Nest table |
| **Area** | A named, rounded region that groups cards. Membership is by position: a card belongs to the smallest area containing its centre. Areas can be drawn, renamed, moved (cards move with them), resized, or made from a selection of loose chats. | Nest table |
| **Card** | A chat placed on a canvas: position, width and area. The same chat may appear on several canvases. | Nest table → engine channel |
| **Loose chats** | Chats you are part of that are not on the current canvas. Newest first, with search, filters (needs you, agent, age) and bulk archive or "make an area from these". Archive here is a per-person hide, not an engine archive. | Nest per-human state + engine channel list |
| **Context** | Notes and files that every chat in a canvas or area can see. Agents read it as files. A chat gets context only from its **home area**: the canvas and area where a member of the chat first placed it. That means the home canvas's context, then the home area's, then any context that area links. Placing the chat on other canvases shows the card there but adds no context. Home can be moved by any chat member. Because agents may repeat what they read, home-area context counts as visible to everyone in the chat. | Nest table + file storage |
| **Linked context** | An area can use another area's context, on this canvas or another one it can read, instead of copying it. One level only, with no chaining. Example: a "Brand kit" area used by "Launch content" and "Teams plan pricing". | Nest table |
| **Link (hand-off)** | A directed connection between two chats. It has three settings. **What** passes along: results and files, a short summary, or the whole conversation. **When** it passes: each time the source finishes something, after you approve, or only when you press Send now. **Who** picks it up in the target: an agent, or nobody (it is just context). Links can be paused, renamed and disconnected. They belong to the channel pair, not to a canvas, so moving cards never changes behaviour. | Nest table + Nest delivery worker |
| **Fork** | A new chat started from a message in another chat. It is linked back, optionally with "findings flow back". | Nest table + new engine channel |
| **Schedule / trigger** | Runs an agent in a chat on a timer (once, daily, weekdays, weekly on chosen days, monthly, every N minutes), when something happens in an app, or when a webhook is called. Each run happens in that same chat. Missed runs go to Needs you. | Nest table + OrgOps scheduled events |
| **Needs you** | Chats waiting on the current person: approvals, reviews, picks, mentions and missed runs. Has Approve and Request changes where they apply. | Derived from existing mentions and reviews plus new canvas sources |
| **Quiet** | An agent whose turn started but has gone silent for longer than a threshold. It is shown as a possible hang with a Nudge button. | Derived from engine turn events (Nest #74 classification) |
| **Setup (per chat)** | Extras for one agent in one chat: model, skills on or off, skill packs, app access level, extra instructions, where it runs. The agent's defaults stay unchanged elsewhere. | Phase 4; needs upstream engine support |
| **Sandbox** | A fresh, isolated machine for one chat's work. It has an image, CPU and memory, internet (off, listed sites, on), allowed secrets, and how long it is kept. It can be the default for a whole area. | Phase 4; new runner capability |
| **Repo footprint** | For engineering chats: which repos a chat works in, with lines added and removed. Each repo can be added or removed for the chat. | Phase 4 |

## 7. What the spike settled

These interactions were tried in the spike and accepted. The builder should follow them unless they turn out to be infeasible.

**The canvas**
- **Semantic zoom:** below about 50% zoom, cards show only a large title, faces and a needs-you or quiet marker. Areas show a summary such as "2 need you · 3 moving".
- **Opening a chat** happens in place, enlarged over the canvas. On a desktop-width screen that is up to four floating, non-modal chat windows with one message box in the active one and no dimming (see [chat windows](2026-11-19-canvas-chat-windows-design.md), a deliberate departure from the mockup at the owner's request); phones keep the full-screen focus chat. A split-screen mode keeps the canvas usable on the left with the chat on the right. "Open in the regular chat view" leaves the canvas.
- **Inside an open chat, from the top:**
  - **Header:** the title and who is in the chat.
  - **"Where it stands" digest:** what is waiting on you, with Approve and Request changes buttons where they apply.
  - **One collapsed Setup line:** agents and models, where it runs, schedule, connections, repos, and apps with a count of changes made outside Nest. Expanding it shows the details: links, repos, agent chips, the sandbox terminal, and app chips that filter the timeline.
  - **Per-participant filter**, then the messages, then the reply box.
- **Agents in a chat:** each agent's row shows its live activity, including the app it is using, plus any subagent progress such as "3 of 4 subagents done".
- **App activity in the timeline:** each app action is a slim line, for example "Pom read the thread from billing@kettle.co · Gmail". Actions that changed something outside Nest are tagged "changed". The step details expand on click.

**Adding things**
- **Inviting agents:** drag an agent onto a chat to invite it, or drag its face off a card to remove it. Agents can also bring in other agents; a card shows "via Moss" when that is known.
- **The pinned agent tray** shows suggested agents for the selected chat, and "All 30" opens a searchable picker with filters (yours, team, by area).
- **Files:** drop on a chat to post them in it, on an area to add them to its context, or on empty canvas to attach them to a new chat. The paperclip button does the same in the reply box and the bottom box.
- **Voice:** the mic in the bottom box and in each reply box records, then shows the transcript to edit before sending. The voice note is sent with the text. The huddle button starts the existing Nest huddle.

**Links and schedules**
- **Connecting chats:** a visible **+** handle on a card's right edge can be dragged onto another card, or onto empty canvas to create a "next step" chat. The connect button on cards and in chats opens a searchable chat picker. Both open the Hand-off panel, which ends with one plain-language summary sentence.
- **Schedules:** the clock button in a chat opens the schedule and trigger panel. Typing "every Monday at 9 …" in the bottom box detects a schedule and shows it as a removable chip. The top-bar "Scheduled" list groups jobs into Missed, Starts when something happens, Next 24 hours, Later and Paused, and can filter to jobs set by agents.

**Navigation and sharing**
- **Search** (Ctrl/Cmd+K) covers canvases, chats on this canvas, chats elsewhere, and areas.
- **Sharing:** the canvas share control offers Private or Shared with chosen people. Sharing covers the layout, areas, links and context only. Each chat keeps its own engine access, so a teammate who isn't in a chat sees a locked card.

## 8. Phases

Each phase ships on its own, behind the flag, with SPEC.md and ROADMAP.md updated. Later phases build on earlier ones, but none waits on a later one. Phases 1–3 need **no OrgOps change**. Phase 4 depends on upstream work and starts with the proposals in section 10.

### Phase 1: Canvas of chats (see everything)

User outcome: I can lay out my chats on canvases, see their state at a glance, find anything fast, and open a chat without leaving the canvas.

Scope:
- **Canvases:**
  - **Basics:** create, rename, switch, delete.
  - **Sharing:** private, or shared with chosen people as edit or view.
  - **Sync:** shared canvases refresh on focus and every few seconds while visible. Each item has a version, and conflicting edits are rejected with a refresh.
- **Areas:**
  - **Editing:** draw, rename (double-click), move with their cards, resize.
  - **From the pile:** "New area from these" in Loose chats.
- **Cards for existing chats (channels and projects):**
  - **What a card shows:**
    - title and participants
    - each agent's live status (working, waiting on you, done, quiet)
    - artifacts (attachments from messages)
    - last activity and needs-you
  - **Moving cards:** drag to move. Moving a card into or out of an area changes only its area.
- **Loose chats pile** with search, filters, multi-select, bulk archive (hide), "place on canvas" (drag or button) and "new area from these".
- **Bottom box:** starts a chat exactly as Nest's own "new chat" does today (chat-first project creation, including mentions and background naming). The new chat is placed at the viewport centre and opens beside the canvas (on a view-only canvas or in the phone list it opens in focus and stays in the pile). So "plain" means "not on the canvas", not a different kind of chat.
- **Opening a chat** in place, in split screen, or in the regular chat view. The chat inside reuses the existing assistant-ui chat module.
- **Needs you:** a list in the top bar with jump-to.
- **Quiet:** "quiet for N min" with Nudge. Nudge posts a targeted message to the agent through the normal send path.
- **Agents on cards:**
  - **Inviting:** drag from the tray onto a card, using the existing subscribe and member APIs.
  - **Removing:** drag a face off a card.
  - **Finding them:** the pinned tray and the "All agents" picker.
- **Search** (Ctrl/Cmd+K) across canvases, cards, loose chats and areas.
- **Display and devices:**
  - **Zoom levels:** semantic zoom, zoom controls and Fit.
  - **Theme:** light and dark.
  - **Input:** mouse, trackpad and touch (pinch and pan) on tablets.
- **Phones:** the canvas, as the mockup shows: tablet pinch and pan, no navigation rail, legend or zoom buttons, the drawer and an open chat at screen width (one chat at a time), and no `+` port drag on touch (the chat picker connects). A `List` toggle in the top bar swaps in a list with Areas → chats, Needs you and Loose chats, remembered per browser. (Updated 2026-11-19: this first said phones get only the list.)
- **Locked cards:** a teammate on a shared canvas who isn't in a chat sees a locked card. The title is hidden; it shows "Private chat" and the owner.

Data (Nest product DB):
- `product_canvases(id, owner_id, name, visibility, version, created_at, updated_at)`
- `product_canvas_members(canvas_id, human_id, role)`
- `product_canvas_areas(id, canvas_id, title, x, y, w, h, tint, version, …)`
- `product_canvas_cards(canvas_id, channel_id, project_id?, x, y, w, version, placed_by, placed_at)`, unique per (canvas, channel)
- `product_loose_hidden(human_id, channel_id, hidden_at)`

API: `/api/canvases` and its descendants (CRUD, members, areas, cards, the loose list). All chat data comes from engine HTTP and WS with the human's own credentials, so card visibility follows engine access.

Acceptance:
- **Scale:** a canvas with 150 cards and 30 agents pans and zooms smoothly on a mid-range laptop, with off-screen cards culled. The pile handles 200+ chats.
- **Reload and history:** reloading restores the canvas, view position and open chat.
- **Sharing:**
  - A view-only member cannot move anything.
  - A member without channel access sees a locked card and cannot read its title or messages.
- **Quiet:** it never claims "done" from elapsed time alone. It uses the existing queued, running, interrupted and unavailable classification.
- **Engine data:** no engine data is changed by layout actions.
- **Real-boundary tests:** colocated tests run against real Nest-to-OrgOps handlers with temporary DBs.
- **Browser checks:** CI covers desktop, tablet and phone.

Out of scope for Phase 1: links, forks, context, schedules, app usage, setup and sandboxes.

### Phase 2: Context, files, voice and app visibility (agents stop being a black box)

User outcome: Shared knowledge lives in one place. I can drop files and talk to my chats. I can see which apps an agent used and whether it changed anything outside Nest.

Scope:
- **Context:**
  - **Notes and files** for the canvas and for each area, edited in a context panel. Drop files on an area to add them.
  - **Linked context:** "Use context from another area" (this canvas or another readable canvas), shown as "↳ Brand kit" chips on the area plus a dotted line on hover. Source areas show "Used by …".
  - **Home area:** the first placement of a chat by one of its members becomes its home. Any chat member can move home with "Use this area's context". Dropping a chat into an area, or adding notes to an area that holds chats, shows a one-line warning: everyone in those chats, including through their agents, can see this. Cards that are not home show "context from <home area>".
  - **Linked context and access:** linking another area's context requires read access to that area. Once linked, it is visible to everyone in the chats of the home area. If the person who linked it loses access, the link shows "unavailable" and agents stop receiving it.
  - **Agents read context** through a Nest-provided read-only skill or tool that returns the notes and files for the agent's current chat (canvas → area → linked areas). Context is pulled on demand. Changing context never posts a message and never wakes an agent. The builder may pick another mechanism that keeps these properties.
- **Files on the canvas:**
  - **On a chat:** dropping files posts them as a message with attachments, through the existing upload path.
  - **On empty canvas:** the files attach to a new chat in the bottom box.
- **Voice input** in the bottom box and in each reply box: record, show the transcript to edit, then send. The voice note is attached as audio.
  - **Transcription:** use the OrgOps voice and transcription service when it offers one-shot transcription. Otherwise the builder proposes a provider, and the audio still never leaves the existing authenticated paths without the owner's consent.
  - **Huddle button** in the chat header, using the existing huddles.
- **What app activity is stored:** for each call, the tool name, the time, the agent, read or change, and a short label taken only from non-content arguments (recipient address, repo, file or folder name, channel name). No message bodies, documents or results are stored. The expandable details show only that. Activity is visible only to members of the chat, on any canvas. It is kept as long as the existing product audit.
- **Apps used in a chat:**
  - **On the card:** app logos, plus a live ring when an agent is using one right now.
  - **In the chat:** an "Apps here" bar with counts and "N reads · M changes outside Nest", and app activity lines in the timeline with expandable details.
  - **Data sources:**
    - Nest already proxies every connected-app call (`/api/integrations/skill/execute`) and audits it.
    - Command-line skills appear as engine `tool.*` events in the channel.
- **Matching app calls to chats:** the missing piece is which chat a proxied app call came from.
  - **Interim:** match the call to the agent's active turn by time. When more than one turn could match, show "unattributed" rather than guess.
  - **Exact:** after upstream proposal U2 lands.
  - **Wrapped agents (Codex, Claude Code):** only reported commands appear. Each chat shows that limitation plainly.
- **Canvas sharing** extends to context, so shared canvas members see and edit it according to their role.

Data:
- `product_chat_home(channel_id PRIMARY KEY, canvas_id, area_id, set_by, set_at)`
- `product_canvas_context(scope_kind, scope_id, notes, version)`
- `product_canvas_context_files(…)`. Storage: product file storage under `files/`, with size limits. The builder may keep files in the engine file API if it can hold files that are not bound to a channel.
- `product_area_context_refs(area_id, source_area_id)`
- An index of app activity per channel, if needed for speed.

Acceptance:
- **Context and access:**
  - An agent only ever receives the context of its chat's home area.
  - A chat placed on someone's private canvas outside its home never leaks that canvas's notes.
  - Linked context stops when the linker loses access.
- **No agent wake-ups:** context edits never wake agents.
- **Uploads:** file drops reuse the 20-file limit and the upload progress UI.
- **Honest app activity:** an action shows "changed" only when the call could write. The builder classifies the tools. Unknown tools count as "changed".

### Phase 3: Flows (links, forks, schedules, triggers)

User outcome: My marketing flow and my incident loop run as connected chats. Work starts on a schedule or when something happens. I approve where I want to, and I'm told when something didn't run.

Scope:
- **Links (hand-offs)** with what, when, who, a label, pause and disconnect, created by:
  - dragging the **+** handle
  - the chat picker
  - "a new step after this one"
- **Who posts hand-offs, scheduled runs, webhooks and fork seeds:** work with no person present is posted by a dedicated Nest system identity, a service agent named "Switchyard" that never takes turns. Nest posts with its existing service credential (the runner token used today for subscribe and directory calls), never with a stored human session. The message says who set it up, for example "Hand-off from Blog post · set up by Lena". The service agent joins a target chat as a visible participant when the link or schedule is created. Before planning, the builder verifies against `7406b6a` that the engine accepts such posts from a non-running service agent. If it does not, that becomes upstream proposal U7 and these Phase 3 parts wait for it.
- **Link permissions:**
  - **Creating:** anyone who can read the source chat and post in the target chat.
  - **Seeing:** members of either chat see it as a chip, and on any canvas where both cards are placed.
  - **Pausing or disconnecting:** the creator, or any member of the target chat.
  - **Approvals:** "After I approve" approvals go to the creator's Needs you.
  - **Access checks:** at each delivery, Nest checks that the creator can still read the source and post in the target. If not, the link pauses and the creator is told.
- **Hand-off delivery:** a Nest worker watches source channels through the engine WebSocket and HTTP catch-up for finished agent turns that produced results (`agent.turn.completed` plus new messages or attachments). It then posts into the target chat using the normal send path, targeted to the chosen agent:
  - **Results and files:** the result text plus attachments.
  - **Summary:** a short summary from the instance default model. It is labelled as a summary.
  - **Whole conversation:** a transcript file.
  - **"After I approve":** the hand-off shows up in Needs you first.
  - **Delivery guarantees:**
    - **At most once:** there are idempotency keys per source turn.
    - **Loop guard:** loops are allowed, for example incident → … → incident, so there is a cap on hand-offs per link per hour. Hitting the cap pauses the link and goes to Needs you.
    - **Self-check:** the worker never hands off its own posted message.
- **Forks:**
  - **What a fork is:** the same kind of chat as the bottom box creates. Its members start as the person forking plus the agent who wrote the message, and more can be added through the normal invite flow. The summary seed is visible only to them.
  - **Start a fork:** "Fork from here" on any message creates a new engine chat seeded with a summary and a link to the source message. The fork appears next to its parent.
  - **"Findings flow back":** a link back to the parent, which can be paused.
  - **History:** copying full history is out of scope unless upstream adds it (U6).
- **Schedules and triggers:**
  - **Time-based:** once, daily, weekdays, weekly, monthly, every N minutes.
  - **How runs are delivered:** Nest stores the repeat rule and books the next run as an OrgOps one-off scheduled trigger (`agent.scheduled.trigger` with `deliverAt` and `targetAgentName`). Each run happens in the same chat.
  - **App events:** use Composio triggers where available (new email, new Sentry issue, new PR, Slack message, Stripe event). If none exists, the trigger kind is not offered for that app.
  - **Webhook:** a per-trigger secret URL served by Nest that posts the payload to the chat.
  - **Missed runs:** a run counts as missed when no agent turn starts within a grace period after it was due. Missed runs go to Needs you with Run now.
  - **Agent-made schedules:** schedules that agents create through the existing OrgOps tools show in the Scheduled list with "set by Pom".
  - **Typing a schedule:** "every Monday at 9 …" in the bottom box is detected and shown as a removable chip. Parsing is deterministic and checked before saving; it is never guessed silently.
- **Approve and Request changes** on gates. Reuse `product_reviews` where the chat is a project task. Otherwise post the decision as a message.

Data:
- `product_links(id, from_channel, to_channel, what, when, who_agent, label, on, created_by, version)`
- `product_link_deliveries(link_id, source_turn_id, status, target_event_id)`
- `product_forks(child_channel, parent_channel, parent_event_id)`
- `product_schedules(id, channel_id, agent_id, prompt, rule_json, timezone, on, created_by, next_event_id, next_at)`
- `product_schedule_runs(…)`
- `product_triggers(…)` (app event and webhook)

Acceptance:
- **Link safety:**
  - A paused link never delivers.
  - Disconnecting never deletes what was already delivered.
  - Hand-offs respect the target chat's access. The posting identity must be allowed to post there, or the link cannot be created.
- **Restart and outages:** a restart or engine outage never double-delivers and never loses a scheduled run silently.
- **Time zones:** schedules use the creator's time zone, and the UI shows it.
- **Webhook security:** webhook URLs can be rotated, and the payload size is bounded.

### Phase 4: Per-chat agent setup, sandboxes and repos (software factory)

User outcome: I can give an agent extra skills, a stronger model, different app access or extra instructions for one chat. I can run the work in an isolated sandbox I set up from the canvas, and see which repos it touches.

Scope:
- **Agent panel:** click an agent anywhere. It has two tabs:
  - **Defaults** is read-only and links to Agents, where defaults are managed today.
  - **In this chat** sets:
    - model (with speed and cost hints from the model picker data)
    - default skills on or off, plus extra skills
    - skill packs (superpowers, wave)
    - app access per app (Off, Read, Drafts, Full)
    - extra instructions
    - where it runs
- **Showing changes:** changed items get a green dot, a card shows a dot next to the agent's name, and Reset returns to the defaults.
- **Who can raise app access:**
  - **Lowering** access is always allowed.
  - **Raising** access on someone else's agent asks its owner first, consistent with today's owner-managed app grants.
  - **Enforcement:** Nest enforces per-chat app access in its integration proxy once U2 is available.
- **Where it runs:**
  - **The choices:**
    - the agent's default runner
    - another runner
    - an existing sandbox on the canvas
    - a new sandbox (image, CPU, memory, internet, secrets, lifetime)
  - **Area default:** "Use for every chat in this area".
  - **Terminal:** the sandbox output is visible in the chat, read-only.
- **Subagent progress** for skill packs, from reported subagent events.
- **Repo footprint:** a strip on cards (web, api, mobile, infra) with lines added and removed. The repo chips in Setup add or remove a repo for the chat; the sandbox gets a worktree of each. A repo with changes cannot be removed until they are reverted.

Engine dependencies: U1 (per-chat agent overrides), U2 (chat identity in tool calls) and U5 (per-chat execution placement and sandboxed runners).
- **Who writes them:** we do, as pull requests to `camplight/orgops`. They are part of the Phase 4 plans and land in Nest through a reviewed submodule bump.
- **Where sandboxes run:** on separate runner host(s) we operate, never on the production VPS. Each sandbox is a container built from a chosen image, running an OrgOps runner registered with the engine and placed on the chat through U5. Nest's Docker image is the base for the runner part.
- **Host sizing:** the host is sized for a fixed number of concurrent sandboxes. When it is full, new sandboxes wait in a visible queue. They never silently fall back to an unsandboxed runner.

Nest-only parts (UI, stored preferences, area defaults, repo strip from GitHub data) can start earlier. Settings that the engine cannot yet apply are shown as unavailable; they are never stored as if they worked.

Acceptance:
- **Defaults stay put:** per-chat settings never change an agent's defaults or affect other chats.
- **Sandbox limits are enforced, not just displayed:**
  - Internet off really blocks the network.
  - Secrets not allowed are not present.
  - Lifetime cleanup happens.
- **Repo safety:** removing a repo with uncommitted changes is refused.

### Later (not planned yet)

- reusable flow templates
- live multiplayer cursors on a canvas
- "via X" attribution for agent-invited agents (needs U4)
- canvas history and undo
- per-area permissions
- limits on which agents may invite which agents

## 9. Data ownership summary

| Data | Owner |
|---|---|
| Chats, messages, attachments, participants, agent runs, scheduled triggers, runner assignment | OrgOps (engine API only) |
| Canvases, members, areas, card positions, loose-pile hiding, context notes and files, context links, chat links and deliveries, forks, schedules and triggers, per-chat setup preferences, sandbox definitions | Nest product DB (migrations `011+`) |
| App connections, grants, tool audit | Nest (existing) |

Engine state is never changed by moving, grouping or sharing on the canvas. Product records that point at engine IDs tolerate the engine record disappearing: cards for deleted chats show "unavailable" and can be removed.

## 10. Proposals for OrgOps (upstream first)

We write these ourselves as pull requests to `camplight/orgops`, and Nest adopts them through a reviewed submodule bump.

| ID | Proposal | Needed by |
|---|---|---|
| U1 | Channel-scoped agent overrides that the runner applies to turns in that channel: model, extra or disabled skills, extra instructions | Phase 4 |
| U2 | Expose the current channel and turn IDs to tool and skill processes, for example through the environment, so product services can attribute and authorise calls per chat | Phase 2 (exact app attribution), Phase 4 (per-chat app access) |
| U3 | Optional: recurring scheduled triggers in the engine. Nest can manage recurrence itself until then. | Phase 3 (optional) |
| U4 | Record the actor on participant-add events | Later |
| U5 | Per-channel execution placement (sandboxes run on our own separate runner hosts), so a channel's turns run on a chosen runner instead of the agent's assigned runner, plus runners started from a container image as sandboxes | Phase 4 |
| U6 | Optional: fork a channel with copied history | Phase 3 (optional) |
| U7 | Only if needed: let a product service agent post into a channel without taking turns | Phase 3 (only if the check in Phase 3 fails) |

## 11. Risks

- **Performance:** with many cards and live events, Phase 1 must cull off-screen cards and coalesce WS updates per card.
- **Attribution and change counts could mislead:** the interim time-based matching can be wrong when turns overlap. Show "unattributed" instead of guessing. Treat unknown tools as "changed".
- **Hand-off loops and duplicates:** guarded by idempotency per source turn, rate caps and the self-check.
- **Cost:** summaries for hand-offs and forks, and stronger per-chat models, cost money. Show the model or cost hint where the choice is made. Summary usage is attributed to the person who created the link or fork.
- **Scope creep toward an editor:** reviewers check new UI against the anti-goals in section 4.

## 12. Testing and rollout

- **Tests:** colocated unit tests, plus real Nest-to-OrgOps boundary tests with temporary databases (`npm test`, and `npm run test:engine` where engine behaviour matters). Do not mock away the ownership boundary.
- **Browser suites:** a canvas suite in the style of `test:ui:projects`, covering desktop, tablet and phone, reload and history, and sharing permissions. Run in CI, not on the production host.
- **Timing:** Phase 1 starts now, in parallel with the ROADMAP reliability work. It is UI and product data only behind the flag, and it does not delay or change any reliability item.
- **Release flag:** each phase sits behind the canvas flag. The flag is removed after the phase is accepted in production.
- **Production check:** the specific flow is verified after deployment, per the ROADMAP guardrails.

## 13. Left to the builder

- **Rendering approach:** plain DOM with CSS transforms, as in the spike, or a library. A library is only acceptable if it doesn't impose its look (section 4) and keeps the bundle reasonable.
- **API shape:** exact route shapes, table columns and indexes.
- **How agents read context:** within the constraints in Phase 2.
- **Sync:** the shared-canvas sync interval and the conflict UI.
- **Thresholds:** for "quiet" (the spike used about 20 minutes), the missed-run grace period, and the hand-off rate cap.
- **Transcription provider:** if OrgOps has no one-shot transcription.
- **Tool classification:** which app tools count as read and which as change.
- **Phone layout** details of the canvas and its List toggle.

## 14. Calls made in this document (please check)

0. (Decided by you) Context comes only from a chat's home area. We write the upstream OrgOps changes. Sandboxes run on separate runner hosts we operate. Phase 1 starts now behind a flag.
1. Canvas sharing covers layout, areas, links and context. Chat access always stays with the engine, and non-members see a locked card with the title hidden.
2. Links belong to the chat pair, not the canvas. Moving or removing cards never changes hand-off behaviour.
3. "Archive" in the Loose chats pile is a personal hide, not an engine archive.
4. Linked context is one level deep, with no chaining.
5. Context is pulled by agents on demand. Editing it never posts messages or wakes agents.
6. Phones get the canvas with less chrome, and the list as a `List` toggle (first a list view only; changed 2026-11-19).
7. Shared canvases sync by refresh and versioning in Phase 1, not live multiplayer.
8. Unknown app tools count as "changed outside Nest".
9. Raising app access on someone else's agent asks the owner. Lowering it never does.
10. Phases 1–3 need no engine changes. Phase 4 waits on upstream U1, U2 and U5 for the parts the engine must enforce.
11. Background posts (hand-offs, scheduled runs, webhooks, fork seeds) come from a visible "Switchyard" service agent and name the person who set them up. A stored human session is never used.
12. Link permissions as in Phase 3. A link pauses when its creator loses access to either chat.
13. App activity stores only tool name, read or change, and a short label from non-content arguments. It never stores bodies or results, and only chat members see it.
14. The bottom box and forks create the same chat-first projects as the rest of Nest. A fork starts with only the person forking and the agent who wrote the message.
15. Summary usage is attributed to whoever created the link or fork.
16. Until a Figma design exists, the HTML spike is the visual reference for PRs.
