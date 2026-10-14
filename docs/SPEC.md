# Nest implementation spec

Nest is the product layer around OrgOps. OrgOps is a pinned, untouched Git
submodule at `vendor/orgops`, sourced from https://github.com/camplight/orgops.
Nest does not keep a second copy of the engine or apply source patches.
The current pin is `3e3ed36` (OrgOps main through reviewed PR #49, including Google team membership repair).

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
`?view=projects&project=<id>&tab=chat` with Chat, Files and Members sections.
The About sidebar shows the current team from engine channel participants. Tasks
are removed from normal project navigation; no automatic chat-to-task extraction
or replacement to-do sidebar is introduced.
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
The creation screen requires only a name, with an optional description and a
collapsible, searchable people/agent picker. `GET /api/projects/members` returns
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

Product APIs (JSON, no-store, 64 KB request cap):

- `GET/POST /api/projects`: list accessible owner/team projects / create a project.
- `GET /api/projects/members`: available existing people and public/owner agents.
- `GET /api/projects/:projectId`: project, tasks, deliverables and review history.
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
short welcome with one action to create their first project. Only its name is
required; the description and initial team are optional. Projects owns the work
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
attestation API, access requires exactly one unshared owner-only private channel;
additional conversation subscriptions or sharing deny all connected-account calls
for that agent. The canonical runner lifecycle GROUP is allowed only while
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
engine `payload.targetAgentName`; no engine source changes are needed. At most
one distinct agent can be targeted per message. Multiple selected people receive
in-app mention notifications. Unselected @ text retains ordinary channel delivery
and may still be interpreted by an agent's coordination instructions.

The picker keeps human and agent identities distinct, supports names with spaces
and email handles, and disables recipients outside the current conversation.
Editing a selected name removes its routing metadata. Surrounding edits preserve
it. The composer shows Ask/Notify recipients and prevents multiple-agent sends.
Server validation checks span/text agreement, recipient membership, agent
visibility, human identity and current channel posting rights. It derives source
from the human session and never subscribes a recipient or expands tool grants.

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

Runtime isolation, shared-account delegation and Composio's private-context rule
are unchanged. Targeting a personal agent does not unlock connected accounts in
a shared conversation. See PERSONAL_AGENTS.md for that separate permission boundary.

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
   personal mapping and the same private-context boundary as connected tools:
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
