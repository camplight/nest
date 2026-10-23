import type { RunnerNode } from "./types";

export type ClaudeCodeOptions = {
  credential: "oauth" | "apiKey";
  timeoutMinutes: number;
  secretNames: string[];
  secretFiles: { name: string; path: string }[];
  // Recipe env the form does not manage (for example NEST_CLAUDE_MODEL), kept on edit.
  extraEnv?: Record<string, string>;
};

export const DEFAULT_CLAUDE_CODE_OPTIONS: ClaudeCodeOptions = {
  credential: "oauth",
  timeoutMinutes: 120,
  secretNames: [],
  secretFiles: [],
  extraEnv: {}
};

// Set by deploy/compose.claude-agents.yaml for the runner-only agent container.
export const CLAUDE_CODE_RUNNER_NAME = "nest-agents";

// The bridge path inside the agent image; recipes pointing elsewhere are hand-written ones.
const BRIDGE_PATH = "/app/deploy/claude-code-bridge.mjs";
// Larger turn limits overflow Node timers in the runner.
export const MAX_TURN_MINUTES = 1440;

// The node account's passwd home, so ssh finds ~/.ssh; compose.claude-agents.yaml puts it on a volume.
const CLAUDE_HOME = "/home/node";
export const SHARED_DEFAULT_WORKSPACE = ".nest-data/workspaces/default";
const MANAGED_ENV_KEYS = new Set([
  "NEST_CLAUDE_PERMISSIONS",
  "NEST_CLAUDE_UID",
  "NEST_CLAUDE_GID",
  "NEST_CLAUDE_HOME",
  "NEST_CLAUDE_CONFIG_DIR",
  "NEST_CLAUDE_SECRETS",
  "NEST_CLAUDE_SECRET_FILES"
]);
const CREDENTIAL_NAMES = { oauth: "CLAUDE_CODE_OAUTH_TOKEN", apiKey: "ANTHROPIC_API_KEY" } as const;
// The names isProtectedName in deploy/claude-code-bridge.mjs refuses; the form refuses the same set.
export const PROTECTED_SECRET_PREFIXES = ["NEST_", "ORGOPS_", "ANTHROPIC_", "CLAUDE_", "LD_", "DYLD_", "NODE_"];
export const PROTECTED_SECRET_NAMES = [
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TMPDIR", "TERM", "HTTPS_PROXY", "HTTP_PROXY",
  "NO_PROXY", "NODE_EXTRA_CA_CERTS", "DISABLE_AUTOUPDATER", "NODE_OPTIONS", "BASH_ENV", "ENV"
];

const unique = (values: string[]) => [...new Set(values)];

export const credentialSecretName = (options: Pick<ClaudeCodeOptions, "credential">) =>
  CREDENTIAL_NAMES[options.credential];

export const requiredSecretNames = (options: ClaudeCodeOptions) =>
  unique([credentialSecretName(options), ...options.secretNames, ...options.secretFiles.map((file) => file.name)]);

