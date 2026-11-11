# Nest implementation spec

Nest is the product layer around OrgOps. OrgOps is a pinned, untouched Git
submodule at `vendor/orgops`, sourced from https://github.com/camplight/orgops.
Nest does not keep a second copy of the engine or apply source patches.
The reviewed engine pin is upstream main `7406b6a`, including OrgOps #76
voice/realtime support, #79 restart metadata, #80 byte-budget compatibility,
the merged security fixes and #82 realtime maintenance environment handling.
It also includes #83 runner socket wakeups with HTTP catch-up, #84 private invite
ownership, #85 price upserts, #86 non-conversational format diagnostics and optional
chat staging, #89 bounded late-event continuation/SYNC injection suppression,
and #88 upstream trace pagination (Nest retains its own chat interface).
The previously deployed pin is `eb2e19d` from OrgOps #78; merging the dependency
update alone does not install it on existing hosts.
Personal onboarding binds the workspace returned by OrgOps instead of requiring
the requested path. A reservation marker reconciles member-agent creation after
a lost response; the first binding stores its identity/path with compare-and-swap.
Existing bound agents still reject ownership, identity and workspace changes.
It retains multi-agent message routing and native workspace-file uploads and adds
human invitations into channels, engine LLM usage reporting, agent copy/move and
federation APIs. External engines must use this revision for the current adapter.

This revision preserves the deployed memory protections. It caps persisted tool
results, compacts default event searches and bounds normal event-listing reads
before historical blobs enter JS: at most 64 KiB per history payload and 1 MiB
of UTF-8 payloads per page. Runner polls return complete inputs up to 1 MiB, acknowledge
only the prefix that fits and leave later requests pending; omitted individual
inputs never trigger agents or broaden targeting. The engine returns
`payloadTruncated` stubs with original byte sizes while retaining IDs, order, receipt delivery and stored history. Nest shows
an explicit retained-content notice for omitted chat messages. Explicit SQLite
exports retain their upstream full-dump behavior. Native release builds run the
real-engine 280 MiB-history/256 MiB-heap and void-result regressions in CI before
packaging; production installs prebuilt artifacts without running stress tests.
Response handling comes from merged OrgOps #86/#89, replacing the earlier closed
OrgOps #77 proposal. Format exhaustion emits `agent.turn.phase` diagnostics rather
than a new chat message. Normal mid-turn messages remain immediate; optional
`stageUntilTurnSettled` discards staged drafts on retry. Late events can extend a
settled turn within a separate bounded budget, while synchronous process results
are suppressed from duplicate mid-turn injection. This is not a blanket ban on
agent collaboration or a claim that all autonomous loops are impossible.
Engine migrations `046`–`050` add workspace publications, file-backed event
payload metadata, a lifecycle lookup index and invite ownership. Large new
payloads live under the persistent engine data directory; backups must include
those files along with both databases. A pre-open rollback restores the old DB
pair; do not run an old engine against the upgraded schema after accepting writes.

Realtime model capabilities and voice HTTP/WS APIs remain owned by OrgOps and
are available through Nest's existing authenticated gateway. Nest's Huddle UI
uses these APIs as described below. No existing agents/models are reconfigured.
For native installations, opt in with `--enable-livekit` or private
`NEST_ENABLE_LIVEKIT=1`. The installer provisions checksum-pinned LiveKit as
`nest-livekit.service`, with generated private credentials and a Caddy TLS endpoint
on the existing domain's port 8443. Signaling stays loopback on 7880; media uses
7881/TCP and 7882/UDP. External SFU configuration is preserved and requires an
explicit operator migration before enabling the managed service. Reinstall and
rollback preserve the credentials, config and activation marker. LiveKit has a
256 MiB systemd cap and restarts independently of the APIs/runner. Fresh-host CI
checks real synthetic audio between two clients as well as credential reuse,
activation rollback and independent SFU crash recovery; no model calls are needed.

### Project and chat huddles

The chat toolbar opens a Figma-inspired Huddle overlay (case-study `904:254`),
with the recent conversation, existing agent portraits, participant cards, actual
speaker highlights, microphone level, mute/unmute, expand and leave controls.
Mobile uses a full-height overlay and horizontally scrolling participant cards.
Agent invitation labels have 44 px touch targets. Opening or restoring the
conversation starts at its newest messages. The optional voice bundle has its
own loading/cancel/error state so a failed download cannot blank the workspace.
Camera and screen sharing are outside this slice. The reference is a flattened
screen; Nest composes existing dialog, Markdown, attachment and avatar components
using instance branding rather than embedding the screenshot.

The lazy-loaded LiveKit browser SDK joins through `POST /api/voice/rooms/join`
using the human's cookie and the existing Nest gateway. OrgOps remains responsible
for permissions, tokens, voice agents and transcription. No service token reaches
the browser and no engine DB, schema or source changes are required. Read-only
and archived chats cannot join. Config comes from `GET /api/voice/config`; missing
LiveKit configuration, denied microphone access and audio autoplay restrictions
have explicit recovery states. This slice requires the LiveKit room broker.
The HTTP adapter buffers only the small voice-join JSON envelope (16 KiB maximum)
so an upstream 401 is preserved rather than becoming Undici's streaming-body
network error. Upload bodies remain streamed.

Only subscribed native agents with `desiredState=RUNNING` and realtime audio input
are offered for invitation. The human can deselect them before joining; an empty
selection starts a human-only call, without emitting an empty agent invitation
that upstream would interpret as inviting everyone. Model capability is eligibility,
not proof of a successful connection: participant presence and active speaker
state come from LiveKit. Existing models and provider credentials are unchanged.

After media connects, the client emits existing `voice.session.started` and,
when agents are selected, `voice.room.started` events. The broker's stable channel
room name is also the logical room ID, so subsequent joins reuse upstream's
active-call registry. Each browser has a distinct session ID. Leaving emits only
the local session's ending; it never ends other humans' call. OrgOps's existing
last-human-disconnected handling closes agent media legs. Media acquisition,
cancelled permission prompts, connection errors, navigation, tab closure and
terminal disconnects all release the client's owned tracks and audio elements.

Transcripts are the actual upstream `message.created` events with voice metadata,
also retained in normal chat. Nest does not fabricate partial transcription or
record a second microphone stream. A human-only huddle has audio but no automatic
transcript; spoken AI replies/transcription require an appropriately configured
agent and its provider credentials. The level display measures the local mic.

`npm run test:ui:huddle` exercises the real Nest/engine gateway with synthetic
tenant data, mobile/desktop views, eligibility, cancellation and denied capture.
Set `NEST_HUDDLE_TEST_URL` to a disposable local LiveKit server to additionally run
the two-browser media, mute, transcript-event and independent-leave test. Its
test-only credentials are fixed fixtures; never point it at production. Session
unit tests cover late microphone acquisition, join failures and reconnect cleanup.
Linux product CI starts and removes a bounded Docker fixture using the native
installer's pinned LiveKit version, so the real browser media test runs there too.
This test container does not change native production's systemd topology.

Engine migration `039` consolidates stored `system_instructions` and
`soul_contents` into `soul_contents`, in that order with a blank line between
nonempty values, and removes `soul_path`. The HTTP adapter accepts Nest's existing
`systemInstructions` input as an alias of `soulContents` on agent creation and
settings updates, and returns the alias on agent list/detail reads. Explicit
`soulContents` takes precedence when both are supplied; the alias represents the
complete prompt, not a separate instruction section. This preserves personal
onboarding, saved management helpers, settings and creation-retry reconciliation.
No engine DB access or runtime source patch is introduced.

Engine migrations `040`–`045` add usage/pricing and federation storage. Nest does
not yet display the new engine billing/federation screens or configure peers.
Default `system` agent seeding is opt-in via `ORGOPS_SYSTEM_AGENT_MODEL`, requires
a configured provider key, and applies only when no agents exist. Nest does not
set this option or replace existing agents/models during an upgrade.

This engine revision includes Google Workspace authentication (migration `037`),
configured/per-agent skill roots, human-scoped secrets
and delegated private agent ownership. Migration `036` adds empty additional skill
roots and disables owner-secret delegation for existing agents by default. Nest
continues using its explicit runtime project root. These engine API capabilities
are available through the gateway; upstream UI changes do not automatically alter
Nest-owned screens.

Chat activity uses trusted OrgOps `agent.lifecycle.started` / `wrapper.lifecycle.started`
records as restart boundaries. An unfinished turn that predates its agent's next
lifecycle is shown as **Interrupted · outcome unknown**, without animation or old
progress text; Review request focuses the original message without resending it.
A completion/failure removes the indicator; newer turns keep their own activity.
Heartbeats, availability, wall-clock age and settings updates never establish an
interruption or successful completion. A failed lifecycle read leaves chat usable
and labels unverified ongoing activity unavailable. Only lifecycle timestamps are
kept outside the current room; lifecycle text never enters its timeline or export.
The current engine is unchanged: two bounded, human-authorized lifecycle queries
provide compatibility until upstream agent `lastStartedAt` metadata is available.
No events/receipts are rewritten and no unknown work is automatically retried.

## Ownership

| Layer | Owner | Location |
|---|---|---|
| Admin/user interfaces and branding | Nest | `apps/admin-ui`, `apps/user-ui`, `apps/nest-brand` |
| Product API / backend-for-frontend | Nest | `apps/api` |
| Engine HTTP/auth compatibility adapter | Nest | `packages/orgops-client` |
| Product settings, projects, tasks, reviews, community and audit persistence | Nest | `packages/db`, `.nest-product/nest.sqlite` |
| Product schemas | Nest | `packages/schemas` |
| Bootstrap CLI | Nest | `apps/cli` |
| Agents, humans, sessions, events, runners, skills, execution | OrgOps | `vendor/orgops` |
| Engine database and runtime data | OrgOps | `.nest-data/nest.sqlite` and `.nest-data/` |

The legacy engine DB path is intentionally retained for existing installations.
It is not Nest's product database. OrgOps remains authoritative for humans,
permissions, agents, channels, events, receipts, files, secrets and runner state.
Nest request handlers never read that database; they use HTTP/WS. Only the
explicit offline migration reads/writes legacy state during upgrades.

OrgOps's engine contract is documented in
[`vendor/orgops/docs/SPEC.md`](../vendor/orgops/docs/SPEC.md). Pinning a new commit
is a deliberate dependency upgrade with lockfile and integration-test review.

## Runtime and processes

`scripts/start-orgops.ts` starts the upstream Hono API using its exported
`createApp` factory and configuration arguments, or starts its original runner.
It sets `ORGOPS_*` environment values from explicit `NEST_*` settings before
loading any engine modules. Engine source is never rewritten.

The launcher keeps the engine database at the existing `.nest-data/nest.sqlite`,
sets a stable absolute runner ID path, and creates `.nest-data/engine` as its
project directory. Built-in skills are copied there on first startup; installed
skills are writable runtime state, not modifications to the submodule. The
engine files directory links to the existing root `files/` directory. Compatibility
links for `.nest-data` and `.orgops-data` preserve standard relative workspace paths.

The product API listens on port 8787 in local development and connects to OrgOps
on loopback port 8788. `ORGOPS_URL` can instead point to an external engine.
`npm run start:api:env` starts both APIs when no external engine is configured;
`npm run start:runner:env` starts the upstream runner and waits for API readiness.
The React development servers proxy HTTP and WS through the product API.

The existing single-container deployment still works: HAProxy listens on 8787,
Nest's product API on 8789, OrgOps on loopback 8788, and the two Vite preview
servers on 4173/4190. The API component launches an internal OrgOps API unless
`ORGOPS_URL` is supplied. The runner is an independently supervised process.
The image includes the submodule source and the parent npm lockfile installs
both product and selected engine workspaces. It never builds the upstream UIs.

Persistent volumes are `.nest-data` (engine), `.nest-product` (product) and
`files` (uploads). Credentials and existing Codex installations remain in engine
runtime storage. Public branding assets remain Nest-owned.

### Production resource protection

The Compose deployment defaults to 1536 MiB container RAM, 2048 MiB combined
RAM/swap, 0.80 CPU and 384 processes/threads, with explicit operator overrides.
Host swap is separately configured; production has approximately 2 GiB total.
Nest logs rotate through Docker's local driver. These are deployment budgets,
not per-agent sandboxes, and do not change the OrgOps source or runner assignment.
API and agents still share a container: an excessive workload can fail or cause a
container restart, but it is bounded before consuming all host RAM/process capacity.
Heavy validation belongs in CI or a separate runner.

