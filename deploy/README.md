# Nest deployment

This stack serves the user UI at `https://nest.camplight.net/`, the admin UI at
`https://nest.camplight.net/admin/`, and the API and WebSocket endpoints on the
same origin. Caddy provisions and renews HTTPS certificates. Only ports 80 and
443 are published; Nest data and uploads persist in Docker volumes.

Build and transfer the Linux image to the destination host before starting:

```sh
docker build --platform linux/amd64 -t nest:deploy-20260923 .
```

Copy `compose.yaml` and `Caddyfile` into the deployment directory. Create `.env`
there with mode 600 and unique production values for `NEST_ADMIN_USER`,
`NEST_ADMIN_PASS`, `NEST_RUNNER_TOKEN`, and `NEST_MASTER_KEY` (32 random bytes,
base64 encoded). Keep those values in 1Password. Never use the development
credentials or copy the local development database to a fresh deployment.

After loading the image and pointing the hostname to this server:

```sh
docker compose up -d
docker compose ps
curl --fail https://nest.camplight.net/health
```

Before an upgrade, back up the database, files volume, and encrypted secrets'
master key. Retain the previous image tag for rollback. Do not run
`docker compose down -v`: it removes persistent data.

The runner ID is stored at `/app/.nest-data/runner-id` on the persistent data
volume. When upgrading a deployment that previously used an ephemeral runner
ID, preserve its existing ID at this path before recreating the container so
agents remain assigned to the same runner. Production may select its image via
`compose.override.yaml`; update that override when deploying a new image.
