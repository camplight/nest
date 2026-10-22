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

it('lists registered personal agents and opens idempotent direct chat without owner membership',async()=>{
 const directory=await call('/api/collaboration/agents',requester);expect(directory.status).toBe(200);expect((await directory.json()).items).toEqual([{name:'PuffNaska',ownerName:'naska'}]);
 const path='/api/collaboration/agents/PuffNaska/chat';
 const opened=await call(path,requester,'POST',{});expect(opened.status).toBe(200);const {channelId}=await opened.json();expect(channelId).toBeTruthy();
 expect((await(await call(path,requester,'POST',{})).json()).channelId).toBe(channelId);
 const channels=await(await call('/api/channels',requester)).json(),chat=channels.find((c:any)=>c.id===channelId);
 expect(chat.participants).toEqual(expect.arrayContaining([{subscriberType:'HUMAN',subscriberId:'vitaliy'},{subscriberType:'AGENT',subscriberId:'PuffNaska'}]));
 expect(chat.participants.some((p:any)=>p.subscriberId==='naska')).toBe(false);
 const sent=await call('/api/messages',requester,'POST',{id:randomUUID(),channelId,text:'Hello',mentions:[],attachments:[],targetAgentName:'PuffNaska'});expect(sent.status).toBe(201);
 expect((await call('/api/agents/PuffNaska',requester,'PATCH',{systemInstructions:'Hijack'})).status).toBe(403);
 expect((await call('/api/integrations/agents/PuffNaska/skill',requester,'POST',{})).status).toBe(403);
});
it('requires a human session and matching registered identity',async()=>{
 expect((await call('/api/collaboration/agents',{})).status).toBe(401);
 expect((await call('/api/collaboration/agents',runner)).status).toBe(401);
 product.store.db.prepare("UPDATE product_personal_agents SET agent_id='stale'").run();
 expect((await(await call('/api/collaboration/agents',requester)).json()).items).toEqual([]);
 expect((await call('/api/collaboration/agents/PuffNaska/chat',requester,'POST',{})).status).toBe(404);
});
it('retires request and offer mutations without dispatching work',async()=>{
 for(const path of ['/api/agent-requests','/api/agent-requests/old/approve','/api/agent-requests/old/reply','/api/agent-requests/old/cancel','/api/assistants/PuffNaska/offer'])expect((await call(path,requester,path.endsWith('/offer')?'PUT':'POST',{})).status).toBe(410);
 expect((await(await call('/api/agent-requests',requester)).json()).items).toEqual([]);
});

it('allows a project owner to invite another teammates personal agent',async()=>{
 const who=await(await call('/api/auth/me',requester)).json();
 const created=await(await call('/api/channels',requester,'POST',{name:'Team project',visibility:'PRIVATE'})).json();
 product.store.db.prepare("INSERT INTO product_projects(id,owner_id,channel_id,name,description,created_at,collaboration) VALUES(?,?,?,?,?,?,'team')").run('p',who.id,created.id,'Team project','',Date.now());
 const response=await call('/api/projects/p/members',requester,'POST',{subscriberType:'AGENT',subscriberId:'PuffNaska'});expect(response.status).toBe(200);
 const channels=await(await call('/api/channels',requester)).json();expect(channels.find((c:any)=>c.id===created.id).participants.some((p:any)=>p.subscriberId==='PuffNaska')).toBe(true);
 expect((await call('/api/projects/p/members',other,'POST',{subscriberType:'AGENT',subscriberId:'PuffNaska'})).status).toBe(404);
});
it('retains old participant-only history without exposing unreleased replies',async()=>{
 const own=await(await call('/api/auth/me',owner)).json(),req=await(await call('/api/auth/me',requester)).json();
 product.store.db.prepare("INSERT INTO product_agent_requests(id,agent_id,agent_name,owner_id,requester_id,title,brief,status,reply,channel_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run('historic','agent','PuffNaska',own.id,req.id,'Old request','Brief','working','Unreleased private text',channel,1,1);
 const history=await(await call('/api/agent-requests/historic',requester)).json();expect(history.reply).toBeNull();expect(history).not.toHaveProperty('channel_id');
 expect((await call('/api/agent-requests/historic',other)).status).toBe(404);
 expect((await call('/api/agent-requests/historic/reply',owner,'POST',{})).status).toBe(410);
 expect(product.store.agentRequests.request('historic')?.status).toBe('working');
});
