# Current production deployment

Updated 2026-10-01 after merging PR #2 and migrating production to Nest's
product API/SQLite over an untouched OrgOps submodule. Existing humans, agent
workspace, uploads, runner identity, Codex login and branding were retained.

- User UI: https://nest.camplight.net/
- Admin UI: https://nest.camplight.net/admin/
- Health: https://nest.camplight.net/health
- Linode: `nest-production`, ID `106230482`, Frankfurt (`eu-central`)
- Plan: `g6-standard-1`, 2 GB RAM, $12/month at deployment time
- IPv4: `172.105.78.86`
- Firewall: `173212963`, inbound TCP 22/80/443, other inbound traffic dropped
- DNS: zone `592954`, record `46304812`, A `nest`, TTL 300
- SSH: `root@172.105.78.86`, using the approved `~/.ssh/id_exe` key
- Server deployment directory: `/opt/nest`
- 1Password: **OrgOps POC → nest-production** (username, password, runner token,
  encryption master key). No production credentials are committed to this repo.
- Image: `nest:git-ebdcc0e51316` (selected in server `compose.override.yaml`)
- Running image ID: `sha256:3232a20b71d62c6835295a21d1009f15a53e1b933b7089136d6d75659334b37b`
- Source: merged main commit `ebdcc0e5131657b834135e83d051c33c48369a54`.
- OrgOps submodule: `c78698d73155bca15cfbb1bc7831d89e47804624`, unchanged.
- Previous image: `nest:git-2b711e50570b`
- Latest deployment backup: `/opt/nest/backups/submodule-20261001-ebdcc0e51316`
  (stopped runtime volumes, engine SQLite, environment, Compose and old controller).
- Successful operation: `e90161edd9c74fff8a080f96319f26c1`.
- Separate product volume: `nest_nest-product`, mounted at `/app/.nest-product`.
  Branding was moved into its SQLite DB and matched the old snapshot exactly.
- Updated host controller installed; NestSystem can query it through its existing
  restricted DevOps key. Future deployments snapshot both databases.
- Pre-update backup: `/opt/nest/backups/whitelabel-20260923-213519`
  (stopped database/uploads archive, environment, deployment configuration, previous image ID)
- Original runner identity restored and persisted at `/app/.nest-data/runner-id`
  through `NEST_RUNNER_ID_FILE`, preserving existing agent assignments on recreation.
- `NestSystem` runs through Codex CLI with its existing ChatGPT subscription.
  Its migrated wrapped recipe produced a real verification reply. GitHub ADMIN
  access was verified from its uid-1000 runtime after container replacement.
- Camplight settings from [camplight-branding.json](camplight-branding.json) are
  persisted in SQLite. The instance owner can edit them under Admin → Branding.
  Both interfaces display Camplight at the top and Powered by Nest at the bottom.
- NestSystem has authenticated GitHub access and an explicitly approved,
  restricted host operations endpoint. Restart and deployment from its runtime
  were verified, including persistence of GitHub authentication and the Kibrit
  demo. See [NestSystem operations](devops/README.md).

Caddy manages the Let's Encrypt certificate and HTTP-to-HTTPS redirect.
Both containers restart automatically. SQLite and uploads use persistent
Docker volumes; the production environment file has mode 600.

Verified after this update: public HTTPS health, both UIs, unchanged Camplight
branding, owner login/access, authenticated WebSocket ping, the original runner
online, a real Codex reply, GitHub access, restricted DevOps status and the Kibrit
page checksum. Merged-main product CI and CLI release builds passed. See the
[migration guide](../docs/SUBMODULE_MIGRATION.md) for pinned-upstream test limits.

For status and logs on the server:

```sh
cd /opt/nest
docker compose ps
docker compose logs --tail=100
```
