# Switchyard Canvas, Phase 1 (Canvas of chats) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the Switchyard canvas view behind `NEST_ENABLE_CANVAS`. People can lay out their existing chats on private or shared canvases, see each chat's live state, work the Loose chats pile, and open a chat in place or in split screen, all without changing any engine data through layout.

**Architecture:**
- **Layout state** (canvases, members, areas, card positions, per-person hides) is new Nest product data. It lives in migration `011`, is served by a new `apps/api/src/canvases.ts` route module, and uses versioned compare-and-swap writes.
- **Chat data** always comes from the engine with the viewer's own credentials. The board endpoint resolves each card against the viewer's `/api/channels` list, so engine access alone decides between open, locked and unavailable.
- **Live card state** is computed in the browser by reusing the existing Nest #74 `activeTurns` classification over cross-channel event queries. It is then kept fresh by the WebSocket events App already receives for every visible channel.
- **The canvas** is plain DOM with CSS transforms and off-screen culling. Opening a chat reuses App's existing single chat workspace (one open chat at a time), shown in place or in a split pane.

**Tech Stack:**
- Hono API, better-sqlite3 product DB, zod v3 schemas
- React 18 + Vite user UI with plain CSS on Nest brand tokens. Tailwind stays scoped to `chat/`.
- vitest unit and boundary tests; Playwright browser suites run under `node --import tsx`
- npm workspaces

**Spec:** `docs/superpowers/specs/2026-11-08-switchyard-canvas-design.md`, section 8 "Phase 1: Canvas of chats". Sections 4 (anti-goals), 5 (constraints), 6 (concepts), 7 (what the spike settled) and 9 (data ownership) also apply. "Spec 7" means its section 7.

**Branch:** `feat/switchyard-canvas` (it already holds the design doc). Visual reference: the spike `switchyard-nest-vision.html`, which is attached to the PR and not committed.

## Global Constraints

- `vendor/orgops` is never edited or patched. Plan against the pinned revision `7406b6a`; the local checkout may differ.
- Use npm, not pnpm. No new runtime dependencies. The canvas is plain DOM and CSS transforms (spec 13 leaves this open; this plan decides it).
- Boundaries:
  - `apps/api` never reads the engine DB.
  - Engine calls go through `OrgOpsClient` (`humanJson` / `humanRequest`) with the human's headers.
  - Product tables live only in `packages/db` migration `011_canvases.sql`.
  - Product types live in `packages/schemas/src/canvas.ts`.
- Layout actions never call an engine write. The only engine writes in Phase 1 are inviting or removing an agent, sending a Nudge, and starting a chat from the bottom box. Each goes through an existing endpoint: `POST /api/channels/:id/subscribe`, `POST /api/projects/:id/members`, `POST /api/channels/:id/unsubscribe`, `POST /api/messages` and `POST /api/projects`.
- Flag: the API reads `NEST_ENABLE_CANVAS=1` (config field `canvasEnabled`).
  - When it is off, every `/api/canvases/*` route returns 404 `{error:'Not found'}`, except `GET /api/canvases/availability`, which returns `{available:false}`.
  - The UI shows no Canvas entry unless `available` is true.
- Anti-goals (spec 4) are review criteria for every UI task:
  - no Run or Run all buttons, no node wiring
  - no freehand drawing, sticky notes or shapes
  - no automatic placement
  - no dot grid; use the woven-twig texture
  - areas are rounded "nests"
  - Nest tokens, Inter and Unbounded, and Nest characters
- Copy fixed by the spec:
  - `Loose chats`, `Needs you`, `New area from these`, `Private chat`
  - `quiet for N min` (N = whole minutes), `Nudge`
  - `Open in the regular chat view`, `All agents`, `Fit`
- Thresholds:
  - quiet after 20 minutes without an agent signal
  - semantic zoom below 0.5
  - zoom range 0.2–2
  - shared-canvas sync every 5 s while visible, and on window focus
  - phones are viewports ≤ 760 px wide (the existing breakpoint)
- Limits, each rejected with 400:
  - names and titles 1–120 trimmed chars
  - coordinates finite within ±1,000,000
  - card `w` 200–640 (default 280)
  - area `w`/`h` 160–20,000
  - ≤ 500 cards and ≤ 100 areas per canvas
  - ≤ 50 owned canvases per human
  - ≤ 30 members per canvas
  - ≤ 100 channel ids per bulk call
- Tests are colocated vitest files against real Nest-to-OrgOps handlers with temporary DBs, following `apps/api/src/projects.test.ts:18-37`. Browser suites use the real engine, API and WS harness. No mocks across the ownership boundary.
- Full builds, full suites and browser checks run in CI (`.github/workflows/product.yml`), never on the production VPS. A local run of one targeted test file is fine.
- Conventional commits ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. No credentials in code, logs or fixtures. Screenshots are PR attachments only.
- Commands:
  - `npm test -- <path>`: one vitest file
  - `npm test`, `npm run lint`, `npm run build`
  - `npm run test:ui:canvas` (added in Task 4)

## Review Focus

Each of these inputs is pinned by a test in the task named.

1. **A card for a chat the viewer can't see, including a renamed one** (shared canvas, teammate not in the chat). The board must never send its title, participants or project name; it shows `Private chat` and the owner. This is tested in Task 3 by asserting the response JSON contains no title string.
2. **Two editors moving the same card, or one moving an area while another moves a card inside it.** The second write gets 409 with the current item, and the UI refreshes instead of snapping back silently. Tested in Task 2 (store) and Task 5 (UI shows `Canvas changed. Refreshed.`).
3. **An agent turn that started, then nothing for 25 minutes, while the agent still heartbeats.** The card must say `quiet for 25 min` and never `done`. A restart must show interrupted, not quiet. Tested in Task 6.
4. **Losing access.** A canvas member is removed while viewing, or a chat is deleted or unshared after placement. The member gets 404 on the next sync and is moved to their canvas list. A card the viewer placed that is now missing from their channels shows `unavailable` with a `Remove` action. Tested in Tasks 3 and 10.
5. **A 200+ chat pile and a 150-card canvas.** The pile list stays virtualised and filterable. Panning renders only cards near the viewport (fewer than 60 card nodes in the DOM at Fit-to-area zoom). Tested in Tasks 7 and 12.

---

## File Structure

