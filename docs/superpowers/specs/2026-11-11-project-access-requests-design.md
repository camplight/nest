# Project access requests

## Intent

People often receive a direct Nest project URL before the project owner has added them. Today the project page only reports that the project is unavailable or conversation access changed. The recipient cannot distinguish a stale link from a valid project they could ask to join, and the owner has no explicit request/decision workflow.

Add a Nest-owned access-request workflow for authenticated humans. A recipient can request normal collaborator access from the unavailable project screen. The project owner can approve or deny the request, see pending requests alongside project membership, and later revoke a granted human membership. Approval grants the existing team-project access: the person can read and post in project chat and access project files. It does not grant personal connected-account permissions, agent ownership, project ownership, task mutation rights, or instance administration.

OrgOps remains authoritative for actual channel membership and permissions. Nest stores the request/decision workflow and audit history in the product database, and performs membership changes through human-authenticated OrgOps HTTP APIs.

## Goals

- Replace the generic dead end for a valid inaccessible project link with a safe request-access state.
- Let one authenticated human create at most one pending request for a project at a time.
- Let the project owner approve or deny pending requests from the notification inbox and project details.
- On approval, grant ordinary human collaborator membership through OrgOps and confirm it before reporting success.
- Let the owner revoke a human collaborator later and confirm removal before reporting success.
- Keep project title, description, participants, files, messages, and owner identity hidden from an unauthorized requester.
- Make request creation and owner decisions safe to retry after timeouts or lost responses.
- Record request, approval, denial, and revocation in Nest product audit history.
- Cover authorization, retries, access changes, UI states, and revocation with API and browser tests.

## Non-goals

- Read-only project roles or per-file/per-tab permissions.
- Access requests for standalone OrgOps conversations, agents, canvases, community packages, or administrative screens.
- Email, push, or external notifications.
- Automatic approval, approval by agents, delegated approvers, or multi-owner projects.
- Exposing project metadata to prove that a supplied UUID exists.
- Mirroring current OrgOps membership into the Nest product database.
- Changing task/review mutation permissions; existing owner-only compatibility APIs remain owner-only.
- Editing or patching `vendor/orgops`.

## Anti-goals

- Do not use a runner or service credential to grant access on an owner’s behalf.
- Do not treat a product request row as permission. Current OrgOps membership is always rechecked.
- Do not post access requests into the private project conversation.
- Do not silently claim approval when the engine membership write or confirmation is uncertain.
- Do not let repeated requests spam the owner with duplicate pending entries.
- Do not make an inaccessible project’s metadata visible in an error, notification count, API body, or page title.

## Constraints and ownership boundaries

- Nest owns product UI, API, schemas, migrations, request workflow, and product audit.
- OrgOps owns humans, channel membership, access enforcement, events, files, and sessions.
- The Nest API must use the signed-in human’s translated session for OrgOps membership writes. No privileged token is injected.
- Project access for a non-owner continues to require an active, non-archived project channel, a HUMAN subscription for the current username, and post access.
- Human IDs are the durable Nest identity. OrgOps subscriptions use the human’s current username, so decision/revocation routes resolve the current username from `/api/humans` immediately before mutation.
- An owner can decide requests only while they still own the product project and can currently manage/post to its engine channel.
- Existing private legacy projects are not silently exposed. Approving the first human collaborator is an explicit owner action and atomically changes the product collaboration policy to `team` only after engine membership is confirmed. The approval UI explains this when applicable.
- API bodies remain JSON, no-store, and within the existing 64 KB project route limit.

## Approaches considered

### 1. Nest-owned request workflow — selected

Store pending and decided requests in the Nest product database, expose Nest API routes, render controls in Nest’s unavailable-project, notification, and project-member interfaces, and use existing OrgOps subscribe/unsubscribe endpoints for the actual permission change.

This keeps the product-specific workflow close to the UI while preserving OrgOps as the permission authority. It requires one additive product migration but no engine change.

### 2. OrgOps-native access requests

Add pending access requests, decisions, and notifications to OrgOps, then bump the untouched submodule. This would make the concept available to every OrgOps client, but it is a much broader upstream contract and migration for a workflow currently required only by Nest.

Rejected for this feature because Nest can implement it without duplicating permission state or changing the engine.

### 3. Message- or invitation-based requests

Represent a request as a message, mention, or existing share-link claim. The requester cannot post in the inaccessible project, message delivery would mix workflow state with conversation history, and denial/retry/revocation would be difficult to reconcile.

Rejected because it creates ambiguous state and weak authorization semantics.

## Domain model

### Access request

