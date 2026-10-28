# Native host deployment

Production runs directly on Ubuntu 24.04. Nest owns deployment around the
**untouched** OrgOps submodule. The existing CLI/startup code remains useful for
local installs; production has one repeatable entrypoint:

```sh
sudo scripts/install-host.sh \
  --release /path/nest-host-linux-x64.tar.gz \
  --sha256 <verified-release-checksum> \
  --domain nest.example.com \
  --env-file /root/nest-runtime.env
```

Re-run the same script with the next reviewed release to upgrade. Omit
`--env-file` to preserve the installed environment. No build runs on the live
host. There is no Ansible/Terraform or agent-written server configuration.

For a known runner/engine incident, `--pause-runner` deploys the API/UIs while
retaining an explicit execution pause at `/etc/nest/runner-paused`. Upgrades,
controller restarts and reboot preserve that pause. The runner's systemd
condition also blocks an accidental start. After reviewing the core fix, use
`--resume-runner` to remove the pause and require registration/heartbeat again.
Paused activation checks API/Google/demo availability and does not claim agent
execution is healthy. The marker is included in configuration backup/rollback.

## Topology and reproducibility

Caddy serves the built user/admin UIs and proxies HTTP/WebSocket/demo requests to
Nest API (127.0.0.1:8787). Nest calls OrgOps API (127.0.0.1:8788). The runner calls
the engine. Each process has a repo-owned systemd unit in [systemd](systemd);
static UIs share Caddy's service rather than running Vite preview servers.

[versions.env](versions.env) pins Node/Caddy with official artifact checksums.
The [agent CLI lockfile](agent-clis/package-lock.json) pins Codex/Claude and package
integrity. The root lockfile and submodule gitlink pin application dependencies.
OS security packages come from Ubuntu's maintained repositories. These pins make
application/runtime versions reproducible; future Ubuntu package updates are not
byte-identical OS images.

`scripts/build-host-release.sh` runs the existing npm install/UI build commands on
a separate matching Linux builder. It packages tracked source, untouched engine,
Linux dependencies and built UIs with revision/platform/pin/lock metadata. CI uses
Node 22.23.2 and a fresh Ubuntu VM, invokes the actual installer, and tests repeat
installation, paired-DB rollback, runner registration/recovery and a real agent
turn against a local synthetic provider. No production credentials are used.
Successful main builds publish `native-<full SHA>` GitHub Releases. Only Linux x64
is published by CI; the installer also understands arm64 for local rehearsal.

Application releases live under `/opt/nest/releases/<SHA>`, with `/app` as their
stable symlink. Source/dependencies are root-owned. Persistent engine/product/files
live in `/var/lib/nest`, linked into each release. Generated engine/file aliases point at persistent
storage and are repaired atomically; removing an old release does not break them.
API/engine/runner run as `node`,
Caddy as `caddy`. Memory/CPU/task budgets live in the units, not manual host tweaks:
320 MiB product API, 512 MiB engine, 768 MiB runner within 1536 MiB RAM, 512 MiB
swap, 80% CPU and 384 tasks. Caddy has a separate 128 MiB cap. The installer preserves existing swap and adds
a persistent 2 GiB swap file when the host has less than about 2 GiB available
swap capacity; container rehearsals leave the outer host swap untouched. These are process
budgets, not per-agent sandboxes. Builds belong off the production VPS.

## Operator inputs

- **Secrets:** supply a private Node dotenv file on first install. Preserve the
  existing `NEST_MASTER_KEY` and `NEST_RUNNER_TOKEN`; changing the encryption key
  breaks stored secrets. Include provider/Google/Composio settings as needed.
  The installer stores it as `/etc/nest/runtime.env` with mode 600. Never upload
  it as a release artifact or print it to debug configuration.
- **Agent logins:** log into Codex as `node`, with `HOME=/home/node` and
  `CODEX_HOME=/app/.nest-data/codex-home`. Configure Claude with its normal
  interactive/setup-token flow under that account. Tokens stay private. The
installer installs pinned CLIs; it cannot authorize subscriptions/accounts.
  Node/npm/npx are linked into `/usr/local/bin` so existing wrapped bridges with
  a restricted PATH can launch those CLIs. Activation rollback restores any
  previous commands at those paths.
- **DNS/firewall:** point the domain at the host and permit 80/443 and operator
  SSH. APIs remain loopback. Caddy obtains/renews TLS. A localhost HTTP domain
  such as `http://127.0.0.1:8080` is supported for isolated rehearsal.
- **Backups:** the installer snapshots both stopped SQLite databases and previous
  configuration/release pointers in private `/opt/nest/backups/host-*` folders.
  Keep encrypted off-host backups of the **entire** `/var/lib/nest`, private env,
  `/home/node`, `/var/lib/nest-caddy`, private Compose/ops files and authorized
  deployment keys too. DB snapshots alone exclude workspaces, uploads, Codex
  logins, runtime skills and demos. Test a full restore on an isolated host with
  outbound agent/provider actions disabled.

## Docker import

After reviewing the native release, first deploy that **same SHA** in Docker.
Take an off-host private backup and retain operator SSH. Then run the installer
with `--import-docker`. It checks the existing image revision, preserves UID/GID
1000, stops the old watchdog/containers, records restart policies, verifies runtime
copies, imports home/TLS/env and activates native services. Existing volumes remain
untouched. The imported environment must round-trip through Node's dotenv parser;
unsafe quoting fails rather than damaging credentials. Custom storage roots need
an explicit migration review. No live engine database is silently rewritten.

The installer replaces the reviewed root-owned deployment controller while
preserving its restricted SSH key/interface. Native `deploy <main SHA>` downloads
the matching CI release and invokes this same script; `restart` uses systemd.
The existing health watchdog also handles native service failures with the same
three-observation threshold, one-hour cooldown and deployment lock. It leaves
intentionally stopped services alone. No agent root shell or on-host build is added. Installing source does not update
other existing hosts; each host must run the installer.

Before inviting users back, verify Google login/return, a wrapped Codex turn,
Composio/GitHub, projects/uploads, demos and deployment access using real accounts.
The synthetic CI turn does not prove those external credentials work. Observe
memory/swap and test reboot with operator SSH available. Retain Docker/volumes
through an observation period; uninstalling Docker is separate cleanup.

## Recovery

A pre-open activation failure restores the previous database pair/config/release.
The installer pauses the public proxy during schema migration and checks engine
health, runner heartbeat and anonymous demo denial before opening traffic. Do not
restart an old engine against new schemas. Keep the reported backup directory.

After a successful activation accepts writes, **do not restore an old snapshot**
over new messages. Stop traffic and both APIs/runner, take a new full backup, and
copy the latest engine/product/files/workspaces back to the old stopped Docker
volumes before starting the same-version image. Schema/version rollback requires
the matching pre-upgrade DB pair plus an explicit decision about subsequent
writes. Never run both backends against the same state. Restore old container
restart policies/watchdog only once the native services are disabled.

Local CLI upgrades now also stop all local writers, wait for complete process
trees/registered Linux services and create private archives before replacing
source. Failed updates stay stopped for explicit recovery. Linked/custom runtime
roots and registered launchd/Windows services need an offline operator procedure.
Native releases reject in-place CLI builds and point to the host installer.
