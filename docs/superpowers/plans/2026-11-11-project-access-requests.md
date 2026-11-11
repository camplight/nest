# Project Access Requests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an authenticated human request normal collaborator access from an inaccessible project link, let the owner approve or deny, and let the owner later revoke confirmed OrgOps membership.

**Architecture:** Nest persists only the access-request workflow and audit history in its product database. A dedicated project-access API uses the signed-in owner’s human session to reconcile OrgOps HUMAN channel subscriptions; current OrgOps membership remains authoritative. The user UI adds a privacy-safe inaccessible-project gate, extends the notifications inbox, and adds owner decision/revocation controls to project details.

**Tech Stack:** TypeScript, Hono, SQLite/better-sqlite3, Zod, React 18, Vitest, Playwright, embedded OrgOps API fixtures.

**Spec:** `docs/superpowers/specs/2026-11-11-project-access-requests-design.md`

## Global Constraints

- Do not edit or patch `vendor/orgops`; use existing human-authenticated channel subscribe/unsubscribe HTTP APIs.
- Do not store or infer engine membership in the product database; re-read OrgOps before reporting approval or revocation success.
- Requester-facing responses and UI must not expose project name, description, owner, channel ID, participants, files, or messages before access is granted.
- Approval grants normal collaborator access: project chat read/post and project files; it grants no connected-account, agent, task mutation, ownership, or administration rights.
- Human IDs are durable request identities; resolve the current username from `/api/humans` immediately before OrgOps membership writes.
- Approval must claim `pending -> approving` before any subscribe attempt so a racing denial cannot contradict live engine access.
- A legacy private project changes to `team` only in the same product transaction that finalizes confirmed approval.
- API requests remain JSON, `Cache-Control: no-store`, and within the existing 64 KB product route bound.
- Use npm, not pnpm. If dependencies are absent, initialize the pinned submodule before `npm ci`.
- On this live production host, run focused unit/integration tests only. Run full builds, full suites, and browser validation in GitHub Actions or another bounded runner.

## Review Focus

- Approve/deny race after approval starts: the approval claim wins before OrgOps mutation, denial returns 409, and final membership matches the stored decision — pinned in Task 3 API concurrency tests.
- Lost subscribe/unsubscribe response: retries reconcile current OrgOps membership without duplicate grants, false denials, or false revocation success — pinned in Task 3 API recovery tests.
- Renamed or deleted requester: approval resolves by durable human ID, uses the current username, and fails closed if the identity no longer exists — pinned in Task 3 identity tests.
- Missing, archived, or inaccessible project IDs: requester state stays generic and leaks no metadata; owner actions require current manage/post access — pinned in Tasks 2 and 3 authorization tests.
- Membership changed outside the workflow: current members load the project, removed members can request again, and pending requests reconcile deterministically — pinned in Tasks 2, 3, and 6.

---

### Task 1: Product schema, migration, and access-request store

**Files:**
- Create: `packages/db/migrations/011_project_access_requests.sql`
- Create: `packages/db/src/project-access.ts`
- Create: `packages/db/src/project-access.test.ts`
- Modify: `packages/db/src/index.ts`
- Modify: `packages/db/src/projects.test.ts`
- Modify: `packages/schemas/src/projects.ts`

**Interfaces:**
- Produces schemas/types:
  - `ProjectAccessRequestStatus = 'pending' | 'approving' | 'approved' | 'denied'`
  - `CreateProjectAccessRequestSchema` for `{ id: UUID }`
  - `ProjectAccessDecisionSchema` for `{ decision: 'approve' | 'deny' }`
  - `ProjectAccessRequest`, `ProjectAccessRequesterState`, and `ProjectAccessNotification`
