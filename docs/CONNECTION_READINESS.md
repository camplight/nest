# Connected-account agent failure investigation

Production was inspected read-only on 2026-10-13 after a personal agent could not
use newly linked apps. This note deliberately omits tenant identities, messages,
channel/account IDs, raw prompts, tool arguments and credential values.

The product had three linked account records and zero tool grants for the agent.
The failed turn's prompt had an empty enabled-skill index. The connection token
was activated after that turn began. The agent tried a Google CLI path rather
than the Nest adapter; file reads of unrelated, disabled skill directories were
rejected by the runner. There were no Nest connection-helper calls in that turn.
The connected account in the callback URL was confirmed active and owner-matched;
a callback itself never grants tool permissions.

These observations explain why authenticating apps did not let the agent use
them. They do not indicate a broken OpenRouter key or a failed OAuth connection.
Google Workspace sign-in credentials are for sign-in and do not authorize the
personal assistant's Gmail access.

A separate response-format symptom also occurred: the agent emitted a chat reply
through `events_emit`, then exhausted the runner's three final-event validation
attempts. The runner emitted its response-format fallback and marked the turn
`completedWithFallback`. Its attempt telemetry reported `stop`, not a provider
outage. The rejected final model event is not stored in that telemetry, so its
exact invalid field cannot be determined from this evidence. This is the existing
OrgOps final-event contract. Nest does not patch it, suppress its message or
claim that connection setup fixes every model formatting failure.

The Nest correction makes account consent, saved tool permissions and skill
activation visible as separate steps. Activation rejects empty grants and
configures the enabled `nest-connections` skill to preload its full instructions
using OrgOps's public agent API. This gives the next turn the actual integration
workflow instead of relying on the model to discover it. Existing prompts,
workspace restrictions, unrelated skills and installed skill copies are retained.

For the owner after upgrading:

1. Open Agents, choose the personal agent and find Connected apps.
2. Under each account, choose the specific tools the agent should use and click
   Save tool access. Start with the read tools needed for the intended task.
3. Click Enable skill access, or Renew skill access for an existing credential.
4. Send a new request in the owner-only private chat. Changes do not update a
   model turn that is already running.

Regression checks use the real Nest API, unchanged OrgOps API and unchanged
runner prompt composer. Only the external provider/model response is a test
fixture. They verify zero-grant denial, no implicit permissions, renewal,
retention of other skills and the full helper instructions in the actual model
prompt. Browser checks cover unsaved selection, saved permissions, legacy renewal,
disconnect and desktop/mobile agent settings. No real external tool was executed
as part of the investigation.
