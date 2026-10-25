// Wrapped runtime bridge for Claude Code. See docs/CLAUDE_CODE_AGENT.md.
// Each Nest session key (agent + channel) resumes its own Claude Code session.
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, existsSync, readFileSync, readdirSync, writeFileSync, renameSync, rmSync, lstatSync, lchownSync, chmodSync, realpathSync, openSync, fchmodSync, writeSync, closeSync, constants } from "node:fs";
import { basename, dirname, join, normalize, relative, resolve, isAbsolute, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { readCredential, startCredentialProxy } from "./claude-code-proxy.mjs";

export const PERMISSION_PROFILES = ["workspace", "full"];

const INSTRUCTIONS = "You are reached through a Nest chat channel. Reply directly to the people in it; your final response is posted to the same channel, and short text you write before using tools may be shown as progress. The input may be a JSON batch of Nest events: respond to its human messages. Never reveal credentials.";

/**
 * Host variables Claude Code needs. The runner passes its whole environment, including Nest's
 * admin password, master key and global runner token; none of those are forwarded.
 */
const PASSTHROUGH_ENV = [
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TMPDIR", "TERM",
  "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "NODE_EXTRA_CA_CERTS",
];

/**
 * Names an agent's tool secrets can never take: Nest, engine, Anthropic and bridge-controlled
 * variables, and loader or runtime variables, because the runner also injects the secrets into
 * the bridge, which runs as root.
 */
export function isProtectedName(name) {
  const upper = String(name).toUpperCase();
  return /^(NEST_|ORGOPS_|ANTHROPIC_|CLAUDE_|NODE_|LD_|DYLD_)/.test(upper) || PASSTHROUGH_ENV.includes(upper)
    || ["DISABLE_AUTOUPDATER", "BASH_ENV", "ENV"].includes(upper);
}

/** The listed tool secrets that are set, minus protected names. */
export function forwardedSecrets(env, names) {
  return Object.fromEntries(names.filter((name) => !isProtectedName(name) && env[name]).map((name) => [name, env[name]]));
}

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

// Built-in tools for `workspace`, so tools added by future Claude Code releases (scheduling,
// remote triggers, notifications) stay off until reviewed. `full` keeps the default set.
const WORKSPACE_TOOLS = "Bash,Read,Edit,Write,Glob,Grep,NotebookEdit,Skill,Agent";

// The runner sends one SIGTERM to its shell and never escalates.
const KILL_GRACE_MS = 10_000;
// How often a running turn looks for tool processes that left Claude Code's process group.
const PROCESS_SCAN_MS = 500;

const list = (value) => (value ? value.split(",").map((item) => item.trim()).filter(Boolean) : []);

const inside = (parent, child) => { const path = relative(parent, child); return !path || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path)); };

/** The real location of a path whose tail may not exist yet; the runner reaches workspaces through a link. */
function realPath(path) {
  const rest = [];
  for (let current = resolve(path); ; current = dirname(current)) {
    try { return join(realpathSync(current), ...rest); } catch {}
    if (dirname(current) === current) return resolve(path);
    rest.unshift(basename(current));
  }
}

