import { beforeEach, afterEach, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createApp as createEngine } from "../../../vendor/orgops/apps/api/src/app";
import { shouldHandleEventForAgent } from "../../../vendor/orgops/apps/agent-runner/src/event-routing";
import { createOrgOpsClient } from "@nest/orgops-client";
import { createApp } from "./app";
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
  dir = mkdtempSync(join(tmpdir(), "nest-message-"));
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
it("sends one targeted event through real engine routing and notifies only selected people", async () => {
  const response = await call("/api/messages", "POST", message());
  expect(response.status).toBe(201);
  const event = await response.json();
  expect(event.payload.targetAgentName).toBe("Puff");
  expect(event.source).toBe("human:owner");
  expect(shouldHandleEventForAgent({ name: "Puff" } as any, event)).toBe(true);
  expect(shouldHandleEventForAgent({ name: "Moss" } as any, event)).toBe(false);
  const mine = await (await call("/api/mentions")).json();
  expect(mine.items).toEqual([]);
  const inbox = await (
    await call("/api/mentions", "GET", undefined, other)
  ).json();
  expect(inbox.items).toHaveLength(1);
  expect(inbox.items[0]).toMatchObject({
    id: event.id,
    channelId: channel,
    readAt: null,
    text: "@Puff @teammate please review",
  });
  expect(
    (
      await call(
        "/api/mentions/" + event.id + "/read",
        "POST",
        undefined,
        headers,
      )
    ).status,
  ).toBe(404);
  expect(
    (
      await call(
        "/api/mentions/" + event.id + "/read",
        "POST",
        undefined,
        other,
      )
    ).status,
  ).toBe(200);
  expect(
    (await (await call("/api/mentions", "GET", undefined, other)).json())
      .items[0].readAt,
  ).toBeGreaterThan(0);
  expect(
    JSON.stringify(
      product.store.db.prepare("SELECT * FROM product_message_requests").all(),
    ),
  ).not.toContain("please review");
});
it("preserves normal delivery for plain text and supports people without an agent target", async () => {
  const plain = await (
    await call("/api/messages", "POST", message("@Puff as plain text", []))
  ).json();
  expect(plain.payload.targetAgentName).toBeUndefined();
  expect(shouldHandleEventForAgent({ name: "Moss" } as any, plain)).toBe(true);
  const human = await (
    await call(
      "/api/messages",
      "POST",
      message("@teammate please read", [["teammate", "HUMAN"]]),
    )
  ).json();
  expect(human.payload.targetAgentName).toBeUndefined();
  expect(
    (await (await call("/api/mentions", "GET", undefined, other)).json()).items,
  ).toHaveLength(1);
});
it("rejects multiple agent targets, nonmembers, mismatched spans and forged source/target fields", async () => {
  for (const body of [
    message("@Puff @Moss", [
      ["Puff", "AGENT"],
      ["Moss", "AGENT"],
    ]),
    message("@Outsider", [["Outsider", "AGENT"]]),
    { ...message(), source: "human:teammate" },
    { ...message(), targetAgentName: "Moss" },
    {
      ...message(),
      mentions: [{ kind: "AGENT", name: "Puff", start: 1, end: 6 }],
    },
  ])
    expect((await call("/api/messages", "POST", body)).ok).toBe(false);
  expect(
    await (
      await call("/api/events?channelId=" + channel + "&type=message.created")
    ).json(),
  ).toHaveLength(0);
  expect((await call("/api/messages", "POST", message(), {})).status).toBe(401);
  expect(
    (
      await call("/api/messages", "POST", message(), {
        "content-type": "application/json",
        "x-nest-runner-token": "runner",
      })
    ).status,
  ).toBe(401);
});
it("recovers a lost response across restart without duplicate messages or notifications", async () => {
  const input = message();
  lose = true;
  expect((await call("/api/messages", "POST", input)).status).toBe(502);
  // Recipient can see the already committed message even before the sender retries.
  expect(
    (await (await call("/api/mentions", "GET", undefined, other)).json()).items,
  ).toHaveLength(1);
  product.store.close();
  product = createApp({
    orgops: client,
    dbPath: join(dir, "product.sqlite"),
    connections: null,
  });
  expect((await call("/api/messages", "POST", input)).status).toBe(201);
  expect(
    await (
      await call("/api/events?channelId=" + channel + "&type=message.created")
    ).json(),
  ).toHaveLength(1);
  expect(
    (await (await call("/api/mentions", "GET", undefined, other)).json()).items,
  ).toHaveLength(1);
  expect(
    (
      await call("/api/messages", "POST", {
        ...input,
        text: input.text + " changed",
      })
    ).status,
  ).toBe(409);
  const results = await Promise.all([
    call("/api/messages", "POST", input),
    call("/api/messages", "POST", input),
  ]);
  expect(results.every((r) => r.ok)).toBe(true);
});
it("revalidates access for sending and notification reads after membership/visibility changes", async () => {
  const input = message();
  expect((await call("/api/messages", "POST", input)).status).toBe(201);
  await call("/api/channels/" + channel + "/unsubscribe", "POST", {
    subscriberType: "AGENT",
    subscriberId: "Puff",
  });
  expect((await call("/api/messages", "POST", message())).status).toBe(409);
  await call("/api/channels/" + channel + "/unsubscribe", "POST", {
    subscriberType: "HUMAN",
    subscriberId: "teammate",
  });
  expect(
    (await (await call("/api/mentions", "GET", undefined, other)).json()).items,
  ).toEqual([]);
  expect(
    (await call("/api/messages", "POST", message("Hello", []), other)).status,
  ).toBe(403);
  await call("/api/channels/" + channel + "/archive", "POST", {});
  expect(
    (await call("/api/messages", "POST", message("Hello", []))).status,
  ).toBe(403);
});
it("keeps human IDs separate from agent names and removes deleted messages from the inbox", async () => {
  const input = message();
  const event = await (await call("/api/messages", "POST", input)).json();
  expect(
    event.payload.mentions.find((m: any) => m.kind === "HUMAN").humanId,
  ).toBeTruthy();
  await call("/api/channels/" + channel + "/messages", "DELETE");
  expect(
    (await (await call("/api/mentions", "GET", undefined, other)).json()).items,
  ).toEqual([]);
  expect(
    (
      await call(
        "/api/mentions/" + event.id + "/read",
        "POST",
        undefined,
        other,
      )
    ).status,
  ).toBe(404);
  expect((await call("/api/messages", "POST", input)).status).toBe(409);
});

it("supports several human notifications and separates a person and agent with the same name", async () => {
  await call("/api/humans/invite", "POST", {
    username: "Puff",
    tempPassword: "password",
  });
  await call("/api/channels/" + channel + "/subscribe", "POST", {
    subscriberType: "HUMAN",
    subscriberId: "Puff",
  });
  const text = "@Puff @Puff @teammate review";
  const input = {
    id: randomUUID(),
    channelId: channel,
    text,
    mentions: [
      { kind: "AGENT", name: "Puff", start: 0, end: 5 },
      { kind: "HUMAN", name: "Puff", start: 6, end: 11 },
      { kind: "HUMAN", name: "teammate", start: 12, end: 21 },
    ],
  };
  const response = await call("/api/messages", "POST", input);
  expect(response.status).toBe(201);
  const event = await response.json();
  expect(event.payload.targetAgentName).toBe("Puff");
  expect(event.payload.mentions).toHaveLength(3);
  expect(
    (
      product.store.db
        .prepare("SELECT COUNT(*) n FROM product_mention_notifications")
        .get() as any
    ).n,
  ).toBe(2);
});
