# Nest product API

Hono backend-for-frontend for the Nest interfaces. It owns branding/settings and
product audit in `.nest-product/nest.sqlite`. Engine requests and WebSocket
messages go through `@nest/orgops-client` to OrgOps; this service does not open
OrgOps's database or inject a privileged credential into browser requests.

Start the local API pair with `npm run start:api:env`, or set `ORGOPS_URL` before
`npm run --workspace @nest/api start` to use an existing engine.
See [the product spec](../../docs/SPEC.md) and [migration guide](../../docs/SUBMODULE_MIGRATION.md).
