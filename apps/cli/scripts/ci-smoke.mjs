import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

const repoRoot = resolve(import.meta.dirname, "..", "..", "..");
const distDir = resolve(repoRoot, "dist");

function fail(message) {
  console.error(`[nest-smoke] ${message}`);
  process.exit(1);
}

function findBinaryPath() {
  const entries = readdirSync(distDir).filter((name) => name.startsWith("nest-"));
  if (entries.length === 0) fail(`No nest binary found in ${distDir}`);
  const binaryName = entries.sort()[0];
  const binaryPath = resolve(distDir, binaryName);
  if (!existsSync(binaryPath)) fail(`Binary path does not exist: ${binaryPath}`);
  return binaryPath;
}

function run(binaryPath, args, extraEnv = {}) {
  console.log(`[nest-smoke] Running: ${binaryPath} ${args.join(" ")}`);
  const result = spawnSync(binaryPath, args, {
    stdio: "inherit",
    env: {
      ...process.env,
      ...extraEnv,
    },
    shell: false,
  });
  if (result.status !== 0) {
    fail(`Command failed with exit code ${result.status}: ${args.join(" ")}`);
  }
}

function runBestEffort(binaryPath, args, extraEnv = {}) {
  console.log(`[nest-smoke] Best-effort: ${binaryPath} ${args.join(" ")}`);
  spawnSync(binaryPath, args, {
    stdio: "inherit",
    env: {
      ...process.env,
      ...extraEnv,
    },
    shell: false,
  });
}

function assertPath(path, label) {
  if (!existsSync(path)) {
    fail(`Missing expected ${label}: ${path}`);
  }
}

