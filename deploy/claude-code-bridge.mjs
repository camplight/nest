// Wrapped runtime bridge for Claude Code. See docs/CLAUDE_CODE_AGENT.md.
// Each Nest session key (agent + channel) resumes its own Claude Code session.
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, existsSync, readFileSync, readdirSync, writeFileSync, renameSync, rmSync, statSync, chownSync } from "node:fs";
import { dirname, join, relative, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

export const PERMISSION_PROFILES = ["read-only", "workspace", "full"];

const INSTRUCTIONS = "You are reached through a Nest chat channel. Reply directly to the people in it; your final response is posted to the same channel, and short text you write before using tools may be shown as progress. The input may be a JSON batch of Nest events: respond to its human messages. Never reveal credentials.";

/**
 * Host variables Claude Code needs. The runner passes its whole environment, including Nest's
 * admin password, master key and global runner token; none of those are forwarded.
 */
const PASSTHROUGH_ENV = [
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TMPDIR", "TERM",
  "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "NODE_EXTRA_CA_CERTS", "ANTHROPIC_BASE_URL",
  // Agent secrets. Outside `full`, the key reaches Claude Code through a helper file instead.
  "ANTHROPIC_API_KEY",
];

/** Credentials Claude Code would pass on to tool subprocesses; only `full` forwards them, scrubbed. */
const SCRUBBED_ENV = ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"];

/** The Nest checkout holding .env, both databases and uploads; the bridge lives in its deploy/ folder. */
const NEST_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * What sandboxed shell commands may still read under HOME, which is otherwise denied:
 * git configuration, Claude Code skills and common toolchain installs. Missing a toolchain
 * fails a command visibly; operators add it with NEST_CLAUDE_ALLOW_READ.
 */
const HOME_READABLE = [
  ".gitconfig", ".claude/skills", ".claude/plugins/cache", ".claude/plugins/marketplaces",
  ".local/bin", ".local/share/fnm", ".local/state/fnm_multishells", ".local/share/mise", ".local/share/pnpm", ".local/pipx",
  ".fnm", ".nvm", ".volta", ".bun", ".deno", ".cargo/bin", ".rustup", ".pyenv", ".rbenv", ".asdf", ".sdkman",
  ".yarn", ".nix-profile", "go/bin", "Library/pnpm",
];

// Built-in tools per profile, so tools added by future Claude Code releases (scheduling,
// remote triggers, notifications) stay off until reviewed. `full` keeps the default set.
const READ_ONLY_TOOLS = "Read,Grep,Glob";
const WORKSPACE_TOOLS = "Bash,Read,Edit,Write,Glob,Grep,NotebookEdit,Skill,Agent";

// The runner sends one SIGTERM to its shell and never escalates. Remove the process-group
// handling here once camplight/orgops#70 lands.
const KILL_GRACE_MS = 10_000;

const list = (value) => (value ? value.split(",").map((item) => item.trim()).filter(Boolean) : []);

/** Read the bridge configuration from the recipe's runtime.env and the runner's turn variables. */
export function readBridgeConfig(env = process.env, { nestRoot = NEST_ROOT } = {}) {
  const pick = (name) => env[`ORGOPS_WRAPPED_${name}`] || env[`NEST_WRAPPED_${name}`] || undefined;
  const permissions = env.NEST_CLAUDE_PERMISSIONS || "workspace";
  if (!PERMISSION_PROFILES.includes(permissions)) {
    throw Error(`NEST_CLAUDE_PERMISSIONS must be one of ${PERMISSION_PROFILES.join(", ")}`);
  }
  const workspace = pick("WORKSPACE_PATH");
  const projectRoot = env.ORGOPS_PROJECT_ROOT || (workspace ? dirname(workspace) : process.cwd());
  const stateDir = resolve(env.NEST_CLAUDE_STATE_DIR || join(projectRoot, "claude-code", "sessions"));
  const home = env.HOME ? resolve(env.HOME) : undefined;
  const account = (name) => {
    if (!env[name]) return undefined;
    if (!/^\d+$/.test(env[name])) throw Error(`${name} must be a numeric id`);
    return Number(env[name]);
  };
  const uid = account("NEST_CLAUDE_UID");
  const gid = account("NEST_CLAUDE_GID") ?? uid;
  if (uid !== undefined && permissions !== "full") throw Error("NEST_CLAUDE_UID is for the full profile, where the account is the boundary");
  // Claude Code refuses bypassPermissions as root; say how to fix it instead of failing every turn.
  if (permissions === "full" && uid === undefined && process.getuid?.() === 0) {
    throw Error("NEST_CLAUDE_PERMISSIONS=full needs a non-root account: set NEST_CLAUDE_UID (and NEST_CLAUDE_HOME)");
  }
  // The key helper is a shell command quoting this path.
  if (stateDir.includes("'")) throw Error("NEST_CLAUDE_STATE_DIR must not contain a quote character");
  if (workspace && permissions !== "full") {
    const inside = (parent, child) => { const path = relative(parent, child); return !path || (!path.startsWith("..") && !isAbsolute(path)); };
    // Reads are allowed inside the workspace, so it must not contain what the sandbox protects.
    for (const protectedPath of [nestRoot, stateDir, home].filter(Boolean)) {
      if (inside(resolve(workspace), protectedPath)) {
        throw Error("NEST_CLAUDE_PERMISSIONS needs a workspace that does not contain HOME, the Nest checkout or the session folder");
      }
    }
  }
  return {
    sessionKey: pick("SESSION_ID"),
    message: pick("MESSAGE"),
    workspace,
    bin: env.NEST_CLAUDE_BIN || "claude",
    stateDir,
    permissions,
    model: env.NEST_CLAUDE_MODEL || undefined,
    settingSources: env.NEST_CLAUDE_SETTING_SOURCES || undefined,
    allowedDomains: list(env.NEST_CLAUDE_ALLOWED_DOMAINS),
    uid,
    gid,
    home: env.NEST_CLAUDE_HOME || undefined,
    configDir: env.NEST_CLAUDE_CONFIG_DIR || undefined,
    denyRead: [
      nestRoot,
      stateDir,
      // Engine and product data can live outside the checkout (NEST_ENGINE_DATA_DIR, NEST_PRODUCT_DB_PATH).
      ...(env.ORGOPS_PROJECT_ROOT ? [dirname(resolve(env.ORGOPS_PROJECT_ROOT))] : []),
      ...(env.NEST_PRODUCT_DB_PATH ? [dirname(resolve(nestRoot, env.NEST_PRODUCT_DB_PATH))] : []),
      // The host account's other credentials, tokens and history.
      ...(home ? [home] : []),
    ],
    allowRead: [
      ...(workspace ? [workspace] : []),
      ...(home ? HOME_READABLE.map((path) => join(home, path)) : []),
      ...list(env.NEST_CLAUDE_ALLOW_READ),
    ],
  };
}

/** Command-line arguments for one turn. The permission profile is the only security switch. */
export function claudeArgs(config, sessionId, { apiKeyFile } = {}) {
  const args = ["-p", "--output-format", "stream-json", "--verbose", "--append-system-prompt", INSTRUCTIONS];
  // Claude Code reads the key through a helper, so tool subprocesses never inherit it.
  const credentials = apiKeyFile ? { apiKeyHelper: `cat '${apiKeyFile}'` } : {};
  if (config.permissions === "full") {
    // Only for a runner that is isolated by its own machine or OS account.
    args.push("--permission-mode", "bypassPermissions");
  } else if (config.permissions === "workspace") {
    // File tools edit inside the workspace and need approval elsewhere, which a headless
    // turn denies. Shell commands run in the OS sandbox: writes stay in the workspace,
    // Nest's data and the host account's HOME are unreadable apart from toolchains and
    // Claude Code skills, and network is opt-in.
    // Claude Code itself refuses writes to .claude/ settings and .mcp.json, so a turn
    // cannot plant hooks or MCP servers that would run outside the sandbox later.
    args.push("--permission-mode", "acceptEdits", "--tools", WORKSPACE_TOOLS, "--settings", JSON.stringify({
      ...credentials,
      sandbox: {
        enabled: true,
        failIfUnavailable: true,
        autoAllowBashIfSandboxed: true,
        allowUnsandboxedCommands: false,
        filesystem: { denyRead: config.denyRead, allowRead: config.allowRead },
        network: { allowedDomains: config.allowedDomains },
      },
    }));
  } else {
    // An allowlist of built-in tools: dontAsk alone still runs commands Claude Code classes
    // as read-only, unsandboxed, through Bash, Monitor or a subagent. Reads stay in the workspace.
    args.push("--permission-mode", "dontAsk", "--tools", READ_ONLY_TOOLS);
    if (apiKeyFile) args.push("--settings", JSON.stringify(credentials));
  }
  // MCP tools run outside the sandbox with the account's own access; only `full` keeps them.
  if (config.permissions !== "full") args.push("--strict-mcp-config");
  if (config.model) args.push("--model", config.model);
  if (config.settingSources) args.push("--setting-sources", config.settingSources);
  if (sessionId) args.push("--resume", sessionId);
  return args;
}

export function claudeEnvironment(env, config = {}) {
  const result = Object.fromEntries(PASSTHROUGH_ENV.filter((key) => env[key]).map((key) => [key, env[key]]));
  // A bridged turn is not an interactive install; updates come from the image or the operator.
  result.DISABLE_AUTOUPDATER = "1";
  if (config.home) result.HOME = config.home;
  if (config.configDir) result.CLAUDE_CONFIG_DIR = config.configDir;
  if (config.permissions === "full") {
    // Without an OS sandbox, Claude Code strips its credentials from tool subprocesses itself.
    // (The scrub also changes sandbox behaviour, so the sandboxed profiles use a key file instead.)
    for (const key of SCRUBBED_ENV) if (env[key]) result[key] = env[key];
    result.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB = "1";
  }
  return result;
}

/** Create a folder Claude Code writes to, owned by the account it runs as. */
function ensureOwnedDir(dir, { uid, gid }) {
  if (!dir) return;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (uid !== undefined && statSync(dir).uid !== uid) chownSync(dir, uid, gid);
}

/** Consume Claude Code stream-json; publish only assistant text, never thinking, tool input or tool output. */
export function createClaudeOutput({ publishProgress, onProgressError = () => {} }) {
  let buffer = "", sessionId, result, candidate, segment = 0, lastMessageId, assistantError;
  let pending = Promise.resolve(), progressFailed = false;
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
    if (!event || typeof event !== "object" || result) return;
    if (typeof event.session_id === "string" && event.type !== "system") sessionId = event.session_id;
    if (event.type === "system" && event.subtype === "init" && typeof event.session_id === "string") sessionId = event.session_id;
    if (event.type === "result") {
      // The final assistant text arrives as the result; the last candidate is not progress.
      candidate = undefined;
      result = event;
      return;
    }
    // Subagent messages and their reports are tool activity, not the agent speaking to the chat.
    if (event.parent_tool_use_id) return;
    if (event.type === "user") { publishCandidate(); return; }
    if (event.type !== "assistant" || !event.message || !Array.isArray(event.message.content)) return;
    if (typeof event.error === "string") assistantError = event.error;
    const messageId = typeof event.message.id === "string" ? event.message.id : "";
    for (const block of event.message.content) {
      if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
        if (candidate && messageId === lastMessageId) {
          candidate.text = `${candidate.text}\n\n${block.text}`;
        } else {
          // A new assistant message proves the previous text was an interim update.
          publishCandidate();
          candidate = { id: `${messageId}:${segment++}`, text: block.text };
        }
        lastMessageId = messageId;
      } else if (block?.type === "tool_use") {
        publishCandidate();
      }
    }
  }
  return {
    write(chunk) {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        consume(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1);
      }
    },
    async finish() {
      if (buffer.trim()) consume(buffer);
      buffer = "";
      await pending;
      const success = result?.subtype === "success" && result.is_error !== true && typeof result.result === "string";
      return {
        sessionId: result?.session_id || sessionId,
        finalText: success ? result.result : "",
        failure: !success,
        // Zero turns means Claude Code rejected the request before running it.
        started: Boolean(result) && result.num_turns !== 0,
        errorStatus: result?.api_error_status ?? undefined,
        subtype: result?.subtype,
        // Claude Code reports sign-in and limit failures here, not on stderr.
        errorText: [
          assistantError,
          result?.is_error && typeof result.result === "string" ? result.result : "",
          ...(Array.isArray(result?.errors) ? result.errors.filter((item) => typeof item === "string") : []),
        ].filter(Boolean).join("\n"),
      };
    },
  };
}

