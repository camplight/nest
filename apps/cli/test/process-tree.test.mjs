import test from "node:test";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {setTimeout as delay} from "node:timers/promises";
import {stopComponents} from "../src/lib/component-runtime.ts";

test("stop waits for a detached parent AND its descendant before clearing the PID", {skip: process.platform === "win32", timeout: 20000}, async t => {
  const root = mkdtempSync(join(tmpdir(), "nest-process-tree-"));
  let pid;
  t.after(() => {
    try { if (pid) process.kill(-pid, "SIGKILL"); } catch {}
    rmSync(root, {recursive: true, force: true});
  });
  const heartbeat = join(root, "heartbeat");
  const childSource = `import {appendFileSync} from 'node:fs'; setInterval(() => appendFileSync(${JSON.stringify(heartbeat)}, 'tick\\n'), 30);`;
  writeFileSync(join(root, "child.mjs"), childSource);
  writeFileSync(join(root, "parent.mjs"), `import {spawn} from 'node:child_process'; const child=spawn(process.execPath, ['child.mjs']); process.on('SIGTERM', () => { child.kill('SIGTERM'); child.on('exit', () => process.exit(0)); }); setInterval(() => {},1000);`);
  const parent = spawn(process.execPath, ["parent.mjs"], {cwd: root, detached: true, stdio: "ignore"});
  pid = parent.pid;
  mkdirSync(join(root, ".nest-runtime"));
  writeFileSync(join(root, ".nest-runtime/runner.json"), JSON.stringify({pid}));
  for (let i = 0; i < 100 && !existsSync(heartbeat); i++) await delay(30);
  assert.ok(existsSync(heartbeat), "descendant started writing");
  await stopComponents({installDir: root, components: ["runner"]});
  const contents = readFileSync(heartbeat, "utf-8");
  await delay(100);
  assert.equal(readFileSync(heartbeat, "utf-8"), contents);
  assert.equal(existsSync(join(root, ".nest-runtime/runner.json")), false);
});
