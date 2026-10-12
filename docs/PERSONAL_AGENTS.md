# Personal-agent onboarding

The first tracer bullet is **sign in → create one personal agent → optionally
connect apps and grant tools → start a private conversation**. It uses Figma
`866:225` as the character reference and Nest's existing layout/branding. The
screen is interactive React, not a flattened Figma screenshot.

## For a new teammate

1. Sign in with the configured Google Workspace domain.
2. Choose Puff, Moss, Muff, Pom or Pip; give the agent a unique name such as
   `PuffVitaliy`; describe what you want help with.
3. Optionally connect an app. Hosted Composio authentication happens outside Nest.
   Back in Nest, refresh status and select the exact tools the agent may use.
   Saving tool access is a separate action from signing into the provider.
4. Open the private workspace and send a message. A reply requires a working
   runner and model; workspace creation alone is not a successful model test.

**My agent** in navigation reopens setup/connections. Returning to Nest's home
resumes unfinished setup for new users. Completed users return to the dashboard.
Existing users with projects or owned agents keep their home; My agent lets them
opt in. Existing deep links take priority and are not redirected. Completion is
stored by immutable engine human ID, so changing a username does not create a
new personal agent.

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
12 model steps maximum, no enabled skills, no access outside its workspace and
no owner-secret delegation. The shared model key is available to native agents through the engine secret
context (including their shell environment); this is a trusted-team deployment,
not per-user provider-key isolation. Users do not enter a model key into onboarding. A valid model record is not proof
that provider billing/credentials work: perform a real reply check before inviting
the team.

Composio requires the reviewed/merged OrgOps core contribution, PR #50. Until an
engine with that API is installed, Nest shows a truthful unavailable state and
allows setup without connections. Once available, configure:

```dotenv
NEST_COMPOSIO_API_KEY=<service-key-from-secret-store>
NEST_COMPOSIO_INSTANCE_ID=<stable-unique-installation-id>
NEST_COMPOSIO_CALLBACK_URL=https://nest.camplight.net/onboarding
NEST_COMPOSIO_AUTH_CONFIGS={"trello":"ac_configured_id","googledrive":"ac_configured_id"}
```

The callback is a fixed HTTPS path without query parameters. Nest canonicalizes
it to `/?view=onboarding`. Callback parameters never prove a connection succeeded;
Nest asks the authenticated engine for current account status. No auth URL,
provider tokens or service keys are saved in the product DB. Search is live from
Composio's catalog. An app without an operator-configured auth config is labelled
“Admin setup needed.” Google login does not grant access to Google APIs.
WordPress.com connectivity does not automatically connect self-hosted WordPress.

The launcher removes the Composio service key from the runner environment before
loading the engine runner. This prevents ordinary inheritance into agent shells;
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
Shared-conversation Composio execution remains denied by the core API.

## Verification and release

`npm test` covers the real Nest/engine boundary, two human accounts, concurrent
creation, lost-response/restart recovery, ownership changes and missing config.
`npm run test:ui:onboarding` exercises the real pinned engine through the browser,
including desktop/mobile, reload, navigation and the unavailable-integration path.
For a candidate upstream checkout, run:

```sh
NEST_TEST_ENGINE_ROOT=/absolute/path/to/orgops npm run test:ui:onboarding
```

That mode uses the candidate's real auth/routes/database and only replaces
Composio's external HTTP transport with labelled test data. It covers tool grants
and revocation without authenticating real external accounts. The test does not
invoke a live model. PR screenshots must say which mode was used.

Before rollout: obtain upstream review, bump the untouched engine to the merged
commit, rerun integration checks, configure secrets/defaults, and deploy with
snapshots of both databases. Then verify a fresh Google login, one real personal
agent reply, an owner-authorized app connection, and a tool grant/revocation.
Only call the platform ready for invitations after these live checks pass.

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