| Path | Responsibility |
|---|---|
| `packages/db/migrations/011_canvases.sql` | Product tables for Phase 1 |
| `packages/db/src/canvases.ts` (+ `.test.ts`) | `createCanvasStore(db)`: access rules, versioned writes, audit |
| `packages/schemas/src/canvas.ts` (+ `.test.ts`) | Zod input schemas, response types, shared geometry `areaFor` |
| `apps/api/src/canvases.ts` (+ `canvases.test.ts`, `canvas-board.test.ts`) | `/api/canvases*` routes, flag gate, board resolution against engine channels |
| `apps/api/src/app.ts` | Register routes; `canvasEnabled` config |
| `apps/user-ui/src/canvas/api.ts` | Typed fetch helpers for `/api/canvases*` |
| `apps/user-ui/src/canvas/geometry.ts` (+ test) | View transform, zoom, fit, culling, hit testing |
| `apps/user-ui/src/canvas/board-store.ts` (+ test) | Board state, optimistic writes, conflict refresh, sync loop |
| `apps/user-ui/src/canvas/pulse.ts` (+ test) | Per-card live state from events, agents, starts and mentions |
| `apps/user-ui/src/canvas/loose.ts` (+ test) | Loose pile derivation, filters, search |
| `apps/user-ui/src/canvas/search.ts` (+ test) | Ctrl/Cmd+K index and ranking |
| `apps/user-ui/src/canvas/CanvasView.tsx` | View shell: top bar, surface, pile, tray, bottom box, chat pane |
| `apps/user-ui/src/canvas/Surface.tsx`, `Area.tsx`, `Card.tsx` | Canvas rendering and gestures |
| `apps/user-ui/src/canvas/LoosePile.tsx`, `AgentTray.tsx`, `NeedsYou.tsx`, `CanvasSearch.tsx`, `CanvasSwitcher.tsx`, `ShareDialog.tsx`, `PhoneList.tsx` | Feature panels |
| `apps/user-ui/src/canvas/canvas.css` | Canvas styles on brand tokens, including the twig texture |
| `apps/user-ui/src/chat-members.ts` (+ test) | `addChatMember` / `removeChatMember` shared by App and canvas |
| `apps/user-ui/src/App.tsx` | `view==='canvas'`, nav entry, URL state, WS fan-out, chat reuse |
| `apps/user-ui/src/ProjectStart.tsx` | `StartChat` gains a `variant:'page'|'dock'` prop |
| `apps/user-ui/public/design/canvas.svg` | Nav icon |
| `tests/browser/support/chat-harness.ts` | `canvas?:boolean` option passes `canvasEnabled` to `createApp` |
| `tests/browser/canvas/*.ts`, `tests/browser/canvas/run.ts` | Browser suite |
| `package.json`, `.github/workflows/product.yml`, `.env.example`, `docs/SPEC.md`, `docs/ROADMAP.md` | Script, CI, flag docs |

---

### Task 1: Product schema, migration and canvas store

**Files:**
- Create: `packages/db/migrations/011_canvases.sql`, `packages/db/src/canvases.ts`, `packages/db/src/canvases.test.ts`, `packages/schemas/src/canvas.ts`, `packages/schemas/src/canvas.test.ts`
- Modify:
  - `packages/db/src/index.ts:24-31` (append `'011_canvases'` to the migration array) and `:46` (attach `canvases:createCanvasStore(db)`)
  - `packages/db/src/projects.test.ts:24` (expected migration list)
  - `packages/schemas/src/index.ts` (`export * from './canvas'`)

**Interfaces:**
- Produces, in `@nest/schemas`:
  - Enums:
    - `CanvasRole = 'owner'|'edit'|'view'`
    - `CanvasVisibility = 'private'|'shared'`
  - Schemas:
    - `NewCanvasSchema {id:uuid, name}`
    - `CanvasRenameSchema {name, version}`
    - `CanvasSharingSchema {visibility, members:{humanId:string(1..200), role:'edit'|'view'}[] ≤30, version}`. The refine rejects members when visibility is `'private'`.
    - `NewAreaSchema {id:uuid, title, x, y, w, h, tint?:'moss'|'puff'|'pom'|'pip'|'muff'}`
    - `AreaPatchSchema {title?, x?, y?, w?, h?, tint?, version}`
    - `PlaceCardsSchema {cards:{channelId, x, y, w?}[] 1..100, area?:NewArea}`
    - `CardPatchSchema {x, y, w?, version}`
    - `HiddenSchema {channelIds:string[] 1..100, hidden:boolean}`
  - Types:
    - `Canvas {id, ownerId, name, visibility, version, createdAt, updatedAt, role}`
    - `CanvasArea {id, canvasId, title, x, y, w, h, tint, version}`
    - `CanvasCardRow {canvasId, channelId, projectId:string|null, x, y, w, version, placedBy, placedAt, ownerLabel}`
  - `areaFor(point:{x:number;y:number}, areas:CanvasArea[]): CanvasArea|null`: the smallest-area region containing the point; ties go to the lowest `id`.
- Produces, as `store.canvases`: `createCanvasStore(db)` returning:
  - `list(humanId):Canvas[]`, which includes shared canvases where the human is a member
  - `get(canvasId, humanId):Canvas|null`, which returns null when there is no access
  - `create(input, ownerId):Canvas`, throwing `CanvasLimitError` after 50
  - `rename(canvasId, name, version, actor)`
  - `remove(canvasId, actor)`
  - `setSharing(canvasId, input, actor)`
  - `members(canvasId):{humanId, role}[]`
  - `areas(canvasId)`, `createArea(canvasId, input, actor)`, `patchArea(canvasId, areaId, patch, actor, {moveCards:boolean})`, `removeArea(canvasId, areaId, version, actor)`
  - `cards(canvasId)`, `placeCards(canvasId, cards:(CanvasCardRow input)[], area:NewArea|undefined, actor)`, `moveCard(canvasId, channelId, patch, actor)`, `removeCard(canvasId, channelId, version, actor)`
  - `hidden(humanId):string[]`, `setHidden(humanId, channelIds, hidden)`
  - Every write throws `CanvasConflictError {current}` on a version mismatch and `CanvasForbiddenError` when the role is too low (view, or a non-owner changing rename, sharing or delete).
  - Each successful write bumps `product_canvases.version` and the item's `version`, and audits `audit.canvas.<verb>`.

- [ ] **Step 1: Write the failing tests.**
  - `canvas.test.ts`:
    - `areaFor` returns the inner of two nested areas
    - `null` outside every area
    - lowest id on equal sizes
    - `PlaceCardsSchema` rejects 101 cards and `w:199`
    - `CanvasSharingSchema` rejects members with `visibility:'private'`
  - `canvases.test.ts` (temp DB as in `projects.test.ts`):
    - **Visibility and limits:** `list` shows a shared canvas to a `view` member and hides a private one from a stranger. The 51st `create` throws `CanvasLimitError`.
    - **Conflicts:** `moveCard` with a stale version throws `CanvasConflictError` whose `current.x` equals the winning write.
    - **Roles:** a `view` member's `moveCard` throws `CanvasForbiddenError`; an `edit` member's `rename` throws it too.
    - **Moving areas:** `patchArea(..., {moveCards:true})` moving an area by (+100,+50) moves only cards whose centre `areaFor` placed in that area. A card in a nested child area moves too; a card outside does not.
    - **Placement:** `placeCards` is idempotent per (canvas, channel) and keeps the original position and `placedBy`. It enforces 500 cards.
    - **Removal:** `remove` cascades areas, cards and members. `setSharing` to `private` deletes members.
    - **Hides:** `setHidden` round-trips and is per human.
    - **Migrations:** the `product_migrations` list ends with `'011_canvases'`.
- [ ] **Step 2: Run them and confirm they fail.**
  - Run: `npm test -- packages/schemas/src/canvas.test.ts packages/db/src/canvases.test.ts`
  - Expected: FAIL (module not found)
