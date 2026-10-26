import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { readRunnerEnvConfig, resolveRunnerBootstrap, writeRunnerEnvConfig } from "../src/lib/runner-bootstrap.ts";

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


test("reinstall/upgrade preserves configured runner identity and credentials", async () => {
  const existing = {apiUrl: "https://engine.example", runnerToken: "synthetic-saved-token", runnerName: "stable-runner"};
  assert.deepEqual(await resolveRunnerBootstrap({}, existing), existing);
  assert.deepEqual(await resolveRunnerBootstrap({runnerApiUrl: "https://new.example"}, existing), {...existing, apiUrl: "https://new.example"});
});


test("runner env updates preserve quoted credentials, JSON and multiline settings", t => {
  const root = mkdtempSync(join(tmpdir(), "nest-runner-env-"));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  writeFileSync(join(root, ".env"), `OTHER_SECRET='has # and spaces'\nNEST_COMPOSIO_AUTH_CONFIGS='{"trello":"synthetic"}'\nMULTILINE='line1\nline2'\n`);
  writeRunnerEnvConfig(root, {apiUrl: "https://engine.example", runnerToken: "test # token"});
  assert.deepEqual(parseEnv(readFileSync(join(root, ".env"), "utf-8")), {
    OTHER_SECRET: "has # and spaces", NEST_COMPOSIO_AUTH_CONFIGS: '{"trello":"synthetic"}', MULTILINE: "line1\nline2",
    NEST_API_URL: "https://engine.example", NEST_RUNNER_TOKEN: "test # token",
  });
});
