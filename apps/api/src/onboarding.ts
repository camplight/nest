import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { bodyLimit } from "hono/body-limit";
import type { ProductDb } from "@nest/db";
import type { Human, OrgOpsClient } from "@nest/orgops-client";
import {
  PersonalAgentSchema,
  type PersonalAgentSetup,
  type AgentCharacter,
} from "@nest/schemas";
export type PersonalAgentConfig = {
  modelId: string;
  runnerId: string;
  workspaceRoot: string;
};
type Row = {
  owner_id: string;
  id: string;
  name: string;
  character: AgentCharacter;
  brief: string;
  model_id: string;
  runner_id: string;
  workspace_path: string;
  agent_id: string | null;
  channel_id: string | null;
  completed_at: number | null;
};
type EngineAgent = {
  id: string;
  name: string;
  ownerHumanId: string;
  visibility: string;
  workspacePath: string;
  runtimeState: string;
  soulContents?: string;
  systemInstructions?: string;
};
type EngineChannel = {
  id: string;
  ownerHumanId: string;
  visibility: string;
  archivedAt?: number;
  metadata?: { nestPersonalAgent?: string };
  participants?: { subscriberType: string; subscriberId: string }[];
  shares?: unknown[];
};
export function registerOnboardingRoutes(
  app: Hono,
  {
    store,
    orgops,
    config,
    defaultModelId,
    connectionsAvailable = false,
  }: { store: ProductDb; orgops: OrgOpsClient; config?: PersonalAgentConfig; defaultModelId?: string; connectionsAvailable?:boolean },
) {
  const routes = new Hono<{ Variables: { human: Human } }>();
  const db = store.db;
  const settings =
    config ??
    (defaultModelId &&
    process.env.NEST_PERSONAL_AGENT_RUNNER_ID
      ? {
          modelId: defaultModelId,
          runnerId: process.env.NEST_PERSONAL_AGENT_RUNNER_ID,
          workspaceRoot:
            process.env.NEST_PERSONAL_AGENT_WORKSPACE_ROOT ??
            "/app/.nest-data/workspaces/personal",
        }
      : undefined);
  const row = (owner: string) =>
    db
      .prepare("SELECT * FROM product_personal_agents WHERE owner_id=?")
      .get(owner) as Row | undefined;
  const reservationMarker = (r: Row) => `<!-- Nest onboarding reservation: ${r.id} -->`;
  const publicSetup = (r: Row): PersonalAgentSetup => ({
    id: r.id,
    name: r.name,
    character: r.character,
    brief: r.brief,
    agentId: r.agent_id,
    channelId: r.channel_id,
    completedAt: r.completed_at,
  });
  routes.onError((e, c) =>
    e instanceof HTTPException
      ? c.json({ error: e.message }, e.status)
      : c.json(
          {
            error:
              "Setup could not finish. Your progress is saved; retry to continue.",
          },
          502,
        ),
  );
  routes.use(
    "*",
    bodyLimit({
      maxSize: 16_000,
      onError: (c) => c.json({ error: "Request too large" }, 413),
    }),
  );
  routes.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    const human = await orgops.currentHuman(c.req.raw.headers);
    if (!human) return c.json({ error: "Sign in to set up your agent" }, 401);
    if (human.mustChangePassword)
      return c.json({ error: "Complete password setup first" }, 403);
    c.set("human", human);
    await next();
  });
  async function agent(r: Row, headers: Headers) {
    const response = await orgops.humanRequest(
      `/api/agents/${encodeURIComponent(r.name)}`,
      headers,
    );
    if (response.status === 404) return null;
    if (!response.ok) throw Error("Engine unavailable");
    const value = (await response.json()) as EngineAgent;
    if (
      value.ownerHumanId !== r.owner_id ||
      value.visibility !== "PRIVATE" ||
      (r.agent_id && (value.id !== r.agent_id || value.workspacePath !== r.workspace_path)) ||
      (!r.agent_id && value.workspacePath !== r.workspace_path &&
        !(value.soulContents ?? value.systemInstructions ?? "").includes(reservationMarker(r)))
    )
      throw new HTTPException(409, {
        message:
          "Agent ownership or configuration changed. Contact your administrator.",
      });
    // OrgOps assigns member workspace paths. Bind the returned identity/path once;
    // the reservation marker also reconciles a committed create with a lost response.
    // Existing setups retain their saved path and reject subsequent configuration drift.
    if (!r.agent_id) {
      if (!value.id || typeof value.workspacePath !== "string" || !value.workspacePath.trim())
        throw Error("Engine returned an incomplete agent");
      db.prepare(
        "UPDATE product_personal_agents SET agent_id=?,workspace_path=? WHERE owner_id=? AND id=? AND agent_id IS NULL AND workspace_path=?",
      ).run(value.id, value.workspacePath, r.owner_id, r.id, r.workspace_path);
      const bound = row(r.owner_id);
      if (bound?.id !== r.id || bound.agent_id !== value.id || bound.workspace_path !== value.workspacePath)
        throw new HTTPException(409, {message:"Agent ownership or configuration changed. Contact your administrator."});
      r.agent_id = bound.agent_id;
      r.workspace_path = bound.workspace_path;
    }
    return value;
  }
  async function channel(r: Row, headers: Headers) {
    const channels = await orgops.humanJson<EngineChannel[]>(
      "/api/channels?includeArchived=1",
      headers,
    );
    const found = channels.find((ch) =>
      r.channel_id
        ? ch.id === r.channel_id
        : ch.metadata?.nestPersonalAgent === r.id,
    );
    if (
      found &&
      (found.ownerHumanId !== r.owner_id ||
        found.visibility !== "PRIVATE" ||
        found.archivedAt ||
        found.metadata?.nestPersonalAgent !== r.id)
    )
      throw new HTTPException(409, {
        message:
          "Your personal conversation is unavailable. Contact your administrator.",
      });
    return found;
  }
  async function configured(
    headers: Headers,
    modelId = settings?.modelId,
    runnerId = settings?.runnerId,
  ) {
    if (!modelId || !runnerId) return false;
    const [model, runners] = await Promise.all([
      orgops.nativeModelReference(modelId, headers),
      orgops.humanJson<{ id: string; online: boolean }[]>(
        "/api/runners",
        headers,
      ),
    ]);
    return (
      !!model &&
      runners.some((r) => r.id === runnerId && r.online)
    );
  }
  routes.get("/summary", (c) => {
    const setup = row(c.get("human").id);
    return c.json({setup: setup ? publicSetup(setup) : null});
  });
  // Compatibility for clients from the settings rollout; capability now belongs to Nest.
  routes.get("/connections", c => c.json({available:connectionsAvailable}));
  routes.get("/", async (c) => {
    const human = c.get("human"),
      r = row(human.id),
      headers = c.req.raw.headers;
    let runtimeState: string | null = null,
      problem: string | null = null;
    if (r?.agent_id) {
      try {
        const a = await agent(r, headers);
        runtimeState = a?.runtimeState ?? null;
        if (!a)
          problem = "Your agent is unavailable. Contact your administrator.";
        if (r.channel_id && !(await channel(r, headers)))
          problem =
            "Your personal conversation is unavailable. Contact your administrator.";
      } catch (e) {
        problem =
          e instanceof HTTPException
            ? e.message
            : "Agent status is temporarily unavailable.";
      }
    }
    const available = await configured(headers, r?.model_id, r?.runner_id);
    return c.json({
      setup: r ? publicSetup(r) : null,
      provisioningAvailable: available,
      connectionsAvailable,
      suggestedName: `Puff${
        human.username
          .split("@")[0]
          .replace(/[^A-Za-z0-9]/g, "")
          .slice(0, 30)
          .replace(/^./, (s) => s.toUpperCase()) || "Teammate"
      }`,
      runtimeState,
      problem,
    });
  });
  routes.post("/agent", async (c) => {
    const human = c.get("human"),
      headers = c.req.raw.headers;
    const input = PersonalAgentSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!input.success)
      return c.json(
        { error: input.error.issues.map((i) => i.message).join("; ") },
        400,
      );
    let r = row(human.id);
    if (
      r &&
      (r.name !== input.data.name ||
        r.character !== input.data.character ||
        r.brief !== input.data.brief)
    )
      return c.json(
        {
          error:
            "Your setup already exists. Resume it instead of creating another agent.",
        },
        409,
      );
    if (!r) {
      if (!settings || !(await configured(headers)))
        return c.json(
          {
            error:
              "An administrator needs to configure an enabled model and runner before you can create your agent.",
          },
          503,
        );
      const modelReference = await orgops.nativeModelReference(settings.modelId, headers);
      if (!modelReference) return c.json({error:'The selected model is not available.'},503);
      const occupied = await orgops.humanRequest(
        `/api/agents/${encodeURIComponent(input.data.name)}`,
        headers,
      );
      if (occupied.ok)
        return c.json(
          { error: "That agent name is already in use. Choose another name." },
          409,
        );
      if (occupied.status !== 404) throw Error("Engine unavailable");
      const id = randomUUID();
      try {
        db.prepare(
          "INSERT INTO product_personal_agents(owner_id,id,name,character,brief,model_id,runner_id,workspace_path,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
        ).run(
          human.id,
          id,
          input.data.name,
          input.data.character,
          input.data.brief,
          modelReference,
          settings.runnerId,
          resolve(settings.workspaceRoot, id),
          Date.now(),
        );
      } catch (e) {
        if (!row(human.id))
          return c.json(
            { error: "That agent name is reserved. Choose another name." },
            409,
          );
      }
      r = row(human.id)!;
      if (
        r.name !== input.data.name ||
        r.character !== input.data.character ||
        r.brief !== input.data.brief
      )
        return c.json(
          {
            error:
              "Another setup request has already started. Refresh to continue.",
          },
          409,
        );
    }
    let a = await agent(r, headers);
    if (!a) {
      if (r.agent_id)
        return c.json(
          {
            error:
              "Your agent was removed. Contact your administrator before recreating it.",
          },
          409,
        );
      // Stable unique name + reservation marker reconcile lost responses; competing
      // creates cannot produce two engine agents with this name.
      const created = await orgops.humanRequest(
        "/api/agents",
        headers,
        "POST",
        {
          name: r.name,
          icon: r.character,
          modelId: r.model_id,
          assignedRunnerId: r.runner_id,
          workspacePath: r.workspace_path,
          visibility: "PRIVATE",
          mode: "CLASSIC",
          desiredState: "RUNNING",
          allowOutsideWorkspace: false,
          allowOwnerHumanSecrets: false,
          enabledSkills: [],
          classicMaxModelSteps: 12,
          description: `Personal assistant for ${human.username}`,
          systemInstructions: `You are ${r.name}, the personal assistant of ${human.username}. Help with planning, research and follow-through. ${r.brief}\nUse only explicitly granted connections. Never claim an integration or action succeeded without a tool result. Teammates may talk to you, but this does not grant access to your owner's accounts. Ask for clarification before destructive or externally visible actions.\n${reservationMarker(r)}`,
        },
      );
      a = await agent(r, headers);
      if (!a || (!created.ok && created.status < 500))
        throw Error("Agent create failed");
    }
    db.prepare(
      "UPDATE product_personal_agents SET agent_id=? WHERE owner_id=?",
    ).run(a.id, human.id);
    let ch = await channel(r, headers);
    if (!ch) {
      if (r.channel_id)
        return c.json(
          {
            error:
              "Your personal conversation was removed. Contact your administrator.",
          },
          409,
        );
      await orgops.humanRequest("/api/channels", headers, "POST", {
        name: `nest-personal-${r.id}`,
        description: `Your private workspace with ${r.name}`,
        visibility: "PRIVATE",
        metadata: { nestPersonalAgent: r.id },
      });
      ch = await channel(r, headers);
      if (!ch) throw Error("Conversation create failed");
    }
    await orgops.humanJson(`/api/channels/${ch.id}/subscribe`, headers, {
      subscriberType: "AGENT",
      subscriberId: r.name,
    });
    db.prepare(
      "UPDATE product_personal_agents SET channel_id=? WHERE owner_id=?",
    ).run(ch.id, human.id);
    return c.json(publicSetup(row(human.id)!));
  });
  routes.post("/complete", async (c) => {
    const r = row(c.get("human").id);
    if (!r?.agent_id || !r.channel_id)
      return c.json({ error: "Create your agent first" }, 409);
    const a = await agent(r, c.req.raw.headers),
      ch = await channel(r, c.req.raw.headers);
    if (!a || !ch)
      return c.json(
        { error: "Your agent or conversation is unavailable" },
        409,
      );
    db.prepare(
      "UPDATE product_personal_agents SET completed_at=COALESCE(completed_at,?) WHERE owner_id=?",
    ).run(Date.now(), r.owner_id);
    return c.json(publicSetup(row(r.owner_id)!));
  });
  app.route("/api/onboarding", routes);
  app.all("/api/onboarding/*", (c) => c.json({ error: "Not found" }, 404));
}