- [ ] **Step 3: Write `011_canvases.sql`** in the 001–010 style (TEXT ids, INTEGER ms timestamps, `CHECK` enums, `ON DELETE CASCADE` to `product_canvases`):
  - `product_canvases(id PK, owner_id, name, visibility CHECK IN ('private','shared'), version INTEGER NOT NULL DEFAULT 0, created_at, updated_at)`
  - `product_canvas_members(canvas_id, human_id, role CHECK IN ('edit','view'), PRIMARY KEY(canvas_id,human_id))`
  - `product_canvas_areas(id PK, canvas_id, title, x REAL, y REAL, w REAL, h REAL, tint, version, created_by, created_at, updated_at)`
  - `product_canvas_cards(canvas_id, channel_id, project_id NULL, x REAL, y REAL, w REAL, version, placed_by, placed_at, owner_label TEXT NOT NULL DEFAULT '', PRIMARY KEY(canvas_id,channel_id))`
  - `product_loose_hidden(human_id, channel_id, hidden_at, PRIMARY KEY(human_id,channel_id))`
  - Indexes: `product_canvases_owner`, `product_canvas_members_human`, `product_canvas_areas_canvas`
  - Comment line: engine channels and memberships are never mirrored here.
- [ ] **Step 4: Implement `canvas.ts` and `createCanvasStore`.** Follow `packages/db/src/projects.ts`: inline prepared statements, camelCase aliases, `db.transaction`, and a local `audit()`. Do compare-and-swap with `UPDATE … WHERE …AND version=?` and check `.changes`. Implement `areaFor` once in schemas and import it in the store.
- [ ] **Step 5: Run the tests and confirm they pass.**
  - Run the same command as Step 2, plus `npm test -- packages/db/src/projects.test.ts`
  - Expected: PASS
- [ ] **Step 6: Commit.**
  - `git add packages/db packages/schemas`
  - `git commit -m "feat(canvas): add canvas product tables and store"`

### Task 2: Canvas API — flag, canvases, sharing and hides

**Files:**
- Create: `apps/api/src/canvases.ts`, `apps/api/src/canvases.test.ts`
- Modify:
  - `apps/api/src/app.ts`: add `canvasEnabled?:boolean` to the `createApp` config, defaulting to `process.env.NEST_ENABLE_CANVAS==='1'`. Call `registerCanvasRoutes(app,{store,orgops,enabled})` **before** the `/api/*` proxy (l.96).
  - `.env.example`: add `# NEST_ENABLE_CANVAS=1` next to `NEST_ENABLE_LIVEKIT`

**Interfaces:**
- Consumes: `store.canvases`, the Task 1 schemas, and `orgops.currentHuman` / `humanJson`.
- Produces `registerCanvasRoutes(app:Hono, deps:{store:ProductDb; orgops:OrgOpsClient; enabled:boolean})`. It uses a sub-app with the same middleware as `projects.ts:22-36` (body limit 64 KB, auth, `channels` var, `no-store`). The errors map as follows:
  - Conflict → 409 `{error:'Canvas changed', current}`
  - Forbidden → 403
  - No access → 404
  - Limit → 400
- Routes:
  - `GET /api/canvases/availability` → `{available:boolean}`. It is registered even when the flag is off, and requires auth.
  - `GET /api/canvases` → `Canvas[]`
  - `POST /api/canvases` `NewCanvasSchema` → 201 `Canvas`
  - `PATCH /api/canvases/:id` `CanvasRenameSchema` → `Canvas`
  - `DELETE /api/canvases/:id?version=N` → 204
  - `GET /api/canvases/:id/members` → `{visibility, members:{humanId, username, role}[]}`. Usernames come from `GET /api/humans` with the caller's headers.
  - `PUT /api/canvases/:id/members` `CanvasSharingSchema` → same shape. It is owner only. Every `humanId` must exist in the caller's `/api/humans` list, else 400.
  - `GET /api/canvases/hidden` → `{channelIds:string[]}`
  - `POST /api/canvases/hidden` `HiddenSchema` → `{channelIds}`. It only accepts channel ids present in the caller's `/api/channels` list and silently drops others.
  - When the flag is off, every route except `availability` returns 404, and an `all('/api/canvases/*')` handler returns 404 for unknown paths.
  - Register `availability` and `hidden` before the `/api/canvases/:id` routes, and validate `:id` as a uuid (404 otherwise).

- [ ] **Step 1: Write the failing tests** in `canvases.test.ts`, with a real engine plus Nest app as in `projects.test.ts:18-37`. Make a second human through `POST /api/humans/invite`.
  - **Flag off** (`canvasEnabled:false`): `availability` → `{available:false}`, `GET /api/canvases` → 404.
  - **Auth:** without a cookie → 401.
  - **Lifecycle:** create, then list, then rename with a stale version → 409 with a `current.name`.
  - **Sharing:** the owner shares with the teammate as `view`; the teammate's `GET /api/canvases` lists it with `role:'view'`; the teammate's `PATCH` → 403; the teammate's `PUT …/members` → 403.
  - **Unknown member:** sharing with an unknown `humanId` → 400.
  - **Delete:** delete as owner → 204, then the teammate's `GET /api/canvases/:id/members` → 404.
  - **Hides:** `POST /hidden` with one visible and one foreign channel id stores only the visible one.
  - **Engine untouched:** the engine's `GET /api/channels` response is byte-identical before and after every call in this file.
- [ ] **Step 2: Run them and confirm they fail.**
  - Run: `npm test -- apps/api/src/canvases.test.ts`
  - Expected: FAIL
- [ ] **Step 3: Implement `registerCanvasRoutes`** and the `app.ts` and `.env.example` changes.
- [ ] **Step 4: Run them and confirm they pass.**
  - Run: `npm test -- apps/api/src/canvases.test.ts`
  - Expected: PASS
- [ ] **Step 5: Commit.**
  - `git commit -m "feat(canvas): add flagged canvas and sharing API"`

### Task 3: Canvas API — board, areas and cards

**Files:**
- Modify: `apps/api/src/canvases.ts`
- Create: `apps/api/src/canvas-board.test.ts`

**Interfaces:**
- Produces:
  - **The board:**
    - `GET /api/canvases/:id/board?version=N` → `{unchanged:true}` when the canvas version equals N.
    - Otherwise it returns `CanvasBoard = {canvas:Canvas, areas:CanvasArea[], cards:BoardCard[]}`.
    - `BoardCard = CanvasCardRow-minus-ownerLabel & ({access:'open'; title:string; kind?:string; projectId:string|null; participants:{subscriberType:string;subscriberId:string}[]; archived:boolean; canManage:boolean} | {access:'locked'; ownerLabel:string} | {access:'unavailable'})`. Add `BoardCard` and `CanvasBoard` to `packages/schemas/src/canvas.ts`.
  - **Resolution rule:**
    - A card whose channel is in the caller's `/api/channels?includeArchived=1` list is `open`. Its `title` is the project name when there is a product project for that channel, else the channel name.
    - A missing card the caller placed is `unavailable`.
    - Any other missing card is `locked`.
    - Locked and unavailable cards carry no title, participants, project id or kind.
  - **Areas:**
    - `POST /api/canvases/:id/areas` `NewAreaSchema` → 201 `CanvasArea`
    - `PATCH /api/canvases/:id/areas/:areaId` `AreaPatchSchema` with optional query `moveCards=1` → `{area, cards:CanvasCardRow[]}`. `cards` lists the moved cards.
    - `DELETE /api/canvases/:id/areas/:areaId?version=N` → 204. Cards stay where they are.
  - **Cards:**
    - `POST /api/canvases/:id/cards` `PlaceCardsSchema` → 201 `CanvasBoard`. Each `channelId` must be in the caller's channel list (else 400 naming no titles). The server sets `projectId` from the product projects table and `ownerLabel` from the channel's `ownerHumanId`, resolved through `/api/humans`, falling back to `'a teammate'`.
    - `PATCH /api/canvases/:id/cards/:channelId` `CardPatchSchema` → `CanvasCardRow`
    - `DELETE /api/canvases/:id/cards/:channelId?version=N` → 204