function writeFixtureRuntimePackage(installDir) {
  const pkg = {
    name: "nest-ci-smoke-runtime",
    private: true,
    scripts: {
      "start:api:env": "node .nest-smoke-api-server.mjs",
      "start:runner:env": "node .nest-smoke-runner-process.mjs",
      "start:user-ui:preview:env": "node .nest-smoke-user-ui-server.mjs",
      "start:admin-ui:preview:env": "node .nest-smoke-admin-ui-server.mjs",
    },
  };
  writeFileSync(resolve(installDir, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`, "utf-8");

  const userUiServer = [
    "import http from 'node:http';",
    "const server = http.createServer((_req, res) => { res.statusCode = 200; res.end('ok'); });",
    "server.listen(4190);",
    "const shutdown = () => server.close(() => process.exit(0));",
    "process.on('SIGTERM', shutdown);",
    "process.on('SIGINT', shutdown);",
    "setInterval(() => {}, 1000);",
    "",
  ].join("\n");
  writeFileSync(resolve(installDir, ".nest-smoke-user-ui-server.mjs"), userUiServer, "utf-8");

  const apiServer = [
    "import http from 'node:http';",
    "const server = http.createServer((_req, res) => { res.statusCode = 200; res.end('ok'); });",
    "server.listen(8787);",
    "const shutdown = () => server.close(() => process.exit(0));",
    "process.on('SIGTERM', shutdown);",
    "process.on('SIGINT', shutdown);",
    "setInterval(() => {}, 1000);",
    "",
  ].join("\n");
  writeFileSync(resolve(installDir, ".nest-smoke-api-server.mjs"), apiServer, "utf-8");

  const runnerProcess = [
    "const shutdown = () => process.exit(0);",
    "process.on('SIGTERM', shutdown);",
    "process.on('SIGINT', shutdown);",
    "setInterval(() => {}, 1000);",
    "",
  ].join("\n");
  writeFileSync(resolve(installDir, ".nest-smoke-runner-process.mjs"), runnerProcess, "utf-8");

  const adminUiServer = [
    "import http from 'node:http';",
    "const server = http.createServer((_req, res) => { res.statusCode = 200; res.end('ok'); });",
    "server.listen(4173);",
    "const shutdown = () => server.close(() => process.exit(0));",
    "process.on('SIGTERM', shutdown);",
    "process.on('SIGINT', shutdown);",
    "setInterval(() => {}, 1000);",
    "",
  ].join("\n");
  writeFileSync(resolve(installDir, ".nest-smoke-admin-ui-server.mjs"), adminUiServer, "utf-8");
}

const binaryPath = findBinaryPath();
const tempHome = mkdtempSync(join(tmpdir(), "nest-home-smoke-"));
const installDir = mkdtempSync(join(tmpdir(), "nest-install-smoke-"));
const smokeEnv = {
  NEST_CLI_INSTALL_SMOKE_MOCK: "1",
  NEST_CLI_NO_BROWSER: "1",
  NEST_LLM_STUB: "1",
  OPENAI_API_KEY: "stub-key",
  NEST_CLI_MODEL: "openai:gpt-5.2",
  NEST_CLI_LOG_PATH: resolve(tempHome, "nest-session.log"),
  NEST_CLI_STATE_DIR: resolve(tempHome, ".nest"),
};

try {
  run(binaryPath, ["--help"]);
  run(binaryPath, ["chat", "--help"], smokeEnv);
  run(binaryPath, ["doctor"], smokeEnv);

  run(
    binaryPath,
    ["install", "--dir", installDir, "--repo", "https://example.invalid/nest-fixture.git", "--create-shortcut"],
    smokeEnv
  );

  assertPath(resolve(installDir, ".nest-install-smoke.json"), "mock install metadata file");
  assertPath(resolve(installDir, ".nest-install-smoke-build.txt"), "mock build marker file");
  assertPath(resolve(installDir, "Nest User UI.smoke-shortcut"), "mock shortcut file");

  // Seed realistic mutable payload so upgrade backup creation is exercised.
  mkdirSync(resolve(installDir, ".nest-data"), { recursive: true });
  mkdirSync(resolve(installDir, "files"), { recursive: true });
  writeFileSync(resolve(installDir, ".env"), "NEST_ADMIN_USER=admin\n", "utf-8");
  writeFileSync(resolve(installDir, ".nest-data", "seed.txt"), "seed\n", "utf-8");
  writeFileSync(resolve(installDir, "files", "seed.txt"), "seed\n", "utf-8");

  run(binaryPath, ["upgrade", "--dir", installDir, "--no-restart"], smokeEnv);

  const backupsDir = resolve(installDir, ".nest-backups");
  assertPath(backupsDir, "upgrade backups directory");
  const backupArtifacts = readdirSync(backupsDir).filter((name) => name.startsWith("upgrade-backup-"));
  if (backupArtifacts.length === 0) {
    fail("Missing expected upgrade backup artifact under .nest-backups");
  }

  writeFixtureRuntimePackage(installDir);

  // Smoke the deterministic lifecycle commands.
  run(binaryPath, ["start", "--dir", installDir, "--no-open"], smokeEnv);
  run(binaryPath, ["status", "--dir", installDir], smokeEnv);
  run(binaryPath, ["stop", "--dir", installDir], smokeEnv);
  run(binaryPath, ["status", "--dir", installDir], smokeEnv);

  // Smoke the admin command surface (browser launch disabled by env).
  run(binaryPath, ["admin", "open", "--dir", installDir], smokeEnv);
  run(binaryPath, ["admin", "status", "--dir", installDir], smokeEnv);
  run(binaryPath, ["admin", "stop", "--dir", installDir], smokeEnv);
  run(binaryPath, ["admin", "status", "--dir", installDir], smokeEnv);

  // Smoke chat one-shot path without external model dependency.
  run(binaryPath, ["chat", "--goal", "Acknowledge smoke test success in one sentence."], smokeEnv);

  console.log("[nest-smoke] Completed successfully.");
} finally {
  runBestEffort(binaryPath, ["stop", "--dir", installDir], smokeEnv);
  runBestEffort(binaryPath, ["admin", "stop", "--dir", installDir], smokeEnv);
  rmSync(tempHome, { recursive: true, force: true });
  rmSync(installDir, { recursive: true, force: true });
}