- Produces `createProjectAccessStore(db)` and `ProductDb.projectAccess` with:
  - `get(id: string): ProjectAccessRequest | undefined`
  - `latest(projectId: string, requesterId: string): ProjectAccessRequest | undefined`
  - `create(input): { kind: 'created' | 'existing'; request: ProjectAccessRequest } | { kind: 'conflict' }`
  - `activeForProjects(projectIds: string[]): ProjectAccessRequest[]`
  - `deny(requestId, projectId, ownerId, at): DecisionResult`
  - `claimApproval(requestId, projectId, ownerId, at): DecisionResult`
  - `releaseApproval(requestId, ownerId): boolean`
  - `finishApproval(requestId, projectId, ownerId, at): DecisionResult`
  - `auditRevocation(projectId, memberId, memberUsername, ownerId, at): void`

- [ ] **Step 1: Initialize the isolated checkout and verify the focused baseline**

Run only when `node_modules` is absent:

```bash
npm run engine:install
npm ci
```

Then run:

```bash
node node_modules/vitest/vitest.mjs run packages/db/src/projects.test.ts apps/api/src/projects.test.ts
```

Expected: existing focused tests pass. If setup or the baseline fails independently of this feature, stop and report the exact failure.

- [ ] **Step 2: Write failing migration and store tests**

Add tests proving:

```ts
expect(store.db.prepare('SELECT name FROM product_migrations WHERE name=?').get('011_project_access_requests')).toBeTruthy();
expect(store.projectAccess.create(request).kind).toBe('created');
expect(store.projectAccess.create(request).kind).toBe('existing');
expect(store.projectAccess.create({...request,id:otherId}).request.id).toBe(request.id); // one active row
expect(store.projectAccess.claimApproval(request.id, project.id, ownerId, now).request.status).toBe('approving');
expect(store.projectAccess.deny(request.id, project.id, ownerId, now).kind).toBe('conflict');
expect(store.projectAccess.finishApproval(request.id, project.id, ownerId, now).request.status).toBe('approved');
expect(store.projects.project(project.id)?.collaboration).toBe('team');
```

Also cover ID reuse by another requester/project, denial history followed by a new pending request, latest-state ordering, audit rows, and repeatable migration application.

- [ ] **Step 3: Run the store tests to verify they fail**

```bash
node node_modules/vitest/vitest.mjs run packages/db/src/project-access.test.ts packages/db/src/projects.test.ts
```

Expected: FAIL because migration 011, schemas, and `projectAccess` do not exist.

- [ ] **Step 4: Implement the schemas, migration, and store**

Migration requirements:

- `product_project_access_requests` references `product_projects(id)` with cascade delete.
- Store durable requester ID plus username snapshot.
- Status check includes exactly `pending`, `approving`, `approved`, `denied`.
- Partial unique index permits one active (`pending` or `approving`) row per project/requester.
- Index owner-active and requester-latest lookups.

Store requirements:

- Keep all SQL and request-state transactions in `packages/db/src/project-access.ts`.
- Claim approval before external side effects.
- `finishApproval` atomically changes the project to `team`, finalizes `approved`, and appends the audit row.
- `deny` atomically finalizes and audits only a `pending` request.
- Repeated same decisions are idempotent; conflicting decisions return structured conflicts.

Register migration `011_project_access_requests` and expose `projectAccess` from `openProductDb`.

- [ ] **Step 5: Run focused tests and type checks**

```bash
node node_modules/vitest/vitest.mjs run packages/db/src/project-access.test.ts packages/db/src/projects.test.ts
npm run --workspace @nest/schemas lint
npm run --workspace @nest/db lint
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add packages/db/migrations/011_project_access_requests.sql packages/db/src/project-access.ts packages/db/src/project-access.test.ts packages/db/src/index.ts packages/db/src/projects.test.ts packages/schemas/src/projects.ts
git commit -m "feat(db): store project access requests"
```

---

### Task 2: Privacy-safe requester state, request creation, and owner inbox API