/** One short, actionable line for the chat; raw Claude Code diagnostics stay out of Nest events. */
export function describeFailure({ code, stderr, output, missingBinary, stopped, bin }) {
  if (missingBinary) return `Could not start Claude Code (${bin}). Install it on the runner host or set NEST_CLAUDE_BIN.`;
  if (stopped) return "Claude Code was stopped before it finished.";
  const text = `${stderr}\n${output?.errorText ?? ""}`;
  if (output?.errorStatus === 401 || /authentication_failed|not logged in|invalid api key|\/login/i.test(text)) {
    return "Claude Code is not signed in on the runner host. Run `claude` there and sign in, or configure ANTHROPIC_API_KEY as an agent secret.";
  }
  if (/sandbox required but unavailable/i.test(text)) {
    return "Claude Code's sandbox is unavailable on the runner host. Install bubblewrap and socat there, or choose another permission profile.";
  }
  if (output?.errorStatus === 429 || /rate_limit|rate limit|usage limit|billing_error|credit balance/i.test(text)) {
    return "Claude Code reached a usage, rate or billing limit. Try again later.";
  }
  if (output?.subtype === "error_max_turns") return "Claude Code stopped after reaching its maximum number of steps.";
  if (output?.started && !output.failure) return "Claude Code finished the turn without a written reply.";
  if (code === null) return "Claude Code was stopped before it finished.";
  return "Claude Code did not complete the turn. Check the runner host's Claude Code installation and sign-in.";
}

