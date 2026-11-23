import { createHash, randomUUID } from "node:crypto";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { bodyLimit } from "hono/body-limit";
import {
  SendMessageSchema,
  type SelectedMention,
  type MentionNotification,
} from "@nest/schemas";
import type { ProductDb } from "@nest/db";
import type { OrgOpsClient, Human } from "@nest/orgops-client";
type Channel = {
  id: string;
  name: string;
  canPost: boolean;
  archivedAt?: number;
  participants: { subscriberType: string; subscriberId: string }[];
};
type Intent = {
  id: string;
  sender_id: string;
  sender_name: string;
  channel_id: string;
  input_hash: string;
  payload_hash: string;
  event_id: string;
  created_at: number;
  delivered_at: number | null;
};
type Event = {
  id: string;
  type: string;
  source: string;
  channelId: string;
  idempotencyKey?: string;
  createdAt: number;
  payload: Record<string, unknown>;
};
function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ":" + canonical(v))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
const hash = (value: unknown) =>
  createHash("sha256").update(canonical(value)).digest("hex");
export function registerMessageRoutes(
  app: Hono,
  { store, orgops }: { store: ProductDb; orgops: OrgOpsClient },
) {
  const routes = new Hono<{ Variables: { human: Human } }>(),
    db = store.db;
  routes.onError((error, c) =>
    error instanceof HTTPException
      ? c.json({ error: error.message }, error.status)
      : c.json(
          {
            error:
              "Message delivery is uncertain. Retry this unchanged message to recover safely.",
          },
          502,
        ),
  );
  for (const path of ["/messages", "/mentions", "/mentions/*"])
    routes.use(
      path,
      bodyLimit({
        maxSize: 100_000,
        onError: (c) => c.json({ error: "Message is too large" }, 413),
      }),
    );
  for (const path of ["/messages", "/mentions", "/mentions/*"])
    routes.use(path, async (c, next) => {
      c.header("Cache-Control", "no-store");
      const human = await orgops.currentHuman(c.req.raw.headers);
      if (!human)
        return c.json(
          { error: "Sign in to send messages or read mentions" },
          401,
        );
      if (human.mustChangePassword)
        return c.json({ error: "Complete password setup first" }, 403);
      c.set("human", human);
      await next();
    });
  const fail = (status: 400 | 403 | 404 | 409, message: string): never => {
    throw new HTTPException(status, { message });
  };
  const intent = (id: string) =>
    db.prepare("SELECT * FROM product_message_requests WHERE id=?").get(id) as
      Intent | undefined;
  async function engineEvent(id: string, headers: Headers) {
    const r = await orgops.humanRequest(
      "/api/events/" + encodeURIComponent(id),
      headers,
    );
    if (r.status === 404) return null;
    if (!r.ok) throw Error("Engine unavailable");
    return (await r.json()) as Event;
  }
  function validReceipt(row: Intent, event: Event) {
    return (
      event.id === row.event_id &&
      event.type === "message.created" &&
      event.channelId === row.channel_id &&
      event.source === "human:" + row.sender_name &&
      event.idempotencyKey === `nest:message:${row.sender_id}:${row.id}` &&
      hash(event.payload) === row.payload_hash
    );
  }
  async function channelList(headers: Headers) {
    return orgops.humanJson<Channel[]>(
      "/api/channels?includeArchived=1",
      headers,
    );
  }
  routes.post("/messages", async (c) => {
    if (!c.req.header("content-type")?.startsWith("application/json"))
      return c.json({ error: "Use application/json" }, 415);
    const parsed = SendMessageSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) fail(400, "Invalid message");
    const input = parsed.data!,
      human = c.get("human"),
      headers = c.req.raw.headers;
    const channel = (await channelList(headers)).find(
      (ch) => ch.id === input.channelId,
    );
    if (!channel?.canPost || channel.archivedAt)
      fail(403, "You cannot send to this conversation");
    const sorted = [...input.mentions].sort((a, b) => a.start - b.start);
    for (let i = 0; i < sorted.length; i++) {
      const mention = sorted[i];
      if (
        input.text.slice(mention.start, mention.end) !== "@" + mention.name ||
        mention.end > input.text.length ||
        (i && sorted[i - 1].end > mention.start)
      )
        fail(400, "Mention selection no longer matches the message");
    }
    const recipients = [
      ...new Map(sorted.map((m) => [m.kind + ":" + m.name, m])).values(),
    ];
    const agentRecipients = recipients.filter((m) => m.kind === "AGENT");
    const targetAgentName=input.targetAgentName??(agentRecipients.length===1?agentRecipients[0].name:undefined);
    const targetAgentNames=agentRecipients.length>1?agentRecipients.map(m=>m.name):undefined;
    if(input.targetAgentName&&targetAgentNames)
      fail(400,"An explicit single target cannot be combined with multiple selected agents");
    if(input.targetAgentName&&agentRecipients[0]&&input.targetAgentName!==agentRecipients[0].name)
      fail(400,"The selected agent and message target must match");
    if(targetAgentName&&!channel!.participants.some(p=>p.subscriberType==='AGENT'&&p.subscriberId===targetAgentName))
      fail(409,"The selected agent is no longer in this conversation");
    for (const recipient of recipients)
      if (
        !channel!.participants.some(
          (p) =>
            p.subscriberType === recipient.kind &&
            p.subscriberId === recipient.name,
        )
      )
        fail(
          409,
          "A selected recipient is no longer in this conversation. Refresh and choose again.",
        );
    // Engine ownership/visibility remains authoritative even for a subscribed agent.
    for (const name of targetAgentNames ?? (targetAgentName ? [targetAgentName] : [])) {
      const r = await orgops.humanRequest(
        "/api/agents/" + encodeURIComponent(name),
        headers,
      );
      if (r.status === 403 || r.status === 404) fail(403, "Agent unavailable");
      if (!r.ok) throw Error("Engine unavailable");
    }
    const humans = recipients.some((m) => m.kind === "HUMAN")
      ? await orgops.humanJson<{ id: string; username: string }[]>(
          "/api/humans",
          headers,
        )
      : [];
    // Validate a reply target only for a new request, so an unchanged retry recovers after the target vanished.
    if (input.replyTo && !intent(input.id)) {
      const target = await engineEvent(input.replyTo, headers);
      if (
        target?.type !== "message.created" ||
        target.channelId !== input.channelId
      )
        return c.json(
          {
            error: "The message you are replying to is unavailable.",
            code: "REPLY_TARGET_INVALID",
          },
          400,
        );
    }
    const resolved = recipients.map((m) => ({
      ...m,
      ...(m.kind === "HUMAN"
        ? { humanId: humans.find((h) => h.username === m.name)?.id }
        : {}),
    }));
    if (resolved.some((m) => m.kind === "HUMAN" && !m.humanId))
      fail(409, "A selected person is unavailable");
    const payload = {
      text: input.text,
      ...(input.attachments.length ? { attachments: input.attachments } : {}),
      nestMessageId: input.id,
      mentions: resolved,
      ...(targetAgentNames ? { targetAgentNames } : {}),
      ...(targetAgentName
        ? { targetAgentName }
        : {}),
      ...(input.replyTo ? { inReplyTo: input.replyTo } : {}),
    };
    const inputHash = hash({ ...input, mentions: sorted });
    db.transaction(() => {
      const existing = intent(input.id);
      if (existing) {
        if (
          existing.sender_id !== human.id ||
          existing.input_hash !== inputHash
        )
          fail(409, "Message ID already used for different content");
        return;
      }
      db.prepare(
        "INSERT INTO product_message_requests(id,sender_id,sender_name,channel_id,input_hash,payload_hash,event_id,created_at) VALUES(?,?,?,?,?,?,?,?)",
      ).run(
        input.id,
        human.id,
        human.username,
        input.channelId,
        inputHash,
        hash(payload),
        randomUUID(),
        Date.now(),
      );
      for (const recipient of resolved)
        if (recipient.humanId && recipient.humanId !== human.id)
          db.prepare(
            "INSERT INTO product_mention_notifications(request_id,recipient_id) VALUES(?,?)",
          ).run(input.id, recipient.humanId);
    })();
    const row = intent(input.id)!;
    let event = await engineEvent(row.event_id, headers);
    if (!event) {
      if (row.delivered_at)
        fail(409, "This message was removed; it will not be sent again.");
      const currentChannel = (await channelList(headers)).find(
        (ch) => ch.id === input.channelId,
      );
      if (
        !currentChannel?.canPost ||
        currentChannel.archivedAt ||
        (targetAgentName&&!currentChannel.participants.some(p=>p.subscriberType==='AGENT'&&p.subscriberId===targetAgentName)) ||
        recipients.some(
          (m) =>
            !currentChannel.participants.some(
              (p) => p.subscriberType === m.kind && p.subscriberId === m.name,
            ),
        )
      )
        fail(409, "Conversation recipients changed; refresh before sending.");
      if (
        row.payload_hash !== hash(payload) ||
        row.sender_name !== human.username
      )
        fail(409, "Recipients changed; inspect this message before retrying");
      const response = await orgops.humanRequest(
        "/api/events",
        headers,
        "POST",
        {
          id: row.event_id,
          type: "message.created",
          channelId: row.channel_id,
          source: "human:" + row.sender_name,
          idempotencyKey: `nest:message:${row.sender_id}:${row.id}`,
          payload,
        },
      );
      if (response.status === 403) fail(403, "Conversation access changed");
      if (!response.ok) throw Error("Engine delivery failed");
      event = (await response.json()) as Event;
    }
    if (!validReceipt(row, event))
      fail(409, "Message receipt does not match this send request");
    db.transaction(()=>{
      db.prepare(
        "UPDATE product_message_requests SET delivered_at=COALESCE(delivered_at,?) WHERE id=?",
      ).run(Date.now(), row.id);
      // Persist only references, never message text or a user's session credentials.
      db.prepare(`INSERT OR IGNORE INTO product_project_naming(project_id,request_id,expected_name,expected_description)
        SELECT p.id,r.id,p.name,p.description FROM product_projects p JOIN product_message_requests r ON r.channel_id=p.channel_id
        WHERE r.id=? AND p.owner_id=r.sender_id AND NOT EXISTS (
          SELECT 1 FROM product_message_requests earlier WHERE earlier.channel_id=r.channel_id
          AND earlier.sender_id=p.owner_id AND earlier.delivered_at IS NOT NULL AND earlier.rowid<r.rowid)
        AND NOT EXISTS (SELECT 1 FROM product_audit WHERE type IN ('audit.project.updated','audit.project.naming.applied')
          AND json_extract(payload_json,'$.projectId')=p.id)`).run(row.id);
    })();
    return c.json(event, 201);
  });
  routes.get("/mentions", async (c) => {
    const human = c.get("human"),
      headers = c.req.raw.headers,
      channels = await channelList(headers);
    if (!channels.length) return c.json({ items: [] });
    const accessible = db
      .prepare(
        `SELECT r.*,n.read_at FROM product_mention_notifications n JOIN product_message_requests r ON r.id=n.request_id WHERE n.recipient_id=? AND r.channel_id IN (${channels.map(() => "?").join(",")}) ORDER BY n.read_at IS NOT NULL,r.created_at DESC LIMIT 20`,
      )
      .all(human.id, ...channels.map((ch) => ch.id)) as (Intent & {
      read_at: number | null;
    })[];
    const items: MentionNotification[] = [];
    // Bound engine concurrency and never serve cached message content after access changes.
    for (let offset = 0; offset < accessible.length; offset += 5) {
      await Promise.all(
        accessible.slice(offset, offset + 5).map(async (row) => {
          const event = await engineEvent(row.event_id, headers);
          if (!event) {
            if (row.delivered_at)
              db.prepare(
                "DELETE FROM product_mention_notifications WHERE request_id=?",
              ).run(row.id);
            return;
          }
          if (!validReceipt(row, event)) return;
          db.prepare(
            "UPDATE product_message_requests SET delivered_at=COALESCE(delivered_at,?) WHERE id=?",
          ).run(Date.now(), row.id);
          const mentions = event.payload.mentions as (SelectedMention & {
            humanId?: string;
          })[];
          if (!mentions.some((m) => m.humanId === human.id)) return;
          items.push({
            id: event.id,
            channelId: row.channel_id,
            channelName: channels.find((ch) => ch.id === row.channel_id)!.name,
            sender: row.sender_name,
            text: String(event.payload.text ?? "").slice(0, 160),
            createdAt: event.createdAt,
            readAt: row.read_at,
          });
        }),
      );
    }
    return c.json({
      items: items.sort(
        (a, b) =>
          Number(Boolean(a.readAt)) - Number(Boolean(b.readAt)) ||
          b.createdAt - a.createdAt,
      ),
    });
  });
  routes.post("/mentions/:id/read", async (c) => {
    const human = c.get("human"),
      headers = c.req.raw.headers;
    const row = db
      .prepare(
        `SELECT r.* FROM product_message_requests r JOIN product_mention_notifications n ON n.request_id=r.id WHERE r.event_id=? AND n.recipient_id=?`,
      )
      .get(c.req.param("id"), human.id) as Intent | undefined;
    if (!row) fail(404, "Mention unavailable");
    const event = await engineEvent(row!.event_id, headers);
    if (!event || !validReceipt(row!, event)) fail(404, "Mention unavailable");
    db.prepare(
      "UPDATE product_mention_notifications SET read_at=COALESCE(read_at,?) WHERE request_id=? AND recipient_id=?",
    ).run(Date.now(), row!.id, human.id);
    return c.json({ ok: true });
  });
  app.route("/api", routes);
  app.all("/api/messages/*", (c) => c.json({ error: "Not found" }, 404));
  app.all("/api/mentions/*", (c) => c.json({ error: "Not found" }, 404));
}
