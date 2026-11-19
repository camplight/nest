import {DEFAULT_AGENT_MODEL_ID,defaultModelReference} from '@nest/orgops-client';
import {registerDashboardActivityRoutes} from './dashboard-activity';
import {registerModelPickerRoutes} from './model-picker';
import {createProjectNamingWorker} from './project-naming-worker';
import {registerCollaborationRoutes} from './collaboration';
import { registerDemoRoutes } from './demos';
import type {ProjectNamer} from './project-naming';
import {registerAgentManagementRoutes,type AgentManagementConfig} from './agent-management';
import {registerAgentRequestRoutes} from './agent-requests';
import {registerMessageRoutes} from './messages';
import {registerIntegrationRoutes} from "./integrations/routes";
import {composioConfigFromEnv,createComposioProvider} from "./integrations/composio";
import type {ConnectionProvider} from "./integrations/provider";
import { registerAgentModelRoutes } from './agent-models';
import { registerOnboardingRoutes, type PersonalAgentConfig } from './onboarding';
import { registerCommunityRoutes } from './community';
import { registerProjectRoutes } from './projects';
import { registerCanvasRoutes } from './canvases';
import { registerCanvasContextRoutes } from './canvas-context';
import { createContextFiles } from './context-files';
import { createContextAgents } from './context-agents';
import { createSwitchyard } from './flows/identity';
import { createSummarizer, type Summarize } from './flows/summarize';
import { registerFlowRoutes } from './flows/routes';
import { createHandoffWorker } from './flows/handoff';
import { createScheduler } from './flows/scheduler';
import { createHooks, registerHookEndpoint } from './flows/hooks';
import { randomUUID } from 'node:crypto';
import { watchEngine } from './flows/engine-watch';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { openProductDb, type ProductDb } from '@nest/db';
import { BrandingSchema } from '@nest/schemas';
import { createOrgOpsClient, productHeaders, type OrgOpsClient } from '@nest/orgops-client';
import { registerAgentMemoryRoutes } from './agent-memory';
import { createContextCompactionWorker } from './context-compaction-worker';
import type { HistorySummarizer } from './context-compaction';

