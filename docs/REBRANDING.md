# Nest branding and migration

Nest's repository is [camplight/nest](https://github.com/camplight/nest). The local fork retains its upstream history; the original attribution remains in `NOTICE`.

## Canonical names

| Surface | Nest name |
| --- | --- |
| npm workspaces | `@nest/*` |
| CLI workspace / directory | `@nest/cli` / `apps/cli` |
| CLI command / release binaries | `nest` / `nest-linux`, `nest-macos`, `nest-windows.exe` |
| Configuration | `NEST_*`, including `NEST_CLI_*` |
| Fresh database | `.nest-data/nest.sqlite` |
| CLI state | `~/.nest/nest-state.json` |
| CLI state override | `NEST_CLI_STATE_DIR` |
| Component PID state | `.nest-runtime/` |
| Upgrade backups | `.nest-backups/` |
| Human session cookie | `nest_session` |
| Runner headers | `x-nest-runner-token`, `x-nest-agent-name`, `x-nest-channel-id` |
| Embedding header / file links | `x-nest-conversation` / `nest://file/<id>` |
| Runtime UI configuration | `__NEST_UI_CONFIG__`, `__NEST_USER_UI_CONFIG__` |
| macOS services | `com.nest.<component>` |
| Linux services | `nest-<component>` |
| Windows tasks | `NestApi`, `NestRunner`, `NestAdminUi`, `NestUserUi` |

Install and upgrade default to `https://github.com/camplight/nest.git`, branch `main`. Override the source with `--repo` or `NEST_REPO_URL`. Upgrade retains the repository/ref saved by a prior Nest installation unless explicitly overridden. Installing into an existing checkout points that checkout's `origin` at the selected repository.

## Existing installations

- Server, runner, CLI and skill environment reads accept legacy `ORGOPS_*` variables when the equivalent Nest value is absent; `NEST_CLI_*` accepts the former `ORGOPS_OPSCLI_*` names. Set only the Nest name when updating configuration. Explicit Nest values take precedence.
- The CLI's saved runner configuration reader also accepts legacy keys in `.env` files. An explicitly empty Nest token does not fall back to a legacy credential.
- Existing `.orgops-data/orgops.sqlite` is reopened when there is no Nest database. A new `.nest-data/workspaces` directory alone does not hide the old database. No database or workspace is moved automatically. Explicit `AppConfig` paths still take precedence.
- Legacy session cookies, runner headers, embedding conversation headers, file links, and injected UI configuration remain accepted. Newly generated identifiers use Nest. Sessions remain in-memory and do not survive server restarts, as before.
- Runner child processes expose both environment prefixes so stored wrapper commands and installed skills continue to work. Stored `.orgops-data/` working directories remain supported.
- Upgrade backups include both runtime data directory names. Legacy and Nest runtime data remain excluded from Git and Docker build contexts.
- Before replacing an existing deployment, stop and unregister its old services using the old CLI. Then install/register the Nest services. CLI state, service registrations, and PID files are separate identities; the rebrand does not automatically modify running services or migrate `~/.orgops` state. Point the Nest CLI explicitly at the existing installation with `--dir`.
- For Docker migration, retain the existing data mount at `/app/.orgops-data` until deliberately migrating the volume. Fresh Nest containers use `/app/.nest-data`. Keep the existing master key so encrypted secrets remain readable.

## Verification

All workspace TypeScript checks, both UI builds, CLI Node-runner tests, and five new environment/auth/data compatibility tests pass. Browser smoke checks exercise both branded UIs with mocked API data. The macOS Nest release executable also builds and passes the CLI smoke flow: help, doctor, mocked install/upgrade, component start/status/stop, admin UI lifecycle, and stubbed chat.

The initial full-suite comparison with unchanged upstream `c78698d` found the same five process-authorization fixture failures and one process-exit timing failure in both trees. These upstream test issues remain unresolved.

The continuation pass fixes the CLI smoke workflow to invoke the `@nest/cli` workspace, excludes Node-runner CLI tests from Vitest discovery, and moves the database migration test's files into an isolated temporary directory (the old path was outside the checkout). All workspace TypeScript checks and both UI builds pass. All six CLI tests pass, including three saved runner configuration compatibility checks; the six focused API branding, runner environment, and database migration tests also pass. The full Vitest run before the database fixture fix had 187 passing tests, the six known failures above, and the out-of-checkout database failure; the database test passes after the fix.

## White-label instances

Instance owners can configure the organization name, logo and colors under
**Admin → Branding**. Settings persist in SQLite and apply to both UIs and their
sign-in screens. The organization logo appears at the top; the Nest signature
appears beside “Powered by” in the sidebar footer. Use a horizontal logo suited
to the sidebar color. Upload PNG/JPEG/WebP (up to 250 KB), use an HTTPS image URL,
or select a bundled `/brand/` asset. Restore defaults and save to return to Nest.

Camplight's official horizontal SVG is bundled locally from
`https://camplight.net/wp-content/uploads/2020/05/camplight-logo-horizontal-positive.svg`.
The white variant changes the purple wordmark to white for dark sidebars; the
coral mark retains its original color. Deployment values live in
`deploy/camplight-branding.json`, separate from the reusable product defaults.
