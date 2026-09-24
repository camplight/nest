import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { InstallComponent } from "./components";

const STATE_DIR = resolve(process.env.NEST_CLI_STATE_DIR ?? join(homedir(), ".nest"));
const STATE_PATH = join(STATE_DIR, "nest-state.json");

export type NestCliState = {
  installDir?: string;
  repoUrl?: string;
  repoRef?: string;
  serviceRegistered?: boolean;
  serviceComponents?: InstallComponent[];
  installedComponents?: InstallComponent[];
};

export function getStatePath() {
  return STATE_PATH;
}

export function loadState(): NestCliState {
  if (!existsSync(STATE_PATH)) return {};
  try {
    const parsed = JSON.parse(readFileSync(STATE_PATH, "utf-8")) as NestCliState;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function saveState(next: NestCliState) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_PATH, `${JSON.stringify(next, null, 2)}\n`, "utf-8");
}
