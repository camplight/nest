# Private subscription-backed assistant

Production has a private `NestAssistant` wrapped agent and a private
`Nest Assistant` channel owned by the deployment administrator. The agent runs
Codex CLI 0.155.1 using ChatGPT subscription authentication. It is running and
was verified on 2026-09-23 with an initial response and a follow-up that recalled
the previous turn. Owner visibility and rejection of unauthenticated access
were also verified.

Open the channel while signed in as its owner:
https://nest.camplight.net/?channel=61885f66-f98c-43c2-9add-388a48bc5695

The persistent Nest data volume contains:

- `codex-runtime/node_modules`: pinned `@openai/codex@0.155.1` installation.
- `codex-runtime/bridge.mjs`: installed copy of `deploy/codex-bridge.mjs`.
- `codex-runtime/sessions`: mapping from Nest sessions to Codex thread IDs.
- `codex-home`: private Codex login, configuration, and conversation storage.
- `workspaces/NestAssistant`: the assistant's working directory.

The bridge runs Codex as the container's unprivileged `node` user with a
read-only sandbox. It passes only a minimal environment, excluding Nest's admin
password, runner token, and master key. Only final assistant text is returned to
Nest; raw Codex diagnostics are not posted to chat. Each Nest channel resumes
its own Codex thread. The Docker image includes CA certificates for verified
TLS connections to OpenAI.

To sign in on the production host:

```sh
cd /opt/nest
docker compose exec --user node \
  -e CODEX_HOME=/app/.nest-data/codex-home nest \
  /app/.nest-data/codex-runtime/node_modules/.bin/codex login --device-auth
```

Complete the displayed flow in your own browser. Check the result with the same
command ending in `login status`. Never print or commit `auth.json`. Authentication
state is sensitive and any backup of the data volume must be protected accordingly.

Keep this agent and its channels private. Codex requests consume the signed-in
account's allowance and may fail when usage limits are reached or reauthentication
is required. The bridge reports such failures rather than switching to API billing.
