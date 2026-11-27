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

[versions.env](versions.env) pins Node/Caddy/LiveKit with official artifact checksums.
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

## Voice service

Nest's chat toolbar opens the audio Huddle interface, backed by OrgOps voice APIs.
Spoken agent replies require a configured voice-capable model and provider key;
human-only calls have no automatic transcription. To provision the local SFU, add `--enable-livekit` to the
normal installer command, or set `NEST_ENABLE_LIVEKIT=1` in the private installed
environment before deploying through the restricted controller. The choice is
persisted across upgrades. No Docker service or separate DNS record is needed.

The installer generates LiveKit credentials once in `/etc/nest/runtime.env` and
renders private `/etc/nest/livekit.yaml`. It runs the pinned binary under its own
`nest-livekit` account as `nest-livekit.service`, capped at 256 MiB within the Nest
slice. Systemd recovers an SFU crash without restarting APIs or agents. Existing
external `LIVEKIT_URL` configuration is never silently replaced.

Caddy exposes `wss://<Nest domain>:8443`, forwarding to loopback port 7880. Permit
8443/TCP for signaling, 7881/TCP and 7882/UDP for media in host/cloud firewalls;
the installer adds these rules when UFW is already active. Never expose 7880.
Restrictive networks may need a future TURN/TLS service; it is not configured by
this rollout. See [LiveKit's port reference](https://docs.livekit.io/transport/self-hosting/ports-firewall/).

Fresh-host CI enables the SFU and checks actual synthetic audio between two
authenticated clients, reinstallation with unchanged keys, activation rollback,
and independent crash recovery. Operators can run the same bounded check without
creating product chats or spending model credits:

```sh
sudo runuser -u node -- /opt/nest/node/bin/node \
  --env-file=/etc/nest/runtime.env /app/deploy/native/livekit-smoke.mjs
```

Pre-open rollback restores the SFU configuration, credentials, unit and binary
pointer with the DB pair. Include engine payload/publication blob directories in
full-state backups: a new SQLite snapshot alone is insufficient for this engine.

## Docker import

After reviewing the native release, first deploy that **same SHA** in Docker.
Take an off-host private backup and retain operator SSH. Then run the installer
with `--import-docker`. It checks the existing image revision, preserves UID/GID
1000, stops the old watchdog/containers, records restart policies, verifies runtime
copies, imports home/TLS/env and activates native services. Existing volumes remain
untouched. The imported environment must round-trip through Node's dotenv parser;
unsafe quoting fails rather than damaging credentials. Custom storage roots need
an explicit migration review. No live engine database is silently rewritten.

Application activation and rollback do not install the restricted controller.
The new controller source rejects legacy native `deploy <SHA>` without running
checkout code. Existing installed controllers are unchanged. Protocol v2 is
fixture-only pending the private workflow and verified release gates.
The watchdog still uses the three-observation threshold, one-hour cooldown and
shared deployment lock; it leaves intentionally stopped services alone.

Before inviting users back, verify Google login/return, a wrapped Codex turn,
Composio/GitHub, projects/uploads, demos and deployment access using real accounts.
The synthetic CI turn does not prove those external credentials work. Observe
memory/swap and test reboot with operator SSH available. Retain Docker/volumes
through an observation period; uninstalling Docker is separate cleanup.

## Recovery

A reversible pre-cutoff failure restores the previous database pair/config/release.
The installer keeps ingress and the normal runner stopped through API readiness
and anonymous access checks. It records the durable cutoff before starting either;
runner freshness and public ingress are checked afterward. A post-cutoff failure
never restores a snapshot automatically. Do not restart an old engine against
new schemas. Keep the reported backup directory.

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

## Disk headroom and release retention

The controller rejects downloads unless the filesystem has room for a bounded
2 GiB artifact plus 2 GiB of space available to unprivileged services (not root's
reserved blocks). Downloads are capped at 2 GiB. The installer checks actual
expanded archive allocation, both databases/WALs, a second copy for migration or
rollback, and 3 GiB for tool installation/first-host swap before unpacking or
stopping services. It checks snapshot space again immediately before downtime.
The 2 GiB service reserve remains throughout these estimates; concurrent agent
writes can still consume space, so monitor disk usage independently.

After successful activation, retention removes only recognized immutable release
directories, keeping the active release, the three newest releases, and releases
referenced by the three newest host snapshots. Runtime symlinks are not followed;
legacy directories containing real runtime data, unknown directories and mounts
are skipped. Databases, backups, workspaces, uploads and credentials are never
pruned. Older DB snapshots remain available, but restoring them may require
redownloading their matching GitHub release artifact. Cleanup failure is reported
without rolling back a release already serving users.

An unverified rollback, interrupted activation, or post-cutoff health failure
leaves `/var/lib/nest-watchdog/recovery-required`. The timer may still run, but
cannot restart services under that gate. Do not clear it until the active
DB/config/release pair is known coherent and the operator has resolved the outage.
The installer does not provision the independent systemd start guards needed for
v2. A managed install uses the independently installed activation helper for
both checkpoint transitions and runner probes, so the systemd guard and the
installer agree on the checkpoint format. The guards and recovery hooks must
be proven on a disposable host before any production rollout.

### Existing native controller: failure after activation

Merging Phase 1 does not replace an installed controller or start a deployment.
The next legacy native `deploy <SHA>` does use the new installer in unmanaged
mode. It sets the recovery marker before activation and, after opening ingress
or enabled runner work, checks for a fresh runner heartbeat and probes public
`/health` and `/admin/` (four bounded retries per route). A temporary ingress
or TLS failure can fail the deploy after the release is already active. The
legacy job reports failure; no alert is sent by this path. Live writes are
preserved, there is no automatic snapshot rollback, and while the marker is
present the watchdog will not restart services and subsequent installs refuse
activation. The timer may still be running; that is not proof of recovery.

An operator should use independent host access to inspect the failed job logs,
`/opt/nest/operations/activation.json`, `/etc/nest/native.json`, and the `/app`
release pointer. Check both databases and their matching configuration/release,
public TLS and health/UI, and the runner heartbeat or intentional pause. If the
checkpoint is still `cutoff` and the active candidate is coherent and healthy
after fixing or rechecking the problem, record an explicit resolution and clear
the gate under the deployment lock. Use the root-owned host helper for managed
installs or the active reviewed release's helper for an unmanaged install:

```sh
op='<operation_id from the inspected checkpoint>'
helper=/app/deploy/native/activation.py # managed: /usr/local/lib/nest-ops/activation.py
sudo flock -w 5 /opt/nest/operations/deployment.lock bash -ec '
  /usr/bin/python3 -I "$1" resolve "$2"
  /usr/bin/python3 -I "$1" clear "$2"
' bash "$helper" "$op"
sudo systemctl enable --now nest-native-watchdog.timer
```

`resolve` records `resolved_unhealthy` in the checkpoint and leaves the failed
job result unchanged. Do not use `verify` to relabel a failed deployment. If
coherence is unknown, or the checkpoint is not the expected cutoff case, keep
the gate and use operator-led recovery. Do not restore a pre-cutoff snapshot
automatically after opening live work.

The product API starts its background project-naming worker during loopback
readiness. This is a Phase 1 limitation: a pending naming job can make a model
call or write its result before cutoff. A pre-cutoff rollback can discard that
result and the call may repeat; the normal agent runner and public ingress
remain blocked until cutoff.

## Protocol v2 rehearsal (disposable VM only)

Use an isolated Ubuntu 24.04 x64 VM with only synthetic credentials/data and
SSH access for the operator. Build the baseline from a clean test snapshot
with pinned OrgOps initialized and the Node version from `versions.env`. The
builder rejects modified tracked files and packages from `git ls-files`; to
include uncommitted work, transfer reviewed files to a scratch checkout and
record a test-only commit there. Do not publish the snapshot or its artifacts.

```sh
scripts/build-host-release.sh /tmp/nest-host-linux-x64.tar.gz
sudo bash deploy/native/rehearse.sh /tmp/nest-host-linux-x64.tar.gz
sudo bash deploy/native/rehearse-v2.sh /tmp/nest-host-linux-x64.tar.gz
```

Native CI also tests a post-cutoff failure using the pinned pre-Phase-1
controller and local Git/artifact fixtures. It injects an ingress-check
failure after a real synthetic agent turn, checks that the new write and
failed job receipt survive, and resolves the recovery gate before the v2 case.

The v2 driver requires the baseline's synthetic login and loopback domain.
It provisions independent systemd guards and a local fixture-only worker,
uses a distinct synthetic upgrade, checks replay and controller preservation,
and observes systemd's exit hook after killing a fixture worker. It does not
enable the production v2 SSH binding.

For each reboot case, use a fresh VM or reset the VM to a snapshot from after
the successful v2 rehearsal. Run `sudo bash deploy/native/rehearse-v2.sh
--prepare-reboot interrupted-before-cutoff` (or `--prepare-reboot failed-restore`),
reboot the VM yourself, reconnect, and run `sudo bash deploy/native/rehearse-v2.sh
--check-reboot`. The check requires a changed boot ID, a durable recovery
outcome, the watchdog gate, and confirmation that guarded services did not
start. The fixture intentionally leaves recovery blocked. Do not run these
commands on a production or shared host.