export function createApp(config: { demoRoot?: string; projectNamer?:ProjectNamer; projectNamingModelId?:string; agentManagement?:AgentManagementConfig; connections?: ConnectionProvider | null; connectionEngineToken?:string; defaultAgentModelId?: string; personalAgent?: PersonalAgentConfig; store?: ProductDb; orgops?: OrgOpsClient; dbPath?: string; orgopsUrl?: string; canvasEnabled?: boolean; compaction?: {engineToken?:string; summarize?:HistorySummarizer; now?:()=>number}; contextFilesDir?: string; contextSetupWaitMs?: number; switchyardName?: string; switchyardCreator?: string; switchyardWorkspaceRoot?: string; summarize?: Summarize; flowsNow?: () => number } = {}) {
  const store = config.store ?? openProductDb(config.dbPath ?? resolve(fileURLToPath(new URL('../../../', import.meta.url)), process.env.NEST_PRODUCT_DB_PATH ?? '.nest-product/nest.sqlite'));
  const orgops = config.orgops ?? createOrgOpsClient(config.orgopsUrl ?? process.env.ORGOPS_URL ?? 'http://127.0.0.1:8788');
  const app = new Hono();
  app.onError((error, c) => {
    console.error('Nest request failed:', error.name);
    return c.json({error: 'Upstream service unavailable'}, 502);
  });
  // Webhooks first: POST /api/hooks/<token> is public (no cookie or session is read) and never reaches the engine proxy.
  const canvasEnabled = config.canvasEnabled ?? process.env.NEST_ENABLE_CANVAS === '1';
  const defaultAgentModelId = config.defaultAgentModelId ?? process.env.NEST_DEFAULT_AGENT_MODEL_ID ?? config.personalAgent?.modelId ?? process.env.NEST_PERSONAL_AGENT_MODEL_ID ?? DEFAULT_AGENT_MODEL_ID;
  // Nest's stopped service agent: it joins linked chats and posts hand-offs, runs, webhook calls and notes as itself.
  const serviceToken = config.connectionEngineToken ?? process.env.NEST_CONNECTION_METADATA_TOKEN ?? process.env.NEST_RUNNER_TOKEN;
  const switchyard = createSwitchyard({
    store, orgops, token: serviceToken,
    name: config.switchyardName ?? process.env.NEST_SWITCHYARD_AGENT_NAME, defaultModelId: defaultAgentModelId,
    creator: config.switchyardCreator ?? process.env.NEST_MANAGEMENT_AGENT_NAME,
    workspaceRoot: config.switchyardWorkspaceRoot ?? resolve(fileURLToPath(new URL('../../../', import.meta.url)), process.env.NEST_ENGINE_DATA_DIR ?? '.nest-data', 'workspaces/managed'),
  });
  const hooks = createHooks({store, orgops, token: serviceToken, switchyard, now: config.flowsNow});
  registerHookEndpoint(app, {hooks, enabled: canvasEnabled});
  registerDemoRoutes(app, {orgops, root: config.demoRoot ?? resolve(fileURLToPath(new URL('../../../', import.meta.url)), process.env.NEST_DEMO_ROOT ?? '.nest-data/demos')});
  app.get('/health', async c => {
    try {
      const response = await orgops.request('/health', {signal: AbortSignal.timeout(5000)});
      return c.json({status: response.ok ? 'ok' : 'degraded', service: 'nest-api', engine: 'orgops'}, response.ok ? 200 : 503);
    } catch { return c.json({status: 'degraded', service: 'nest-api', engine: 'orgops'}, 503); }
  });
  app.get('/api/branding', c => { c.header('Cache-Control', 'no-store'); return c.json(store.branding()); });
  app.get('/api/branding/access', async c => {
    c.header('Cache-Control', 'no-store');
    const user = await orgops.currentHuman(c.req.raw.headers);
    if (!user) return c.json({error: 'Unauthorized'}, 401);
    return c.json({canManage: await orgops.isOwner(user, c.req.raw.headers)});
  });
  app.put('/api/branding', bodyLimit({maxSize: 360_000, onError: c => c.json({error: 'Logo is too large'}, 413)}), async c => {
    const user = await orgops.currentHuman(c.req.raw.headers);
    if (!user) return c.json({error: 'Unauthorized'}, 401);
    if (!await orgops.isOwner(user, c.req.raw.headers)) return c.json({error: 'Only the instance owner can change branding'}, 403);
    const value = BrandingSchema.safeParse(await c.req.json().catch(() => null));
    if (!value.success) return c.json({error: 'Invalid branding'}, 400);
    return c.json(store.saveBranding(value.data, user.id));
  });
  const providerConfig=composioConfigFromEnv();
  const provider=config.connections===null?undefined:config.connections??(providerConfig?createComposioProvider(providerConfig):undefined);
  registerIntegrationRoutes(app,{store,orgops,provider,engineToken:config.connectionEngineToken??process.env.NEST_CONNECTION_METADATA_TOKEN??process.env.NEST_RUNNER_TOKEN});
  registerAgentModelRoutes(app, orgops, defaultAgentModelId);
  registerDashboardActivityRoutes(app,orgops);
  registerModelPickerRoutes(app, orgops, {engineToken:config.connectionEngineToken??process.env.NEST_RUNNER_TOKEN});
  const managementName = process.env.NEST_MANAGEMENT_AGENT_NAME;
  const managementId = process.env.NEST_MANAGEMENT_AGENT_ID;
  const managementKey = process.env.NEST_RUNNER_TOKEN;
  const agentManagement = config.agentManagement ?? (
    managementName && managementId && managementKey && defaultAgentModelId ? {
      agentName: managementName, agentId: managementId, engineToken: managementKey,
      defaultModelId: defaultAgentModelId,
      workspaceRoot: resolve(fileURLToPath(new URL('../../../', import.meta.url)), process.env.NEST_ENGINE_DATA_DIR ?? '.nest-data', 'workspaces/managed'),
    } : undefined
  );
  registerAgentManagementRoutes(app, {orgops, store, config: agentManagement});
  registerOnboardingRoutes(app, {store, orgops, config:config.personalAgent && {...config.personalAgent, modelId:defaultAgentModelId ?? config.personalAgent.modelId}, defaultModelId:defaultAgentModelId, connectionsAvailable:Boolean(provider)});
  registerMessageRoutes(app, {store,orgops});
  registerCollaborationRoutes(app,{store,orgops,engineToken:config.connectionEngineToken??process.env.NEST_CONNECTION_METADATA_TOKEN??process.env.NEST_RUNNER_TOKEN});
  registerAgentRequestRoutes(app,{store,orgops,engineToken:config.connectionEngineToken??process.env.NEST_CONNECTION_METADATA_TOKEN??process.env.NEST_RUNNER_TOKEN});
  const namingSource=process.env.NEST_PROJECT_NAMING_AGENT_NAME??managementName;
  registerProjectRoutes(app, {
    store,orgops,engineToken:config.connectionEngineToken??process.env.NEST_CONNECTION_METADATA_TOKEN??process.env.NEST_RUNNER_TOKEN,
  });
  registerCommunityRoutes(app, {store, orgops});
  // Context files stay out of the engine's files/ tree, which agents' shells can read.
  const contextFiles = createContextFiles(config.contextFilesDir ?? resolve(fileURLToPath(new URL('../../../', import.meta.url)), process.env.NEST_CONTEXT_FILES_DIR ?? '.nest-product/context-files'));
  // Agents' context keys and reads; the agent routes sit outside /api/canvases and before the engine proxy.
  const contextAgents = createContextAgents({store, orgops, engineToken: config.connectionEngineToken ?? process.env.NEST_CONNECTION_METADATA_TOKEN ?? process.env.NEST_RUNNER_TOKEN, setupWaitMs: config.contextSetupWaitMs});
  contextAgents.registerRoutes(app, {enabled: canvasEnabled, files: contextFiles});
  // Summaries reuse the project-naming model path: the default model and its provider keys only.
  const summarize = config.summarize ?? createSummarizer({store, model: async () => {
    if (!managementKey || !namingSource) return null;
    const response = await orgops.request('/api/models', {headers: {'x-orgops-runner-token': managementKey}});
    if (!response.ok) return null;
    const reference = defaultModelReference(defaultAgentModelId, orgops.nativeModels(await response.json()));
    if (!reference) return null;
    const env = await orgops.projectNamingEnv({model: reference, token: managementKey, agentName: namingSource, agentId: namingSource === managementName ? managementId : undefined});
    return {model: reference, env};
  }});
  // The hand-off worker and the scheduler share one lease holder, so one process does both; config.flowsNow is their clock.
  const flowsHolder = randomUUID();
  const handoff = createHandoffWorker({store, orgops, token: serviceToken, switchyard, summarize, now: config.flowsNow, holder: flowsHolder});
  const scheduler = createScheduler({store, orgops, token: serviceToken, switchyard, now: config.flowsNow, holder: flowsHolder});
  registerFlowRoutes(app, {store, orgops, enabled: canvasEnabled, switchyard, worker: handoff, summarize, scheduler, hooks});
  const flows = {
    enabled: canvasEnabled,
    /** One flows tick: hand-offs, then scheduled runs. */
    tick: async () => { await handoff.tick(); await scheduler.tick(); },
    /** Wake the worker when a linked chat's turn completes; null without a service token. */
    watch: (baseUrl: string) => serviceToken ? watchEngine({baseUrl, token: serviceToken, onTurnCompleted: handoff.wake}) : null,
  };
  // Before the canvas routes, whose /api/canvases/* catch-all would otherwise answer 404 first.
  registerCanvasContextRoutes(app, {store, orgops, enabled: canvasEnabled, files: contextFiles, agents: contextAgents});
  registerCanvasRoutes(app, {store, orgops, enabled: canvasEnabled, files: contextFiles, agents: contextAgents});
  // Unknown product endpoints do not fall through to a privileged service account.
  app.all('/api/branding/*', c => c.json({error: 'Not found'}, 404));
  const forward = async (source: Request) => {
    const url = new URL(source.url);
    const headers = new Headers(source.headers);
    headers.set('x-forwarded-host', url.host);
    headers.set('x-forwarded-proto', source.headers.get('x-forwarded-proto') ?? url.protocol.slice(0, -1));
    const init: RequestInit & {duplex?: string} = { method: source.method, headers, signal: source.signal };
    if (!['GET', 'HEAD'].includes(source.method)) { init.body = source.body; init.duplex = 'half'; }
    const response = await orgops.request(url.pathname + url.search, init);
    return new Response(response.body, { status: response.status, headers: productHeaders(response.headers) });
  };
  const proxy = (c: any) => forward(c.req.raw as Request);
  registerAgentMemoryRoutes(app, {store, orgops, forward, now: config.compaction?.now});
  app.all('/api/*', proxy);
  app.all('/v1/*', proxy);
  const projectNaming=createProjectNamingWorker({store,namer:config.projectNamer,context:async(projectId,requestId)=>{
    const project=store.projects.project(projectId);
    if(!project)return null;
    const receipt=store.db.prepare('SELECT event_id,sender_name FROM product_message_requests WHERE id=? AND channel_id=? AND sender_id=? AND delivered_at IS NOT NULL').get(requestId,project.channelId,project.ownerId) as {event_id:string;sender_name:string}|undefined;
    if(!receipt)return null;
    const input=await orgops.projectNamingContext({token:managementKey,modelId:config.projectNamingModelId??process.env.NEST_PROJECT_NAMING_MODEL_ID??defaultAgentModelId,preferFastModel:!config.projectNamingModelId&&!process.env.NEST_PROJECT_NAMING_MODEL_ID,eventId:receipt.event_id,channelId:project.channelId,ownerId:project.ownerId,senderName:receipt.sender_name});
    if(!input)return null;
    const env=config.projectNamer?undefined:await orgops.projectNamingEnv({model:input.model,token:managementKey,agentName:namingSource,agentId:namingSource===managementName?managementId:undefined});
    return {...input,env};
  }});
  const compactionToken = config.compaction ? config.compaction.engineToken : managementKey;
  const contextCompaction = createContextCompactionWorker({store, engine: compactionToken ? orgops.contextCompaction(compactionToken) : null, summarize: config.compaction?.summarize, now: config.compaction?.now});
  return { app, store, orgops, projectNaming, contextAgents, switchyard, summarize, handoff, scheduler, hooks, flows, contextCompaction };
}
