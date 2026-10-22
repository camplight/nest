// Install only for NestSystem at /app/.nest-data/codex-runtime/nestsystem-bridge.mjs.
// Keep Codex credentials and conversation state on the persistent data volume.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Consume only public assistant messages; never forward reasoning or tool output. */
export function createCodexOutput({publishProgress, onProgressError = () => {}}) {
  let buffer = '', threadId, finalText = '', failure = false, candidate;
  let pending = Promise.resolve(), progressFailed = false;
  const seen = new Set();
  function publishCandidate() {
    if (!candidate) return;
    const update = candidate;
    candidate = undefined;
    pending = pending.then(async () => {
      if (progressFailed) return;
      try { await publishProgress(update); }
      catch { progressFailed = true; onProgressError(); }
    });
  }
  function consume(line) {
    let event;
    try { event = JSON.parse(line); } catch { return; }
    if (!event || typeof event !== 'object') return;
    if (event.type === 'thread.started' && typeof event.thread_id === 'string') threadId = event.thread_id;
    if (event.type === 'turn.failed' || event.type === 'error') { failure = true; candidate = undefined; }
    const item = event.item;
    if (failure || !item || typeof item.id !== 'string' || (typeof event.type !== 'string' || !event.type.startsWith('item.'))) return;
    if (item.type === 'agent_message' && seen.has(item.id)) return;
    // A following item proves the previous assistant message was an interim update.
    // Keep the last message for the runner's existing final-reply path.
    if (candidate && item.id !== candidate.id) publishCandidate();
    if (event.type === 'item.completed' && item.type === 'agent_message' &&
        typeof item.text === 'string' && item.text.trim()) {
      seen.add(item.id);
      finalText = item.text;
      candidate = {id: item.id, text: item.text};
    }
  }
  return {
    write(chunk) {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        consume(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1);
      }
    },
    async finish() {
      if (buffer.trim()) consume(buffer);
      buffer = '';
      await pending;
      return {threadId, finalText, failure};
    },
  };
}

async function runBridge() {
  const { managementEnvironment } = await import('/app/skills/nest-management/scripts/capability.mjs');
  const { createWrappedProgressPublisher } = await import('/app/packages/orgops-client/src/wrapped-progress.mjs');

  const runtime = "/app/.nest-data/codex-runtime";
  const workspace = process.env.ORGOPS_WRAPPED_WORKSPACE_PATH || process.env.NEST_WRAPPED_WORKSPACE_PATH || "/app/.nest-data/workspaces/NestSystem";
  const sessionKey = process.env.ORGOPS_WRAPPED_SESSION_ID || process.env.NEST_WRAPPED_SESSION_ID;
  const message = process.env.ORGOPS_WRAPPED_MESSAGE || process.env.NEST_WRAPPED_MESSAGE;
  if (!sessionKey || !message) throw new Error("Missing Nest session or message");
  const stateDir = join(runtime, "nestsystem-sessions");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const statePath = join(stateDir, `${createHash("sha256").update(sessionKey).digest("hex")}.json`);
  const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {};
  const args = ["exec", "--dangerously-bypass-approvals-and-sandbox"];
  if (state.threadId) args.push("resume", state.threadId);
  args.push("--skip-git-repo-check", "--json", "-");
  const output = createCodexOutput({
    publishProgress: createWrappedProgressPublisher(),
    onProgressError: () => console.error('Progress updates are unavailable; the final reply will still be returned.'),
  });
  // Only this trusted bridge sees the engine credential. Codex receives only a request-bound management proof.
  const child = spawn(join(runtime, "node_modules/.bin/codex"), args, {
    cwd: workspace,
    uid: 1000,
    gid: 1000,
    // Never forward Nest's admin credentials, encryption key or runner token.
    env: {
      PATH: "/usr/local/bin:/usr/bin:/bin",
      HOME: "/home/node",
      CODEX_HOME: "/app/.nest-data/codex-home",
      LANG: "C.UTF-8",
      ...managementEnvironment(process.env),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const instructions = "You are NestSystem, a system and development assistant accessed through Nest project and private chats. Reply directly to the human. You run on the Nest server with Codex sandboxing disabled. Use tools to perform authorized work and verify results; operating-system permissions still apply. Be candid about capabilities and failures. Never reveal credentials or access unrelated runtime data. The input may be a Nest event batch: respond to its human messages. Your final response is posted to the same chat.\n\n";
  child.stdin.on("error", () => {});
  const managementInstructions = "An authenticated Nest management helper is available for this request. When asked to create/find an agent or add people/agents to the current project, read /app/skills/nest-management/SKILL.md and use its authenticated helper. Project invitations require an explicit request from that project’s owner; a mention alone is not an invitation. This permission stays enabled until revoked; no sign-in is needed. Never print the capability or use unauthenticated curl for management actions.\n\n";
  child.stdin.end((state.threadId ? "" : instructions) + managementInstructions + message);
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => output.write(chunk));
  // Codex diagnostic logs are not chat messages and can contain sensitive context.
  child.stderr.resume();
  child.on("error", () => {
    console.error("Could not start Codex. Check the server installation.");
    process.exitCode = 1;
  });
  child.on("close", async code => {
    const result = await output.finish();
    const threadId = result.threadId || state.threadId;
    const {finalText, failure} = result;
    if (code !== 0 || failure || !finalText || !threadId) {
      console.error("Codex did not complete the turn. Check subscription availability and login status on the server.");
      process.exitCode = 1;
      return;
    }
    writeFileSync(`${statePath}.tmp`, JSON.stringify({ threadId }), { mode: 0o600 });
    renameSync(`${statePath}.tmp`, statePath);
    console.log(finalText);
  });
  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, () => child.kill(signal));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runBridge();
