import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { runAgentTurn } from "./lib/agent";
import { SESSION_LOG_PATH, DOUBLE_SIGINT_WINDOW_MS } from "./lib/config";
import { loadBuildTimestamp, loadBundledDocsText } from "./lib/bundle";
import {
  ensureModelCredentials,
  getModelId,
  getNestCliEnvPath,
  loadDotEnvIntoProcess,
} from "./lib/env";
import { appendSessionLog, resetSessionLog } from "./lib/logger";
import type { CliOptions, SessionMemory } from "./lib/types";
import { TaskInterruptedError } from "./lib/types";
import { forceStopSpinner, rolePrefix, writeRoleMessage } from "./lib/ui";
import { toDisplayError } from "./lib/utils";
import { runInstall } from "./lib/install";
import { ensurePrerequisites } from "./lib/prereqs";
import { runUpgrade } from "./lib/upgrade";
import { getComponentsStatus, startComponents, stopComponents } from "./lib/component-runtime";
import { formatComponents, parseComponentsArg } from "./lib/components";
import { loadState } from "./lib/runtime-state";
import { createShortcutAction, registerServiceAction, unregisterServiceAction } from "./lib/lifecycle-actions";
import type { ShortcutTarget } from "./lib/browser";

type ParsedCommand =
  | { name: "help" }
  | { name: "chat"; options: CliOptions }
  | {
      name: "install";
      options: {
        installDir?: string;
        repoUrl?: string;
        repoRef?: string;
        components?: string;
        runnerApiUrl?: string;
        runnerToken?: string;
        runnerName?: string;
        runnerInviteUrl?: string;
        registerService: boolean;
        createShortcut: boolean;
      };
    }
  | {
      name: "upgrade";
      options: {
        installDir?: string;
        repoUrl?: string;
        repoRef?: string;
        components?: string;
        runnerApiUrl?: string;
        runnerToken?: string;
        runnerName?: string;
        runnerInviteUrl?: string;
        restart: boolean;
      };
    }
  | {
      name: "admin-open";
      options: { installDir?: string };
    }
  | {
      name: "admin-stop";
      options: { installDir?: string };
    }
  | {
      name: "admin-status";
      options: { installDir?: string };
    }
  | {
      name: "service-register";
      options: { installDir?: string; components?: string };
    }
  | {
      name: "service-unregister";
      options: { installDir?: string; components?: string };
    }
  | {
      name: "shortcut-create";
      options: { url?: string; target: ShortcutTarget };
    }
  | {
      name: "start";
      options: { installDir?: string; openBrowser: boolean; components?: string };
    }
  | {
      name: "stop";
      options: { installDir?: string; components?: string };
    }
  | {
      name: "status";
      options: { installDir?: string; components?: string };
    }
  | { name: "doctor" };

function parseChatArgs(argv: string[]): CliOptions {
  const args = [...argv];
  let goal: string | null = null;
  let help = false;
  while (args.length > 0) {
    const token = args.shift() ?? "";
    if (token === "--help" || token === "-h") {
      help = true;
      continue;
    }
    if (token === "--goal" || token === "-g") {
      const value = args.shift();
      if (!value) throw new Error(`Missing value for ${token}. Usage: --goal "your instruction"`);
      goal = value;
      continue;
    }
    throw new Error(`Unknown argument: ${token}. Use --help for usage.`);
  }
  return { goal, help };
}