**Files:**
- Create: `apps/api/src/project-access.ts`
- Create: `apps/api/src/project-access.test.ts`
- Modify: `apps/api/src/app.ts`

**Interfaces:**
- Consumes `ProductDb.projectAccess` and schemas from Task 1.
- Produces:
  - `GET /api/projects/:projectId/access-request`
  - `POST /api/projects/:projectId/access-requests`
  - `GET /api/project-access-requests`
  - `registerProjectAccessRoutes(app, { store, orgops })`
- Later Task 3 extends the same route module with decisions and revocation.

- [ ] **Step 1: Write failing requester and inbox API tests**

Build a two-human fixture against the real embedded OrgOps API. Assert:

- Signed-out and must-change-password callers are rejected.
- An inaccessible existing project returns only `requestable`; serialized JSON does not contain its name, description, owner ID, or channel ID.
- Missing/unrequestable project returns generic 404 `{error:'Project unavailable'}`.
- A client UUID creates one pending request; same UUID and a second UUID both reconcile to that request.
- Request ID reuse by another actor/project returns 409.
- Owner self-request is rejected; a current member receives `{status:'member'}`.
- `approving` is presented to the requester as `pending`.
- Latest denial is returned as `{status:'denied', request:{id,decidedAt}}`; a previously approved but no-longer-member requester is `requestable`.
- Owner inbox contains only active requests for projects the owner can currently manage/post to, with project name and current requester username.
- A non-owner or an owner who lost channel management cannot list another owner’s request.

- [ ] **Step 2: Run the API test to verify it fails**

```bash
node node_modules/vitest/vitest.mjs run apps/api/src/project-access.test.ts
```

Expected: FAIL because the routes are not registered.

- [ ] **Step 3: Implement route registration and shared authorization helpers**

In `project-access.ts`:

- Authenticate through `orgops.currentHuman`; reject incomplete password setup.
- Load current channels with the human session and set `Cache-Control: no-store`.
- Keep requester responses metadata-free.
- Map current OrgOps membership before product history: a current member always receives `member`.
- Resolve owner inbox identities from `/api/humans` but use stored snapshots only for display when an identity disappeared.
- Register `registerProjectAccessRoutes` before `registerProjectRoutes` in `apps/api/src/app.ts`, so the existing project wildcard does not swallow the new routes.

- [ ] **Step 4: Run focused API tests and lint**

```bash
node node_modules/vitest/vitest.mjs run apps/api/src/project-access.test.ts apps/api/src/projects.test.ts
npm run --workspace @nest/api lint
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/project-access.ts apps/api/src/project-access.test.ts apps/api/src/app.ts
git commit -m "feat(api): accept project access requests"
```

---

### Task 3: Owner decisions and collaborator revocation API

**Files:**
- Modify: `apps/api/src/project-access.ts`
- Modify: `apps/api/src/project-access.test.ts`

**Interfaces:**
- Consumes Task 1 decision/store methods and Task 2 auth helpers.
- Produces:
  - `POST /api/projects/:projectId/access-requests/:requestId/decision`
  - `DELETE /api/projects/:projectId/members/:username`

- [ ] **Step 1: Write failing decision, race, recovery, and revocation tests**

Add tests proving:

- Denial changes no engine membership and requester polling returns `denied`.
- Approval resolves requester by durable ID, subscribes the current username, confirms membership, finalizes `approved`, and makes a legacy private project `team`-visible.
- A renamed requester is subscribed under the new username; a deleted requester cannot be approved and remains actionable for denial.
- Approval with a lost subscribe response re-reads membership, finalizes once, and creates one HUMAN subscription.
- A definite failure before a subscribe attempt releases `approving` to `pending`; an uncertain attempt remains `approving` for retry.
- Concurrent approve/deny produces one winner before engine mutation: if approval claims first, denial returns 409 and membership is present; if denial claims first, no membership is added.
- An independently added pending requester is reconciled as approved when the owner approves.
- Owner, anonymous, requester, and runner-header callers cannot decide or revoke.
- Archived/unmanageable channels block decisions without changing request state.
- Revocation confirms HUMAN removal, immediately removes project access, is retry-safe after a lost response, cannot remove the owner, audits once, and lets the removed person request again.

