# Claude Code container check

`npm run check:container:claude` (or `bash tests/container/claude-code-agent.sh`) builds the image, starts Nest and the runner-only agent container from `deploy/compose.yaml` and `deploy/compose.claude-agents.yaml`, and runs scripted Claude Code turns against a mock Anthropic API. It never contacts Anthropic and uses only generated, fake credentials. It prints a PASS/FAIL table and exits non-zero when any step fails.

## 1. Requirements

Docker with Compose v2, `bash`, `curl`, `jq`, `openssl`, `node` and `uuidgen` on the host. On macOS with Colima, start it with `colima start`; the check passes files into containers with `docker cp` and stdin, so it needs no bind mounts.

Environment options:

- `NEST_IMAGE` (default `nest:claude-check`): image tag to build and run.
- `SKIP_BUILD=1`: reuse an image that is already built.
- `KEEP=1`: leave the stack (compose project `nest-claude-check`) and its working folder in place for inspection. Clean up later with `docker compose -p nest-claude-check down -v`.

Without `KEEP=1` the stack and its volumes are removed on exit, also after a failure or Ctrl-C. A failed run keeps its working folder (API responses, compose logs) and names it; the fake credential is redacted from those files and from everything printed.

## 2. Steps

1. The image builds and `claude`, `gh`, `git` and `ssh` print their versions.
2. Nest and `nest-agents` start under project `nest-claude-check`, with a generated admin password, master key and runner token, the API published on a free `127.0.0.1` port, and no Caddy or public host.
3. Both runners come online; the agent container's runner is named `nest-agents`.
4. `mock-anthropic.mjs` runs inside the agent container on `127.0.0.1:4010`, started as root so its request log is root-only.
5. Agent `ClaudeCheck` is created with the Admin recipe, `NEST_CLAUDE_UPSTREAM_URL` pointing at the mock, and a private `CLAUDE_CODE_OAUTH_TOKEN` secret with a random fake value; it is mentioned in a new channel.
6. From the channel events: a `wrapped-progress` event `Checking the container.`, a reply showing `uid=1000(node)`, `ANTHROPIC_BASE_URL` set to the per-turn proxy rather than the mock, no visible credential other than a `nest-proxy-` dummy, no `NEST_` or `ORGOPS_` variables, `/proc/1/environ` unreadable, no `.sqlite` file, the fake value absent from all events, and the mock's log showing `Authorization: Bearer <fake>` (the proxy swapped the dummy for the real value).
7. As `node`, no readable file or process environment in the agent container contains the fake value.
8. Agent `ClaudeStop` (turn limit 20 s) runs `sleep 600`; the turn ends with the stop line and no `sleep 600` or `claude` process is left.
9. Agent `ClaudeRefuse`, assigned to the Nest container's runner, fails with the `Nest's data` refusal.

Claude Code removes its own `CLAUDE_CODE_OAUTH_TOKEN` from tool environments (verified with 2.1.309), so step 6 checks the proxy through `ANTHROPIC_BASE_URL` and the mock's log rather than the token variable. The recipe also sets `ANTHROPIC_BASE_URL` to the mock so that a bridge without the credential proxy still stays local; the proxy replaces it.

## 3. Engine API used by the check

All calls go through the Nest API with the admin session cookie from `POST /api/auth/login {username, password}`.

- Runners: `GET /api/runners` (`displayName`, `online`). `NEST_RUNNER_NAME` in the compose file becomes the runner's display name.
- Agents: `POST /api/agents {name, workspacePath, mode: "WRAPPED", modelId: "wrapped:none", assignedRunnerId, wrappedConfig}`.
- Secrets: `POST /api/secrets {name, value, scopeType: "private", scopeId: <agent name>}`. The runner injects them into the turn filtered by `wrappedConfig.secrets.allowedKeys`.
- Turns: `POST /api/channels {name}`, `POST /api/channels/:id/subscribe {subscriberType: "AGENT", subscriberId}`, then `POST /api/messages {id, channelId, text: "@Name ...", mentions: [{kind: "AGENT", name, start: 0, end}]}`.
- Results: `GET /api/events?channelId=...` for `message.created` and `agent.turn.failed` from `agent:<Name>` and `agent.turn.phase` progress events.

## 4. Mock Anthropic API

`mock-anthropic.mjs <port> [log file]` answers `HEAD`/`GET` with `200 {}`, `POST /v1/messages/count_tokens`, and `POST /v1/messages` in Anthropic's streaming SSE format (`message_start` with usage, `content_block_start`, `text_delta` / `input_json_delta`, `content_block_stop`, `message_delta` with `stop_reason`, `message_stop`) or as plain JSON when `stream` is false. Every request's method, path and auth headers go to the log; unknown paths get a 404 and show up there, which is how to find what a new Claude Code release calls.

The scripted agent counts `tool_result` blocks: with none it says `Checking the container.` and runs one `Bash` inspection command (or `sleep 600` when the prompt contains `SLEEP`); afterwards it replies `RESULT:` followed by the tool output. Requests without tools get a short text reply.

To check the mock against the CLI alone, run in the built image as `node`:

```sh
docker run --rm -i --user node --entrypoint sh -e ANTHROPIC_BASE_URL=http://127.0.0.1:4010 -e CLAUDE_CODE_OAUTH_TOKEN=dummy nest:claude-check -s <<'EOF'
cat > /tmp/mock.mjs <<'MOCK'
...contents of tests/container/mock-anthropic.mjs...
MOCK
node /tmp/mock.mjs 4010 & sleep 1; cd /tmp
claude -p --output-format stream-json --verbose --permission-mode bypassPermissions go | grep '"type":"result"'
EOF
```

The result text starts with `RESULT:` and contains `uid=1000(node)`.
