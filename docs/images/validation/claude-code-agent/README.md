# Claude Code agent: Admin create form

Captured on 2026-10-23 by `node tests/browser/claude-code-agent.mjs`, which rewrites these files on every run.

The admin API is mocked inside the browser check. The agent `Coder`, the runners `nest` and `nest-agents`, the model list and the secret names `GH_TOKEN` and `SSH_PRIVATE_KEY` are synthetic test data. No engine, real credential or production tenant is involved.

1. `claude-code-create-desktop.png`: the Create Agent drawer at 1440 px wide with Claude Code chosen, one tool secret, one secret file, the secrets notice and the generated recipe.
2. `claude-code-create-mobile.png`: the same form at 390 px wide. The check asserts there is no horizontal page scroll.
