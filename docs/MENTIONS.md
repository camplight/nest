# Mention completion

In any writable Nest chat, type `@` to search visible people and agents. Matching
is case-insensitive and accent-insensitive, with exact/prefix matches before
substring and ordered-subsequence matches (for example `@pffvtly` matches
`PuffVitaliy`). Current conversation members sort first within the same match
quality. Up to eight results appear; type more to narrow them.

Use arrow keys to browse, Enter or Tab to insert, and Escape to dismiss. Clicking
or tapping an option also inserts it. Selecting never sends the message. Enter
while an empty result list is open does not send it either; Escape restores normal
send behavior. Shift+Enter, IME composition, pasted attachments, text selections,
mid-message caret edits and read-only conversations retain their existing behavior.
Email addresses, URL fragments and inline/fenced code do not trigger the picker.

The picker uses the UI's visibility-filtered agent list, authenticated human list,
and current channel participants. It does not request a privileged directory.
People outside the conversation are labelled **Not in this chat**. Inserting a
mention does not invite them, grant access, notify a nonmember, or expose the chat.

Mentions are existing `@name` message text. OrgOps retains channel delivery and
permissions; this change does not introduce exclusive recipient routing or human
mention notifications. Explicit targeted agent events are a separate engine
feature. No upstream modification, new API, database migration or dependency is
needed for completion itself.

SmoothUI's official combobox was evaluated, but its separate trigger/search field
would replace textarea focus and brings command/popover dependencies. This inline
popup is Nest-owned, using the existing Motion dependency and reduced-motion
preference. It uses a listbox/active-descendant pattern while focus stays in the
textarea, original agent avatars, and existing Figma-derived tokens.

Validation: `npm test` covers matching, token boundaries and insertion;
`node tests/browser/mentions.mjs` covers real browser interaction with labelled
synthetic API fixtures. It also runs through the existing `test:ui:agents` CI entry.
