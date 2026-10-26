import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync, symlinkSync, existsSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import * as tar from "tar";
import {createSafetyBackup, assertLocalRuntimePaths, runUpgrade} from "../src/lib/upgrade.ts";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "nest-upgrade-"));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  mkdirSync(join(root, ".git"));
  return root;
}
function actions(log, overrides = {}) {
  let stopped = false;
  return {
    status: async () => ({statuses: ["api", "runner"].map(component => ({component, running: !stopped}))}),
    stop: async ({components}) => {log.push(["stop", ...components]); stopped = true;},
    backup: async () => {log.push(["backup"]); return "";},
    install: async options => {log.push(["install", options.registerService]); return {repoRef: "main", repoUrl: "fixture"};},
    start: async ({components}) => {log.push(["start", ...components]); stopped = false;},
    revision: () => "a".repeat(40),
    ...overrides,
  };
}

test("UI-only upgrades quiesce both writers before backup and restore the running set", async t => {
  const log = [];
  await runUpgrade({installDir: fixture(t), components: "user-ui"}, actions(log));
  assert.ok(log[0].includes("api") && log[0].includes("runner"));
  assert.deepEqual(log.slice(1), [["backup"], ["install", false], ["start", "api", "runner"]]);
});
test("--no-restart does not enable/restart registered services via install", async t => {
  const log = [];
  await runUpgrade({installDir: fixture(t), restart: false}, actions(log));
  assert.deepEqual(log.slice(1), [["backup"], ["install", false]]);
});
test("backup failure recovers the old services without installing anything", async t => {
  const log = [];
  await assert.rejects(runUpgrade({installDir: fixture(t)}, actions(log, {backup: async () => {throw new Error("disk full");}})), /disk full/);
  assert.deepEqual(log.at(-1), ["start", "api", "runner"]);
  assert.ok(!log.some(row => row[0] === "install"));
});
test("unquiesced writers prevent backup and mutation", async t => {
  const log = [];
  const fake = actions(log, {status: async () => ({statuses: [{component: "api", running: true}]})});
  await assert.rejects(runUpgrade({installDir: fixture(t)}, fake), /still running/);
  assert.ok(!log.some(row => ["backup", "install"].includes(row[0])));
});
test("failed install remains stopped and reports paired database recovery", async t => {
  const log = [];
  await assert.rejects(runUpgrade({installDir: fixture(t)}, actions(log, {install: async () => {throw new Error("build failed");}})), /components are stopped.*BOTH databases/);
  assert.equal(log.at(-1)[0], "stop");
  assert.ok(!log.some(row => row[0] === "start"));
});
test("failed readiness does not restart old source against new schemas", async t => {
  const log = [];
  await assert.rejects(runUpgrade({installDir: fixture(t)}, actions(log, {start: async () => {throw new Error("health check failed");}})), /components are stopped/);
  assert.equal(log.at(-1)[0], "stop");
});
test("exclusive upgrade lock rejects concurrent changes and releases after failure", async t => {
  const root = fixture(t);
  mkdirSync(join(root, ".nest-upgrade.lock"));
  await assert.rejects(runUpgrade({installDir: root}, actions([])), /Another upgrade/);
  rmSync(join(root, ".nest-upgrade.lock"), {recursive: true});
  await assert.rejects(runUpgrade({installDir: root}, actions([], {backup: async () => {throw new Error("fail");}})));
  assert.equal(existsSync(join(root, ".nest-upgrade.lock")), false);
});
test("offline archive preserves both DBs, WAL, identity, skills, files and env privately", async t => {
  const root = fixture(t);
  const payload = {
    ".nest-data/nest.sqlite": "engine", ".nest-data/nest.sqlite-wal": "committed WAL",
    ".nest-product/nest.sqlite": "product", ".nest-product/nest.sqlite-wal": "product WAL",
    ".nest-data/runner-id": "stable-runner", ".agent-runner-id": "legacy-id",
    ".nest-data/codex-home/auth.json": "synthetic-auth", ".nest-data/engine/skills/custom/SKILL.md": "skill",
    "files/upload.txt": "upload", ".env": "SYNTHETIC_TEST_SECRET=not-a-real-secret\n",
  };
  for (const [file, value] of Object.entries(payload)) {
    mkdirSync(join(root, file, ".."), {recursive: true}); writeFileSync(join(root, file), value);
  }
  const archive = await createSafetyBackup(root);
  if (process.platform !== "win32") {
    assert.equal(statSync(archive).mode & 0o777, 0o600);
    assert.equal(statSync(join(root, ".nest-backups")).mode & 0o777, 0o700);
  }
  const restored = join(root, "restore"); mkdirSync(restored);
  await tar.x({file: archive, cwd: restored});
  for (const [file, value] of Object.entries(payload)) assert.equal(readFileSync(join(restored, file), "utf-8"), value);
});
test("custom runtime paths fail before services are touched", t => {
  const root = fixture(t);
  writeFileSync(join(root, ".env"), "NEST_PRODUCT_DB_PATH=/outside/nest.sqlite\n");
  assert.throws(() => assertLocalRuntimePaths(root), /Custom NEST_PRODUCT_DB_PATH/);
});
test("linked runtime paths cannot silently produce incomplete archives", {skip: process.platform === "win32"}, t => {
  const root = fixture(t);
  const outside = fixture(t);
  symlinkSync(outside, join(root, ".nest-data"));
  assert.throws(() => assertLocalRuntimePaths(root), /Linked runtime path/);
});
