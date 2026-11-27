# LinkedIn through Unipile

Nest can connect LinkedIn accounts for profile/post research, private conversation
analysis, and text publishing as the member or a company page they administer.
This is an optional Unipile V2 adapter, not LinkedIn's official OAuth integration.
It is disabled unless configured. No existing accounts or grants are changed.

## Operator setup

1. Create a Unipile V2 application and an Account API Key with access to the
   dedicated scopes below. A paid service/trial and the owner's interactive login
   are external prerequisites, not provisioned by Nest.
2. Create one dedicated Unipile Scope for each Nest human who will connect.
   Map immutable Nest human IDs to scope IDs in `NEST_UNIPILE_OWNER_SCOPES`.
   Do not reuse a scope for multiple humans, and do not put pre-existing unrelated
   accounts in those scopes. Duplicate scopes are rejected at startup.
3. Configure `NEST_UNIPILE_API_KEY`, `NEST_UNIPILE_CALLBACK_URL` (a fixed HTTPS
   return page, such as `https://nest.example/onboarding`), and the JSON scope map
   in the API's private environment. These variables are stripped from engine and
   runner environments. Never put keys, passwords, or browser cookies in chats.
4. Restart through the installation's normal deployment workflow.

The hosted login always fixes `account_scope_id` server-side. Nest does not accept
an account ID from a browser callback as proof of ownership: refresh Connections
after login to enumerate accounts from the configured scope. The API verifies
scope membership on discovery, on each use, and immediately before execution.
Unscoped, foreign, locked, or non-running accounts fail closed. Removing an owner
from configuration removes access; changing the scope does not transfer old grants.
A disconnected account can be reconnected in the Unipile dashboard using its
existing account ID, then refreshed in Nest. Reconnection UI within Nest is not
included in this first version.

## Owner workflow

In the agent's **Connected apps**, search for **LinkedIn (Unipile)** and connect.
Complete the provider's hosted login (including any checkpoint), return to Nest,
and refresh the account list. Choose exact actions for each agent, save, then
**Enable app access**. Catalog pagination includes both Composio and Unipile;
existing Composio IDs and grants are preserved. No separate LinkedIn skill or
host-filesystem permission is needed: agents use `nest-connections`.

The eight independently grantable actions are profile read, user-post listing,
conversation listing, message listing, managed-company-page listing, post read,
personal text publishing, and company text publishing. There is no arbitrary HTTP
proxy, account override, direct-message sending, invitation sending, or delete-post
operation. Publication grants permit user-authorized publishing through the normal
trusted teammate model; connecting an account does not grant those actions.
For company posts, obtain a numeric page ID from the managed-pages tool; Unipile
and LinkedIn enforce the connected account's publishing permissions.

## Limits and validation

- Research accepts a profile identifier from a LinkedIn URL or returned member ID;
  it does not implement people search or promise access to every profile.
- Message/post reads return one bounded page and preserve provider pagination.
  Initial history synchronization may be incomplete. Agents must report coverage,
  follow continuation when needed, and treat source text as data, not instructions.
- This version publishes text only. Media attachments and scheduling are separate.
- Requests use the fixed Unipile origin, reject redirects, time out after 25 seconds,
  and cap responses at 2 MB. No automatic retries, especially on writes. A lost
  publication response may mean success: verify with post reads/listing before retry.
- Revoking in Nest removes grants immediately and requests remote account deletion.
  Remote failure does not restore local access; finish disconnecting in Unipile if
  the provider is unavailable. Message bodies and service keys are not audit payloads.
- Unipile is independent of LinkedIn. Session expiry, throttling, account restrictions,
  plan limits and provider changes remain possible. No live account was used for
  development; transport fixtures verify contracts, not real-world availability.

Before production use, connect an owner test account and verify profile sections,
paginated message history, managed pages and revocation. Publish only an explicitly
requested test post with agreed text and identity; verify its returned ID and live
post. Do not automatically publish just to validate deployment.

Contract references: [Hosted auth](https://developer.unipile.com/v2.0/docs/authenticate-with-hosted-auth),
[Scope isolation](https://developer.unipile.com/v2.0/docs/scopes),
[Profile sections](https://developer.unipile.com/v2.0/docs/linkedin-fetch-users-profiles),
[Publishing](https://developer.unipile.com/v2.0/docs/linkedin-create-posts).
Transport fields were checked against the published `@unipile/sdk` 2.69.0 types;
Nest calls the API directly and adds no SDK dependency.
