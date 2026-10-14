# Chat-first project creation validation

These screenshots show synthetic local browser fixtures, not production tenant data.
The before views show the name-and-description form from the parent project-creation PR.
The implemented flow starts in chat, adds explicitly selected mentions on first send,
and lets owners edit project details in settings.

`project-chat.png` shows a delayed, injected AI naming response used to verify that
chat opens before the brief arrives. It is not a live model response. The renamed
view shows a subsequent manual edit. No provider calls or charges were made by the
browser tests.

Captured after the product tests, lint, build, and project/dashboard browser checks
passed. The final project capture used:

```sh
node --import tsx tests/browser/projects.ts
```

Desktop is 1440 × 1100; mobile is 390 × 844. The existing Nest shell, tokens, and
agent avatars follow the Figma reference `Rqfq3v9a8nZfQKbM3Q0NZk`, node `849:599`.
The chat-first creation and project settings are product extensions, not exact
copies of a dedicated Figma frame. Screenshots exclude credentials and real users.
