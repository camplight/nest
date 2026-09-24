// Installed at /app/.nest-data/codex-runtime/bridge.mjs on the Nest host.
// Keep Codex credentials and conversation state on the persistent data volume.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";

const runtime = "/app/.nest-data/codex-runtime";
const workspace = "/app/.nest-data/workspaces/NestAssistant";
const sessionKey = process.env.NEST_WRAPPED_SESSION_ID;
const message = process.env.NEST_WRAPPED_MESSAGE;
if (!sessionKey || !message) throw new Error("Missing Nest session or message");
const stateDir = join(runtime, "sessions");
mkdirSync(stateDir, { recursive: true, mode: 0o700 });
const statePath = join(stateDir, `${createHash("sha256").update(sessionKey).digest("hex")}.json`);
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {};
const args = ["exec", "-c", 'sandbox_mode="read-only"'];
if (state.threadId) args.push("resume", state.threadId);
args.push("--skip-git-repo-check", "--json", "-");
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
  },
  stdio: ["pipe", "pipe", "pipe"],
});
const instructions = "You are Nest Assistant, a helpful personal assistant accessed through a private Nest chat. Reply directly to the human. You run on the Nest server in a read-only sandbox. Be candid about capabilities and failures. Never reveal credentials or access unrelated runtime data. The input may be a Nest event batch: respond to its human messages. Your final response is posted to the same chat.\n\n";
child.stdin.on("error", () => {});
child.stdin.end((state.threadId ? "" : instructions) + message);
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