A project access request is a Nest product workflow record, not a permission grant.

Fields:

- `id`: client-generated UUID used for idempotent creation.
- `project_id`: target Nest project.
- `requester_id`: durable human ID.
- `requester_username`: username snapshot for audit/display fallback only.
- `status`: `pending`, `approving`, `approved`, or `denied`. `approving` is an internal decision claim that prevents a racing denial after an OrgOps membership write begins.
- `created_at`: request time.
- `decision_started_at`: nullable time at which approval claimed the request.
- `decided_at`: nullable final decision time.
- `decided_by`: nullable owner human ID.

A partial unique index allows only one active (`pending` or `approving`) row for a `(project_id, requester_id)` pair. Historical approved and denied rows remain immutable evidence. If membership is later revoked, the former approved row remains approved; current OrgOps membership determines access. The person may create a new pending request after revocation or denial.

A repeated POST with the same request ID and matching project/requester returns the existing row. A different actor or project reusing the ID returns 409. A repeated POST with another ID while an active request already exists returns that request rather than creating another notification. Requester-facing state presents `approving` as `pending`; only the owner sees that approval needs completion or reconciliation.

### Membership

Membership is never stored in the access-request table. The API reads current OrgOps channels on every project access check. Approval and revocation re-read the channel after mutation and report success only after the expected HUMAN membership state is observed.

### Audit events

Add product audit records:

- `audit.project.access.requested`
- `audit.project.access.approved`
- `audit.project.access.denied`
- `audit.project.member.revoked`

Payloads contain project ID, request ID where applicable, and durable requester/member human ID. Username snapshots may be included for operator readability but are not authorization keys.

## API design

All routes require an authenticated human with password setup complete and return `Cache-Control: no-store`.

### Requester state

`GET /api/projects/:projectId/access-request`

Used only when the normal project detail request fails. It returns no project metadata.

Possible successful bodies:

- `{ status: "member" }` when access has become available; the UI reloads the project.
- `{ status: "pending", request: { id, createdAt } }` when this person has a `pending` or `approving` request.
- `{ status: "denied", request: { id, decidedAt } }` when the latest request was denied and no newer active request or current membership exists. This lets denial remain visible after refresh or on another device without revealing who decided it.
- `{ status: "requestable" }` when the project exists, the current human is neither owner nor current member, and the latest historical state does not need to be shown. A previously approved requester whose membership was later removed is requestable again.

It returns a generic 404 `{ error: "Project unavailable" }` when the product project does not exist or cannot accept requests. The response never includes project name, description, owner, channel ID, or participants.

`POST /api/projects/:projectId/access-requests`

Body: `{ id: <uuid> }`.

- Rejects owner self-requests.
- Returns `{ status: "member" }` if the requester already has access.
- Returns the existing active request for a retry or duplicate submission.
- Creates a pending request and audit row in one transaction otherwise.
- Returns only request ID, status, and timestamp.

### Owner pending list

`GET /api/project-access-requests`

Returns active (`pending` and `approving`) requests only for projects the signed-in owner can currently manage and post to. Unlike requester state, this owner-authorized response may include project ID/name and the requester’s current username. Missing/deleted humans use the stored username snapshot and cannot be approved until the identity can be resolved. An `approving` row is labelled as an incomplete approval that can be retried, not as a second actionable decision.

This endpoint feeds both the topbar notification inbox and project details. It does not return denied/approved history in the initial slice.

### Owner decision

`POST /api/projects/:projectId/access-requests/:requestId/decision`

Body: `{ decision: "approve" | "deny" }`.

Common checks:

- The signed-in human is the project owner.
- The owner can currently manage and post to the active project channel.
- The request belongs to the project and is active.
- The requester is not the owner.

Deny:

- Atomically changes only `pending` to `denied`, records decision metadata, and appends the audit row.
- A retry of the same denial returns the decided request.
- A denial cannot overtake `approving`; it returns 409 with guidance to finish approval and revoke membership if the owner changed their mind.
- A conflicting decision against an already decided request returns 409 and its current state.

Approve:

1. Resolve the requester’s current username from the owner-visible human roster by durable human ID and recheck the owner’s project channel.
2. Atomically claim the decision with `pending -> approving`, storing the owner and `decision_started_at`. An approval retry may resume an existing `approving` row; no denial can claim it.
3. Re-read current participants. If the HUMAN subscription is absent, call the existing OrgOps subscribe endpoint with the owner’s human session.
4. Re-read and confirm the membership.
5. In one Nest transaction, change a legacy private project to `team` if necessary, change `approving -> approved`, set `decided_at`, and append the audit row.
6. Return the request decision and updated project collaboration policy.