function printCliHelp() {
  const lines = [
    "Nest CLI",
    "",
    "Usage:",
    "  nest chat [--goal \"instruction\"]",
    "  nest install [--dir <path>] [--repo <url>] [--ref <git-ref>] [--components <csv>] [--runner-api-url <url>] [--runner-token <token>] [--runner-name <name>] [--runner-invite-url <url>] [--register-service] [--create-shortcut]",
    "  nest upgrade [--dir <path>] [--repo <url>] [--ref <git-ref>] [--components <csv>] [--runner-api-url <url>] [--runner-token <token>] [--runner-name <name>] [--runner-invite-url <url>] [--no-restart]",
    "  nest start [--dir <path>] [--components <csv>] [--no-open]",
    "  nest stop [--dir <path>] [--components <csv>]",
    "  nest status [--dir <path>] [--components <csv>]",
    "  nest service register [--dir <path>] [--components <csv>]",
    "  nest service unregister [--dir <path>] [--components <csv>]",
    "  nest shortcut create [--target user-ui|admin-ui] [--url <url>]",
    "  nest admin open [--dir <path>]",
    "  nest admin stop [--dir <path>]",
    "  nest admin status [--dir <path>]",
    "  nest doctor",
    "",
    "Options:",
    "  -g, --goal <text>    Chat: run one autonomous goal and exit",
    "  --dir <path>         Install/admin/service: Nest install directory (default: ./nest)",
    "  --repo <url>         Install: git repository URL",
    "  --ref <git-ref>      Install: git branch/tag/ref (default: main)",
    "  --components <csv>   Components: api,runner,user-ui,admin-ui",
    "  --runner-api-url     Runner install/upgrade API base URL",
    "  --runner-token       Runner install/upgrade token",
    "  --runner-name        Runner display name",
    "  --runner-invite-url  Runner invite URL generated by Admin UI",
    "  --register-service   Install: register per-component auto-start services at login",
    "  --create-shortcut    Install: create desktop shortcut for User UI",
    "  --target <name>      Shortcut target: user-ui or admin-ui (default: user-ui)",
    "  --url <url>          Shortcut: override URL (default depends on --target)",
    "  --no-restart         Upgrade: do not restart previously running services",
    "  --no-open            Start: do not open User UI in browser",
    "  -h, --help           Show help",
  ];
  stdout.write(`${lines.join("\n")}\n`);
}

