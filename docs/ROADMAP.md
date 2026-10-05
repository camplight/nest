# Nest product roadmap

Source of truth for scope and acceptance, paired with [SPEC.md](SPEC.md) for
implemented behavior. Figma describes the target experience, not capabilities
that already exist. Keep this document updated in the same PR as each milestone.

## Design references

File: [Nest case study](https://www.figma.com/design/Rqfq3v9a8nZfQKbM3Q0NZk/Portfolio---Case-Studies?node-id=766-99).

| Surface | Figma node | Implementation and intentional differences |
|---|---|---|
| Dashboard | `793:2`, Camplight `923:417` | `Dashboard.tsx`; currently counts agents, conversations and session-local unread messages, not spend/tasks/issues. |
| Agents directory | `866:119` | `Agents.tsx`; list, search, real runtime counts and Manage. Scores, task totals, assignment and creation are deferred. |
| Agent details | `849:574` | `Agents.tsx`; description and native instructions can be saved. Identity/resources are read-only; wrapped runtime configuration remains external/admin. |
| Project workspace | `849:599` | `Projects.tsx`: one workspace with Chat/Tasks/Files/Members, automatic private chat creation, tasks and human review. Budgets remain pending. |
| Onboarding | `860:680` | Pending. |

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

This slice repaired navigation before the project workflow. Agent creation and
full resource editing remain future work.

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
- Project chats appear under Projects; standalone/direct chats remain in Chats.
- Legacy chat links resolve to the owned project. History and mobile are tested.
- Shared project roles are still deferred: invited chat members do not gain tasks.

Next: actionable review requests in Up next, persistent notification/read state
across sessions. Release verification is recorded in the milestone PR; local
checks alone do not establish production deployment.

### 3. Complete agent experience

Extend the initial directory/detail slice with creation, assignment, explicit
avatar selection and resource editing. Distinguish runtime online state from
working on a task. Use existing engine APIs and their permission model.

### 4. Operational dashboard

Replace temporary metrics with task/review/issue aggregates. Define how issues
are created and resolved. Distinguish measured, estimated and unavailable spend,
especially for subscription-backed wrapped runtimes. No fabricated scores,
progress, costs or time estimates.

### 5. Discovery and finishing

Product skills catalog, guided onboarding and first task, then community reuse
and publishing. Refine global navigation, topbar controls and layout customization.

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
