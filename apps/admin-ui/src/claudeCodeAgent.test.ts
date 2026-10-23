import { describe, expect, it } from "vitest";
import type { RunnerNode } from "./types";
import {
  DEFAULT_CLAUDE_CODE_OPTIONS,
  buildClaudeCodeWrappedConfig,
  defaultClaudeCodeWorkspace,
  isValidSecretName,
  isValidSecretPath,
  pickClaudeCodeRunner,
  readClaudeCodeOptions,
  requiredSecretNames
} from "./claudeCodeAgent";

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
