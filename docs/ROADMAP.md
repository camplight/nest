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
| Project workspace | `849:599` | `Projects.tsx`: one workspace with Chat/Tasks/Files/Members, automatic private chat creation, tasks and human review. Budgets remain pending. |
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
remain compatible. Project/task/review records are private to the creator; chat
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

Boundaries: this is owner-only project management, not shared project roles.
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

- One visible project workspace with URL-backed Chat/Tasks/Files/Members.
- Automatic private chat creation; durable recovery after lost responses.
- Existing chat controls, upload browsing, member/sharing controls and task reviews.
- Projects is the sole work entry in navigation. Existing standalone/direct chats remain accessible in a collapsed Existing conversations section under Projects.
- Legacy chat links resolve to the owned project. History and mobile are tested.
- Shared project roles are still deferred: invited chat members do not gain tasks.

Pending deliverables now appear as actionable review cards in Up next.
Next: persistent notification/read state across sessions. Release verification is recorded in the milestone PR; local
checks alone do not establish production deployment.

### 3. Complete agent experience

Extend the initial directory/detail slice with creation, assignment, explicit
avatar selection and resource editing. Distinguish runtime online state from
working on a task. Use existing engine APIs and their permission model.

### 4. Operational dashboard

Implemented the Figma home structure (923:417): Spend/Tasks/Issues cards,
SmoothUI Active projects and Up next stacks, Urgent issues area and original-art
private community strip. Empty instances keep the same shell. Task metrics and
approved-task progress come from owner/access-scoped product summaries. Pending
reviews deep-link to the actual task; changes requested stay distinct from
operational incidents. Desktop/mobile/dark and synthetic before/after captures
are covered by `tests/browser/dashboard.ts`. Remaining design deviations are
documented in [DASHBOARD_DESIGN.md](DASHBOARD_DESIGN.md).

The shared top bar now supplies the original theme, notifications, settings and
account controls across product views, with mobile search, real mention read
state, owner-gated administration and a private-catalog Skills navigation entry.

Replace temporary metrics with task/review/issue aggregates. Define how issues
are created and resolved. Distinguish measured, estimated and unavailable spend,
especially for subscription-backed wrapped runtimes. No fabricated scores,
progress, costs or time estimates.

### 5. Discovery and finishing

Tenant-private Community is implemented locally against Figma `963:26`: composer,
category feed, skill detail/version selection, package download/install instructions,
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
This slice has not yet been deployed.

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
name → add members → chat, with a direct Create your first project action.
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
3. **Next:** owner-controlled team delegation by requester/channel/tool/resource,
   with credential-owner and requester audit. Talking to an agent alone grants
   no access to its owner's applications.
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
people receive in-app mention notifications. Nonmembers are disabled, multiple
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

Action cards replace the raw checkbox list. Accounts have readable app labels;
search, Selected view, pagination, descriptive details and a visible Save access
bar distinguish choices from saved permissions. Discard and clear choices do not
write until saved. Failed saves retain choices, and explicit account access still
uses the existing API. Desktop/mobile/dark and real grant preservation are checked.