- [ ] **Step 2: Run the new tests to verify they fail**

```bash
node node_modules/vitest/vitest.mjs run apps/api/src/project-access.test.ts
```

Expected: decision and revocation assertions fail because the routes do not exist.

- [ ] **Step 3: Implement denial and approval claim/finalization**

Approval sequence must be exactly:

1. Verify current owner/manage/post access and resolve the requester’s current username.
2. Claim `pending -> approving` in the product DB; resume an existing approval claim on retry.
3. Re-read channel membership and subscribe only when absent.
4. Re-read and confirm HUMAN membership.
5. Finalize `approving -> approved`, project `private -> team`, and audit in one product transaction.

Do not permit denial after `approving`. On a definite pre-subscription failure release the claim; after an attempted/uncertain subscription retain it for reconciliation.

- [ ] **Step 4: Implement confirmed revocation**

Resolve the current human by username, reject the owner, unsubscribe through the owner’s session, and re-read the channel. Report success only when absent. Append one revocation audit after confirmation; retries after confirmed absence remain successful.

- [ ] **Step 5: Run focused API tests and lint**

```bash
node node_modules/vitest/vitest.mjs run apps/api/src/project-access.test.ts apps/api/src/projects.test.ts
npm run --workspace @nest/api lint
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/project-access.ts apps/api/src/project-access.test.ts
git commit -m "feat(api): decide and revoke project access"
```

---

### Task 4: Inaccessible-project request controls

**Files:**
- Create: `apps/user-ui/src/ProjectAccessGate.tsx`
- Create: `apps/user-ui/src/ProjectAccessGate.test.tsx`
- Modify: `apps/user-ui/src/Projects.tsx`
- Modify: `apps/user-ui/src/projects.css`

**Interfaces:**
- Consumes `ProjectAccessRequesterState` and requester routes from Tasks 1–2.
- Produces `ProjectAccessGate({ projectId, onMember, onUnavailable })`.
- `onMember()` triggers the normal project detail reload after approval becomes visible.

- [ ] **Step 1: Write failing static-render tests for privacy-safe states**

Use `renderToStaticMarkup` to assert:

- `requestable` renders “Request access” and normal collaborator copy.
- `pending` renders “Access requested” and no second submission control.
- `denied` renders “Your request was not approved” and “Request again”.
- `unavailable` renders generic “Project unavailable”.
- None of these states accepts or renders project metadata.

- [ ] **Step 2: Run the component test to verify it fails**

```bash
node node_modules/vitest/vitest.mjs run apps/user-ui/src/ProjectAccessGate.test.tsx
```

Expected: FAIL because the component does not exist.

- [ ] **Step 3: Implement `ProjectAccessGate`**

- Fetch requester state immediately and every 10 seconds while mounted.
- Keep the direct-link page heading neutral (`Project`).
- Generate one request UUID per submission attempt and reuse it after an uncertain response.
- Render loading, requestable, submitting, pending, denied, unavailable, and retryable error states from the spec.
- When state becomes `member`, call `onMember` and let `Projects` retry its normal detail request.
- Never pass project name/description into this component.

- [ ] **Step 4: Integrate the gate into `Projects`**

When a direct project detail load fails, render the gate instead of the existing raw error notice. Preserve the ordinary error/refresh behavior when the access-state endpoint is also unavailable. Do not render chat, files, tasks, or `ProjectContext` until detail succeeds.

- [ ] **Step 5: Run focused tests and user UI typecheck**