A definite failure before any subscribe attempt may release `approving` back to `pending`. Once a subscription has been attempted or its outcome is uncertain, the request stays `approving`; a retry reconciles membership and completes approval. This prevents a denied request from racing with live engine access. If the owner no longer wants to grant access after approval started, they finish/reconcile approval and then use revocation.

### Owner revocation

`DELETE /api/projects/:projectId/members/:username`

This route initially supports HUMAN members only.

- Requires current project ownership and manageable/postable channel access.
- Resolves the named current human and rejects removal of the owner.
- Calls the existing OrgOps unsubscribe endpoint with `{ subscriberType: "HUMAN", subscriberId: username }`.
- Re-reads and confirms the member is absent.
- Appends `audit.project.member.revoked` only after confirmed removal.
- A retry after confirmed removal is idempotently successful when the target is a known non-owner human.

The project remains `team`; collaboration policy is not downgraded when the last collaborator is removed.

## User interface

### Inaccessible project link

When `GET /api/projects/:id` fails with the existing unavailable/access-changed response, `Projects` requests the access-request state instead of showing only the generic notice.

The page keeps the neutral `Project` heading and does not render the normal project shell, chat, files, participants, or metadata.

States:

- Loading: “Checking whether you can request access…”
- Requestable: a focused card saying the project is private and a primary “Request access” button. Supporting copy says approval gives normal project chat and file access, while personal account permissions remain unchanged.
- Submitting: disabled “Requesting…” state.
- Pending: “Access requested” with the request time and “The project owner will review your request.” Repeated refreshes do not create another request.
- Member: automatically retry the normal project load.
- Unavailable: retain a generic “Project unavailable” message and Refresh action.
- Error: preserve the request state and offer Retry without navigating away.

The request ID is created once per submission attempt and retained in component state until a definitive response, so retrying a lost response uses the same ID.

### Notification inbox

The existing bell becomes a general Notifications inbox while preserving mention behavior.

- It fetches mentions and pending project access requests independently; one failure does not erase the other section.
- Pending requests show “<person> requested access to <project>” with Approve and Deny controls.
- Approval and denial disable both controls for that row, provide an explicit progress label, and replace the row only after the server confirms the decision.
- Approval copy states that access includes project chat and files. For a legacy private project it additionally states that approval makes the project a team project.
- The unread dot is present when there is an unread mention or any pending access request.
- The existing 30-second/focus refresh remains sufficient; no new WebSocket topic is introduced.

### Project details

For the owner, the People & agents area gains:

- A pending requests section using the same decision controls.
- A Remove control for each non-owner HUMAN collaborator.
- A confirmation dialog: “Remove <person> from this project? They will immediately lose project chat and file access. They can request access again later.”
- Progress, confirmed success, and retryable failure states.

Agents continue to use existing add/remove controls and are outside this access-request workflow. Non-owner collaborators still see that the owner manages membership.

### Requester after a decision

No external notification is added. The pending screen polls with the existing project refresh interval. Approval causes the normal project page to load once OrgOps membership becomes visible. Denial changes the state to a neutral “Your request was not approved” message with an option to submit a new request; it does not reveal who denied it or any project metadata.

## Authorization and privacy

- Only authenticated humans can request access.
- A requester endpoint never returns project metadata or owner identity.
- An owner list/decision route includes a request only after current owner/channel management checks.
- Approval uses the owner’s current human session; requester, runner, Authorization, and scoped-agent headers cannot elevate it.
- Requester human ID is durable. Username snapshots are display/audit data only.
- Current OrgOps membership overrides product request history. Removing a HUMAN subscription ends project access on the next request.
- Archived/deleted project channels cannot be approved until restored; the request remains pending rather than granting stale access.
- Project tasks, reviews, connected accounts, agents, and owner settings retain their existing authorization.

## Failure handling and concurrency

- Request creation is transactional and idempotent by request UUID plus the partial active-request uniqueness rule.
- Denial conditionally claims `pending -> denied`. Approval conditionally claims `pending -> approving` before any engine mutation; concurrent decisions therefore produce one winner before OrgOps access can change.
- Denial has no engine side effect and commits decision plus audit atomically.
- Approval retries may resume `approving`. A lost engine response is reconciled by re-reading membership; finalization conditionally changes `approving -> approved` together with the project policy update and audit.
- A definite pre-subscription failure can release the claim to `pending`; an attempted or uncertain subscription keeps `approving` so denial cannot contradict possible live access.
- Revocation similarly re-reads membership before and after unsubscribe. A lost response is reconciled on retry.
- If a requester is deleted or no longer appears in the current human roster, approval fails without changing the request; denial remains available.
- If the owner loses channel management access, pending requests remain stored but disappear from actionable lists until ownership/access is restored.
- If access is granted outside this workflow while a request is pending, the requester state becomes `member`; the owner decision endpoint may reconcile an approval, while the owner can also deny/close the stale request. The implementation should choose one deterministic behavior and test it; recommended behavior is to mark it approved when owner processing observes confirmed membership.

