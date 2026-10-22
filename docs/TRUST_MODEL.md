# Trusted collaboration

The default is trusted collaboration among signed-in teammates, with owner-controlled credentials and tool grants.

## History reviewed

- #19 (`a069ceb`): connected-account ownership, exact tool grants, and a global
  private-context check were introduced together.
- #21 (`192dd85`): runner lifecycle channels needed a separate private exception.
- #22 (`3a3bc33`): an owner-reviewed request/reply inbox allowed outsiders to ask
  a personal assistant without entering its private context.
- #35–#37 (`ebfa2c8`, `3e30b7f`, `18f4ae7`): team project creation, invitations,
  and automatic personal-agent membership made collaboration the normal flow,
  while the connected-app policy still treated it as a reason to pause.
- #39 (`7ed9f8f`): connection suggestions added another explanation of access.
- #43 (`77d3da2`, `8fe4898`): project audience hashes and approval UI bridged the
  mismatch, but any roster change invalidated trust across all agent chats.
- Open #49 proposes another parallel audience-approval path for public channels.
  This refactor replaces that approach; it should not be merged unchanged on top.

## Current default trusted policy

All signed-in humans who have completed account setup may discover the
installation's registered personal agents and open a normal private conversation.
There is no trust edge, offer publication, request approval, or owner-presence
requirement. Project owners can invite registered personal agents using the same
member picker as other teammates. Registration is checked against current engine
agent ID, owner, native mode and private visibility; stale mappings do not grant
access. Arbitrary hidden agents and wrapped agents are not added to this directory.

Connected-account tokens remain scoped to the current agent and owner. Exact tool
grants, account ownership, credential expiry and revocation are checked as before,
including rechecks before execution. Teammates inherit existing grants, including
write actions. The agent's room roster, shared viewers, archive state and lifecycle
channel no longer grant or revoke tool access globally. Normal engine permissions
still govern who can read or post in each room. Existing private chats are not
opened to everyone, and no owner is silently added to a teammate's conversation.

The legacy token channel_id is retained as metadata only, with an empty value for
new tokens. Provider secrets are not handed to teammates. Agent settings, account
linking, grants, revocation and project membership management remain owner-managed.
Agents can carry information between conversations; this is not per-user memory
isolation or a restriction to read-only tools.

## Retired requests and approvals

Both approval panels are removed. The old request UI becomes a retirement notice
for bookmarked URLs. Request/offer mutations return 410 for authenticated humans.
Participant-only list/detail history remains readable; no unreleased replies,
private event IDs or channel IDs are returned. Pending requests are not dispatched,
completed or released automatically. Existing offers and audience rows remain
stored unused for rollback. There is no new database migration or engine patch.

The directory and mention actions open ordinary direct chats idempotently. Project
member options use the same registered-agent directory. Existing ordinary message
routing and permission checks handle the conversation after admission.

## Published artifacts

Files now includes a separate Published artifacts library for all demos and
reports on this Nest instance. Existing publication has no project registry, so
this is explicitly instance-wide rather than implying that every item belongs to
the currently open project. Chat uploads remain project-scoped in their own list.

GET /api/artifacts requires a current human session and completed account setup.
It scans only canonical slug directories and regular index.html files under the
configured demo root, excludes symlinks and incomplete publications, and returns
name, URL, modification time and byte count, with no-store caching. It does not
expose paths, source HTML, backup history or arbitrary workspace files. Refresh
picks up new publications; existing demos need no republish. Demo viewing retains
its existing authenticated route. No publication or production deployment is
performed by this refactor.
