# Agent creation from NestSystem

NestSystem uses a wrapped Codex runtime. Native OrgOps's authenticated
`agents_create` tool is not injected into that runtime. The bridge now supplies a
Nest-specific create-only capability and the `nest-management` skill. The global
runner token and administrator credentials remain outside Codex's environment.
The Docker image explicitly makes this public skill readable by the node account
and checks both helper imports as that account during the build, even when the
host checkout uses a private umask. Private runtime credentials are unchanged.

Management permission is permanent until the administrator revokes it. It does
not expire with human sign-out, API restarts or a time limit. The trusted bridge
signs its originating agent/channel/event context using the existing runner key;
Codex receives only that proof. Each new turn carries its own context, including
when resuming an existing Codex session. Rotating the key invalidates old proofs;
new turns use the current key without manual credential renewal.

Nest validates the configured manager name **and ID**, the original human message,
its channel/target and current human/manager subscriptions on each helper request.
Agent/system triggers cannot provision agents. Nest supplies that human's ownership,
the enabled instance default model, the manager's online assigned runner and a
workspace under `.nest-data/workspaces/managed`. New agents are private, native and
running, with no enabled skills, outside-workspace access or owner-secret delegation.
This preserves the deployment's existing shared-runner OS trust boundary.

The helper accepts only a name, description and system instructions. It cannot
choose another owner/model/runner, create a wrapped runtime, delete agents, read
secrets or make arbitrary engine requests. Publishing a skill does not grant this
capability. New agents can be configured through the returned settings link and
added to project conversations through the existing member controls. Creation does
not subscribe them automatically or connect private accounts.

Nest calls the existing OrgOps HTTP APIs through `packages/orgops-client` and
stores only a product audit record. Unique names and a deterministic workspace
bound to the originating event allow identical retries to reconcile a creation
whose response was lost. Different settings or another existing agent return 409;
no existing agent is overwritten. A new human message has a different request
identity; it cannot silently take over a previously created name.

## Operator installation

1. Deploy the Nest API and image containing `skills/nest-management` and
   `deploy/nestsystem-bridge.mjs`, using normal snapshots of both databases.
2. Retrieve NestSystem's existing ID through the authenticated agent API. Set
   `NEST_MANAGEMENT_AGENT_NAME=NestSystem` and `NEST_MANAGEMENT_AGENT_ID=<existing ID>`
   in the private host environment. Keep the existing runner key/default model.
3. Back up the current persistent `nestsystem-bridge.mjs` outside the webroot.
   Also retrieve and back up NestSystem's `wrappedConfig` through the authenticated
   agent API. Some existing installations embed an encoded bridge in
   `wrappedConfig.setup.command`; OrgOps reruns that setup after runner restarts.
   Update that embedded copy to the reviewed bridge through
   `PATCH /api/agents/NestSystem`, preserving all other configuration fields.
   Replacing only the persistent file lets the old setup overwrite it on restart.
   Install `/app/deploy/nestsystem-bridge.mjs` at
   `/app/.nest-data/codex-runtime/nestsystem-bridge.mjs`. This is a targeted operator
   action; Nest's launcher does not install runtime bridges, but the agent's saved
   setup can regenerate them. Preserve the workspace,
   `nestsystem-sessions` directory, Codex home/login and all other bridges.
4. Recreate/restart through the host controller so the API reads the allowlist.
   Check authenticated `context` from NestSystem's bridge environment before creation.
   The bridge adds management instructions on resumed turns as well as new sessions.
   After startup setup finishes, compare the persistent bridge with the reviewed
   image copy and run the helper as UID 1000. Verify the saved setup contains the
   reviewed bridge too; a context check alone does not prove that future Codex turns
   receive the management capability.

Disable management by removing the two `NEST_MANAGEMENT_AGENT_*` settings and
restarting the API. Deleting/replacing the configured manager also denies access.
No engine source change, new secret, database migration or human re-login is needed.

API: `GET /api/agent-management/context` and `POST /api/agent-management/agents`.
Both require the signed bearer capability; ordinary engine APIs do not accept it.
Bodies are JSON capped at 32,000 bytes. Failures do not expose provider credentials.
Run `npx vitest run apps/api/src/agent-management.test.ts scripts/orgops-env.test.ts`
for real-engine boundary and runtime credential-filtering checks.
