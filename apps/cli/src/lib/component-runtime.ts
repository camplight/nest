import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { spawn, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { npmCommandForHost } from "./exec";
import { openUrlInBrowser } from "./browser";
import type { InstallComponent } from "./components";
import { loadState } from "./runtime-state";
import { controlLinuxService, isManagedLinuxService, linuxServiceStatus } from "./service";

type ComponentStatus = {
  component: InstallComponent;
  running: boolean;
  pid: number | null;
  url?: string;
  reachable?: boolean;
};

const COMPONENT_START_COMMAND: Record<InstallComponent, string> = {
  api: "start:api:env",
  runner: "start:runner:env",
  "admin-ui": "start:admin-ui:preview:env",
  "user-ui": "start:user-ui:preview:env",
};

const COMPONENT_URL: Partial<Record<InstallComponent, string>> = {
  api: "http://localhost:8787/health",
  "admin-ui": "http://localhost:4173",
  "user-ui": "http://localhost:4190",
};

function runtimeStatePath(installDir: string, component: InstallComponent) {
  const key = component.replace(/[^a-z0-9-]/gi, "_");
  return resolve(installDir, ".nest-runtime", `${key}.json`);
}

function processIsAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function loadPid(installDir: string, component: InstallComponent): number | null {
  const file = runtimeStatePath(installDir, component);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as { pid?: number };
    if (typeof parsed.pid === "number" && processIsAlive(parsed.pid)) return parsed.pid;
    return null;
  } catch {
    return null;
  }
}

function savePid(installDir: string, component: InstallComponent, pid: number) {
  const runtimeDir = resolve(installDir, ".nest-runtime");
  mkdirSync(runtimeDir, { recursive: true });
  writeFileSync(
    runtimeStatePath(installDir, component),
    `${JSON.stringify({ pid }, null, 2)}\n`,
    "utf-8"
  );
}

function clearPid(installDir: string, component: InstallComponent) {
  rmSync(runtimeStatePath(installDir, component), { force: true });
}

function resolveInstallDir(inputDir?: string) {
  return resolve(inputDir ?? loadState().installDir ?? "nest");
}

function checkHttpUp(url: string, healthyOnly = false): Promise<boolean> {
  return new Promise((resolveReady) => {
    let settled = false;
    const target = new URL(url);
    const requester = target.protocol === "https:" ? httpsRequest : httpRequest;
    const req = requester(
      target,
      {
        method: "GET",
        timeout: 1_500,
      },
      (res) => {
        if (settled) return;
        settled = true;
        resolveReady(!healthyOnly || ((res.statusCode ?? 500) >= 200 && (res.statusCode ?? 500) < 300));
        res.resume();
      }
    );
    req.on("timeout", () => {
      req.destroy();
      if (!settled) {
        settled = true;
        resolveReady(false);
      }
    });
    req.on("error", () => {
      if (!settled) {
        settled = true;
        resolveReady(false);
      }
    });
    req.end();
  });
}

async function waitForComponentReady(component: InstallComponent, timeoutMs: number) {
  const url = COMPONENT_URL[component];
  if (!url) return;
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await checkHttpUp(url, true)) return;
    await delay(500);
  }
  throw new Error(`${component} did not become ready at ${url} within ${timeoutMs}ms.`);
}