## Persistence and schemas

Add the next numbered migration under `packages/db/migrations` creating `product_project_access_requests` with foreign key to `product_projects`, status check, timestamps, decision actor, and indexes for:

- one active (`pending` or `approving`) request per project/requester,
- owner inbox lookup through project ID/status/created time,
- requester state lookup through project ID/requester ID/status/created time.

Add product types and Zod schemas to `packages/schemas/src/projects.ts`. Keep SQL/store mappings in `packages/db/src/projects.ts` synchronized. The store should expose narrow operations such as create-or-read-pending, requester-state lookup, owner-pending list, conditional decision, and private-to-team approval finalization rather than leaking raw SQL into route handlers.

## Testing

### Database/store tests

- Idempotent request creation.
- One active request per requester/project with historical decided rows retained.
- Conditional decision concurrency, including approve/deny races and approval resumption from `approving`.
- Approval transaction updates legacy collaboration policy, final request state, and audit together.
- Owner and requester indexes/list ordering.

### API tests

Use the real embedded OrgOps API boundary, not a mocked permission store.

- Signed-out and must-change-password rejection.
- Requester receives no project metadata.
- Owner/self/current-member request behavior.
- Duplicate request and lost-response retry behavior.
- Non-owner cannot list or decide requests.
- Owner cannot act after losing channel management access.
- Approval subscribes the current username, confirms membership, makes a legacy private project team-visible, and enables project GET.
- Approval retry after membership already exists.
- Denial changes no engine membership.
- Concurrent/conflicting decisions, proving a denial cannot win after approval claims the request and begins an engine write.
- Approval retry from `approving` after a lost/uncertain subscription response.
- Requester polling returns a persistent denied state and a new request replaces it with pending.
- Revocation removes membership, immediately removes project access, and allows a new request.
- Runner/authorization headers cannot elevate request decisions.
- Deleted/renamed requester identity handling.

### UI/component tests

- Requestable, submitting, pending, denied, unavailable, and member-recovery states.
- Request UUID reuse on retry.
- Notification inbox merges mentions and requests and isolates endpoint failures.
- Accessible approve/deny/remove controls, focus restoration, progress labels, and confirmation dialog.
- Project details refresh after membership decisions.

### Browser test

Extend `npm run test:ui:projects` with two real human sessions:

1. Owner creates a project and shares its direct URL without adding the second human.
2. Second human opens the URL and requests access.
3. Owner sees the notification and approves.
4. Second human’s open page recovers to chat and can post/read files.
5. Owner removes the collaborator.
6. Second human loses access on refresh and can request again.
7. Repeat with denial to verify no access is granted and no project details leak.

Capture desktop and mobile screenshots for the eventual PR because this changes visible UI; screenshots stay outside the repository and are attached to the PR after checks pass.

## Documentation and runtime impact

Update `docs/SPEC.md` and `docs/SUBMODULE_MIGRATION.md` with the request workflow, product migration, API routes, permission boundary, and deployment behavior.

Deployment requires the normal product database snapshot and additive migration. No OrgOps migration, submodule bump, runner restart policy, credential change, or runtime skill installation is required. Deploy API and user UI together. Preserve both databases and existing engine runtime data through the normal rollout process.

## Builder decisions already made

- Approval grants normal collaborator access, not read-only access.
- Nest stores request workflow; OrgOps stores and enforces membership.
- Unauthorized request screens reveal no project metadata.
- Human IDs are durable request identities; current usernames are resolved for engine writes.
- Approval explicitly converts a legacy private project to team policy after membership confirmation.
- Past decisions are retained; current membership remains authoritative and a revoked/denied person may request again.
- Notifications use polling and the existing bell; no new engine event or email channel is added.

## Remaining implementation discretion

- Exact component extraction and CSS class names.
- Whether owner decision controls share one component between the inbox and project details.
- Exact wording within the privacy and behavior constraints above.
- The deterministic reconciliation response when a pending requester was independently added before the owner processes the request; the recommended behavior is approval reconciliation.
