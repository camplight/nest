import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { spawnSync } from "node:child_process";
import * as tar from "tar";
import { runInstall } from "./install";
import { loadState } from "./runtime-state";
import { parseComponentsArg } from "./components";
import { getComponentsStatus, startComponents, stopComponents } from "./component-runtime";
import type { RunnerBootstrapOptions } from "./runner-bootstrap";

export type UpgradeOptions = {
  installDir?: string;
  repoUrl?: string;
  repoRef?: string;
  components?: string;
  restart?: boolean;
} & RunnerBootstrapOptions;

const BACKUP_PATHS = [".nest-data", ".nest-product", ".orgops-data", "files", ".env", ".agent-runner-id"];

export function assertLocalRuntimePaths(installDir: string) {
  const envFile = resolve(installDir, ".env");
  const env = {...(existsSync(envFile) ? parseEnv(readFileSync(envFile, "utf-8")) : {}), ...process.env};
  const defaults = {
    NEST_ENGINE_DATA_DIR: ".nest-data", NEST_ENGINE_DB_FILE: "nest.sqlite",
    NEST_PRODUCT_DB_PATH: ".nest-product/nest.sqlite", NEST_RUNNER_ID_FILE: ".agent-runner-id",
  };
  for (const [key, fallback] of Object.entries(defaults)) {
    const value = env[key];
    if (value && resolve(installDir, value) !== resolve(installDir, fallback)) {
      throw new Error(`Custom ${key} requires an operator-managed offline backup and upgrade. No services changed.`);
    }
  }
  if (env.ORGOPS_RUNNER_ID_FILE && !env.NEST_RUNNER_ID_FILE && resolve(installDir, env.ORGOPS_RUNNER_ID_FILE) !== resolve(installDir, ".agent-runner-id")) {
    throw new Error("Custom ORGOPS_RUNNER_ID_FILE requires an offline operator upgrade.");
  }
  for (const path of BACKUP_PATHS) {
    const target = resolve(installDir, path);
    if (existsSync(target) && lstatSync(target).isSymbolicLink()) {
      throw new Error(`Linked runtime path ${path} requires an operator-managed offline backup and upgrade.`);
    }
  }
}

// Call only after every local API/runner writer has stopped. Preserve WAL files and
// runtime symlinks as a single offline archive; never follow workspace symlinks.
export async function createSafetyBackup(installDir: string) {
  const existing = BACKUP_PATHS.filter(item => existsSync(resolve(installDir, item)));
  if (existing.length === 0) return "";
  const backupsDir = resolve(installDir, ".nest-backups");
  if (existsSync(backupsDir) && lstatSync(backupsDir).isSymbolicLink()) throw new Error("Backup directory must not be a symlink.");
  mkdirSync(backupsDir, { recursive: true, mode: 0o700 });
  chmodSync(backupsDir, 0o700);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = resolve(backupsDir, `upgrade-backup-${stamp}.tar.gz`);
  const partialPath = `${backupPath}.partial`;
  // Create privately before tar opens the destination, independent of the user's umask.
  writeFileSync(partialPath, "", {mode: 0o600, flag: "wx"});
  await tar.c({ gzip: true, cwd: installDir, file: partialPath }, existing);
  renameSync(partialPath, backupPath);
  return backupPath;
}

function currentRevision(installDir: string) {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {cwd: installDir, encoding: "utf-8"});
  if (result.status !== 0) throw new Error("Cannot record the existing revision. Upgrade refused.");
  return result.stdout.trim();
}

// Dependencies keep failure/recovery tests on the same orchestration used by the CLI.
const defaultActions = {
  status: getComponentsStatus, stop: stopComponents, start: startComponents,
  backup: createSafetyBackup, install: runInstall, revision: currentRevision,
};

export async function runUpgrade(rawOptions: UpgradeOptions, actions = defaultActions) {
  const installDir = resolve(rawOptions.installDir ?? loadState().installDir ?? "nest");
  const lock = resolve(installDir, ".nest-upgrade.lock");
  try { mkdirSync(lock, {mode: 0o700}); }
  catch { throw new Error("Another upgrade is active, or its lock needs operator recovery. No services changed."); }
  try { return await executeUpgrade(rawOptions, actions); }
  finally { rmSync(lock, {recursive: true}); }
}

