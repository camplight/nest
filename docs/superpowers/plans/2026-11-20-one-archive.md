# One Archive and Chat Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Archive means the engine archive everywhere a person can manage the chat, archived chats are marked wherever they appear (Projects, sidebar, chat header, canvas), and the chat's **Sharing** button becomes **Settings**.

**Architecture:** Nest intercepts the engine's channel archive routes to pause and resume hand-off links; the projects API reads archived channels so archived projects list and open read-only; the user UI gains a `ChatSettingsDialog` component (extracted from App.tsx), an `Archived` header tag, an Archived section on the Projects page, and a Loose chats action that archives what the person can manage and hides the rest.

**Tech Stack:** Hono API (`apps/api`), product SQLite store (`packages/db`), zod schemas (`packages/schemas`), React 18 user UI (`apps/user-ui`, Vitest node env with `renderToStaticMarkup`), Playwright-style browser scripts in `tests/browser` (run in CI only).

**Spec:** `docs/superpowers/specs/2026-11-20-one-archive-design.md`

## Global Constraints

- `vendor/orgops` is never edited. Engine archive is `POST /api/channels/:id/archive` and `/unarchive`; who may call them is the engine's `canManageChannel`.
- npm only. Focused `npx vitest run <file>` and `npx tsc --noEmit -p .` locally; `npm test` once at the end; browser suites run in CI only.
- Link pause reason for archiving is the existing `'archived'` (`packages/schemas/src/flows.ts` `PausedReason`); archived-paused links are never Needs you items (already true in `pausedLinks`).
- Copy, verbatim: button `Settings`; dialog heading `Chat settings`; dialog parts `Sharing`, `Archive`, `Delete`; buttons `Archive chat` / `Unarchive chat`; tag `Archived`; header action `Unarchive`; Projects section heading `Archived ({n})`; canvas action for chats the person cannot manage `Hide from my list`, its undo `Unhide`; bulk notice parts `Archived {n}` and `hid {n} you can't manage` joined by ` · ` (capitalised `Hid …` when it stands alone).
- The archive line in Chat settings reads: `Archiving makes this chat read-only for everyone and pauses its hand-offs. You can unarchive it later.` and, when archived: `This chat is archived: read-only for everyone, its hand-offs paused.`
- Keep `docs/SPEC.md` in sync in the task that changes the behaviour. Conventional commits, no Co-Authored-By or tool attribution lines. Do not push.

## Review Focus

1. Archiving the chat of the project you are viewing: the page stays on that project and shows it archived (today `refreshChannels` reroutes away because it skips archived channels). Pinned in Task 5.
2. An engine refusal (403 for a chat you don't own) on archive must change no links and surface the engine's error, not a generic one. Pinned in Task 2.
3. Unarchiving a chat whose link's other end is still archived (or hidden by the link's creator) leaves that link paused. Pinned in Task 1 and Task 2.
4. A bulk Loose chats Archive where some engine archives fail: the chats that succeeded stay archived, the notice says what failed, and nothing is hidden by mistake in their place. Pinned in Task 6.
5. A team member (not the owner) viewing an archived team project sees it tagged but gets no Unarchive and no edit actions. Pinned in Task 3 and Task 5.

---

### Task 1: Store — archive pauses every creator's links, unarchive takes a predicate

**Files:**
- Modify: `packages/db/src/flows.ts` (`archiveLinks`, `unarchiveLinks`)
- Modify: `apps/api/src/canvases.ts` (the `POST /api/canvases/hidden` caller)
- Test: `packages/db/src/flows.test.ts`

**Interfaces:**
- Produces:
  - `archiveLinks(createdBy: string | null, channelIds: string[]): string[]` — `null` pauses running links of any creator touching the chats; a string keeps today's own-links behaviour. Returns paused link ids, declines their `awaiting` deliveries via `finishDelivery`.
  - `unarchiveLinks(createdBy: string | null, channelIds: string[], stillOff: (channelId: string, createdBy: string) => boolean): string[]` — resumes `archived`-paused links touching the chats unless `stillOff(otherEnd, link.createdBy)` (checked for both ends) is true; scan restarts at `max(now, scanned_to)`.

