# Automatic task model routing: decision and implementation

## Original failure

[The original image request](https://nest.camplight.net/?view=projects&project=214d8d56-2261-4ece-9ef7-c2c60ac90887&tab=chat&message=c779bee1-7e11-4bc0-a4f7-f02f05459501)
asked PuffVitaliy to use a PNG as an infographic example. Its text-only model
rejected image input. Changing the saved model affected unrelated chats; temporary
switch/revert also races with concurrent tasks. A separate Codex wrapper failure
in that incident is not addressed by model routing.

## Research decision (23 November 2026)

| Option | Fit for Nest | Tradeoff |
| --- | --- | --- |
| OpenRouter Auto Router | Existing provider connection; managed capability/task-aware selection and session adaptation | Provider-managed decisions; account policy and observed usage must be monitored |
| Jev decision API / custom router | Typed decisions can classify task needs before our selection policy | Requires catalog, policy, scoring, calibration and fallback implementation; not an answer model |
| OpenRouter Jev Router | Hosted Jev routing without a custom classifier | Its include-model preferences may fall back outside that list, unlike Auto Router's hard allowed list |
| RouteLLM | Open source framework for evaluating/serving learned routers | Additional serving/calibration work; not a turnkey solution to Nest's attachment ingestion and agent lifecycle |

Primary sources:
- [Auto Router](https://openrouter.ai/docs/guides/routing/routers/auto-router)
- [Jev Router](https://openrouter.ai/docs/guides/routing/routers/jev-router)
- [TypeSafe primitives](https://docs.typesafe.ai/introduction)
- [RouteLLM](https://github.com/lm-sys/RouteLLM)

Choose **OpenRouter Auto Router** for the first working integration. Its current
docs describe a fast decision stage, capability filtering, task/effort selection
and session signals. It already exposes Jev routing metadata, so a separate Jev
classifier would duplicate part of this path. This is an integration choice, not
an independently measured claim that it is globally optimal or always faster.

## Delivered behavior

Nest's runner launcher defaults `ORGOPS_TASK_MODEL_ROUTING` to `openrouter-auto`.
The upstream runner applies `openrouter:openrouter/auto` to a local copy for native
CLASSIC OpenRouter agents. Human chat syntax is unchanged: no `/model`, thresholds
or model-picker interaction. Existing saved model IDs, grants and credentials are
unchanged; concurrent rooms get separate provider session keys. Explicit upstream
taskModel requests still take precedence. Wrapped Claude/Codex, RLM and other
providers are unaffected.

The original image/tool inputs reach the router. Required provider parameters are
enforced, and automatic turns do not recover by silently discarding image input.
The SDK's concrete serving model is recorded in turn events and usage. The
existing bounded runner loop remains; no new tool replay or escalation loop is
introduced. Routing applies per provider request, including later tool steps,
rather than pinning one concrete model for the entire task.

Operators may set `NEST_TASK_MODEL_ROUTING=off`,
`NEST_TASK_MODEL_COST_TIER` (default medium), or a comma-separated
`NEST_TASK_MODEL_ALLOWED_MODELS` hard allowlist. Provider-account governance and
budgets remain authoritative. Cost tiers are preferences, not fixed quality floors
or whole-task spending limits. An external runner must be configured equivalently;
Nest cannot change another process's environment.

## Boundaries and verification

[OrgOps #112](https://github.com/camplight/orgops/pull/112) owns runtime integration;
[Nest #97](https://github.com/camplight/nest/pull/97) enables it and pins that engine.
The pin is proposed until upstream review/merge, not a production deployment.

Tests cover saved-default isolation, per-room sessions, disabled/inapplicable
agents, policy parsing, transport of images and tools, and a real SDK tool loop
against a local provider fixture. The fixture proves protocol behavior, not live
OpenRouter model quality. Live image success, comparative cost and routing latency
still need a provider-backed evaluation. Current SDK usage accounting retains
its existing last-step behavior; this is not new complete multi-step cost accounting.

Audio/video/document ingestion is not added by choosing a router. No separate
planning/execution scheduler is introduced; provider-managed model/effort
adaptation is the first implementation. Hard task budgets and independently
measured quality escalation are follow-up work, not guarantees of this PR.

Tracking: [Trello #192](https://trello.com/c/ZjnIN3Qt/192).