function parseGlobalArgs(argv: string[]): ParsedCommand {
  const [first = "help", second = "", ...rest] = argv;
  if (first === "--help" || first === "-h" || first === "help") return { name: "help" };
  if (first === "doctor") return { name: "doctor" };
  if (first === "start") {
    let installDir: string | undefined;
    let openBrowser = true;
    let components: string | undefined;
    const args = [second, ...rest].filter(Boolean);
    while (args.length > 0) {
      const token = args.shift() ?? "";
      if (token === "--dir") {
        installDir = args.shift();
        if (!installDir) throw new Error("Missing value for --dir.");
        continue;
      }
      if (token === "--components") {
        components = args.shift();
        if (!components) throw new Error("Missing value for --components.");
        continue;
      }
      if (token === "--no-open") {
        openBrowser = false;
        continue;
      }
      throw new Error(`Unknown argument for start: ${token}`);
    }
    return { name: "start", options: { installDir, openBrowser, components } };
  }
  if (first === "stop") {
    let installDir: string | undefined;
    let components: string | undefined;
    const args = [second, ...rest].filter(Boolean);
    while (args.length > 0) {
      const token = args.shift() ?? "";
      if (token === "--dir") {
        installDir = args.shift();
        if (!installDir) throw new Error("Missing value for --dir.");
        continue;
      }
      if (token === "--components") {
        components = args.shift();
        if (!components) throw new Error("Missing value for --components.");
        continue;
      }
      throw new Error(`Unknown argument for stop: ${token}`);
    }
    return { name: "stop", options: { installDir, components } };
  }
  if (first === "status") {
    let installDir: string | undefined;
    let components: string | undefined;
    const args = [second, ...rest].filter(Boolean);
    while (args.length > 0) {
      const token = args.shift() ?? "";
      if (token === "--dir") {
        installDir = args.shift();
        if (!installDir) throw new Error("Missing value for --dir.");
        continue;
      }
      if (token === "--components") {
        components = args.shift();
        if (!components) throw new Error("Missing value for --components.");
        continue;
      }
      throw new Error(`Unknown argument for status: ${token}`);
    }
    return { name: "status", options: { installDir, components } };
  }
  if (first === "admin" && second === "open") {
    let installDir: string | undefined;
    const args = [...rest];
    while (args.length > 0) {
      const token = args.shift() ?? "";
      if (token === "--dir") {
        installDir = args.shift();
        if (!installDir) throw new Error("Missing value for --dir.");
        continue;
      }
      throw new Error(`Unknown argument for admin open: ${token}`);
    }
    return { name: "admin-open", options: { installDir } };
  }
  if (first === "admin" && second === "stop") {
    let installDir: string | undefined;
    const args = [...rest];
    while (args.length > 0) {
      const token = args.shift() ?? "";
      if (token === "--dir") {
        installDir = args.shift();
        if (!installDir) throw new Error("Missing value for --dir.");
        continue;
      }
      throw new Error(`Unknown argument for admin stop: ${token}`);
    }
    return { name: "admin-stop", options: { installDir } };
  }
  if (first === "admin" && second === "status") {
    let installDir: string | undefined;
    const args = [...rest];
    while (args.length > 0) {
      const token = args.shift() ?? "";
      if (token === "--dir") {
        installDir = args.shift();
        if (!installDir) throw new Error("Missing value for --dir.");
        continue;
      }
      throw new Error(`Unknown argument for admin status: ${token}`);
    }
    return { name: "admin-status", options: { installDir } };
  }
  if (first === "service" && second === "register") {
    let installDir: string | undefined;
    let components: string | undefined;
    const args = [...rest];
    while (args.length > 0) {
      const token = args.shift() ?? "";
      if (token === "--dir") {
        installDir = args.shift();
        if (!installDir) throw new Error("Missing value for --dir.");
        continue;
      }
      if (token === "--components") {
        components = args.shift();
        if (!components) throw new Error("Missing value for --components.");
        continue;
      }
      throw new Error(`Unknown argument for service register: ${token}`);
    }
    return { name: "service-register", options: { installDir, components } };
  }
  if (first === "service" && second === "unregister") {
    let installDir: string | undefined;
    let components: string | undefined;
    const args = [...rest];
    while (args.length > 0) {
      const token = args.shift() ?? "";
      if (token === "--dir") {
        installDir = args.shift();
        if (!installDir) throw new Error("Missing value for --dir.");
        continue;
      }
      if (token === "--components") {
        components = args.shift();
        if (!components) throw new Error("Missing value for --components.");
        continue;
      }
      throw new Error(`Unknown argument for service unregister: ${token}`);
    }
    return { name: "service-unregister", options: { installDir, components } };
  }
  if (first === "shortcut" && second === "create") {
    let url: string | undefined;
    let target: ShortcutTarget = "user-ui";
    const args = [...rest];
    while (args.length > 0) {
      const token = args.shift() ?? "";
      if (token === "--target") {
        const raw = args.shift();
        if (!raw) throw new Error("Missing value for --target.");
        if (raw !== "user-ui" && raw !== "admin-ui") {
          throw new Error("Invalid value for --target. Use user-ui or admin-ui.");
        }
        target = raw;
        continue;
      }
      if (token === "--url") {
        url = args.shift();
        if (!url) throw new Error("Missing value for --url.");
        continue;
      }
      throw new Error(`Unknown argument for shortcut create: ${token}`);
    }
    return { name: "shortcut-create", options: { target, url } };
  }
  if (first === "install") {
    const args = [second, ...rest].filter(Boolean);
    let installDir: string | undefined;
    let repoUrl: string | undefined;
    let repoRef: string | undefined;
    let components: string | undefined;
    let runnerApiUrl: string | undefined;
    let runnerToken: string | undefined;
    let runnerName: string | undefined;
    let runnerInviteUrl: string | undefined;
    let registerService = false;
    let createShortcut = false;
    while (args.length > 0) {
      const token = args.shift() ?? "";
      if (token === "--dir") {
        installDir = args.shift();
        if (!installDir) throw new Error("Missing value for --dir.");
        continue;
      }
      if (token === "--repo") {
        repoUrl = args.shift();
        if (!repoUrl) throw new Error("Missing value for --repo.");
        continue;
      }
      if (token === "--ref") {
        repoRef = args.shift();
        if (!repoRef) throw new Error("Missing value for --ref.");
        continue;
      }
      if (token === "--components") {
        components = args.shift();
        if (!components) throw new Error("Missing value for --components.");
        continue;
      }
      if (token === "--runner-api-url") {
        runnerApiUrl = args.shift();
        if (!runnerApiUrl) throw new Error("Missing value for --runner-api-url.");
        continue;
      }
      if (token === "--runner-token") {
        runnerToken = args.shift();
        if (!runnerToken) throw new Error("Missing value for --runner-token.");
        continue;
      }
      if (token === "--runner-name") {
        runnerName = args.shift();
        if (!runnerName) throw new Error("Missing value for --runner-name.");
        continue;
      }
      if (token === "--runner-invite-url") {
        runnerInviteUrl = args.shift();
        if (!runnerInviteUrl) throw new Error("Missing value for --runner-invite-url.");
        continue;
      }
      if (token === "--register-service") {
        registerService = true;
        continue;
      }
      if (token === "--create-shortcut") {
        createShortcut = true;
        continue;
      }
      throw new Error(`Unknown argument for install: ${token}`);
    }
    return {
      name: "install",
      options: {
        installDir,
        repoUrl,
        repoRef,
        components,
        runnerApiUrl,
        runnerToken,
        runnerName,
        runnerInviteUrl,
        registerService,
        createShortcut,
      },
    };
  }
  if (first === "upgrade") {
    const args = [second, ...rest].filter(Boolean);
    let installDir: string | undefined;
    let repoUrl: string | undefined;
    let repoRef: string | undefined;
    let components: string | undefined;
    let runnerApiUrl: string | undefined;
    let runnerToken: string | undefined;
    let runnerName: string | undefined;
    let runnerInviteUrl: string | undefined;
    let restart = true;
    while (args.length > 0) {
      const token = args.shift() ?? "";
      if (token === "--dir") {
        installDir = args.shift();
        if (!installDir) throw new Error("Missing value for --dir.");
        continue;
      }
      if (token === "--repo") {
        repoUrl = args.shift();
        if (!repoUrl) throw new Error("Missing value for --repo.");
        continue;
      }
      if (token === "--ref") {
        repoRef = args.shift();
        if (!repoRef) throw new Error("Missing value for --ref.");
        continue;
      }
      if (token === "--components") {
        components = args.shift();
        if (!components) throw new Error("Missing value for --components.");
        continue;
      }
      if (token === "--runner-api-url") {
        runnerApiUrl = args.shift();
        if (!runnerApiUrl) throw new Error("Missing value for --runner-api-url.");
        continue;
      }
      if (token === "--runner-token") {
        runnerToken = args.shift();
        if (!runnerToken) throw new Error("Missing value for --runner-token.");
        continue;
      }
      if (token === "--runner-name") {
        runnerName = args.shift();
        if (!runnerName) throw new Error("Missing value for --runner-name.");
        continue;
      }
      if (token === "--runner-invite-url") {
        runnerInviteUrl = args.shift();
        if (!runnerInviteUrl) throw new Error("Missing value for --runner-invite-url.");
        continue;
      }
      if (token === "--no-restart") {
        restart = false;
        continue;
      }
      throw new Error(`Unknown argument for upgrade: ${token}`);
    }
    return {
      name: "upgrade",
      options: {
        installDir,
        repoUrl,
        repoRef,
        components,
        runnerApiUrl,
        runnerToken,
        runnerName,
        runnerInviteUrl,
        restart,
      },
    };
  }
  if (first === "chat") {
    const options = parseChatArgs([second, ...rest].filter(Boolean));
    if (options.help) return { name: "help" };
    return { name: "chat", options };
  }
  if (first === "--goal" || first === "-g") {
    return { name: "chat", options: parseChatArgs(argv) };
  }
  if (!first.trim()) return { name: "help" };
  throw new Error(`Unknown command: ${first}`);
}