- [ ] **Step 1: Write the failing tests** in `canvas-board.test.ts`, with the real engine. The owner creates channels A (private, owner only) and B (private, owner plus teammate), then places both on a canvas shared `edit` with the teammate.
  - **Locked card:** the teammate's board has B `open` and A `locked` with `ownerLabel:'owner'`. The raw teammate response text does not contain A's name.
  - **Unavailable card:** the teammate creates private channel C, adds the owner, and the owner places C. The teammate then unsubscribes the owner. The owner's board shows C as `unavailable`.
  - **Unchanged board:** `?version=<current>` → `{unchanged:true}`.
  - **Moving an area:** `PATCH area moveCards=1` returns the moved card list, and the board reflects the new positions.
  - **Foreign channel:** placing a channel the caller can't see → 400.
  - **Version conflict:** a teammate's stale `PATCH card` → 409 with `current`.
  - **View role:** a `view`-role teammate's `POST cards` → 403.
  - **Engine untouched:** engine `/api/events?limit=1000` has the same count before and after all layout calls.
- [ ] **Step 2: Run them and confirm they fail.**
  - Run: `npm test -- apps/api/src/canvas-board.test.ts`
  - Expected: FAIL
- [ ] **Step 3: Implement the board resolution** as a pure, exported `resolveBoard(rows, areas, canvas, channels, projectsByChannel, viewerId): CanvasBoard` in `canvases.ts`, plus the routes.
- [ ] **Step 4: Run them and confirm they pass.**
  - Run: `npm test -- apps/api/src/canvas-board.test.ts apps/api/src/canvases.test.ts`
  - Expected: PASS
- [ ] **Step 5: Commit.**
  - `git commit -m "feat(canvas): serve canvas boards with engine-resolved card access"`

### Task 4: UI entry, routing, board store and browser harness

**Files:**
- Create:
  - `apps/user-ui/src/canvas/api.ts`, `board-store.ts`, `board-store.test.ts`, `CanvasView.tsx` (shell only), `canvas.css`
  - `apps/user-ui/public/design/canvas.svg`
  - `tests/browser/canvas/run.ts`, `tests/browser/canvas/entry.ts`
- Modify:
  - `apps/user-ui/src/App.tsx`:
    - view union (329) gains `'canvas'`
    - `loadShell` view list (781–782) and `handlePopState` (1136)
    - a `selectCanvas(canvasId:string|null, opts?:{replace?:boolean})` helper modelled on `selectCommunity` (584)
    - the nav button after Dashboard (1754–1759), rendered only when availability is true
    - the render ternary (1850–1855)
  - `tests/browser/support/chat-harness.ts`: `ChatTestOptions.canvas?:boolean` → `createApp({…, canvasEnabled:true})`
  - `package.json`: `"test:ui:canvas": "node --import tsx tests/browser/canvas/run.ts"`

**Interfaces:**
- URL: `?view=canvas&canvas=<id>[&chat=<channelId>&mode=focus|split]`. With no `canvas` param, the view opens the person's most recently updated canvas. When they have none, it offers `Create your first canvas`.
- `canvas/api.ts` exports thin wrappers over `apiJson` for every Task 2–3 route:
  - `canvasAvailability()`, `listCanvases()`, `createCanvas(name)`, `renameCanvas`, `deleteCanvas`
  - `getMembers`, `putMembers`, `getBoard(id, version?)`
  - `createArea`, `patchArea(id, areaId, patch, moveCards)`, `deleteArea`
  - `placeCards`, `moveCard`, `removeCard`, `getHidden`, `setHidden`
  - On HTTP 409 they throw `CanvasConflict {current}`.
- `board-store.ts` exports `createBoardStore({api, now, intervalMs:5000})`:
  - It holds `{board, status:'loading'|'ready'|'gone'|'error', notice:string|null}` with `subscribe` / `snapshot` for `useSyncExternalStore`.
  - Methods:
    - `open(canvasId)` and `refresh()`, which pass the version so an unchanged board stays unchanged
    - `apply(op)`, which updates optimistically and then confirms
    - `start()` and `stop()`, which run polling only while `document.visibilityState==='visible'` and also refresh on window focus
  - On a conflict it replaces the board from a fresh `getBoard` and sets `notice:'Canvas changed. Refreshed.'`. On 404 it sets `status:'gone'`.
- `CanvasView` props: `{canvasId:string|null; humanId:string; username:string; channels:Channel[]; projects:Project[]; agents:Agent[]; humans:Human[]; onSelectCanvas(id:string|null):void; onMenu():void; chat:ReactNode; chatChannelId:string|null; chatMode:'focus'|'split'|null; onOpenChat(channelId:string, mode:'focus'|'split'):void; onCloseChat():void; onOpenRegular(channelId:string):void; live:CanvasLive}`. `CanvasLive` is defined in Task 6; until then, pass a stub in this task.

- [ ] **Step 1: Write the failing tests.**
  - `board-store.test.ts`, with a fake `api` object; this is UI state, not the ownership boundary:
    - an optimistic `moveCard` updates `snapshot().board` before the promise resolves
    - a rejected `CanvasConflict` reloads and sets the notice text above
    - 404 sets `gone`
    - `refresh()` with an unchanged response keeps the same `board` object identity
    - polling stops when `visibilityState` is `'hidden'`
  - `tests/browser/canvas/entry.ts`, using `runChatTest(…, {canvas:true})`:
    - the `Canvas` nav button is visible
    - clicking it shows `Create your first canvas`
    - creating `Launch` puts `?view=canvas&canvas=` in the URL
    - reloading keeps the canvas open
    - Back returns to the Dashboard
    - with `{canvas:false}`, no `Canvas` nav button exists
- [ ] **Step 2: Run them and confirm they fail.**
  - Run: `npm test -- apps/user-ui/src/canvas/board-store.test.ts`
  - Expected: FAIL
  - Browser: `npm run test:ui:canvas` fails in CI or a bounded runner
- [ ] **Step 3: Implement the store, the API helpers, the App routing and nav, and the shell**:
  - the top bar shows the canvas name, a `CanvasSwitcher` placeholder and a theme toggle
  - an empty surface
  - the harness option
- [ ] **Step 4: Run them and confirm they pass.**
  - Run the same commands as Step 2
  - Expected: PASS
- [ ] **Step 5: Commit.**
  - `git commit -m "feat(canvas): add flagged canvas view, routing and board sync"`

### Task 5: Surface — pan, zoom, culling, areas and card moves

**Files:**
- Create: `apps/user-ui/src/canvas/geometry.ts`, `geometry.test.ts`, `Surface.tsx`, `Area.tsx`, `tests/browser/canvas/surface.ts`
- Modify: `CanvasView.tsx`, `canvas.css`, `tests/browser/canvas/run.ts`