- [ ] **Step 1: Update the two existing store tests and add one**

Change the existing calls `unarchiveLinks('u', ['a'], new Set(['c']))` to `unarchiveLinks('u', ['a'], id => id === 'c')` (and `new Set()` to `() => false`). Add:

```ts
it('archiving a chat for everyone pauses every creator\'s links to it, and unarchive asks per creator', () => {
  const mine = mk('a', 'b');
  const theirs = store.flows.createLink({ id: randomUUID(), from: 'c', to: 'a', kind: 'link', createdBy: 'v', now: 1000 });
  expect(store.flows.archiveLinks(null, ['a']).sort()).toEqual([mine.id, theirs.id].sort());
  // 'v' still hides 'c' from their list: their link stays paused.
  expect(store.flows.unarchiveLinks(null, ['a'], (id, creator) => creator === 'v' && id === 'c')).toEqual([mine.id]);
  expect(store.flows.link(theirs.id)).toMatchObject({ on: false, pausedReason: 'archived' });
});
```

- [ ] **Step 2: Run** `cd packages/db && npx vitest run src/flows.test.ts` — expect the new test and the changed calls to fail.
- [ ] **Step 3: Implement** the signatures above (SQL `created_by=?` only when `createdBy` is a string).
- [ ] **Step 4: Update `apps/api/src/canvases.ts`** hidden route: `unarchiveLinks(human.id, ids, (id, creator) => engineArchived.has(id) || canvases.hidden(creator).includes(id))`, where `engineArchived` is the set of `c.get('channels')` ids with `archivedAt`. Run `cd packages/db && npx vitest run src/flows.test.ts` and `cd apps/api && npx vitest run src/canvases.test.ts` — PASS.
- [ ] **Step 5: Commit** `refactor(flows): pause links of every creator when a chat is archived for everyone`

### Task 2: API — Nest acts on links when the engine archives or unarchives a chat

**Files:**
- Create: `apps/api/src/channel-archive.ts`
- Modify: `apps/api/src/app.ts` (register before `app.all('/api/*', proxy)`, next to `registerAgentMemoryRoutes`)
- Test: `apps/api/src/channel-archive.test.ts` (engine + product harness as in `canvases.test.ts`)
- Modify: `docs/SPEC.md` (Loose chats Archive paragraph near "Archiving also pauses the person's own running links", and the links `paused_reason` list)

