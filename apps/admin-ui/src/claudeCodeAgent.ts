import type { RunnerNode } from "./types";

export type ClaudeCodeOptions = {
  credential: "oauth" | "apiKey";
  timeoutMinutes: number;
  secretNames: string[];
  secretFiles: { name: string; path: string }[];
};

export const DEFAULT_CLAUDE_CODE_OPTIONS: ClaudeCodeOptions = {
  credential: "oauth",
  timeoutMinutes: 120,
  secretNames: [],
  secretFiles: []
};

// Set by deploy/compose.claude-agents.yaml for the runner-only agent container.
export const CLAUDE_CODE_RUNNER_NAME = "nest-agents";

const CLAUDE_HOME = "/app/.nest-data/claude/home";
const CREDENTIAL_NAMES = { oauth: "CLAUDE_CODE_OAUTH_TOKEN", apiKey: "ANTHROPIC_API_KEY" } as const;
const PROTECTED_PREFIXES = ["NEST_", "ORGOPS_", "ANTHROPIC_", "CLAUDE_"];
// The bridge never forwards these either; refusing them here keeps the form honest.
const PROTECTED_NAMES = new Set(["PATH", "HOME", "USER", "LOGNAME", "SHELL"]);

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
      args: ["/app/deploy/claude-code-bridge.mjs"],
      parse: "text",
      timeoutMs: options.timeoutMinutes * 60000,
      env: {
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

export function readClaudeCodeOptions(wrappedConfig: unknown): ClaudeCodeOptions | null {
  const config = record(wrappedConfig);
  if (config.kind !== "claude-code") return null;
  const runtime = record(config.runtime);
  const env = record(runtime.env);
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
    })
  };
}

export const pickClaudeCodeRunner = (runners: RunnerNode[]) =>
  runners.find((runner) => runner.online && runner.displayName === CLAUDE_CODE_RUNNER_NAME)?.id ?? "";

export const isValidSecretName = (name: string) =>
  /^[A-Z_][A-Z0-9_]*$/.test(name) &&
  !PROTECTED_NAMES.has(name) &&
  !PROTECTED_PREFIXES.some((prefix) => name.startsWith(prefix));

// Relative to Claude's home; "," and ":" are the separators of NEST_CLAUDE_SECRET_FILES.
export const isValidSecretPath = (path: string) =>
  /^[A-Za-z0-9._/-]+$/.test(path) &&
  !path.startsWith("/") &&
  path.split("/").every((segment) => segment && segment !== "." && segment !== "..");