export async function startComponents(options: {
  installDir?: string;
  components: InstallComponent[];
  openBrowser?: boolean;
}) {
  const installDir = resolveInstallDir(options.installDir);
  const started: Array<{ component: InstallComponent; alreadyRunning: boolean; pid: number | null }> = [];
  for (const component of options.components) {
    if (isManagedLinuxService(installDir, component)) {
      const before = linuxServiceStatus(component);
      controlLinuxService("start", component);
      await waitForComponentReady(component, 30_000);
      started.push({component, alreadyRunning: before.running, pid: linuxServiceStatus(component).pid});
      continue;
    }
    const existingPid = loadPid(installDir, component);
    if (!existingPid) {
      const runtimeDir = resolve(installDir, ".nest-runtime");
      mkdirSync(runtimeDir, { recursive: true });
      const logPath = resolve(runtimeDir, `${component}.log`);
      const outFd = openSync(logPath, "a");
      const errFd = openSync(logPath, "a");
      const child = spawn(npmCommandForHost(), ["run", COMPONENT_START_COMMAND[component]], {
        cwd: installDir,
        detached: true,
        stdio: ["ignore", outFd, errFd],
        env: process.env,
        shell: process.platform === "win32",
        windowsHide: true,
      });
      closeSync(outFd);
      closeSync(errFd);
      child.unref();
      if (typeof child.pid !== "number") {
        throw new Error(`Failed to start ${component} process.`);
      }
      savePid(installDir, component, child.pid);
      started.push({ component, alreadyRunning: false, pid: child.pid });
    } else {
      started.push({ component, alreadyRunning: true, pid: existingPid });
    }
    await waitForComponentReady(component, 30_000);
  }

  if (options.openBrowser) {
    if (options.components.includes("user-ui")) openUrlInBrowser(COMPONENT_URL["user-ui"]!);
    else if (options.components.includes("admin-ui")) openUrlInBrowser(COMPONENT_URL["admin-ui"]!);
  }
  return { installDir, started };
}

export async function stopComponents(options: { installDir?: string; components: InstallComponent[] }) {
  const installDir = resolveInstallDir(options.installDir);
  const stopped: Array<{ component: InstallComponent; stopped: boolean; pid: number | null }> = [];
  for (const component of options.components) {
    if (isManagedLinuxService(installDir, component)) {
      const before = linuxServiceStatus(component);
      controlLinuxService("stop", component);
      if (linuxServiceStatus(component).running) throw new Error(`systemd did not stop ${component}.`);
      stopped.push({component, stopped: before.running, pid: before.pid});
      continue;
    }
    const pid = loadPid(installDir, component);
    if (!pid) {
      if (COMPONENT_URL[component] && await checkHttpUp(COMPONENT_URL[component]!)) {
        throw new Error(`${component} is reachable but is not managed by this CLI. Stop its supervisor before proceeding.`);
      }
      stopped.push({ component, stopped: false, pid: null });
      continue;
    }
    if (process.platform === "win32") {
      const result = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore", windowsHide: true,
      });
      if (result.status !== 0 && processIsAlive(pid)) throw new Error(`Could not stop ${component}.`);
    } else {
      // startComponents detaches a new process group. Kill npm AND its descendants.
      const groupAlive = () => processIsAlive(-pid);
      const signalGroup = (signal: NodeJS.Signals) => {
        try { process.kill(-pid, signal); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      };
      signalGroup("SIGTERM");
      const deadline = Date.now() + 10_000;
      while (groupAlive() && Date.now() < deadline) await delay(50);
      if (groupAlive()) {
        signalGroup("SIGKILL");
        const killDeadline = Date.now() + 5_000;
        while (groupAlive() && Date.now() < killDeadline) await delay(50);
      }
      if (groupAlive()) throw new Error(`${component} process group did not stop. No backup is safe yet.`);
    }
    clearPid(installDir, component);
    stopped.push({ component, stopped: true, pid });
  }
  return { installDir, stopped };
}

export async function getComponentsStatus(options: {
  installDir?: string;
  components: InstallComponent[];
}) {
  const installDir = resolveInstallDir(options.installDir);
  const statuses: ComponentStatus[] = [];
  for (const component of options.components) {
    const managed = isManagedLinuxService(installDir, component) ? linuxServiceStatus(component) : null;
    const pid = managed ? managed.pid : loadPid(installDir, component);
    const url = COMPONENT_URL[component];
    const reachable = url ? await checkHttpUp(url) : undefined;
    statuses.push({
      component,
      running: managed ? managed.running : Boolean(pid) || Boolean(reachable),
      pid,
      url,
      reachable,
    });
  }
  return { installDir, statuses };
}

