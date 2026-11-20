# Start a chat by dropping an agent, and open files in place — design

Branch: `feat/switchyard-canvas` (local; canvas work behind `NEST_ENABLE_CANVAS`). Approved by the owner on
2026-11-20 ("yes please go with item 2 and 3"). Both came from comparing Nest with the original Switchyard canvas
prototype; the other prototype blocks are listed as Phase 5 candidates in `docs/ROADMAP.md`.

## Intent
1. Dropping an agent from the tray on empty canvas should start a chat with that agent there. Today such a drop does
   nothing (only a drop on an open card adds the agent to that chat).
2. Clicking a voice note, image or other file should show or play it in Nest, not download it. Today the engine serves
   only raster images inline (`/api/files/:id` sends everything else as `application/octet-stream` with
   `content-disposition: attachment`), context files are always downloads, and card tiles just follow the link.

## Decisions
### Start a chat by dropping an agent (editors only)
- An agent dragged from the tray over empty canvas (no card under the pointer) can be dropped: the floating label
  reads `Start a chat with Moss`, or `Start a chat with Moss in Research` over an area. Over a card, today's labels and
  behaviour are unchanged.
- The drop creates a team chat named "New chat" (the first message names it, as for `+ Chat`) whose only agent is the
  dropped one (the person's own agent is not added: this is "a chat with Moss"). Dropped in an area, the chat joins
  that area (the area grows to fit, as for an area's `+ Chat`); elsewhere the card is placed at the drop point, nudged
  clear of other cards. Then it opens in the current or last chat mode with its message box focused, exactly like
  `+ Chat`.
- Viewers (view role), the phone list and a canvas without placement rights get no drop. A failed create says
  `Could not start a chat with Moss. Try again.`

### Open files in place
- One shared viewer dialog. A plain primary click on any file tile opens it: cards, chat messages (canvas tiles), area
  shelves, the context popover and the phone list. Ctrl/Cmd/Shift/Alt or middle click keeps today's link behaviour.
- What it shows, by type (from the file's known MIME type, else its extension):
  - raster images (png, jpeg, gif, webp, avif): the picture, fit to the dialog;
  - audio, voice notes included: an audio player; video: a video player;
  - PDF: the browser's PDF viewer inside the dialog;
  - plain text, Markdown, JSON, logs, YAML: the text as plain text (never rendered as HTML);
  - CSV/TSV: a simple table (first 200 rows, 30 columns, with a note when cut);
  - anything else, including HTML and SVG: name, type, size and a Download button.
- Nest fetches the file itself (same-origin, with the person's session) and makes a typed object URL from an
  allowlist of safe types, so the engine's download header does not apply and the engine is not changed. HTML and
  SVG are never rendered. Files over 25 MB are not loaded; the dialog offers Download. Object URLs are revoked on close.
- The dialog always has Download and close; Escape closes; focus is trapped; on phones it is full screen.
- In chat messages, audio attachments (voice notes) also get an inline player: a Play button that loads the file on
  first press, so a long history does not download every voice note.

## Not in scope
Transcripts, text-in-image reading, previews of Office documents, editing files, and any engine change (a follow-up
could ask OrgOps to serve audio/video/PDF inline with a strict CSP).
