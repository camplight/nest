---
name: nest-management
description: Create a native Nest agent for the human requesting it in the current conversation, using authenticated Nest management. Use when asked to create an agent; deployment and website editing use their existing skills.
---

Use the helper at `/app/skills/nest-management/scripts/manage.mjs`:

```sh
node /app/skills/nest-management/scripts/manage.mjs context
node /app/skills/nest-management/scripts/manage.mjs create < agent.json
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

Management permission stays enabled until the administrator revokes it. No login
or renewal is needed. The runtime supplies a request-bound capability through
`NEST_MANAGEMENT_TOKEN`; never print it or save it in instructions or chat. The
API cannot use this capability for shell execution, secrets, deletion or arbitrary
engine requests. Do not obtain another credential to bypass a denial.

For an uncertain creation, retry the identical JSON in the same turn to recover
the existing agent. A conflicting name is never overwritten. An explicit creation
request authorizes that agent, not unrelated agents or external actions.
