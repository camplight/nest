---
name: nest-connections
description: Discover and execute tools from accounts the owner connected and explicitly granted to this agent in Nest. Use for tasks involving those connected apps; linking accounts and changing grants require the owner's Nest settings.
---

Run the helper by its full path from your workspace, for example
`node SKILL_DIR/scripts/connections.mjs list`, where SKILL_DIR is this skill's
directory. Do not `cd` into the skill directory; saved files belong in your workspace.

- `list` shows each granted connection, its app, its actions and their argument
  names (`*` marks a required one). That is usually enough to call an action.
- `schema CONNECTION_ID TOOL` gives argument types and descriptions. Use it only
  when the names in `list` are not clear enough.
- `execute CONNECTION_ID TOOL < arguments.json` runs an action. The JSON on stdin
  is the tool arguments object; keep credentials out of arguments.
- Add `--out FILE` to save a large result to a file instead of printing it.
- Add `--all --out FILE` to read every page of a list action (boards, items,
  messages, files). The helper follows the provider's cursor, saves the merged
  `items` to FILE and prints only a summary. It refuses actions without a cursor.

Work in few steps. Write and run a script in one `shell_run`, for example
`cat > report.mjs <<'EOF' ... EOF` followed by `&& node report.mjs`. Read saved
files with a script that prints only what you need, not the whole file. Once you
have enough to answer, answer; do not fetch the same data again.

The helper reads `NEST_CONNECTION_TOKEN` from the agent's private engine secret
and `NEST_CONNECTIONS_URL` (or `NEST_API_URL`) from instance configuration. Never
print these credentials or copy them into the skill package, messages, or files.
Provider service keys stay in Nest. No Composio SDK or service key is needed here.

If access is expired, revoked, or denied, stop and direct the owner to Connected
apps in their agent settings. Never try another account, agent token, or provider
API to bypass a denial. Nest trusts signed-in teammates by default: they may ask
this agent to use its existing grants, including write actions, through normal
conversations. Owner presence, trust edges and separate project approvals are not
required. The owner alone manages connected accounts and grants. Conversation
permissions govern message access; tool credentials remain agent-scoped. Do not
claim personal data or memory is isolated between chats. Never disclose credentials.

Do not retry an execute request after an ambiguous timeout: the remote action
may have completed. Report the uncertainty and verify the result before retrying.
Only claim an action succeeded when the returned tool result confirms it.
