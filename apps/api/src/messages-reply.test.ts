import { beforeEach, afterEach, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createApp as createEngine } from "../../../vendor/orgops/apps/api/src/app";
import { createOrgOpsClient } from "@nest/orgops-client";
import { createApp } from "./app";
import { SendMessageSchema } from "@nest/schemas";
let dir: string,
  engine: ReturnType<typeof createEngine>,
  product: ReturnType<typeof createApp>,
  headers: Record<string, string>,
  other: Record<string, string>,
  channel: string,
  client: ReturnType<typeof createOrgOpsClient>,
  lose = false;
const call = (path: string, method = "GET", body?: unknown, h = headers) =>
  product.app.request(path, {
    method,
    headers: h,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const mentions = (text: string, names: [string, "AGENT" | "HUMAN"][]) =>
  names.map(([name, kind]) => ({
    name,
    kind,
    start: text.indexOf("@" + name),
    end: text.indexOf("@" + name) + name.length + 1,
  }));
const message = (
  text = "@Puff @teammate please review",
  names: [string, "AGENT" | "HUMAN"][] = [
    ["Puff", "AGENT"],
    ["teammate", "HUMAN"],
  ],
) => ({
  id: randomUUID(),
  channelId: channel,
  text,
  mentions: mentions(text, names),
});
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "nest-message-reply-"));
  lose = false;
  engine = createEngine({
    dbPath: join(dir, "engine.sqlite"),
    projectRoot: dir,
    dataDir: dir,
    adminUser: "owner",
    adminPass: "password",
    runnerToken: "runner",
  });
  client = createOrgOpsClient("http://engine", async (url, init) => {
    const r = await engine.app.fetch(new Request(url, init));
    if (
      lose &&
      new URL(String(url)).pathname === "/api/events" &&
      init?.method === "POST"
    ) {
      lose = false;
      throw Error("Lost committed response");
    }
    return r;
  });
  product = createApp({
    orgops: client,
    dbPath: join(dir, "product.sqlite"),
    connections: null,
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
  await call("/api/humans/invite", "POST", {
    username: "teammate",
    tempPassword: "password",
  });
  engine.db
    .prepare(
      "UPDATE humans SET must_change_password=0 WHERE username='teammate'",
    )
    .run();
  const signIn = await call("/api/auth/login", "POST", {
    username: "teammate",
    password: "password",
  });
  other = {
    ...headers,
    cookie: signIn.headers.getSetCookie()[0].split(";")[0],
  };
  for (const name of ["Puff", "Moss", "Outsider"])
    expect(
      (
        await call("/api/agents", "POST", {
          name,
          modelId: "openrouter:test",
          workspacePath: join(dir, name),
        })
      ).status,
    ).toBe(201);
  const chat = await call("/api/channels", "POST", {
    name: "planning",
    visibility: "PRIVATE",
  });
  expect(chat.status).toBe(201);
  channel = (await chat.json()).id;
  for (const [subscriberType, subscriberId] of [
    ["AGENT", "Puff"],
    ["AGENT", "Moss"],
    ["HUMAN", "teammate"],
  ])
    expect(
      (
        await call("/api/channels/" + channel + "/subscribe", "POST", {
          subscriberType,
          subscriberId,
        })
      ).ok,
    ).toBe(true);
});
afterEach(() => {
  product.store.close();
  engine.db.close();
  rmSync(dir, { recursive: true, force: true });
});
const send = async (body: unknown, h = headers) => {
  const response = await call("/api/messages", "POST", body, h);
  return { status: response.status, body: await response.json() };
};
const plain = (text = "context for a reply", channelId = channel) => ({
  id: randomUUID(),
  channelId,
  text,
});
async function posted(channelId = channel, h = headers) {
  const result = await send(plain("original message", channelId), h);
  expect(result.status).toBe(201);
  return result.body.id as string;
}
async function createChannel(name: string, members: string[] = []) {
  const created = await call("/api/channels", "POST", {
    name,
    visibility: "PRIVATE",
  });
  expect(created.status).toBe(201);
  const id = (await created.json()).id as string;
  for (const subscriberId of members)
    expect(
      (
        await call("/api/channels/" + id + "/subscribe", "POST", {
          subscriberType: "HUMAN",
          subscriberId,
        })
      ).ok,
    ).toBe(true);
  return id;
}
const engineRow = (id: string) =>
  engine.db.prepare("SELECT * FROM events WHERE id=?").get(id) as
    | Record<string, unknown>
    | undefined;
