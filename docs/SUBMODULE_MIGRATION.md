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

## Upstream upgrade: `f7c95b7` → `cc8faa0`

The untouched engine advances through OrgOps PRs #55, #56, #58 and #59. The parent
lockfile reflects upstream's move of `tsx` into API/runner runtime dependencies.
No Nest product migration, runner reassignment, credential rotation or installed
skill replacement is required.

The engine applies migrations `039`–`045` on startup. Migration `039` rebuilds the
agents table, combines existing stored instructions and soul content into one
`soul_contents` prompt, and drops `system_instructions` and `soul_path`. Existing
IDs, ownership, workspaces, runner assignment, skills and wrapped configuration
are retained. The previous runner already used inline soul content; this migration
does not import files from former soul paths. Nest's HTTP adapter keeps the
published `systemInstructions` field as an alias for the complete prompt, with
explicit `soulContents` authoritative when both are provided.

Before a production upgrade, stop the API and runner and snapshot both databases,
private environment and runtime volumes through the existing deployment flow.
Start the matching API/runner/UI image together, then verify login, personal-agent
creation and settings, management retries, chat targeting, connections and a
wrapped-agent turn. Rollback requires restoring the pre-upgrade engine database
alongside the previous image; the old engine cannot read the rebuilt agents table.
Keep runner identity files, Codex authentication, workspaces and runtime skills.

Usage reporting, channel invitation and copy/move/federation HTTP capabilities
come from upstream. No federation peers or channels are configured by the bump;
Nest's existing UI does not automatically gain upstream billing/federation pages.
The new default-system-agent seed remains opt-in and skips populated instances.

The Nest integration suite exercises the actual upgraded engine. A migration
fixture starts at schema `038`, runs the upstream migrator and verifies prompt
composition, preserved identities/membership/secrets/runtime configuration and
repeatability. Run `npm run test:engine` separately: upstream currently has known
skill-enumeration ordering and fixed-delay shell-status assertions; report any
failures rather than patching or excluding vendor tests. On macOS, a canonical
temporary directory (`TMPDIR=/private/tmp`) avoids `/var` symlink mismatches in
upstream file-upload tests.

Product unit/browser fixtures disable federation polling with its existing interval setting:
upstream currently leaves a poller alive after an embedded API database closes.
This avoids callbacks into disposed test databases; it does not change production
configuration or exclude any upstream federation tests.

The home dashboard summary (`GET /api/projects/dashboard`) lives in Nest's
project API. It aggregates product tasks only after the current human/project and
live engine channel access checks. It adds no engine endpoint, DB migration,
runner change or source overlay. Cost/operational issue data is explicitly
unavailable; private community previews use Nest's existing catalog API.

Connection activation uses the unchanged engine's `alwaysPreloadedSkills` field
so the next turn receives Nest's helper instructions. Upgrades add no migration
or engine patch. Existing owners must save at least one tool grant and use Renew
skill access to enable preloading; there is no automatic account consent or
credential rotation. Installed runtime skill copies remain untouched.

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

The previous pin was `f87d7c9a0a21066baf23ee8bd55aa54573c84ae6`, advancing
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


## Google Workspace authentication upgrade

The new pin is `59fe050772ea2cac9df06e2028c4bb74882d83be`.
OrgOps PR #44 adds migration `037_google_identity.sql` with identity and sign-in
settings tables. Existing humans/passwords are preserved and Google sign-in starts
disabled. The dependency adds Google's authentication SDK; the parent lockfile is
reconciled. Nest adds login/admin interfaces without editing engine source.

Configure secrets only in the private server environment and enable the domain
through the owner's **Sign-in** screen after rollout. Deployment snapshots both
databases before engine migrations run. Keep the local owner login available.
See [Google Workspace setup](GOOGLE_WORKSPACE.md). The focused upstream API,
authentication and WebSocket suite passes 96 tests. The full upstream suite passes
205/207 on macOS with the same two known failures listed above.

The final pin uses the merged PR #44 commit, rather than its pre-merge branch tip.
Its intervening upstream changes add sensitive-message event handling and upstream
JSON-render/secret-input UI support. Nest still builds its own UI, so those upstream
UI components are not automatically exposed here. Sensitive-message reveal requires
a local password; Google-only accounts do not have one. No additional database
migration is introduced by those intervening changes.

