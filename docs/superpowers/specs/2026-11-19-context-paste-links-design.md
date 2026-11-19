# Paste links and files into canvas context — design

Branch: `feat/switchyard-canvas` (local, behind `NEST_ENABLE_CANVAS`). Extends the Phase 2 context feature
(`2026-11-08-switchyard-canvas-design.md`, context popover `apps/user-ui/src/canvas/ContextPanel.tsx`).

## Intent

The owner keeps reference material for a section (area) or a whole canvas in its context popover (the `◱ Notes · 5
files` chip). Today that holds notes, uploaded files and "Also uses" links to other areas. Adding a web page (a Google
Doc, a Miro board, a Trello card, an article) means typing its address into the notes. Adding a screenshot means saving
it and using Add files.

They want to **paste** instead: with the popover open, pasting a link adds it to that section's context as its own item,
and pasting files adds them to its Files. Agents in that section then know about the links, as they know the notes and
files, and can open them with their own tools (for example the Miro/Trello connections).

Success: open the popover, press Ctrl/Cmd+V with a copied link or screenshot, and it appears in the context; chats in
that section (and their agents) see it.

## Goals

- **Paste files** (images, screenshots, copied files) anywhere in the popover → uploaded to that scope's Files, the same
  path as Add files / drop (same limits and errors).
- **Paste links** anywhere in the popover → saved as **web links** of that scope: a new **Links** list in the popover,
  between Files and Also uses. Each row: a link icon, the title (or the address without `https://`), the host as a second
  line, opens in a new tab on click, ✕ removes it (editors).
- Works for **both scopes**: the canvas context and an area's context.
- Agents reading context get each scope's web links (`url`, `title`) next to its notes and files.
- The area/canvas chip counts them: `Notes · 5 files · 2 links`; a scope with only links counts as having context.

## Non-goals

- Fetching pages, snapshots, previews, page titles from the network, or remote favicons (no server-side requests to
  pasted addresses; no third-party icon requests from the browser).
- Editing a link's title, reordering links, or links on an empty area's on-canvas file shelf.
- Pasting into chats or the bottom box (unchanged).
- Phones get the same popover behaviour only if paste already reaches it; no phone-specific work.

## Anti-goals

- Pasting text into the Notes box (or any input) turning into a link item: inside Notes, paste is ordinary text.
- A `javascript:` or other non-web address becoming a clickable link.
- Link addresses leaking into logs or the audit trail (they can be private document links): audit only ids, as notes do.
- Breaking the existing "Also uses" area links, which the code already calls `links`.

## Constraints

- Repository rules (`AGENTS.md`): API in `apps/api` (no engine DB), product state in `packages/db` with a numbered
  migration, product types in `packages/schemas`, UI in `apps/user-ui`; no `vendor/orgops` edits; functional factories,
  DI, colocated tests; docs (`docs/SPEC.md`) kept in sync. Branch stays local.
- Naming: "links" already means area-to-area context links (`ContextLink`, `/context/links`, `↳` chips). The new items
  are **web links** in code (`ContextWebLink`, `webLinks`, `/context/web-links`, table
  `product_canvas_context_web_links`); the UI heading is **Links**.

## Approaches considered

1. **Web links as their own stored items** *(chosen by the owner)*: new table, two routes, shown as a Links list, sent
   to agents. A real but contained full-stack change.
2. Append pasted links as lines in Notes: cheapest, but not a visible, removable item ("as attachment").
3. Save a link as a small file in Files: no backend change, but clicking downloads a file; dropped.

## How it works (decided)

### Data

- Migration `018_context_web_links.sql`: `product_canvas_context_web_links(id TEXT PK, canvas_id TEXT NOT NULL
  REFERENCES product_canvases(id) ON DELETE CASCADE, scope_kind TEXT CHECK IN ('canvas','area'), scope_id TEXT NOT NULL,
  url TEXT NOT NULL, title TEXT, added_by TEXT NOT NULL, added_at INTEGER NOT NULL, UNIQUE(scope_kind, scope_id, url))`
  plus an index on `(scope_kind, scope_id)`. Rows of a deleted area are removed wherever that area's context files and
  notes are removed today.
- Limits in `packages/schemas`: `MAX_WEB_LINKS_PER_SCOPE = 50`, `MAX_WEB_LINK_URL = 2048`, `MAX_WEB_LINK_TITLE = 200`.
  Only `http:` and `https:` URLs are accepted (parsed with `URL`, stored normalized via `url.href`).
- Type `ContextWebLink = {id, url, title: string | null, addedBy, addedAt}`; `ScopeContext` gains `webLinks`;
  `ContextCounts` gains `linkCount`; `hasContext` = notes or files or web links.

### API

- `POST /api/canvases/:id/context/web-links` and `POST /api/canvases/:id/areas/:areaId/context/web-links`, body
  `{url, title?}` (strict schema), editors only (same permission as notes/files). A URL already in that scope returns the
  existing row with 200 (not an error); a new one 201; over the limit 409; invalid URL 400.
- `DELETE …/context/web-links/:linkId` (both scopes), editors only.
- `GET …/context` returns `webLinks`; the board context summary counts them.
- Agent payload (`homeContext` in `context-agents.ts`): every scope (`canvas`, `area`, each `linked`) gains
  `webLinks: [{url, title}]`. The `nest-context` skill text (`skills/nest-context/SKILL.md`) says so. A scope with only
  web links counts as filled wherever "has notes or files" decides agent setup/readers.
- Audit: `audit.canvas.context.web-link.added` / `.removed` with ids only, never the URL or title.

### Paste in the popover (UI)

- One `onPaste` on the popover root, editors only. If the paste target is the Notes textarea or any input/textarea/
  contenteditable, do nothing (normal paste).
- Otherwise, in order: if the clipboard has files → upload them exactly as Add files does (`addFiles`). Else read
  `text/plain` and find http(s) URLs in it (up to 10 per paste) → add each as a web link. The title comes from the
  clipboard's `text/html` when it is a single `<a href=URL>text</a>` whose text is not the URL itself; otherwise none.
  Text with no URL → a short status line: "Paste a link or a file to add it here."
- The popover focuses its heading when it opens (it does today), so a paste right after opening reaches it.
- Links list: newest last; empty state "No links yet. Paste one here." (editors) / "No links." (viewers). Errors show
  inline like file errors. Duplicate paste → status "Already in context".
- `contextLabel` adds `N link(s)`; the chat header's "sees" summary keeps working (it already reads counts).

### Calls made after the builder check (the designer's, open to the owner's correction)

- Area deletion: `removeArea` in `packages/db/src/canvases.ts` deletes context rows by hand (no FK on `scope_id`); web
  links are deleted there too. The runtime skill copy is replaced by `scripts/orgops-env.ts` when the bundled skill
  version changes, so bump `skills/nest-context/skill.json`'s version with the SKILL.md change.
- A paste at the limit adds links in order and stops at the first refusal, with one status line ("Context is full: 50
  links").
- `linkCount` shows on every chip that reads counts, including "Also uses" sources.
- A clipboard with both files and text (some browsers attach the page URL to a copied image) uploads the files and
  ignores the text.

## Left to the builder

- Exact parsing helper names (keep URL extraction and the HTML-title read as pure, tested functions).
- Where area deletion cleans context rows today, and mirroring it for web links (with a test).
- How the runtime copies of the `nest-context` skill pick up the SKILL.md change (`.nest-data/engine/skills`); if a copy
  must be refreshed by an existing sync, say so in the report rather than writing to live data.
- Styling of the Links rows within the existing context popover tokens.
