# Agent creation from NestSystem

NestSystem uses a wrapped Codex runtime. Native OrgOps's authenticated
`agents_create` tool is not injected into that runtime. The bridge now supplies a
Nest-specific creation/owner-lookup capability and the `nest-management` skill. The global
runner token and administrator credentials remain outside Codex's environment.
The Docker image explicitly makes this public skill readable by the node account
and checks both helper imports as that account during the build, even when the
host checkout uses a private umask. Private runtime credentials are unchanged.

During long turns, the same trusted bridge uses
`packages/orgops-client/src/wrapped-progress.mjs` to publish public assistant
updates through OrgOps's existing `agent.turn.phase` endpoint. Nest displays the
latest update next to the compact activity icons until completion or failure.
The final reply still uses normal wrapped output; reasoning, tool output and
diagnostics stay out of progress. No additional agent/tool grant is needed, and
the global runner credential still stays outside Codex's environment.

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

The helper also supports `get "Agent name"` through
`GET /api/agent-management/agents/:name`. This returns only an ID, name, model,
visibility and settings link for a private agent owned by the requesting human.
It revalidates the same signed context and current memberships. Other owners',
public and missing agents return the same 404 response. It does not read agent
instructions, connected accounts or workspace contents into the manager's response.
Check this endpoint before creation and after a name conflict, including a later
"retry" message. Finding an agent confirms it already exists; it does not confirm
that new instructions were applied. Creation's strict same-request recovery remains
unchanged, and conflicting agents are never overwritten or renamed automatically.

## Operator installation

1. Deploy the Nest API and image containing `skills/nest-management` and
   `deploy/nestsystem-bridge.mjs`, using normal snapshots of both databases.
2. Retrieve NestSystem's existing ID through the authenticated agent API. Set
   `NEST_MANAGEMENT_AGENT_NAME=NestSystem` and `NEST_MANAGEMENT_AGENT_ID=<existing ID>`
   in the private host environment. Keep the existing runner key/default model.
3. On runner startup, Nest's launcher retrieves the explicitly pinned NestSystem
   record through authenticated HTTP. It migrates the recognized legacy command
   to run `/app/deploy/nestsystem-bridge.mjs` directly and removes the generated
   embedded old-file write from setup. Other setup/config fields are preserved.
   The previous configuration is saved with mode 600 under
   `.nest-data/codex-runtime/bridge-config-backups`. Existing bridge files,
   workspaces, `nestsystem-sessions`, Codex home/login and other agents are retained.
   Custom recipes produce `nest.bridge.reconcile needs-review` and are not
   modified. For those, review and update the runtime command explicitly through
   the agent API; do not replace arbitrary setup commands. The release-owned
   executable is the single source for subsequent updates, so a stored old setup
   cannot restore the executable used by NestSystem.
4. Recreate/restart through the host controller so the API reads the allowlist.
   Check authenticated `context` from NestSystem's bridge environment before creation.
   The bridge adds management instructions on resumed turns as well as new sessions.
   Verify the saved runtime command points at the release-owned bridge and run
   the helper as UID 1000. A context check alone does not prove which executable
   future Codex turns use. Restoring an old release may require restoring the
   backed-up configuration if it predates the release-owned path.
   For progress updates, verify the image's adapter is readable as the runtime
   user, then check a synthetic long turn shows an update before its final reply.
   Deploy the UI, adapter and bridge together. Progress delivery is bounded and best-effort; an engine outage
   reports a generic diagnostic and does not discard the final reply.

Disable management by removing the two `NEST_MANAGEMENT_AGENT_*` settings and
restarting the API. Deleting/replacing the configured manager also denies access.
No engine source change, new secret, database migration or human re-login is needed.

API: `GET /api/agent-management/context`, `GET /api/agent-management/agents/:name`
and `POST /api/agent-management/agents`.
All require the signed bearer capability; ordinary engine APIs do not accept it.
Bodies are JSON capped at 32,000 bytes. Failures do not expose provider credentials.
Run `npx vitest run apps/api/src/agent-management.test.ts scripts/orgops-env.test.ts`
for real-engine boundary and runtime credential-filtering checks.


## Inviting project members

The existing trusted wrapped manager can list current-project members and invite
one exact identity when the owner asks, for example “@NestSystem add Naska to this
project.” Its skill calls:

```sh
node /app/skills/nest-management/scripts/manage.mjs project-members
node /app/skills/nest-management/scripts/manage.mjs invite < member.json
```

`member.json` contains only `subscriberType` (`HUMAN` or `AGENT`) and the exact
`subscriberId` returned by roster lookup. Ambiguous names need clarification.
The API derives the project from the signed originating conversation; it requires
that human to own both the team project and conversation. There is no arbitrary
project/channel argument, user-session token, additional environment variable or
new credential. Other owners’ private agents, standalone chats and legacy private
projects are unavailable through this helper.

Existing subscriptions are no-ops. Lost responses reconcile current engine
participants before claiming success. The response includes a project URL and
confirmed identity; requested and confirmed mutations are audited without tokens.
A normal mention alone does not request an invitation. The helper grants no email,
new account, role change or connected-tool access. Native agents’ existing engine
membership tools retain their original permissions; this signed delegation path
is for the configured trusted wrapped manager.

Deploy the updated API, helper, skill and bridge instructions together. Verify
the release-owned runtime command using operator step 3;
a source update alone does not install them. Request-bound signing and credentials
remain compatible. Back up both databases
as usual; this extension adds no migration beyond the project collaboration policy
included in the project-creation PR.
