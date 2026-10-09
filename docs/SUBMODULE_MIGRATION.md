# OrgOps submodule migration

Nest now owns the product layer; `vendor/orgops` owns the execution engine.
The submodule initially pins `c78698d`, the engine revision used before Nest's
rebrand, to separate this restructuring from an upstream functionality upgrade.
There is no engine source patch queue or generated fork.

## Development

```sh
git clone --recurse-submodules https://github.com/camplight/nest.git
cd nest
npm ci
cp .env.example .env
npm run dev:all
```

For an existing checkout, run `npm run engine:install` before `npm ci`.
Do not edit `vendor/orgops`. Change Nest UI/API/client/launcher code for product
features. Contribute engine changes to OrgOps separately, then update the gitlink.
The parent npm lockfile locks the combined workspace dependency graph.

## Existing installations

The CLI refuses automatic upgrade of a legacy installation with the branding
migration and engine data; complete this one-time offline migration first.
Subsequent CLI backups include the product directory.

Do not deploy this layout over the old image without preparing the host:

1. Initialize recursive submodules in the source checkout and build the new image.
2. Add the `nest-product` volume from `deploy/compose.yaml`. It must mount at
   `/app/.nest-product`. Keep the engine, files, runner ID and Codex volumes unchanged.
3. Stop the Nest API and runner. Back up the current image reference, Compose
   files, environment and persistent volumes. Backups contain credentials; keep
   them private.
4. Run the migration with the new image/tools while services are stopped:

   ```sh
   node --import tsx scripts/migrate-product-data.ts \
     .nest-data/nest.sqlite .nest-product/nest.sqlite
   # Inspect the dry-run result, then use a new private backup directory:
   node --import tsx scripts/migrate-product-data.ts \
     .nest-data/nest.sqlite .nest-product/nest.sqlite \
     --apply --services-stopped /path/to/private/backup
   ```

5. Start the new image and check `/health`, login, `/api/branding`, both UIs,
   WebSocket messaging, runner heartbeat and a wrapped-agent turn. Existing human
   sessions expire on restart as before; sign in again.
6. If startup fails, stop services and restore both database snapshots and the
   previous image. Workspaces and uploads keep their existing volumes. Database
   writes during a failed startup window are discarded on rollback.

The migration copies branding only when no product branding exists, preserves
engine resource IDs and stored workspace paths, and makes wrapped commands
compatible with upstream environment names. No engine DB is read by Nest's API.
Existing `.nest-data/...` workspace paths resolve through a compatibility link.
Copy any custom skills previously installed in `/app/skills` into
`/app/.nest-data/engine/skills` before starting agents; built-in skills are seeded
from the pinned engine. Review any other relative workspace paths and convert
them to absolute paths before migration.
For an ordinary fresh install, no migration is needed.

The repository host controller source in `deploy/devops/` supports submodule
initialization and both DB snapshots. Install that controller and the Compose
volume update through the existing operator SSH connection before enabling its
new deployment flow. The already-running host controller is not automatically
changed by a repository update. The first production migration on 2026-10-01
is recorded in [the deployment record](../deploy/DEPLOYMENT.md).

## Upgrade OrgOps deliberately

```sh
git -C vendor/orgops fetch origin
git -C vendor/orgops checkout <reviewed-commit>
npm install
npm test
npm run test:engine
npm run lint
npm run build
git add vendor/orgops package-lock.json
```

Review schema changes before upgrading the engine. Keep secrets out of commits.
GitHub Actions checks out recursive submodules. Nest CLI install/upgrade also
initializes them. `git archive` alone does not include submodule contents; use a
recursive checkout to build an image or release.

Existing Git history is preserved for auditability. This change replaces source
ownership; it does not rewrite history or change GitHub fork-network metadata.

## Validation at the initial pin

Product integration tests cover actual upstream HTTP authentication, owner access,
separate branding persistence, binary uploads, WebSocket authorization/messaging,
and migrated wrapped-command execution. The Docker image has been smoke-tested
with both UIs, login, branding and a registered runner. The CLI build and smoke
suite run separately.

The pinned engine suite is not entirely green: five process API tests create a
process for an absent `test-agent` and receive 403 rather than their expected 201
on Linux and macOS. macOS also shows a shell-status timing failure. These tests
run directly against untouched OrgOps, without Nest's gateway. Track/fix them
upstream before treating an engine upgrade as fully verified; do not suppress
or rewrite vendor tests in Nest.

## Upstream update — 2026-10-09

The current pin is `f87d7c9a0a21066baf23ee8bd55aa54573c84ae6`, advancing
three commits from the initial pin. It includes upstream test fixes (#41),
turn-failure rendering in upstream's user UI (#42), and multi-root skills,
human-scoped secrets and delegated private ownership (#43). Nest keeps its own
UI, so upstream UI changes are not automatically adopted.

Engine migration `036_agent_skill_roots_and_owner_secrets.sql` adds two agent
columns with defaults `[]` and disabled secret delegation. Existing launcher
configuration explicitly sets the engine project root. No dependency manifests
changed upstream; reconciling the parent npm lockfile produced no changes.

Nest's 41 integration/unit tests, workspace type checks, both UI builds and
Projects/Community browser suites pass. The upstream engine
suite initially passed 189/193 tests on macOS. A single-worker rerun of the three
failing files resolved both shell environment timeouts, leaving two failures:

- `packages/skills/src/index.test.ts:134` assumes directory enumeration returns
  `only-a` before `dup`; this filesystem returns the reverse order.
- `apps/agent-runner/src/runner.test.ts:2709` still reports a short-lived process
  running at its fixed-delay assertion, matching the previously recorded macOS
  failure.

No vendor code or tests have been patched or suppressed. The operator authorized
merging and deploying this upgrade with these validation limits recorded.
Production rollout uses the existing controller to back up both databases and
restore the previous image and databases if health checks fail.
