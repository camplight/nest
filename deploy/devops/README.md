# NestSystem host operations

The host controller is `nest-ops.py`. Install it as root-owned,
non-agent-writable `/usr/local/lib/nest-ops.py` with mode 755. It assumes the
existing `/opt/nest` Compose deployment and `nest_nest-data` / `nest_nest-product`
volumes. Before installing this controller version, follow
[the submodule migration guide](../../docs/SUBMODULE_MIGRATION.md), including the
new product volume mount. The controller initializes submodules and runs the
offline migration before starting a new image.

The `skill/` directory is the agent-facing `nest-devops` skill. Its SSH wrapper
uses a dedicated key at `codex-home/devops/id_ed25519`, with the host key pinned
in `codex-home/devops/known_hosts`. The corresponding authorized_keys entry must
use `restrict,command="/usr/local/lib/nest-ops.py"`; it must never grant a shell.

Provisioning this host-control credential requires explicit operator approval.
The operator approved activation on 2026-09-24. The restricted key and skill are
installed; a live restart passed health, UI, branding, and Kibrit checks.
Deployment of main commit `2b711e50570bf63d552b6b194e1b56f39bdf7619` also passed
(operation `c49c233d35bb494caf76fc52282a5183`). GitHub authentication and the
restricted endpoint were rechecked from NestSystem's environment after recreation.

Before activation, persist the existing Git configuration (credential helper
references only, no token values) at `codex-home/gitconfig`, and point
`/home/node/.gitconfig` to it. GitHub credentials already live separately in the
private `codex-home/github-cli-config` directory. The controller restores this
symlink, node's login-shell Git PATH, and existing demo routes after container replacement.

Accepted commands: `status [id]`, `logs [id]`, `restart`, and `deploy <full SHA>`.
Deployment is restricted to the current `camplight/nest` main commit. systemd
runs operations independently of Nest; flock prevents simultaneous mutations.
Status and logs are under `/opt/nest/operations`, private to root but readable
through the endpoint. Backups are under `/opt/nest/backups/ops-<id>`.

Builds happen before stopping the service. SQLite is backed up while Nest is
stopped. Failed starts restore the prior image and both SQLite snapshots; runtime
workspaces and uploads retain their existing volume contents. Database writes
during a failed deployment's startup window are discarded on rollback. The
host checks health, branding, both UI routes, and the existing Kibrit demo.

This grants production deployment authority: merged application code and its
Dockerfile run on the production host. Repository permissions and PR review
remain important even though the SSH endpoint provides no interactive shell.
Controller updates require operator installation, not an agent-writable hook.

Validation: `python3 -m unittest discover -s deploy/devops -p 'test_*.py'` covers
unmerged SHA rejection, command rejection, and image/database rollback. A live
restart check passed (operation `7029420743884523982a408e2a075723`). Public-page
checks retry briefly because API health can precede UI readiness.
