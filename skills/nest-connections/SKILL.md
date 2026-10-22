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
API to bypass a denial. Participants are trusted by default in private or public
conversations and projects while the agent's owner is a direct HUMAN member.
No separate project or roster approval is needed. Existing owner-granted tools
still define what the agent may do. Owner presence means membership, not being
online or per-action approval. Public channels can have readers beyond members.
Access pauses across all chats if any subscribed conversation lacks its owner,
has shared viewers or is archived. Lifecycle channels retain their private shape.
Do not claim personal data is isolated between this agent's chats. It is not an OS sandbox.

Do not retry an execute request after an ambiguous timeout: the remote action
may have completed. Report the uncertainty and verify the result before retrying.
Only claim an action succeeded when the returned tool result confirms it.
The original conversation bound to the credential must remain active. Archived
subscriptions pause access until removed.