async function runChat(cli: CliOptions) {
  try {
    const rootEnvPath = getNestCliEnvPath();
    loadDotEnvIntoProcess(rootEnvPath);
    resetSessionLog(getModelId());
    appendSessionLog("chat initialized");

    writeRoleMessage("nest", "Nest CLI chat ready.");
    const buildTimestamp = loadBuildTimestamp();
    if (buildTimestamp) writeRoleMessage("nest", `Build timestamp (UTC): ${buildTimestamp}`);
    writeRoleMessage("nest", `Nest CLI session log: ${SESSION_LOG_PATH}`);

    let rl = createInterface({ input: stdin, output: stdout });
    const hasCredentials = await ensureModelCredentials({
      ask: (prompt) => rl.question(prompt),
      rootEnvPath,
    });
    if (!hasCredentials) {
      rl.close();
      process.exitCode = 1;
      return;
    }

    const docsText = loadBundledDocsText();
    const memory: SessionMemory = { summary: "", history: [] };
    if (!cli.goal) writeRoleMessage("nest", "Type a goal (can be empty), or 'exit' to quit.");
    else writeRoleMessage("nest", "Running one-shot goal from CLI argument.");

    let activeTaskAbortController: AbortController | null = null;
    let lastSigintAt = 0;

    const onSigint = () => {
      const now = Date.now();
      const isDoubleSigint = now - lastSigintAt <= DOUBLE_SIGINT_WINDOW_MS;
      lastSigintAt = now;
      if (isDoubleSigint) {
        appendSessionLog("sigint received twice: exiting process");
        if (activeTaskAbortController && !activeTaskAbortController.signal.aborted) {
          activeTaskAbortController.abort();
        }
        forceStopSpinner();
        writeRoleMessage("nest", "Second Ctrl+C detected. Exiting Nest CLI.", { leadingNewline: true });
        process.exit(130);
      }
      if (activeTaskAbortController && !activeTaskAbortController.signal.aborted) {
        appendSessionLog("sigint received: interrupting active run");
        activeTaskAbortController.abort();
        forceStopSpinner();
        writeRoleMessage(
          "nest",
          "Interrupt requested. Stopping current run... (press Ctrl+C again quickly to exit)",
          { leadingNewline: true }
        );
        return;
      }
      forceStopSpinner();
      writeRoleMessage(
        "nest",
        "No active run to interrupt. Press Ctrl+C again quickly to exit (or type 'exit').",
        { leadingNewline: true }
      );
    };

    rl.on("SIGINT", onSigint);
    try {
      const askPasswordInput = async (question: string) => {
        writeRoleMessage("nest", `${question} (input hidden)`, { leadingNewline: true });
        const mutableRl = rl as unknown as {
          _writeToOutput?: (text: string) => void;
        };
        const originalWrite = mutableRl._writeToOutput;
        mutableRl._writeToOutput = () => {};
        try {
          return await rl.question(`${rolePrefix("user")} `);
        } finally {
          mutableRl._writeToOutput = originalWrite;
          stdout.write("\n");
        }
      };

      const executePrompt = async (promptText: string) => {
        activeTaskAbortController = new AbortController();
        const result = await runAgentTurn({
          modelId: getModelId(),
          docsText,
          promptText,
          memory,
          requestPasswordInput: askPasswordInput,
          abortSignal: activeTaskAbortController.signal,
        });
        activeTaskAbortController = null;
        return result;
      };

      if (cli.goal) {
        const result = await executePrompt(cli.goal);
        if (result.requestedExit) process.exitCode = result.exitCode;
        return;
      }

      while (true) {
        let input = "";
        try {
          input = await rl.question(`\n${rolePrefix("user")} `);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException | undefined)?.code;
          if (code === "ERR_USE_AFTER_CLOSE") {
            appendSessionLog("readline closed unexpectedly; recreating prompt");
            rl.close();
            rl = createInterface({ input: stdin, output: stdout });
            rl.on("SIGINT", onSigint);
            writeRoleMessage("nest", "Prompt recovered after interrupt.", { leadingNewline: true });
            continue;
          }
          throw error;
        }

        const normalized = input.trim().toLowerCase();
        if (normalized === "exit" || normalized === "quit") break;

        try {
          const result = await executePrompt(input);
          if (result.requestedExit) {
            process.exitCode = result.exitCode;
            break;
          }
        } catch (error) {
          activeTaskAbortController = null;
          if (error instanceof TaskInterruptedError) {
            writeRoleMessage("nest", "Interrupted current run. You can now ask follow-ups or retry.", {
              leadingNewline: true,
            });
            continue;
          }
          writeRoleMessage("error", `Task failed: ${toDisplayError(error)}`, {
            leadingNewline: true,
            toStderr: true,
          });
        }
      }
    } finally {
      rl.off("SIGINT", onSigint);
      rl.close();
    }
  } catch (error) {
    writeRoleMessage("error", `Chat failed: ${toDisplayError(error)}`, { toStderr: true });
    process.exitCode = 1;
  }
}

