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
symlink, node's login-shell Git PATH, and legacy demo routes after container replacement. Protected images serve demos through the session-gated API.

Accepted commands: `status [id]`, `logs [id]`, `restart`, and `deploy <full SHA>`.
Deployment is restricted to the current `camplight/nest` main commit. systemd
runs operations independently of Nest; flock prevents simultaneous mutations.
Status and logs are under `/opt/nest/operations`, private to root but readable
through the endpoint. Backups are under `/opt/nest/backups/ops-<id>`.

Builds happen before stopping the service. SQLite is backed up while Nest is
stopped. Failed starts restore the prior image and both SQLite snapshots; runtime
workspaces and uploads retain their existing volume contents. Database writes
during a failed deployment's startup window are discarded on rollback. The
host checks health, branding, both UI routes, and the existing Kibrit demo (anonymous 401 for protected images; byte hash for legacy images and rollback).

This grants production deployment authority: merged application code and its
Dockerfile run on the production host. Repository permissions and PR review
remain important even though the SSH endpoint provides no interactive shell.
Controller updates require operator installation, not an agent-writable hook.

Validation: `python3 -m unittest discover -s deploy/devops -p 'test_*.py'` covers
unmerged SHA rejection, command rejection, and image/database rollback. A live
restart check passed (operation `7029420743884523982a408e2a075723`). Public-page
checks retry briefly because API health can precede UI readiness.

## Host resource budgets and health recovery

The deployment template defaults to a 1536 MiB RAM limit, a **2048 MiB combined
RAM + swap limit** (therefore at most 512 MiB container swap), 0.80 CPU and 384
processes/threads for Nest. This leaves host capacity for SSH, Docker and Caddy
on the current 2 GiB / 1 CPU machine. `NEST_MEMORY_LIMIT`,
`NEST_MEMORY_SWAP_LIMIT`, `NEST_CPU_LIMIT` and `NEST_PIDS_LIMIT` override these
Compose settings for a differently sized host. Use positive values; zero can
remove a limit. The swap limit must be at least the RAM limit. Nest logs use
Docker's rotating local driver, capped at three 10 MiB files.

Host swap is independent of these limits. Production now has about 2 GiB total
swap, including the operator-added `/swap-nest-extra` file. Never disable active
swap on a pressured host to resize it: add a mode-0600 swap file, activate it,
back up fstab, and persist the entry. Swap is a burst buffer, not additional RAM.
Do not run heavy browser/build/full-suite validation on the production host;
use GitHub Actions or a separate bounded build runner.

Budget exhaustion can still terminate an agent or API process in this shared
container. The existing supervisor and `unless-stopped` policy restart exited
process stacks, but Docker does **not** restart a still-running `unhealthy`
container. The optional `nest-watchdog` systemd timer observes health every minute:

- Three consecutive unhealthy observations trigger a fixed container restart.
- Healthy, starting, explicitly stopped, unknown and recreated containers reset
  the streak. Unknown/missing Docker state never triggers a restart.
- It shares the deployment controller's flock, so it skips deployment snapshots,
  migration/startup and rollback. It never deploys an image or reboots the host.
- Restart attempts are limited to one per hour, including failed attempts and
  container/host restarts. Corrupt state fails closed for operator review.
- Journald receives state/resource metadata, not application logs, commands,
  database contents, prompts or credential-bearing environment configuration.

### Reviewed operator installation

Repository deployment does not update host Compose settings or install this
watchdog. First snapshot the existing private Compose files, environment, both
databases and runtime volumes through the normal upgrade procedure. Merge only
the reviewed resource/logging settings into the existing `/opt/nest/compose.yaml`;
preserve its image selection, private settings, runner identity and mounts. Check
`docker compose config --quiet` without printing its expanded credentials.
Recreating Nest applies limits and interrupts active work; schedule that change,
then verify health, login, runner heartbeat and demo access before enabling recovery.
A larger/separate runner remains the stronger availability boundary. Host-owned
Docker image builds and direct root commands are outside Nest's cgroup; prefer
prebuilt CI images or separately bounded build capacity for those workloads.

From the reviewed source checkout, install as an operator with host access:

```sh
sudo install -d -o root -g root -m 700 /var/lib/nest-watchdog
sudo install -o root -g root -m 755 deploy/devops/nest-watchdog.py /usr/local/lib/nest-watchdog.py
sudo install -o root -g root -m 644 deploy/devops/nest-watchdog.service /etc/systemd/system/nest-watchdog.service
sudo install -o root -g root -m 644 deploy/devops/nest-watchdog.timer /etc/systemd/system/nest-watchdog.timer
sudo systemd-analyze verify /etc/systemd/system/nest-watchdog.service /etc/systemd/system/nest-watchdog.timer
sudo systemctl daemon-reload
sudo systemctl enable --now nest-watchdog.timer
sudo systemctl list-timers nest-watchdog.timer
sudo journalctl -u nest-watchdog.service --since today
```

For maintenance, disable the timer before intentionally inducing an unhealthy
state: `sudo systemctl disable --now nest-watchdog.timer`. To roll back budgets,
restore the saved Compose settings and recreate the same image against the same
volumes. Removing the watchdog does not remove application data. Do not delete
or reset watchdog state merely to bypass its cooldown.

Validation: `python3 -m unittest discover -s deploy/devops -p 'test_*.py'` covers
recovery decisions, cooldown, unknown state, failed restarts and deployment locks.
After building `nest:check`, `node deploy/devops/check-resources.mjs` checks actual
Compose rendering and uses a disposable, network-isolated 64 MiB container to
verify cgroup OOM containment, automatic restart, real watchdog recovery from
unhealthy state and synthetic volume persistence.
Run this **locally or in CI**, never as a stress test of production.

See [the incident record](INCIDENT-2026-10-25.md) for evidence and remaining limits.