/** `NAME:relative/path` entries; a bad one stops the turn before anything is written. */
function readSecretFiles(value, home) {
  const mappings = list(value).map((item) => {
    const at = item.indexOf(":");
    const name = at > 0 ? item.slice(0, at).trim() : "", path = at > 0 ? item.slice(at + 1).trim() : "";
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || isProtectedName(name) || !path || isAbsolute(path) || path.split(/[\\/]/).includes("..") || normalize(path) === ".") {
      throw Error(`NEST_CLAUDE_SECRET_FILES entries must be NAME:relative/path inside Claude's home, not a protected name (${JSON.stringify(item)})`);
    }
    return { name, path: normalize(path) };
  });
  if (mappings.length && !home) throw Error("NEST_CLAUDE_SECRET_FILES needs NEST_CLAUDE_HOME, so secret files never land in the runner account's own home");
  return mappings;
}

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
  // The workspace sandbox protects the runner account's HOME; another home would be left readable.
  if ((env.NEST_CLAUDE_HOME || env.NEST_CLAUDE_CONFIG_DIR) && permissions !== "full") {
    throw Error("NEST_CLAUDE_HOME and NEST_CLAUDE_CONFIG_DIR are for the full profile");
  }
  // Claude Code refuses bypassPermissions as root; say how to fix it instead of failing every turn.
  if (permissions === "full" && (uid === 0 || (uid === undefined && process.getuid?.() === 0))) {
    throw Error("NEST_CLAUDE_PERMISSIONS=full needs a non-root account: set NEST_CLAUDE_UID (and NEST_CLAUDE_HOME)");
  }
  const productDb = resolve(nestRoot, env.NEST_PRODUCT_DB_PATH || ".nest-product/nest.sqlite");
  // Without a sandbox, a runner that can see Nest's data hands it to every shell command.
  if (permissions === "full" && existsSync(productDb)) {
    throw Error("NEST_CLAUDE_PERMISSIONS=full refuses to run next to Nest's data (product database found). Assign this agent to the agents runner.");
  }
  if (workspace) {
    const real = realPath(workspace);
    // Claude Code can read and change its whole workspace, so it must not contain Nest's data or
    // the session folder (nor, under the sandbox, the runner account's HOME).
    const contained = [nestRoot, stateDir, env.ORGOPS_PROJECT_ROOT, ...(permissions === "full" ? [] : [home])].filter(Boolean);
    if (contained.some((path) => inside(real, realPath(path)))) {
      throw Error("NEST_CLAUDE_PERMISSIONS needs a workspace that does not contain HOME, the Nest checkout, the engine data or the session folder");
    }
    // Claude Code owns its workspace, so it must not sit in the session state or either database's folder.
    const protectedParents = [stateDir, env.ORGOPS_PROJECT_ROOT, dirname(productDb)].filter(Boolean);
    if (protectedParents.some((path) => inside(realPath(path), real))) {
      throw Error("NEST_CLAUDE_PERMISSIONS needs a workspace outside the session folder, ORGOPS_PROJECT_ROOT and Nest's product data");
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
    secrets: list(env.NEST_CLAUDE_SECRETS),
    secretFiles: readSecretFiles(env.NEST_CLAUDE_SECRET_FILES, env.NEST_CLAUDE_HOME),
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
export function claudeArgs(config, sessionId) {
  const args = ["-p", "--output-format", "stream-json", "--verbose", "--append-system-prompt", INSTRUCTIONS];
  if (config.permissions === "full") {
    // Only for a runner that is isolated by its own machine or OS account.
    args.push("--permission-mode", "bypassPermissions");
  } else {
    // File tools edit inside the workspace and need approval elsewhere, which a headless
    // turn denies. Shell commands run in the OS sandbox: writes stay in the workspace,
    // Nest's data and the host account's HOME are unreadable apart from toolchains and
    // Claude Code skills, and network is opt-in.
    // Claude Code itself refuses writes to .claude/ settings and .mcp.json, so a turn
    // cannot plant hooks or MCP servers that would run outside the sandbox later.
    args.push("--permission-mode", "acceptEdits", "--tools", WORKSPACE_TOOLS, "--settings", JSON.stringify({
      sandbox: {
        enabled: true,
        failIfUnavailable: true,
        autoAllowBashIfSandboxed: true,
        allowUnsandboxedCommands: false,
        filesystem: { denyRead: config.denyRead, allowRead: config.allowRead },
        network: { allowedDomains: config.allowedDomains },
      },
    }));
  }
  // MCP tools run outside the sandbox with the account's own access; only `full` keeps them.
  if (config.permissions !== "full") args.push("--strict-mcp-config");
  if (config.model) args.push("--model", config.model);
  if (config.settingSources) args.push("--setting-sources", config.settingSources);
  if (sessionId) args.push("--resume", sessionId);
  return args;
}

/** Claude Code's environment. A credential secret never enters it; the turn's proxy supplies a dummy. */
export function claudeEnvironment(env, config = {}) {
  const result = Object.fromEntries(PASSTHROUGH_ENV.filter((key) => env[key]).map((key) => [key, env[key]]));
  // Without a credential secret, the host account's own login and API URL apply.
  if (env.ANTHROPIC_BASE_URL && !readCredential(env)) result.ANTHROPIC_BASE_URL = env.ANTHROPIC_BASE_URL;
  Object.assign(result, forwardedSecrets(env, config.secrets ?? []));
  // A bridged turn is not an interactive install; updates come from the image or the operator.
  result.DISABLE_AUTOUPDATER = "1";
  if (config.home) result.HOME = config.home;
  if (config.configDir) result.CLAUDE_CONFIG_DIR = config.configDir;
  return result;
}

/** Create a folder Claude Code writes to, owned by the account it runs as; folders above it stay traversable. */
function ensureOwnedDir(dir, { uid, gid }) {
  if (!dir) return;
  mkdirSync(dirname(dir), { recursive: true, mode: 0o755 });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Claude Code can replace folders under its home with links; never chown through one.
  const stat = lstatSync(dir);
  if (uid !== undefined && stat.isDirectory() && stat.uid !== uid) lchownSync(dir, uid, gid);
}

/**
 * With a separate account, the runner still writes chat attachments into the workspace as root
 * (`.orgops-wrapped-attachments`), creating folders and following links. The workspace therefore
 * stays owned by the bridge's account and Claude Code works in `work/` below it, so it cannot
 * redirect those writes. Returns the folder Claude Code runs in.
 */
export function prepareWorkspace({ workspace, uid, gid }) {
  if (uid === undefined) { mkdirSync(workspace, { recursive: true, mode: 0o700 }); return workspace; }
  const owner = process.geteuid?.() ?? uid;
  mkdirSync(workspace, { recursive: true, mode: 0o755 });
  const stat = lstatSync(workspace);
  if (!stat.isDirectory()) throw Error("NEST_CLAUDE_UID needs the agent workspace to be a folder");
  if (stat.uid !== owner) lchownSync(workspace, owner, process.getegid?.() ?? gid);
  chmodSync(workspace, 0o755);
  const attachments = join(workspace, ".orgops-wrapped-attachments");
  const existing = (() => { try { return lstatSync(attachments); } catch { return undefined; } })();
  // Planted by an earlier turn: keep it for inspection, but out of the runner's way.
  if (existing && (!existing.isDirectory() || existing.uid !== owner)) renameSync(attachments, `${attachments}.untrusted-${Date.now()}`);
  const work = join(workspace, "work");
  ensureOwnedDir(work, { uid, gid });
  return work;
}

/** Run file work in Claude's home with its account's rights, so a link it planted cannot redirect root's writes. */
function asAccount({ uid, gid }, action) {
  if (uid === undefined || uid === 0 || process.geteuid?.() !== 0) return action();
  const groups = process.getgroups(), egid = process.getegid();
  process.setgroups([gid]); process.setegid(gid); process.seteuid(uid);
  try { return action(); } finally { process.seteuid(0); process.setegid(egid); process.setgroups(groups); }
}

/** Write each mapped secret under Claude's home (600, new folders 700); remove files whose secret is gone. */
export function writeSecretFiles({ env, mappings, home, uid, gid }) {
  asAccount({ uid, gid: gid ?? uid }, () => {
    for (const { name, path } of mappings) {
      const file = join(home, path);
      if (!env[name]) { rmSync(file, { force: true }); continue; }
      let dir = home;
      for (const part of dirname(path).split(sep).filter((item) => item && item !== ".")) {
        dir = join(dir, part);
        if (!existsSync(dir)) mkdirSync(dir, { mode: 0o700 });
      }
      const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
      try {
        fchmodSync(fd, 0o600);
        // Keys and known_hosts files need a final newline.
        writeSync(fd, env[name].endsWith("\n") ? env[name] : `${env[name]}\n`);
      } finally { closeSync(fd); }
    }
  });
}

/** Consume Claude Code stream-json; publish only assistant text, never thinking, tool input or tool output. */
export function createClaudeOutput({ publishProgress, onProgressError = () => {} }) {
  let buffer = "", sessionId, result, candidate, segment = 0, lastMessageId, assistantError, answered = false;
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
    else answered = true;
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
        // A turn stopped by its limit has no result, but its history is saved as it runs.
        started: (Boolean(result) && result.num_turns !== 0) || answered,
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

/** Claude Code reports a rejected or missing credential in its stream, not on stderr. */
const isSignInFailure = ({ stderr = "", output }) => output?.errorStatus === 401 || /authentication_failed|not logged in|invalid api key|\/login/i.test(`${stderr}\n${output?.errorText ?? ""}`);

/** One short, actionable line for the chat; raw Claude Code diagnostics stay out of Nest events. */
export function describeFailure({ code, stderr, output, missingBinary, stopped, bin }) {
  if (missingBinary) return `Could not start Claude Code (${bin}). Install it on the runner host or set NEST_CLAUDE_BIN.`;
  if (stopped) return "Claude Code was stopped before it finished.";
  const text = `${stderr}\n${output?.errorText ?? ""}`;
  if (isSignInFailure({ stderr, output })) {
    return "Claude Code is not signed in. Add CLAUDE_CODE_OAUTH_TOKEN (from claude setup-token) or ANTHROPIC_API_KEY as a private secret of this agent.";
  }
  if (/sandbox required but unavailable/i.test(text)) {
    return "Claude Code's sandbox is unavailable on the runner host. Install bubblewrap and socat there, or choose another permission profile.";
  }
  if (output?.errorStatus === 429 || /rate_limit|rate limit|usage limit|billing_error|credit balance/i.test(text)) {
    return "Claude Code reached a usage, rate or billing limit. Try again later.";
  }
  if (output?.subtype === "error_max_turns") return "Claude Code stopped after reaching its maximum number of steps.";
  if (output?.subtype === "error_max_budget_usd") return "Claude Code stopped after reaching its spending limit for this turn.";
  if (output?.started && !output.failure) return "Claude Code finished the turn without a written reply.";
  if (code === null) return "Claude Code was stopped before it finished.";
  return "Claude Code did not complete the turn. Check the runner host's Claude Code installation and sign-in.";
}

const MISSING_SESSION = /No conversation found/i;

function readState(path) {
  try { return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {}; } catch { return {}; }
}

/** `ps` where there is no /proc (macOS): no session ids, so a process group stands in for its session. */
export function readPsTable(run = execFileSync) {
  try {
    return run("ps", ["-A", "-o", "pid=,ppid=,pgid=,lstart="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .split("\n").map((line) => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line)).filter(Boolean)
      .map(([, pid, ppid, pgrp, start]) => ({ pid: Number(pid), ppid: Number(ppid), pgrp: Number(pgrp), session: Number(pgrp), start }));
  } catch { return []; }
}

/** The process table from /proc, or from `ps` where there is none. */
export function readProcessTable(proc = "/proc", { fallback = readPsTable } = {}) {
  let names;
  try { names = readdirSync(proc); } catch { return fallback(); }
  const rows = [];
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = readFileSync(join(proc, name, "stat"), "utf8");
      // Fields after the command name, which may itself contain spaces and parentheses.
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      rows.push({ pid: Number(name), ppid: Number(fields[1]), pgrp: Number(fields[2]), session: Number(fields[3]), start: fields[19] });
    } catch {}
  }
  return rows;
}

/**
 * Follows every process a turn starts. Claude Code runs each Bash command in a session of its
 * own, so a background tool leaves Claude Code's process group and, once its shell exits, its
 * parentage too; its session and group stay. Root can read /proc/<pid>/stat but not another
 * account's environment, so these ids are what identifies a turn's processes. A process is
 * remembered with its start time, so a reused process id is never signalled.
 */
export function createProcessTracker(rootPid, { list = readProcessTable, kill = (pid, signal) => process.kill(pid, signal) } = {}) {
  const known = new Map(), groups = new Set([rootPid]);
  let rootStart;
  const scan = () => {
    const rows = list();
    const live = new Map(rows.map((row) => [row.pid, row.start]));
    const owns = (row) => (row.pid === rootPid ? (rootStart ??= row.start) === row.start
      : groups.has(row.pgrp) || groups.has(row.session) || (known.has(row.ppid) && known.get(row.ppid) === live.get(row.ppid)));
    for (let added = true; added;) {
      added = false;
      for (const row of rows) {
        if (known.get(row.pid) === row.start || !owns(row)) continue;
        known.set(row.pid, row.start);
        groups.add(row.pgrp).add(row.session);
        added = true;
      }
    }
    // A finished group's id can be reused by an unrelated process that becomes a leader.
    for (const id of groups) if (!rows.some((row) => row.pgrp === id || row.session === id)) groups.delete(id);
    for (const [pid, start] of known) if (live.get(pid) !== start) known.delete(pid);
    return rows;
  };
  return {
    scan,
    kill(signal) {
      scan();
      for (const pid of known.keys()) { try { kill(pid, signal); } catch {} }
    },
  };
}

function runClaude(config, sessionId, { env, publishProgress, onProgressError, spawnImpl, killGraceMs, proxyEnv, stop, reaper }) {
  return new Promise((done) => {
    const output = createClaudeOutput({ publishProgress, onProgressError });
    let stderr = "", missingBinary = false, closed = false, stopped = false, killTimer;
    // Under a subreaper, tools whose shell exits are reparented to it rather than to init, so the
    // tracker can still tell they belong to this turn.
    const [command, ...args] = [...(reaper ? [reaper, "-s", "--"] : []), config.bin, ...claudeArgs(config, sessionId)];
    const child = spawnImpl(command, args, {
      cwd: config.cwd ?? config.workspace,
      env: { ...claudeEnvironment(env, config), ...proxyEnv },
      stdio: ["pipe", "pipe", "pipe"],
      // Its own process group, so tool subprocesses are stopped with it.
      detached: true,
      ...(config.uid !== undefined ? { uid: config.uid, gid: config.gid } : {}),
    });
    const tracker = child.pid ? createProcessTracker(child.pid) : undefined;
    const scanTimer = tracker && setInterval(tracker.scan, PROCESS_SCAN_MS);
    scanTimer?.unref?.();
    const killGroup = (signal) => {
      try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch {} }
      tracker?.kill(signal);
    };
    const forward = (signal) => {
      stopped = true;
      killGroup(signal);
      killTimer ??= setTimeout(() => { if (!closed) killGroup("SIGKILL"); }, killGraceMs);
      killTimer.unref?.();
    };
    stop.forward = forward;
    if (stop.requested) forward("SIGTERM");
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
      // tini reports a program it could not start with 127.
      if (reaper && code === 127 && /exec .* failed/i.test(stderr)) missingBinary = true;
      clearTimeout(killTimer);
      clearInterval(scanTimer);
      stop.forward = undefined;
      // Background tool processes must not outlive the turn that started them.
      if (child.pid) killGroup("SIGKILL");
      done({ code, stderr, missingBinary, stopped, output: await output.finish() });
    });
  });
}