**Interfaces:**
- Consumes: Task 1 `archiveLinks(null, …)`, `unarchiveLinks(null, …, stillOff)`.
- Produces: `registerChannelArchiveRoutes(app: Hono, deps: {store: ProductDb; orgops: OrgOpsClient; forward: (request: Request) => Promise<Response>}): void` handling `POST /api/channels/:id/archive` and `POST /api/channels/:id/unarchive`: forward unchanged; when the engine answers 2xx, archive → `archiveLinks(null, [id])`; unarchive → `unarchiveLinks(null, [id], stillOff)` where `stillOff(other, creator)` is true when `other` is engine-archived (read `/api/channels?includeArchived=1` with the request's headers) or in `store.canvases.hidden(creator)`. The engine's response is returned as is.

- [ ] **Step 1: Write the failing tests**
  - `archiving through Nest pauses links to the chat and declines waiting hand-offs` — owner creates chats A, B; `store.flows.createLink(A→B, createdBy owner)`; `claimDelivery(…, 'awaiting')`; `POST /api/channels/B/archive` → 200; link `{on:false, pausedReason:'archived'}`, delivery `declined`.
  - `unarchiving resumes them unless the other end is still archived` — archive B and A; unarchive B → link stays paused; unarchive A → link on.
  - `an engine refusal changes nothing` — mate calls `POST /api/channels/<owner's private chat>/archive` → the engine's 403 body passes through; link unchanged.
- [ ] **Step 2: Run** `cd apps/api && npx vitest run src/channel-archive.test.ts` — FAIL (routes not registered: links unchanged).
- [ ] **Step 3: Implement** `apps/api/src/channel-archive.ts` and register it in `app.ts`.
- [ ] **Step 4: Run** the new test and `src/canvases.test.ts` — PASS. Update SPEC: archive and unarchive through Nest pause and resume every creator's links (`archived`), declining waiting hand-offs; the personal hide still pauses only the person's own.
- [ ] **Step 5: Commit** `feat(flows): archiving a chat pauses its hand-offs for everyone`

### Task 3: API — archived projects list and open read-only

**Files:**
- Modify: `apps/api/src/projects.ts:28-50,73,181-185`
- Modify: `packages/schemas/src/projects.ts:22` (`Project` gains `archived?: boolean`)
- Test: `apps/api/src/projects.test.ts`
- Modify: `docs/SPEC.md:532-534` (the "Archived/deleted/inaccessible chats make the project unavailable" sentence)

**Interfaces:**
- Produces: `GET /api/projects` returns the viewer's visible projects, then their archived ones with `archived: true` (owner: chat present, `canManage`, `archivedAt`; team member: chat present, archived, they are a HUMAN participant). `GET /api/projects/:id` returns `db.detail(project)` plus `archived: true` for those. `GET /api/projects/dashboard` and every route using `owned()` are unchanged (archived still refused).

- [ ] **Step 1: Write the failing tests**
  - `an archived project stays listed, tagged archived, and opens read-only` — create a project, `POST /api/channels/<its chat>/archive`, then `GET /api/projects` contains `{id, archived: true}`; `GET /api/projects/:id` 200 with `archived: true`; `POST /api/projects/:id/tasks` still 404.
  - `a team member sees an archived team project tagged, and cannot change it` — team project with mate as participant; archive; mate's list has it with `archived: true`; mate's `PATCH`/member routes refuse as today.
  - Existing expectations that an archived project is absent from `GET /api/projects` change to the above; dashboard expectations stay.
- [ ] **Step 2: Run** `cd apps/api && npx vitest run src/projects.test.ts` — FAIL.
- [ ] **Step 3: Implement** — the middleware reads `/api/channels?includeArchived=1` (every existing check already requires `!archivedAt`, so they keep refusing archived chats); add `archivedView(project, human, channels): boolean` and use it for the list's tail and for the detail route.
- [ ] **Step 4: Run** the projects tests and `npx tsc --noEmit -p .` in `apps/api` — PASS. Update SPEC: archived projects are listed after the others with `archived: true` and open read-only; edits stay refused until unarchived.
- [ ] **Step 5: Commit** `feat(projects): keep archived projects listed and readable`

### Task 4: UI — Chat settings dialog and the Archived header tag

**Files:**
- Create: `apps/user-ui/src/components/ChatSettingsDialog.tsx` (markup moved from `App.tsx:2378-2504`)
- Create: `apps/user-ui/src/components/ChatSettingsDialog.test.tsx`
- Modify: `apps/user-ui/src/App.tsx` (`headerMore` button at ~1904: label `Settings`, lucide `Settings` icon instead of `Share2`; `handleSaveChannelSettings` saves visibility only; new `setChannelArchived(channel, archived)` posting `/archive` or `/unarchive` then `refreshChannels(channel.id)`; render `ChatSettingsDialog`)
- Modify: `apps/user-ui/src/chat/ChatThread.tsx` (new optional prop `headerStatus?: ReactNode`, rendered before the header actions only when no `ChatHeaderSlotsContext` is set, so the canvas keeps its own tag)
- Modify: the browser scripts that click or read `Sharing` / `Manage channel` / the `Archived` checkbox: `tests/browser/chat.ts`, `tests/browser/projects.ts`, `tests/browser/dashboard.ts`, `tests/browser/agent-runtime-status.ts`, `tests/browser/canvas/open-chat.ts` (rename to `Settings` / `Chat settings`; archive via `Archive chat`)
- Modify: `docs/SPEC.md` (where the Sharing button / Manage channel dialog is described; the canvas "…" menu's Sharing item)

**Interfaces:**
- Produces: `ChatSettingsDialog(props: {channel: Channel; label: string; visibility: 'PRIVATE'|'PUBLIC'; onVisibility(v): void; saving: boolean; dirty: boolean; onSave(): void; onArchive(archived: boolean): Promise<void>; archiving: boolean; onParticipants(): void; onCopyLink(): void; linkCopied: boolean; confirmingDelete: boolean; onConfirmDelete(v: boolean): void; onDelete(): void; deleting: boolean; onClose(): void})`. App passes `headerStatus={activeChannel?.archivedAt ? <ArchivedTag canUnarchive={activeChannelManageable} onUnarchive={() => setChannelArchived(activeChannel, false)}/> : null}`; `ArchivedTag` lives in `ChatSettingsDialog.tsx` and renders `<span class="chat-archived-tag">Archived</span>` plus an `Unarchive` button when allowed.

- [ ] **Step 1: Write the failing tests** (`renderToStaticMarkup`)
  - heading `Chat settings`; section headings `Sharing`, `Archive`, `Delete` in that order;
  - an active chat shows `Archive chat` and the line `Archiving makes this chat read-only for everyone and pauses its hand-offs. You can unarchive it later.`; an archived chat shows `Unarchive chat` and `This chat is archived: read-only for everyone, its hand-offs paused.`;
  - no checkbox named `Archived` remains;
  - `ArchivedTag` with `canUnarchive` renders `Archived` and an `Unarchive` button; without it, only the tag.
- [ ] **Step 2: Run** `cd apps/user-ui && npx vitest run src/components/ChatSettingsDialog.test.tsx` — FAIL.
- [ ] **Step 3: Implement** the component, wire App and ChatThread; keep the existing delete confirm copy.
- [ ] **Step 4: Run** the new test, `npx vitest run src/chat`, `npx tsc --noEmit -p .` — PASS. Update the browser scripts' strings and SPEC.
- [ ] **Step 5: Commit** `feat(chat): Settings replaces Sharing, with Archive chat and an Archived tag`

### Task 5: UI — Archived projects on the Projects page, the sidebar and the project view

**Files:**
- Create: `apps/user-ui/src/project-archive.ts` (+ `project-archive.test.ts`)
- Modify: `apps/user-ui/src/Projects.tsx` (grid at ~59; detail header ~51-55; edit actions)
- Modify: `apps/user-ui/src/components/ProjectNavigation.tsx` (short list leaves out archived)
- Modify: `apps/user-ui/src/App.tsx` (`refreshChannels` ~1478-1486 and the project-selection effect ~523: an archived project chat keeps the project selected)
- Modify: `docs/SPEC.md` (Projects page and sidebar sections)

**Interfaces:**
- Consumes: Task 3 `Project.archived`; Task 4 `ArchivedTag`, App's `setChannelArchived`.
- Produces: `splitArchived<T extends {archived?: boolean}>(projects: T[]): {active: T[]; archived: T[]}` (order kept); `keepsProjectSelected(channel: {archivedAt?: number|null} | undefined, project: {archived?: boolean} | undefined): boolean`.

- [ ] **Step 1: Write the failing tests**
  - `splitArchived` keeps order and splits on `archived`;
  - `keepsProjectSelected` is true for an archived channel whose project is listed, false when the project is gone;
  - Projects grid markup: archived cards appear only inside `<details>` whose summary is `Archived (2)`, each card tagged `Archived`; none when there are no archived projects;
  - ProjectNavigation leaves archived projects out of its list.
- [ ] **Step 2: Run** the new tests — FAIL.
- [ ] **Step 3: Implement.** An archived project's detail shows `ArchivedTag` by the title (Unarchive only for the owner, calling `setChannelArchived` via a new `onUnarchive` prop from App), and hides `Edit project details`, `Add people or agents`, member removal and task actions.
- [ ] **Step 4: Run** the tests and `npx tsc --noEmit -p .` — PASS. Update SPEC.
- [ ] **Step 5: Commit** `feat(projects): show archived projects and let their owner unarchive them`

### Task 6: UI — Loose chats Archive archives what you manage and hides the rest

**Files:**
- Modify: `apps/user-ui/src/canvas/loose.ts` (`LooseChat` gains `manageable: boolean` and `archived: boolean`; `looseChats` includes engine-archived chats only while `showHidden`; new `archivePlan`, `archiveNotice`)
- Modify: `apps/user-ui/src/canvas/LooseDrawer.tsx` (bulk button label; row undo `Unarchive` for archived, `Unhide` for hidden; footer checkbox stays `Show archived`)
- Modify: `apps/user-ui/src/canvas/CanvasView.tsx` (`hide` becomes `archiveOrHide(channelIds, value)`: engine archive/unarchive for manageable ids one by one through `/api/channels/:id/archive|unarchive`, `setHidden` for the rest, then `refreshChannels()`; `manageable` uses the `canAddTo` rule for loose chats)
- Modify: `tests/browser/canvas/pile.ts` (archive labels and the archived row's undo)
- Test: `apps/user-ui/src/canvas/loose.test.ts`, `apps/user-ui/src/canvas/LooseDrawer.test.tsx` (if present; else add focused markup tests to `loose.test.ts`)
- Modify: `docs/SPEC.md` (the Loose chats drawer: Archive, Show archived, bulk actions, and the hidden route paragraph)

**Interfaces:**
- Consumes: Task 2 routes (links follow automatically).
- Produces: `archivePlan(ids: string[], manageable: (id: string) => boolean): {archive: string[]; hide: string[]}`; `archiveNotice(archived: number, hid: number, failed: number): string` → e.g. `Archived 3 · hid 1 you can't manage`, `Hid 2 you can't manage`, `Archived 2 · 1 could not be archived. Try again.`; bulk button label `Archive` when the selection has a manageable chat, else `Hide from my list`.

- [ ] **Step 1: Write the failing tests**
  - `archivePlan` splits by `manageable`, order kept;
  - `archiveNotice` returns exactly the three strings above for `(3,1,0)`, `(0,2,0)`, `(2,0,1)`;
  - `looseChats` with `showHidden` lists an engine-archived chat with `archived: true`, and without it leaves it out;
  - drawer markup: an archived row shows `Unarchive`, a hidden row `Unhide`; a selection of only unmanageable chats labels the bulk button `Hide from my list`.
- [ ] **Step 2: Run** `cd apps/user-ui && npx vitest run src/canvas/loose.test.ts` — FAIL.
- [ ] **Step 3: Implement.** Failures: an engine refusal for one id counts as failed and that id is **not** hidden instead.
- [ ] **Step 4: Run** `npx vitest run src/canvas` and `npx tsc --noEmit -p .` — PASS. Update `tests/browser/canvas/pile.ts` strings and SPEC.
- [ ] **Step 5: Commit** `feat(canvas): Loose chats Archive archives chats you manage and hides the rest`

### Task 7: Whole-suite check

- [ ] Run `npm test` from the repo root — expect all files to pass; run `npx esbuild <each modified tests/browser file> --format=esm --log-level=error > /dev/null` to syntax-check the browser scripts.
- [ ] Fix anything red in the task that owns it, then commit.