function printDoctor() {
  const check = ensurePrerequisites();
  if (check.ok) {
    writeRoleMessage("nest", "Doctor check: all prerequisites available (node, npm, git).");
    return;
  }
  for (const result of check.results) {
    writeRoleMessage(
      "nest",
      `${result.name}: ${result.ok ? "ok" : "missing"}${result.output ? ` (${result.output})` : ""}`
    );
  }
  writeRoleMessage("error", check.hint || "Missing prerequisites.", { toStderr: true });
  process.exitCode = 1;
}

function resolveTargetComponents(raw: string | undefined) {
  if (raw?.trim()) return parseComponentsArg(raw);
  const persisted = loadState().installedComponents;
  if (Array.isArray(persisted) && persisted.length > 0) return persisted;
  throw new Error(
    "No installed components recorded. Pass --components explicitly (e.g. api,runner,user-ui)."
  );
}

function resolveServiceComponents(raw: string | undefined) {
  if (raw?.trim()) return parseComponentsArg(raw);
  const state = loadState();
  if (Array.isArray(state.serviceComponents) && state.serviceComponents.length > 0) {
    return state.serviceComponents;
  }
  if (Array.isArray(state.installedComponents) && state.installedComponents.length > 0) {
    return state.installedComponents;
  }
  return parseComponentsArg(undefined);
}

