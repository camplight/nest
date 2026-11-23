# Agents that end without replying (Nest #91)

## Intent

On weaker models an agent sometimes ends a turn with `noop` while a person is waiting,
sometimes with a false reason ("already delivered as message …"). The engine accepts a
deliberate `noop` as finished work, so the person sees only a folded "Details" line with
no avatar or time and no answer. Seen with NikiPA on GLM-5p3: it fetched the Miro board,
then ended with a `noop` claiming the answer was posted.

The user wants this fixed in Nest only, without waiting for an OrgOps change.

## Goals

- A turn that answered nobody is visible: it shows as the agent's row (avatar, name,
  time) with "Ended without replying", the agent's stated reason when it gave one, and the
  Details fold under it.
- When a person was clearly waiting, Nest asks the agent once to reply.

## Non-goals

- No OrgOps change. An engine-side guard can be proposed upstream later.
- No retry beyond one nudge per request.

## Anti-goals

- Agents in group chats must not be pushed to answer messages meant for someone else.
- Never nudge after Stop, after a failed turn, or twice for the same request.
- Never nudge when the person already followed up; the agent is handling that.

## Approaches considered

- **A. Nest nudges the agent automatically (chosen).** A background worker spots the turn and
  posts one targeted note that wakes the agent for one more try. Costs one model call, only
  when it happens.
- **B. An "Ask again" button on the row.** Nothing automatic, simpler, but the person must
  notice and click.
- **Engine guard in OrgOps.** Covers every OrgOps user, but needs the maintainer; deferred.

## Design

### Worker (`apps/api`, engine access through `packages/orgops-client`)

Follows the chat-compaction worker: a `tick()` every 15 s, a cursor in `product_settings`
(`reply_nudge_cursor`, first run starts at the newest event), engine reads and writes
through the client with Nest's runner token. No product migration.

For each new `agent.turn.completed` from `agent:<name>`, Nest nudges when all hold:

1. The turn was not cancelled (`payload.cancelled` is not true).
2. Its trigger (`payload.triggerEventId`) is a `message.created` from `human:<…>`.
3. A person was clearly waiting for this agent: the trigger's `mentions` include the agent
   or its `targetAgentName` is the agent, or the agent is the only agent in the chat.
4. The agent posted no `message.created` in that chat between the trigger and the
   completion.
5. No person posted a newer message in the chat after the trigger.

The nudge is a `message.created` from `system:nest` in the chat with
`{ text, targetAgentName: <agent>, nestReplyNudge: { triggerEventId, requestedFor: "human:<…>" } }`
and idempotency key `nest-reply-nudge:<agent>:<triggerEventId>`. The text:
"You ended your turn without replying to <person>. Reply to them now, or say why you can't."
`targetAgentName` wakes only that agent. A refused duplicate (idempotency) counts as done.
The nudge's own turn is never nudged again, because its trigger is not from a person.
Errors are not logged raw.

### Chat (`apps/user-ui`)

- A finished agent turn whose activity has no reply message renders as that agent's row
  with avatar, name and the completion time, the line "Ended without replying", the
  `noop` reason when present ("It said: …"), and the existing Details fold. Cancelled and
  failed turns keep their current lines.
  Builder's call: only for turns meant for the agent, by the worker's rule (named, or
  the only agent when nobody is named), plus turns Nest asked about and the ask's own
  turn. Otherwise every silent agent in a group chat would get a row.
- Builder's call after review: in a one-agent chat an unnamed message counts only when
  the turn called a tool, so a "thanks" the agent lets pass is not nudged. Turns that
  scheduled their own retry and turns over 10 minutes old are left alone.
- A `system:nest` message with `nestReplyNudge` renders as a small system line:
  "Nest asked NikiPA to reply."

### Docs and tests

- `docs/SPEC.md`: the nudge rule and the "ended without replying" row.
- Worker tests run against the real in-process engine, like the compaction worker tests:
  a single-agent chat nudges once; an @mentioned agent in a group chat nudges; an
  unaddressed agent in a group chat does not; cancelled, failed and replied turns do not;
  a person's follow-up prevents it; a second pass and a second API process do not
  duplicate it; the nudge's own turn is not nudged.
- Timeline tests for the new row and the system line.

## Where it lands

On `feat/agent-providers-and-connected-apps` (#91) in the primary checkout, local only
until the user has tested it. Not pushed.

## Left to the builder

- How the worker pages engine events (type filter plus `after` cursor).
- Exact row styling, following the existing agent message row.
