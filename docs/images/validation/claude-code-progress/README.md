# Claude Code progress in chat

These screenshots show the implemented Nest UI with synthetic local test data.
They are not production conversations or Figma references. The browser scenario
uses the unchanged OrgOps API, Nest gateway, real authenticated WebSocket delivery,
and the Claude Code bridge's stream-json parser with the shared progress adapter.
Scripted Claude Code events avoid a live model call.

- [Desktop](progress-desktop.png)
- [Mobile](progress-mobile.png)

The scenario verifies that interim assistant text appears before completion, only
the latest update remains across intervening human messages, progress recovers
after refresh, completed progress clears, the final response appears once, and
thinking, tool input, tool output and file paths never reach the chat. Existing
Codex progress (`tests/browser/codex-progress.mjs`) passes unchanged.