async function main() {
  let parsed: ParsedCommand;
  try {
    parsed = parseGlobalArgs(process.argv.slice(2));
  } catch (error) {
    writeRoleMessage("error", String(error), { toStderr: true });
    printCliHelp();
    process.exitCode = 1;
    return;
  }

  if (parsed.name === "help") {
    printCliHelp();
    return;
  }

  if (parsed.name === "doctor") {
    printDoctor();
    return;
  }

  if (parsed.name === "install") {
    try {
      writeRoleMessage("nest", "Running deterministic Nest install.");
      const result = await runInstall(parsed.options);
      writeRoleMessage("nest", `Install complete at ${result.installDir}.`);
      writeRoleMessage("nest", `Installed components: ${result.componentsSummary}`);
      if (result.runnerConfigApplied) {
        writeRoleMessage("nest", "Runner environment configured in .env.");
      }
      if (result.serviceRegistered) writeRoleMessage("nest", result.serviceMessage || "Service registered.");
      if (result.shortcutPath) writeRoleMessage("nest", `Created shortcut: ${result.shortcutPath}`);
      writeRoleMessage("nest", `User UI URL: ${result.userUiUrl}`);
    } catch (error) {
      writeRoleMessage("error", `Install failed: ${toDisplayError(error)}`, { toStderr: true });
      process.exitCode = 1;
    }
    return;
  }

  if (parsed.name === "upgrade") {
    try {
      writeRoleMessage("nest", "Running safe in-place Nest upgrade.");
      const result = await runUpgrade(parsed.options);
      writeRoleMessage("nest", `Upgrade complete at ${result.installDir}.`);
      if (result.backupPath) {
        writeRoleMessage("nest", `Safety backup: ${result.backupPath}`);
      } else {
        writeRoleMessage("nest", "No backup payload found (.nest-data/files/.env missing).");
      }
      writeRoleMessage("nest", `Components: ${formatComponents(result.components)}`);
      writeRoleMessage("nest", `Restart policy: ${result.restartMessage}`);
    } catch (error) {
      writeRoleMessage("error", `Upgrade failed: ${toDisplayError(error)}`, { toStderr: true });
      process.exitCode = 1;
    }
    return;
  }

  if (parsed.name === "start") {
    try {
      const components = resolveTargetComponents(parsed.options.components);
      writeRoleMessage("nest", `Starting components: ${formatComponents(components)}.`);
      const result = await startComponents({
        installDir: parsed.options.installDir,
        components,
        openBrowser: parsed.options.openBrowser,
      });
      for (const item of result.started) {
        writeRoleMessage(
          "nest",
          item.alreadyRunning
            ? `${item.component}: already running (pid ${item.pid ?? "unknown"})`
            : `${item.component}: started (pid ${item.pid ?? "unknown"})`
        );
      }
    } catch (error) {
      writeRoleMessage("error", `Start failed: ${toDisplayError(error)}`, { toStderr: true });
      process.exitCode = 1;
    }
    return;
  }

  if (parsed.name === "stop") {
    try {
      const components = resolveTargetComponents(parsed.options.components);
      writeRoleMessage("nest", `Stopping components: ${formatComponents(components)}.`);
      const result = stopComponents({ installDir: parsed.options.installDir, components });
      for (const item of result.stopped) {
        writeRoleMessage(
          "nest",
          item.stopped
            ? `${item.component}: stopped (pid ${item.pid ?? "unknown"})`
            : `${item.component}: not running`
        );
      }
    } catch (error) {
      writeRoleMessage("error", `Stop failed: ${toDisplayError(error)}`, { toStderr: true });
      process.exitCode = 1;
    }
    return;
  }

  if (parsed.name === "status") {
    try {
      const components = resolveTargetComponents(parsed.options.components);
      const status = await getComponentsStatus({
        installDir: parsed.options.installDir,
        components,
      });
      writeRoleMessage("nest", `Install dir: ${status.installDir}`);
      for (const item of status.statuses) {
        const details = [
          `running=${item.running ? "yes" : "no"}`,
          `pid=${item.pid !== null ? String(item.pid) : "none"}`,
        ];
        if (item.url) details.push(`url=${item.url}`);
        if (typeof item.reachable === "boolean") details.push(`reachable=${item.reachable ? "yes" : "no"}`);
        writeRoleMessage("nest", `${item.component}: ${details.join(" | ")}`);
      }
    } catch (error) {
      writeRoleMessage("error", `Status failed: ${toDisplayError(error)}`, { toStderr: true });
      process.exitCode = 1;
    }
    return;
  }

  if (parsed.name === "admin-open") {
    try {
      writeRoleMessage("nest", "Starting component: admin-ui.");
      const result = await startComponents({
        installDir: parsed.options.installDir,
        components: ["admin-ui"],
        openBrowser: true,
      });
      const first = result.started[0];
      writeRoleMessage("nest", `admin-ui: ${first?.alreadyRunning ? "already running" : "started"}`);
    } catch (error) {
      writeRoleMessage("error", `Admin UI command failed: ${toDisplayError(error)}`, { toStderr: true });
      process.exitCode = 1;
    }
    return;
  }

  if (parsed.name === "admin-stop") {
    try {
      writeRoleMessage("nest", "Stopping component: admin-ui.");
      const result = stopComponents({
        installDir: parsed.options.installDir,
        components: ["admin-ui"],
      });
      const first = result.stopped[0];
      writeRoleMessage("nest", first?.stopped ? "admin-ui: stopped" : "admin-ui: not running");
    } catch (error) {
      writeRoleMessage("error", `Admin stop failed: ${toDisplayError(error)}`, { toStderr: true });
      process.exitCode = 1;
    }
    return;
  }

  if (parsed.name === "admin-status") {
    try {
      const status = await getComponentsStatus({
        installDir: parsed.options.installDir,
        components: ["admin-ui"],
      });
      const first = status.statuses[0];
      if (first) {
        writeRoleMessage("nest", `Install dir: ${status.installDir}`);
        writeRoleMessage(
          "nest",
          `admin-ui: running=${first.running ? "yes" : "no"} | pid=${first.pid ?? "none"} | reachable=${first.reachable ? "yes" : "no"} | url=${first.url ?? "n/a"}`
        );
      }
    } catch (error) {
      writeRoleMessage("error", `Admin status failed: ${toDisplayError(error)}`, { toStderr: true });
      process.exitCode = 1;
    }
    return;
  }

  if (parsed.name === "service-register") {
    try {
      const components = resolveServiceComponents(parsed.options.components);
      const result = registerServiceAction({
        installDir: parsed.options.installDir,
        components,
      });
      writeRoleMessage("nest", `Services registered for install dir: ${result.installDir}`);
      writeRoleMessage("nest", `Components: ${formatComponents(result.serviceComponents)}`);
      for (const message of result.messages) writeRoleMessage("nest", message);
    } catch (error) {
      writeRoleMessage("error", `Service registration failed: ${toDisplayError(error)}`, { toStderr: true });
      process.exitCode = 1;
    }
    return;
  }

  if (parsed.name === "service-unregister") {
    try {
      const components = resolveServiceComponents(parsed.options.components);
      const result = unregisterServiceAction({
        installDir: parsed.options.installDir,
        components,
      });
      writeRoleMessage("nest", `Services unregistered for install dir: ${result.installDir}`);
      writeRoleMessage("nest", `Components: ${formatComponents(components)}`);
      for (const message of result.messages) writeRoleMessage("nest", message);
    } catch (error) {
      writeRoleMessage("error", `Service unregister failed: ${toDisplayError(error)}`, { toStderr: true });
      process.exitCode = 1;
    }
    return;
  }

  if (parsed.name === "shortcut-create") {
    try {
      const result = createShortcutAction({ target: parsed.options.target, url: parsed.options.url });
      writeRoleMessage("nest", `Created shortcut: ${result.shortcutPath}`);
      writeRoleMessage("nest", `Shortcut target: ${result.target}`);
      writeRoleMessage("nest", `Shortcut URL: ${result.url}`);
    } catch (error) {
      writeRoleMessage("error", `Shortcut creation failed: ${toDisplayError(error)}`, { toStderr: true });
      process.exitCode = 1;
    }
    return;
  }

  await runChat(parsed.options);
}

void main().catch((error) => {
  writeRoleMessage("error", `Fatal startup error: ${toDisplayError(error)}`, { toStderr: true });
  process.exitCode = 1;
});
