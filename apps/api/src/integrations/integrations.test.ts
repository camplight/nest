import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp as createEngine } from "../../../../vendor/orgops/apps/api/src/app";
import { createOrgOpsClient } from "@nest/orgops-client";
import { createApp } from "../app";
import { createComposioProvider } from "./composio";
let dir: string,
  engine: ReturnType<typeof createEngine>,
  product: ReturnType<typeof createApp>,
  headers: Record<string, string>,
  subject: string,
  channel: string,
  localId: string;
let executionCount = 0,
  shared = false,
  foreign = false,
  disabled = false,
  failExecute = false;
const requests: { path: string; body: any }[] = [];
const call = (path: string, method = "GET", body?: unknown, h = headers) =>
  product.app.request(path, {
    method,
    headers: h,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const account = () => ({
  id: "provider-account",
  user_id: foreign ? "foreign" : subject,
  toolkit: { slug: "trello" },
  status: "ACTIVE",
  is_disabled: disabled,
  experimental: { account_type: shared ? "SHARED" : "PRIVATE" },
});
beforeEach(async () => {
  vi.stubEnv("ORGOPS_MASTER_KEY", Buffer.alloc(32, 171).toString("base64"));
  dir = mkdtempSync(join(tmpdir(), "nest-connections-"));
  executionCount = 0;
  shared = false;
  foreign = false;
  disabled = false;
  failExecute = false;
  requests.length = 0;
  engine = createEngine({
    projectRoot: dir,
    dataDir: dir,
    dbPath: join(dir, "engine.sqlite"),
    adminUser: "owner",
    adminPass: "password",
    runnerToken: "runner",
  });
  const provider = createComposioProvider({
    apiKey: "secret-service-key",
    instanceId: "test",
    callbackUrl: "https://nest.example/onboarding",
    authConfigs: { trello: "auth-config" },
    fetch: async (url, init) => {
      const u = new URL(String(url)),
        path = u.pathname.replace("/api/v3.1", ""),
        body = init?.body ? JSON.parse(String(init.body)) : undefined;
      requests.push({ path, body });
      expect(u.origin).toBe("https://backend.composio.dev");
      expect(new Headers(init?.headers).get("x-api-key")).toBe(
        "secret-service-key",
      );
      expect(init?.redirect).toBe("error");
      if (path === "/connected_accounts")
        return Response.json({
          items: [
            account(),
            { ...account(), id: "foreign-account", user_id: "foreign" },
          ],
        });
      if (path === "/connected_accounts/provider-account")
        return Response.json(account());
      if (path === "/connected_accounts/link")
        return Response.json({
          redirect_url: "https://connect.composio.dev/fixture",
        });
      if (path.endsWith("/revoke")) return Response.json({ ok: true });
      if (path === "/tools/TRELLO_GET_BOARDS")
        return Response.json({
          slug: "TRELLO_GET_BOARDS",
          toolkit: { slug: "trello" },
          input_parameters: { type: "object" },
        });
      if (path === "/tools/OTHER_TOOL")
        return Response.json({
          slug: "OTHER_TOOL",
          toolkit: { slug: "slack" },
        });
      if (path === "/tools/execute/TRELLO_GET_BOARDS") {
        executionCount++;
        return Response.json(
          failExecute
            ? { error: "secret-provider-detail" }
            : { data: { boards: ["private-result"] } },
          { status: failExecute ? 500 : 200 },
        );
      }
      throw Error("Unexpected provider request " + path);
    },
  });
  const client = createOrgOpsClient("http://engine", async (url, init) => {
    expect(new URL(String(url)).pathname.startsWith("/api/composio")).toBe(
      false,
    );
    return engine.app.fetch(new Request(url, init));
  });
  product = createApp({
    orgops: client,
    connections: provider,
    connectionEngineToken: "runner",
    dbPath: join(dir, "product.sqlite"),
    personalAgent: {
      modelId: "model",
      runnerId: "runner",
      workspaceRoot: join(dir, "personal"),
    },
  });
  const login = await call(
    "/api/auth/login",
    "POST",
    { username: "owner", password: "password" },
    { "content-type": "application/json" },
  );
  headers = {
    "content-type": "application/json",
    cookie: login.headers.getSetCookie()[0].split(";")[0],
  };
  const me = await (await call("/api/auth/me")).json();
  subject = provider.subject(me.id);
  await call("/api/models", "POST", {
    id: "model",
    provider: "openrouter",
    modelName: "test-only",
    enabled: true,
  });
  await call(
    "/api/runners/register",
    "POST",
    { existingRunnerId: "runner", displayName: "Test" },
    { "content-type": "application/json", "x-nest-runner-token": "runner" },
  );
  const setup = await call("/api/onboarding/agent", "POST", {
    name: "PuffOwner",
    character: "puff",
    brief: "Test",
  });
  expect(setup.status).toBe(200);
  channel = (await setup.json()).channelId;
  const list = await (await call("/api/integrations/connections")).json();
  expect(list.items).toHaveLength(1);
  localId = list.items[0].id;
});
afterEach(() => {
  product.store.close();
  engine.db.close();
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
async function enable() {
  expect(
    (
      await call(
        "/api/integrations/agents/PuffOwner/grants/" + localId,
        "PUT",
        { tools: ["TRELLO_GET_BOARDS"] },
      )
    ).status,
  ).toBe(200);
  const enabled = await call(
    "/api/integrations/agents/PuffOwner/skill",
    "POST",
    {},
  );
  expect(enabled.status).toBe(200);
  expect(await enabled.text()).not.toContain("nest_connection_");
  const secrets = await engine.app.request("/api/secrets/env", {
    headers: {
      "x-orgops-runner-token": "runner",
      "x-orgops-agent-name": "PuffOwner",
      "x-orgops-channel-id": channel,
    },
  });
  expect(secrets.status).toBe(200);
  const env = await secrets.json();
  const token = env.NEST_CONNECTION_TOKEN ?? env.env?.NEST_CONNECTION_TOKEN;
  expect(token).toMatch(/^nest_connection_/);
  return {
    "content-type": "application/json",
    authorization: "Bearer " + token,
  };
}
const execute = (
  h: Record<string, string>,
  args = { board: "private-argument" },
) =>
  call(
    "/api/integrations/skill/execute",
    "POST",
    { connectionId: localId, tool: "TRELLO_GET_BOARDS", arguments: args },
    h,
  );
it("keeps user sessions, provider account IDs and agent credentials separate", async () => {
  expect(
    (await call("/api/integrations/config", "GET", undefined, {})).status,
  ).toBe(401);
  expect(
    (
      await call("/api/integrations/config", "GET", undefined, {
        "x-nest-runner-token": "runner",
      })
    ).status,
  ).toBe(401);
  expect((await call("/api/composio/config")).status).toBe(410);
  expect(localId).not.toBe("provider-account");
  const linked = await call("/api/integrations/connections/link", "POST", {
    toolkit: "trello",
  });
  expect(linked.status).toBe(201);
  expect(requests.at(-1)?.body).toEqual({
    auth_config_id: "auth-config",
    user_id: subject,
    callback_url: "https://nest.example/onboarding",
  });
  const h = await enable();
  expect(
    (await call("/api/integrations/connections", "GET", undefined, h)).status,
  ).toBe(403);
  expect(
    (await call("/api/integrations/skill/tools", "GET", undefined, headers))
      .status,
  ).toBe(403);
  const result = await execute(h);
  expect(result.status).toBe(200);
  expect(executionCount).toBe(1);
  expect(requests.at(-1)?.body).toEqual({
    user_id: subject,
    connected_account_id: "provider-account",
    arguments: { board: "private-argument" },
  });
  const audit = JSON.stringify(
    product.store.db.prepare("SELECT * FROM product_audit").all(),
  );
  for (const value of [
    "secret-service-key",
    "nest_connection_",
    "private-argument",
    "private-result",
  ])
    expect(audit).not.toContain(value);
  const row = product.store.db
    .prepare("SELECT * FROM product_connection_tokens")
    .get() as any;
  expect(row.token_hash).toHaveLength(64);
  expect(JSON.stringify(row)).not.toContain(h.authorization.slice(7));
});
it("validates exact grants, cross-toolkit tools, provider ownership and revocation", async () => {
  expect(
    (
      await call(
        "/api/integrations/agents/PuffOwner/grants/" + localId,
        "PUT",
        { tools: ["OTHER_TOOL"] },
      )
    ).status,
  ).toBe(400);
  const h = await enable();
  for (const flag of ["shared", "foreign", "disabled"]) {
    shared = flag === "shared";
    foreign = flag === "foreign";
    disabled = flag === "disabled";
    expect((await execute(h)).ok).toBe(false);
  }
  shared = foreign = disabled = false;
  expect(executionCount).toBe(0);
  expect(
    (
      await call(
        "/api/integrations/agents/PuffOwner/grants/" + localId,
        "DELETE",
      )
    ).status,
  ).toBe(200);
  expect((await execute(h)).status).toBe(403);
  await call("/api/integrations/agents/PuffOwner/grants/" + localId, "PUT", {
    tools: ["TRELLO_GET_BOARDS"],
  });
  await call(
    "/api/integrations/connections/" + localId + "/revoke",
    "POST",
    {},
  );
  expect((await execute(h)).status).toBe(403);
});
it("denies changed ownership and additional conversations, including archived chats", async () => {
  const h = await enable();
  const extra = await call("/api/channels", "POST", {
    name: "extra",
    visibility: "PRIVATE",
  });
  expect(extra.status).toBe(201);
  const id = (await extra.json()).id;
  const subscribed = await call("/api/channels/" + id + "/subscribe", "POST", {
    subscriberType: "AGENT",
    subscriberId: "PuffOwner",
  });
  expect(subscribed.ok).toBe(true);
  expect((await execute(h)).status).toBe(403);
  expect(executionCount).toBe(0);
  expect((await call("/api/channels/" + id + "/archive", "POST", {})).ok).toBe(
    true,
  );
  expect((await execute(h)).status).toBe(403);
  engine.db
    .prepare("UPDATE agents SET owner_human_id=NULL WHERE name='PuffOwner'")
    .run();
  expect((await execute(h)).status).toBe(403);
});
it("expires, renews and revokes credentials; never retries ambiguous execution failures", async () => {
  const h = await enable();
  failExecute = true;
  const r = await execute(h);
  expect(r.status).toBe(502);
  expect(await r.text()).not.toContain("secret-provider-detail");
  expect(executionCount).toBe(1);
  const renewed = await enable();
  expect((await execute(h)).status).toBe(401);
  product.store.db
    .prepare("UPDATE product_connection_tokens SET expires_at=0")
    .run();
  expect((await execute(renewed)).status).toBe(401);
  const fresh = await enable();
  await call("/api/integrations/agents/PuffOwner/skill", "DELETE");
  expect((await execute(fresh)).status).toBe(401);
});

it("denies other humans management and denies skill access once the private chat is shared", async () => {
  const tokenHeaders = await enable();
  await call("/api/humans/invite", "POST", {
    username: "other",
    tempPassword: "password",
  });
  engine.db
    .prepare("UPDATE humans SET must_change_password=0 WHERE username='other'")
    .run();
  const login = await call(
    "/api/auth/login",
    "POST",
    { username: "other", password: "password" },
    { "content-type": "application/json" },
  );
  const other = {
    ...headers,
    cookie: login.headers.getSetCookie()[0].split(";")[0],
  };
  expect(
    (await call("/api/integrations/agents/PuffOwner/skill", "POST", {}, other))
      .status,
  ).toBe(403);
  expect(
    (
      await call(
        "/api/integrations/connections/" + localId + "/revoke",
        "POST",
        {},
        other,
      )
    ).status,
  ).toBe(404);
  expect(
    (
      await call(
        "/api/integrations/agents/PuffOwner/grants/" + localId,
        "PUT",
        { tools: ["TRELLO_GET_BOARDS"] },
        other,
      )
    ).status,
  ).toBe(403);
  const share = await (
    await call("/api/channels/" + channel + "/share-link", "POST", {})
  ).json();
  expect(
    (
      await call(
        "/api/channel-share-links/" + share.token + "/claim",
        "POST",
        {},
        other,
      )
    ).ok,
  ).toBe(true);
  expect((await execute(tokenHeaders)).status).toBe(403);
  expect(executionCount).toBe(0);
});
it("rejects simultaneous credential changes rather than installing a revoked token", async () => {
  const results = await Promise.all([
    call("/api/integrations/agents/PuffOwner/skill", "POST", {}),
    call("/api/integrations/agents/PuffOwner/skill", "POST", {}),
  ]);
  expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
  expect(
    (
      product.store.db
        .prepare(
          "SELECT COUNT(*) n FROM product_connection_tokens WHERE revoked_at IS NULL",
        )
        .get() as any
    ).n,
  ).toBe(1);
});
it("denies tampered execution bodies and reports an enabled Nest adapter independently of core", async () => {
  expect(await (await call("/api/integrations/config")).json()).toEqual({
    configured: true,
    skillAvailable: true,
  });
  expect(await (await call("/api/onboarding/connections")).json()).toEqual({
    available: true,
  });
  const h = await enable();
  for (const input of [
    {
      connectionId: localId,
      tool: "TRELLO_GET_BOARDS",
      arguments: {},
      user_id: "other",
    },
    {
      connectionId: "provider-account",
      tool: "TRELLO_GET_BOARDS",
      arguments: {},
    },
    { connectionId: localId, tool: "OTHER_TOOL", arguments: {} },
  ])
    expect(
      (await call("/api/integrations/skill/execute", "POST", input, h)).ok,
    ).toBe(false);
  expect(executionCount).toBe(0);
  const schema = await call(
    "/api/integrations/skill/schema",
    "POST",
    { connectionId: localId, tool: "TRELLO_GET_BOARDS" },
    h,
  );
  expect(schema.status).toBe(200);
  expect((await schema.json()).inputParameters).toEqual({ type: "object" });
});