async function executeUpgrade(rawOptions: UpgradeOptions, actions: typeof defaultActions) {
  const state = loadState();
  const installDir = resolve(rawOptions.installDir ?? state.installDir ?? "nest");
  if (!existsSync(resolve(installDir, ".git"))) throw new Error(`No git repository found at ${installDir}. Run install first.`);
  if (existsSync(resolve(installDir, "packages/db/migrations/036_instance_branding.sql")) && existsSync(resolve(installDir, ".nest-data/nest.sqlite"))) {
    throw new Error("This installation needs the one-time offline OrgOps submodule migration before CLI upgrade. Follow docs/SUBMODULE_MIGRATION.md; no services changed.");
  }
  const sameInstall = state.installDir && existsSync(state.installDir) && realpathSync(state.installDir) === realpathSync(installDir);
  if (sameInstall && state.serviceRegistered && process.platform !== "linux") {
    throw new Error("For registered launchd/Windows services, stop and unregister the supervisor before upgrading. No services changed.");
  }
  if (existsSync(resolve(installDir, "nest-host.json"))) {
    throw new Error("Server installations require the scripts/install-host.sh with a prebuilt release; do not build on the live server.");
  }
  assertLocalRuntimePaths(installDir);
  const components = parseComponentsArg(rawOptions.components ?? (sameInstall ? state.installedComponents?.join(",") : undefined));
  // Even a UI-only upgrade touches shared dependencies and backs up both DBs.
  // Stop ALL installed writers, then restore exactly the previous running set.
  const allComponents = parseComponentsArg(Array.from(new Set([
    ...components, ...(sameInstall ? state.installedComponents ?? [] : []), "api", "runner", "admin-ui", "user-ui",
  ])).join(","));
  const statusBefore = await actions.status({ installDir, components: allComponents });
  const runningBefore = statusBefore.statuses.filter(status => status.running).map(status => status.component);
  const revision = await actions.revision(installDir);
  let backupPath = "";
  let installationStarted = false;
  try {
    await actions.stop({installDir, components: allComponents});
    const after = await actions.status({installDir, components: allComponents});
    if (after.statuses.some(status => status.running || status.reachable)) throw new Error("A local writer is still running; backup refused.");
    backupPath = await actions.backup(installDir);
    if (backupPath) writeFileSync(`${backupPath}.json`, JSON.stringify({revision, components, runningBefore}, null, 2) + "\n", {mode: 0o600});
    installationStarted = true;
    const installResult = await actions.install({
      ...rawOptions, offlineUpgrade: true, installDir, repoUrl: rawOptions.repoUrl ?? (sameInstall ? state.repoUrl : undefined),
      repoRef: rawOptions.repoRef ?? (sameInstall ? state.repoRef : undefined), components: components.join(","),
      registerService: false, createShortcut: false,
    });
    if (rawOptions.restart !== false && runningBefore.length > 0) await actions.start({installDir, components: runningBefore, openBrowser: false});
    return {
      installDir, repoUrl: installResult.repoUrl, repoRef: installResult.repoRef, components, backupPath,
      restarted: rawOptions.restart !== false, runningBefore,
      restartMessage: rawOptions.restart === false ? "Skipped restart (by option); registered services remain stopped."
        : runningBefore.length ? `Restarted components: ${runningBefore.join(", ")}.` : "No component restart needed (none were running).",
    };
  } catch (error) {
    if (!installationStarted) {
      // Source is untouched: recover any services stopped before a backup/preflight error.
      try { if (runningBefore.length) await actions.start({installDir, components: runningBefore, openBrowser: false}); }
      catch { throw new Error(`Upgrade stopped before source changes; previous services could not restart. Inspect ${installDir} locally.`); }
      throw error;
    }
    // Startup may have migrated both databases. Never restart the old binary against
    // new schemas or silently discard accepted writes by auto-restoring old DBs.
    await actions.stop({installDir, components: allComponents});
    throw new Error(`Upgrade failed; components are stopped. Restore revision ${revision} and BOTH databases using ${backupPath || "your offline backup"}. See deploy/native/README.md.`, {cause: error});
  }
}
