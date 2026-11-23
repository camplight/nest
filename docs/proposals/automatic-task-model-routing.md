# Automatic task routing: current PR implementation

The original failure was an image sent to a text-only personal agent. Users should
send ordinary messages; they should not need `/model` commands or change the
agent's saved model for one task.

Nest now calls Jev through the OpenRouter Decisions API to classify task difficulty.
It persists the small decision with the send intent and forwards it to OrgOps.
Routine/default text work keeps the saved model; standard and complex work select
medium/high Auto Router policy respectively. Images in the composed context are an
independent capability requirement. OrgOps keeps each classified task separate and
never writes the temporary choice into the agent row. OpenRouter handles provider
availability/failover; Nest's classifier handles task complexity.

The decision deadline is 1.5 seconds including credential resolution. Missing keys,
provider errors, malformed/refused decisions and confidence below 0.7 yield a
safe default hint. This is a tunable starting policy, not a calibrated guarantee.
Ambiguous follow-ups without reply context are classified uncertain. Only current
task and optional reply text are submitted; no full conversation or attachments
are uploaded to the classifier. Existing authentication/visibility checks run first.

Classifier calls are separately billed. Auto Router has no routing surcharge but
underlying inference still costs money. An optional hard model allowlist applies
across routing tiers. A higher cost tier is a quality/cost preference, not proof of
better quality or a task spend cap. Workload evaluation is still required. This
version does not evaluate answer quality, automatically replay failed tools, split
plans into child tasks, or adapt wrapped Claude/Codex runtimes.

References:
- https://openrouter.ai/docs/guides/features/decisions
- https://openrouter.ai/docs/guides/routing/routers/auto-router
- https://openrouter.ai/docs/guides/routing/model-fallbacks

`models[]` is ordered fallback, not a complexity classifier. The typed Jev decision
chooses a bounded task tier; it cannot supply credentials, model IDs or grants.
