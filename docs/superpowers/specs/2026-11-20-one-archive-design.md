# One archive, and chat settings

## Why

Nest had two archives. The canvas Loose chats **Archive** only hid a chat from the
person's own list, so the chat looked normal everywhere else (Projects, the sidebar,
the chat itself). The real archive, which makes the chat read-only for everyone, was a
checkbox in a dialog reached through a **Sharing** button. Archiving a project chat
made the project vanish: `apps/api/src/projects.ts` reads channels without archived
ones, so the project left the grid and the sidebar, and its link answered "Project
unavailable", which also removed the way back.

The person asked for one meaning of archive, visible wherever the chat appears, and
for settings to be called settings.

## Approaches considered

1. **One real archive** (chosen): Archive archives the chat itself when the person can
   manage it; a personal hide stays only for chats they cannot manage, named for what
   it does.
2. Keep both and label them (`Hidden` / `Archived`): two words for nearly the same
   act, and the confusion stays.
3. Personal hide only: the chat stays live for everyone else, which is not what
   archiving means to people.

## Design

### What Archive means

- Archive is the engine archive (`POST /api/channels/:id/archive`): the chat becomes
  read-only for everyone and leaves active lists. Who may archive is the engine's rule
  (`canManageChannel`); for a project chat, the project owner.
- For chats the person cannot manage, the canvas action is **Hide from my list** (the
  existing personal hide, `POST /api/canvases/hidden`), with Unhide.
- Archiving pauses every hand-off link to or from the chat (reason `archived`, not a
  Needs you item) and declines hand-offs there awaiting an OK; Unarchive resumes the
  links archiving paused unless the other end is still archived or hidden by the link's
  creator. Nest intercepts the archive and unarchive routes, forwards them to the
  engine, and acts on the links only when the engine accepted. A personal hide keeps
  pausing only the person's own links, as now.

### Chat settings

- The **Sharing** button becomes **Settings** (gear icon) everywhere it appears: the
  regular chat, a project's Chat tab, and the canvas chat's "…" menu.
- The dialog is titled **Chat settings** with three parts: **Sharing** (visibility,
  Manage participants, Copy share link, Save), **Archive** (an `Archive chat` /
  `Unarchive chat` button that acts at once, with one line on what it does), and
  **Delete** (the existing two-step Delete permanently).

### Where an archived chat shows

- **Projects page**: archived projects are listed after the others under an
  `Archived (N)` heading, collapsed by default, each card tagged `Archived`.
- **Sidebar Projects list**: archived projects are left out of the short list; `View
  all projects` reaches them.
- **An archived project** opens read-only: the chat and files show, an `Archived` tag
  sits by the title with **Unarchive** for the owner, and editing actions stay
  unavailable. `GET /api/projects` and `GET /api/projects/:id` read channels with
  `includeArchived=1` and return `archived: true`; owner mutations still refuse an
  archived chat.
- **Chat header** (regular and project chat): an `Archived` tag by the title, with
  Unarchive for people who may manage it. The reply box keeps "Restore this channel to
  send messages".
- **Canvas**: cards and the chat header keep their existing `Archived` tag; the Loose
  chats drawer's **Show archived** lists archived chats and the person's hidden ones,
  each tagged and with the matching undo.

### Loose chats bulk action

The toolbar's **Archive** archives the selected chats the person can manage and hides
the rest; the notice says how many of each (`Archived 3 · hid 1 you can't manage`).

## Not changing

- Existing personal hides stay as they are; nothing is migrated.
- Delete keeps its current behaviour (cleaning up links on delete is a separate
  follow-up).
- The engine is not changed.

## Left to the builder

Exact placement and styling of the `Archived` tag and the Archived section, following
the existing project card and canvas tag styles; copy for the archive line in Chat
settings.