/** tini, shipped in the Nest image, as a child subreaper on Linux; elsewhere the process scan alone. */
function defaultReaper() {
  return process.platform === "linux" && existsSync("/usr/bin/tini") ? "/usr/bin/tini" : undefined;
}

/** Run one Nest turn. Returns the process exit code; prints only the final reply or one diagnostic line. */
export async function runBridge({ env = process.env, spawnImpl = spawn, publishProgress, stdout = console.log, stderr = console.error, killGraceMs = KILL_GRACE_MS, nestRoot = NEST_ROOT, reaper = defaultReaper() } = {}) {
  let config;
  try { config = readBridgeConfig(env, { nestRoot }); } catch (error) {
    if (!/NEST_CLAUDE_/.test(error?.message)) throw error;
    stderr(error.message);
    return 1;
  }
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
  // Reported only with a reply: a failed turn gets exactly one line.
  let progressFailed = false;
  const onProgressError = () => { progressFailed = true; };
  // The runner's SIGTERM can arrive at any point of the turn, not only while Claude Code runs.
  const stop = { requested: false, rejected: false, forward: undefined };
  const onSignal = (signal) => { stop.requested = true; stop.forward?.(signal); };
  for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, onSignal);
  mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
  config.cwd = prepareWorkspace(config);
  for (const dir of [config.home, config.configDir]) ensureOwnedDir(dir, config);
  // Rewritten every turn, so rotating or removing a secret in Admin takes effect on the next one.
  if (config.secretFiles.length) writeSecretFiles({ env, mappings: config.secretFiles, home: config.home, uid: config.uid, gid: config.gid });
  const statePath = join(config.stateDir, `${createHash("sha256").update(config.sessionKey).digest("hex")}.json`);
  const credential = readCredential(env);
  // A rejected credential would otherwise keep Claude Code retrying for minutes.
  const onRejected = () => { if (!stop.rejected) { stop.rejected = true; stop.forward?.("SIGTERM"); } };
  const proxy = credential ? await startCredentialProxy({ credential, upstream: env.NEST_CLAUDE_UPSTREAM_URL || undefined, onRejected }) : undefined;
  try {
    return await runTurn({ config, statePath, stdout, stderr, publishProgress, stop, progressFailed: () => progressFailed,
      deps: { env, publishProgress, onProgressError, spawnImpl, killGraceMs, proxyEnv: proxy?.childEnv, stop, reaper } });
  } finally {
    await proxy?.close();
    for (const signal of ["SIGTERM", "SIGINT"]) process.off(signal, onSignal);
  }
}