const MISSING_SESSION = /No conversation found/i;

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}

/** Key files of bridges that were killed before their cleanup ran. */
function removeOrphanedKeyFiles(stateDir) {
  for (const name of readdirSync(stateDir)) {
    const pid = Number(/^\.key-(\d+)-/.exec(name)?.[1]);
    if (pid && !isAlive(pid)) rmSync(join(stateDir, name), { force: true });
  }
}

function readState(path) {
  try { return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {}; } catch { return {}; }
}

function runClaude(config, sessionId, { env, publishProgress, onProgressError, spawnImpl, killGraceMs, apiKeyFile }) {
  return new Promise((done) => {
    const output = createClaudeOutput({ publishProgress, onProgressError });
    let stderr = "", missingBinary = false, closed = false, stopped = false, killTimer;
    const childEnv = claudeEnvironment(env, config);
    if (apiKeyFile) delete childEnv.ANTHROPIC_API_KEY;
    const child = spawnImpl(config.bin, claudeArgs(config, sessionId, { apiKeyFile }), {
      cwd: config.workspace,
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe"],
      // Its own process group, so tool subprocesses are stopped with it.
      detached: true,
      ...(config.uid !== undefined ? { uid: config.uid, gid: config.gid } : {}),
    });
    const killGroup = (signal) => {
      try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch {} }
    };
    const forward = (signal) => {
      stopped = true;
      killGroup(signal);
      killTimer ??= setTimeout(() => { if (!closed) killGroup("SIGKILL"); }, killGraceMs);
      killTimer.unref?.();
    };
    for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, forward);
    child.stdin.on("error", () => {});
    child.stdin.end(config.message);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => output.write(chunk));
    child.stderr.setEncoding("utf8");
    // Kept in memory for failure classification only; never printed.
    child.stderr.on("data", (chunk) => { if (stderr.length < 16_000) stderr += chunk; });
    child.on("error", (error) => { if (error.code === "ENOENT") missingBinary = true; });
    child.on("close", async (code) => {
      closed = true;
      clearTimeout(killTimer);
      for (const signal of ["SIGTERM", "SIGINT"]) process.off(signal, forward);
      // Background tool processes must not outlive the turn that started them.
      if (child.pid) killGroup("SIGKILL");
      done({ code, stderr, missingBinary, stopped, output: await output.finish() });
    });
  });
}

