# Project kickoff and contextual connections

Synthetic local project/accounts only. Catalog, account and authorization responses
come from an injected fixture provider behind the real Nest authentication and
integration routes; the external authorization page is intercepted locally. No
real OAuth account, live model response, tool execution or provider bill is used.
The successful fixed callback restores only the current owner's accessible project
and unsent local draft, and active accounts suppress further suggestions.

Captured by tests/browser/projects.ts after 149 product tests, full lint/build,
and project/dashboard browser validation. Desktop/mobile screenshots show the
final implemented suggestion; the explanatory copy distinguishes account linking
from agent permissions. Kickoff metadata is prompt guidance, not a guarantee of
model wording. Existing connected-account privacy restrictions are unchanged.