**Interfaces:**
- `geometry.ts`:
  - `type View={x:number;y:number;zoom:number}`
  - `zoomAt(view, factor, screenPoint):View` keeps the canvas point under the cursor fixed and clamps zoom to 0.2–2
  - `fit(rects:Rect[], viewport:{w:number;h:number}, pad=48):View`
  - `toCanvas(view, screenPoint)` and `toScreen(view, canvasPoint)`
  - `visible<T extends Rect>(items:T[], view, viewport, margin=200):T[]`
  - `isCompact(view):boolean` is true when zoom < 0.5
- Card height is not stored. `Surface` measures it with a `ResizeObserver` and uses `w × measured h`, defaulting to 160, for culling and centres.
- Gestures:
  - **Panning:** drag on empty canvas, or space+drag.
  - **Zooming:** wheel zooms with Ctrl or a trackpad pinch (`ctrlKey` wheel), and a plain wheel pans. Two-pointer touch pinches and pans.
  - **Buttons:** `+`, `−` and `Fit` in a bottom-right control group.
  - **Saved view:** stored per human and canvas in `localStorage` key `nest-canvas-view:<humanId>:<canvasId>`, wrapped in try/catch.
- Areas:
  - **Drawing:** the `Area` tool button, then drag on empty canvas, calls `createArea` with title `New area`.
  - **Editing:** double-click the title to rename inline. Drag the title bar to move it, calling `patchArea(…, moveCards:true)`; the cards move with it. A corner handle resizes it.
  - **Deleting:** a menu item on the area.
  - **Look:** rounded nest shapes tinted with a character colour, and `aria-label="Area <title>"`.
  - **Compact zoom:** below 0.5 zoom an area shows a summary line `N need you · M moving`. These counts come from Task 6; this task leaves the slot in place.
- Cards on the surface:
  - **Moving:** drag calls `moveCard`. Area membership is derived with `areaFor` on the card centre; nothing else is stored.
  - **View role:** the area and card drag handles are absent and the tool buttons are disabled.

- [ ] **Step 1: Write the failing tests.**
  - `geometry.test.ts`:
    - `zoomAt` keeps `toCanvas(view, p)` equal before and after for p=(400,300)
    - zoom clamps at 0.2 and 2
    - `fit` of two rects contains both inside the viewport
    - `visible` drops an item 1000 px off-screen and keeps one 150 px off-screen
  - `surface.ts` browser test at 1440×900:
    - draw an area, rename it to `Launch content` with a double-click, reload, and it is still there
    - drag the area 200 px right, and the card inside moves by 200 px
    - `Fit` brings all cards into view
    - with a second editor session, move the same card from both, and the later one sees `Canvas changed. Refreshed.`
    - a tablet viewport (1024×768, `hasTouch`) pinch with two touch pointers changes the zoom label
- [ ] **Step 2: Run them and confirm they fail.**
  - Run: `npm test -- apps/user-ui/src/canvas/geometry.test.ts`
  - Expected: FAIL
- [ ] **Step 3: Implement `geometry.ts`, `Surface`, `Area`, the controls and the woven-twig background.**
  - The twig texture is an inline SVG pattern in `canvas.css` with light and dark variants. There is no dot grid.
  - Transforms go on one container (`transform: translate() scale()`). Only items in `visible(...)` mount.
- [ ] **Step 4: Run them and confirm they pass.**
  - Expected: PASS
- [ ] **Step 5: Commit.**
  - `git commit -m "feat(canvas): add canvas surface, areas and card moves"`

### Task 6: Live cards — status, artifacts, needs you, quiet and Nudge

**Files:**
- Create: `apps/user-ui/src/canvas/pulse.ts`, `pulse.test.ts`, `live.ts`, `Card.tsx`, `tests/browser/canvas/cards.ts`
- Modify: `App.tsx` (`handleIncomingRealtimeEvent` at 873 also calls `canvasLive.ingest(event)` while `view==='canvas'`), `Surface.tsx`, `Area.tsx`

**Interfaces:**
- `pulse.ts`:
  - `QUIET_AFTER_MS = 20*60_000`
  - `type AgentPulse={name:string; state:'working'|'quiet'|'interrupted'|'done'|'failed'|'idle'|'unavailable'; since:number; quietMinutes?:number}`
  - `type CardPulse={agents:AgentPulse[]; lastActivityAt:number|null; artifacts:{fileId:string;name:string;mime?:string}[]; needsYou:{kind:'mention';id:string;at:number}[]}`
  - `cardPulse(input:{events:EventRow[]; agents:Agent[]; starts:AgentStarts; mentions:MentionNotification[]; cards:{channelId:string; agentNames:string[]}[]; now:number}): Map<string,CardPulse>`
- `pulse.ts` rules:
  - **Active turns:** group events by `channelId` and call the existing `activeTurns(events, agents, starts)` from `chat/working.ts` per channel. Do not reimplement it.
    - An active turn with `interrupted` maps to `interrupted`.
    - Otherwise the agent's latest signal in that channel is the newest event with `source==='agent:'+name`, or the turn `since`. If that signal is older than `QUIET_AFTER_MS`, the state is `quiet` with `quietMinutes=floor((now-signal)/60000)`. Otherwise it is `working`.
  - **No active turn:** the latest `agent.turn.completed` maps to `done`, the latest `agent.turn.failed` maps to `failed`, and with neither the state is `idle`.
  - **Unavailable:** a STOPPED or CRASHED agent that is not mid-turn maps to `unavailable`.
  - **Agents listed:** each card's `agentNames` (the AGENT participants from the board or channel list), in roster order.
  - **Card fields:**
    - `lastActivityAt` is the newest `message.created`.
    - `artifacts` are the attachments of `message.created` payloads, newest first, deduplicated by `fileId`, at most 6.
    - `needsYou` lists unread mentions for that channel.
  - Elapsed time alone never produces `done`.
- `live.ts`: `createCanvasLive({fetchJson, now})` returning `CanvasLive`:
  - `{subscribe, snapshot():Map<string,CardPulse>, setCards(cards:{channelId:string; agentNames:string[]}[]), ingest(event:EventRow), refresh()}`. It covers both board cards and loose chats.
  - **Seeding:** it seeds with `GET /api/events?typePrefix=agent.turn.&order=desc&limit=1000`, `GET /api/events?type=message.created&order=desc&limit=500`, `fetchAgentStarts(fetchJson)`, `GET /api/agents` and `GET /api/mentions`.
  - **Refreshing:** it refreshes every 30 s while visible and on focus. `ingest` coalesces recomputation to one `requestAnimationFrame`.
- `Card.tsx`:
  - **Contents:** title, human initials and `AgentAvatar` faces with a state dot, a status line, an artifact strip of file chips that open the existing file link, relative last activity, and a needs-you badge.
  - **Status line examples:** `Pom is working`, `Pom quiet for 25 min` with a `Nudge` button, `Pom stopped unexpectedly`, `Done`.
  - **Compact zoom:** big title, faces and a needs-you or quiet marker only.
  - **Locked card:** `Private chat`, plus `Owner: <ownerLabel>`.
  - **Unavailable card:** `This chat is no longer available` with `Remove`.
  - **Nudge:** `POST /api/messages` with `{id:randomUUID(), channelId, text:'@<agent> are you still on this? Please post a short status update.', mentions:[{kind:'AGENT',name,start:0,end:name.length+1}], attachments:[], targetAgentName:name}`. It is disabled while the request is in flight.
