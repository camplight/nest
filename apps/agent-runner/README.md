# Nest Agent Runner

Agent supervisor that polls events, calls the LLM, executes tools, and emits audit events.
Each runner registers itself with the API and persists identity to `.agent-runner-id`
so agents can be pinned to a stable runner host.

## Agent Modes

- `CLASSIC` (default): single-shot structured JSON event generation.
- `RLM_REPL`: recursive REPL loop with persistent per-agent VM context.
  - Runs in a dedicated child Node process per agent.
  - Child process is started with `cwd` set to the agent workspace path.
  - Runner sets a global `prompt` variable each handled event.
  - LLM emits one JS REPL input per step; runner executes and appends input/output to channel audit events.
  - Completion is signaled only by calling `done(result)` inside the REPL.
  - Recursive delegation is available via `spawnSubagent(promptText)`, and subagents also finish with `done(result)`.

## Run

```bash
npm run dev
```

## Environment

- `NEST_API_URL` (default: `http://localhost:8787`)
- `NEST_RUNNER_TOKEN` (shared with API)
- `NEST_RUNNER_ID_FILE` (default: `.agent-runner-id`)
- `NEST_PROJECT_ROOT` (optional monorepo root override used for resolving skills/workspaces)
- `NEST_LLM_STUB=1` to stub LLM calls
- `OPENAI_API_KEY` (for OpenAI models)
- `ANTHROPIC_API_KEY` (for Anthropic models)
- `OPENROUTER_API_KEY` (for OpenRouter models)
- `OPENROUTER_BASE_URL` (optional; default: `https://openrouter.ai/api/v1`)
- `OPENROUTER_HTTP_REFERER` / `OPENROUTER_APP_TITLE` (optional OpenRouter request headers)
- `NEST_LLM_CALL_TIMEOUT_MS` (default: `10800000`)
- `NEST_HISTORY_MAX_EVENTS` / `NEST_HISTORY_MAX_CHARS` (prompt history bounds)
- `NEST_CHANNEL_RECENT_MEMORY_INTERVAL_MS` (default: `10000`)
- `NEST_CHANNEL_FULL_MEMORY_INTERVAL_MS` (default: `60000`)
- `NEST_CROSS_RECENT_MEMORY_INTERVAL_MS` (default: `15000`)
- `NEST_CROSS_FULL_MEMORY_INTERVAL_MS` (default: `120000`)
- `NEST_AGENT_INTENT_TIMEOUT_MS` (default: `45000`)
- `NEST_AGENT_INTENT_MAX_TIMEOUTS` (default: `3`)
- `NEST_GIT_BASH_PATH` (optional Windows path to `bash.exe`)
- `NEST_SHELL_PATH` / `NEST_SHELL_ARGS` (optional shell override for `shell_*` tools)
- `NEST_SHELL_TIMEOUT_KILL_GRACE_MS` (optional post-timeout kill grace)
- `NEST_RLM_MAX_STEPS` (default: `24`)
- `NEST_RLM_EVAL_TIMEOUT_MS` (default: `10000`)
- `NEST_RLM_MAX_INPUT_CHARS` (default: `16000`)
- `NEST_RLM_MAX_OUTPUT_CHARS` (default: `16000`)
- `NEST_RLM_PROMPT_PREVIEW_MAX_CHARS` (default: `4000`)
- `NEST_RLM_MAX_SUBAGENT_DEPTH` (default: `3`)
- `NEST_RLM_MAX_SUBAGENTS_PER_EVENT` (default: `12`)
