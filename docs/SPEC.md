# Nest implementation spec

Nest is the product layer around OrgOps. OrgOps is a pinned, untouched Git
submodule at `vendor/orgops`, sourced from https://github.com/camplight/orgops.
Nest does not keep a second copy of the engine or apply source patches.
The current pin is `cc8faa0` (OrgOps PRs #55, #56, #58 and #59 over `f7c95b7`).
It retains multi-agent message routing and native workspace-file uploads and adds
human invitations into channels, engine LLM usage reporting, agent copy/move and
federation APIs. External engines must use this revision for the current adapter.

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
After confirmed message delivery, a separate request generates an AI name and
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
are kept in agreement with this schema. Both databases already participate in
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

Wrapped bridges choose the progress phase through the shared adapter:
NestSystem keeps `codex-progress`, and other runtimes use `wrapped-progress`.
The chat renders both the same way; any other phase stays out of the chat.

## Claude Code wrapped runtime

`deploy/claude-code-bridge.mjs` runs Claude Code headlessly as a command recipe
(`kind: "claude-code"`, per-channel sessions). Each turn resumes the Claude Code
session mapped to the runner's session key, stored outside the workspace; a
missing history starts a new session with a progress notice. Stream-json output
is reduced to top-level assistant text: interim text becomes `wrapped-progress`
and the `result` is the reply. Failures print one classified line, because the
runner shows stderr in chat. The bridge passes only host basics and Claude Code
credentials, never Nest's admin, master-key or runner credentials; an API key
reaches Claude Code through a per-turn helper file rather than the environment.

`NEST_CLAUDE_PERMISSIONS` selects `read-only` (`dontAsk`, no shell), `workspace`
(`acceptEdits` plus a fail-closed OS sandbox that denies shell reads of the Nest
checkout, its data folders and the account's HOME apart from toolchains, with
opt-in network domains) or `full` (`bypassPermissions`, dedicated hosts only).
The bridge runs Claude Code in its own process group, forwards SIGTERM and
escalates to SIGKILL. See [Claude Code agents](CLAUDE_CODE_AGENT.md).

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

Chat/Files are normal project tabs. Project details contains the brief, owner-only inline editing with existing compare-and-swap, counts and typed member list, and searchable invitations. Mobile exposes it above chat in a disclosure. Legacy Members links render chat with details available. Advanced sharing remains in the existing engine-backed dialog. `POST /api/projects/:id/members` requires the current product owner with live engine manage/post access, validates exact existing HUMAN/AGENT identities and current agent visibility, and reconciles ambiguous subscriptions before reporting success. It grants no personal connected-account access.

Personal connected skills require an unshared owner-only conversation and explicit approval for every additional project audience. Automatic project invitation grants no app access; joining pauses connected tools until owner approval. No new provisioning, model calls, account grants, engine changes or migrations are introduced by this workspace refinement.


## Local project and conversation drafts

Fresh project drafts now use owner-scoped local storage, with recovery from the earlier owner-bound tab draft. Existing conversations save text, selected mentions and already-uploaded file references by current human ID and engine channel ID. The stable send request ID/fingerprint is saved before posting, so an uncertain response can be recovered after refresh with one explicit Send. Local file bytes and in-progress uploads are not persisted; only confirmed upload references can be restored. Nothing is sent automatically.

Drafts are stored on this browser/device, not synchronized between devices or used as server permissions. Invalid/blocked/quota-failed storage is tolerated and the composer reports when saving is unavailable. Signing out clears the current owner's drafts and recent project reference. Owner/channel scopes and matching-snapshot removal prevent one conversation or a late response from clearing another draft. The dashboard's Continue your project action resolves only against the currently accessible project index, so removed access cannot reveal a saved project title.


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


## Chat sender avatars

Human and agent messages show a decorative 32px avatar beside the sender name.
Agents reuse `AgentAvatar` and the current configured character from the Agents
screen, with its existing deterministic/image-error fallback. Humans use initials
from the recorded sender name; the engine human/auth APIs do not provide profile
photos. Rendering does not fetch external avatar services or add profile storage.
Historical senders remain visible even if absent from the current directory.
Names, timestamps, message anchors, attachments, targeting and compact activity
retain their existing behaviour in project and standalone chats.


Connected apps support any number of unshared, active owner-only conversations alongside explicitly approved projects. Every subscribed conversation must still pass the owner/privacy checks or project roster approval; archived or unsafe subscriptions pause access. The credential remains bound to its original private conversation, which must still exist. Assistant request dispatch retains its separate single-private-conversation boundary. No additional migration or engine change is required.

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
