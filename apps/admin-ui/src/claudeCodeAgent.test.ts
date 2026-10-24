import { describe, expect, it } from "vitest";
import type { RunnerNode } from "./types";
import {
  DEFAULT_CLAUDE_CODE_OPTIONS,
  MAX_TURN_MINUTES,
  PROTECTED_SECRET_NAMES,
  PROTECTED_SECRET_PREFIXES,
  buildClaudeCodeWrappedConfig,
  claudeCodeOptionsError,
  defaultClaudeCodeWorkspace,
  isValidSecretName,
  isValidSecretPath,
  mergeClaudeCodeWrappedConfig,
  pickClaudeCodeRunner,
  readClaudeCodeOptions,
  requiredSecretNames
} from "./claudeCodeAgent";

// The developer-machine recipe from docs/CLAUDE_CODE_AGENT.md section 8.
const devRecipe = {
  kind: "claude-code",
  harness: "command",
  session: { scope: "per-channel" },
  setup: { checkCommand: "claude --version" },
  runtime: {
    command: "exec node",
    args: ["/path/to/nest/deploy/claude-code-bridge.mjs"],
    env: { NEST_CLAUDE_PERMISSIONS: "workspace" },
    parse: "text",
    timeoutMs: 7200000
  }
};

const withTools = {
  ...DEFAULT_CLAUDE_CODE_OPTIONS,
  secretNames: ["GH_TOKEN"],
  secretFiles: [{ name: "SSH_PRIVATE_KEY", path: ".ssh/id_ed25519" }]
};

const runner = (id: string, displayName: string, online = true): RunnerNode => ({
  id, displayName, online, createdAt: 0, updatedAt: 0, lastSeenAt: 0
});