Validation against the merged pin on 2026-10-12: Nest's 43 product tests pass.
`npm run test:engine` passes 206/208 tests, retaining only the two recorded macOS
failures (shell-status timing and skill-directory enumeration).

## Upstream update — project-first onboarding

Pin `0b383c5507218ee78f8bc99b3d6184eb019ad1cc` advances three merged commits beyond PR #44:
dependency remediation, upstream admin styling, and HUMAN channel participants
in agent tools (#48). No migrations were added. The parent lockfile reconciles
the runner's Vitest dependency; upstream admin styling remains upstream-owned.
PR #49's Google membership migration is not merged and is not included.

Validation: 43 Nest tests, full type checks, both UI builds and all four browser
suites pass. Engine tests pass 209/211 on macOS; only the previously recorded
shell-status fixed-delay assertion and skill-directory ordering assertion fail.
No vendor files were edited.

## Personal-agent onboarding dependency update

The reviewed pin `3e3ed36` includes merged OrgOps PR #49. Migration `038` repairs
Google memberships to use the engine's HUMAN/username representation; new Google
logins receive valid team membership. Nest tests assert that membership after
OAuth. No dependency manifests changed and the parent lockfile remains unchanged.

Composio PR #50 was subsequently closed; it must not be merged or added to the
submodule as a release dependency. Connections will move to a Nest adapter and
instance skill layer. The Nest adapter below replaces the compatibility probe without upgrading core.
Candidate-core browser tests were historical prototype validation. Rollout still snapshots both product and engine DBs.

Validation of `3e3ed36`: 52 Nest product tests pass, full workspace/script typechecks
and both UI builds pass. The unchanged engine suite passes 210/212 on macOS;
only the previously documented process-status timing and skill-directory ordering
assertions fail. No vendor source or tests are patched or suppressed.

## Model selection overlay

Nest's model catalog/default and selectors use the existing model registry and
agent HTTP endpoints at the unchanged `3e3ed36` pin. No engine source changes or
migrations are needed. Preserve existing model registry rows during rollout,
register the desired new model separately, and configure
`NEST_DEFAULT_AGENT_MODEL_ID` in the private environment. Follow normal dual-DB
snapshot and rollback procedures. Existing agents are not bulk rewritten.

## Personal agents in the team directory

Personal-agent creation and connected-account controls now live under Agents.
The existing onboarding endpoints, reservation IDs and engine ownership checks
are unchanged. Old setup/OAuth return links redirect to the owning agent's
settings, so existing connection callback configuration needs no migration.
No upstream pin change, schema migration or bulk agent update is required.

## Lightweight setup navigation and settings

The Nest API adds authenticated `/api/onboarding/summary` and
`/api/onboarding/connections` read endpoints. These reuse the existing product
setup mappings; the later connection adapter reads local Nest configuration. No database migration, engine
pin change or provider configuration is required. Deploy UI and API together;
private setup recovery and existing OAuth return paths remain compatible.

## Nest-owned connections

The pin remains `3e3ed36`. Product migration `005_integrations.sql` adds connection
mappings, exact tool grants and hashed skill capabilities. No engine migration or
source patch is required. The bundled Nest skill is seeded into writable runtime
skills only if absent; existing copies are preserved. External engines need an
explicit skill installation. Provider service configuration is stripped from both
engine child processes. Configure the Nest API and remote-runner product URL as
explained in [PERSONAL_AGENTS.md](PERSONAL_AGENTS.md).

There is no automatic migration from the abandoned core Composio prototype or
its service-key skill. Deploy UI and API together, preserve private agent secrets
and existing skill roots, and snapshot both databases before product migration.
Do not advertise live connectivity until OAuth, model execution and revocation
have been verified with an owner-authorized test account. Runtime isolation and
mention delivery remain outside this adapter change.

## Nest selected mention delivery

The engine remains pinned to `3e3ed36`. Nest now uses the existing event ID,
idempotency key and `payload.targetAgentName` API fields for selected mention
routing. Product migration `006_mentions.sql` adds send-intent hashes, planned
engine event IDs, delivery confirmations and human notification read state.
No message text or attachments are duplicated into product storage and no engine
migration, core mention parser or source patch is introduced.

Deploy the user UI and Nest API together. Snapshot both databases using the
existing operator deployment flow before applying the product migration. Preserve
existing channels, runtime skills, connected-account configuration and private
agent secrets. Native API/WS clients keep their original event semantics;
notifications are generated for selected human mentions submitted through Nest.
The generic skill private-context restriction and deployment isolation policy do
not change.

## Personal connection skill lifecycle compatibility

The runner creates a PUBLIC `agent.lifecycle.<name>` GROUP by default. Nest's
connection activation uses the existing human-authenticated channel PATCH API to
make the canonical channel private and owner-owned before issuing credentials.
Every skill call checks its privacy, membership and sharing alongside the single
owner-only conversation. Lifecycle names alone are not authorization markers.
This is a Nest adapter change: no engine source, pin, DB migration, or runner
assignment changes. Existing agents apply it when their owner clicks Enable/Renew.

## Larger connection grants

The Nest UI and API now allow up to 2,000 exact actions per connected account.
Large selections validate against provider catalog pages rather than individual
schema lookups. Grant requests alone receive a 512 KB body bound. Existing saved
grants, private-context checks, credentials and runtime skills remain unchanged;
no migration or OrgOps update is needed. Give all remains an explicit snapshot of
currently available actions, without future-tool permission. Deploy UI and API together.

## Nest-owned personal-assistant requests

Product migration `007_agent_requests.sql` introduces opt-in assistant profiles
and human-reviewed work requests. OrgOps remains at `3e3ed36`; Nest uses existing
human-authenticated agent/channel/event APIs and the engine's targeting and
idempotency fields. A shared Nest profile does not change engine agent visibility
or subscriptions. The same private-context HTTP validator is used by connected
account calls and owner-approved request dispatch.

Deploy the Nest API and UI together with the usual snapshots of both databases.
Existing agents, personal mappings, private chats, tool grants, runner assignments
and runtime skill copies are preserved. All profiles start unpublished. Owners
must explicitly describe and enable teammate requests. No Composio configuration
or new runtime skill is required; existing connected accounts keep their current
permissions. Follow [AGENT_REQUESTS.md](AGENT_REQUESTS.md) for release verification.

## Community consolidation

Community presents one reusable skill artifact and one navigation entry. Existing
API category metadata, immutable package versions, hashes and publishing tokens
are preserved. No product migration, engine pin change, skill installation or
runtime change is required. Workflows are skill instructions; future recurring-run
controls can adapt OrgOps's existing targeted scheduled triggers through HTTP.

## NestSystem agent creation

The permanent Nest management adapter uses existing agent/event/channel/model/runner
HTTP APIs at the unchanged engine pin. No database migration is required. Deployment
alone does not install the persistent wrapped bridge or grant management permission.
The operator must pin the existing manager ID in the private environment and install
the reviewed NestSystem bridge, preserving Codex sessions/login and other bridges.
Back up the environment and previous bridge as well as both databases. Follow
[AGENT_MANAGEMENT.md](AGENT_MANAGEMENT.md) for installation and revocation.
The owner-scoped exact-name lookup for later retries uses the same existing agent
HTTP endpoint. It needs only the updated Nest API and helper skill in the image;
no engine bump, database migration or further bridge/configuration edit is needed.

## Simple project creation and initial team

The optional creation-time people/agent selection uses unchanged OrgOps humans,
agents, channel and subscription HTTP APIs under the signed-in human's credentials.
Nest stores only the requested team in its existing creation reservation, not an
engine membership mirror. Product migration `008_project_collaboration.sql` adds
a private/team visibility policy. Existing records and legacy request bodies remain
private; the new form explicitly creates team projects. Current subscribed humans
with post access can open team projects; public visibility/read-only shares alone
do not grant access. Historical task mutations remain owner-only.

Normal project navigation is Chat/Files/Members; historical task URLs and records
are retained. No engine bump, runner change or credential installation is required.
Snapshot both databases before deployment; the additive migration changes only
Nest product storage and does not read or modify engine state.

## Owner-requested project invitations

The management adapter adds minimal roster lookup and channel subscription through
existing OrgOps HTTP endpoints. No submodule pin/source, database migration or new
runtime credential is needed beyond PR35's existing product migration008. Deploy
the updated Nest API, management helper/skill and bridge instructions together.
Refresh the persistent NestSystem bridge and its embedded saved setup following
[operator installation](AGENT_MANAGEMENT.md#operator-installation); updating source
alone does not install either copy. Signed request-bound credentials stay compatible. The management
skill adds `project-members` and `invite`; invitations require the current project's
human owner and preserve existing private-project history and account grants.

## Chat-first project entry and editable metadata

This stacked follow-up adds no migration or engine pin/source change. New entry
uses the existing durable project creation and message delivery APIs; settings
update only existing Nest product name/description fields with compare-and-swap.
Original creation reservations remain authoritative across renames, and old
submitted name-form drafts retain recovery. The parent creation PR's migration008
still applies when deploying both. Preserve both databases and runtime credentials
through the normal deployment process. AI naming reuses the enabled default model
(or NEST_PROJECT_NAMING_MODEL_ID) and provider key from the API environment or the
configured system agent’s encrypted engine environment over HTTP. No new secret
is required when that source is configured. Source-agent owner-human delegation
must be disabled. Provider failure preserves fallback metadata. No worker process
or migration is introduced; @orgops/llm is an existing workspace dependency.


## Frictionless workspace refinement

Deploy UI and API together. Creation roster gains a pinned personal-agent suggestion; message targeting uses the existing upstream target field. New product invitation and inline metadata controls use current engine HTTP authorization. No migration beyond parent008, engine source/pin change, runtime skill installation, or provider grant is required. Personal connection context validation is intentionally unchanged, so project subscription pauses connected skills. Normal project navigation removes Members; old links open chat with contextual membership available. Preserve both databases and runtime credentials normally.


## Local draft and resume compatibility

This UI-only follow-up requires no API/DB/engine change. Fresh creation drafts migrate lazily from owner-bound session storage to an owner-scoped local key; legacy submitted name-form recovery is unchanged. Conversation draft text, selected mentions, confirmed upload references and stable send identity persist on the current device. Pending local file objects do not. Signing out clears that owner's local drafts and recent project reference. No automatic send, credential storage or server migration is introduced.


## Project kickoff and connection suggestions

No engine source/pin, product migration, runtime credential or agent instruction update is required. New automatic project channels carry response guidance in existing metadata consumed by native channel context; existing channels are untouched. The optional UI connects through current provider/catalog/link APIs and requires the existing instance integration configuration. Personal account grants and private-context checks do not change. Return-from-authorization routing uses an owner-bound tab marker plus current project access; provider state is always fetched through existing APIs.

## Explicit project connection audiences

Product migration009 adds owner-approved project audience snapshots. No engine
source/pin, runner credential or provider grant changes. Deploy API/UI together
with both database snapshots. Existing tokens and grants remain valid only in
eligible contexts; existing project subscriptions need explicit owner approval in
Connected apps. Assistant requests remain private-only. Runtime skill copies are
preserved by installation; operators may refresh the bundled nest-connections
instructions through normal skill distribution, but endpoint enforcement and the
new UI do not require a runtime helper update.


Connected apps support any number of unshared, active owner-only conversations alongside explicitly approved projects. Every subscribed conversation must still pass the owner/privacy checks or project roster approval; archived or unsafe subscriptions pause access. The credential remains bound to its original private conversation, which must still exist. Assistant request dispatch retains its separate single-private-conversation boundary. No additional migration or engine change is required.

## Authenticated demo hosting

No engine source/pin change or database migration is needed. Install the updated
host controller before deploying: the old anonymous demo byte check would roll
back the protected release. Update persistent publishing helpers from
`deploy/demos/publish.mjs`. See [rollout prerequisites](../deploy/demos/README.md).

## Demo artifact preview

The chat-side demo preview is Nest UI only. It uses existing authenticated demo
routes and normal message drafts; no engine change, new grant, DB migration or
publisher replacement is required.
