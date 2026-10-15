# Personal-agent onboarding

Connections are a **Nest-owned adapter and instance skill**. OrgOps PR #50 is
closed and is not a dependency. The engine remains unchanged at `3e3ed36`.
This implementation requires operator configuration and live consent verification
before connections can be offered to the team.

The first tracer bullet is **sign in → create one personal agent → optionally
connect apps and grant tools → start a private conversation**. It uses Figma
`866:225` as the character reference and Nest's existing layout/branding. The
screen is interactive React, not a flattened Figma screenshot.

## For a new teammate

1. Sign in with the configured Google Workspace domain.
2. Open **Agents → Add your agent**, choose Puff, Moss, Muff, Pom or Pip, and give
   your collaborator a name and brief. New teammates arrive in the Agents directory.
3. Your agent appears in **Your team** with a **Your personal agent** label. Open its
   details to choose a model, edit instructions, and manage **Connected apps**.
4. Connect an app and grant specific tools when the Nest integration is available.
   Authenticating an account and granting tools remain separate actions.
5. Use **Open private chat** from agent details to start working together.

There is no separate My agent navigation or standalone onboarding screen.
`?view=agents&create=personal` opens creation within Agents. Existing
`?view=onboarding` and `/onboarding` OAuth return links redirect to the existing
agent's details, or creation if no agent exists. Incomplete reservations resume
without creating a duplicate; after a lost creation response the details screen
can finish setup when opening chat. Completed users keep the dashboard home.
Explicit project/chat links retain their original destination.

Only one onboarding-created agent per human is supported in this tracer bullet.
Other engine agents remain unchanged. Avatar choice is saved in the engine's
`icon` field and product setup record; it is independent of the chosen name.
Names and the initial brief are fixed after provisioning starts. Existing agent
settings can edit the description and instructions afterward.

## Operator configuration

Create an enabled native engine model (provider `openrouter` is supported), and
register a runner. Configure these values in the private server environment:

```dotenv
NEST_DEFAULT_AGENT_MODEL_ID=<existing-engine-model-id>
NEST_PERSONAL_AGENT_RUNNER_ID=<registered-runner-id>
NEST_PERSONAL_AGENT_WORKSPACE_ROOT=/app/.nest-data/workspaces/personal
```

Store `OPENROUTER_API_KEY` in the engine's encrypted secret store with `public`
scope for the shared model, using the operator's authenticated secrets API/admin
flow. Merely setting a process environment key is insufficient: the native
runner resolves provider credentials through its engine secret context. Never
put the value in source, browser onboarding forms, or screenshots.

Nest resolves the model registry ID to the runner's `provider:model` reference
and snapshots that reference for recovery. Nest checks the configured model is enabled and the runner is online before
initial provisioning. It creates a PRIVATE CLASSIC agent with a unique workspace,
12 model steps maximum, no enabled skills, `allowOutsideWorkspace=false` and
no owner-secret delegation. The workspace flag controls file-tool paths; it is
not an OS sandbox for shell commands. The shared model key is available to native agents through the engine secret
context (including their shell environment); this is a trusted-team deployment,
not per-user provider-key isolation. Users do not enter a model key into onboarding. A valid model record is not proof
that provider billing/credentials work: perform a real reply check before inviting
the team.

Nest's Composio adapter runs in the product API. Configure its credentials there:

```dotenv
NEST_COMPOSIO_API_KEY=<service-key-from-secret-store>
NEST_COMPOSIO_INSTANCE_ID=<stable-unique-installation-id>
NEST_COMPOSIO_CALLBACK_URL=https://nest.camplight.net/onboarding
NEST_COMPOSIO_AUTH_CONFIGS={"trello":"ac_configured_id","googledrive":"ac_configured_id"}
```

The callback is a fixed HTTPS path without query parameters. Nest canonicalizes
it to the owning agent under `/?view=agents&agent=…`. Callback parameters never prove a connection succeeded;
Nest asks its provider adapter for current account status. No auth URL,
provider credentials or plaintext skill tokens are saved in the product DB. Search is live from
Composio's catalog. An app without an operator-configured auth config is labelled
“Setup required.” Google login does not grant access to Google APIs.
WordPress.com connectivity does not automatically connect self-hosted WordPress.

The launcher removes Composio configuration and the dedicated metadata token
from both engine processes before loading them. This prevents ordinary inheritance into agent shells;
it is not OS isolation between processes sharing a host/UID. Global runners and
operators remain trusted. The old Composio skill/service-key package must not be
enabled on personal agents. No credentials or old skill installations are
migrated automatically.

## Recovery and ownership

Migration `004_personal_agents.sql` stores product onboarding intent and engine
ID mappings only. The engine remains authoritative for identity, ownership,
permissions, runtime, conversations and credentials. All provisioning calls use
the human's session; Nest never adds a runner credential.

