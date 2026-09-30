# Nest

Nest is a branded control plane for human and AI-agent collaboration, built on
[OrgOps](https://github.com/camplight/orgops) as a pinned Git submodule.

Nest owns the user experience, product API, branding/settings database, CLI and
deployment. OrgOps owns agents, events, channels, runners and execution. The
engine source stays untouched; Nest integrates through its HTTP/WebSocket API.

```text
Browser → Nest UI → Nest API ─→ Nest product SQLite (settings/audit)
                       └─────→ OrgOps API / WebSocket → OrgOps SQLite + runners
```

## Get started

Use Node 22.12+ and npm. Clone with submodules:

```sh
git clone --recurse-submodules https://github.com/camplight/nest.git
cd nest
npm ci
cp .env.example .env
npm run dev:all
```

Existing checkout: run `npm run engine:install` before installing dependencies.
Admin UI: http://localhost:5173; user UI: http://localhost:5190; product API: 8787;
internal OrgOps API: 8788. Set `NEST_LLM_STUB=1` for development without model keys.
Configure credentials in `.env`; defaults are for local development only.

## Source layout

- `apps/admin-ui`, `apps/user-ui`, `apps/nest-brand`: Nest's React interfaces.
- `apps/api`: Nest Hono API, branding routes and authenticated engine gateway.
- `packages/orgops-client`: engine adapter and Nest protocol compatibility.
- `packages/db`, `packages/schemas`: Nest product data and validation.
- `apps/cli`: Nest installer/operator CLI; initializes upstream submodules.
- `vendor/orgops`: untouched engine at a reviewed commit.
- `scripts`: process launchers and explicit offline migration.
- `deploy`, `docker`: deployment composition and host operations.

The two databases are intentionally separate: `.nest-product/nest.sqlite` is
Nest's product data; `.nest-data/nest.sqlite` remains the engine DB at its legacy
location. Nest request handlers never query engine tables directly.

## Commands

```sh
npm run dev:all                  # APIs, UIs and runner
npm run start:api:env            # product API + embedded OrgOps API
npm run start:runner:env         # upstream runner through the Nest launcher
npm run build                   # both product UIs
npm test                        # product/engine integration and migration tests
npm run test:engine             # tests from the untouched engine
npm run lint                    # selected Nest and OrgOps workspaces
npm run --workspace @nest/cli test
```

Set `ORGOPS_URL` to use an external engine. All browser traffic still goes through
Nest's API, which forwards caller credentials rather than injecting an admin key.

## Brand your instance

The instance owner can change its name, logo and palette in **Admin → Branding**.
Both interfaces and sign-in screens use those settings and retain **Powered by
Nest** in the footer. Settings and product audits persist in Nest's own database.

## Deployment and upgrades

The Docker image supervises separate Nest and OrgOps processes behind one origin.
`deploy/compose.yaml` mounts separate product, engine and upload volumes. A
recursive checkout is required to build the image; do not use a bare Git archive.

**Existing deployments require the offline migration and new product volume.**
Read [migration instructions](docs/SUBMODULE_MIGRATION.md) before replacing the
old monolithic image. Production is not changed simply by updating this checkout.

See [implementation spec](docs/SPEC.md), [deployment record](deploy/DEPLOYMENT.md),
and [host operations](deploy/devops/README.md). Engine behavior is documented in
[OrgOps's own spec](vendor/orgops/docs/SPEC.md).