async function runTurn({ config, statePath, stdout, stderr, publishProgress, stop, progressFailed, deps }) {
  const state = readState(statePath);
  let run = await runClaude(config, state.sessionId, deps);
  if (state.sessionId && !stop.requested && !stop.rejected && run.code !== 0 && !run.output.started && MISSING_SESSION.test(run.stderr)) {
    // Claude Code's local history for this chat is gone; continue in a new session rather than failing forever.
    const missing = state.sessionId;
    // Forgotten even if the new session fails too, so later turns do not repeat the failed resume.
    rmSync(statePath, { force: true });
    state.sessionId = undefined;
    await publishProgress({ id: `session-reset:${missing}`, text: "Earlier Claude Code history for this chat is unavailable, so this reply starts a new session." }).catch(() => {});
    run = await runClaude(config, undefined, deps);
  }
  const { output } = run;
  // Keep any session Claude Code actually ran, so a failed turn's context is not lost;
  // a turn that never signed in has no context worth resuming.
  if (output.started && output.sessionId && output.sessionId !== state.sessionId && !isSignInFailure(run) && !stop.rejected) {
    writeFileSync(`${statePath}.tmp`, JSON.stringify({ sessionId: output.sessionId }), { mode: 0o600 });
    renameSync(`${statePath}.tmp`, statePath);
  }
  if (stop.rejected) {
    stderr(describeFailure({ output: { errorStatus: 401 } }));
    return 1;
  }
  if (run.code !== 0 || output.failure || !output.finalText.trim() || run.stopped || stop.requested) {
    stderr(describeFailure({ ...run, stopped: run.stopped || stop.requested, bin: config.bin }));
    return 1;
  }
  if (progressFailed()) stderr("Progress updates are unavailable; the final reply will still be returned.");
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
