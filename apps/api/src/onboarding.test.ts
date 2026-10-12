import { beforeEach, afterEach, describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApp as createEngine } from "../../../vendor/orgops/apps/api/src/app";
import { createOrgOpsClient } from "@nest/orgops-client";
import { createApp } from "./app";
import type { PersonalAgentConfig } from "./onboarding";
describe("personal onboarding through the untouched engine", () => {
  let dir: string,
    engine: ReturnType<typeof createEngine>,
    product: ReturnType<typeof createApp>,
    client: ReturnType<typeof createOrgOpsClient>,
    headers: Record<string, string>,
    settings: PersonalAgentConfig;
  let lose = "";
  const call = (path = "/api/onboarding", body?: unknown, h = headers) =>
    product.app.request(path, {
      headers: h,
      method: body === undefined ? "GET" : "POST",
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const input = {
    name: "PuffOwner",
    character: "puff",
    brief: "Help plan my week",
  };
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "nest-onboarding-"));
    lose = "";
    engine = createEngine({
      projectRoot: dir,
      dataDir: dir,
      dbPath: join(dir, "engine.sqlite"),
      adminUser: "owner",
      adminPass: "password",
      runnerToken: "runner",
    });
    client = createOrgOpsClient("http://engine", async (url, init) => {
      const r = await engine.app.fetch(new Request(url, init));
      if (lose === new URL(String(url)).pathname && init?.method === "POST") {
        lose = "";
        throw Error("Lost committed response");
      }
      return r;
    });
    settings = {
      modelId: "test-model",
      runnerId: "test-runner",
      workspaceRoot: join(dir, "personal"),
    };
    product = createApp({
      orgops: client,
      dbPath: join(dir, "product.sqlite"),
      personalAgent: settings,
    });
    const login = await call(
      "/api/auth/login",
      { username: "owner", password: "password" },
      { "content-type": "application/json" },
    );
    headers = {
      "content-type": "application/json",
      cookie: login.headers.getSetCookie()[0].split(";")[0],
    };
    await call("/api/models", {
      id: "test-model",
      provider: "openrouter",
      modelName: "test-only",
      enabled: true,
    });
    await call(
      "/api/runners/register",
      { existingRunnerId: "test-runner", displayName: "Test runner" },
      { "content-type": "application/json", "x-nest-runner-token": "runner" },
    );
  });
  afterEach(() => {
    product.store.close();
    engine.db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  it("requires a human and ignores injected runner credentials", async () => {
    expect((await call("/api/onboarding", undefined, {})).status).toBe(401);
    expect(
      (
        await call("/api/onboarding", undefined, {
          "x-nest-runner-token": "runner",
        })
      ).status,
    ).toBe(401);
    const state = await (await call()).json();
    expect(state).toMatchObject({
      setup: null,
      provisioningAvailable: true,
      connectionsAvailable: false,
      suggestedName: "PuffOwner",
    });
  });
  it("creates one private agent and owner conversation across concurrent retries and restarts", async () => {
    const results = await Promise.all([
      call("/api/onboarding/agent", input),
      call("/api/onboarding/agent", input),
    ]);
    expect(results.some((r) => r.ok)).toBe(true);
    const setup = await (await call("/api/onboarding/agent", input)).json();
    expect(setup.channelId).toBeTruthy();
    expect(setup.agentId).toBeTruthy();
    const agents = await (await call("/api/agents")).json();
    expect(agents.filter((a: any) => a.name === input.name)).toHaveLength(1);
    const a = await (await call("/api/agents/PuffOwner")).json();
    expect(a).toMatchObject({
      visibility: "PRIVATE",
      mode: "CLASSIC",
      modelId: "openrouter:test-only",
      assignedRunnerId: "test-runner",
      allowOutsideWorkspace: false,
      allowOwnerHumanSecrets: false,
    });
    const channels = await (await call("/api/channels")).json();
    expect(channels).toHaveLength(1);
    expect(channels[0]).toMatchObject({
      visibility: "PRIVATE",
      id: setup.channelId,
    });
    expect(channels[0].participants).toContainEqual({
      subscriberType: "AGENT",
      subscriberId: "PuffOwner",
    });
    const completed = await (await call("/api/onboarding/complete", {})).json();
    expect(completed.completedAt).toBeGreaterThan(0);
    product.store.close();
    product = createApp({
      orgops: client,
      dbPath: join(dir, "product.sqlite"),
      personalAgent: settings,
    });
    expect((await (await call()).json()).setup).toEqual(completed);
    expect(
      (await call("/api/onboarding/agent", { ...input, name: "SecondAgent" }))
        .status,
    ).toBe(409);
  });
  it("uses the common default for new onboarding instead of the legacy personal default", async () => {
    await call('/api/models',{id:'new-default',provider:'openrouter',modelName:'new-test',enabled:true});
    product.store.close();
    product = createApp({orgops:client, dbPath:join(dir,'product.sqlite'),personalAgent:settings,defaultAgentModelId:'new-default'});
    expect((await call('/api/onboarding/agent',input)).status).toBe(200);
    expect(await (await call('/api/agents/PuffOwner')).json()).toMatchObject({modelId:'openrouter:new-test'});
  });
  for (const path of ["/api/agents", "/api/channels"])
    it(`recovers after losing ${path} response`, async () => {
      lose = path;
      expect((await call("/api/onboarding/agent", input)).status).toBe(502);
      product.store.close();
      product = createApp({
        orgops: client,
        dbPath: join(dir, "product.sqlite"),
        personalAgent: settings,
        defaultAgentModelId: "later-unavailable-default",
      });
      expect((await call("/api/onboarding/agent", input)).status).toBe(200);
      expect(await (await call("/api/channels")).json()).toHaveLength(1);
      expect(await (await call("/api/agents")).json()).toHaveLength(1);
      expect(await (await call("/api/agents/PuffOwner")).json()).toMatchObject({modelId:"openrouter:test-only"});
    });
  it("does not overwrite existing agents or accept runtime configuration from the browser", async () => {
    expect(
      (
        await call("/api/onboarding/agent", {
          ...input,
          workspacePath: "/etc",
          ownerHumanId: "other",
        })
      ).status,
    ).toBe(400);
    await call("/api/agents", {
      name: "PuffOwner",
      modelId: "test-model",
      workspacePath: join(dir, "existing"),
    });
    expect((await call("/api/onboarding/agent", input)).status).toBe(409);
    expect((await (await call()).json()).setup).toBeNull();
  });
  it("does not report completed setup if the engine ownership changes", async () => {
    await call("/api/onboarding/agent", input);
    engine.db
      .prepare(
        "UPDATE agents SET owner_human_id=NULL,visibility='PUBLIC' WHERE name='PuffOwner'",
      )
      .run();
    expect((await call("/api/onboarding/complete", {})).status).toBe(409);
    expect((await (await call()).json()).problem).toContain("ownership");
  });
  it("refuses creation when the default model is disabled and does not reserve a broken setup", async () => {
    engine.db.prepare("UPDATE models SET enabled=0").run();
    expect((await call("/api/onboarding/agent", input)).status).toBe(503);
    expect((await (await call()).json()).setup).toBeNull();
  });
  it("keeps separate setup records for different humans", async () => {
    await call("/api/onboarding/agent", input);
    await call("/api/humans/invite", {
      username: "other",
      tempPassword: "password",
    });
    engine.db
      .prepare(
        "UPDATE humans SET must_change_password=0 WHERE username='other'",
      )
      .run();
    const login = await call(
      "/api/auth/login",
      { username: "other", password: "password" },
      { "content-type": "application/json" },
    );
    const other = {
      ...headers,
      cookie: login.headers.getSetCookie()[0].split(";")[0],
    };
    expect(
      (await (await call("/api/onboarding", undefined, other)).json()).setup,
    ).toBeNull();
    expect(
      (
        await call(
          "/api/onboarding/agent",
          { ...input, name: "PuffOther" },
          other,
        )
      ).status,
    ).toBe(200);
    expect(
      (await (await call("/api/onboarding", undefined, other)).json()).setup
        .name,
    ).toBe("PuffOther");
    expect((await (await call()).json()).setup.name).toBe("PuffOwner");
  });
});