export function buildClaudeCodeWrappedConfig(options: ClaudeCodeOptions): Record<string, unknown> {
  const secretNames = unique(options.secretNames);
  const secretFiles = options.secretFiles.map((file) => `${file.name}:${file.path}`).join(",");
  return {
    kind: "claude-code",
    harness: "command",
    session: { scope: "per-channel" },
    setup: { checkCommand: "claude --version" },
    runtime: {
      command: "exec node",
      args: [BRIDGE_PATH],
      parse: "text",
      timeoutMs: options.timeoutMinutes * 60000,
      env: {
        ...Object.fromEntries(
          Object.entries(options.extraEnv ?? {}).filter(([key]) => !MANAGED_ENV_KEYS.has(key))
        ),
        NEST_CLAUDE_PERMISSIONS: "full",
        NEST_CLAUDE_UID: "1000",
        NEST_CLAUDE_GID: "1000",
        NEST_CLAUDE_HOME: CLAUDE_HOME,
        NEST_CLAUDE_CONFIG_DIR: `${CLAUDE_HOME}/.claude`,
        ...(secretNames.length ? { NEST_CLAUDE_SECRETS: secretNames.join(",") } : {}),
        ...(secretFiles ? { NEST_CLAUDE_SECRET_FILES: secretFiles } : {})
      }
    },
    secrets: { allowedKeys: requiredSecretNames(options) }
  };
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const list = (value: unknown) => (typeof value === "string" ? value.split(",").filter(Boolean) : []);

// Only the container recipe belongs to the form; others (such as the developer-machine recipe) stay raw JSON.
export function readClaudeCodeOptions(wrappedConfig: unknown): ClaudeCodeOptions | null {
  const config = record(wrappedConfig);
  const runtime = record(config.runtime);
  const env = record(runtime.env);
  if (
    config.kind !== "claude-code" ||
    !Array.isArray(runtime.args) ||
    runtime.args[0] !== BRIDGE_PATH ||
    (env.NEST_CLAUDE_PERMISSIONS !== undefined && env.NEST_CLAUDE_PERMISSIONS !== "full")
  ) {
    return null;
  }
  const allowedKeys = record(config.secrets).allowedKeys;
  const timeoutMs = Number(runtime.timeoutMs);
  return {
    credential: Array.isArray(allowedKeys) && allowedKeys.includes(CREDENTIAL_NAMES.apiKey) ? "apiKey" : "oauth",
    timeoutMinutes:
      Number.isFinite(timeoutMs) && timeoutMs > 0
        ? Math.max(1, Math.round(timeoutMs / 60000))
        : DEFAULT_CLAUDE_CODE_OPTIONS.timeoutMinutes,
    secretNames: list(env.NEST_CLAUDE_SECRETS),
    secretFiles: list(env.NEST_CLAUDE_SECRET_FILES).map((entry) => {
      const separator = entry.indexOf(":");
      return { name: entry.slice(0, separator), path: entry.slice(separator + 1) };
    }),
    extraEnv: Object.fromEntries(
      Object.entries(env).filter(
        (entry): entry is [string, string] => !MANAGED_ENV_KEYS.has(entry[0]) && typeof entry[1] === "string"
      )
    )
  };
}

// Saving rewrites only what the form manages, so hand edits elsewhere in the stored recipe survive.
export function mergeClaudeCodeWrappedConfig(stored: unknown, options: ClaudeCodeOptions): Record<string, unknown> {
  const built = buildClaudeCodeWrappedConfig(options);
  const previous = readClaudeCodeOptions(stored);
  if (!previous) return built;
  const config = record(stored);
  const secrets = record(config.secrets);
  const formKeys = new Set([...Object.values(CREDENTIAL_NAMES), ...requiredSecretNames(previous)]);
  const storedKeys = Array.isArray(secrets.allowedKeys) ? secrets.allowedKeys : [];
  const handKeys = storedKeys.filter((key): key is string => typeof key === "string" && !formKeys.has(key));
  return {
    ...config,
    ...built,
    session: config.session ?? built.session,
    setup: { ...record(config.setup), ...record(built.setup) },
    runtime: { ...record(config.runtime), ...record(built.runtime) },
    secrets: { ...secrets, allowedKeys: unique([...requiredSecretNames(options), ...handKeys]) }
  };
}

export const claudeCodeOptionsError = (options: ClaudeCodeOptions) =>
  Number.isInteger(options.timeoutMinutes) && options.timeoutMinutes > 0 && options.timeoutMinutes <= MAX_TURN_MINUTES
    ? null
    : `Turn limit must be a whole number of minutes from 1 to ${MAX_TURN_MINUTES}.`;

// Claude Code sessions and files live in the workspace, so agents should not share the default one.
export function defaultClaudeCodeWorkspace(agentName: string) {
  const folder = agentName.trim().replace(/[^A-Za-z0-9._-]/g, "-").replace(/^\.+/, "");
  return folder ? `.nest-data/workspaces/${folder}` : SHARED_DEFAULT_WORKSPACE;
}

export const pickClaudeCodeRunner = (runners: RunnerNode[]) =>
  runners.find((runner) => runner.online && runner.displayName === CLAUDE_CODE_RUNNER_NAME)?.id ?? "";

export const isValidSecretName = (name: string) =>
  /^[A-Z_][A-Z0-9_]*$/.test(name) &&
  !PROTECTED_SECRET_NAMES.includes(name) &&
  !PROTECTED_SECRET_PREFIXES.some((prefix) => name.startsWith(prefix));

// Relative to Claude's home; "," and ":" are the separators of NEST_CLAUDE_SECRET_FILES.
export const isValidSecretPath = (path: string) =>
  /^[A-Za-z0-9._/-]+$/.test(path) &&
  !path.startsWith("/") &&
  path.split("/").every((segment) => segment && segment !== "." && segment !== "..");