const expectInvalid = (result: { status: number; body: any }) => {
  expect(result.status).toBe(400);
  expect(result.body.code).toBe("REPLY_TARGET_INVALID");
  expect(typeof result.body.error).toBe("string");
};
it("records a reply to a message in the same channel as payload.inReplyTo without a parent", async () => {
  const target = await posted();
  const result = await send({ ...plain("my reply"), replyTo: target });
  expect(result.status).toBe(201);
  expect(result.body.payload.inReplyTo).toBe(target);
  expect(result.body.payload).not.toHaveProperty("parentEventId");
  expect(result.body.parentEventId ?? undefined).toBeUndefined();
  const stored = await (await call("/api/events/" + result.body.id)).json();
  expect(stored.payload.inReplyTo).toBe(target);
  expect(stored.payload).not.toHaveProperty("parentEventId");
  expect(stored.parentEventId ?? undefined).toBeUndefined();
  expect(engineRow(result.body.id)?.parent_event_id ?? null).toBeNull();
  // A reply adds no targeting: no agent is selected by replying.
  expect(result.body.payload).not.toHaveProperty("targetAgentName");
  expect(result.body.payload).not.toHaveProperty("targetAgentNames");
});
it("keeps a send without replyTo free of inReplyTo", async () => {
  const result = await send(plain());
  expect(result.status).toBe(201);
  expect(result.body.payload).not.toHaveProperty("inReplyTo");
});
it("rejects a reply target in another channel the sender can view", async () => {
  const elsewhere = await createChannel("elsewhere");
  const target = await posted(elsewhere);
  const input = { ...plain("my reply"), replyTo: target };
  expectInvalid(await send(input));
  // A rejected send records no intent: the same id with a valid target then succeeds.
  const valid = await posted();
  expect((await send({ ...input, replyTo: valid })).status).toBe(201);
});
it("rejects a reply target that is not a message", async () => {
  const started = await engine.app.request("http://engine/api/events", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-orgops-runner-token": "runner",
    },
    body: JSON.stringify({
      type: "agent.turn.started",
      channelId: channel,
      source: "agent:Puff",
      payload: { triggerEventId: await posted() },
    }),
  });
  expect(started.status).toBe(201);
  const turn = await started.json();
  expect(turn.type).toBe("agent.turn.started");
  expect(turn.channelId).toBe(channel);
  expectInvalid(await send({ ...plain("my reply"), replyTo: turn.id }));
});
it("rejects a missing reply target", async () => {
  expectInvalid(await send({ ...plain("my reply"), replyTo: randomUUID() }));
});
it("rejects a reply target in a channel the sender cannot view", async () => {
  const hidden = await createChannel("owners-only");
  const target = await posted(hidden);
  const shared = await createChannel("shared", ["teammate"]);
  const viewable = await send(
    { ...plain("teammate reply", shared), replyTo: target },
    other,
  );
  expectInvalid(viewable);
  // Same channel id as the hidden target, from someone who cannot view it: the post check answers first.
  expect(
    (await send({ ...plain("teammate reply", hidden), replyTo: target }, other))
      .status,
  ).toBe(403);
  // The owner can still reply to it in that channel.
  expect(
    (await send({ ...plain("owner reply", hidden), replyTo: target })).status,
  ).toBe(201);
});
it("answers an unchanged retry with the recorded result after the target was deleted", async () => {
  const target = await posted();
  const input = { ...plain("my reply"), replyTo: target };
  const first = await send(input);
  expect(first.status).toBe(201);
  engine.db.prepare("DELETE FROM events WHERE id=?").run(target);
  expect(engineRow(target)).toBeUndefined();
  const retry = await send(input);
  expect(retry.status).toBe(first.status);
  expect(retry.body.id).toBe(first.body.id);
  expect(retry.body.payload.inReplyTo).toBe(target);
  // A fresh send to the deleted target is now rejected.
  expectInvalid(await send({ ...plain("another reply"), replyTo: target }));
});
it("rejects the same request id with a different replyTo as 409", async () => {
  const one = await posted();
  const two = await posted();
  const input = { ...plain("my reply"), replyTo: one };
  expect((await send(input)).status).toBe(201);
  const changed = await send({ ...input, replyTo: two });
  expect(changed.status).toBe(409);
  const dropped = await send({ ...input, replyTo: undefined });
  expect(dropped.status).toBe(409);
});
it("accepts replyTo as an optional string of 1 to 200 characters", () => {
  const base = { id: randomUUID(), channelId: "room", text: "hello" };
  expect(SendMessageSchema.safeParse(base).success).toBe(true);
  expect(SendMessageSchema.safeParse(base).data).not.toHaveProperty("replyTo");
  expect(SendMessageSchema.safeParse({ ...base, replyTo: "x" }).success).toBe(true);
  expect(
    SendMessageSchema.safeParse({ ...base, replyTo: "x".repeat(200) }).success,
  ).toBe(true);
  expect(SendMessageSchema.safeParse({ ...base, replyTo: "" }).success).toBe(false);
  expect(
    SendMessageSchema.safeParse({ ...base, replyTo: "x".repeat(201) }).success,
  ).toBe(false);
  expect(SendMessageSchema.safeParse({ ...base, replyTo: 7 }).success).toBe(false);
});
