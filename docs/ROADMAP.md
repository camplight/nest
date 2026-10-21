# Nest product roadmap

Source of truth for scope and acceptance, paired with [SPEC.md](SPEC.md) for
implemented behavior. Figma describes the target experience, not capabilities
that already exist. Keep this document updated in the same PR as each milestone.

## Design references

File: [Nest case study](https://www.figma.com/design/Rqfq3v9a8nZfQKbM3Q0NZk/Portfolio---Case-Studies?node-id=766-99).

| Surface | Figma node | Implementation and intentional differences |
|---|---|---|
| Dashboard | `793:2`, Camplight `923:417` | `Dashboard.tsx`; currently counts agents, conversations and session-local unread messages, not spend/tasks/issues. |
| Agents directory | `866:119` | `Agents.tsx`; list, search, real runtime counts and Manage. Personal agents are created here and labeled in Your team. Scores, task totals and assignment remain deferred. |
| Agent details | `849:574` | `Agents.tsx`; description, native model and instructions can be saved; personal connected apps and private chat are available here. Identity and workspace remain read-only; wrapped runtime configuration remains external/admin. |
| Project workspace | `849:599` | `Projects.tsx`: one workspace with Chat/Files/Members and automatic private chat creation. Historical task/review URLs remain available; normal task navigation is retired. Budgets remain pending. |
| Onboarding | `860:680` | New users enter Agents → Your team and can create their personal agent within this view. Project creation remains in Projects. |

Directory and detail references are flattened images in the case study. Use the
existing Nest components, exported avatar assets and instance color tokens;
do not embed the reference screenshots as the application UI. Record any newly
available editable design frames here before refining exact geometry.

## Completed and deployed: agent navigation and settings

Merged in PR #5; production commit `cb40e59` verified on 2026-10-02.

Acceptance:

- Agents has a persistent URL (`?view=agents`) and selected sidebar state.
- Selecting a named agent opens `?view=agents&agent=<encoded-name>`.
- Reload, browser Back/Forward and direct links restore the selected view.
- Dashboard agent names open the same detail view.
- A human can save description and native instructions through the existing API.
- Private non-owner access is read-only; API permissions remain authoritative.
- Wrapped agents do not offer native instructions that their runtime ignores.
- Loading, unavailable-agent, empty, save failure and success states are visible.
- Mobile layout, keyboard navigation and original avatar loading are verified.
- Existing conversation/share links continue to work; viewing Agents does not
  mark conversation messages read.

This slice repaired navigation before the project workflow. Later milestones below add personal agent creation and native model editing; full resource editing remains future work.

## Milestones in agreed order

### 1. One project completed through human review — implemented

Projects now create a private chat automatically. Existing linked conversations
remain compatible. Legacy project/task/review records are private to the creator; chat
messages retain engine visibility. No engine data or identity is copied.

Implemented acceptance:

- Projects, individual projects and tasks have persistent URLs and selected nav.
- Create a task with a brief, acceptance criteria and an existing visible agent.
- Explicitly send the task; retries use one engine idempotency key per attempt.
- The assigned agent is subscribed and receives a targeted message brief.
- A human selects a real agent response as the deliverable; its text/Markdown
  and artifact links are snapshotted without moving uploaded files.
- Approve or request changes with feedback. Changes create a new attempt;
  resending is explicit. Old deliverables and review decisions remain visible.
- Only human approval marks done. Version checks reject stale reviews.
- A lost dispatch response can be retried after process restart without a
  duplicate brief. Queued/changes-requested records remain retryable on failure.

Original boundaries: owner-only project management. The creation refinement below
adds explicit team-project visibility without migrating old private history.
Response selection deliberately remains human-controlled: messages from the
assigned agent in the linked conversation after dispatch may include unrelated
work, so the reviewer must verify relevance. The picker shows the latest 100.
No automatic runner-failure classification, cancellation, automatic result
correlation, multi-agent task coordination or live provider test is claimed.
`working` means the brief was sent; the UI says “Awaiting deliverable.”

Release verification is recorded in the milestone PR. Local/CI success alone
does not establish production deployment. Browser verification uses real isolated
product and engine HTTP handlers with deterministic runner-authored responses.


Nest owns projects, tasks, acceptance criteria, deliverables and review decisions.
Map them to OrgOps channel/agent/event IDs; never read or duplicate engine state.

Acceptance: create a project, create and assign a task to an existing agent,
receive an artifact, request changes or approve it, and persist the outcome.
Define authorization, idempotency and recovery before connecting agent execution.
Current task states: queued, working, needs_review, changes_requested, done.
A separate failed state awaits reliable execution-failure correlation.
A successful agent turn alone must not imply human acceptance.

### 2. Project workspace and review inbox — workspace implemented

- One visible project workspace; originally Chat/Tasks/Files/Members. The current
  creation refinement uses Chat/Files/Members and retains task URLs for history.
- Automatic private chat creation; durable recovery after lost responses.
- Existing chat controls, upload browsing, member/sharing controls and task reviews.
- Projects is the sole work entry in navigation. Existing standalone/direct chats remain accessible in a collapsed Existing conversations section under Projects.
- Legacy chat links resolve to the owned project. History and mobile are tested.
- Existing creator-private projects remain private. New team projects resolve
  visibility through live human channel membership; task editing remains owner-only.

Pending deliverables now appear as actionable review cards in Up next.
Next: persistent notification/read state across sessions. Release verification is recorded in the milestone PR; local
checks alone do not establish production deployment.

### 3. Complete agent experience

Room runtime indicators are implemented in project details, standalone rooms and
the mobile member dialog. Compact dots and visible labels use the authorized
engine roster, refreshed every ten seconds and on focus; unknown/failed lookups
remain gray. Runtime state is distinct from task activity and verified runner or
provider health. `tests/browser/agent-runtime-status.ts` checks engine control
changes, refresh, lookup outages/recovery and desktop/mobile rendering.

Extend the initial directory/detail slice with creation, assignment, explicit
avatar selection and resource editing. Distinguish runtime online state from
working on a task. Use existing engine APIs and their permission model.

### 4. Operational dashboard

Implemented the Figma home structure (923:417): Spend/Tasks/Issues cards,
SmoothUI Active projects and Up next stacks, Urgent issues area and original-art
private community strip. Empty instances keep the same shell. Task metrics and
approved-task progress come from current project/access-scoped product summaries. Pending
reviews deep-link to the actual task; changes requested stay distinct from
operational incidents. Desktop/mobile/dark and synthetic before/after captures
are covered by `tests/browser/dashboard.ts`. Remaining design deviations are
documented in [DASHBOARD_DESIGN.md](DASHBOARD_DESIGN.md).

The shared top bar now supplies the original theme, notifications, settings and
account controls across product views, with mobile search, real mention read
state, owner-gated administration and a single private-catalog Community navigation entry.

Replace temporary metrics with task/review/issue aggregates. Define how issues
are created and resolved. Distinguish measured, estimated and unavailable spend,
especially for subscription-backed wrapped runtimes. No fabricated scores,
progress, costs or time estimates.

### 5. Discovery and finishing

Tenant-private Community is implemented locally against Figma `963:26`: composer,
unified skill feed, skill detail/version selection, package download/install instructions,
search and agent publishing access. Original assets: `793:30` (Community icon) and
`793:235` (cover artwork). Product SQLite owns the catalog; OrgOps is unchanged.

Acceptance: people and authorized agents publish; conflicting versions cannot be
overwritten; other publishers cannot edit packages; anonymous and revoked-token
access fails; downloaded versions pass integrity checks and install without
executing scripts. Community selection and skill links survive reload/history;
desktop/mobile layouts use shared Nest tokens and original Figma assets.

Intentional differences: tenant-only visibility, recently published instead of
invented trending metrics, contributors counted within displayed results, and
explicit host installation. Discussion, reactions, install telemetry, remote
activation and guided agent setup remain future work. See [Community](COMMUNITY.md).
The original catalog is deployed; this consolidation simplifies its navigation and artifact labels.

Run `npm run test:ui:community` for the isolated real-engine browser workflow,
including agent token issuance/revocation and exported-package installation.

## Guardrails for every feature PR

1. Name the milestone, Figma node and user outcome in the PR description.
2. List observable acceptance criteria and intentional design deviations.
3. Keep OrgOps untouched; put product state in Nest and call engine APIs.
4. Reuse shared components/tokens; show real data or explicit unavailable states.
5. Verify the specific flow, including permissions, failure, reload/history,
   desktop/mobile and screenshots against the referenced Figma screen.
6. Update SPEC and this roadmap with implemented behavior and remaining gaps.
7. Record the deployed commit and verify that same flow in production before
   marking a milestone deployed. Passing a local build is not a deployment.

## Repeatable checks

Run `npm test` for real Nest-to-OrgOps integration tests, including persisted
agent edits and rejection of private non-owner edits. Run `npm run build`.

For the browser regression suite, install Chromium once with
`npx playwright install chromium`, then run `npm run test:ui:agents`. The script
starts an isolated Vite server on port 5297 and uses fixture API responses so it
never edits a live agent. It checks navigation, reload/history, encoded names,
saves/failures, read-only/wrapped settings and mobile layout. Screenshots are
written to a temporary directory printed by the script. Product CI runs it too.
The fixture suite complements the real API tests; it is not production proof.

`npm run test:ui:projects` starts an isolated UI on port 5298 and connects the
browser to real Nest/OrgOps handlers with temporary databases. It exercises
project/task creation, assignment, dispatch, response selection, changes,
approval, reload/history and mobile layout. It emits deterministic agent events
without calling a model or touching production. Product CI runs both browser suites.

## Project-first onboarding refinement

The dashboard remains home. With no owned projects, a welcome panel explains
a direct Create your first project action. The chat-first refinement below now
opens the composer immediately and derives/suggests details after first Send.
The sidebar and Cmd/Ctrl+K open project creation; there is no separate Chats
nav or New chat action. Dashboard metrics count projects instead of standalone
chats. Existing chat/share URLs and history remain compatible; no data is moved.
Desktop/mobile browser checks cover onboarding, recovery, navigation and reviews.
This refines the existing visual system; it does not claim a pixel match to the
not-yet-implemented Figma onboarding wizard or automatic agent provisioning.

## Personal agents — tracer bullets

1. **Implemented for review:** Google login → choose an original character →
   create one private personal agent and conversation → first chat. Durable
   recovery and per-user setup; operator-selected model/runner; original avatars.
2. **Implemented for review in Nest:** discovery → hosted auth → verify ACTIVE
   account → grant exact tools → enable expiring skill access → revoke. OrgOps
   PR #50 is closed; a provider adapter and reusable Nest skill run on the unchanged
   engine. Real external-account consent and production tool execution still need
   release verification.
3. **Implemented for review:** opt-in personal assistant profiles → Ask/@ request
   → owner approves a brief → targeted private execution → owner selects/edits
   and shares a reply → requester sees it in Requests. No guest chat subscription
   or account grant. Product migration 007 and unchanged engine HTTP boundaries.
   Remaining delegation: standing requester/tool/resource permissions, exact-action
   approvals and automated correlation. Talking to an agent alone grants no access
   to its owner's applications.
4. **Next:** exact-action approvals and multiple personal agents.

Reference: Figma `866:225` within `860:680`. The original characters and staggered
selection cards are adapted into a responsive interactive wizard, with real setup
fields instead of the case study's preassigned five-agent team. No invented
connections, performance scores or online claims. Status is not “deployed” until
fresh Google signup, real model reply and consented connection checks pass on the
release commit. Full acceptance/configuration: [Personal agents](PERSONAL_AGENTS.md).

Local model tracer verified on 2026-10-12: one actual CLASSIC agent response via
OpenRouter/Gemini 2.5 Flash after provisioning through Nest. Production release
and real external-account consent remain pending; do not mark this deployed.

### Personal-agent navigation consolidation

Personal agents belong in Agents → Your team, not a separate My agent screen.
New teammates use Add your agent within Agents; details hold model, instructions,
connected apps and a link to private chat. Existing setup and OAuth return URLs
remain compatible. Verify new creation, lost-response recovery, directory labels,
settings links, browser history, mobile layout and both legacy callback paths.

## Simpler settings and independent capability loading — implemented

Agent settings foreground the team description and model choice. Instructions
and technical runtime details are collapsed under Advanced, an intentional
simplification of Figma's always-expanded resource section. The owner-only
Connected apps panel has independent loading/error/retry states. Navigation reads
only the product setup summary; runtime/integration health is checked when needed.
Personal-chat organization, mention delivery and runtime isolation are unchanged.

## Integration ownership decision

Mention delivery belongs in Nest using existing OrgOps event APIs; evaluate the
existing `targetAgentName` field before adding any new delivery machinery.
Personal-chat navigation and execution isolation remain deferred for discussion.
The shared runner is an intentional deployment model, not per-agent OS isolation.

Composio is an instance integration, not an OrgOps core dependency. PR #50 is
closed and its branch retained for reference. The Nest implementation provides
a provider adapter and a reusable instance skill compatible with private community
packaging. No catalog entry is published automatically. Provider service keys stay
in Nest; exact tool grants and expiring capabilities govern skill access. For now,
any additional/shared conversation pauses connected-account access for the agent;
a generic skill cannot attest the triggering conversation. Runtime isolation and
Nest mention targeting are separate work. See PERSONAL_AGENTS.md for prerequisites
and the global metadata-token requirement.

## Targeted mentions and in-app notifications — implemented for review

Selected mentions in the existing composer now carry structured identities and
text spans. One agent target uses OrgOps's existing `targetAgentName`; any selected
people receive in-app mention notifications. Eligible nonmembers can be invited
from the picker by a chat manager (project owner); nonmanagers see a reason. Multiple
agent targets block Send, edited names lose their selection, and the server
revalidates membership/visibility. No implicit subscription or account delegation.

The sidebar inbox retains read state and opens the highlighted message through a
reloadable URL. Stable send IDs and verified engine receipts recover uncertain
responses without duplicate messages. This is Nest product behavior on the
unchanged engine; coordination skills remain available for ordinary textual
conventions. Multi-agent fan-out, OS isolation, push/email delivery and shared
connected-account delegation remain separate decisions.

Acceptance includes real-engine targeted routing, human notification ownership,
access changes, lost responses and restart recovery, desktop/mobile, IME/caret
behavior, attachments and message deep links. Production rollout follows a
reviewed PR and the normal dual-database backup process.


## Personal-assistant request acceptance

- Publication is off by default and exposes a separate owner-approved description.
- Published assistants are discoverable in Agents and writable-chat @ suggestions.
- External-assistant selection opens a request form, without bypassing chat membership.
- Requests are visible only to the owner/requester; no guest prompt reaches the agent
  until the owner approves it. Only the owner's edited, approved reply is released.
- Native agent and private conversation IDs remain pinned and engine-authoritative.
- Shared context or changed ownership/visibility denies work and private response access.
- Lost creation/dispatch responses and restart retries recover without duplicate work.
- Incoming/Outgoing, details, reload/history and desktop/mobile are verified.
- CI includes the real-engine browser flow through the existing agents entry point.
- No live OAuth/model/provider success or production deployment is inferred from fixtures.

Visuals reuse the existing Figma agent layouts, original Puff avatar and instance
branding tokens. The Requests workflow is a Nest extension; the case study has no
editable request-review frame. This implements the approval-first slice described
in [AGENT_REQUESTS.md](AGENT_REQUESTS.md), not full team delegation.

## Consistent header on connection-return chats

Standalone channel links (including personal-chat connection callbacks) now reuse
the shared product header. Theme, mention notifications, settings and account
remain visible; channel search filters the existing sidebar. Chat management and
the composer are preserved, and project chats render only their outer header.
Desktop/mobile browser acceptance covers callback URLs, reload, real direct-chat
access, menus, search, mobile navigation and composer visibility.

## Connection readiness after authentication

Connected-app settings show saved tool permission counts, prevent zero-grant
activation and refresh after permission saves/account changes. Enable/Renew
configures the instance helper for preloading through the unchanged engine API;
legacy agents upgrade by owner renewal. Consent stays explicit. See
[the investigation](CONNECTION_READINESS.md) for the separate final-event format
fallback and the limits of the production evidence.

## Friendly connected-app permissions

Connected accounts use local app logos and a compact Give all access button.
Choose specific actions collapses search, Selected view and granular permission
rows by default. Give all access fetches and saves every current provider action
in one explicit click, independently of advanced search. Advanced choices still
require Save access, with discard/clear and failed-save recovery. Pagination,
search and bulk selection preserve choices. Page failures and selections exceeding
the 2,000-action request bound never apply partial selections or grants. Desktop/mobile/dark,
local logo loading, default size and the real permission boundary are checked.

## Simple project creation with a team — implemented for review

Milestone 2 / project-first onboarding: enter a name, optionally describe the work
and select existing people or agents before creating. The picker is a compact name/`@` search field with fuzzy suggestions, keyboard
selection and original agent avatars; names and selections persist through
refresh or uncertain creation. New project links have a consistent creation URL.
Validation covers name-only creation, roster errors/retry, keyboard selection,
member privacy, partial subscription recovery, deduplication and desktop/mobile.
The Figma workspace reference is `849:599`; it is a flattened image and contains
no editable creation dialog. This screen is an intentional extension of the
existing tokens and components, rather than a claimed pixel match to a new frame.

Projects now use Chat, Files and Members, with the real team in the right About
sidebar. The separate Tasks tab is removed from normal navigation. Historical task
records and deep links remain supported; a chat-side to-do aggregate is deferred.

New forms create team projects. Current human channel subscribers with post access
can list/open these projects; removal revokes product visibility. Product migration
008 keeps historical projects private, and legacy API requests default to private.
Task mutations/reviews remain owner-only compatibility APIs. Selecting teammates
does not send email or provision accounts.
The request limit is 50 selected members. Persistent engine/identity failures during
reserved setup need operator recovery; prior grants are not rolled back automatically.
No production deployment is claimed by the PR's isolated browser checks.

## Project navigation hierarchy — implemented for review

The information architecture is collection → project → Chat/Files/Members.
Projects is one persistent, collapsible parent within the main navigation. Its
children are visually indented beneath it, before Agents/Community; selecting a
project does not reveal an unrelated list elsewhere. New project is scoped to
this group rather than the sidebar footer.

The sidebar shows at most five creation-ordered shortcuts, keeping the open project
visible. View all projects opens the existing searchable directory. This keeps
navigation manageable as the list grows without adding another project hierarchy
or multiple chats per project. Keyboard disclosure, single current-page state,
mobile selection and ten-project fixtures are covered in the browser suite.

This bounds displayed navigation only: the current API still returns all accessible
projects. Server pagination and directory sorting/filtering should precede very
large tenant catalogs. User-chosen pins and project archival can follow observed
usage; folder hierarchies are not introduced in this slice. Figma workspace
`849:599` remains the workspace reference; this is an intentional information
architecture refinement rather than a new exact Figma-frame implementation.

## Project member search and agent invitations — implemented for review

Create projects with one people/agent search field: names and @names use existing
mention ranking, up to eight suggestions, keyboard selection and removable chips.
The field never submits the form on Enter. Membership applies on project creation,
with the existing 50-member bound and interrupted-request recovery.

The trusted wrapped manager can resolve identities and add a person/agent to its
current team project when its owner explicitly requests it. Reuse the signed
management helper and unchanged engine subscription HTTP API; deny nonowners,
legacy private projects, other-owner private agents and arbitrary target channels.
Existing subscriptions are no-ops, uncertain writes reconcile membership, and
requests/confirmations enter product audit. Ordinary @mentions remain delivery,
not membership changes. This does not add email/account provisioning or connected
account permissions. Current Figma workspace reference remains `849:599`.

## Chat-first project creation — stacked follow-up, implemented for review

New project immediately opens a blank chat; the first Send creates its private
engine channel and team project, derives name/description from the opening text,
and delivers that same message. Selected draft @mentions add their exact people
or agent before delivery. One agent target per message is preserved. No records
are created by merely opening/cancelling the draft. This supersedes the fresh
name-form flow while retaining submitted legacy-form recovery.

A first-message fallback appears immediately, then AI generates the name and a
useful brief asynchronously through the existing LLM library and configured model.
The brief covers the objective, expected outcome, context and open questions; it
does not infer access grants. Project settings lets only the owner edit name/description,
with stale-editor conflict detection. Product labels update without renaming the
engine chat or changing memberships/history. Original creation intents remain
replayable after edits; failed first-message delivery remains safely retryable.

Browser checks cover empty draft/mobile, @ selection and invitations, creation
and message response loss, reload, settings edits and legacy recovery. The current
Figma workspace reference is `849:599`; blank-chat onboarding/settings are deliberate
extensions. This work is a separate PR stacked on the creation/navigation/invitation
PR, not part of that PR's diff. Naming uses a bounded best-effort background
request; provider failure preserves chat and manual settings. Any manual save
protects against a late AI response. No durable naming worker, automatic retry
loop, pre-send uploads, multiple agent targets or generalized roles are added.


## Frictionless projects epic

Small stacked PRs keep workspace, draft persistence, and model guidance reviewable.

1. **Workspace and immediate help — PR #37:** suggest the creator's pinned personal agent on the fresh chat draft; subscribe it only on first Send with a visible opt-out. Target the first message without inserting artificial @ text. Consolidate brief, inline edits, member counts and searchable invitations into the right Project details panel. Normal navigation is Chat/Files; old Members links open chat. Mobile uses a disclosure above chat.
2. **Resume — PR #38:** owner/channel-scoped local draft storage, stable send IDs through reload, explicit retries, and a Continue project entry. Persist text and selected identities, never credentials; clear on logout. Upload recovery must not imply that local file objects are durable.
3. **Guided first response and contextual connections — implemented for review:** Nest-owned kickoff guidance should acknowledge the goal, propose one useful next step and ask at most one essential question. Prompt guidance is a behavioral preference, not a guarantee; targeting, delivery and connection permissions are enforced in code. Connection suggestions should use the configured provider catalog and route users into a valid private context. Do not auto-grant accounts or infer successful tool execution.

### Connected-account constraint

Current connection skills require exactly one unshared owner-only conversation and a secured lifecycle channel. Subscribing the same personal agent to a project therefore pauses its connected tools even if the project contains only its owner. Show this before automatic invitation and preserve the validator. Safe delegation or a separate project helper is a separate product/security design; automatic project membership must not silently expand connected-account access. The existing owner-approved Requests flow remains available. Agent creation by agents remains deferred.


The kickoff policy is carried in new auto-created channels' existing metadata, which native OrgOps turns include in their system channel context. It is intentionally prompt guidance: no output-rewriting model, validation/retry loop, or changes to existing agents' instructions. Existing channels are not silently rewritten. Contextual suggestions recognize explicit app names in recent project messages, confirm exact connectable catalog slugs, and suppress currently active accounts. At most two suggestions are shown; dismissal is available and provider failures leave chat usable. Authorization is human initiated, owner-scoped, and leaves grants unchanged. A successful fixed-provider callback returns to the same accessible project and restores its local draft; explicit channel/project/share links take precedence.


## Chat usability — implemented, awaiting release

- Drop files anywhere on an existing chat screen or a new-project chat draft;
  retain explicit Send, existing file permissions and owner-scoped draft recovery.
- Share upload status and the 20-file limit across picker, paste and drop.
- Replace activity letter abbreviations with icons in the same tiny boxes,
  short hover/focus labels and click-to-open technical details.
- Browser coverage uses isolated real Nest/OrgOps handlers and synthetic files,
  with desktop/mobile screenshots. No live model or provider accounts are used.


## Mention invitations — implemented, awaiting release

Chat/project owners can select an eligible teammate outside the current chat with
Add to chat and mention. Existing HTTP APIs confirm membership before selected
routing metadata is inserted. Picking never sends a message. Failed invitations
preserve the draft; lost responses reconcile without duplicate subscriptions.
Pending invitations block Send and do not replace drafts in other conversations.
Private assistants owned by others retain their existing approval workflow.


## Chat sender avatars — implemented, awaiting release

Human/agent message headers show initials/configured Figma character avatars.
Names and timestamps remain visible on desktop and mobile. System activity keeps
its compact icon strip. Human profile photos await an engine HTTP profile field.
