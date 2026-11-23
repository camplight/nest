# Agent drop and file viewer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox syntax.

**Goal:** Start a chat by dropping a tray agent on empty canvas, and open/play files in an in-app viewer.

**Architecture:** Pure helpers (`file-viewer.ts`, `invite-label.ts`, a members helper) carry the decisions and are
unit-tested; React components (`FileViewer.tsx`, `InlineAudio`) and wiring in `FileTile`, `Card`, `Area`,
`ContextPanel`, `PhoneList`, `chat/attachments-view.tsx`, `Surface.tsx` and `CanvasView.tsx` stay thin.

**Tech Stack:** React 18, Vitest (node env, `renderToStaticMarkup`), Radix dialog (`chat/ui/dialog.tsx`).

**Spec:** docs/superpowers/specs/2026-11-20-agent-drop-and-file-viewer-design.md

## Global Constraints
- npm only; never edit `vendor/orgops`; no engine change; no builds; do not start/stop dev servers; do not touch
  `.nest-product/` or `.nest-data/`.
- Exact copy: `Start a chat with {agent}`, `Start a chat with {agent} in {area title}`,
  `Could not start a chat with {agent}. Try again.`, `Too large to preview here.`,
  `Could not open this file. Download it instead.`, `No preview for this file type.`, button `Download`.
- Viewer size cap: 25 MB (`VIEWER_MAX_BYTES = 25 * 1024 * 1024`). CSV table: 200 rows, 30 columns.
- HTML and SVG are never rendered; text is shown as text nodes only; object URLs come only from an allowlist of
  types and are revoked on close/unmount.
- Keep `docs/SPEC.md` in sync. Conventional commits, NO AI attribution lines. Never push.

## Review Focus
- A modified click (Ctrl/Cmd/Shift/Alt, middle) on a tile must still follow the link (new tab / download).
- A file whose MIME type is missing or `application/octet-stream` must be classified by extension.
- An agent dropped on a card (open or locked) must behave exactly as before — no new chat.
- A view-role person or the phone list must not be able to start a chat by dropping.
- Closing the viewer while a fetch is in flight must not leak an object URL or set state after unmount.

---

### Task 1: File viewer

**Files:**
- Create: `apps/user-ui/src/canvas/file-viewer.ts`, `apps/user-ui/src/canvas/file-viewer.test.ts`,
  `apps/user-ui/src/canvas/FileViewer.tsx`, `apps/user-ui/src/canvas/FileViewer.test.tsx`
- Modify: `apps/user-ui/src/canvas/FileTile.tsx` (+test), `apps/user-ui/src/canvas/Card.tsx`,
  `apps/user-ui/src/canvas/Area.tsx`, `apps/user-ui/src/canvas/ContextPanel.tsx`, `apps/user-ui/src/canvas/PhoneList.tsx`,
  `apps/user-ui/src/chat/attachments-view.tsx`, `apps/user-ui/src/canvas/file-tile.css` or `canvas.css`, `docs/SPEC.md`

**Interfaces (produces):**
- `export type ViewerKind = 'image' | 'audio' | 'video' | 'pdf' | 'text' | 'table' | 'none'`
- `export function viewerKind(mime: string | undefined, name: string): ViewerKind` — MIME first (ignoring
  `application/octet-stream` and empty), else extension. Raster images: png jpeg/jpg gif webp avif. Audio: `audio/*`,
  .mp3 .m4a .aac .ogg .oga .opus .wav .flac, and .webm when mime is audio/webm. Video: `video/*`, .mp4 .mov .m4v and
  .webm otherwise. PDF: application/pdf, .pdf. Text: text/plain, text/markdown, application/json, .txt .md .markdown
  .json .log .yaml .yml. Table: text/csv, text/tab-separated-values, .csv .tsv. `image/svg+xml`, .svg, text/html,
  .html/.htm → 'none'.
- `export function blobType(kind: ViewerKind, mime: string | undefined, name: string): string | null` — the type used
  for the object URL: image/audio/video → the known specific mime when it matches the kind, else derived from the
  extension (e.g. `audio/mpeg`, `audio/webm`, `video/mp4`, `image/png`); pdf → `application/pdf`; text/table/none → null
  (no object URL; text is read with `blob.text()`).
- `export const VIEWER_MAX_BYTES = 25 * 1024 * 1024`
- `export function parseTable(text: string, separator: ',' | '\t', maxRows = 200, maxCols = 30): {rows: string[][]; cut: boolean}`
  — handles quoted fields with commas, doubled quotes and newlines inside quotes.
- `export const isPlainClick = (event: {button: number; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean; defaultPrevented: boolean}) => boolean`
  (move the existing one from attachments-view here and reuse it).
