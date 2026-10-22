# Codex progress in chat

These screenshots show the implemented Nest UI with synthetic local test data.
They are not production conversations or Figma references. The browser scenario
uses the unchanged OrgOps API, Nest gateway, real authenticated WebSocket delivery,
and Nest's Codex parser/progress adapter. Scripted Codex JSONL events avoid a live
model call, subscription use or production mutations.

- [Desktop](progress-desktop.png)
- [Mobile](progress-mobile.png)

The scenario verifies that interim assistant text appears before completion,
only the latest update remains across intervening human messages, progress recovers
after refresh, completed progress clears, and the final response appears once.
Unit/integration checks additionally cover failed turns, reasoning/tool-output
exclusion, lost-response deduplication, bounded delivery failure and suppression
of agent wake-ups. Existing compact activity controls remain unchanged.

Validation: `npm run lint`, `npm run build`, all 173 product tests, the demo
publisher check, and `npm run test:ui:chat`. On macOS the publisher check needs
`TMPDIR=/private/tmp` to avoid the existing temporary-path symlink mismatch.
The OrgOps submodule is untouched. No live Codex turn was dispatched for these checks.