- `Area.tsx` compact summary counts cards in the area whose pulse has `needsYou.length>0` (need you) and cards with any `working` agent (moving).

- [ ] **Step 1: Write the failing tests.**
  - `pulse.test.ts`, with fixtures built from real event shapes (`agent.turn.started` with `payload.triggerEventId`, `source:'agent:Pom'`):
    - **Working:** started 5 min ago gives `working`.
    - **Quiet:** started 25 min ago with no later signal, while the agent heartbeats, gives `quiet` with `quietMinutes:25`, and never `done`.
    - **Restart:** the same, but the agent restarted after the start (`starts.Pom` > since), gives `interrupted`.
    - **Endings:** a `completed` ending gives `done`; `failed` gives `failed`.
    - **Stopped:** a STOPPED agent with no turn gives `unavailable`.
    - **Artifacts:** attachments are deduplicated across two messages and capped at 6.
    - **Mentions:** an unread mention appears in `needsYou`, and a read one doesn't.
    - **Isolation:** events from a channel not in `cards` are ignored.
  - `cards.ts` browser test, using the harness `emit()` against the real engine:
    - **Working:** emit `agent.turn.started` for Pip in the project channel, and the card shows `Pip is working` without a reload.
    - **Quiet:** an engine-DB fixture inserts a started turn 25 min old, and the card shows `Pip quiet for 25 min`.
    - **Nudge:** clicking `Nudge` creates a `message.created` in the engine with `targetAgentName:'Pip'`. Assert it through `GET /api/events`.
    - **Artifacts:** a message with an uploaded file shows the file chip on the card.
    - **Compact zoom:** at zoom 0.4 the status line is hidden and the title is shown.
- [ ] **Step 2: Run them and confirm they fail.**
  - Run: `npm test -- apps/user-ui/src/canvas/pulse.test.ts`
  - Expected: FAIL
- [ ] **Step 3: Implement `pulse.ts`, `live.ts`, `Card.tsx`, the App fan-out and the area summary.**
- [ ] **Step 4: Run them and confirm they pass.**
  - Expected: PASS
- [ ] **Step 5: Commit.**
  - `git commit -m "feat(canvas): show live chat state, artifacts and quiet nudges on cards"`

### Task 7: Loose chats pile and bottom box

**Files:**
- Create: `apps/user-ui/src/canvas/loose.ts`, `loose.test.ts`, `LoosePile.tsx`, `tests/browser/canvas/pile.ts`
- Modify:
  - `apps/user-ui/src/ProjectStart.tsx`: export `StartChat` and give it a `variant?:'page'|'dock'` prop. `dock` hides the intro and Cancel, uses one row of input with an `Attach files` icon and `Send`, and calls `onCreated` without navigating.
  - `CanvasView.tsx`

**Interfaces:**
- `loose.ts`:
  - `type LooseChat={channelId:string; projectId:string|null; title:string; participants:ChannelParticipant[]; lastActivityAt:number|null; needsYou:boolean; agents:string[]}`
  - `looseChats(input:{channels:Channel[]; projects:Project[]; boardChannelIds:Set<string>; hidden:Set<string>; username:string; userId:string; pulses:Map<string,CardPulse>; showHidden:boolean}):LooseChat[]` keeps chats where the person is a HUMAN participant or the owner, not archived, not on this board, and not hidden unless `showHidden`. It sorts newest activity first, falling back to title.
  - `filterLoose(items, {query:string; needsYou:boolean; agent:string|null; age:'any'|'today'|'week'|'older'}, now)` matches the query case-insensitively against title and participant ids.
- `LoosePile`:
  - **Layout:** a collapsible right-side panel `aria-label="Loose chats"` with a count badge, search, and filter chips (`Needs you`, an agent select, an age select).
  - **List:** a virtualised list that renders only visible rows: fixed 56 px rows, windowed by scroll offset, with no library.
  - **Selection:** row checkboxes, and Shift-click selects a range.
  - **Bulk actions:**
    - `Place on canvas` places cards in a grid of 3 columns at the viewport centre, spaced 300×200.
    - `New area from these` places the cards the same way inside a new area titled `New area` that wraps them with 48 px padding, in one `placeCards` call.
    - `Hide` calls `setHidden(..., true)`.
  - **Drag:** dragging a row onto the surface places one card at the drop point.
  - **Hidden toggle:** `Show hidden` with `Unhide`.