describe("Claude Code agent recipe", () => {
  it("builds the container recipe", () => {
    expect(buildClaudeCodeWrappedConfig(withTools)).toEqual({
      kind: "claude-code",
      harness: "command",
      session: { scope: "per-channel" },
      setup: { checkCommand: "claude --version" },
      runtime: {
        command: "exec node",
        args: ["/app/deploy/claude-code-bridge.mjs"],
        parse: "text",
        timeoutMs: 7200000,
        env: {
          NEST_CLAUDE_PERMISSIONS: "full",
          NEST_CLAUDE_UID: "1000",
          NEST_CLAUDE_GID: "1000",
          NEST_CLAUDE_HOME: "/home/node",
          NEST_CLAUDE_CONFIG_DIR: "/home/node/.claude",
          NEST_CLAUDE_SECRETS: "GH_TOKEN",
          NEST_CLAUDE_SECRET_FILES: "SSH_PRIVATE_KEY:.ssh/id_ed25519"
        }
      },
      secrets: { allowedKeys: ["CLAUDE_CODE_OAUTH_TOKEN", "GH_TOKEN", "SSH_PRIVATE_KEY"] }
    });
    const bare = buildClaudeCodeWrappedConfig(DEFAULT_CLAUDE_CODE_OPTIONS) as {
      runtime: { env: Record<string, string> };
    };
    expect(bare.runtime.env).not.toHaveProperty("NEST_CLAUDE_SECRETS");
    expect(bare.runtime.env).not.toHaveProperty("NEST_CLAUDE_SECRET_FILES");
  });

  it("uses ANTHROPIC_API_KEY for the API key credential", () => {
    const options = { ...withTools, credential: "apiKey" as const, timeoutMinutes: 30 };
    const config = buildClaudeCodeWrappedConfig(options) as {
      runtime: { timeoutMs: number };
      secrets: { allowedKeys: string[] };
    };
    expect(config.secrets.allowedKeys).toEqual(["ANTHROPIC_API_KEY", "GH_TOKEN", "SSH_PRIVATE_KEY"]);
    expect(config.runtime.timeoutMs).toBe(1800000);
    expect(requiredSecretNames(options)).toEqual(["ANTHROPIC_API_KEY", "GH_TOKEN", "SSH_PRIVATE_KEY"]);
  });

  it("round-trips through readClaudeCodeOptions", () => {
    expect(readClaudeCodeOptions(buildClaudeCodeWrappedConfig(withTools))).toEqual(withTools);
    const apiKey = { ...DEFAULT_CLAUDE_CODE_OPTIONS, credential: "apiKey" as const, timeoutMinutes: 45 };
    expect(readClaudeCodeOptions(buildClaudeCodeWrappedConfig(apiKey))).toEqual(apiKey);
    expect(readClaudeCodeOptions({ kind: "custom", harness: "command" })).toBeNull();
    expect(readClaudeCodeOptions(undefined)).toBeNull();
  });

  it("keeps operator env the form does not manage", () => {
    const stored = buildClaudeCodeWrappedConfig(withTools) as { runtime: { env: Record<string, string> } };
    stored.runtime.env = { ...stored.runtime.env, NEST_CLAUDE_MODEL: "sonnet", NEST_CLAUDE_UPSTREAM_URL: "http://127.0.0.1:4010" };
    const options = readClaudeCodeOptions(stored);
    expect(options?.extraEnv).toEqual({ NEST_CLAUDE_MODEL: "sonnet", NEST_CLAUDE_UPSTREAM_URL: "http://127.0.0.1:4010" });
    expect(buildClaudeCodeWrappedConfig(options!)).toEqual(stored);
    // Managed keys always come from the form, even when extraEnv carries an old value.
    const rebuilt = buildClaudeCodeWrappedConfig({
      ...DEFAULT_CLAUDE_CODE_OPTIONS,
      extraEnv: { NEST_CLAUDE_PERMISSIONS: "workspace", NEST_CLAUDE_SECRETS: "OLD", NEST_CLAUDE_MODEL: "sonnet" }
    }) as { runtime: { env: Record<string, string> } };
    expect(rebuilt.runtime.env.NEST_CLAUDE_PERMISSIONS).toBe("full");
    expect(rebuilt.runtime.env).not.toHaveProperty("NEST_CLAUDE_SECRETS");
    expect(rebuilt.runtime.env.NEST_CLAUDE_MODEL).toBe("sonnet");
  });

  it("leaves recipes that are not the container recipe to the raw JSON editor", () => {
    expect(readClaudeCodeOptions(devRecipe)).toBeNull();
    const container = buildClaudeCodeWrappedConfig(withTools) as { runtime: { args: string[]; env: Record<string, string> } };
    expect(readClaudeCodeOptions({ ...container, runtime: { ...container.runtime, args: ["/srv/nest/deploy/claude-code-bridge.mjs"] } })).toBeNull();
    expect(readClaudeCodeOptions({ ...container, runtime: { ...container.runtime, env: { ...container.runtime.env, NEST_CLAUDE_PERMISSIONS: "workspace" } } })).toBeNull();
    const { NEST_CLAUDE_PERMISSIONS: _full, ...withoutPermissions } = container.runtime.env;
    expect(readClaudeCodeOptions({ ...container, runtime: { ...container.runtime, env: withoutPermissions } })).toEqual(withTools);
  });

  it("merges the form into the stored recipe, keeping hand edits outside the managed keys", () => {
    const built = buildClaudeCodeWrappedConfig(withTools) as Record<string, any>;
    const stored = {
      ...built,
      description: "hand edit",
      session: { scope: "per-agent" },
      runtime: { ...built.runtime, cwd: "repo", timeoutMs: 60000, env: { ...built.runtime.env, NEST_CLAUDE_MODEL: "sonnet" } },
      secrets: { allowedKeys: [...built.secrets.allowedKeys, "NPM_TOKEN"], note: "kept" }
    };
    const options = readClaudeCodeOptions(stored)!;
    const edited = { ...options, credential: "apiKey" as const, timeoutMinutes: 30, secretNames: [] };
    expect(mergeClaudeCodeWrappedConfig(stored, edited)).toEqual({
      ...stored,
      runtime: {
        ...stored.runtime,
        timeoutMs: 1800000,
        env: {
          NEST_CLAUDE_MODEL: "sonnet",
          NEST_CLAUDE_PERMISSIONS: "full",
          NEST_CLAUDE_UID: "1000",
          NEST_CLAUDE_GID: "1000",
          NEST_CLAUDE_HOME: "/home/node",
          NEST_CLAUDE_CONFIG_DIR: "/home/node/.claude",
          NEST_CLAUDE_SECRET_FILES: "SSH_PRIVATE_KEY:.ssh/id_ed25519"
        }
      },
      // The old credential and the removed GH_TOKEN go; the hand-added NPM_TOKEN stays.
      secrets: { allowedKeys: ["ANTHROPIC_API_KEY", "SSH_PRIVATE_KEY", "NPM_TOKEN"], note: "kept" }
    });
    // Managed keys win over hand edits.
    const tampered = { ...stored, kind: "custom-ish", harness: "other", runtime: { ...stored.runtime, command: "sh", parse: "json" } };
    const merged = mergeClaudeCodeWrappedConfig(tampered, options) as Record<string, any>;
    expect([merged.kind, merged.harness, merged.runtime.command, merged.runtime.parse]).toEqual(["claude-code", "command", "exec node", "text"]);
    // A stored config that is not a Claude Code recipe is replaced, not merged.
    expect(mergeClaudeCodeWrappedConfig(devRecipe, withTools)).toEqual(buildClaudeCodeWrappedConfig(withTools));
    expect(mergeClaudeCodeWrappedConfig(undefined, withTools)).toEqual(buildClaudeCodeWrappedConfig(withTools));
  });

  it("caps the turn limit where Node timers still work", () => {
    expect(MAX_TURN_MINUTES).toBe(1440);
    for (const timeoutMinutes of [1, 120, 1440]) expect(claudeCodeOptionsError({ ...withTools, timeoutMinutes })).toBeNull();
    for (const timeoutMinutes of [0, -1, 1.5, 1441, 40000, Number.NaN]) {
      expect(claudeCodeOptionsError({ ...withTools, timeoutMinutes })).toBe("Turn limit must be a whole number of minutes from 1 to 1440.");
    }
  });

  it("gives each Claude Code agent its own workspace", () => {
    expect(defaultClaudeCodeWorkspace("Coder")).toBe(".nest-data/workspaces/Coder");
    expect(defaultClaudeCodeWorkspace(" Code Review/ops ")).toBe(".nest-data/workspaces/Code-Review-ops");
    expect(defaultClaudeCodeWorkspace("../x")).toBe(".nest-data/workspaces/-x");
    expect(defaultClaudeCodeWorkspace("..")).toBe(".nest-data/workspaces/default");
    expect(defaultClaudeCodeWorkspace("")).toBe(".nest-data/workspaces/default");
  });

  it("de-duplicates allowedKeys", () => {
    const config = buildClaudeCodeWrappedConfig({
      ...DEFAULT_CLAUDE_CODE_OPTIONS,
      secretNames: ["GH_TOKEN", "GH_TOKEN", "SSH_PRIVATE_KEY"],
      secretFiles: [{ name: "SSH_PRIVATE_KEY", path: ".ssh/id_ed25519" }]
    }) as { runtime: { env: Record<string, string> }; secrets: { allowedKeys: string[] } };
    expect(config.secrets.allowedKeys).toEqual(["CLAUDE_CODE_OAUTH_TOKEN", "GH_TOKEN", "SSH_PRIVATE_KEY"]);
    expect(config.runtime.env.NEST_CLAUDE_SECRETS).toBe("GH_TOKEN,SSH_PRIVATE_KEY");
  });

  it("refuses exactly the names the bridge refuses", () => {
    // Mirrors isProtectedName in deploy/claude-code-bridge.mjs.
    expect(PROTECTED_SECRET_PREFIXES).toEqual(["NEST_", "ORGOPS_", "ANTHROPIC_", "CLAUDE_", "LD_", "DYLD_", "NODE_"]);
    expect(PROTECTED_SECRET_NAMES).toEqual([
      "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TMPDIR", "TERM", "HTTPS_PROXY", "HTTP_PROXY",
      "NO_PROXY", "NODE_EXTRA_CA_CERTS", "DISABLE_AUTOUPDATER", "NODE_OPTIONS", "BASH_ENV", "ENV"
    ]);
    for (const name of [...PROTECTED_SECRET_NAMES, "LD_PRELOAD", "DYLD_INSERT_LIBRARIES", "NODE_TLS_REJECT_UNAUTHORIZED"]) {
      expect(isValidSecretName(name)).toBe(false);
    }
    for (const name of ["ENVIRONMENT", "TERMINAL_ID", "PATH_TOKEN", "NODEJS_TOKEN", "LDAP_PASSWORD"]) expect(isValidSecretName(name)).toBe(true);
  });

  it("rejects protected and malformed names and escaping paths", () => {
    for (const name of ["GH_TOKEN", "SSH_PRIVATE_KEY", "_X", "AWS_KEY_2"]) expect(isValidSecretName(name)).toBe(true);
    for (const name of ["", "gh_token", "2FA", "GH-TOKEN", "NEST_RUNNER_TOKEN", "ORGOPS_MASTER_KEY",
      "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "PATH", "HOME"]) expect(isValidSecretName(name)).toBe(false);
    for (const path of [".ssh/id_ed25519", ".config/gh/hosts.yml", "known_hosts"]) expect(isValidSecretPath(path)).toBe(true);
    for (const path of ["", "../x", "/etc/x", ".ssh/../../x", "~/x", ".ssh//x", ".ssh/", "a,b", "a:b", "a b"]) {
      expect(isValidSecretPath(path)).toBe(false);
    }
  });

  it("picks the online nest-agents runner and otherwise the engine default", () => {
    expect(pickClaudeCodeRunner([runner("r1", "nest"), runner("r2", "nest-agents")])).toBe("r2");
    expect(pickClaudeCodeRunner([runner("r1", "nest"), runner("r2", "nest-agents", false)])).toBe("");
    expect(pickClaudeCodeRunner([])).toBe("");
  });
});

describe("secret names shared with the bridge", () => {
  it("refuses exactly what deploy/claude-code-bridge.mjs refuses", async () => {
    // @ts-expect-error The bridge is plain ESM without type declarations.
    const { isProtectedName } = await import("../../../deploy/claude-code-bridge.mjs");
    const names = [...PROTECTED_SECRET_NAMES, ...PROTECTED_SECRET_PREFIXES.map((prefix) => `${prefix}X`),
      "GH_TOKEN", "SSH_PRIVATE_KEY", "AWS_SECRET_ACCESS_KEY", "ENVIRONMENT", "PATHS", "NODEJS"];
    for (const name of names) expect([name, isValidSecretName(name)]).toEqual([name, !isProtectedName(name)]);
  });
});