- `export function FileViewer({file, open, onOpenChange, fetchFile = fetch}: {file: {name: string; mime?: string; size?: number; href: string}; open: boolean; onOpenChange(open: boolean): void; fetchFile?: typeof fetch})`
  — dialog with the file name as title, `type · size` line, Download link (`href`, `download` attribute) and the body
  per kind; loads only while open; aborts the fetch and revokes the URL on close/unmount; refuses over the cap using the
  known size, then `content-length`, then the blob size; full screen at ≤ 760 px.
- `FileTile` gains `onOpen?(event: MouseEvent<HTMLAnchorElement>): void` called on a plain click for every kind (it
  replaces the image-only `onPreview`; update its callers). Tests for tiles are renderToStaticMarkup-level.
- A `useFileViewer()` hook or small `ViewableFileTile` wrapper that holds the open state, so each caller is one line.
- `InlineAudio({name, mime, href})` in `chat/attachments-view.tsx`: a `Play {name}` button that, on first press,
  fetches the file (same rules and cap), then renders `<audio controls autoPlay>` with the object URL; used for the
  audio items of `MessageAttachments`.

- [ ] Step 1: write `file-viewer.test.ts` — viewerKind table (each type above, octet-stream + extension, missing mime,
      svg/html → none, uppercase extension), blobType (`voice.webm` with `audio/webm` → `audio/webm`; `clip.mp4` with
      octet-stream → `video/mp4`; pdf → `application/pdf`; text → null), parseTable (quotes, embedded comma, doubled
      quote, embedded newline, TSV, cut at 200 rows and 30 cols with `cut: true`), isPlainClick.
- [ ] Step 2: run it, see it fail.
- [ ] Step 3: implement `file-viewer.ts`; run, see it pass.
- [ ] Step 4: write `FileViewer.test.tsx` (renderToStaticMarkup of the closed/opened shell: title, Download link with
      `download`, type · size line) and a test that a FileTile renders without `download` behaviour change; then
      implement `FileViewer.tsx`, `onOpen` in FileTile, the wrapper, and wire every caller listed above (context-file
      tiles keep their download href for modified clicks). Replace `MessageFileTile`'s ImageZoom with the viewer.
- [ ] Step 5: add `InlineAudio` to the audio items in `MessageAttachments`.
- [ ] Step 6: update `docs/SPEC.md` where file tiles and attachments are described.
- [ ] Step 7: focused vitest, `npx tsc --noEmit -p apps/user-ui`, `npm test`; commit
      `feat(canvas): open images, audio, video, PDFs and text in place`.

### Task 2: Start a chat by dropping an agent

**Files:**
- Modify: `apps/user-ui/src/canvas/invite-label.ts` (+test), `apps/user-ui/src/canvas/Surface.tsx`,
  `apps/user-ui/src/canvas/CanvasView.tsx`, `docs/SPEC.md`
- Create if useful: a pure helper file with tests for drop routing and new-chat members.

**Interfaces:**
- `export function startLabel(agent: string, areaTitle?: string): string` → `Start a chat with Moss` /
  `Start a chat with Moss in Research`.
- Surface prop `onDropAgentAt?(agent: string, at: Point, areaId: string | null): void`. Over a card (any access): today's
  behaviour. Over empty canvas, when `onDropAgentAt` is given: `dropEffect = 'copy'`, the floating label shows
  `startLabel` (area title when the point is inside an area), and the drop calls `onDropAgentAt` with the world point.
  Without the prop, empty-canvas agent drags stay `none` as today.
- `export function newChatMembers(agent: string | undefined, personalAgentId: string | undefined): {subscriberType: 'AGENT'; subscriberId: string}[]`
  → `[agent]` when given, else `[personal]` when present, else `[]`.
- `CanvasView.newChat` generalised to `newChat({areaId?, at?, agent?})`; the drop passes the agent and either the area
  or the point. Point placement: place the card with its top-left centred on the point (DEFAULT_CARD_WIDTH /
  CARD_PLACE_HEIGHT), clamped, nudged clear of other cards like `place` does. Area placement reuses `placeInArea`.
  Failure copy uses the agent name. `onDropAgentAt` is passed only when `canPlace` (editor, not phone list).

- [ ] Step 1: tests for `startLabel`, `newChatMembers`, and (if extracted) drop routing: card under pointer → card;
      none → canvas with area id or null; no handler → null.
- [ ] Step 2: run, see them fail. Step 3: implement; wire Surface and CanvasView. Step 4: run, pass.
- [ ] Step 5: update SPEC (canvas tray/agent drop section) and the ROADMAP Phase 5 "In progress" line to "Done".
- [ ] Step 6: focused vitest, tsc for user-ui, `npm test`; commit `feat(canvas): start a chat by dropping an agent on the canvas`.
