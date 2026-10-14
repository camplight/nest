// Install only for NestSystem at /app/.nest-data/codex-runtime/nestsystem-bridge.mjs.
// Keep Codex credentials and conversation state on the persistent data volume.
import { spawn } from "node:child_process";
import { managementEnvironment } from "/app/skills/nest-management/scripts/capability.mjs";
import { createHash } from "node:crypto";
import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";

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
let buffer = "";
let threadId = state.threadId;
let finalText = "";
let failure = false;
function consume(line) {
  let event;
  try { event = JSON.parse(line); } catch { return; }
  if (event.type === "thread.started") threadId = event.thread_id;
  if (event.type === "item.completed" && event.item?.type === "agent_message") {
    finalText = event.item.text;
  }
  if (event.type === "turn.failed" || event.type === "error") failure = true;
}
child.stdout.setEncoding("utf8");
child.stdout.on("data", chunk => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) !== -1) {
    consume(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
  }
});
// Codex diagnostic logs are not chat messages and can contain sensitive context.
child.stderr.resume();
child.on("error", () => {
  console.error("Could not start Codex. Check the server installation.");
  process.exitCode = 1;
});
child.on("close", code => {
  if (buffer.trim()) consume(buffer);
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
