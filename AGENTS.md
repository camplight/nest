# Nest development

Nest owns the product UI/API and uses **untouched OrgOps as a Git submodule** at
`vendor/orgops`. Read `docs/SPEC.md` and `docs/SUBMODULE_MIGRATION.md` before
architectural changes. Keep them synchronized when APIs or runtime behavior change.

## Boundaries

- `apps/api`: Nest Hono API and WebSocket gateway. No engine DB reads here.
- `packages/orgops-client`: all engine HTTP/credential adaptation.
- `packages/db`: Nest SQLite settings, projects/tasks/reviews, private community packages/tokens and product audit; never engine state.
- `packages/schemas`: product schemas for branding, projects and community.
- `apps/admin-ui`, `apps/user-ui`, `apps/nest-brand`: Nest-owned React interfaces.
- `apps/cli`: Nest installer/operator CLI using upstream LLM library.
- `scripts/start-orgops.ts`: launcher/configuration adapter for upstream processes.
- `vendor/orgops`: upstream API, runner and packages; **do not edit or patch**.

OrgOps owns humans, permissions, sessions, agents, events, channels, files,
secrets, runner assignment and execution. Nest calls HTTP/WS for those features.
Engine improvements belong in OrgOps first, followed by a reviewed submodule bump.
Read the submodule's `AGENTS.md` for upstream internals, not as permission to edit it.

## Commands

Use npm, not pnpm. Clone recursively or run `npm run engine:install` before
`npm ci`. The parent npm lockfile includes selected upstream workspaces.

```sh
cp .env.example .env
npm run dev:all
npm test
npm run test:engine
npm run lint
npm run build
npm run --workspace @nest/cli test
```

Track numbered product migrations under `packages/db/migrations`; keep product
types in `packages/schemas` synchronized. Project UI work follows `docs/ROADMAP.md`.

Tests are colocated. `npm test` excludes vendor tests; `test:engine` runs them
separately. The CLI uses node:test. Scripts use Node 22.12+ / tsx. Test the actual
adapter/engine boundary rather than mocking away the ownership separation.

## State and compatibility

- `.nest-product/nest.sqlite`: Nest product state.
- `.nest-data/nest.sqlite`: engine state (legacy location kept intentionally).
- `.nest-data/engine/skills`: writable runtime skill copies.
- `files/`: uploads. All runtime directories are gitignored.

NEST environment variables, headers and cookies are translated at boundaries.
Offline migration moves old branding and adds aliases to stored wrapped commands;
never silently migrate a running production DB. Preserve runner IDs, workspaces,
Codex logins, demos and private deployment credentials during upgrades.

The Docker image can run both APIs and the runner under one supervisor or point
Nest at an external engine via ORGOPS_URL. Host self-deployment needs recursive
submodule checkout, a product volume and snapshots of **both** databases. Updating
controller source does not install it on the host.

Use functional factories and dependency injection. Conventional commits. Do not
maintain CHANGELOG.md by hand. Never expose credentials in logs or commits.
