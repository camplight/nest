# Requests to personal assistants

A teammate can ask your assistant to work on your behalf while you control what
it receives and what it shares. This is a Nest product workflow around the
existing private OrgOps agent. Its private conversation and connected accounts
remain private.

## Enable teammate requests

Open Agents → Your team → your personal agent. Under Teammate requests, write a
short description of useful work it can do, enable requests and save. This
publishes the agent's name, your username and that description to signed-in
teammates. It does not publish the agent's instructions, connected tools or chat.
Leave requests off to keep the assistant undiscoverable through this feature.
Turning them off later stops new requests without removing existing work records.

A correctly configured global engine metadata credential is required, as for
connected-app access. Wrapped agents and agents outside onboarding's pinned
personal mapping are not eligible. No new Composio credential is needed.

## Ask an assistant

Choose Ask on its profile in Agents → Personal assistants, or select it in the
chat's @ picker under Request owner approval. That selection opens a request
form; it does not send a message to the current chat or add the assistant there.
Give the request a title and clear brief, then send. It appears under Agents →
Requests → Outgoing. The owner sees it under Incoming. The owner and requester
are the only people who can view this work record.

If sending fails after the request was saved, retry the unchanged brief. Its UUID
is retained in tab storage across reload so the same intent is recovered without
a duplicate. You can cancel a request before the owner approves it.

## Approve work and a reply

The owner reviews the brief and can decline it with feedback or choose Approve
and ask. Nest then sends one targeted event into the existing owner-only private
conversation using the approving owner's session. The requester is never added.
An unconfirmed delivery remains retryable with the same engine event identity.

The agent works with its existing tool permissions. A request approval authorizes
the brief; it is not approval of individual tool arguments. Choose grants you are
comfortable letting the agent use for approved work. This initial slice has no
standing delegation or per-request resource limits.

Once it replies, the owner refreshes the latest 100 private responses, selects the relevant one,
edits the reply and chooses Share approved reply. Review relevance and private
details: the list can contain responses to other work in that same private chat.
Only the text explicitly approved by the owner reaches the requester's Requests
inbox. Raw responses, attachments, private engine links and tool credentials are
not shared automatically. Inbox/details polling updates status; there are no
email/Slack notifications or automatic replies in team chats in this slice.

## Verification before release

Run `npm test`, `npm run lint`, `npm run build` and `npm run test:ui:agents`.
The request browser scenario uses real isolated engine/product HTTP handlers,
synthetic identities, and a scripted agent reply. Product integration tests also
verify an approved tool call against a test provider uses the owner's account and
keeps its result private until the owner shares an edited answer.

Before advertising the flow as production verified, use an owner-consented test
account to publish a profile, submit a teammate request, approve one bounded read,
verify a real agent/tool response, share an edited reply and confirm a third
person cannot access it. No CI/local test establishes live model/provider success.
Preserve runtime state and both database snapshots during normal deployment.