```bash
node node_modules/vitest/vitest.mjs run apps/user-ui/src/ProjectAccessGate.test.tsx
npm run --workspace @nest/user-ui lint
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add apps/user-ui/src/ProjectAccessGate.tsx apps/user-ui/src/ProjectAccessGate.test.tsx apps/user-ui/src/Projects.tsx apps/user-ui/src/projects.css
git commit -m "feat(ui): request project access from shared links"
```

---

### Task 5: Owner notifications, decisions, and member removal controls

**Files:**
- Create: `apps/user-ui/src/project-access.ts`
- Create: `apps/user-ui/src/components/ProjectAccessRequestList.tsx`
- Create: `apps/user-ui/src/components/ProjectAccessRequestList.test.tsx`
- Modify: `apps/user-ui/src/components/MentionInbox.tsx`
- Modify: `apps/user-ui/src/components/mentions.css`
- Modify: `apps/user-ui/src/components/WorkspaceTopbar.tsx`
- Modify: `apps/user-ui/src/ProjectContext.tsx`
- Modify: `apps/user-ui/src/projects.css`
- Modify: `apps/user-ui/src/App.tsx`

**Interfaces:**
- Produces transport helpers:
  - `loadProjectAccessRequests(signal?: AbortSignal): Promise<ProjectAccessNotification[]>`
  - `decideProjectAccess(projectId, requestId, decision): Promise<ProjectAccessRequest>`
  - `revokeProjectMember(projectId, username): Promise<{status:'removed'}>`
- Produces reusable `ProjectAccessRequestList` with explicit `items`, `busyId`, `onApprove`, and `onDeny` props.
- Extends `WorkspaceHeaderProvider` with `onProjectAccessChanged(): void` so approved membership refreshes the current project/channel shell.

- [ ] **Step 1: Write failing static-render tests for owner controls**

Assert the reusable list renders:

- “<requester> requested access to <project>”.
- Approve and Deny buttons with accessible names.
- “Approving makes this a team project” only for private projects.
- An `approving` row as incomplete/retryable approval, without a Deny action.
- Disabled progress controls for the busy row.

- [ ] **Step 2: Run the component test to verify it fails**

```bash
node node_modules/vitest/vitest.mjs run apps/user-ui/src/components/ProjectAccessRequestList.test.tsx
```

Expected: FAIL because the list does not exist.

- [ ] **Step 3: Extend the notification inbox**

- Fetch mentions and project access requests independently on mount, every 30 seconds, focus, and existing message refresh events.
- Rename visible/ARIA inbox language from “Mentions” to “Notifications” while preserving mention actions.
- Render request controls through `ProjectAccessRequestList`.
- Keep one section usable if the other endpoint fails.
- Show the unread dot for unread mentions or any active access request.
- After a confirmed decision, refresh requests and call `onProjectAccessChanged`.

- [ ] **Step 4: Add project-detail pending and revoke controls**

For owners only:

- Load/filter active requests for the current project and render the same list.
- Add “Remove access” to non-owner HUMAN participants only.
- Confirm removal with the exact consequence that chat/file access ends immediately and another request is allowed later.
- After approve, deny, or revoke, refresh requests and call `onMembersChanged`.
- Preserve existing agent membership and invitation behavior.

- [ ] **Step 5: Run focused UI tests and typecheck**

```bash
node node_modules/vitest/vitest.mjs run apps/user-ui/src/ProjectAccessGate.test.tsx apps/user-ui/src/components/ProjectAccessRequestList.test.tsx
npm run --workspace @nest/user-ui lint
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add apps/user-ui/src/project-access.ts apps/user-ui/src/components/ProjectAccessRequestList.tsx apps/user-ui/src/components/ProjectAccessRequestList.test.tsx apps/user-ui/src/components/MentionInbox.tsx apps/user-ui/src/components/mentions.css apps/user-ui/src/components/WorkspaceTopbar.tsx apps/user-ui/src/ProjectContext.tsx apps/user-ui/src/projects.css apps/user-ui/src/App.tsx
git commit -m "feat(ui): review and revoke project access"
```

