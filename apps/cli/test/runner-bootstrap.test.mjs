import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRunnerEnvConfig } from "../src/lib/runner-bootstrap.ts";

function readConfig(t, contents) {
  const root = mkdtempSync(join(tmpdir(), "nest-runner-bootstrap-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, ".env"), contents);
  return readRunnerEnvConfig(root);
}

test("reads existing OrgOps runner configuration", (t) => {
  assert.deepEqual(readConfig(t, [
    "ORGOPS_API_URL=https://legacy.example/",
    "ORGOPS_RUNNER_TOKEN=legacy-token",
    "ORGOPS_RUNNER_NAME=existing-runner",
  ].join("\n")), {
    apiUrl: "https://legacy.example",
    runnerToken: "legacy-token",
    runnerName: "existing-runner",
  });
});

test("Nest runner settings take precedence over legacy values", (t) => {
  assert.deepEqual(readConfig(t, [
    "ORGOPS_API_URL=https://legacy.example",
    "ORGOPS_RUNNER_TOKEN=legacy-token",
    "ORGOPS_RUNNER_NAME=existing-runner",
    "NEST_API_URL=https://nest.example/",
    "NEST_RUNNER_TOKEN=nest-token",
    "NEST_RUNNER_NAME=nest-runner",
  ].join("\n")), {
    apiUrl: "https://nest.example",
    runnerToken: "nest-token",
    runnerName: "nest-runner",
  });
});

test("explicit empty Nest token does not fall back to legacy credentials", (t) => {
  assert.equal(readConfig(t, [
    "NEST_API_URL=https://nest.example",
    "NEST_RUNNER_TOKEN=",
    "ORGOPS_RUNNER_TOKEN=legacy-token",
  ].join("\n")), null);
});
