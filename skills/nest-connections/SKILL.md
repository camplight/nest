---
name: nest-connections
description: Discover and execute tools from accounts the owner connected and explicitly granted to this agent in Nest. Use for tasks involving those connected apps; linking accounts and changing grants require the owner's Nest settings.
---

Resolve `scripts/connections.mjs` relative to this skill directory, not the agent workspace.
Use `node scripts/connections.mjs list` to see granted connection IDs and tools.
Inspect inputs with `node scripts/connections.mjs schema CONNECTION_ID TOOL`.
Execute with `node scripts/connections.mjs execute CONNECTION_ID TOOL < arguments.json`.
The JSON on stdin must be the tool arguments object; keep credentials out of arguments.

The helper reads `NEST_CONNECTION_TOKEN` from the agent's private engine secret
and `NEST_CONNECTIONS_URL` (or `NEST_API_URL`) from instance configuration. Never
print these credentials or copy them into the skill package, messages, or files.
Provider service keys stay in Nest. No Composio SDK or service key is needed here.

If access is expired, revoked, or denied, stop and direct the owner to Connected
apps in their agent settings. Never try another account, agent token, or provider
API to bypass a denial. Access supports any number of active, unshared owner-only chats;
project chats and public channels require explicit owner approval in Connected
apps. Public channels additionally require the owner to remain a direct human
participant. Owner presence means membership, not online status or approval of
each request. Public-channel results are visible to anyone who can read that
channel, not just its subscribers. Membership or sharing changes pause access. Approval covers all granted
apps and tools for this agent, not a verified requesting human or current turn.
Treat approved project participants as trusted with tool use and results. Do not
claim that personal data is isolated between this agent’s chats. It is not an OS sandbox.

Do not retry an execute request after an ambiguous timeout: the remote action
may have completed. Report the uncertainty and verify the result before retrying.
Only claim an action succeeded when the returned tool result confirms it.
The original private chat bound to the credential must remain active. Archived
subscriptions pause access until removed.