---

### Task 6: End-to-end project access journey and synchronized documentation

**Files:**
- Modify: `tests/browser/projects.ts`
- Modify: `docs/SPEC.md`
- Modify: `docs/SUBMODULE_MIGRATION.md`

**Interfaces:**
- Consumes all feature routes and UI from Tasks 1–5.
- Produces the browser acceptance journey and deployment/ownership documentation.

- [ ] **Step 1: Add the browser acceptance journey**

Extend the existing real product/engine project test with a third authenticated human who is not initially subscribed:

1. Open the direct project URL and assert the neutral access gate does not contain the project name, description, owner, participants, chat, or files.
2. Capture final desktop and mobile request-access screenshots into the existing temporary screenshot directory; emit CI attachments using the established base64 pattern when appropriate.
3. Request access and assert the pending state survives reload without creating a duplicate row.
4. On the owner page, open Notifications and approve; assert the requester’s already-open page recovers to the real project and can use chat/files.
5. Remove the collaborator from project details; assert the requester loses access on refresh and can request again.
6. Submit another request, deny it, and assert the requester sees the persistent denied state with Request again and no project metadata.
7. Assert API/database counts show one active request at a time and the expected audit history.

- [ ] **Step 2: Update the product and migration specifications**

In `docs/SPEC.md`, document:

- Requester/owner/revocation behavior and API routes.
- Product workflow versus OrgOps membership authority.
- Migration 011 table and audit events.
- Approval claim/reconciliation and metadata privacy.
- Focused and browser verification coverage.

In `docs/SUBMODULE_MIGRATION.md`, document:

- Additive product migration only; no OrgOps pin/source/engine migration.
- API and UI deploy together.
- Snapshot both databases and preserve engine runtime data.
- Existing memberships/credentials are unchanged; pending requests live in the product volume.

- [ ] **Step 3: Run all focused local checks permitted on this host**

```bash
node node_modules/vitest/vitest.mjs run packages/db/src/project-access.test.ts packages/db/src/projects.test.ts apps/api/src/project-access.test.ts apps/api/src/projects.test.ts apps/user-ui/src/ProjectAccessGate.test.tsx apps/user-ui/src/components/ProjectAccessRequestList.test.tsx
npm run --workspace @nest/schemas lint
npm run --workspace @nest/db lint
npm run --workspace @nest/api lint
npm run --workspace @nest/user-ui lint
git diff --check
```

Expected: all pass.

Do **not** run `npm test`, `npm run build`, or browser validation alongside the live services on this host.

- [ ] **Step 4: Record required bounded-runner/CI validation**

Required before merge, but run in GitHub Actions or a separate bounded runner:

```bash
npm test
npm run lint
npm run build
npm run test:ui:projects
```

Report exact results. Do not claim these checks passed until their CI/bounded-runner output exists.

- [ ] **Step 5: Commit**

```bash
git add tests/browser/projects.ts docs/SPEC.md docs/SUBMODULE_MIGRATION.md
git commit -m "test: cover project access request journey"
```

---

## Plan self-review

- **Spec coverage:** Persistence, schemas, requester privacy, owner inbox, approval/denial, race prevention, revocation, legacy private conversion, retries, auditing, browser journey, screenshots, and docs each map to Tasks 1–6.
- **Step scan:** Each implementation step names exact files, route/component/store interfaces, focused assertions, and verification commands; browser execution is explicitly deferred to the required bounded environment.
- **Type consistency:** Tasks use the same four request statuses, `ProjectAccessRequesterState`, `ProjectAccessNotification`, `ProductDb.projectAccess`, and route paths defined in Task 1.
- **Review Focus:** All five high-risk conditions have explicit tests in Tasks 2, 3, and 6.
- **Proportion:** The plan specifies interfaces and observable tests without embedding route/store/component implementations.
