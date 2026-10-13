import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp as createEngine } from "../../../vendor/orgops/apps/api/src/app";
import { createOrgOpsClient } from "@nest/orgops-client";
import { createApp } from "./app";
import type { ConnectionProvider } from "./integrations/provider";

let dir: string,
  engine: ReturnType<typeof createEngine>,
  product: ReturnType<typeof createApp>,
  channel: string;
let owner: Record<string, string>,
  requester: Record<string, string>,
  other: Record<string, string>,
  loseDispatch = false;
const runner = {
  "content-type": "application/json",
  "x-orgops-runner-token": "runner",
};
const client = createOrgOpsClient("http://engine", async (url, init) => {
  const response = await engine.app.fetch(new Request(url, init));
  if (
    loseDispatch &&
    new URL(String(url)).pathname === "/api/events" &&
    init?.method === "POST"
  ) {
    loseDispatch = false;
    throw Error("Test: committed dispatch response lost");
  }
  return response;
});
const call = (path: string, h = owner, method = "GET", body?: unknown) =>
  product.app.request(path, {
    method,
    headers: h,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
async function signIn(username: string) {
  const response = await call(
    "/api/auth/login",
    { "content-type": "application/json" },
    "POST",
    { username, password: "password" },
  );
  expect(response.status).toBe(200);
  return {
    "content-type": "application/json",
    cookie: response.headers.getSetCookie()[0].split(";")[0],
  };
}
function open(connections: ConnectionProvider | null = null) {
  return createApp({
    orgops: client,
    connections,
    connectionEngineToken: "runner",
    dbPath: join(dir, "product.sqlite"),
    personalAgent: {
      modelId: "model",
      runnerId: "runner",
      workspaceRoot: join(dir, "personal"),
    },
  });
}
beforeEach(async () => {
  vi.stubEnv("ORGOPS_MASTER_KEY", Buffer.alloc(32, 171).toString("base64"));
  loseDispatch = false;
  dir = mkdtempSync(join(tmpdir(), "nest-assistant-requests-"));
  engine = createEngine({
    projectRoot: dir,
    dataDir: dir,
    dbPath: join(dir, "engine.sqlite"),
    adminUser: "naska",
    adminPass: "password",
    runnerToken: "runner",
  });
  product = open();
  owner = await signIn("naska");
  for (const username of ["vitaliy", "other"]) {
    expect(
      (
        await call("/api/humans/invite", owner, "POST", {
          username,
          tempPassword: "password",
        })
      ).ok,
    ).toBe(true);
    engine.db
      .prepare("UPDATE humans SET must_change_password=0 WHERE username=?")
      .run(username);
  }
  requester = await signIn("vitaliy");
  other = await signIn("other");
  await call("/api/models", owner, "POST", {
    id: "model",
    provider: "openrouter",
    modelName: "test-only",
    enabled: true,
  });
  await call(
    "/api/runners/register",
    { "content-type": "application/json", "x-nest-runner-token": "runner" },
    "POST",
    { existingRunnerId: "runner", displayName: "Test runner" },
  );
  const setup = await call("/api/onboarding/agent", owner, "POST", {
    name: "PuffNaska",
    character: "puff",
    brief: "Private system instructions",
  });
  expect(setup.status).toBe(200);
  channel = (await setup.json()).channelId;
});
afterEach(() => {
  product.store.close();
  engine.db.close();
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
async function publish(enabled = true) {
  const response = await call("/api/assistants/PuffNaska/offer", owner, "PUT", {
    enabled,
    description: "Help with project status on my Trello boards.",
  });
  expect(response.status).toBe(200);
}
async function create(id = randomUUID()) {
  const response = await call("/api/agent-requests", requester, "POST", {
    id,
    agentName: "PuffNaska",
    title: "Project status",
    brief: "Summarize the launch board, without personal information.",
  });
  expect(response.status).toBe(201);
  return response.json();
}
async function approve(id: string, version = 0) {
  return call(`/api/agent-requests/${id}/approve`, owner, "POST", { version });
}
async function events() {
  return (await (
    await call(`/api/events?channelId=${channel}&type=message.created`, owner)
  ).json()) as any[];
}
async function response(
  text = "Private raw agent result: SECRET",
  source = "agent:PuffNaska",
  channelId = channel,
) {
  const r = await engine.app.request("/api/events", {
    method: "POST",
    headers: runner,
    body: JSON.stringify({
      type: "message.created",
      source,
      channelId,
      payload: { text },
    }),
  });
  expect(r.status).toBe(201);
  return r.json();
}

it("requires explicit publication and exposes a product profile without private engine access", async () => {
  expect(
    (await (await call("/api/assistants", requester)).json()).items,
  ).toEqual([]);
  expect(
    (await call("/api/assistants/PuffNaska/offer", requester)).status,
  ).toBe(409);
  await publish();
  const directory = await (await call("/api/assistants", requester)).json();
  expect(directory.items).toEqual([
    {
      agentName: "PuffNaska",
      ownerName: "naska",
      description: "Help with project status on my Trello boards.",
      yours: false,
    },
  ]);
  expect(JSON.stringify(directory)).not.toContain(
    "Private system instructions",
  );
  expect((await call("/api/agents/PuffNaska", requester)).status).toBe(404);
  expect((await call("/api/assistants", {})).status).toBe(401);
  expect(
    (await call("/api/agent-requests", { "x-nest-runner-token": "runner" }))
      .status,
  ).toBe(401);
});
it("keeps guest prompts in the product inbox until approval and recovers creation retries", async () => {
  await publish();
  const row = await create();
  expect(row.status).toBe("pending");
  expect(row.reply).toBe(null);
  expect(await events()).toHaveLength(0);
  const retry = await call("/api/agent-requests", requester, "POST", {
    id: row.id,
    agentName: "PuffNaska",
    title: row.title,
    brief: row.brief,
  });
  expect(retry.status).toBe(200);
  expect(
    (
      await call("/api/agent-requests", requester, "POST", {
        id: row.id,
        agentName: "PuffNaska",
        title: row.title,
        brief: "Changed",
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await call("/api/agent-requests", requester, "POST", {
        id: randomUUID(),
        agentName: "PuffNaska",
        title: "Spoofed",
        brief: "x",
        ownerId: "fake",
      })
    ).status,
  ).toBe(400);
  expect((await call(`/api/agent-requests/${row.id}`, other)).status).toBe(404);
  expect(
    (await (await call("/api/agent-requests", other)).json()).items,
  ).toEqual([]);
  const duplicateId = randomUUID();
  const body = {
    id: duplicateId,
    agentName: "PuffNaska",
    title: "Concurrent request",
    brief: "One request only",
  };
  const concurrent = await Promise.all([
    call("/api/agent-requests", requester, "POST", body),
    call("/api/agent-requests", requester, "POST", body),
  ]);
  expect(concurrent.map((response) => response.status).sort()).toEqual([
    200, 201,
  ]);
});
it("dispatches only as the approving owner and shares only an explicitly approved edited reply", async () => {
  await publish();
  const row = await create();
  expect(
    (
      await call(`/api/agent-requests/${row.id}/approve`, requester, "POST", {
        version: 0,
      })
    ).status,
  ).toBe(404);
  const approved = await approve(row.id);
  expect(approved.status).toBe(200);
  const working = await approved.json();
  expect(working.status).toBe("working");
  const messages = await events();
  expect(messages).toHaveLength(1);
  expect(messages[0].source).toBe("human:naska");
  expect(messages[0].payload.targetAgentName).toBe("PuffNaska");
  expect(messages[0].payload.nestAgentRequestId).toBe(row.id);
  expect(
    await (await call(`/api/events?channelId=${channel}`, requester)).json(),
  ).toEqual([]);
  const raw = await response();
  expect(
    (await call(`/api/agent-requests/${row.id}/responses`, requester)).status,
  ).toBe(404);
  const responses = await (
    await call(`/api/agent-requests/${row.id}/responses`, owner)
  ).json();
  expect(responses[0].text).toContain("SECRET");
  const before = await (
    await call(`/api/agent-requests/${row.id}`, requester)
  ).json();
  expect(JSON.stringify(before)).not.toContain("SECRET");
  expect(before.reply).toBe(null);
  for (const key of [
    "channel_id",
    "channelId",
    "response_event_id",
    "eventId",
    "agent_id",
  ])
    expect(before).not.toHaveProperty(key);
  const reply = {
    version: working.version,
    eventId: raw.id,
    reply: "Launch is on track.",
  };
  expect(
    (
      await call(
        `/api/agent-requests/${row.id}/reply`,
        requester,
        "POST",
        reply,
      )
    ).status,
  ).toBe(404);
  const released = await call(
    `/api/agent-requests/${row.id}/reply`,
    owner,
    "POST",
    reply,
  );
  expect(released.status).toBe(200);
  const visible = await (
    await call(`/api/agent-requests/${row.id}`, requester)
  ).json();
  expect(visible.status).toBe("completed");
  expect(visible.reply).toBe("Launch is on track.");
  expect(JSON.stringify(visible)).not.toContain("SECRET");
  expect(
    (await call(`/api/agent-requests/${row.id}/reply`, owner, "POST", reply))
      .status,
  ).toBe(200);
  expect(
    (
      await call(`/api/agent-requests/${row.id}/reply`, owner, "POST", {
        ...reply,
        reply: "Different",
      })
    ).status,
  ).toBe(409);
  const audit = JSON.stringify(
    product.store.db.prepare("SELECT * FROM product_audit").all(),
  );
  expect(audit).not.toContain("SECRET");
  expect(audit).not.toContain(row.brief);
});
it("requires a response from the intended private agent and preserves guest isolation", async () => {
  const old = await response();
  await publish();
  const row = await create(),
    working = await (await approve(row.id)).json();
  const wrong = await response("Unrelated", "human:naska");
  for (const eventId of [old.id, wrong.id])
    expect(
      (
        await call(`/api/agent-requests/${row.id}/reply`, owner, "POST", {
          version: working.version,
          eventId,
          reply: "Wrong reply",
        })
      ).status,
    ).toBe(400);
  const personal = (await (await call("/api/channels", owner)).json()).find(
    (c: any) => c.id === channel,
  );
  expect(personal.participants.map((p: any) => p.subscriberId).sort()).toEqual([
    "PuffNaska",
    "naska",
  ]);
});
it("secures the runner lifecycle channel without adding a guest subscription", async () => {
  const created = await engine.app.request("/api/channels", {
    method: "POST",
    headers: runner,
    body: JSON.stringify({
      name: "agent.lifecycle.PuffNaska",
      description: "Lifecycle bootstrap channel for PuffNaska",
      kind: "GROUP",
    }),
  });
  const id = (await created.json()).id;
  await engine.app.request(`/api/channels/${id}/subscribe`, {
    method: "POST",
    headers: runner,
    body: JSON.stringify({
      subscriberType: "AGENT",
      subscriberId: "PuffNaska",
    }),
  });
  await publish();
  const row = await create();
  expect((await approve(row.id)).status).toBe(200);
  const channel = (await (await call("/api/channels")).json()).find(
    (ch: any) => ch.id === id,
  );
  expect(channel.visibility).toBe("PRIVATE");
  expect(channel.participants).toEqual([
    { subscriberType: "AGENT", subscriberId: "PuffNaska" },
  ]);
});
it("fails closed on shared context and hides publications when engine identity changes", async () => {
  await publish();
  const row = await create();
  await call(`/api/channels/${channel}/subscribe`, owner, "POST", {
    subscriberType: "HUMAN",
    subscriberId: "vitaliy",
  });
  expect((await approve(row.id)).status).toBe(403);
  expect(await events()).toHaveLength(0);
  await call(`/api/channels/${channel}/unsubscribe`, owner, "POST", {
    subscriberType: "HUMAN",
    subscriberId: "vitaliy",
  });
  await call("/api/agents/PuffNaska", owner, "PATCH", { visibility: "PUBLIC" });
  expect(
    (await (await call("/api/assistants", requester)).json()).items,
  ).toEqual([]);
  expect((await approve(row.id)).status).toBe(403);
});
it("recovers an ambiguous dispatch after restart without duplicate engine work", async () => {
  await publish();
  const row = await create();
  loseDispatch = true;
  expect((await approve(row.id)).status).toBe(502);
  expect(await events()).toHaveLength(1);
  product.store.close();
  product = open();
  expect((await approve(row.id)).status).toBe(200);
  expect(await events()).toHaveLength(1);
  expect((await approve(row.id)).status).toBe(200);
  expect(await events()).toHaveLength(1);
});
it("allows cancellation or decline before approval and stops new requests on unpublish", async () => {
  await publish();
  const row = await create();
  expect(
    (
      await call(`/api/agent-requests/${row.id}/cancel`, other, "POST", {
        version: 0,
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await call(`/api/agent-requests/${row.id}/cancel`, requester, "POST", {
        version: 0,
      })
    ).status,
  ).toBe(200);
  expect((await approve(row.id)).status).toBe(409);
  const next = await create();
  expect(
    (
      await call(`/api/agent-requests/${next.id}/decline`, owner, "POST", {
        version: 0,
        feedback: "Please ask about the launch board only.",
      })
    ).status,
  ).toBe(200);
  expect(
    (await (await call(`/api/agent-requests/${next.id}`, requester)).json())
      .feedback,
  ).toBe("Please ask about the launch board only.");
  await publish(false);
  expect(
    (
      await call("/api/agent-requests", requester, "POST", {
        id: randomUUID(),
        agentName: "PuffNaska",
        title: "More",
        brief: "More",
      })
    ).status,
  ).toBe(404);
});
it("uses durable version checks for competing decisions and paginates participant-only inboxes", async () => {
  await publish();
  const row = await create();
  const decisions = await Promise.all([
    approve(row.id),
    call(`/api/agent-requests/${row.id}/cancel`, requester, "POST", {
      version: 0,
    }),
  ]);
  expect(decisions.map((r) => r.status).sort()).toEqual([200, 409]);
  expect((await events()).length).toBeLessThanOrEqual(1);
  await create();
  const page = await (
    await call("/api/agent-requests?limit=1", requester)
  ).json();
  expect(page.items).toHaveLength(1);
  expect(page.hasMore).toBe(true);
  expect(
    (await (await call("/api/agent-requests?direction=outgoing", owner)).json())
      .items,
  ).toEqual([]);
  expect(
    (
      await (
        await call("/api/agent-requests?direction=incoming", requester)
      ).json()
    ).items,
  ).toEqual([]);
  expect((await call("/api/agent-requests?limit=101", requester)).status).toBe(
    400,
  );
});

it("keeps approved work on the owner's connected account without exposing its result to the requester", async () => {
  const ownerId = (await (await call("/api/auth/me")).json()).id;
  const account = {
    id: "test-trello-account",
    subject: "test:" + ownerId,
    toolkit: "trello",
    status: "ACTIVE",
    disabled: false,
    shared: false,
  };
  let executions = 0;
  const tool = {
    slug: "TRELLO_GET_BOARDS",
    name: "List boards",
    description: "Demo",
    toolkit: "trello",
    inputParameters: { type: "object" },
  };
  const provider: ConnectionProvider = {
    id: "test-provider",
    subject: (id) => "test:" + id,
    apps: async () => ({ items: [], nextCursor: null }),
    accounts: async () => ({ items: [account], nextCursor: null }),
    account: async () => account,
    link: async () => ({ redirectUrl: "https://example.test/authorize" }),
    revoke: async () => {},
    tools: async () => ({ items: [tool], nextCursor: null }),
    tool: async () => tool,
    execute: async (connected, slug, args) => {
      expect(connected.subject).toBe("test:" + ownerId);
      expect(slug).toBe(tool.slug);
      expect(args).toEqual({ board: "launch" });
      executions++;
      return { text: "PRIVATE-CONNECTED-RESULT" };
    },
  };
  product.store.close();
  product = open(provider);
  const connections = await (
    await call("/api/integrations/connections")
  ).json();
  expect(
    (
      await call(
        `/api/integrations/agents/PuffNaska/grants/${connections.items[0].id}`,
        owner,
        "PUT",
        { tools: [tool.slug] },
      )
    ).status,
  ).toBe(200);
  expect(
    (await call("/api/integrations/agents/PuffNaska/skill", owner, "POST", {}))
      .status,
  ).toBe(200);
  const envResponse = await engine.app.request("/api/secrets/env", {
    headers: {
      "x-orgops-runner-token": "runner",
      "x-orgops-agent-name": "PuffNaska",
      "x-orgops-channel-id": channel,
    },
  });
  const env = await envResponse.json();
  const token = env.NEST_CONNECTION_TOKEN ?? env.env?.NEST_CONNECTION_TOKEN;
  expect(token).toMatch(/^nest_connection_/);
  await publish();
  const row = await create();
  expect(executions).toBe(0);
  expect((await approve(row.id)).status).toBe(200);
  const work = await call(
    "/api/integrations/skill/execute",
    { "content-type": "application/json", authorization: "Bearer " + token },
    "POST",
    {
      connectionId: connections.items[0].id,
      tool: tool.slug,
      arguments: { board: "launch" },
    },
  );
  expect(work.status).toBe(200);
  expect(executions).toBe(1);
  const raw = await response((await work.json()).text);
  const privateBefore = await (
    await call(`/api/agent-requests/${row.id}`, requester)
  ).text();
  expect(privateBefore).not.toContain("PRIVATE-CONNECTED-RESULT");
  const state = await (
    await call(`/api/agent-requests/${row.id}`, owner)
  ).json();
  expect(
    (
      await call(`/api/agent-requests/${row.id}/reply`, owner, "POST", {
        version: state.version,
        eventId: raw.id,
        reply: "Launch board is ready.",
      })
    ).status,
  ).toBe(200);
  const approved = await (
    await call(`/api/agent-requests/${row.id}`, requester)
  ).text();
  expect(approved).toContain("Launch board is ready.");
  expect(approved).not.toContain("PRIVATE-CONNECTED-RESULT");
  expect(approved).not.toContain(token);
});

it("rechecks privacy before listing private responses or releasing an answer", async () => {
  await publish();
  const row = await create();
  const working = await (await approve(row.id)).json();
  const raw = await response();
  await call(`/api/channels/${channel}/subscribe`, owner, "POST", {
    subscriberType: "HUMAN",
    subscriberId: "vitaliy",
  });
  expect(
    (await call(`/api/agent-requests/${row.id}/responses`, owner)).status,
  ).toBe(403);
  expect(
    (
      await call(`/api/agent-requests/${row.id}/reply`, owner, "POST", {
        version: working.version,
        eventId: raw.id,
        reply: "Do not release",
      })
    ).status,
  ).toBe(403);
  expect(
    (await (await call(`/api/agent-requests/${row.id}`, requester)).json())
      .reply,
  ).toBe(null);
});
