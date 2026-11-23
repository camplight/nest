# Automatic task model routing

Status: proposal for feedback; automatic routing is not implemented by this PR.
Tracking: [Trello card 192](https://trello.com/c/ZjnIN3Qt/192-automatic-task-specific-model-routing-for-nest-powered-by-orgops).
Execution foundation: [OrgOps #112](https://github.com/camplight/orgops/pull/112).
Product proposal: [Nest #97](https://github.com/camplight/nest/pull/97).

## The problem we are solving

A person pastes an example image into a project chat and asks their personal
agent to read it. The agent's saved model is text-only, so the provider rejects
the request instead of answering. This occurred in the infographics workflow.
Changing the agent's persistent model to fix that one request then changes its
behavior in unrelated conversations and future chats. Switching it back after
the task is also unsafe when conversations run concurrently.

Users should describe their work and attach their files. They should not have
to understand provider names, model capabilities, benchmark scores or commands.
The same personal agent should use a suitable model for the current work while
keeping its identity, instructions, permissions and saved default.

PuffVitaliy's requested saved default is `openrouter:z-ai/glm-5.3`. That is an
agent setting, not a model ID to hard-code into the router. Catalog capabilities
and prices must be checked dynamically; example model names are not routing rules.

## Product behavior

- Normal conversation uses the saved default whenever it meets the requirements.
- An image-reading request with an incompatible default chooses an eligible
  vision model for that turn. Other chats and the next ordinary turn keep their
  own routing decisions and the saved default.
- A sufficiently complex planning task may use a stronger model for planning.
  Subsequent bounded execution steps may use a cheaper model when their quality
  requirements permit. This is a later routing policy, not an implemented claim.
- No `/model` command, model ID, score or price threshold is required in chat.
- A quiet indicator can say “Adapted for this task.” Optional details explain
  the reason, selected model and any escalation. Vendor names are not the main UI.
- If no permitted model can handle the input, explain the limitation. Do not
  silently discard images or downgrade the task and pretend it succeeded.

## Ownership and unit of routing

OrgOps owns agent execution, task-scoped model selection, capability enforcement,
owner-controlled routing policy and decision/usage events. Nest owns the simple
chat experience and renders a small amount of that information. Nest must not
reimplement a second model-selection engine.

Use one immutable decision per **turn/run**, before its provider call starts.
A larger **task** can contain several runs or stages, linked by a task ID. A
planning stage and execution stage can use different models, with an explicit
handoff containing the plan, constraints and validation criteria. A model must
not change halfway through an in-flight provider call or tool action.

Keep `agents.model_id` as the saved default. Execution uses a local copy of the
agent configuration, never a global switch followed by a revert. A persistent
model preference change is a separate, explicit settings action.

## Routing order

1. Derive the actual input requirements. Images require image input; audio,
   video and documents have their own requirements. A text document is not an
   image. Approved text extraction may satisfy a document request only when it
   preserves the information the task needs. Include tool support and context size.
2. Filter out incompatible models before considering prices. Unknown capability
   metadata is not proof that a model supports the input.
3. Retain the default when it is suitable. Do not churn models between ordinary
   chats merely because a marginally cheaper model appears in the catalog.
4. For a necessary override, establish the task/stage quality floor and apply
   the owner's allowed models and cost constraints. Among eligible models,
   compare the cost/quality Pareto frontier. Cheapest is not automatically best.
5. Record the choice and explanation before execution. Keep the decision stable
   for that run and reconcile retries with it.

Use a cached capability matrix, price table and comparable benchmarks for the
fast path. A small, bounded classifier may assess ambiguous task complexity,
but an extra LLM call on every message is not the default design. “Planning” in
the message alone is not sufficient evidence to select an expensive model.
Benchmark intelligence is a useful signal, not a guarantee of task quality.
Sub-second routing is a latency target to measure, not a promise established by
this design. Cache TTLs, maximum staleness and classifier budgets need policy.

## Quality escalation and cost control

API errors are not the only failure signal. Failed task validation, inability to
use a required tool, or explicit user feedback may justify a stronger model.
A vague feeling that an answer is weak is not a reliable automatic signal.
Define evaluators against representative tasks before enabling quality-based
escalation. Escalation must have an attempt limit and a cost budget.

Do not replay external writes when changing models. After a tool has acted, a
new stage continues from recorded results and completed-action state rather than
restarting the whole task. Reuse the existing event and idempotency mechanisms.

Distinguish estimated per-million token price from a whole-task spending limit.
An estimate alone is not a spending cap. Collect actual provider usage separately
and correlate it with each routing decision and the parent task.

## Permissions and audit

Automatic routing must work for an otherwise-authorized teammate's request using
the agent's existing grants and owner-approved routing policy. It must not create
new credentials, grant new tools, require owner presence in the conversation,
or restore a per-project approval workflow.

OrgOps #112 currently checks agent-management authority for explicit overrides.
That API is a foundation, not yet the policy for automatic teammate-triggered
routing. Add server-controlled policy enforcement before treating arbitrary
message payloads as permission to select a costly model.

Prefer existing append-only decision and usage events. Record trigger/task/run
IDs, default and selected models, input requirements, reason, policy/catalog
version, quality signals, estimates, actual usage and escalation lineage. Add a
query/read model or side-table only if reporting requires it; it must not become
a second source of truth for the saved model.

## Delivery and acceptance

1. **Execution foundation — OrgOps #112:** isolated explicit task overrides,
   capability-filtered selection, price/quality constraints and turn telemetry.
   Its existing code is not an automatic classifier or a quality escalation loop.
2. **First invisible slice:** automatic capability mismatch recovery under an
   owner-approved policy, for ordinary project and private-chat messages. Preserve
   the default for suitable requests; cache metadata and persist decisions.
3. **Complexity and stage routing:** evaluated planning classification, stronger
   planning where needed, structured handoff to cheaper execution, and bounded
   quality escalation with no repeated external side effects.
4. **Nest presentation:** quiet indicator and optional explanation, using the
   OrgOps decision events. No command interface. Capture desktop/mobile evidence
   when the indicator is implemented; upload screenshots to the PR, never the repo.

Acceptance tests must cover an image with a text-only default, a text-only request
that stays on the default, non-image attachments, missing/stale catalog data,
unknown benchmarks, no eligible fallback, unauthorized policy changes, authorized
teammate requests, simultaneous chats, later turns, retries, planning/execution
handoffs, failed quality validation, bounded escalation, duplicate-action
prevention, and actual cost correlation. Verify cache-hit routing latency.

## Feedback needed before enabling automatic spend

Agree the owner-controlled cost/quality limits and eligible model policy; the
complexity/quality evaluation criteria; the stage handoff contract; and the cache
freshness/latency budget. Users should not have to configure these per message.

This draft removes the command implementation and its proposed dependency bump.
It deliberately changes no deployed routing behavior. Implementing the automatic
slices above and pinning the reviewed upstream engine remain outstanding.