Provisioning durably reserves the name, random setup ID and unique workspace
before engine writes. Concurrent/restarted requests reconcile the globally unique
agent name and workspace, then a uniquely named private channel carrying the
setup marker. Existing foreign names are never adopted. Engine IDs are pinned
once returned; removed resources are not silently recreated after completion.
Changed ownership or visibility fails closed. Ambiguous requests can be retried;
a manually deleted/renamed resource requires operator inspection. This is not a
cross-database transaction, and partial resources are retained for recovery.

## Connection adapter and skill boundary

`apps/api/src/integrations/provider.ts` defines a small provider interface. The
Composio REST implementation supplies catalog discovery, hosted authorization,
account status, tool schemas and execution. Public Nest endpoints use
`/api/integrations`; retired `/api/composio/*` paths return 410 and never proxy to
OrgOps. Adding a provider should implement this interface without changing the
engine or the agent skill. No SDK dependency is added to OrgOps.

Migration `005_integrations.sql` stores local connection IDs, provider account
mappings, exact per-agent tool grants, and hashed expiring skill capabilities.
Human management uses engine sessions and current PRIVATE agent ownership.
Connecting an app does not grant tools; granting tools does not enable execution.
Owners explicitly enable app access after choosing actions in agent settings.
Connected accounts and the catalog use locally served app logos. Each account
starts with a compact Give all access button; Choose specific actions is collapsed
by default and does not fetch the action catalog until opened. Give all access
fetches every provider page and saves the exact current catalog in one explicit
click, regardless of an advanced search. It reports success only after saving.
This is a snapshot of available tools, not permission for future additions.

Advanced options use compact rows with full descriptions and exact references
under About this action. Search, pagination and Selected view retain off-page
choices. Select all results includes every search match while keeping existing
choices. Advanced selections require Save access; discard restores saved choices
and failed saves retain pending choices. Bulk page failures or selections above
the 2,000-action request bound never apply partial choices or change saved access.
App access displays the saved permission count; selecting checkboxes is
not a grant until Save access succeeds. Enable/Renew rejects zero saved
permissions with 409, and the UI refreshes the count after saves/disconnects.
The count excludes locally revoked accounts and reflects saved choices, not live
provider availability or current private-context eligibility.

Enabling installs a random 30-day token in the existing engine private-agent
secret store and enables `nest-connections`. It also adds the skill to OrgOps's existing
`alwaysPreloadedSkills`, preserving other enabled/preloaded skills. The runner
includes the helper's full instructions on the next turn; it does not widen
workspace permissions or rewrite the user's prompt. Older activated agents can
load these instructions by saving tool permissions and clicking Renew skill
access after upgrading. Existing turns keep their original prompt. The browser receives only status
and expiry. Renewal replaces access; revocation immediately invalidates tokens.
The disabled token can remain in the encrypted engine secret store, but is no
longer accepted. A single Nest API process owns the product SQLite file and
serializes concurrent enable/revoke requests. Failed installation is fail-closed;
retry Enable/Renew to recover. Model turns may retain an old token until the next
turn after renewal.

The skill checks grants through Nest for every execution; it never receives the
Composio service key. Nest revalidates account ownership/status, current engine
ownership/context, token expiry and exact tool grants. Audit records contain IDs,
tool names and outcomes, not tool arguments, results or credentials. Ambiguous
action failures are not retried automatically.

**Private-context limitation:** a generic skill cannot attest which conversation
caused a call. Nest conservatively requires the PRIVATE owned agent to be
subscribed to exactly one unarchived, unshared PRIVATE owner-only conversation,
with only its owner and itself as participants. OrgOps also creates an
`agent.lifecycle.<agent name>` GROUP for runtime events. Enable/Renew makes the
canonical lifecycle channel PRIVATE and owned by the signed-in owner through
OrgOps's channel API, provided it has no other participants or shares. Nest checks
both channels on each call; execution never repairs permissions. A lifecycle
channel becoming public, shared, archived or joined by others pauses access.
Unapproved subscriptions (even archived), shared viewers, or changed ownership deny skill
calls until resolved. If the runner creates its default lifecycle channel after
initial activation, click Renew to secure it; access stays paused in the meantime. This
is an agent-wide restriction, not a verified current-turn identity. Owned team projects can be explicitly approved as described below. Existing runtime isolation policy
is unchanged; operators and co-resident processes remain trusted.

For these checks the Nest API needs a **global engine metadata credential**:
`NEST_CONNECTION_METADATA_TOKEN`, or the existing global `NEST_RUNNER_TOKEN`
fallback. Configure only the engine's global runner token, never an agent- or
runner-scoped credential whose filtered channel list could conceal subscriptions.
The pinned engine does not expose credential scope introspection, so configuring
this correctly is an operator requirement. It is used only by the HTTP adapter;
Nest never reads engine SQLite. Remote runners also need
`NEST_CONNECTIONS_URL=https://your-nest-host`; colocated Docker runners use
`NEST_API_URL`. These values locate the product API, not the engine API.

