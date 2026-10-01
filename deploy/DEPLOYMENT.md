# Current production deployment

Updated 2026-09-24 from the local Nest rebrand working tree, including reusable
instance branding and the Camplight configuration. Existing production data and
credentials were retained.

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
- Image: `nest:git-2b711e50570b` (selected in server `compose.override.yaml`)
- Running image ID: `sha256:d026541c87147010ceb93e26028e33b23c9c288265e282cb6b2ab1d8b00dad05`
- Source: merged main commit `2b711e50570bf63d552b6b194e1b56f39bdf7619`.
- Previous image: `nest:deploy-20260924-whitelabel`
- Latest deployment SQLite snapshot and prior override:
  `/opt/nest/backups/ops-c49c233d35bb494caf76fc52282a5183`.
- Pre-update backup: `/opt/nest/backups/whitelabel-20260923-213519`
  (stopped database/uploads archive, environment, deployment configuration, previous image ID)
- Original runner identity restored and persisted at `/app/.nest-data/runner-id`
  through `NEST_RUNNER_ID_FILE`, preserving existing agent assignments on recreation.
- `NestAssistant` agent is running through Codex CLI with ChatGPT
  subscription authentication. See [Codex agent operations](CODEX_AGENT.md).
  A real reply and follow-up memory were verified during agent setup.
  Codex login survived this container recreation.
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

Verified after this update: public HTTPS health, Camplight sign-in and logo assets,
the owner's branding editor, workspace sidebar and Nest footer, and authenticated
runner status with the original runner online. Live browser checks reported no
page errors. Login, authenticated page reloads, Secure/HttpOnly cookies, and WebSocket
connections were verified during the initial deployment. Local development data
was not copied. LLM provider keys were not changed during this update.

For status and logs on the server:

```sh
cd /opt/nest
docker compose ps
docker compose logs --tail=100
```