/** Run one Nest turn. Returns the process exit code; prints only the final reply or one diagnostic line. */
export async function runBridge({ env = process.env, spawnImpl = spawn, publishProgress, stdout = console.log, stderr = console.error, killGraceMs = KILL_GRACE_MS } = {}) {
  const config = readBridgeConfig(env);
  if (!config.sessionKey || !config.message || !config.workspace) {
    stderr("Missing Nest session, message or workspace.");
    return 1;
  }
  if (!publishProgress) {
    try {
      const { createWrappedProgressPublisher } = await import("../packages/orgops-client/src/wrapped-progress.mjs");
      publishProgress = createWrappedProgressPublisher({ env, phase: "wrapped-progress" });
    } catch {
      // Progress needs the runner's engine context; the final reply does not.
      publishProgress = async () => {};
    }
  }
  let progressWarned = false;
  const onProgressError = () => {
    if (!progressWarned) stderr("Progress updates are unavailable; the final reply will still be returned.");
    progressWarned = true;
  };
  mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
  for (const dir of [config.workspace, config.home, config.configDir]) ensureOwnedDir(dir, config);
  const statePath = join(config.stateDir, `${createHash("sha256").update(config.sessionKey).digest("hex")}.json`);
  // The state folder is unreadable to sandboxed shells; the key file lives only for this turn.
  removeOrphanedKeyFiles(config.stateDir);
  const apiKeyFile = env.ANTHROPIC_API_KEY && config.permissions !== "full" ? join(config.stateDir, `.key-${process.pid}-${randomUUID()}`) : undefined;
  if (apiKeyFile) writeFileSync(apiKeyFile, env.ANTHROPIC_API_KEY, { mode: 0o600 });
  try {
    return await runTurn({ config, statePath, stdout, stderr, publishProgress, deps: { env, publishProgress, onProgressError, spawnImpl, killGraceMs, apiKeyFile } });
  } finally {
    if (apiKeyFile) rmSync(apiKeyFile, { force: true });
  }
}

