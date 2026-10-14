---
name: nest-management
description: Create or find the requesting human's private Nest agents, or invite people and agents to the current project on its owner's request, using authenticated Nest management.
---

Use the helper at `/app/skills/nest-management/scripts/manage.mjs`:

```sh
node /app/skills/nest-management/scripts/manage.mjs context
node /app/skills/nest-management/scripts/manage.mjs get "Agent name"
node /app/skills/nest-management/scripts/manage.mjs create < agent.json
node /app/skills/nest-management/scripts/manage.mjs project-members
node /app/skills/nest-management/scripts/manage.mjs invite < member.json
```

The JSON object contains only `name`, `description` and `systemInstructions`.
Choose a readable name (letters, numbers, spaces, hyphens or underscores), explain
the agent's role, and write useful instructions for the requested work. For a
tender researcher, include official sources, eligibility, deadlines and evidence.

The API derives the human owner from the signed originating message and supplies
the configured model and manager's runner. It creates a private native agent;
it does not join that agent to a conversation or connect anyone's accounts.
Return the API's settings link, and explain that the owner can add it to a project
conversation. Claim creation only after the helper confirms it.

Check the requested name with `get` before creating, including when the human
says "retry" in a later message. If found, return the existing agent's settings
link and say it already exists; this does not apply newly proposed instructions.
Only a 404 means no private agent by that name was found for this requester.
Other failures do not establish absence. Never rename to bypass a conflict.

Management permission stays enabled until the administrator revokes it. No login
or renewal is needed. The runtime supplies a request-bound capability through
`NEST_MANAGEMENT_TOKEN`; never print it or save it in instructions or chat. The
API cannot use this capability for shell execution, secrets, deletion or arbitrary
engine requests. Do not obtain another credential to bypass a denial.

For an uncertain creation, retry the identical JSON in the same turn to recover
the existing agent. Across turns, use `get` to check the existing agent; a new
message has a different creation identity. A conflicting name is never overwritten.
If creation returns 409, look up that name once; if not found or denied, report
the conflict instead of repeatedly creating. An explicit creation
request authorizes that agent, not unrelated agents or external actions.

For an explicit request to add someone to the current project, use `project-members`
to resolve exact identities and check existing membership. `invite` accepts only
`{"subscriberType":"HUMAN","subscriberId":"name@example.com"}` or
`{"subscriberType":"AGENT","subscriberId":"Agent name"}`. Use a listed identity;
if a name matches both a person and an agent, clarify which one the owner wants.

The API requires the originating human to own both the team project and its
current conversation. It cannot invite into a different project, a standalone chat,
or a legacy creator-private project. A normal @mention does not authorize changing
membership: the human must ask to add/invite that identity. Do not invite unrelated
members while handling another request.

Report success only after the helper confirms membership and returns the project
link. Existing membership is a successful no-op. After an uncertain response,
check `project-members` and retry the same identity; do not claim success without
confirmation. Do not retry a permission denial or obtain another credential.
Invitations do not create accounts, send email, or grant personal connected tools.
