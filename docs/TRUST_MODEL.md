# Trusted collaboration

The default is to trust people and agents invited into a conversation while the
personal agent's owner is also a direct member. Membership is the collaboration
boundary. It is not a claim that the owner is online or approves every action.

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

## One connected-app policy

Owner-granted tools work in private/public conversations and projects when the
owner is a direct HUMAN participant. Project ownership and roster changes do not
require another approval. Other participants can request actions and see results;
public channels may have readers beyond the roster. The agent may carry context
between conversations.

All of the agent's subscribed conversations are checked because credentials are
agent-scoped, not bound to a verified incoming turn. An absent owner, archived
subscription, shared viewers, unknown participant types, or invalid lifecycle
context pauses calls globally. A caller cannot select a safe channel to bypass
this check. The credential's original conversation must still exist and be valid.
The lifecycle exception remains private and owner-controlled.

## Controls that remain

Authentication and engine channel visibility still apply. Inviting new members
and changing project settings remain owner/manager operations. Linking personal
accounts, granting tools, credential renewal/revocation and agent ownership remain
owner-controlled. This change does not enable all tools or share credentials.

The private assistant request inbox remains an explicit request/reply boundary for
people outside a shared conversation. Its approval flow is not a duplicate project
permission, so it retains its strict private-context checks.

## UI and compatibility

The participant-approval panel is removed. Agent settings explain automatic
membership-based trust once; project kickoff and connection suggestions agree.
Users revoke through existing tool grants or Turn off app access, or remove the
agent from a conversation. No implicit account linking or permission grant occurs.

Old project-approval endpoints return 410 to authenticated owners with actionable
instructions, rather than pretending a revoke still controls access. Other humans
and agent tokens remain forbidden. Existing approval rows are retained unused for
rollback; migration history is untouched. Old unapproved projects now work if the
membership rule is met. This is an intentional policy change for existing agents.

No engine patch, database migration, automatic invitation, merge, or deployment is
included. This is the first consolidation of the connected-app access layer; it
does not claim to remove every authorization check in Nest.
