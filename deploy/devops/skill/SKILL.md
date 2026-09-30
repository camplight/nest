---
name: nest-devops
description: Develop Nest through camplight/nest GitHub pull requests and deploy merged main commits or restart the Nest service using its host-side operations endpoint.
---

You are running inside the service you maintain. Use the host-side operations
endpoint for deployment: its systemd job survives termination of your container.

## Repository work

The repository is https://github.com/camplight/nest. Use the installed
`camplight-github-cli` skill and its `scripts/gh.sh` wrapper for GitHub operations.
Git and GitHub authentication belong to the node account and persist in Codex home.
Clone into `/app/.nest-data/workspaces/NestSystem/nest` when needed, read AGENTS.md,
branch from current main, implement the requested change, run relevant checks,
commit, push, and open a PR. Preserve an existing Git identity; obtain the intended
author name/email if none is set. Never put credentials in commits, URLs or chat.

Follow the human's scope for merges and deployment. Creating this skill is not
blanket authorization to change production for unrelated tasks. When asked to
ship a change, wait for its PR checks, merge it, resolve the new main SHA, then
deploy that exact SHA. Do not deploy unreviewed branches or force-push main.

## Production operations

Use `scripts/nest-ops.sh` relative to this skill:

```sh
scripts/nest-ops.sh status
scripts/nest-ops.sh deploy FULL_MAIN_COMMIT_SHA
scripts/nest-ops.sh restart
scripts/nest-ops.sh status OPERATION_ID
scripts/nest-ops.sh logs OPERATION_ID
```

`deploy` accepts only the current main SHA. The host builds while the old service
is running, stops Nest briefly for a database snapshot, switches the image,
restores persistent Git config and demo routes, and checks health and public pages.
On failure it restores the prior image and pre-deployment database, then records
the rollback result. A schema rollback discards database writes during the failed
startup window; uploads and workspaces remain on their existing volumes.

`restart` restarts the Nest container, not the host machine or Caddy. Both commands
return a job ID immediately. Record that ID before waiting: the current agent turn
may be interrupted. After reconnection, read its status; do not blindly repeat a
queued or running operation. A queued response is not proof of success.

The dedicated SSH key is restricted to this endpoint. It grants no interactive
host shell, port forwarding, or Docker socket access. Keep its files private.
Do not replace the host controller from agent-writable files; controller changes
require a separate operator installation. If rollback fails, report the operation
ID and error for host-level recovery instead of repeatedly restarting.
