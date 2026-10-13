import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { bodyLimit } from "hono/body-limit";
import type { z } from "zod";
import {
  connectionLinkInput,
  connectionGrantInput,
  connectionToolInput,
  connectionExecuteInput,
} from "@nest/schemas";
import type { ProductDb } from "@nest/db";
import type { OrgOpsClient, Human } from "@nest/orgops-client";
import type { ConnectionProvider } from "./provider";
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
type Connection = {
  id: string;
  owner_id: string;
  provider: string;
  account_id: string;
  subject: string;
  toolkit: string;
  revoked_at: number | null;
};
type Token = {
  id: string;
  agent_id: string;
  agent_name: string;
  owner_id: string;
  channel_id: string;
  expires_at: number;
  revoked_at: number | null;
};
type IntegrationEnv = {
  Variables: { human: Human | null; token: Token | null };
};
export function registerIntegrationRoutes(
  app: Hono,
  {
    store,
    orgops,
    provider,
    engineToken,
  }: {
    store: ProductDb;
    orgops: OrgOpsClient;
    provider?: ConnectionProvider;
    engineToken?: string;
  },
) {
  const db = store.db;
  const changingSkills = new Set<string>();
  const routes = new Hono<IntegrationEnv>();
  const fail = (
    status: 400 | 401 | 403 | 404 | 409 | 503,
    message: string,
  ): never => {
    throw new HTTPException(status, { message });
  };
  const audit = (type: string, owner: string, payload: unknown) =>
    db
      .prepare(
        "INSERT INTO product_audit(type,actor_id,payload_json,created_at) VALUES(?,?,?,?)",
      )
      .run(type, owner, JSON.stringify(payload), Date.now());
  routes.onError((error, c) =>
    error instanceof HTTPException
      ? c.json({ error: error.message }, error.status)
      : c.json({ error: "Connection service unavailable. Retry later." }, 502),
  );
  routes.use(
    "*",
    bodyLimit({
      maxSize: 64_000,
      onError: (c) => c.json({ error: "Request too large" }, 413),
    }),
  );
  routes.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    if (
      !["GET", "DELETE"].includes(c.req.method) &&
      !c.req.header("content-type")?.startsWith("application/json")
    )
      return c.json({ error: "Use application/json" }, 415);
    const bearer = c.req.header("authorization");
    if (bearer) {
      if (!/^Bearer nest_connection_[a-f0-9]{64}$/.test(bearer))
        return c.json({ error: "Invalid connection token" }, 401);
      const token = db
        .prepare(
          "SELECT * FROM product_connection_tokens WHERE token_hash=? AND revoked_at IS NULL AND expires_at>?",
        )
        .get(hash(bearer.slice(7)), Date.now()) as Token | undefined;
      if (!token)
        return c.json({ error: "Connection token expired or revoked" }, 401);
      c.set("token", token);
      c.set("human", null);
    } else {
      const human = await orgops.currentHuman(c.req.raw.headers);
      if (!human)
        return c.json({ error: "Sign in to manage connections" }, 401);
      if (human.mustChangePassword)
        return c.json({ error: "Complete password setup first" }, 403);
      c.set("human", human);
      c.set("token", null);
    }
    await next();
  });
  // A single Nest API owns this SQLite file. Serialize credential installation and revocation.
  routes.use("/agents/:name/skill", async (c, next) => {
    if (c.req.method === "GET") return next();
    const key = c.req.param("name");
    if (changingSkills.has(key))
      return c.json(
        { error: "Skill access is being updated; retry shortly" },
        409,
      );
    changingSkills.add(key);
    try {
      await next();
    } finally {
      changingSkills.delete(key);
    }
  });
  const human = (c: Context<IntegrationEnv>): Human =>
    c.get("human") ?? fail(403, "Human sign-in required");
  const service = () => provider ?? fail(503, "Connections are not configured");
  async function body<T>(
    c: Context<IntegrationEnv>,
    schema: z.ZodType<T>,
  ): Promise<T> {
    const result = schema.safeParse(await c.req.json().catch(() => null));
    return result.success ? result.data : fail(400, "Invalid request");
  }
  async function ownedAgent(name: string, owner: string, headers: Headers) {
    const r = await orgops.humanRequest(
      `/api/agents/${encodeURIComponent(name)}`,
      headers,
    );
    if (!r.ok) fail(403, "Private owned agent required");
    const a = (await r.json()) as {
      id: string;
      name: string;
      ownerHumanId: string;
      visibility: string;
      mode: string;
      enabledSkills?: string[];
    };
    if (
      a.ownerHumanId !== owner ||
      a.visibility !== "PRIVATE" ||
      a.mode === "WRAPPED"
    )
      fail(403, "Private owned agent required");
    return a;
  }
  function connection(localId: string, owner: string) {
    const r = db
      .prepare(
        "SELECT * FROM product_connections WHERE id=? AND owner_id=? AND provider=?",
      )
      .get(localId, owner, service().id) as Connection | undefined;
    return r ?? fail(404, "Connection not found");
  }
  async function account(r: Connection, active = true) {
    const p = service();
    const a = await p.account(r.account_id);
    if (
      r.subject !== p.subject(r.owner_id) ||
      a.id !== r.account_id ||
      a.subject !== r.subject ||
      a.toolkit !== r.toolkit ||
      a.shared
    )
      fail(403, "Connection ownership mismatch");
    if (active && (r.revoked_at || a.status !== "ACTIVE" || a.disabled))
      fail(409, "Reconnect this account before using it");
    return a;
  }
  async function privateContext(
    agentName: string,
    ownerId: string,
    agentId?: string,
    channelId?: string,
    activateHeaders?: Headers,
  ): Promise<{
    agent: {
      id: string;
      name: string;
      ownerHumanId: string;
      visibility: string;
    };
    channelId: string;
  }> {
    if (!engineToken)
      fail(503, "Skill access requires engine metadata configuration");
    const { agent, channels, humans } = await orgops.connectionContext(
      agentName,
      engineToken!,
    );
    if (
      agent.ownerHumanId !== ownerId ||
      agent.visibility !== "PRIVATE" ||
      (agentId && agent.id !== agentId)
    )
      fail(403, "Agent ownership changed");
    const owner =
      humans.find((h) => h.id === ownerId) ??
      fail(403, "Agent owner is unavailable");
    const subscribed = channels.filter((ch) =>
      ch.participants?.some(
        (p) => p.subscriberType === "AGENT" && p.subscriberId === agent.name,
      ),
    );
    // The runner creates this GROUP for startup/schedule events. Its name is
    // not an authorization boundary: require the canonical shape AND privacy.
    const lifecycle = subscribed.filter(
      (ch) =>
        ch.name === `agent.lifecycle.${agent.name}` &&
        ch.description === `Lifecycle bootstrap channel for ${agent.name}` &&
        ch.kind === "GROUP",
    );
    const conversations = subscribed.filter((ch) => !lifecycle.includes(ch));
    const ch = conversations[0];
    if (
      conversations.length !== 1 ||
      !ch ||
      ch.archivedAt ||
      ch.ownerHumanId !== ownerId ||
      ch.visibility !== "PRIVATE" ||
      !Array.isArray(ch.shares) ||
      ch.shares.length ||
      (channelId && ch.id !== channelId) ||
      !ch.participants.some(
        (p) =>
          p.subscriberType === "HUMAN" && p.subscriberId === owner.username,
      ) ||
      ch.participants.some(
        (p) =>
          !(
            (p.subscriberType === "HUMAN" &&
              p.subscriberId === owner.username) ||
            (p.subscriberType === "AGENT" && p.subscriberId === agent.name)
          ),
      )
    )
      fail(
        403,
        "Skill access requires one unshared owner-only conversation. Remove other subscriptions or sharing before retrying.",
      );
    if (
      lifecycle.length > 1 ||
      lifecycle.some(
        (entry) =>
          entry.archivedAt ||
          !Array.isArray(entry.shares) ||
          entry.shares.length > 0 ||
          entry.participants.some(
            (p) =>
              !(
                (p.subscriberType === "AGENT" &&
                  p.subscriberId === agent.name) ||
                (p.subscriberType === "HUMAN" &&
                  p.subscriberId === owner.username)
              ),
          ) ||
          ((entry.visibility !== "PRIVATE" || entry.ownerHumanId !== ownerId) &&
            !(
              activateHeaders &&
              entry.visibility === "PUBLIC" &&
              !entry.ownerHumanId
            )),
      )
    )
      fail(
        403,
        "The agent's lifecycle channel must be private, owned by you and unshared. Renew skill access to secure its default lifecycle channel.",
      );
    const unsecured = lifecycle.find((entry) => entry.visibility === "PUBLIC");
    if (unsecured) {
      const response = await orgops.humanRequest(
        `/api/channels/${encodeURIComponent(unsecured.id)}`,
        activateHeaders!,
        "PATCH",
        { visibility: "PRIVATE" },
      );
      if (!response.ok)
        fail(
          403,
          "Could not secure the agent's lifecycle channel. Ask your administrator to check channel permissions.",
        );
      audit("audit.connection.lifecycle.secured", ownerId, {
        agentId: agent.id,
        channelId: unsecured.id,
      });
      // Re-read after mutation before issuing any credential. Execution never repairs.
      return privateContext(agentName, ownerId, agentId, ch.id);
    }
    return { agent, channelId: ch.id };
  }
  routes.get("/config", (c) => {
    human(c);
    return c.json({
      configured: Boolean(provider),
      skillAvailable: Boolean(provider && engineToken),
    });
  });
  routes.get("/toolkits", async (c) => {
    human(c);
    return c.json(
      await service().apps(
        (c.req.query("search") ?? "").slice(0, 120),
        c.req.query("cursor")?.slice(0, 500),
      ),
    );
  });
  routes.get("/connections", async (c) => {
    const owner = human(c).id,
      p = service();
    const page = await p.accounts(owner, c.req.query("cursor")?.slice(0, 500));
    const items = [];
    for (const a of page.items) {
      if (a.subject !== p.subject(owner) || a.shared) continue;
      db.prepare(
        "INSERT INTO product_connections(id,owner_id,provider,account_id,subject,toolkit,created_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(provider,account_id) DO NOTHING",
      ).run(randomUUID(), owner, p.id, a.id, a.subject, a.toolkit, Date.now());
      const r = db
        .prepare(
          "SELECT * FROM product_connections WHERE provider=? AND account_id=? AND owner_id=?",
        )
        .get(p.id, a.id, owner) as Connection | undefined;
      if (r && r.subject === a.subject && r.toolkit === a.toolkit)
        items.push({
          id: r.id,
          toolkit: r.toolkit,
          status: r.revoked_at ? "REVOKED" : a.status,
        });
    }
    return c.json({ items, nextCursor: page.nextCursor });
  });
  routes.post("/connections/link", async (c) => {
    const owner = human(c).id;
    const input = await body(c, connectionLinkInput);
    return c.json(await service().link(owner, input.toolkit), 201);
  });
  routes.post("/connections/:id/revoke", async (c) => {
    const owner = human(c).id,
      r = connection(c.req.param("id"), owner);
    await account(r, false);
    db.transaction(() => {
      db.prepare("UPDATE product_connections SET revoked_at=? WHERE id=?").run(
        Date.now(),
        r.id,
      );
      db.prepare(
        "DELETE FROM product_connection_grants WHERE connection_id=?",
      ).run(r.id);
      audit("audit.connection.revoked", owner, { connectionId: r.id });
    })();
    await service().revoke(r.account_id);
    return c.json({ ok: true });
  });
  routes.get("/connections/:id/tools", async (c) => {
    const r = connection(c.req.param("id"), human(c).id);
    await account(r);
    const page = await service().tools(
      r.toolkit,
      (c.req.query("search") ?? "").slice(0, 120),
      c.req.query("cursor")?.slice(0, 500),
    );
    return c.json({
      items: page.items.map(({ slug, name, description }) => ({
        slug,
        name,
        description,
      })),
      nextCursor: page.nextCursor,
    });
  });
  routes.put("/agents/:name/grants/:id", async (c) => {
    const owner = human(c).id,
      a = await ownedAgent(c.req.param("name"), owner, c.req.raw.headers),
      r = connection(c.req.param("id"), owner);
    const input = await body(c, connectionGrantInput);
    await account(r);
    for (const slug of new Set(input.tools)) {
      if ((await service().tool(slug)).toolkit !== r.toolkit)
        fail(400, "Tool does not belong to this connection");
    }
    await ownedAgent(a.name, owner, c.req.raw.headers);
    if (connection(r.id, owner).revoked_at) fail(409, "Connection was revoked");
    db.prepare(
      "INSERT INTO product_connection_grants VALUES(?,?,?,?) ON CONFLICT(agent_id,connection_id) DO UPDATE SET owner_id=excluded.owner_id,tools_json=excluded.tools_json",
    ).run(a.id, owner, r.id, JSON.stringify([...new Set(input.tools)]));
    audit("audit.connection.granted", owner, {
      agentId: a.id,
      connectionId: r.id,
      tools: input.tools,
    });
    return c.json({ ok: true });
  });
  routes.get("/agents/:name/grants", async (c) => {
    const owner = human(c).id,
      a = await ownedAgent(c.req.param("name"), owner, c.req.raw.headers);
    const rows = db
      .prepare(
        "SELECT connection_id,tools_json FROM product_connection_grants WHERE agent_id=? AND owner_id=?",
      )
      .all(a.id, owner) as { connection_id: string; tools_json: string }[];
    return c.json(
      rows.map((r) => ({
        connectionId: r.connection_id,
        tools: JSON.parse(r.tools_json),
      })),
    );
  });
  routes.delete("/agents/:name/grants/:id", async (c) => {
    const owner = human(c).id,
      a = await ownedAgent(c.req.param("name"), owner, c.req.raw.headers);
    db.prepare(
      "DELETE FROM product_connection_grants WHERE agent_id=? AND owner_id=? AND connection_id=?",
    ).run(a.id, owner, c.req.param("id"));
    audit("audit.connection.grant.revoked", owner, {
      agentId: a.id,
      connectionId: c.req.param("id"),
    });
    return c.json({ ok: true });
  });
  routes.get("/agents/:name/skill", async (c) => {
    const owner = human(c).id,
      a = await ownedAgent(c.req.param("name"), owner, c.req.raw.headers);
    const token = db
      .prepare(
        "SELECT expires_at FROM product_connection_tokens WHERE agent_id=? AND owner_id=? AND revoked_at IS NULL AND expires_at>? ORDER BY created_at DESC LIMIT 1",
      )
      .get(a.id, owner, Date.now()) as { expires_at: number } | undefined;
    return c.json({
      enabled: Boolean(token),
      expiresAt: token?.expires_at ?? null,
    });
  });
  routes.post("/agents/:name/skill", async (c) => {
    const owner = human(c).id,
      a = await ownedAgent(c.req.param("name"), owner, c.req.raw.headers);
    service();
    const context = await privateContext(
      a.name,
      owner,
      a.id,
      undefined,
      c.req.raw.headers,
    );
    const token = "nest_connection_" + randomBytes(32).toString("hex"),
      tokenId = randomUUID(),
      expires = Date.now() + 30 * 86400_000;
    db.prepare(
      "INSERT INTO product_connection_tokens(id,token_hash,agent_id,agent_name,owner_id,channel_id,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?)",
    ).run(
      tokenId,
      hash(token),
      a.id,
      a.name,
      owner,
      context.channelId,
      expires,
      Date.now(),
    );
    try {
      const secret = await orgops.humanRequest(
        "/api/secrets",
        c.req.raw.headers,
        "POST",
        {
          key: "NEST_CONNECTION_TOKEN",
          scopeType: "private",
          scopeId: a.name,
          value: token,
        },
      );
      if (!secret.ok) throw Error("Could not install skill credential");
      const enabled = await orgops.humanRequest(
        `/api/agents/${encodeURIComponent(a.name)}`,
        c.req.raw.headers,
        "PATCH",
        {
          enabledSkills: [
            ...new Set([...(a.enabledSkills ?? []), "nest-connections"]),
          ],
        },
      );
      if (!enabled.ok) throw Error("Could not enable skill");
      await privateContext(a.name, owner, a.id, context.channelId);
    } catch (error) {
      db.prepare(
        "UPDATE product_connection_tokens SET revoked_at=? WHERE id=?",
      ).run(Date.now(), tokenId);
      throw error;
    }
    db.prepare(
      "UPDATE product_connection_tokens SET revoked_at=? WHERE agent_id=? AND owner_id=? AND id!=? AND revoked_at IS NULL",
    ).run(Date.now(), a.id, owner, tokenId);
    audit("audit.connection.skill.enabled", owner, {
      agentId: a.id,
      expiresAt: expires,
    });
    return c.json({ enabled: true, expiresAt: expires });
  });
  routes.delete("/agents/:name/skill", async (c) => {
    const owner = human(c).id,
      a = await ownedAgent(c.req.param("name"), owner, c.req.raw.headers);
    db.prepare(
      "UPDATE product_connection_tokens SET revoked_at=? WHERE agent_id=? AND owner_id=?",
    ).run(Date.now(), a.id, owner);
    audit("audit.connection.skill.revoked", owner, { agentId: a.id });
    return c.json({ ok: true });
  });
  async function skill(c: Context<IntegrationEnv>) {
    const t = c.get("token") as Token | null;
    if (!t) fail(403, "Agent connection token required");
    await privateContext(
      t!.agent_name,
      t!.owner_id,
      t!.agent_id,
      t!.channel_id,
    );
    if (
      !db
        .prepare(
          "SELECT 1 FROM product_connection_tokens WHERE id=? AND revoked_at IS NULL AND expires_at>?",
        )
        .get(t!.id, Date.now())
    )
      fail(401, "Connection token expired or revoked");
    return t!;
  }
  function grant(t: Token, connectionId: string, tool: string) {
    const active = db
      .prepare(
        "SELECT 1 FROM product_connection_tokens WHERE id=? AND revoked_at IS NULL AND expires_at>?",
      )
      .get(t.id, Date.now());
    if (!active) fail(401, "Connection token expired or revoked");
    const r = db
      .prepare(
        "SELECT tools_json FROM product_connection_grants WHERE agent_id=? AND owner_id=? AND connection_id=?",
      )
      .get(t.agent_id, t.owner_id, connectionId) as
      { tools_json: string } | undefined;
    if (!r || !JSON.parse(r.tools_json).includes(tool))
      fail(403, "Tool access has not been granted by the owner");
    const conn = connection(connectionId, t.owner_id);
    if (conn.revoked_at) fail(403, "Connection revoked");
    return conn;
  }
  routes.get("/skill/tools", async (c) => {
    const t = await skill(c);
    const rows = db
      .prepare(
        "SELECT connection_id,tools_json FROM product_connection_grants WHERE agent_id=? AND owner_id=?",
      )
      .all(t.agent_id, t.owner_id) as {
      connection_id: string;
      tools_json: string;
    }[];
    return c.json({
      connections: rows.map((r) => ({
        connectionId: r.connection_id,
        tools: JSON.parse(r.tools_json),
      })),
    });
  });
  for (const action of ["schema", "execute"] as const)
    routes.post(`/skill/${action}`, async (c) => {
      const input = await body(
        c,
        action === "execute" ? connectionExecuteInput : connectionToolInput,
      );
      const t = await skill(c),
        conn = grant(t, input.connectionId, input.tool),
        a = await account(conn),
        tool = await service().tool(input.tool);
      if (tool.slug !== input.tool || tool.toolkit !== conn.toolkit)
        fail(403, "Tool does not match connection");
      await skill(c);
      grant(t, input.connectionId, input.tool);
      if (action === "schema")
        return c.json({
          slug: tool.slug,
          description: tool.description,
          inputParameters: tool.inputParameters,
        });
      const requestId = randomUUID();
      audit("audit.connection.tool.requested", t.owner_id, {
        requestId,
        agentId: t.agent_id,
        connectionId: conn.id,
        tool: input.tool,
      });
      try {
        const result = await service().execute(
          a,
          input.tool,
          "arguments" in input
            ? (input.arguments as Record<string, unknown>)
            : {},
        );
        audit("audit.connection.tool.completed", t.owner_id, { requestId });
        return new Response(JSON.stringify(result), {
          headers: {
            "content-type": "application/json",
            "cache-control": "no-store",
          },
        });
      } catch (error) {
        audit("audit.connection.tool.failed", t.owner_id, { requestId });
        throw new HTTPException(502, {
          message:
            "Tool execution failed or its response was lost. It may have completed; verify before retrying.",
        });
      }
    });
  app.route("/api/integrations", routes);
  app.all("/api/integrations/*", (c) => c.json({ error: "Not found" }, 404));
  // The retired engine-specific proposal is never proxied to the engine.
  app.all("/api/composio/*", (c) =>
    c.json({ error: "Use Nest /api/integrations endpoints" }, 410),
  );
}