The launcher seeds `skills/nest-connections` into writable engine runtime skills
on first use without overwriting existing installations. An external engine needs
the same skill installed in its configured skill root. The source includes a
`skill.json` manifest, so it can be packaged with
`node scripts/community.mjs pack skills/nest-connections --out /tmp/nest-connections.json`
and published through the existing private tenant community catalog. Publishing
or installing a package does not create credentials or grants. Existing installed
copies require an explicit reviewed update; no old Composio accounts, grants or
service-key skills are automatically migrated.

## Next tracer bullets

- **Team delegation:** people can converse with an agent separately from being
  permitted to use its owner's connections. Add owner-approved requesting people
  and channels, tools and enforceable resource filters. A read-only tool can still
  reveal private boards/files. Use separate team connections if the provider
  cannot enforce resource restrictions.
- **Action approvals:** bind an approval to requester, credential owner, exact
  tool/arguments and destination audience; revalidate at execution and audit it.
- **Multiple personal agents:** explicit additional provisioning with its own
  workspace, context, grants and lifecycle. Do not duplicate agents on login.

These three follow-ups are not implemented by the initial onboarding slice.
The Nest adapter denies connected-account execution in unapproved contexts.
Explicit trusted-project delegation below does not implement per-action approvals
or current-turn identity verification.

## Verification and release

`npm test` covers the real Nest/engine boundary, human and capability access,
provider ownership, exact grants, expiry, renewal, revocation and private context.
`npm run test:ui:onboarding` uses the untouched pinned engine and replaces only
external Composio HTTP calls with test data. It covers account linking, grants,
skill enablement, disconnect, onboarding recovery and desktop/mobile layouts.
No candidate engine checkout is used. These tests do not invoke a live model or
authorize a real external account.

Before rollout, configure secrets/defaults and deploy with snapshots of both
databases. Verify a fresh Google login, one real personal-agent reply, an
owner-authorized app connection, and a tool grant/revocation. Only call the
platform ready for invitations after these live checks pass.

Local validation on 2026-10-12 also exercised one real CLASSIC personal-agent
reply through `openrouter:google/gemini-2.5-flash`, using an isolated engine/product
DB and the operator-authorized vault credential. The agent returned the requested
test message; temporary state was removed afterward. No production data or
external application tools were involved. This proves the local runner/model
path, not the production deployment or a real user's OAuth consent.

## Model selection

`NEST_DEFAULT_AGENT_MODEL_ID` sets the common default for new native agents in
onboarding and `POST /api/agents` when no model is specified. The legacy
`NEST_PERSONAL_AGENT_MODEL_ID` remains a fallback. Existing agents and reserved
onboarding attempts retain their stored model reference. Wrapped agents choose
models in their external runtime.

The agent settings and admin creation forms offer enabled native models from the
engine registry. Unlisted current values remain visible and are not silently
replaced. Selecting another model updates the engine agent through its usual
permission checks; it applies on the next turn. An enabled registry row is not a
credential or provider-health guarantee. The dropdown is a convenience catalog,
not a new security allowlist for the engine's existing explicit-model API.

As of 2026-10-12, the recommended open-weight multimodal default is
`openrouter:moonshotai/kimi-k3`, with `openrouter:qwen/qwen3.8-27b` as a smaller
alternative. Kimi K3's [official model card](https://huggingface.co/moonshotai/Kimi-K3)
describes its released weights, native vision, and agentic evaluations; there is
no universal SOTA across all benchmarks. OpenRouter's
[current catalog](https://openrouter.ai/api/v1/models) lists both image input and
tool support. Provider pricing and availability change; verify before rollout.
This changes model selection, not Nest's attachment/audio/video UI support.
A real isolated CLASSIC runner reply with Kimi K3 was verified on 2026-10-12.

For an existing instance, register a new enabled model with ID `nest-kimi-k3`,
provider `openrouter`, and modelName `moonshotai/kimi-k3`; retain the existing
Gemini record as an alternative. Set the new default environment variable and
restart using the normal backup/deployment flow. Do not repurpose an existing
registry ID: incomplete onboarding reservations may still depend on it.

### Allow a personal agent in owned team projects

In the agent's **Connected apps → Project access**, review every listed person
and agent and choose **Trust these participants with my apps** for each project.
This delegates use of all tools granted to that agent (including future grants)
to the approved participants. Results may appear in project chats and the agent
may carry private-chat information across conversations. Use a separate agent if
these audiences must remain isolated. No account reconnection is required.
The project must belong to you, be private and unshared, and include you and the
agent. Other owners' projects and legacy private projects are not eligible.

Any participant change pauses connected calls until you review the new roster.
Unapproved extra chats, including archived chats, still block access. Review all
subscriptions if calls remain paused. Removing an approval stops future calls
while the agent remains subscribed there, but does not erase information already
shared or stored in memory. Removing the agent from the project restores the
remaining eligible context. In-flight calls may complete after revocation.

The engine reports shared viewers, not outstanding unclaimed share links. A
claimed link adds a viewer and pauses subsequent tool calls; an unclaimed link
alone cannot be detected by this adapter. Anyone later given project access can
read its existing history. Keep project sharing under the control of trusted
owners and do not treat these checks as retrospective protection of tool results.