An optional operator-installed root-owned systemd watchdog restarts a running
container after three consecutive unhealthy observations. It skips the existing
host deployment lock and limits restart attempts to one per hour, persisted
across container/host restarts. Healthy/starting/stopped/unknown/recreated state
resets the failure streak; unavailable Docker never triggers a restart. It cannot
reboot the host, deploy source, read application databases or print credentials.
Source updates do not install host units or apply Compose limits. See
[resource protection and rollout](../deploy/devops/README.md#host-resource-budgets-and-health-recovery)
and the [2026-10-25 incident](../deploy/devops/INCIDENT-2026-10-25.md).

### Native host installation

`scripts/install-host.sh` is Nest's idempotent production entrypoint on Ubuntu
24.04. It installs checksum-pinned Node/Caddy and pinned agent CLIs from a prebuilt
Linux release, then activates repo-owned systemd units for Nest API, OrgOps API,
runner and Caddy. Caddy serves built UIs and authenticated API/WS/demo routes;
APIs bind loopback through `NEST_BIND_HOST`/`ORGOPS_BIND_HOST`. Source/dependencies
are root-owned; state lives in `/var/lib/nest` and private config in `/etc/nest`.
Saved `/app`, `/home/node`, runner identity, Codex homes and runtime skill paths
remain stable. Native units set absolute `NEST_ENGINE_DATA_DIR` and `NEST_FILES_DIR`;
Nest-owned compatibility links are repointed atomically so retiring an old
release cannot break skills/uploads. Real user directories are never replaced. No upstream code is edited or patched.

On runner startup, Nest's launcher reconciles only the explicitly allowlisted
NestSystem ID through the engine HTTP API. A recognized legacy Codex recipe is
backed up privately under the persistent `codex-runtime/bridge-config-backups`
directory and switched to `/app/deploy/nestsystem-bridge.mjs`. The generated
embedded old-file installer is removed while other setup fields, session scope,
workspace, timeout and credentials remain unchanged. Custom recipes require
operator review; other agents are not rewritten. There is no engine DB access.
Subsequent releases supply the executable without copying code into runtime data.
The bridge resolves symlinks on both sides of its executable-entry check so the
stable `/app` path runs the actual release module. Activation verifies that this
entrypoint rejects missing input rather than silently exiting successfully; this
check starts no Codex process and uses no credentials. Existing failed/silent
requests are not automatically replayed.

The shared Google sign-in control distinguishes an explicitly disabled provider
from a failed, malformed or timed-out availability check. Unavailable checks offer
Retry without resetting password fields or navigating away. Native activation
checks that a previously enabled provider retains its enabled state and domain;
it does not perform an OAuth login or claim Google itself is available.

Native activation preserves the operator's `/etc/nest/runner-paused` marker.
`--pause-runner` and `--resume-runner` change it within the backed-up activation;
the runner unit and restricted restart controller respect it. A paused rollout
checks API/provider/demo availability without requiring or claiming a runner
heartbeat. This permits product updates while an upstream execution fix is pending.
The watchdog continues inspecting the two APIs during that execution pause and
excludes only the runner. API recovery respects the same pause marker, deployment
lock and cooldown; intentionally stopping an API still suppresses recovery.

Whole process trees have separate 320/512/768 MiB API/engine/runner limits within
a 1536 MiB RAM / 512 MiB swap / 80% CPU slice. These are not agent sandboxes.
Re-running the script stages another prebuilt release and snapshots both stopped
DBs; pre-open failures restore the previous pair/config/release. Explicit
same-version Docker import retains source volumes and restart-policy records.
Native restricted host operations reuse this installer; builds remain in CI.
Fresh-VM CI checks install/reinstall, paired-DB recovery, runner identity/heartbeat,
crash recovery, protected demos and a real agent turn with a synthetic provider.

Local CLI upgrades stop all writers before private backups, use registered Linux
supervisors and preserve credentials. Post-mutation local failures remain stopped
for explicit schema-compatible recovery. Native installations refuse in-place
CLI builds. Existing Docker production stays unchanged until an operator runs the
reviewed installer. See [native operations](../deploy/native/README.md).

## User workspace home

The user UI opens on a Nest-owned dashboard when no `?channel=` link is present.
Conversation and claimed share links open chat, inside the matching owned project when available;
browser Back/Forward restores the dashboard or conversation from the URL.
Dashboard navigation clears the active channel so background messages are not
treated as read merely because the home page is visible.

Explicit Dashboard navigation writes `?view=dashboard`, so reload and refresh
preserve home even when agent onboarding is unfinished. A first visit to `/`
can still offer personal-agent setup.

Dashboard, Projects, Agents, Community and standalone chats share `WorkspaceTopbar`: each view's
search plus the original Figma theme/bell/settings/account icons. Browser theme
preferences synchronize between mounted controls and across tabs using storage
events. The bell reuses the existing human mention inbox; opening an entry marks
it read and restores its project/channel plus message link. Known project names
replace internal engine chat names in header notifications.

Workspace settings is a native dialog with appearance, an agent-settings shortcut
and an owner-only `/admin/` link gated by existing `GET /api/branding/access`.
An unavailable access check offers Retry without blocking personal preferences.
The account menu shows the authenticated username, agent/settings shortcuts and
the existing session logout. Escape/focus restoration and keyboard navigation
are tested. Standalone channel links, including connected-account callbacks, use
the same header. Chat search filters the sidebar channel list; the existing chat
title, member-management control and composer remain available. Project chats
reuse their outer project header, avoiding duplicate controls.
Community is the sole catalog navigation entry. Legacy `category` URL parameters
are ignored by the unified UI; reload/history and skill deep links remain valid.
No new settings,
notification or credential API/database is introduced.

The dashboard uses visibility-filtered channels and agents, access-scoped project
task summaries, the private community catalog and session-local unread counts.
Unread counts follow the
existing notification behavior: a fresh session establishes a baseline, then
HTTP polling and WebSocket events track subsequent messages. They are not
persisted read receipts. Search filters active projects, review/change tasks,
unread chat labels and the eight most recent community packages. Browse all
opens full catalog search. Legacy projects remain owner-private; new team projects
are also visible to their current subscribed human members.

Its visual reference is Figma file `Rqfq3v9a8nZfQKbM3Q0NZk`, Camplight dashboard
`923:417` and Nest dashboard `793:2`. Shared instance branding supplies the logo
and palette, with a separate Powered by Nest footer. Original exported icons
are local in `apps/user-ui/public/design`. The dashboard follows the reference's
three summary cards, Active projects/Up next columns, Urgent issues and Community
strip, including empty instances. Tasks toggles approved and pending-review counts.
Project completion is approved tasks divided by all tasks; no tasks means no
percentage. Assigned-agent counts come from tasks, not channel membership.
Spend and operational issues explicitly show unavailable with disabled filters;
changes requested are a separate task state, never fabricated incidents.

`GET /api/projects/dashboard` returns `ProjectDashboard`: per-project counts,
task totals and compact pending-review/change rows (no deliverable text, feedback
or engine events). It uses the same human session and current engine
channel access checks as project routes (owner manage/post, or explicit human
membership with post access for team projects; neither can be archived). It reads
only Nest's product task store. Engine failure returns 502, never a successful zero summary.
The UI loads the summary and community catalog concurrently on home entry and
manual Refresh, cancels obsolete requests, and clears failed summary values.

Project, review/unread-activity and changes-requested cards use a local adaptation of SmoothUI's
[Scrollable Card Stack](https://smoothui.dev/docs/components/scrollable-card-stack)
in `apps/user-ui/src/components/smooth-ui`, with its MIT license retained. The
component uses Motion for stack transitions, dots and previous/next controls,
arrow/Home/End keys, horizontal touch swipes and reduced-motion support. Only
the active card exposes actions to keyboard and assistive technology; vertical
page scrolling remains available. "All" switches Up next to the full list.
Review actions deep-link to the task in Projects. The community strip features
the latest packages in catalog order; each opens the actual skill detail. Artwork
is the original Figma automation, discussion and application illustration, retained
as decorative artwork for existing package metadata without inventing reply, run
or installation counts.

Agent portraits reuse Figma's five original characters through `AgentAvatar` in
dashboard cards and chat participants. PNG exports preserve the composed avatar
artwork: Puff (`857:386`, strategy), Moss (`857:396`, research), Muff (`857:406`,
product), Pom (`857:416`, design), Pip (`857:426`, engineering). Files live under
`apps/user-ui/public/design/avatars`. Character names and recognized role words
in agent names select their matching portrait; other names use a stable hash.
NestSystem uses Pip. This is a UI default, not a persisted avatar assignment or
an inference about an agent's capabilities. Failed images fall back to initials.

## Agent directory and settings

`?view=agents` opens the directory and `?view=agents&agent=<name>` opens settings.
The Agents navigation item is selected for both. Reload and browser history
restore these views, and dashboard agent names link to the same detail screen.
Navigating to Agents clears the active conversation. Existing channel/share
links retain their workspace behavior.

The directory uses visibility-filtered agents, searchable by name/description.
Team agent counts describe visible RUNNING and STOPPED runtime records, not task activity or
quality scores. Details load through `GET /api/agents/:name`. Description and
native system instructions save through `PATCH /api/agents/:name`; the existing
engine authorization remains authoritative. Private non-owner settings are
read-only. Names, model, runner, workspace and skills are displayed read-only.
Wrapped agents expose description editing only: native instructions/model/skills
do not control their external runtime. Avatars remain automatic name mappings.

See [ROADMAP.md](ROADMAP.md) for Figma references, acceptance criteria and remaining
project/task/review milestones. These screens do not provision agents or implement
task assignment, performance scores, avatar editing or resource configuration.

## Projects, tasks and human review

`?view=projects` lists projects. A project opens at
`?view=projects&project=<id>&tab=chat` with Chat and Files sections plus a Project details panel.
The About sidebar shows the current team from engine channel participants. Tasks
are removed from normal project navigation; no automatic chat-to-task extraction
or replacement to-do sidebar is introduced.

Project details, standalone room participants and the mobile member dialog share
compact runtime indicators with visible text: RUNNING is green/Running, STOPPED
red/Stopped, CRASHED red/Error, STARTING amber/Starting, and missing/unrecognized
state gray/Status unknown. Humans have no inferred presence indicator. These show
the engine's reported runtime state, not whether an agent is working on a task,
provider readiness or independently verified runner health. The signed-in user's
permission-filtered `GET /api/agents` roster refreshes every ten seconds while the
tab is visible and on window focus, without reloading chat. A failed lookup marks
status unknown while retaining directory details; the next successful lookup
recovers it. No global agent-status topic, new endpoint or engine change is needed.

`tab=tasks&task=<id>` restores a task; older task URLs without `tab` still work.
Tabs, reload and browser history preserve project context. Existing `?channel=`
links for an owned project open its Chat section; other channels remain accessible under Projects → Existing conversations.
The sidebar and dashboard avoid listing accessible project chats twice.
Projects is a single collapsible parent inside the main navigation, directly above
Agents and Community. Its indented shortcuts stay available across product views,
show at most five projects ordered by creation time, and retain the current project
in place of the fifth shortcut when necessary. Only the current destination has
`aria-current="page"`; the parent uses a contextual highlight for an open project.
The separate disclosure toggles without navigating. Clicking Projects opens the
full searchable directory and expands the group. New project lives inside the
group; Cmd/Ctrl+K still opens creation. View all projects appears when there are
more than five accessible projects. Long names truncate with a full-name title,
unread counts remain attached to their project, and the mobile drawer closes on
selection. This bounds sidebar rendering, not the underlying project-list API:
server pagination, pinning, archival and project folders are deferred. The layout
follows case-study reference `849:599` with shared tokens and original avatars;
budget, health and time estimates remain deferred.

Chat reuses the existing message history, real-time events, uploads and composer.
Files lists attachments from engine messages, 100 messages per page, with an
explicit older-files action. Members reuses channel participant/sharing controls;
adding members grants engine chat/file access and, for new team projects, access
to the project itself. Legacy creator-private project history stays private.
Viewing Tasks, Files or Members does not mark chat messages read. Read state
remains session-local.

`POST /api/projects` now accepts an optional `channelId`. Omitting it creates a
private engine chat automatically using the signed-in human's credentials. Legacy
clients can still link an existing active chat they can manage and post to.
Existing projects retain their channel IDs and task/review history.

Before creating the engine chat, Nest durably reserves the project UUID, owner,
request and a random recovery marker in `product_project_chats`. The engine chat
stores that marker in metadata. Concurrent retries and retries after restart
reconcile the owned, accessible channel instead of repeating the channel POST.
The browser retains a failed creation's UUID and submitted fields in tab-local
session storage for retry after reload, and clears them on success/logout.
New project opens an empty chat, with no engine channel or product record created
until the first Send. Its first message supplies the initial product name (first
nonempty line, bounded to 120 characters) and description (opening text, bounded
to 4,000), excluding selected mention spans. These are immediate fallback labels.
After confirmed message delivery, a durable core job generates an AI name and
project brief using the enabled instance default model (or
`NEST_PROJECT_NAMING_MODEL_ID`). The brief includes the goal, expected outcome,
supplied context/constraints and important open questions without inventing facts.
Chat does not wait for generation. The owner can edit both inline in Project details. Plain messages can start a solo project;
selected people/agents in the draft @ picker join before message delivery. The
same existing mention ranking/avatars are reused. One selected agent can receive
the initial targeted request; multiple people can be added/notified.

The browser stores owner-bound draft text, selected identities, project/message
UUIDs and the submitted metadata snapshot. Creation and first-message delivery
reuse their existing independent durable intents. If delivery is uncertain, the
text stays locked for retry; metadata is not recalculated for a submitted draft.
Opening/cancelling an untouched draft creates no empty project or chat records. Files and further
membership management become available in the created workspace. Logout clears
both current and legacy creation drafts. A previously submitted legacy name-form
draft still opens its original recovery form until completed.

`GET /api/projects/members` returns
existing teammates and public or owner-private agents through the human's engine
HTTP credentials. It excludes the creator, who is already included. This selects
existing accounts; no email, signup invitation or connected-account grant is sent.

`POST /api/projects` accepts optional `members` (HUMAN/AGENT subscriptions).
The server validates the team, deduplicates typed identities, sorts the creation
intent and stores it in the existing durable reservation. Empty selections preserve
legacy reservation format when collaboration is private. It adds the selected
members through engine HTTP before completing the product record. Subscription retries reconcile existing participants
after partial failure/restart. Completed retries do not re-add subsequently removed
members; changed team selections cannot reuse a completed creation ID.
The form saves drafts under the current human's identity, freezes submitted fields
while the outcome is uncertain and offers an explicit retry of the same creation.
Unavailable selections can be edited if setup has not yet been reserved. Persistent
engine errors or revoked identities during pending setup may require operator
recovery; no cross-system transaction or automatic rollback of invitations is claimed.
The creation form sends `collaboration: "team"`. Current explicit HUMAN channel
subscribers with post access can list/open these projects and see their dashboard
summary and product history. Public visibility, read-only shares and agent
subscriptions alone do not grant product access. Removing a human subscription
revokes their project access on the next request. Engine membership stays
authoritative; Nest stores no membership mirror. No chat history is posted or
agent work automatically dispatched.

If a channel POST has an uncertain outcome and no matching channel is visible,
creation returns 409 rather than risking a duplicate. An operator must inspect
that reservation and engine state if retries cannot reconcile it; Nest does not
claim exactly-once cross-database transactions. Chat metadata is for recovery,
not authorization. Conflicting requests for a reserved UUID return 409.

Product migration `008_project_collaboration.sql` adds a private/team policy.
Existing projects and legacy API requests default to private; new creation forms
choose team explicitly. Old pending browser drafts keep their original private
intent for safe retries. There is no automatic sharing of historical projects.
The creator remains the project owner and invitation manager. Historical task
mutations and reviews remain owner-only compatibility APIs.
All project routes require a signed-in human with password
setup complete and recheck current chat access. Archived/deleted/inaccessible
chats make the project unavailable without deleting its history. Unarchive or
restore access to recover it.

Tasks store a title, brief, acceptance criteria and assigned agent. Creating a
task queues it; sending explicitly subscribes the agent and posts a targeted
`message.created` using the human's credentials. No runner token is injected;
runner/Authorization/scoped-agent headers are stripped from product engine calls.
The idempotency key is `nest:task:<task-id>:attempt:<number>`. Nest persists dispatch
receipt ID/time after the engine response. A timeout after the engine accepted
it leaves the task queued and retryable with the same key, including after API
restart. This is at-least-once delivery, not a promise of exactly-once agent work.

States: `queued` → `working` → `needs_review` → `done`, or `needs_review` →
`changes_requested` → `working` for a new attempt. `working` means dispatched,
not evidence the runner is currently executing; the UI says “Awaiting deliverable.”
Only explicit human approval marks done. Requested changes require feedback,
increment the attempt and clear its current dispatch/deliverable references.
Previous deliverables/reviews are immutable historical records.

For a working task, a human chooses from the latest 100 assigned-agent message
responses after the dispatch timestamp. Submission fetches the chosen event
through the engine API and verifies source, type, conversation and timestamp.
It snapshots text/Markdown (including artifact links) into the product DB; binary
files stay in the engine. Selection is the human's explicit task/result mapping,
not automatic correlation. A successful turn or arbitrary human message cannot
complete a task. Multiple tasks can share a conversation, so the human must check
that the chosen response matches the task and acceptance criteria.

All task actions include the last observed `version`. A SQLite compare-and-swap
transaction changes task state, stores any deliverable/review and appends an audit
record together. Stale or concurrent decisions return 409 and cannot create two
reviews of the same deliverable. Project/task create IDs are client UUIDs: replay
with matching content returns the existing record; reuse with different content
returns 409. Engine failure returns 502 with saved records retained. There is no
background dispatch worker, stored human credential, automatic retry, cancellation
or automatic failure-classification in this slice.

`PATCH /api/projects/:projectId` edits only the creating human's name/description.
It requires current active manageable/postable channel access and the last observed
name/description in `expected`. The product store compares those values and updates
metadata/audit atomically; a stale editor receives 409. Engine channel IDs/names,
memberships, files, task/review history and collaboration policy are preserved.
Creation retries compare their original reserved request, so renaming cannot
break recovery or cause a retry to overwrite edited metadata. Sidebar, header and
About use the edited product metadata. Shared members cannot edit project settings.

Product APIs (JSON, no-store, 64 KB request cap):

- `GET/POST /api/projects`: list accessible owner/team projects / create a project.
- `GET /api/projects/members`: available existing people and public/owner agents.
- `GET /api/projects/:projectId`: project, tasks, deliverables and review history.
- `PATCH /api/projects/:projectId`: owner-only metadata edit with expected values.
- `POST /api/projects/:projectId/members`: owner-requested existing teammate invitation.
- `POST /api/projects/:projectId/tasks`: create an assigned queued task.
- `POST /api/projects/:projectId/tasks/:taskId/dispatch`: send initial/revision brief.
- `GET /api/projects/:projectId/tasks/:taskId/responses`: candidate agent messages.
- `POST /api/projects/:projectId/tasks/:taskId/deliverables`: snapshot selected event.
- `POST /api/projects/:projectId/tasks/:taskId/reviews`: approve/request changes.

Schemas and public product types live in `packages/schemas/src/projects.ts`.
The historical workflow supports the creator as reviewer; shared task editing,
notifications, full task execution telemetry and resource budgets are later milestones.

## API and identity boundary

Nest owns:

- `GET /health`: reports healthy only when the engine is reachable and healthy.
- `GET /api/branding`: public, no-store; sign-in identity and palette.
- `GET /api/branding/access`: authenticated human's owner capability.
- `PUT /api/branding`: replaces validated branding for the instance owner.
- `/api/projects` and descendants: project/task/review routes described above.

Other `/api/*` and `/v1/*` requests pass through the adapter to the fixed engine
origin. Streaming request/response bodies, HTTP status, uploads and query strings
are preserved. Redirects are not automatically followed. Hop-by-hop headers are
removed. No privileged service token is injected into human requests.

Existing `nest_session` cookies are translated to `orgops_session` on engine
requests and back on responses. A Nest cookie takes precedence if both exist.
The same applies to `x-nest-runner-token`, `x-nest-agent-name` and
`x-nest-channel-id` headers. Legacy OrgOps clients remain compatible.
WebSocket upgrades at `/ws` use the same cookie/header translation and relay
messages to the engine; OrgOps enforces topic visibility and event permissions.

Product ownership is derived through `/api/auth/me` and `/api/humans`: the human
with the earliest `createdAt` (then ID) can manage branding after completing
password setup. Ownership survives username changes. Runner credentials and
Authorization headers are removed from these product identity lookups, so they
cannot elevate branding requests. This version deliberately reuses OrgOps human
identity instead of maintaining a second user/password store.

## Product SQLite schema

`product_settings(key PRIMARY KEY, value_json)` stores the `branding` setting.
`product_audit(id, type, actor_id, payload_json, created_at)` stores product audit
history. A branding write and `audit.branding.updated` record share one SQLite
transaction. This audit is product-owned and does not wake engine agents.

`product_migrations` tracks numbered Nest-only SQL migrations under
`packages/db/migrations`, applied in a transaction at startup. `002_project_chats.sql` adds durable chat-creation reservations; `001_projects.sql`
adds `product_projects`, `product_tasks`, `product_deliverables`, and
`product_reviews`. The existing branding tables are preserved. Project columns
include owner, engine channel IDs and the collaboration policy added by migration
`008_project_collaboration.sql`. Tasks store a versioned JSON record and
project foreign key; deliverables and reviews have immutable typed columns,
foreign keys and uniqueness per task attempt/deliverable. Public types in
`packages/schemas/src/projects.ts` and the store in `packages/db/src/projects.ts`
are kept in agreement with this schema. Migration `011_canvases.sql` adds the
Switchyard canvas tables: `product_canvases` (owner, name, `private` or `shared`,
version), `product_canvas_members` (a person and their `edit` or `view` role),
`product_canvas_areas` (title, position, size, tint, version),
`product_canvas_cards` (one row per canvas and engine channel id, with position,
width, version, who placed it and an owner label) and `product_loose_hidden` (the
chats a person archived (hid) from their Loose chats). They hold layout only; their types
are in `packages/schemas/src/canvas.ts` and the store in `packages/db/src/canvases.ts`.
Migration `013_agent_pins.sql` adds `product_agent_pins`: one row per engine human id
with the ordered names of the agents that person pinned to their canvas tray (no row
until they first save pins); the store is `packages/db/src/agent-pins.ts`. Both databases already participate in
host-controller deployment snapshots and rollback.

Branding includes displayName (1–60 chars), logoUrl, primaryColor, accentColor,
and backgroundColor. Colors are six-digit hex. Logos allow HTTPS without URL
credentials, `/brand/` assets, or PNG/JPEG/WebP data URLs. Uploaded SVG and HTML
are rejected. The API caps the request body at 360,000 bytes; the UI limits
uploads to 250 KB. New instances use Nest defaults; Camplight values are deployment
configuration. The UI retains a fixed Powered by Nest footer.

## Migration and compatibility

See [SUBMODULE_MIGRATION.md](SUBMODULE_MIGRATION.md). The offline migration first
backs up both databases, then copies legacy branding into the product DB, adds
Nest environment aliases to stored wrapped-agent commands, and removes the old
branding migration marker so it cannot collide with a future upstream migration.
It leaves engine data, agent IDs, runner identity and workspace paths intact.
Repeated runs do not overwrite product branding or double-wrap commands.

The wrapped compatibility prefix is stored in the runtime recipe, not injected
into engine source. It translates ORGOPS_WRAPPED_* to NEST_WRAPPED_* for existing
Nest bridges. New recipes may use upstream ORGOPS_WRAPPED_* directly.

The host deployment controller must initialize submodules, mount/snapshot the
product volume and run the offline migration before starting a new image. Its
rollback restores both databases and the old image. Controller installation is
an operator action; updating this source does not replace the host controller.

## Verification

`npm test` exercises Nest against the actual pinned engine API and WebSocket
implementation plus the offline migration. `npm run test:engine` runs upstream
engine tests separately. `npm run lint` type-checks the selected workspaces;
`npm run build` builds both Nest interfaces. CLI tests use the Node test runner:
`npm run --workspace @nest/cli test`.

`npm run test:ui:agents` checks agent navigation/settings. `npm run test:ui:projects`
exercises the project/revision/approval flow in a browser against isolated real
product/engine HTTP handlers. It simulates runner-authored responses without a
model invocation. `apps/api/src/projects.test.ts` additionally covers authorization,
immutable reviews, malformed input, idempotency and restart recovery.

`npm run test:ui:chat-next` runs every browser suite under `tests/browser/chat-next/` (thread, realtime, working row, actions, quote reply, attachments, composer, slash commands and the absence of the old chat) against real engine and product handlers with synthetic data. The earlier browser suites still run against the chat as it renders by default: `test:ui:chat` (`chat.ts`, `codex-progress.mjs`, `claude-code-progress.mjs` and `demo-artifacts.mjs`), `test:ui:projects`, `test:ui:dashboard`, `test:ui:images`, `test:ui:onboarding` (with `test:ui:tour`), `test:ui:agents` (with `connection-projects.mjs`), `tests/browser/targeted-mentions.ts` and `tests/browser/mentions.mjs`. On macOS three upstream tests fail in `npm run test:engine` independently of Nest (the agent runner's two `file-upload` tests and the skills merge test "merges skills from multiple roots with first-name-wins"), and `npm test`'s `deploy/demos/publish.check.mjs` node test fails there too; these four known failures are compared by test ID rather than treated as regressions.

## Switchyard canvas (Phase 1)

The canvas is a board where a person lays out their chats as cards, groups them in
areas and sees at a glance where each one stands. The design is in
[the Switchyard design](superpowers/specs/2026-11-08-switchyard-canvas-design.md);
Phase 1 is built from
[the Phase 1 plan](superpowers/plans/2026-11-08-switchyard-canvas-phase1.md).

1. Flag. The product API reads `NEST_ENABLE_CANVAS=1` (the `canvasEnabled` config
   field). Sign-in is checked first: a signed-out caller gets 401 from every
   `/api/canvases` route, and a person who must still change their password gets
   403. For signed-in people, when the flag is off, every `/api/canvases/*` route
   answers 404 `{error:'Not found'}`, except `GET /api/canvases/availability`, which
   answers `{available:false}`. The user UI shows the Canvas entry only when
   `available` is true. The view lives at `?view=canvas&canvas=<id>`, and an open chat adds
   `chat=<channel id>&mode=focus|split`, so a reload restores both.

2. Ownership. Nest owns the layout only: canvases, their members, areas, card
   positions, the personal Loose chats hides and tray pins (the 011 and 013 tables above). OrgOps owns
   every chat, message, participant, agent run and file. Moving, grouping, sharing
   or hiding never writes to the engine. The only engine writes from the canvas use
   existing endpoints as the signed-in person: adding or removing an agent on a card
   (`POST /api/channels/:id/subscribe`, `POST /api/projects/:id/members`,
   `POST /api/channels/:id/unsubscribe`), Nudge (`POST /api/messages`) and starting
   a chat from the bottom box (`POST /api/projects`). Live state on cards (working,
   waiting on you, quiet for N min, done, stopped, files, last activity, needs you) is
   worked out in the browser from engine events, mentions and reviews the person can
   already read.

3. Routes. All need a signed-in person and take at most 64 KB.
   - `GET /api/canvases/availability`
   - `GET /api/canvases` and `POST /api/canvases` (list and create). A repeated
     create with the same id and name returns the existing canvas; the same id with
     another name, or another person's id, answers 409 `Canvas ID already used`.
   - `PATCH /api/canvases/:id` (rename) and `DELETE /api/canvases/:id?version=`
   - `GET /api/canvases/:id/members` (anyone who can see the canvas) and
     `PUT /api/canvases/:id/members` (owner only)
   - `GET /api/canvases/:id/board[?etag=]`: the canvas, its areas and its cards as
     this person may see them, with an etag; a matching etag answers
     `{unchanged:true}`
   - `POST /api/canvases/:id/areas` (an id already on the canvas answers 409
     `Area ID already used`), `PATCH /api/canvases/:id/areas/:areaId[?moveCards=1]`
     and `DELETE /api/canvases/:id/areas/:areaId?version=`. The PATCH answers
     `{area, cards, areas}`. With `moveCards=1` and a change of position, `cards`
     holds the cards that moved with the area (shaped for this viewer, as below) and
     `areas` the areas nested inside it that moved too; otherwise both are empty.
   - `POST /api/canvases/:id/cards` (up to 100 at once, optionally with a new area;
     a chat already on the canvas keeps its place; it answers the whole board),
     `PATCH /api/canvases/:id/cards/:channelId` (answers the moved card, shaped for
     this viewer, with its `home` label when the viewer can open the chat) and
     `DELETE /api/canvases/:id/cards/:channelId?version=` (removing a chat from its
     home canvas also clears the chat's home). Placing
     needs edit access (403 for a viewer), and every chat must be one the engine
     lists for the person (else 400).
   - `GET /api/canvases/hidden` returns `{channelIds}`. `POST /api/canvases/hidden`
     takes `{channelIds (1–100), hidden: true|false}` and returns the person's full
     `{channelIds}`. Chats the person cannot see are dropped without an error. This
     is the Loose chats drawer's Archive: a personal hide, never an engine archive.
   - `GET /api/canvases/agent-pins` returns `{agentNames, saved}`: the person's tray
     pins in order, and whether they have ever saved any. `PUT /api/canvases/agent-pins`
     takes `{agentNames}` (the whole list, at most 7 distinct names) and returns the
     same shape. More than 7 answers 400 `You can pin up to 7 agents. Unpin one first.`
     Agents the engine does not list for the person (`GET /api/agents` as them: deleted,
     or someone else's private agent) are dropped silently on save and on read. Pins are
     personal, across canvases and devices, keyed by the engine human id. A PUT may
     carry `expectSaved: false` (the browser sends it with a seeded first save); when
     the person already has saved pins it answers 409 `{error:'Pins already saved',
     current}` and changes nothing, so a seed never replaces pins saved elsewhere. These
     routes do not read the engine's channel list.

   Versions. Rename, sharing, area changes and deletes, card moves and removals, and
   canvas deletion carry the version they were based on (in the body, or `?version=`
   for deletes). Creating a canvas or an area, placing cards and hiding take none.
   A stale version answers 409 `{error:'Canvas changed', current}`, where `current`
   is the record as it is now, shaped for this viewer: a card for a chat the viewer
   cannot open has `projectId: null` and no `ownerLabel`. The browser then refreshes
   the board and says "Canvas changed. Refreshed." Limits are rejected with 400:
   names and titles of 1–120 characters, coordinates within ±1,000,000, card width
   200–640 (default 280), area width and height 160–20,000, at most 500 cards and
   100 areas per canvas, 50 owned canvases per person and 30 members per canvas.

4. Access rule. A canvas is private to its owner unless the owner shares it with
   chosen people as `edit` or `view`. Missing and unshared canvases both answer 404;
   a viewer's change answers 403. Sharing covers the layout only: chat access always
   stays with the engine. The board describes a card only when the engine lists that
   chat for the person asking. Anyone else gets a locked card that shows
   "Private chat" and who owns the chat (its engine owner, recorded when the card
   was placed), never the title, participants or messages. A card whose chat the
   person placed but can no longer see shows as unavailable. Locked and unavailable cards never open.
   The owner and editors can take any card off the canvas with "Remove from canvas",
   whether it is open, locked or unavailable; viewers cannot (403). Removing never
   changes the chat, and a loose chat the person has not archived returns to Loose
   chats.

5. Using it. A shared canvas syncs every 5 seconds while visible and on window
   focus. One chat opens at a time, in focus or in split screen beside it, and
   "Open in the regular chat view" leaves the canvas. Focus opens the chat in place:
   the view moves to 100% (less only to fit a very tall card) with the card where a
   560 px sheet of its current height fits, 56 px below the top for the area's
   title, and the chat opens as that sheet over the card, its top-left on the
   card's. It follows the card as the view or window changes, stays inside the
   canvas and ends 8 px above the bottom box (at most 720 px tall). With the Loose
   chats drawer open, opening a card puts it right of the drawer when a 560 px sheet
   fits there; otherwise the sheet overlaps the drawer, above it. Every other card, area and link dims to 28%; there is no
   scrim and the canvas stays live: wheel, pinch and drag pan or zoom it, the zoom
   bar, agent tray and bottom box work, and Fit closes the chat, then fits. A
   press on empty canvas without dragging (the canvas's 3 px threshold) closes it,
   unless it is closing a popover, which then closes alone. While a focus chat is
   open the canvas is hidden from screen readers and Tab stays in the chat (focus
   in another dialog, such as the Huddle, is left alone). A pointer can still reach
   the bottom box, agent tray and an open Loose chats drawer then, though Tab and
   screen readers do not; file
   drops on the canvas are ignored and drops on the chat attach. A chat that is not
   on this canvas opens as a plain 560 px chat centred just above the bottom box (at
   most min(640 px, 100vh − 190 px) tall), with the canvas at 30%; with the drawer
   open it is centred in the room right of the drawer when it fits there. Escape
   (after any popover, menu or picker in the chat) closes it, and the card it closes
   into flashes once. One Escape closes one thing: the chat's More menu, then a
   popover, then the sheet; the drawer closes first only when focus is in it (or on
   its toggle), and otherwise once no sheet is open. The chat's header is one row, as in the mock: title, faces and
   `in <area> · sees N contexts` (plus Archived or Read-only), then icon buttons
   for Split screen, Huddle, Open in the regular chat view, a More menu (Area,
   Place on canvas, Use this area's context, Sharing, Export chat; hidden when it would be empty)
   and Close. A demo preview inside
   the chat stacks above it rather than beside it. Phones keep a full-width chat. Only
   chats in the user UI's visible chat list open; if the open chat leaves that list,
   it closes. Only cards near the viewport are mounted, and below 50% zoom cards
   switch to a compact form. A chat dragged from the drawer lands centred on the
   pointer; dragging a selected row carries every selected chat (up to 100), which
   land as a grid centred on the pointer, moved down below any card it would cover.
   "New area from these" puts that grid at the viewport centre inside a new area.
   The grid is 3 across on the mock's 300 × 300 step. Placement uses each mounted
   card's measured height and assumes 260 canvas px for a card not yet shown; area
   membership still uses the card's top 160 px centre, on client and server alike.
   A chat started from the bottom box stays in sight: on a canvas the person can
   edit it is placed at the viewport centre (moved below any card it would cover),
   opens in split screen (or the mode of the chat already open) and is centred in
   view; on a view-only canvas or a phone it opens in focus and stays loose (the
   drawer, on a wide screen, opens and points at it). While a card or loose chat is dragged, the area it would join (by its centre)
   lights up with a "Place in <area> · shares its context" label on its top edge. A card in an area
   carries a stripe in the area's tint, and screen readers hear "In area <area>".
   A card or chats dropped into an area grow it, never shrink it, so they fit inside
   with 32 px around them and 72 px above them for the title bar (an ordinary area
   resize, at most 20 000 px). An editor can also move the open chat from its header:
   the Area picker puts its card in the first free spot under the chosen area's title
   bar (the area grows to fit), places a loose chat there directly, or with No area
   moves the card just outside its area; the view follows the card. For a loose chat the
   picker also offers `No area (on the canvas)` after the areas (so a first arrow press
   never places it), shown even on a canvas without areas,
   and the More menu has `Place on canvas` (desktop editors only): both place it at the
   viewport centre, moved below any card it would cover, and the chat then opens in
   place over its new card. This is the keyboard and single-pointer way to place one
   chat, alongside dragging. On desktop the canvas starts with an icon-only
   sidebar; the collapse button beside the logo expands it. That choice, the one for
   every other view (which start expanded) and whether the sidebar's agent list is
   shown are remembered per browser. Phones keep the full slide-in menu. Search (Ctrl/Cmd+K)
   finds cards, areas, loose chats and canvases; loose chats the person has archived
   are not searchable unless Show archived is on. Needs you lists unread mentions and
   tasks waiting for review on chats the person can see.

   Loose chats. The person's chats that are not on this canvas (theirs as a member or
   owner, not archived in the engine, not lifecycle channels) sit behind the top bar's
   `Loose chats {n}` toggle (`Plain chats that aren't on the canvas yet`), after Canvas
   context. The count leaves out archived chats and turns coral while any of them needs
   the person. The toggle opens the mock's drawer, a 370 px card over the left of the
   canvas (16 px in, 76 px down, under the Area tool, its bottom 222 px above the
   canvas's so the bottom box and tray stay clear); the canvas keeps its full width and a
   press on it leaves the drawer open. The drawer and the agent picker take turns:
   opening one closes the other. ✕ (`Close`) or Escape closes it, focus returning to the
   toggle when it was in the drawer; opening it from the toggle focuses the search
   (phones have no drawer; see below). It has `Loose chats · {n}`, a search over titles and agent names
   (`Search loose chats`), a compact `All agents` filter, the chips `All / Needs you /
   Working / Done` with counts (archived chats left out, as in the header), and rows in day groups by last activity on the local
   calendar (`Today · n`, `Yesterday · n`, `This week · n` for the five days before,
   `Older · n`; Older folds behind Show/Hide when there is no search, chip or agent
   filter). A chat needs you when it has a Needs you item (mention or review; reviews are
   read on phones too), the one test behind the Needs you chip and the coral count; else it is
   working while an agent's turn is live (working, or quiet for a while), else is done, from the same pulses and
   items as the cards. A row has a checkbox, the first agent's face, the title, a second
   line and the last activity (`5m`): the line is `Needs you: {reason}` in coral for the
   newest item, else `{agent} · {activity}` as on that agent's card row, else the first
   line of the newest message a person posted, else empty. A row opens its chat in focus
   on a click and drags onto the canvas (`Click to open · drag onto the canvas to
   place`); shift-click ticks a range. With rows ticked, a bar shows `{n} selected`,
   `New area from these` (which frames the area, opens its title for typing and closes
   the drawer), `Archive` and `Clear`; actions take at most 100 chats. Archive is the
   personal hide above; `Show archived` in the footer lists archived chats with
   Unarchive. The footer says `Tick chats to act on several at once`. The list is
   windowed (48 px rows, 30 px group headers) and opens at its top each time. Below 1360 px wide the toggle shows its
   icon and count and Canvas context reads `Context` (both keep their full names), and
   the heading wraps rather than run under the search.

   Cards. An open card shows its title with the last activity (`5m`), the apps its
   agents used (up to four logos, each titled `<app>: N reads · M changes`, then the
   app's name or `N apps`), then one row per participant: agents in roster order, then
   people, with the viewer last as `You`. At most four rows show, chosen by what most
   needs a look, then `+N more`. A row has a face, a name, a one-line activity and a
   state dot. An agent's activity is the app and action of its newest running app call
   while its turn is open (`Gmail · Fetch emails`, never the command, arguments or
   output), else the turn's latest progress line, else `working`; a quiet agent reads
   `quiet for N min · last: <progress>` with `z z`; done and idle agents show the first
   line of their latest message. A person shows the first line of their latest message
   or `shared N files`. A participant is **waiting on you** only when one of the chat's
   Needs you items comes from them: an unread mention they sent you, or a task of theirs
   (by agent name) awaiting your review. Message text is never read for it, and waiting
   replaces only done, idle and "posted"; working, quiet, stopped and failed win. Files
   posted in the loaded history follow as one row of 56 px tiles, newest first: a typed
   glyph (document, spreadsheet, slides, image, audio or video, chosen by the file's
   extension first and then its MIME type), or a PNG, JPEG, GIF or WebP file as its own
   preview, over the file name, titled `<name> · <type>` (`PDF`, `Excel spreadsheet`,
   `PowerPoint slides`, never a raw MIME type) and linking to the file. As many tiles
   show as fit the card (four at 264 px); when more files were posted the last slot is
   `+N` (`N more files`), which opens the chat. A file that arrives while the canvas is
   open pops in once, except with reduced motion. Area shelves and the context popover
   use the same tile and keep their download links and ✕. The
   footer shows the newest Needs you reason as a coral pill (`<sender>: <text>` or
   `Review <task>`, `+N` for more) that opens the chat, and the card gets a coral
   border; otherwise it shows `Nudge <agent>` for a quiet agent, else `Moving` or
   `All quiet`. Open is a visible footer button; Remove from canvas is a small icon
   whose slot is always kept, shown on hover or keyboard focus. At compact zoom a card keeps its title, 40 px
   faces and a coral dot (needs you) or `quiet`; file tiles are hidden.

   Agent tray and picker. The tray (bottom left) reads `Pinned`, then the person's
   pinned agents in their order, then `All N` (`Search all agents`), as in the mock.
   Until the person first pins or unpins, their pins are a seed: their own agents by
   name, then the team's, up to 7, starred like any pin. The first star or unstar saves
   that list with the one change (unstarring removes the agent and keeps the rest,
   starring appends), so the tray never collapses. Once saved it shows exactly their
   pins, an empty list included; pins for agents no longer on the roster drop out.
   The browser saves one list at a time: presses while a save is in flight coalesce
   and only the newest list follows, so the stored list is always the last one shown.
   Stars are disabled while the pins load. If the read fails the tray shows the seed,
   and a star press first reads again; when that fails too it says `Couldn't load your
   pinned agents. Try again.` and saves nothing. A seeded save refused with 409 shows
   the saved pins instead. With a card selected,
   up to 3 agents from the other chats in its area who are not in it lead the tray as
   `Suggested for this chat` (accent), then a separator and the pins, without the `Pinned`
   label. `All N` opens the picker: `Agents · N` with a ✕, a search over name (ranked like
   @mentions), role (the engine description) and owner name (`Search by name, role or
   owner`), a compact area filter, the
   chips `All / Yours / Free now / Working`, and rows grouped by owner (`Yours · n` first,
   then `{owner}'s team · n`, or `Team · n` without a known owner). A row has the face,
   the name, the role, a live status and a star. The status reads `in N chat(s)` (accent)
   for the placed cards on this canvas where the agent is a participant and working now
   (from the same live pulses as the card rows) or `free`. The star is a toggle button
   named `Pin {name} to tray` with `aria-pressed` for its state (titled `Pin to tray` or
   `Unpin`); an eighth pin is refused with the notice `You can pin up to 7 agents. Unpin
   one first.` The footer says `Drag any agent onto a chat · ☆ pins it to the tray`;
   areas take no agent drops. App grants are not shown or searched (the agent list
   carries none). A face dragged far enough off
   its card to remove the agent shows `Remove {agent} from "{title}"` in coral.

   Area summaries. At compact zoom an area's title has a summary under it, counting the
   cards in it and in the areas inside it: `2 need you · 3 moving · 1 quiet`, with zero
   parts left out and the need count in coral. A card can count as both moving and
   quiet when it has one working and one quiet agent. With nothing to count it reads
   `all quiet`, and an area with no chats whose context another area uses reads
   `Shared resources`.

   New areas. Arming the Area tool says "Drag on the canvas to draw an area. Chats in it
   can share its context. Esc cancels." A drawn area, or one made with "New area from
   these" (which also frames it), opens its title for typing with the text selected.
   After drawing, the notice says "New area. Name it, then drop chats into it." or, when
   cards sit inside, that they share its context once a member moves them in or picks
   "Use this area's context" (drawing moves no card, so no chat's home changes). "New
   area from these" says "New area with N chats. Rename it, and add context they should
   all share." Double-click and the `⋯` menu still rename.

6. Phones and display. On viewports up to 760 px wide there is no free canvas.
   A list takes its place with three segments: Areas (each area opens to its chats,
   then the chats in no area), Needs you and Loose chats. Tapping a chat opens it in
   focus over the whole body, and the bottom box stays under the list. The top bar's
   Loose chats toggle (icon and count, coral while one needs the person) has no drawer
   there: it closes an open chat, then selects the list's Loose chats segment, focuses
   its tab and scrolls the segments into view. Tablets keep
   the canvas with pinch and pan. Colours come from the Nest brand tokens with
   light and dark variants under `:root[data-theme="dark"]`; the Pip and Pom tints
   and the quiet and alert text colours, which have no brand token, are canvas
   tokens with dark values. Card text keeps at least 4.5:1 contrast in both themes,
   and a focused card keeps an outline in forced-colours mode.

7. Checks. `apps/api/src/canvases.test.ts` and `canvas-board.test.ts` run the routes
   against real Nest-to-OrgOps handlers with temporary databases.
   `npm run test:ui:canvas` (run in CI by `.github/workflows/product.yml`) drives the
   real engine, API and WebSocket in Chromium on desktop, tablet and phone. It
   covers sharing and locked cards, live state, opening chats, the phone list,
   light and dark contrast, and reload. Its scale check seeds 150 cards in 6 areas
   with 30 agents: fitted to one area, fewer than 60 cards are mounted, a scripted
   2 second pan averages at least 30 frames a second, and Fit shows every area.

## Switchyard canvas (Phase 2)

Phase 2 adds shared context, dropped files, voice notes and app visibility to the
flagged canvas. Design: section 8 of
[the Switchyard design](superpowers/specs/2026-11-08-switchyard-canvas-design.md);
plan: [the Phase 2 plan](superpowers/plans/2026-11-09-switchyard-canvas-phase2.md).
Everything is behind `NEST_ENABLE_CANVAS=1`; with the flag off the new routes answer
404 to signed-in people (sign-in checks still answer first) and the new UI is absent.
That includes the regular chat and Projects views: with the flag off there is no voice
note button, no "Apps here" bar, no wrapped-agent line, and the chat timeline's activity
titles and details are exactly as before Phase 2. The browser reads the flag once from
`GET /api/canvases/availability`; until it answers, those features stay off.

1. Data. Migration `012_canvas_context.sql` adds `product_canvas_context` (notes per
   canvas or area, with a version), `product_canvas_context_files` (name, type, size
   and storage key of each file), `product_area_context_refs` (links between areas),
   `product_chat_home` (each chat's home canvas and area), `product_context_tokens`
   (agent context keys, stored only as sha256) and `product_context_agents` (which
   agents have been set up). Types are in `packages/schemas/src/canvas-context.ts`.
   Context files are stored under `NEST_CONTEXT_FILES_DIR` (default
   `.nest-product/context-files`), never in the engine's `files/` tree, which agents'
   shells can read through the engine's tools. Back that directory up together with
   the product DB snapshot; the DB rows alone do not restore the files. The DevOps
   controller (`deploy/devops/nest-ops.py`) copies it next to the product snapshot on
   each deploy and restores it on rollback.

   Confinement limit: every per-chat rule here (home, home availability, links,
   membership, keys) is enforced at Nest's HTTP layer only. The default deployment
   runs the API, the engine and the runner in one container (or on one host) with no
   OS sandbox, so a native agent's shell can read the product DB and `context-files/`
   directly and bypass those checks. Until agents run on separate runner hosts (the
   design's decision), treat everything in context as readable by any agent that runs
   on the same host as Nest.

2. Context routes (signed-in people; read needs access to the canvas, writes need
   `edit`; no engine event is created):
   - `GET|PUT /api/canvases/:id/context` and `GET|PUT /api/canvases/:id/areas/:areaId/context`
     (notes, with the version they were based on; a stale version answers 409)
   - `POST …/context/files` (multipart) and `DELETE …/context/files/:fileId`, for the
     canvas and for each area
   - `GET /api/canvases/:id/context/files/:fileId` downloads any context file of the
     canvas, area files included
   - `POST /api/canvases/:id/areas/:areaId/context/links` and
     `DELETE …/context/links/:sourceAreaId` (use another area's context)
   - `GET /api/canvases/context-sources` (areas the person can link to, each with
     `counts: {notes, fileCount}` for the picker)
   - `GET /api/canvases/:id/context/summary`: one request per board load for every
     area's chip, shelf and footer. `canvas` is `{hasContext, notes, fileCount}`; each
     area is `{areaId, hasContext, notes, fileCount, files, links, usedBy}`, where
     `files` lists the first 8 files (`id`, `name`, `mime`) for the shelf, `links` are
     the area's links with their source's `canvasId`, `canvasName` and
     `counts: {notes, fileCount}`, and `usedBy` the areas that link to it. A link's
     source is named, placed and counted only for viewers who can read its canvas
     (otherwise `title:'Unavailable area'` with nulls), and an unavailable link has
     `counts: null`. A `usedBy` area's `title` is null when the viewer cannot read its
     canvas. Scope reads (`GET …/context`) return links in the same shape.
   - `GET /api/canvases/:id/areas/:areaId/context/readers` (agents in the chats homed
     on the area and whether each can read it: `ready`, `unconfigured` or wrapped)
   - `POST /api/canvases/:id/cards/:channelId/home` ("Use this area's context"; chat
     members only)

   Limits, each rejected with 400: notes 20,000 characters per scope, 20 files per
   upload request, 20 MiB per file, 50 files per scope, 200 MiB of context files per
   canvas, 10 linked areas per area. A single upload request is capped at the
   canvas's 200 MiB limit plus 1 MiB, and one that cannot fit the canvas's remaining
   space is refused early with 413. Links are one level deep: a linked area's own
   links are never followed. A link shows `unavailable`, and agents stop reading it
   at once, when the person who made it loses access to the source canvas.

3. A chat's home. A chat's first placement on any canvas by one of its human members
   sets its home: that canvas plus the area under the card's centre (or none). On the
   home canvas the home area follows the card when a chat member moves it; a move by
   someone outside the chat leaves the home alone. Only a placement (a card newly put
   on a canvas with `POST …/cards`) can give a chat with no home its first home; a
   move never does. A chat has no home after its home canvas is deleted, after its
   card is removed from the home canvas, or when it was placed before migration 012;
   moving its card anywhere leaves it without one until a member places it on another
   canvas or uses "Use this area's context". A move or placement that newly makes this
   canvas a chat's home warns ("Everyone in these chats, including their agents, can
   see this.", with Undo) when the canvas has notes or files, even outside any area,
   or the area under the card has context; a move within the home canvas warns only
   for the new area's context. The context popover shows the same warning when a card
   is in the scope, or when any chat's available home reads it, including chats homed
   in areas that link to this area (`inChats` on the context read).

   A home is unavailable while the person who set it (the member whose placement,
   move or "Use this area's context" last set it) cannot read its canvas, the same rule as a link's linker: agents then read
   `{canvas:null, area:null, linked:[]}` for the chat, its home's files answer 404,
   the area's readers leave it out, and the board gives the card
   `home: {isHere:false, label:null, available:false}`, shown as "context unavailable"
   with the link's `unavailable` tag. It is checked on every read, with no cache, and a
   member re-homing the chat (a move on the home canvas or "Use this area's context")
   makes it available again. Context other canvases hold for a chat placed
   there is never read by its agents; only the home counts.

4. Agent keys and the skill. The first time a native agent is in a chat whose home
   has context, Nest creates a context key (`nest_context_` plus 64 hex characters),
   stores only its sha256, installs the key as the agent's private engine secret
   `NEST_CONTEXT_TOKEN` (`POST /api/secrets`, `scopeType:'private'`) and adds
   `nest-context` to the agent's `enabledSkills` (`PATCH /api/agents/:name`), both
   with Nest's service token. A failed setup revokes the key and retries a minute
   later; `audit.canvas.context.agent_setup_failed` is written once when an agent
   moves into the failed state, not on each retry, and again only after a success.
   A context write or home change waits at most about 2 seconds for setup, then
   answers while setup finishes in the background.
   Wrapped agents (Codex, Claude Code) get no key because their harness does not
   load engine skills; the context popover says
   "<name> can't read context yet (wrapped agent)." The skill is `skills/nest-context`
   (`scripts/context.mjs read CHANNEL_ID`, `file CHANNEL_ID FILE_ID`).
   - `GET /api/context/agent?channelId=` and `GET /api/context/agent/files/:fileId?channelId=`
     take `Authorization: Bearer nest_context_…` and never cookies. They return 401
     for a missing or revoked key, 403 when the engine does not list the agent in
     that chat, 429 above 60 requests a minute per key, 400 for a malformed
     `channelId`, 503 when Nest has no engine service token, and 404 with the flag off.
     They never fall through to the engine proxy and send `Cache-Control: no-store`.
   - Membership is checked through the engine, with the service token, on every
     read; nothing is cached. An agent that is only projected through federation
     metadata is not a member, and one that is both subscribed and listed in that
     metadata is denied. A read returns the chat's home context only: canvas notes
     and files, the home area's notes and files, and areas linked to it.

5. Context in the UI. Every area's title bar has a `◱` chip button labelled from
   the summary (`Notes · 2 files`, `Notes`, `3 files`, or `Add context` when empty;
   `No context` for viewers), hidden at compact zoom with the shelf and footer. One
   click opens the context popover anchored under the chip and kept inside the
   window (a bottom sheet at 760 px and below). The Canvas context button in the top
   bar (which adds `· Notes · 1 file` when the canvas has context) and the open
   chat's `sees N contexts` open the same popover under themselves. A `↳` link chip
   (a button, so also from the keyboard) frames its area and the source together
   and keeps their dotted line drawn for a moment; a `↗` chip opens the source's
   canvas; a chip for an unavailable source opens the area's popover. The popover
   floats over the canvas, so an open split or focus chat stays open; Escape (after
   folding the area picker) closes the popover before any chat, wherever focus is
   inside it, and an outside press or Done closes it too; focus returns to its
   opener. File drags over the popover never reach the page: a viewer's drop shows
   the view-only notice. It holds the explainer, the warning,
   the autosaved notes, file tiles with progress for uploads, "Also uses" rows with
   each source's canvas and counts and a ✕ (`Stop using {title}`), the picker grouped
   `On {canvas}` / `Other canvases` with counts, `Used by … Changes here reach them
   right away.`, the readers, and Add files and Done. Viewers get it read-only, with
   no Add files, picker or ✕; the area `⋯` menu holds only Rename and Delete, so
   viewers have none. While an area's popover is open, its links to areas on this
   canvas are drawn as dotted lines. An area holding no cards shows up to 8 file
   tiles (a shelf) under its title, and a source area shows `Used by A and B. Edit
   here once, they all see it.` along its bottom edge. The open chat's header shows
   its participants' faces, then `in {area}` (or `on the canvas`, or `Plain chat ·
   not on this canvas`) and, by home semantics, `sees N contexts` (the canvas, the
   home area and that area's available links; tooltip `Sees: …`) when this card is
   the chat's home, otherwise `context from {home}`, `context unavailable` or
   `no shared context yet`. The phone list puts the same chip and shelf in an
   expanded area.

   File drops. During any file drag over the canvas a banner names the three targets.
   A drop on an area (editors) uploads straight into its context through the context
   upload route, one file per request with a progress notice, then says `Added N
   files to {area}'s context. Every chat in the area can now see them.` (plus the
   visibility warning when a card is in the area), refreshes the summary and opens
   nothing; while that area's popover is open the files join its Files section
   instead. A viewer's area drop only says they cannot add files. A drop on empty
   canvas goes to the bottom box, even beside a split chat, which takes focus
   and says `Attached N files. Say what you want done with them, then press Send.`;
   an open chat (split or focus) takes only drops on itself, and while a focus chat
   is open the canvas, its cards and areas and the bottom box take none.

6. Context edits never create engine events and never wake an agent. The only
   engine writes in Phase 2 are the key setup above, `POST /api/messages` for files
   dropped on a card and `POST /api/files` for uploads and voice notes. Dropping files
   on a card opens the chat in split screen and queues them in its reply box. They are
   sent automatically when every upload finishes, but only if the box had no draft or
   queued files and the drop did not hit the 20-file cap; typing or removing a file
   cancels the send and leaves the files queued.

7. App activity. Nest stores none. The browser derives it from the chat's engine
   `tool.*` events that the viewer can already read, so retention is the engine's
   and only people who can read the chat see it. A pure classifier
   (`apps/user-ui/src/app-activity.ts`) turns a call into app, action, read or
   change, and label. Apps are connected-app calls (`connections.mjs execute`) and
   `gh`; other shell commands are not apps. Only exact read verbs count as reads.
   The classifier is fail-safe: anything ambiguous is a change, including unknown
   tools, more than one app invocation in a command, command substitution, pipes
   into a shell, `eval` or `xargs`, and indirect names. Commands and outputs are
   never shown for app calls; the label is the action name, or the repo for `gh`.
   Every `shell_run` also produces `process.started` (with the command),
   `process.output` (with the output) and `process.exited` events that share a
   `processId`. When the started command classifies as an app call (the same
   classifier), the details of all three show only event, time, agent, read or change
   and label, as the tool event's do. A `process.output` whose start is not in the
   loaded history shows no text until older messages load, since it may belong to an
   app call.
   With the canvas flag on, each app call (a `tool.started` paired with its result,
   as `foldCalls` pairs them) is a slim timeline line, not an icon chip: the agent's
   28 px avatar, the app icon, "**Agent** clause · App" (a lowercase clause: "sent an
   email", "merged a PR in acme/web", "sending an email" while running, "tried to
   send an email" when failed), a `running` tag with a live dot or a `failed` tag, a
   text `changed` pill on completed or running changes, and the time. The process
   events of an app call's `shell_run` (start, output, exit) get no chip, since the
   line stands for them. The line is a button with `aria-expanded`; its details are
   one or two plain lines ("Gmail · sent an email" / "changed something outside Nest
   · done at 4:19 PM", the line's own time format), never a command, argument or
   output. A running line re-reads the server clock every 30 seconds, so one stuck
   for 10 minutes turns failed. Non-app events keep the chip strip, and with the flag
   off the timeline is unchanged.
   With the canvas flag on, a message's files are a wrapping row of the cards' file
   tiles under its text instead of the Attachments list: each is named `<name>, <type>,
   <size>` with `<type> · <size>` as its tooltip, and an image preview still opens the
   zoom view on a plain click. Audio files, voice notes included, keep the Attachments
   list. With the flag off, attachments render as described under Chat attachments.
   Running and failed calls are counted. Cards show the apps used, and the chat's
   "Apps here" bar shows "N reads · M changes outside Nest" (singular for one, "nothing changed outside Nest" for none) for the loaded history
   only, so long chats under-report until older pages load. A call still running
   after 10 minutes counts as failed; that window uses a server clock taken from
   response `Date` headers and realtime events, not the browser clock. Wrapped agents
   report no `tool.*` events, so their app use is not shown, and the chat says so.

8. Voice notes. The reply box and bottom box record with `MediaRecorder`, as
   `audio/webm` or, where unsupported, `audio/mp4` (`Voice note.webm` or
   `Voice note.m4a`), for at most 5 minutes. The audio goes only through
   `POST /api/files` and the engine's `POST /api/voice/transcribe`. The transcript
   fills the draft and the audio is attached. If transcription is off or fails, the
   audio is still attached and a message says so. Cancelling at any stage discards
   the recording, transcript and attachment.

9. Checks. `apps/api/src/canvas-context.test.ts`, `context-files.test.ts` and
   `context-agents.test.ts` run against real Nest-to-OrgOps handlers with temporary
   databases. The `context.ts`, `files-voice.ts` and `apps.ts` suites run under
   `npm run test:ui:canvas`. Only the transcription result is stubbed in the voice
   suite, because the harness has no speech model.

## Private Community catalog

Nest owns reusable package metadata, immutable releases, package bytes and scoped
publishing credentials in the product DB. Migration `003_community.sql` adds
`community_skills`, `community_versions` and `community_tokens`. This is separate
from installed OrgOps skills and never reads or modifies the engine database.
One deployment/product DB is the tenant boundary; there is no cross-tenant index.

Community uses verified human engine sessions, excluding runner credentials, or a
`Bearer nest_community_…` token. Only its SHA-256 hash is persisted. Tokens expire
in 30 days, are explicitly revocable, and bind the issuing human and agent identity.
Issuance requires agent ownership or instance ownership. Agent credentials cannot
manage tokens or authenticate to other Nest APIs. Agent deletion does not revoke
a token; revoke it explicitly. All catalog reads require authentication.

| Method | Endpoint | Behavior |
|---|---|---|
| GET | `/api/community/skills` | Search `q`, filter `category`, paginate `offset`/`limit` (default 30, maximum 100). |
| POST | `/api/community/skills` | Publish `{schemaVersion:1,manifest,files}` with validated frontmatter and content. |
| GET | `/api/community/skills/:name` | Detail, file content and version history; optional `version`. |
| GET | `/api/community/skills/:name/download` | JSON attachment with optional `version`, file hashes and package digest. |
| GET | `/api/community/tokens` | Human's issued tokens, without secrets. |
| POST | `/api/community/tokens` | Human-only `{agentName}`; returns token secret once. |
| DELETE | `/api/community/tokens/:id` | Issuing human revokes token. |

The schema in `packages/schemas/src/community.ts` defines metadata, file paths and
content limits. POST requires JSON and caps requests at 1 MB. Packages contain up
to 64 files, 512 KB decoded total, 128 KB per file and 64 KB for UTF-8 `SKILL.md`.
YAML frontmatter must match manifest name, description and license. File traversal,
hidden path components, case-insensitive duplicates and file/directory overlaps
are rejected. The digest covers normalized metadata and sorted file descriptors
including SHA-256 content hashes; publishing never executes files.

The original human owns the slug. Its publishing agent may update its own packages;
the owning human may update those too. Releases are immutable, monotonically
increasing stable semantic versions. A same-version/same-digest retry succeeds;
conflicting content returns 409. Publication and token changes produce product
audit entries. Validation fails with 400, unauthenticated access with 401, and
unauthorized updates with 403. Catalog responses are not cached.

Community has one reusable artifact: a skill with instructions and supporting
files. Workflows are steps within skills; loops are repeated execution by an agent,
not another catalog type. The UI publishes new packages as `category: "skill"`;
legacy API categories remain supported and preserved on republish. No immutable
version, digest or engine state is migrated. Recurring-run controls are not provided.

The user UI uses `?view=community` and optional `&skill=<name>` with sidebar
selection and browser history support. Its Figma feed uses real catalog content,
a unified skills feed, agent author portraits and original cover/icon assets. Historical
versions are selectable within detail. Installation downloads an immutable bundle;
`scripts/community.mjs` verifies content and installs into an explicit host directory
without executing scripts or overwriting an existing package. Native skills still
need enabling through OrgOps; wrapped agents follow their external runtime's rules.
See [Community authoring and installation](COMMUNITY.md).


## Google Workspace sign-in

Nest provides a shared Google sign-in action on both login screens and an owner-only
administration screen under **Sign-in**. The engine owns migration 037's
`human_identities` and `google_auth_settings`; the product database is unchanged.
The gateway forwards `/api/auth/google/{config,start,callback,settings}` through
`packages/orgops-client`, preserving redirects and multiple Set-Cookie headers.
The browser-binding `orgops_google_state` cookie is preserved; only the authenticated
session is translated to `nest_session`.

The bundled launcher translates `NEST_GOOGLE_CLIENT_ID`, `NEST_GOOGLE_CLIENT_SECRET`
and `NEST_GOOGLE_REDIRECT_URI` to upstream names. Sign-in defaults disabled and
requires server configuration plus owner-saved domain/team settings. A verified
Workspace identity creates an engine human and team membership on first login.
Google subjects remain stable identities; local email collisions are not auto-linked.
Sessions expire after eight hours, and saving settings revokes Google sessions.
WebSocket traffic checks the session before processing messages or sending events.
Local owner sign-in remains available. There is no directory import, invitation
email delivery or continuous Workspace suspension synchronization.

See [Google Workspace setup](GOOGLE_WORKSPACE.md) for deployment and recovery.
`npm run test:ui:auth` captures desktop/mobile login and settings screens and tests
redirects/provisioning against real isolated engine/product APIs with a simulated
Google SDK boundary. Product integration tests verify both cookies, session rotation,
private data ownership and settings authorization. Live Google consent is a separate
production smoke check.

The merged authentication pin also includes upstream sensitive-message event
normalization and `/api/events/:id/reveal-sensitive` through the gateway. Reveal
requires a local password and is not available to Google-only accounts. Upstream
JSON-render and secret-input UI components remain upstream-owned and are not
rendered automatically by Nest.

## Project-first entry and onboarding

The dashboard remains the default home. Humans without owned projects see a
short welcome with one action to start their first project in chat. The first
message creates it; a name/description form is not required. Projects owns the work
navigation, including legacy conversations in a collapsed Existing conversations section. Chat itself
remains a project tab. Legacy standalone/shared links still open their existing
workspace with Projects selected. New project and Cmd/Ctrl+K open the same form.
Project ownership and existing chat history are preserved. New team projects
share product visibility through explicit current channel membership as described above.

The current upstream update adds HUMAN participant support in agent channel tools
while preserving legacy agentName arguments and engine permission checks. No new
engine migration is included. Upstream PR #49 (Google team membership repair) is
still awaiting review and is not included in this pin.

Project chat names are internal (`nest-project-<reservation marker>`), independent
of the human-readable project title. OrgOps requires globally unique channel names;
existing channels and other projects can therefore use the same product title
without blocking creation or linking unrelated history. Ambiguous reservations
retain the existing conservative recovery behavior.

## Personal-agent onboarding

Personal agents live in **Agents → Your team**, with an owner label and the same
settings surface as other agents. New teammates arrive in the Agents directory;
**Add your agent** opens `?view=agents&create=personal` with the original Figma
characters, name and brief. Creation opens the agent's details; model/instructions
and Connected apps are configured there. **Open private chat** opens the original
private workspace and completes any unfinished setup mapping.

There is no My agent sidebar entry or standalone setup page. Legacy
`?view=onboarding` and `/onboarding` OAuth return links normalize to the existing
agent's detail URL, or creation when it has not been provisioned. Explicit project
and conversation deep links remain intact; completed users keep dashboard home.

`GET /api/onboarding` returns the current human's setup and availability.
`POST /api/onboarding/agent` validates `{name, character, brief}`, reserves one
setup per human and provisions/reconciles a private native agent and channel via
human-authenticated engine HTTP calls. `POST /api/onboarding/complete` verifies
current ownership and persists completion. Requests strip runner credentials;
16 KB bodies and no-store responses apply. Migration `004_personal_agents`
stores setup intent, configuration snapshot and engine mappings in Nest only.

The instance's configured model and online runner are prerequisites. A reserved
workspace and globally unique names allow safe reconciliation after lost responses.
Removed/renamed resources or changed ownership are not silently replaced. The
original setup fields cannot be changed by a replay. Product setup has no stored
human credentials, engine DB access or provider tokens.

Connections now belong to Nest's `/api/integrations` adapter and the bundled
`nest-connections` instance skill. OrgOps PR #50 is closed; the engine pin is
unchanged. Migration `005_integrations` stores provider account mappings, exact
tool grants and hashed 30-day skill tokens in the product database. The engine's
existing private secret API supplies the token to its agent. Provider credentials
stay in Nest; engine processes have Composio configuration removed at launch.
OAuth return fields are not trusted; status comes from the provider adapter.

`GET /api/integrations/agents/:name/skill` reports the existing token status plus
`grantedToolCount` (saved permissions for this agent on locally nonrevoked accounts
of the current provider) and `preloadConfigured` (the enabled connection skill is
configured in `alwaysPreloadedSkills`). Neither reports live account eligibility.
Enable/Renew requires at least one saved tool permission (409 when empty), then
preserves other enabled/preloaded skills while adding `nest-connections` to both
sets through the existing engine PATCH API. No prompt rewriting or workspace
permission change is performed. Owners renew legacy credentials to opt into this
preload; no existing agent/token is silently upgraded. Settings refresh status
after saving tool grants or refreshing/disconnecting accounts.

Human settings require current private-agent ownership. Skill execution validates
that ownership, exact grants and provider account status. Without a core turn
attestation API, access requires one or more unshared owner-only private channels plus
explicitly owner-approved project audiences (see Project connection approval below).
Other subscriptions or sharing deny all connected-account calls for that agent. The canonical runner lifecycle GROUP is allowed only while
private, owner-owned, unarchived, unshared and limited to the agent and optionally
its owner. Enable/Renew secures its default PUBLIC channel via the human's existing
engine channel PATCH API, then re-reads metadata before issuing credentials.
Execution never changes channel permissions and rejects a public lifecycle channel.
A lifecycle name alone does not exempt a channel from privacy checks. Runtime isolation remains deployment-owned. A correctly configured global
engine metadata token and trusted shared runtime are prerequisites, not inferred
security guarantees. See [PERSONAL_AGENTS.md](PERSONAL_AGENTS.md) for installation,
configuration, expiry/renewal, limitations and live release checks.

Connected-app permissions default to a compact Give all access action, with
locally served brand logos for the initial supported apps and a generic app icon
for unknown providers. Choose specific actions expands the advanced search,
Selected view and compact permission rows. Full provider descriptions and exact
references remain under About this action; action titles are presentation only.
The collapsed default does not fetch the catalog.

Give all access loads every provider page and saves the exact current catalog
through the existing grant endpoint in one explicit click. It ignores advanced
search filters, reports success only after saving and does not grant future tools
automatically. Advanced choices require Save access, and bulk Select all results
keeps existing selections across search and pagination. Page failures or sets
exceeding the 2,000-action request bound never partially select or grant tools.
UI and API share a 2,000-action bound per account. Grant PUT requests accept up to
512,000 bytes (all other integration bodies retain their 64,000-byte limit).
Selections over 20 actions are validated against paged provider catalog IDs
instead of one lookup per action. Catalog traversal stops once every requested
ID is verified, rejects missing/foreign tools, and bounds/rejects repeated pages.
Ownership and local revocation are rechecked after validation before writing;
provider failures leave the previous grant intact. No wildcard or future-tool
permission is introduced and no engine change or migration is required.

Saved access remains distinct from pending advanced choices; discarding restores
saved choices. No guessed read/write classifications are introduced.

## Agent model defaults and selection

Nest exposes authenticated `GET /api/agent-models`, a sanitized enabled native
model catalog from OrgOps plus the resolved instance default. No engine database
or provider credentials are read. `NEST_DEFAULT_AGENT_MODEL_ID` (legacy fallback:
`NEST_PERSONAL_AGENT_MODEL_ID`) resolves a registry ID to the runner's provider:model
reference. Nest supplies it on native `POST /api/agents` only if modelId is absent
or empty. Explicit references and WRAPPED creation retain engine semantics.
Missing/disabled defaults return 503, rather than creating a broken native agent.

User settings and admin creation use the catalog in a labelled model dropdown,
with loading/retry/empty states and preservation of unknown current references.
Changes use the existing engine PATCH and authorization; running turns keep their
current configuration until the next turn. Onboarding reservations preserve their
snapshotted reference across later default changes. No migration is required.

## Settings and page loading

Agent details keep the team description (**About this agent**) and native model
selector visible. **Advanced** is closed initially and contains full system
instructions and runtime/model/workspace/runner/skill details. Editing the team
description does not change the agent's instructions. Saving, permission checks,
unknown model references and wrapped-runtime ownership are unchanged.

`GET /api/onboarding/summary` authenticates the human and returns only their
product setup mapping (`{setup}`). Navigation uses this lightweight response;
it does not probe models, runner health, agents, channels or Composio. Existing
initial setup and legacy OAuth routing use the same mapping as before.

`GET /api/onboarding/connections` remains a compatibility availability response
from local Nest adapter configuration. Agent settings use authenticated
`GET /api/integrations/config` and have independent loading/error/retry states;
connection setup cannot block or reset settings edits. No engine provider
capability probe is needed. The complete `/api/onboarding` status remains
available to agent creation, where provisioning readiness matters. Model catalogs
load only for native agent details. Initial unread notification fetching no
longer holds the shell's loading state.

## Selected mentions and message delivery

Nest's composer sends `POST /api/messages` with a stable send UUID, channel, text,
attachments and selected mention spans. A selected agent produces the existing
engine `payload.targetAgentName`; multiple distinct selected agents produce
`payload.targetAgentNames` and each receives the same message event. Unselected
agents do not start a turn for it. Multiple selected people receive
in-app mention notifications. Unselected @ text retains ordinary channel delivery
and may still be interpreted by an agent's coordination instructions.

The picker keeps human and agent identities distinct, supports names with spaces
and email handles. Eligible nonmembers offer Add to chat and mention when the
human can manage invitations (the owner for product projects). Selection explicitly
shares chat history/files, calls the existing project-members or engine-subscribe
HTTP API, and confirms membership before inserting routing metadata. An uncertain
response is reconciled by reading the current roster. Failure preserves the draft;
changing chats during the request never inserts into another conversation.
Nonmanagers see an explanation. Another owner's private agent is never invited
through this picker; published personal assistants keep their owner-approval path.
Editing a selected name removes its routing metadata. Surrounding edits preserve
it. The composer shows Ask/Notify recipients and permits multiple-agent sends.
Server validation checks span/text agreement, recipient membership, agent
visibility, human identity and current channel posting rights. It derives source
from the human session. Sending itself never subscribes a recipient or expands
tool grants; the explicit picker invitation is a separate operation.

`POST /api/messages` also accepts an optional `replyTo`, the engine event ID (1 to 200 characters) of the message being answered. It is part of the send identity and the stored fingerprint, so changing it under the same send ID is rejected like any other changed content. The target is validated only when no intent row exists for the send ID, so an unchanged retry still recovers after the target disappeared: it must be a `message.created` event in the same channel that the sender can read through the engine's `GET /api/events/:id`. Otherwise the response is 400 `{error, code: "REPLY_TARGET_INVALID"}` with one message for every cause, so it does not reveal whether the target exists. The reply is recorded as the engine's existing `payload.inReplyTo`; `parentEventId` is never set. A reply adds no targeting: only selected mentions decide who is asked. The composer's picker also serves the `/` commands described under "Chat on assistant-ui".

Migration `006_mentions.sql` stores Nest send intent hashes, a planned engine
event UUID, delivery confirmations and notification read state. Text and
attachments remain authoritative in the engine event log. A retry of unchanged
content uses the same planned ID and engine idempotency key; HTTP receipt checks
recover a committed event after a lost response or Nest restart. Changed content
under the same send ID is rejected. Confirmed removed messages are not recreated.
A failed response leaves the draft intact for retry; this is not an automatic
background delivery queue or a cross-database transaction.

`GET /api/mentions` reads the current human's product notification references and
checks engine channel visibility and event receipts before returning previews.
It shows at most 20 current items, unread first. Reading them lets earlier unread
items surface. `POST /api/mentions/:id/read` checks recipient ownership and
current engine access. Read state persists across sessions; deleted events and
revoked visibility are omitted. Notifications cover selected human mentions sent
through Nest, not arbitrary engine-native @ text. There are no email, browser-push
or Slack notifications in this slice.

The sidebar inbox opens the exact message with a `message` URL parameter,
including an HTTP fetch when it is outside the loaded chat page. Reload and
history restore the highlighted message. Inbox loading does not block the shell;
HTTP polling, focus and realtime message activity refresh it.

Runtime isolation remains unchanged. Targeting or inviting a personal agent does
not grant connected-account access. Project audiences require explicit owner approval. See PERSONAL_AGENTS.md for that separate permission boundary.

## Personal-assistant requests

Migration `007_agent_requests.sql` adds opt-in assistant offers and owner/requester
work requests to Nest's product DB. Only an onboarding-mapped PRIVATE native agent
with the same current engine ID and owner can be offered. Publication is off by
default; the owner writes a separate public description. Authenticated discovery
exposes only that description, agent name and current owner's username. Engine
instructions, model, workspace, tool grants, account IDs and private chats are not
published. Shared profiles are listed separately from the visibility-filtered team runtime counts. Missing metadata configuration returns a setup error without blocking
ordinary agent settings.

Agents contains All agents and Requests views. Shared personal assistants expose
an Ask action. In a writable chat, the fuzzy @ picker can offer a published
assistant outside that chat, labelled Request owner approval. Selecting it opens
a request form with the human's draft text; it does not insert a selected engine
recipient, publish a chat message, join a channel or grant account access. Existing
in-chat selected mention delivery keeps its original semantics.

`?view=agents&tab=requests` restores the inbox; `&assistant=<name>` restores a new
request and `&request=<uuid>` restores details. Incoming and Outgoing lists poll
20 seconds; details poll 15 seconds. Lists are participant-only and paginated at
50 items by default (maximum 100). The browser retains an attempted creation's
UUID and immutable brief in user-scoped tab storage, so retries after a lost
response/reload recover one request. It does not store sessions or credentials.

The first flow is explicitly human reviewed:

1. Request creation saves a pending brief only in Nest; no guest prompt reaches
   the privileged agent before its owner approves the work.
2. The owner approves using their current human session. Nest verifies the pinned
   personal mapping and the strict private-context boundary (project connection approvals do not extend assistant request dispatch):
   one unshared owner-only conversation plus a secured canonical lifecycle GROUP.
   It never subscribes the requester. The approved engine event is sourced from
   the approving human and targets the existing agent.
3. A durable dispatch UUID and engine idempotency key survive a lost response or
   Nest restart. Receipts must match the owner, channel, agent, request and brief.
   Version checks serialize conflicting decisions. Unconfirmed delivery remains
   explicitly retryable; confirmed delivery is not silently recreated.
4. Only the owner can list private agent responses after dispatch. They select a
   relevant response, edit an outgoing reply and explicitly share that text.
   Replies are persisted product deliverables, not a mirror of engine history.
   The requester sees only the human-approved text in Requests. No raw private
   response/event/channel IDs, uploaded files or account credentials are returned.

`pending` requests can be cancelled by their requester or declined by their
owner. `dispatching` means private delivery is unconfirmed; `working` means a
confirmed event was sent, not that a model/tool call succeeded. The human's reply
marks `completed`. Turning publication off stops new requests, while existing
requests remain available to their two participants. Changed ownership, visibility,
engine IDs or private context fail closed for approval and response access.
Audit stores IDs/status transitions, never briefs, private results or credentials.

This slice approves a work brief using the agent's existing exact tool grants;
it does not implement per-action/resource restrictions, standing permissions,
automatic result correlation, external notifications, automatic team-chat reply
publication or OS isolation. Private response selection is manual because another
approved task or owner conversation may produce responses in the same chat.
See [AGENT_REQUESTS.md](AGENT_REQUESTS.md) for the user flow and rollout checks.
OrgOps source and the submodule pin remain untouched.

## Wrapped agent management

NestSystem's Nest-owned Codex bridge publishes completed interim assistant messages
as the existing `agent.turn.phase` event with `phase=codex-progress`, text, and the
originating trigger ID. A following Codex item identifies an interim message; the
last assistant message remains on the runner's existing final-response path. Raw
JSONL, reasoning, tool arguments/results and stderr are never forwarded as progress.
`packages/orgops-client` posts the event to the engine using the bridge's retained
runner credential, channel and parent event. Stable per-item identities reconcile
lost responses; bounded best-effort delivery cannot prevent a final reply.

The chat keeps its compact activity icons and shows only the latest progress text
for each active turn, including across intervening human messages. Completion or
failure clears that text; earlier updates remain available in activity details.
These bookkeeping events cannot wake other agents or create message notifications.
This does not change channel queuing, cancellation, timeouts or runtime isolation.

An operator can permanently authorize one trusted wrapped manager using
`NEST_MANAGEMENT_AGENT_NAME` and its pinned `NEST_MANAGEMENT_AGENT_ID`.
`GET /api/agent-management/context`, `GET /api/agent-management/agents/:name`
and `POST /api/agent-management/agents` accept a creation/owner-lookup signed
capability bound to the originating human event and
current channel membership. It has no time expiry or human-session dependency.
The bridge retains the engine key and supplies only the proof to Codex. Disabling
the allowlist or rotating the key revokes old proofs.

Creation accepts only name/description/instructions and derives private ownership,
the instance default native model, manager's online runner, isolated workspace path
and disabled owner-secret delegation. It grants no OS sandbox or new connected-tool
permissions. Engine HTTP endpoints remain authoritative; no engine DB is read.
Retries reconcile the unique name and exact configuration/workspace rather than
creating duplicates or overwriting existing agents. Product audit records identify
the manager, requester and originating event without credentials. See
[operator installation and boundaries](AGENT_MANAGEMENT.md).

Exact-name lookup returns minimal metadata and a settings link only for the
requesting human's private agent, rechecking current management context after the
lookup. Other owners', public and missing agents share a 404 response. This lets a
later human "retry" find an agent created by an earlier message without treating
the new message as the original creation request or applying changed instructions.


## Project invitations through a trusted manager

The configured wrapped manager can use
`GET/POST /api/agent-management/project/members` with its existing signed request capability.
The GET returns minimal project identity/link, current participants and available
exact HUMAN/AGENT identities. Agents are filtered to public or requester-owned;
other-owner private agents are omitted from available identities. Existing project
participant identities keep their engine membership visibility.

POST accepts one strict `ProjectMemberSchema` identity, without a channel or
project override. Nest derives the project from the signed triggering channel and
requires the originating human to own both the team project and that channel.
Standalone conversations, legacy creator-private projects, other owners and
revoked context are denied. Agent invitations recheck target visibility and current
request membership before the engine subscription write. The capability does not
grant arbitrary engine API access. Creation defaults/model/online-runner checks
remain on creation; invitations only require current valid request authority.

The helper exposes `project-members` and `invite` commands. Its skill requires an
explicit request to add/invite named identities; mentioning someone alone does not
change membership. Existing membership is a no-op; uncertain writes are reconciled
against engine participants before success is returned. Requested/confirmed writes
are audited in Nest with requester, manager, project, trigger and typed identity,
without credentials. No email/new account, removal, role change, account connection
or automatic agent work is introduced. Engine HTTP remains authoritative, with no
engine DB reads or source changes. This uses request-time checks across HTTP;
there is no cross-system atomic permission transaction or invitation rollback.


## Background AI project naming

`POST /api/projects/:projectId/suggest-details` accepts a confirmed product message
request ID and the expected fallback metadata. Only the project owner with current
engine access can invoke it. Nest verifies that the delivered message belongs to
this owner/project and reads that event over engine HTTP; arbitrary caller prompts
or other conversations cannot be supplied. It sends only the opening text (bounded
to 8,000 characters) to the configured LLM with a JSON-only metadata prompt, no
tools, a 20-second timeout and bounded output. Generated metadata is schema-checked.

Provider credentials stay server-side. The selected provider's API environment key
is reused when present. Otherwise the OrgOps client resolves the configured system
agent's provider environment through `/api/secrets/env`, without a channel/team
context, and returns only the required provider key/options. The source agent must
have owner-human secret delegation explicitly disabled and match the manager's
pinned ID when using its default source. It does not resolve a user's personal
agent/accounts, read the engine database, or return secrets/model diagnostics.

An atomic product audit/metadata check prevents AI from replacing any manually
saved metadata, including a same-value save, or applying a second successful
suggestion. Duplicate in-flight requests are coalesced within the API process.
A missing model/provider, invalid output, access change or timeout preserves the
usable first-message label and manual settings. The frontend fires naming after
message confirmation and the project view polls updated metadata; it does not
navigate again when generation finishes. This is a best-effort background request,
not a durable worker queue: closing the browser/API restart can interrupt it and
there is no automatic retry/billing loop. No new database migration is needed.


## Frictionless project workspace

The creation roster also returns `personalAgent` only when the product onboarding mapping's pinned engine ID, current PRIVATE visibility, native mode and human owner match an engine HTTP detail read. The fresh chat draft includes this agent visibly and permits starting without it. It is subscribed only with the first submitted project intent, never merely on opening the draft; selected agent mentions override the first-message target. Older submitted drafts never gain new implicit members.

`POST /api/messages` accepts an optional explicit `targetAgentName` without changing human text. It must match the sole selected agent mention when present (combining an explicit single target with multiple selected agents is rejected), be a current subscribed visible agent, and is included in the durable send identity and receipt. The engine's existing target field is used unchanged.

An optional `replyTo` sits beside `targetAgentName` in the same durable send identity and receipt (see "Selected mentions and message delivery").

Chat/Files are normal project tabs. Project details contains the brief, owner-only inline editing with existing compare-and-swap, counts and typed member list, and searchable invitations. Mobile exposes it above chat in a disclosure. Legacy Members links render chat with details available. Advanced sharing remains in the existing engine-backed dialog. `POST /api/projects/:id/members` requires the current product owner with live engine manage/post access, validates exact existing HUMAN/AGENT identities and current agent visibility, and reconciles ambiguous subscriptions before reporting success. It grants no personal connected-account access.

Personal connected skills require an unshared owner-only conversation and explicit approval for every additional project audience. Automatic project invitation grants no app access; joining pauses connected tools until owner approval. No new provisioning, model calls, account grants, engine changes or migrations are introduced by this workspace refinement.


## Local project and conversation drafts

Fresh project drafts now use owner-scoped local storage, with recovery from the earlier owner-bound tab draft. Existing conversations save text, selected mentions and already-uploaded file references by current human ID and engine channel ID. The stable send request ID/fingerprint is saved before posting, so an uncertain response can be recovered after refresh with one explicit Send. Local file bytes and in-progress uploads are not persisted; only confirmed upload references can be restored. Nothing is sent automatically.

Drafts are stored on this browser/device, not synchronized between devices or used as server permissions. Invalid/blocked/quota-failed storage is tolerated and the composer reports when saving is unavailable. Signing out clears the current owner's drafts and recent project reference. Owner/channel scopes and matching-snapshot removal prevent one conversation or a late response from clearing another draft. The dashboard's Continue your project action resolves only against the currently accessible project index, so removed access cannot reveal a saved project title.

A conversation draft also stores its reply target as `replyTo: {eventId, author, excerpt}`, with the excerpt cut to at most 500 characters. The field is optional, so drafts saved before it existed still load.


## Kickoff guidance and contextual connections

New auto-created project channels include `nestKickoffGuidance` alongside the existing recovery marker. Native OrgOps already includes the channel record in system context. This Nest-owned policy asks the first reply to acknowledge the goal, suggest one next action and ask at most one essential question, with truthful tool/account status and explicit human permissions. It guides model behavior; it does not guarantee wording, rewrite outputs, create extra model calls, or overwrite agent instructions. Existing chats/channels are not patched.

Recent confirmed project messages can surface at most two optional app connections. Matching uses explicit supported app names, then verifies an exact connectable slug in the configured provider catalog. Only app search terms go to the catalog, not message contents. Currently active owner accounts are suppressed after a complete bounded account traversal; an incomplete list or provider outage suppresses suggestions without blocking chat. The user can dismiss suggestions. A human click uses the existing owner-authenticated linking API and an HTTPS authorization redirect. No connection token or grant is issued by a suggestion, and no tool is executed.

The UI explicitly states that account linking does not give agents project access. Project subscription pauses personal connected tools until the owner explicitly approves that project audience in Connected apps. Authorization and exact per-agent grants are separate steps. A tab-scoped owner/project return marker restores a successful fixed-provider callback only to a currently accessible project; explicit channel/project/share links win. Callback status/account IDs are navigation hints, never proof of authorization; the provider API remains authoritative for connection state. Browser drafts survive the round trip. Signing out clears the owner's return marker.


## Chat attachments and activity

On a chat screen, files dropped over the header, navigation, message history,
composer or project panel join the current message draft. The new-project chat
supports the same upload path and a keyboard-accessible file picker before the
project exists. Dropping does not send, create a project or invoke a model.
File-only opening messages use the attached filenames as provisional context.
Confirmed file references survive draft reload; local bytes and unfinished
uploads do not. Upload results remain bound to their original owner/channel/draft.

Picker, pasted images and drops share the message schema's 20-file limit.
Uploads still use the existing authenticated engine file HTTP API. Failed uploads
must be removed before sending, with the draft preserved. Archived, read-only and
sending states block new attachments. Folder drops explain how to use a ZIP or
individual files; ordinary text/link drags retain browser behaviour.

Activity keeps the original tiny 22px event boxes, replacing letter abbreviations
with SVG icons. Green and red distinguish successful and failed events; hover or
keyboard focus shows a short event label and timestamp. Clicking/tapping a box
opens a compact label card with an optional Details toggle for the recorded
event payload; clicking/tapping the box again closes the card. Mobile needs no
hover. No summary prose or step list is shown by default. Diagnostic output and missing process exit codes
do not imply failure. Event colours describe individual events, never project
acceptance. No execution, retry or engine event semantics change.

Live progress text no longer appears inside the activity group: it moves to the working row of the active turn (see "Chat on assistant-ui"). Uploads go through `XMLHttpRequest` to the same authenticated file API, so each pending file shows a real progress bar, and image files show a thumbnail before sending. The activity chips themselves are unchanged.

## Project connection approval

Migration `009_connection_projects` stores explicit owner consent per private agent
and owned team project, with a SHA-256 snapshot of channel ID, owner and sorted
HUMAN/AGENT participants. No approval is created by invitations or deployment.
`GET /api/integrations/agents/:name/projects` reviews subscribed owned team projects;
`PUT /api/integrations/agents/:name/projects/:id` requires the displayed
`audienceHash` and `acknowledgeSharedAccess:true`; stale snapshots return 409.
DELETE revokes approval. All management routes require current human ownership;
agent bearer credentials cannot approve themselves. Public, archived, shared,
foreign-owned and legacy private projects are ineligible.

All skill endpoints recheck the full subscription set and exact current audience.
Schema and execution recheck after provider metadata reads, before dispatch.
Unapproved projects, unsafe conversations, changed audiences, ownership or sharing pause calls
agent-wide. The original private chat and secured lifecycle remain mandatory.
Assistant request dispatch retains its original private-only validator.

This is explicit delegation to trusted project participants, not per-turn identity
verification or data isolation. Every approved person/agent may influence use of
all this agent's granted tools, including later grants, and see outputs. The agent
can carry information across chats; removal does not erase prior results or
memory. Calls already sent to a provider cannot be recalled. Metadata validation
and provider execution are not an atomic transaction across systems. The runtime
remains trusted. Exact tool grants, expiry, account ownership and revocation remain
enforced. Audit records include approval/revocation IDs and audience hashes,
never credentials, arguments or tool results.
The engine metadata API exposes viewers but not unclaimed share links. Claims
add a viewer and block subsequent calls; link creation alone is not detected.
New members/viewers can read historical outputs regardless of later tool denial.
### Image attachment previews

Chat message attachments with PNG, JPEG, GIF, or WebP MIME types show lazy-loaded,
responsive inline previews linked to the existing file endpoint. Names, MIME
types, sizes, and download links remain visible. Failed previews fall back to
the file link; SVG and other file types remain links rather than inline images.
Native agents publish generated files with OrgOps `fs_upload`, then include the
returned attachment in their message payload. No public static copy is created.

A plain click on an inline preview opens a zoom view of the image with an "Open original" link. A click with a modifier key, a middle click and keyboard activation still follow the file link as before. SVG files stay link only and never open in the zoom view.


## Chat sender avatars

Human and agent messages show a decorative 32px avatar beside the sender name.
Agents reuse `AgentAvatar` and the current configured character from the Agents
screen, with its existing deterministic/image-error fallback. Humans use initials
from the recorded sender name; the engine human/auth APIs do not provide profile
photos. Rendering does not fetch external avatar services or add profile storage.
Historical senders remain visible even if absent from the current directory.
Names, timestamps, message anchors, attachments, targeting and compact activity
retain their existing behaviour in project and standalone chats.

Consecutive messages from the same author within 5 minutes on the same day are grouped: the avatar and name show once, on the first message of the group. A date separator marks the first message of each day.


Connected apps support any number of unshared, active owner-only conversations alongside explicitly approved projects. Every subscribed conversation must still pass the owner/privacy checks or project roster approval; archived or unsafe subscriptions pause access. The credential remains bound to its original private conversation, which must still exist. Assistant request dispatch retains its separate single-private-conversation boundary. No additional migration or engine change is required.

## Chat on assistant-ui

Project and standalone chats render their message list with assistant-ui. The old hand-written message list, its switch (`?chatUi`, the `nest:chat-ui` storage key and `VITE_NEST_CHAT_UI`) and the dev-only kit preview page are removed; there is one chat. `ChatFileDrop`, the workspace header, error notices, `DemoArtifact` and the participants panel with its "Agent is thinking" line are unchanged.

1. Runtime. `ChatThread` (`apps/user-ui/src/chat/ChatThread.tsx`) drives assistant-ui through `useExternalStoreRuntime` with `isRunning: false`. Nest's channel events store (`chat/channel-events.ts`) stays the source of truth: the runtime only renders the timeline Nest builds from engine events, and sending stays with Nest's composer and `POST /api/messages`. assistant-ui never sends, edits or regenerates on its own.

2. History. The first page issues 7 engine event queries (`chat/history.ts`, `CHAT_EVENT_QUERIES`: messages, failed turns, turn events, tool events, context telemetry, wrapper turns and process events), each with its own cursor, so a busy query family never hides another. Later pages issue up to 7: `requestedQueries` skips every query family whose cursor is exhausted. Scrolling near the top loads the previous page. A deep link to a message outside the loaded pages fetches that event alone through `GET /api/events/:id` and shows it as detached; detached events never move the paging cursors, and an "Earlier messages not loaded" marker separates them from the loaded history. A deep-linked message is scrolled into view, focused and highlighted by the thread itself.

3. Working row. While an agent's turn is active, a working row with the agent's avatar, name and an animated indicator follows the message that triggered it (or the last item when that message is not loaded). It is a `role="status"` element. It starts with `agent.turn.started` or `wrapper.turn.started`, shows the latest codex or wrapped progress text from `agent.turn.phase` events (only that whitelisted text, never tool arguments or output), and ends when the turn completes or fails, when a newer turn of the same agent supersedes it, or when the agent was stopped after the turn began. There is no time limit. Agents created through `POST /api/agents` without a `desiredState` default to RUNNING (only the agent-copy route and `POST /api/federation/agents/transfer`, the remote leg of a copy, default to STOPPED), and the engine bumps `updatedAt` on every agent update, not only on stop. Stopping an agent sets `desiredState` to STOPPED and `updatedAt` to the time of the stop in milliseconds, so the row ends when `desiredState` is STOPPED and `updatedAt` is later than the turn's first event. `desiredState` alone is not used, because an agent may already be STOPPED before the turn began, and `runtimeState` is not used, because agents without a live runner report STOPPED while their events still arrive. `WorkingRow` renders `AgentAvatar` inside a plain sized `div`, not the `.agent-portrait` wrapper message headers use. The participants panel line is unchanged.

4. Message actions. Each message (never an activity group or a working row) has Copy message (the raw text), Copy link (the existing `?message=` deep link) and Quote. Desktop shows the bar on hover and keyboard focus; touch toggles it with a tap. Selecting text inside one message body offers "Quote selection". Activity groups and the working row carry `data-aui-quote-selectable="false"`; `selectionQuote` (`chat/quote.ts`) rejects a selection that spans two messages or whose anchor or focus end lies in such an element, checking only those two ends. That rule is covered by the unit tests of `selectionQuote`; the browser case for activity cards passes on structure alone, because activity wrappers sit outside `[data-message-id]`.

5. Quote reply. Quoting inserts a Markdown blockquote of the author and text (cut to 2000 characters) into the composer and sets the reply target, shown above the composer as "Replying to" the author with a way to clear it. Sending passes `replyTo`. A message with `payload.inReplyTo` shows "Replying to <author>" above its body only when the target resolves (from the loaded events, else `GET /api/events/:id`) to a `message.created` in the same channel; any other result shows nothing. Clicking it runs the normal deep link.

6. Export. An Export button above the thread downloads the loaded conversation as Markdown: a title, then each message with author, a sortable timestamp, its text and links to its attachments. An activity group becomes one count line ("Agent activity: N events"); event payloads, tool details and progress text are never exported.

7. Slash commands. Typing `/` at the start of the composer opens the same picker that serves mentions, with only the commands the user may run there: `/invite` (people or agents, offered only to users who may invite to this chat) and `/files` (offered only in project chats, opens the project's Files tab). A command runs an existing UI action; it never sends a message.

8. Styling. Tailwind v4 is used in the user UI only (the admin UI stays on Tailwind 3.4) and is scoped to `.nest-chat`, `.nest-chat-composer` and `.nest-chat-portal` (`chat/chat.css`). There is no global preflight: the few base rules the copied components expect are applied inside the scope. Utilities are emitted as important so they win over the older global rules still bound to class names such as `.message` and `.messages-panel`. The `dark` variant follows Nest's `data-theme="dark"` attribute rather than the OS scheme, and the shadcn colour names are aliases of the Nest brand tokens. A reduced-motion layer disables animations and transitions when the reader prefers reduced motion. Radix dialogs and tooltips portal into `.nest-chat-portal`, never `document.body`.

9. Dependencies. The user UI pins `@assistant-ui/react` 0.15.31, `@assistant-ui/react-markdown` 0.14.24 and `@assistant-ui/react-syntax-highlighter` 0.14.7. They bring zod 4 and `assistant-cloud` in transitively; Nest does not use Assistant Cloud. React stays on 18.3.

10. Secrets. No secret, credential, tool argument or process output reaches copied text, copied links, the Markdown export or the working row's progress text: each reads only whitelisted fields.

## Authenticated published demos

`/demo/*` is a Nest-owned file route with a live OrgOps human-session check,
private/no-store responses. Anonymous HTML browser requests redirect to the existing login; non-HTML checks receive 401.
Vite development/preview middleware routes demo requests before static files,
including legacy demo symlinks. Published files remain outside the UI tree in
`.nest-data/demos`. See [deployment and publishing](../deploy/demos/README.md).

Demo browser navigations (Accept: text/html) redirect to the existing Nest login with a local demo return URL. Password and Google sign-in return to that demo, preserving query/fragment; first-time password changes complete before return. Non-HTML checks retain 401, preserving controller and publisher verification. Redirects accept only same-origin /demo/ destinations.

## Default trusted collaboration and published artifacts

### Current default trusted policy

All signed-in humans who have completed account setup may discover the
installation's registered personal agents and open a normal private conversation.
There is no trust edge, offer publication, request approval, or owner-presence
requirement. Project owners can invite registered personal agents using the same
member picker as other teammates. Registration is checked against current engine
agent ID, owner, native mode and private visibility; stale mappings do not grant
access. Arbitrary hidden agents and wrapped agents are not added to this directory.

Connected-account tokens remain scoped to the current agent and owner. Exact tool
grants, account ownership, credential expiry and revocation are checked as before,
including rechecks before execution. Teammates inherit existing grants, including
write actions. The agent's room roster, shared viewers, archive state and lifecycle
channel no longer grant or revoke tool access globally. Normal engine permissions
still govern who can read or post in each room. Existing private chats are not
opened to everyone, and no owner is silently added to a teammate's conversation.

The legacy token channel_id is retained as metadata only, with an empty value for
new tokens. Provider secrets are not handed to teammates. Agent settings, account
linking, grants, revocation and project membership management remain owner-managed.
Agents can carry information between conversations; this is not per-user memory
isolation or a restriction to read-only tools.

### Retired requests and approvals

Both approval panels are removed. The old request UI becomes a retirement notice
for bookmarked URLs. Request/offer mutations return 410 for authenticated humans.
Participant-only list/detail history remains readable; no unreleased replies,
private event IDs or channel IDs are returned. Pending requests are not dispatched,
completed or released automatically. Existing offers and audience rows remain
stored unused for rollback. There is no new database migration or engine patch.

The directory and mention actions open ordinary direct chats idempotently. Project
member options use the same registered-agent directory. Existing ordinary message
routing and permission checks handle the conversation after admission.

### Published artifacts

Files now includes a separate Published artifacts library for all demos and
reports on this Nest instance. Existing publication has no project registry, so
this is explicitly instance-wide rather than implying that every item belongs to
the currently open project. Chat uploads remain project-scoped in their own list.

GET /api/artifacts requires a current human session and completed account setup.
It scans only canonical slug directories and regular index.html files under the
configured demo root, excludes symlinks and incomplete publications, and returns
name, URL, modification time and byte count, with no-store caching. It does not
expose paths, source HTML, backup history or arbitrary workspace files. Refresh
picks up new publications; existing demos need no republish. Demo viewing retains
its existing authenticated route. No publication or production deployment is
performed by this refactor.

## Demo artifacts beside chat

Messages containing this instance's `/demo/<slug>` links expose a Preview button.
Opening it shows an isolated iframe beside the chat (stacked on narrow screens),
with phone-width, refresh, open-in-tab and close controls. Preview runs scripts
without same-origin privileges, forms, popups or top navigation; some demo
integrations may therefore need the full-page view. Existing authenticated demo
routing remains authoritative; previewing does not publish or grant access.

Request changes appends the demo URL to the current message draft without sending
or choosing an agent. The human describes changes and selects the appropriate
agent using the existing mention picker. The agent edits and republishes through
the existing publisher. While visible, the preview checks authenticated HEAD
responses every three seconds and reloads when the file revision changes. It
establishes its initial revision with one reload, leaves unchanged previews
intact, and stops polling when closed. Errors show a manual-refresh fallback;
requests time out after ten seconds and retry. Hidden tabs skip checks. Revision
headers use file identity, size and nanosecond timestamps; no HTML body is
downloaded by polling. This remains chat-based editing, not a direct HTML/visual editor.

## First-visit visual tour

The signed-in workspace header offers “Start here · 3 steps” until the human
finishes or skips the quick tour, then keeps “Quick tour” available for replay.
The invitation is non-blocking: it does not auto-open over a deep link or draft.
The three steps spotlight Agents, Projects and Community with brief explanations.
The tour does not create resources, navigate, send messages or change grants.
Completion is versioned per human ID in this browser's localStorage; another
browser shows the invitation again. Storage failure does not block the tour.

During the tour the underlying shell is inert, focus stays in the dialog, Escape
and Skip dismiss it, and focus returns to the launch control. On phones the
navigation opens for the spotlight and restores its prior state on dismissal.
Resize/scroll reposition the highlight. Existing personal-agent setup is unchanged.

### Chat refresh recovery

Chat refresh recovery tracks the newest fetched timestamp independently for each
of the seven event queries. After reconnecting, it pages backward to those saved
boundaries before committing the new head, so a gap larger than one page cannot
hide messages or activity. Concurrent refreshes share one request sequence; failed
gap fetches retain the previous window for retry, and channel switches discard late
responses. If the initial load failed, the first successful refresh also initializes
older-history cursors and availability. The existing same-millisecond engine limit
still applies; this change does not introduce an engine pagination API.

### Durable project naming

Naming is a Nest core background job, not an agent routine. On confirmed delivery
of the first owner message through `/api/messages`, Nest atomically stores a unique
job and delivery receipt. The browser no longer launches inference. The API polls
once every five seconds, processing one job at a time per process. SQLite leases
coordinate API processes sharing the same product database. Expired leases recover
after ten minutes; a lease token fences stale results. Provider calls can repeat
following a crash, but only one metadata update is applied.

Jobs keep request references and the expected metadata snapshot, never message
text, session cookies or provider credentials. The OrgOps adapter reads the source
and checks project channel ownership/archive state before and after inference.
Missing/deleted sources or changed ownership stop the job. Manual saves, including
same-value saves, take precedence through the existing audit/CAS rule. Only the
first delivered owner send is eligible; later conversation messages do not rename
projects. Legacy `suggest-details` calls now report pending/unavailable without
starting a second inference path.

The worker uses the existing enabled `NEST_PROJECT_NAMING_MODEL_ID` override or
instance default model. Select an OpenRouter registry entry to use the existing
OpenRouter key. Keys resolve from the API environment or the configured system
agent's encrypted environment via HTTP; no agent turn or online runner is needed.
The source agent record must still exist with owner-human secret delegation off.
`NEST_RUNNER_TOKEN` is required for the worker's engine metadata reads. Missing
configuration, disabled models, timeouts, rate limits and invalid output retry
up to five attempts with 30/60/120/240-second backoff, then keep fallback metadata.
Operator diagnostics are the job status/attempt count in Nest product storage;
raw provider errors are neither logged nor returned. There is no automatic bulk
backfill or infinite retry. Failed jobs remain available for inspection.

Prompts ask for a short noun-phrase title and a transformed brief, removing filler
and preserving supplied constraints without inventing scope. JSON/schema validation
bounds output; semantic quality still depends on the configured model. Original
chat text remains unchanged. Existing project refresh/polling reveals new metadata.
Attachments are not read by this routine; file-only openings use their message text.

Project cards limit descriptions to three visible lines; the full stored brief remains
available in project details. Automatic naming prefers the enabled
`openrouter:google/gemini-2.5-flash` catalog entry unless a naming model is explicitly
configured. Without that entry it uses the default agent model.

## Dashboard live activity

The dashboard's Active runs section reads `/api/dashboard/activity` on mount,
every 15 seconds while visible, and on focus/visibility return. It uses human-scoped
engine HTTP reads for lifecycle events, agents and accessible channels; it never
uses runner credentials or reads engine storage. Project task summaries and agent
online state are not used as evidence of an active turn. Project and standalone
conversations are included; archived/inaccessible conversations are excluded.

The adapter pairs agent.turn.started with completed/failed by agent, channel and
trigger; newer turns supersede older unterminated turns within that chat. Stopped
or crashed agents suppress prior runs. Starts without recent start/agent-heartbeat
evidence (120s) are shown as Status unconfirmed. The latest 1000 lifecycle events
(excluding phase payloads) bound each request; a full window is labelled limited
and its ambiguous timestamp boundary is omitted. Missing start telemetry cannot
be reconstructed. Failures render unavailable rather than a misleading zero.
Only names, channel links, timestamps and state are returned, never event bodies,
commands or process output. Open chat uses normal conversation navigation.
## OpenRouter model picker

Agent settings offer a collapsed-by-default model explorer, showing the selected
model in its summary. Opening it loads a live OpenRouter catalog
(`/api/openrouter-models`, signed-in humans only). Five tool-capable text models
are shown in OpenRouter weekly token-usage order, with search, image-input filter,
provider marks, advertised capabilities, context and USD/million-token prices.
The shortlist uses popularity, not benchmark scores. Model descriptions are
collapsed behind About; the UI omits the ranking explanation. Catalog data is
cached 15 minutes, with explicitly stale fallback for at most 24 hours.

`POST /api/agents/:name/model-check` accepts `{model: "provider/model"}`. A live
human must be allowed to edit that agent (public agent or private owner). The
adapter resolves that agent's provider env using the configured engine token,
returns only OpenRouter keys server-side, and uses the same OrgOps LLM library
for a bounded synthetic tool check. No chat, instructions or real tools are sent.
Checks have a 20s deadline, 256-token output limit, one step and 30s per-human
cooldown per API process. Provider errors and credentials are not returned.
Passing selects the model in the form; the existing engine-authorized settings
PATCH saves it. Tests never mutate the model or enable a global registry entry.
Wrapped agents retain external model management. Colon variants are rejected
because the pinned LLM parser does not preserve those suffixes.

## Agent conversation navigation

The user sidebar groups private, unshared one-human/one-agent conversations under
each agent, excluding project channels. Agent clicks resume the last visited
non-archived conversation (stored per human/browser) or open the engine's direct
chat. New chat uses a named private channel and existing membership APIs, allowing
separate conversations without changing direct-chat deduplication. Existing
channel links remain valid. The agent workspace separates Chat, Settings and
Connected apps; model selection and instructions live inside Advanced settings.
No ownership or tool-grant rules change.

## Model value picker and GLM default

Agent names are plain text in user settings. The redundant configured-model
dropdown is removed; the OpenRouter picker is the single native-model control.
Connect still runs a synthetic tool call before Save settings applies a choice.

`GET /api/agents/:name/model-benchmarks` is human-authenticated and checks agent
ownership using the engine before resolving that agent's OpenRouter credential.
It reads OpenRouter's documented `/api/v1/benchmarks?source=artificial-analysis&task_type=intelligence`.
Only normalized scores/identities/timestamps are returned. Credentials stay
server-side. Responses coalesce and cache for six hours per hashed provider key,
with a 24-hour stale limit, one-minute failure cooldown and a bounded cache.
The chart joins exact catalog IDs/canonical slugs only, never approximate names,
and omits ambiguous/missing scores. Price is the equal-weight average of input
and output dollars per million tokens, not estimated task cost. Green rings
show the Pareto frontier within matching scored tool-capable models. Unscored
models remain available in the catalog/custom-ID flow. Benchmark failures never
prevent model selection; Artificial Analysis attribution is visible.

The built-in default for new native agents is `openrouter:z-ai/glm-5.3`, including
onboarding, ordinary creation and managed creation. It is a direct engine model
reference and does not require a model-registry preset. Explicit instance/config
overrides and supplied creation models remain authoritative; existing agents,
reserved onboarding attempts and externally managed wrapped models are retained.
On existing deployments, set `NEST_DEFAULT_AGENT_MODEL_ID=openrouter:z-ai/glm-5.3`
to replace an older default override. An OpenRouter key and an available runner
are still required for execution. No engine source or model-registry mutation.

Sources: https://openrouter.ai/docs/api/api-reference/benchmarks/list-benchmarks
and https://openrouter.ai/z-ai/glm-5.3 .

### Trusted invitations for visible agents

Project owners may invite agents already visible through their human-scoped engine session, including private agents owned by teammates outside the onboarding directory. The mention picker applies the same rule. Project/channel management checks remain required; agent ownership, private history, credentials and settings are unchanged. The engine rechecks access when subscribing.