async function runTurn({ config, statePath, stdout, stderr, publishProgress, deps }) {
  const state = readState(statePath);
  let run = await runClaude(config, state.sessionId, deps);
  if (state.sessionId && run.code !== 0 && !run.output.started && MISSING_SESSION.test(run.stderr)) {
    // Claude Code's local history for this chat is gone; continue in a new session rather than failing forever.
    await publishProgress({ id: `session-reset:${state.sessionId}`, text: "Earlier Claude Code history for this chat is unavailable, so this reply starts a new session." }).catch(() => {});
    run = await runClaude(config, undefined, deps);
  }
  const { output } = run;
  // Keep any session Claude Code actually ran, so a failed turn's context is not lost.
  if (output.started && output.sessionId && output.sessionId !== state.sessionId) {
    writeFileSync(`${statePath}.tmp`, JSON.stringify({ sessionId: output.sessionId }), { mode: 0o600 });
    renameSync(`${statePath}.tmp`, statePath);
  }
  if (run.code !== 0 || output.failure || !output.finalText.trim() || run.stopped) {
    stderr(describeFailure({ ...run, bin: config.bin }));
    return 1;
  }
  stdout(output.finalText);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await runBridge();
  } catch (error) {
    // The runner posts stderr to the chat: one line, never a stack trace.
    console.error(/NEST_CLAUDE_/.test(error?.message) ? error.message : "The Claude Code bridge failed before the turn started. Check the runner host.");
    process.exitCode = 1;
  }
}
