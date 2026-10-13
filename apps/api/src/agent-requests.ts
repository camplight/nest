import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { bodyLimit } from "hono/body-limit";
import type { z } from "zod";
import type { ProductDb, AgentRequestRow, OfferRow } from "@nest/db";
import type { OrgOpsClient, Human } from "@nest/orgops-client";
import {
  AssistantOfferInput,
  NewAgentRequestInput,
  AgentRequestActionInput,
  AgentRequestDecisionInput,
  AgentRequestReplyInput,
  type AgentRequest,
  type AssistantOffer,
} from "@nest/schemas";
import { createPrivateAgentContext } from "./agent-private-context";

type EngineEvent = {
  id: string;
  type: string;
  source: string;
  channelId: string;
  createdAt: number;
  idempotencyKey?: string;
  payload?: {
    text?: unknown;
    targetAgentName?: unknown;
    nestAgentRequestId?: unknown;
  };
};
type PersonalSetup = {
  owner_id: string;
  name: string;
  agent_id: string | null;
  channel_id: string | null;
};

export function registerAgentRequestRoutes(
  app: Hono,
  {
    store,
    orgops,
    engineToken,
  }: { store: ProductDb; orgops: OrgOpsClient; engineToken?: string },
) {
  const routes = new Hono<{ Variables: { human: Human } }>();
  const db = store.agentRequests;
  const fail = (
    status: 400 | 403 | 404 | 409 | 503,
    message: string,
  ): never => {
    throw new HTTPException(status, { message });
  };
  const context = createPrivateAgentContext({
    orgops,
    engineToken,
    onSecured: (owner, details) =>
      db.audit("audit.assistant.lifecycle.secured", owner, details),
  });
  routes.onError((error, c) =>
    error instanceof HTTPException
      ? c.json({ error: error.message }, error.status)
      : c.json(
          {
            error:
              "Assistant service unavailable. Existing requests are retained; refresh and retry.",
          },
          502,
        ),
  );
  const prefixes = [
    "/assistants",
    "/assistants/*",
    "/agent-requests",
    "/agent-requests/*",
  ];
  for (const prefix of prefixes) {
    routes.use(
      prefix,
      bodyLimit({
        maxSize: 128_000,
        onError: (c) => c.json({ error: "Request too large" }, 413),
      }),
    );
    routes.use(prefix, async (c, next) => {
      c.header("Cache-Control", "no-store");
      if (
        !["GET", "DELETE"].includes(c.req.method) &&
        !c.req.header("content-type")?.startsWith("application/json")
      )
        return c.json({ error: "Use application/json" }, 415);
      const human = await orgops.currentHuman(c.req.raw.headers);
      if (!human)
        return c.json({ error: "Sign in to request assistant work" }, 401);
      if (human.mustChangePassword)
        return c.json({ error: "Complete password setup first" }, 403);
      c.set("human", human);
      await next();
    });
  }
  async function input<T>(
    c: { req: { json: () => Promise<unknown> } },
    schema: z.ZodType<T>,
  ): Promise<T> {
    const value = schema.safeParse(await c.req.json().catch(() => null));
    return value.success ? value.data : fail(400, "Invalid assistant request");
  }
  function setup(owner: string): PersonalSetup {
    const record = store.db
      .prepare(
        "SELECT owner_id,name,agent_id,channel_id FROM product_personal_agents WHERE owner_id=?",
      )
      .get(owner) as PersonalSetup | undefined;
    return record?.agent_id && record.channel_id
      ? record
      : fail(409, "Finish personal agent setup first");
  }
  async function ownedSetup(name: string, human: Human, headers: Headers) {
    const record = setup(human.id);
    if (record.name !== name) fail(404, "Personal agent not found");
    const response = await orgops.humanRequest(
      `/api/agents/${encodeURIComponent(name)}`,
      headers,
    );
    if (!response.ok) fail(403, "Personal agent ownership is unavailable");
    const agent = (await response.json()) as {
      id: string;
      ownerHumanId: string;
      visibility: string;
      mode: string;
    };
    if (
      agent.id !== record.agent_id ||
      agent.ownerHumanId !== human.id ||
      agent.visibility !== "PRIVATE" ||
      agent.mode === "WRAPPED"
    )
      fail(403, "Private personal agent ownership changed");
    return record;
  }
  async function directory() {
    if (!engineToken)
      fail(503, "Your administrator must configure assistant metadata access");
    return orgops.assistantDirectory(engineToken!);
  }
  function liveOffer(
    row: OfferRow,
    meta: Awaited<ReturnType<typeof directory>>,
  ) {
    const record = store.db
      .prepare(
        "SELECT owner_id,name,agent_id,channel_id FROM product_personal_agents WHERE owner_id=?",
      )
      .get(row.owner_id) as PersonalSetup | undefined;
    return Boolean(
      record?.channel_id &&
      record.agent_id === row.agent_id &&
      record.name === row.agent_name &&
      meta.humans.some((h) => h.id === row.owner_id) &&
      meta.agents.some(
        (a) =>
          a.id === row.agent_id &&
          a.name === row.agent_name &&
          a.ownerHumanId === row.owner_id &&
          a.visibility === "PRIVATE" &&
          a.mode !== "WRAPPED",
      ),
    );
  }
  function accessible(id: string, human: Human, ownerOnly = false) {
    const row = db.request(id);
    if (
      !row ||
      (row.owner_id !== human.id &&
        (ownerOnly || row.requester_id !== human.id))
    )
      fail(404, "Request not found");
    return row!;
  }
  function view(
    row: AgentRequestRow,
    human: Human,
    humans: { id: string; username: string }[],
  ): AgentRequest {
    // No private channel/event IDs or unreleased engine responses leave this boundary.
    return {
      id: row.id,
      agentName: row.agent_name,
      ownerName:
        humans.find((h) => h.id === row.owner_id)?.username ??
        "Former teammate",
      requesterName:
        humans.find((h) => h.id === row.requester_id)?.username ??
        "Former teammate",
      title: row.title,
      brief: row.brief,
      status: row.status,
      version: row.version,
      isOwner: row.owner_id === human.id,
      reply: row.status === "completed" ? row.reply : null,
      feedback: row.feedback,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
  async function result(row: AgentRequestRow, human: Human) {
    return view(row, human, (await directory()).humans);
  }
  function change(
    row: AgentRequestRow,
    patch: Partial<AgentRequestRow>,
    actor: string,
  ) {
    return (
      db.change(row, patch, actor) ??
      fail(409, "This request changed. Refresh before trying again.")
    );
  }
  function version(row: AgentRequestRow, value: number) {
    if (row.version !== value)
      fail(409, "This request changed. Refresh before trying again.");
  }
  async function privateRequest(
    row: AgentRequestRow,
    human: Human,
    headers: Headers,
    activate = false,
  ) {
    const record = await ownedSetup(row.agent_name, human, headers);
    if (
      record.agent_id !== row.agent_id ||
      (row.channel_id && row.channel_id !== record.channel_id)
    )
      fail(403, "Personal agent mapping changed");
    return context(
      row.agent_name,
      row.owner_id,
      row.agent_id,
      record.channel_id!,
      activate ? headers : undefined,
    );
  }
  function candidate(event: EngineEvent, row: AgentRequestRow) {
    return (
      event.type === "message.created" &&
      event.source === `agent:${row.agent_name}` &&
      event.channelId === row.channel_id &&
      row.dispatched_at !== null &&
      event.createdAt >= row.dispatched_at &&
      typeof event.payload?.text === "string" &&
      event.payload.text.trim().length > 0
    );
  }

  routes.get("/assistants", async (c) => {
    const meta = await directory(),
      human = c.get("human");
    return c.json({
      items: db
        .offers()
        .filter((row) => liveOffer(row, meta))
        .map(
          (row) =>
            ({
              agentName: row.agent_name,
              ownerName: meta.humans.find((h) => h.id === row.owner_id)!
                .username,
              description: row.description,
              yours: row.owner_id === human.id,
            }) satisfies AssistantOffer,
        ),
    });
  });
  routes.get("/assistants/:name/offer", async (c) => {
    await ownedSetup(c.req.param("name"), c.get("human"), c.req.raw.headers);
    const row = db.offer(c.req.param("name"));
    return c.json({
      enabled: Boolean(row?.enabled),
      description: row?.description ?? "",
      available: Boolean(engineToken),
    });
  });
  routes.put("/assistants/:name/offer", async (c) => {
    const human = c.get("human"),
      record = await ownedSetup(c.req.param("name"), human, c.req.raw.headers),
      body = await input(c, AssistantOfferInput);
    if (body.enabled && !engineToken)
      fail(503, "Your administrator must configure assistant metadata access");
    const now = Date.now();
    store.db.transaction(() => {
      store.db
        .prepare(
          "INSERT INTO product_agent_offers(agent_id,agent_name,owner_id,enabled,description,created_at,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(agent_id) DO UPDATE SET enabled=excluded.enabled,description=excluded.description,updated_at=excluded.updated_at",
        )
        .run(
          record.agent_id,
          record.name,
          human.id,
          Number(body.enabled),
          body.description,
          now,
          now,
        );
      db.audit("audit.assistant.offer.updated", human.id, {
        agentId: record.agent_id,
        enabled: body.enabled,
      });
    })();
    return c.json({
      enabled: body.enabled,
      description: body.description,
      available: Boolean(engineToken),
    });
  });
  routes.get("/agent-requests", async (c) => {
    const offset = Number(c.req.query("offset") ?? 0),
      limit = Number(c.req.query("limit") ?? 50);
    if (
      !Number.isInteger(offset) ||
      offset < 0 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      fail(400, "Invalid request page");
    const direction = c.req.query("direction") ?? "all";
    if (!["all", "incoming", "outgoing"].includes(direction))
      fail(400, "Invalid request direction");
    const rows = db.list(
        c.get("human").id,
        offset,
        limit + 1,
        direction as "all" | "incoming" | "outgoing",
      ),
      meta = await directory();
    return c.json({
      items: rows
        .slice(0, limit)
        .map((row) => view(row, c.get("human"), meta.humans)),
      hasMore: rows.length > limit,
    });
  });
  routes.post("/agent-requests", async (c) => {
    const body = await input(c, NewAgentRequestInput),
      human = c.get("human");
    const existing = db.request(body.id);
    if (existing) {
      if (
        existing.requester_id !== human.id ||
        existing.agent_name !== body.agentName ||
        existing.title !== body.title ||
        existing.brief !== body.brief
      )
        fail(409, "Request ID already used");
      return c.json(await result(existing, human));
    }
    const meta = await directory();
    const offer =
      db.offer(body.agentName) ??
      fail(404, "This assistant is not accepting new requests");
    if (!offer?.enabled || !liveOffer(offer, meta))
      fail(404, "This assistant is not accepting new requests");
    if (offer.owner_id === human.id)
      fail(400, "Use your private conversation to work with your own agent");
    const now = Date.now();
    let created = false;
    store.db.transaction(() => {
      // A second creator can arrive while metadata is loading. Compare the
      // immutable intent inside the same transaction rather than inserting twice.
      const existing = db.request(body.id);
      if (existing) {
        if (
          existing.requester_id !== human.id ||
          existing.agent_name !== body.agentName ||
          existing.title !== body.title ||
          existing.brief !== body.brief
        )
          fail(409, "Request ID already used");
        return;
      }
      if (!db.offer(body.agentName)?.enabled)
        fail(404, "This assistant is not accepting new requests");
      created = true;
      store.db
        .prepare(
          "INSERT INTO product_agent_requests(id,agent_id,agent_name,owner_id,requester_id,title,brief,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'pending',?,?)",
        )
        .run(
          body.id,
          offer.agent_id,
          offer.agent_name,
          offer.owner_id,
          human.id,
          body.title,
          body.brief,
          now,
          now,
        );
      db.audit("audit.assistant.request.created", human.id, {
        requestId: body.id,
        agentId: offer.agent_id,
      });
    })();
    return c.json(
      view(db.request(body.id)!, human, meta.humans),
      created ? 201 : 200,
    );
  });
  routes.get("/agent-requests/:id", async (c) =>
    c.json(
      await result(
        accessible(c.req.param("id"), c.get("human")),
        c.get("human"),
      ),
    ),
  );
  routes.post("/agent-requests/:id/approve", async (c) => {
    const human = c.get("human"),
      body = await input(c, AgentRequestActionInput);
    let row = accessible(c.req.param("id"), human, true);
    if (row.status === "working") return c.json(await result(row, human));
    if (!["pending", "dispatching"].includes(row.status))
      fail(409, "This request cannot be approved");
    if (row.status === "pending") version(row, body.version);
    else if (body.version !== row.version && body.version !== row.version - 1)
      fail(409, "This request changed. Refresh before trying again.");
    const privateChannel = await privateRequest(
      row,
      human,
      c.req.raw.headers,
      true,
    );
    if (row.status === "pending")
      row = change(
        row,
        {
          status: "dispatching",
          channel_id: privateChannel.channelId,
          event_id: randomUUID(),
        },
        human.id,
      );
    const payload = {
      targetAgentName: row.agent_name,
      nestAgentRequestId: row.id,
      text: [
        `Owner-approved request for ${row.agent_name}: ${row.title}`,
        `Request ID: ${row.id}`,
        `A teammate requested this work. Your owner reviewed and approved the brief below. Work only within your owner's existing tool permissions. Reply in this private conversation; your owner will review and share a reply.`,
        `Brief:\n${row.brief}`,
      ].join("\n\n"),
    };
    // A durable planned UUID and engine idempotency key survive lost responses/restarts.
    let receipt: EngineEvent;
    const existing = await orgops.humanRequest(
      `/api/events/${encodeURIComponent(row.event_id!)}`,
      c.req.raw.headers,
    );
    if (existing.ok) receipt = (await existing.json()) as EngineEvent;
    else {
      if (existing.status !== 404) throw Error("Engine receipt unavailable");
      receipt = await orgops.humanJson<EngineEvent>(
        "/api/events",
        c.req.raw.headers,
        {
          id: row.event_id,
          type: "message.created",
          source: `human:${human.username}`,
          channelId: row.channel_id,
          idempotencyKey: `nest:assistant-request:${row.id}`,
          payload,
        },
      );
    }
    if (
      receipt.id !== row.event_id ||
      receipt.type !== "message.created" ||
      receipt.channelId !== row.channel_id ||
      receipt.source !== `human:${human.username}` ||
      receipt.idempotencyKey !== `nest:assistant-request:${row.id}` ||
      receipt.payload?.targetAgentName !== row.agent_name ||
      receipt.payload.nestAgentRequestId !== row.id ||
      receipt.payload.text !== payload.text
    )
      fail(
        409,
        "Dispatch receipt does not match this request. Ask your administrator to inspect it.",
      );
    await privateRequest(row, human, c.req.raw.headers);
    const changed = db.change(
      row,
      { status: "working", dispatched_at: receipt.createdAt },
      human.id,
    );
    const current = changed ?? db.request(row.id)!;
    if (current.status !== "working" || current.event_id !== receipt.id)
      fail(409, "This request changed. Refresh before trying again.");
    return c.json(await result(current, human));
  });
  routes.get("/agent-requests/:id/responses", async (c) => {
    const human = c.get("human"),
      row = accessible(c.req.param("id"), human, true);
    if (row.status !== "working") return c.json([]);
    await privateRequest(row, human, c.req.raw.headers);
    const query = new URLSearchParams({
      channelId: row.channel_id!,
      type: "message.created",
      source: `agent:${row.agent_name}`,
      after: String(row.dispatched_at! - 1),
      limit: "100",
      order: "desc",
    });
    const events = await orgops.humanJson<EngineEvent[]>(
      `/api/events?${query}`,
      c.req.raw.headers,
    );
    return c.json(
      events
        .filter((event) => candidate(event, row))
        .map((event) => ({
          id: event.id,
          text: event.payload!.text,
          createdAt: event.createdAt,
        })),
    );
  });
  routes.post("/agent-requests/:id/reply", async (c) => {
    const human = c.get("human"),
      row = accessible(c.req.param("id"), human, true),
      body = await input(c, AgentRequestReplyInput);
    if (row.status === "completed") {
      if (row.reply !== body.reply || row.response_event_id !== body.eventId)
        fail(409, "This request already has an approved reply");
      return c.json(await result(row, human));
    }
    version(row, body.version);
    if (row.status !== "working")
      fail(409, "Approve the work before sharing a reply");
    await privateRequest(row, human, c.req.raw.headers);
    const response = await orgops.humanRequest(
      `/api/events/${encodeURIComponent(body.eventId)}`,
      c.req.raw.headers,
    );
    if (!response.ok) fail(400, "Choose an available response from this agent");
    const event = (await response.json()) as EngineEvent;
    if (!candidate(event, row))
      fail(400, "Choose a response from this agent after the request was sent");
    return c.json(
      await result(
        change(
          row,
          {
            status: "completed",
            response_event_id: event.id,
            reply: body.reply,
          },
          human.id,
        ),
        human,
      ),
    );
  });
  routes.post("/agent-requests/:id/decline", async (c) => {
    const human = c.get("human"),
      row = accessible(c.req.param("id"), human, true),
      body = await input(c, AgentRequestDecisionInput);
    version(row, body.version);
    if (row.status !== "pending")
      fail(409, "Only unapproved requests can be declined");
    return c.json(
      await result(
        change(row, { status: "declined", feedback: body.feedback }, human.id),
        human,
      ),
    );
  });
  routes.post("/agent-requests/:id/cancel", async (c) => {
    const human = c.get("human"),
      row = accessible(c.req.param("id"), human),
      body = await input(c, AgentRequestActionInput);
    if (row.requester_id !== human.id) fail(404, "Request not found");
    version(row, body.version);
    if (row.status !== "pending")
      fail(409, "Work already approved cannot be cancelled here");
    return c.json(
      await result(change(row, { status: "cancelled" }, human.id), human),
    );
  });
  for (const prefix of prefixes)
    routes.all(prefix, (c) => c.json({ error: "Not found" }, 404));
  app.route("/api", routes);
}