- **Bottom box:** the `StartChat variant="dock"` is centred at the bottom of the surface. After it is created, the new chat shows in the pile (refresh channels through the App's existing `refreshChannels`) and it is **not** placed.

- [ ] **Step 1: Write the failing tests.**
  - `loose.test.ts`:
    - excludes board cards, hidden chats unless `showHidden`, archived chats, and chats the person is not in
    - sorts by `lastActivityAt` desc
    - `filterLoose` with `age:'today'` keeps only chats from the last 24 h
    - 250 synthetic chats filter in under 10 ms (assert `performance.now()` delta < 10)
  - `pile.ts` browser test:
    - with 220 seeded project chats, the pile shows `220`, and fewer than 40 row elements are in the DOM
    - searching `invoice` narrows the list
    - selecting 3 and clicking `New area from these` creates one area with 3 cards
    - `Hide` removes a row, and reloading keeps it hidden
    - the engine channel is not archived; assert `archivedAt` is null via `/api/channels?includeArchived=1`
    - typing `Draft the launch email` in the bottom box and pressing Send creates a project chat (it appears in the pile and the sidebar) and no card
- [ ] **Step 2: Run them and confirm they fail.**
  - Run: `npm test -- apps/user-ui/src/canvas/loose.test.ts`
  - Expected: FAIL
- [ ] **Step 3: Implement `loose.ts`, `LoosePile`, the `StartChat` variant and the wiring.** The existing Projects page keeps `variant="page"` behaviour unchanged.
- [ ] **Step 4: Run them and confirm they pass**, plus `npm run test:ui:projects` in CI.
  - Expected: PASS
- [ ] **Step 5: Commit.**
  - `git commit -m "feat(canvas): add loose chats pile and canvas bottom box"`

### Task 8: Open a chat in place, in split screen or in the regular view

**Files:**
- Create: `tests/browser/canvas/open-chat.ts`
- Modify: `App.tsx`, `CanvasView.tsx`, `canvas.css`

**Interfaces:**
- Consumes App's existing `chatWorkspace` JSX (1615–1688) as `CanvasView`'s `chat` prop. There is one session `ChannelEventsCore`, so only one chat is open at a time.
- New App helper: `openCanvasChat(channelId:string|null, mode:'focus'|'split'|null, opts?:{replace?:boolean})`. It sets the active channel exactly as `selectChannel` does (`core.switchTo`, mark seen) but keeps `view==='canvas'`, and writes `chat` and `mode` to the URL.
- `chatVisibleRef` / `activeTimelineEvent` (`App.tsx:882-886`) must treat `view==='canvas' && chatMode!==null` as visible, so realtime messages reach the open chat.
- Opening a card:
  - A click on the card body (not on a handle or face) opens `focus`: the chat is enlarged over the canvas with a dimmed backdrop. Esc or `Close` closes it.
  - The header holds `Split screen`, `Open in the regular chat view` (`selectChannel(id)`) and `Close`.
  - `split` puts the canvas left (min 40%) and the chat right, with a draggable divider whose width is stored in localStorage `nest-canvas-split`.
  - The canvas stays interactive in split mode.
  - Locked and unavailable cards don't open.
- `WorkspaceTopbar` is not shown inside the canvas chat. It is already conditional on `view==='workspace'`.

- [ ] **Step 1: Write the failing browser test `open-chat.ts`.**
  - **Focus:** clicking the card opens the chat with textbox `Message`. Sending `Hello from canvas` makes the message appear in the thread, and the URL has `chat=<id>&mode=focus`.
  - **Reload:** after a reload the same chat is open.
  - **Split:** `Split screen` shows both `.canvas-surface` and the thread, and dragging a card still works.
  - **Realtime:** an agent message emitted through the harness appears in the open chat without a reload.
  - **Regular view:** `Open in the regular chat view` navigates to `?channel=<id>`, and Back returns to the canvas with the chat closed or open as before.
  - **Escape:** Esc closes the focus chat.
- [ ] **Step 2: Run it and confirm it fails.**
  - Run: `npm run test:ui:canvas` in CI or a bounded runner
  - Expected: FAIL
- [ ] **Step 3: Implement `openCanvasChat`, the visibility change, the focus and split layouts, and the URL and popstate handling.**
- [ ] **Step 4: Run it and confirm it passes.** Also run `npm run test:ui:chat-next` to prove the regular chat is unchanged.
  - Expected: PASS
- [ ] **Step 5: Commit.**
  - `git commit -m "feat(canvas): open chats in place or in split screen"`

### Task 9: Agents tray — drag to invite, drag off to remove

**Files:**
- Create: `apps/user-ui/src/chat-members.ts`, `chat-members.test.ts`, `apps/user-ui/src/canvas/AgentTray.tsx`, `tests/browser/canvas/agents.ts`
- Modify:
  - `App.tsx`: `inviteMention` (548) and `handleRemoveParticipant` (1425) call the new helpers
  - `Card.tsx`, `CanvasView.tsx`

**Interfaces:**
- `chat-members.ts`:
  - `addChatMember({channelId, projectId, member:{subscriberType:'AGENT'|'HUMAN';subscriberId:string}, fetch:typeof apiFetch, fetchJson:typeof apiJson}):Promise<Channel[]>`
    - It posts to `/api/projects/:projectId/members` when `projectId` is set, else to `/api/channels/:id/subscribe`.
    - It ignores a lost response, then re-reads `/api/channels?includeArchived=1`. It throws `Error('Invitation unconfirmed')` unless the member is present. It returns the fresh list.
  - `removeChatMember({channelId, member, fetch, fetchJson}):Promise<Channel[]>` calls `/api/channels/:id/unsubscribe` and confirms the member is absent.
- `AgentTray`:
  - **Pinned tray:** a bottom-left strip of up to 8 agents. The selected card's suggestions come first: agents in the same area's cards who are not in this card. The rest are the person's own agents, ordered by name. It ends with `All agents (N)`.
  - **All agents picker:** a searchable dialog with filters `Yours` and `Team`, and an area select that limits it to agents present in that area's cards.
  - **Drag to invite:** dragging a face onto an `open` card where `canManage` is true calls `addChatMember`.
  - **Drag to remove:** dragging a face off a card more than 80 px outside its bounds calls `removeChatMember` and shows `Removed <name>` with `Undo`, which re-adds them.
  - **Can't manage:** faces are not draggable, and dropping on such a card shows `You can't add people to this chat`.

- [ ] **Step 1: Write the failing tests.**
  - `chat-members.test.ts` (vitest against the real engine plus Nest app through a `fetch` adapter onto `product.app.request`, as in `projects.test.ts`):
    - adding an agent to a plain channel and to a project channel both return a list that includes it
    - removing returns a list without it
    - adding to a channel the human can't manage rejects
  - `agents.ts` browser test:
    - dragging `Pip` from the tray onto a card adds the Pip face, and engine `/api/channels` shows the AGENT participant
    - dragging the face off removes it, and `Undo` restores it
    - `All agents` search `pi` lists Pip
    - with 30 seeded agents the picker shows 30 and the tray shows at most 8 faces
- [ ] **Step 2: Run them and confirm they fail.**
  - Run: `npm test -- apps/user-ui/src/chat-members.test.ts`
  - Expected: FAIL
- [ ] **Step 3: Implement the helpers.** Switch App's two handlers to them with no behaviour change, then build the tray, the picker and the drag handling.
- [ ] **Step 4: Run them and confirm they pass**, plus `npm run test:ui:projects` in CI for the App refactor.
  - Expected: PASS
- [ ] **Step 5: Commit.**
  - `git commit -m "feat(canvas): invite and remove agents by dragging on cards"`

### Task 10: Canvas switcher and sharing

**Files:**
- Create: `apps/user-ui/src/canvas/CanvasSwitcher.tsx`, `ShareDialog.tsx`, `tests/browser/canvas/sharing.ts`
- Modify: `CanvasView.tsx`

**Interfaces:**
- `CanvasSwitcher`:
  - **Menu:** a top-bar menu listing `listCanvases()` under `Yours` and `Shared with you`, each with a role badge `Can view` / `Can edit`.
  - **Actions:** `New canvas` prompts for a name. `Rename` and `Delete canvas…` are owner only; Delete asks for confirmation and states that chats are not deleted.
- `ShareDialog` (owner only; others see `Shared by <owner>`):
  - **Visibility:** a `Private` / `Shared with chosen people` radio.
  - **People:** a person picker over App's `humans`, each with an `Can edit` / `Can view` select. `Save` calls `putMembers`.
  - **Copy:** `Sharing covers the layout and areas. Each chat keeps its own access.`
- **Access lost:** when the board store reports `gone`, the view shows `This canvas is no longer shared with you` and opens the switcher.

- [ ] **Step 1: Write the failing browser test `sharing.ts`**, with two sessions via `loginAs`.
  - **View access:** the owner shares `Launch` as `Can view`. The teammate sees it under `Shared with you`. Their cards have no drag handles, and tool buttons are disabled.
  - **Locked card:** a card for a chat the teammate isn't in shows `Private chat` and `Owner: demo-owner`, and its title text is absent from the page.
  - **Edit access:** the owner switches the teammate to `Can edit`. Within about 6 s (poll) the teammate can drag a card, and the owner sees the move after the next poll.
  - **Unsharing:** the owner sets `Private`. The teammate sees `This canvas is no longer shared with you`.
  - **Delete:** the owner deletes the canvas, and the chats still exist in the sidebar.
- [ ] **Step 2: Run it and confirm it fails.**
  - Expected: FAIL
- [ ] **Step 3: Implement the switcher, the share dialog and the gone state.**
- [ ] **Step 4: Run it and confirm it passes.**
  - Expected: PASS
- [ ] **Step 5: Commit.**
  - `git commit -m "feat(canvas): switch, share and delete canvases"`

### Task 11: Needs you and search

**Files:**
- Create: `apps/user-ui/src/canvas/search.ts`, `search.test.ts`, `NeedsYou.tsx`, `CanvasSearch.tsx`, `tests/browser/canvas/find.ts`
- Modify: `CanvasView.tsx`

**Interfaces:**
- `NeedsYou`:
  - **List:** a top-bar button `Needs you (N)` opening a list of unread mentions on any visible chat, from `CardPulse.needsYou` plus loose chats. It also includes project tasks with status `needs_review` from `GET /api/projects/dashboard` `reviews`, mapped to a chat through the `projects` prop (`projectId` → `channelId`). Each item shows the chat title, the sender or task and the age.
  - **Jump-to:** a chat on this canvas is centred (animated `fit` of its rect, zoom ≥ 0.8) and opened in `focus`. Otherwise the chat opens in `focus` and the pile highlights it.
- `search.ts`:
  - `type SearchItem={kind:'canvas'|'card'|'loose'|'area'; id:string; label:string; detail:string}`
  - `searchIndex({canvases, board, loose}):SearchItem[]` excludes locked and unavailable cards.
  - `rank(items, query, limit=20)`: prefix matches beat word-start matches, which beat substring matches. Ties keep kind order card, area, loose, canvas.
- `CanvasSearch`:
  - **Opening:** a Ctrl/Cmd+K dialog `aria-label="Search the canvas"` with grouped results under `On this canvas`, `Areas`, `Chats elsewhere` and `Canvases`.
  - **Keyboard:** arrow keys navigate and Enter acts.
  - **Actions:** a card centres and opens, an area fits, a loose chat opens focus, and a canvas switches.
  - **Text inputs:** the shortcut is ignored when focus is in a textarea or input other than its own.

- [ ] **Step 1: Write the failing tests.**
  - `search.test.ts`:
    - ranking order for the query `lau` over `Launch`, `Q3 launch plan`, `Blau`
    - locked cards excluded
    - an empty query returns `[]`
  - `find.ts` browser test:
    - a mention of the owner emitted in a placed chat makes `Needs you (1)` appear
    - clicking the item opens that chat
    - Cmd/Ctrl+K and `invoice` lists the loose chat under `Chats elsewhere`, and Enter opens it
    - the shortcut does nothing while typing in the composer
- [ ] **Step 2: Run them and confirm they fail.**
  - Run: `npm test -- apps/user-ui/src/canvas/search.test.ts`
  - Expected: FAIL
- [ ] **Step 3: Implement `search.ts`, `NeedsYou` and `CanvasSearch`.**
- [ ] **Step 4: Run them and confirm they pass.**
  - Expected: PASS
- [ ] **Step 5: Commit.**
  - `git commit -m "feat(canvas): add needs-you list and canvas search"`

### Task 12: Phone fallback, dark theme, scale check, CI and docs

**Files:**
- Create: `apps/user-ui/src/canvas/PhoneList.tsx`, `tests/browser/canvas/devices.ts`
- Modify:
  - `CanvasView.tsx` (`matchMedia('(max-width: 760px)')`), `canvas.css`
  - `.github/workflows/product.yml` (add `- run: npm run test:ui:canvas` after `test:ui:projects`, l.24–29)
  - `docs/SPEC.md`: a new `## Switchyard canvas (Phase 1)` section covering ownership, routes, flag, tables and the access rule
  - `docs/SPEC.md` `## Product SQLite schema`: list the 011 tables
  - `docs/ROADMAP.md`: an entry `## Switchyard canvas — Phase 1 implemented for review` linking the spec and this plan

**Interfaces:**
- `PhoneList` at ≤ 760 px replaces the free surface. It has three segments:
  - `Areas`: each area expands to its chats
  - `Needs you`
  - `Loose chats`
- Tapping a chat opens it in `focus` full screen. The bottom box stays. There is no surface, tray or drag. The `.sidebar-mobile-toggle` Menu button works as in other views.
- Dark theme uses `:root[data-theme="dark"]` brand tokens only. The twig pattern has a dark variant.

- [ ] **Step 1: Write the failing browser test `devices.ts`.**
  - **Phone (390×844):** shows the `Areas`, `Needs you` and `Loose chats` segments and no `.canvas-surface`. Tapping a chat opens the thread, and the Menu button opens the sidebar.
  - **Tablet (1024×768, touch):** the surface renders, and a pinch zooms.
  - **Dark:** `colorScheme:'dark'` keeps the card text contrast at or above 4.5:1. Compute it from computed styles in `page.evaluate`.
  - **Scale:**
    - with 150 placed cards across 6 areas and 30 agents, at Fit, fewer than 60 `.canvas-card` elements are mounted
    - a scripted 2 s pan averages ≥ 30 fps, measured with `requestAnimationFrame` timestamps in the page
    - pressing `Fit` keeps every area visible
  - **Reload:** restores view position (zoom label and a known card's screen position within 2 px) and the open chat.
- [ ] **Step 2: Run it and confirm it fails.**
  - Expected: FAIL
- [ ] **Step 3: Implement `PhoneList`, the dark variants, the CI line and the docs.**
- [ ] **Step 4: Run the full checks in CI** with `npm test`, `npm run lint`, `npm run build`, `npm run test:ui:canvas`, `npm run test:ui:projects`, `npm run test:ui:chat-next` and `npm run test:engine`.
  - Expected: all green. Record the run URL for the PR.
- [ ] **Step 5: Commit.**
  - `git commit -m "feat(canvas): add phone list, dark theme and canvas CI suite"`

---

## Self-review notes

- **Spec coverage (Phase 1 scope list → task):**

  | Spec item | Task |
  |---|---|
  | Canvases: basics | 2, 10 |
  | Canvases: sharing | 2, 10 |
  | Canvases: sync and versions | 1, 4, 5 |
  | Areas: draw, rename, move, resize | 5 |
  | Areas from the pile | 7 |
  | Cards: what they show | 3, 6 |
  | Cards: moving and area by position | 5 |
  | Loose pile | 7 |
  | Bottom box | 7 |
  | Opening a chat | 8 |
  | Needs you | 11 |
  | Quiet and Nudge | 6 |
  | Agents: invite, remove, tray, picker | 9 |
  | Search | 11 |
  | Zoom, theme, input | 5, 12 |
  | Phones | 12 |
  | Locked cards | 3, 10 |
  | Data tables | 1 |
  | API | 2, 3 |
  | Acceptance: scale | 7, 12 |
  | Acceptance: reload | 4, 8, 12 |
  | Acceptance: sharing | 3, 10 |
  | Acceptance: quiet | 6 |
  | Acceptance: engine untouched | 2, 3, 7 |
  | Acceptance: boundary tests | 1–3, 9 |
  | Acceptance: CI devices | 12 |
  | Flag | 2, 4 |
  | SPEC and ROADMAP | 12 |

- **Decisions this plan makes inside the spec's "left to the builder" list:**
  - plain DOM rendering
  - a 5 s sync interval
  - a 20 min quiet threshold
  - the loose list derived in the browser from the channels App already loads; only hides are stored in the API
  - live state computed in the browser by reusing `activeTurns`
  - one open chat at a time, reusing the session chat core
  - Needs you limited to unread mentions and project reviews; the other spec sources (approvals, picks, missed runs) arrive with Phases 3–4
- **Not in this phase (spec):** links, forks, context, schedules, app usage, setup and sandboxes.
