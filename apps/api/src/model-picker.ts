import {createModelBenchmarks} from './model-benchmarks';
import type { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { generate } from '@orgops/llm';
import { providerEnvKeys, type OrgOpsClient } from '@nest/orgops-client';
import { modelProviderLabel } from '@nest/schemas';
import { createOpenRouterCatalog, modelSlug } from './openrouter-catalog';
import { compatibleModelName, createCompatibleCatalog } from './compatible-catalog';
const COMPATIBLE = 'openai-compatible:';

export function registerModelPickerRoutes(app:Hono, orgops:OrgOpsClient, options:{benchmarks?:ReturnType<typeof createModelBenchmarks>;engineToken?:string;catalog?:ReturnType<typeof createOpenRouterCatalog>;compatibleCatalog?:ReturnType<typeof createCompatibleCatalog>;probe?:typeof generate} = {}) {
  const catalog = options.catalog ?? createOpenRouterCatalog();
  const compatibleCatalog = options.compatibleCatalog ?? createCompatibleCatalog();
  const probe = options.probe ?? generate;
  const benchmarks=options.benchmarks??createModelBenchmarks();
  const checks = new Map<string,number>();
  app.get('/api/openrouter-models', async c => {
    c.header('Cache-Control','no-store');
    if (!await orgops.currentHuman(c.req.raw.headers)) return c.json({error:'Unauthorized'},401);
    try { return c.json(await catalog()); }
    catch { return c.json({error:'OpenRouter catalog unavailable. Use a configured model or an exact model ID.'},503); }
  });
  app.get('/api/agents/:name/model-benchmarks',async c=>{
    c.header('Cache-Control','no-store');
    const human=await orgops.currentHuman(c.req.raw.headers);
    if(!human||human.mustChangePassword)return c.json({error:'Sign in to compare models'},401);
    const name=c.req.param('name');
    const response=await orgops.humanRequest(`/api/agents/${encodeURIComponent(name)}`,c.req.raw.headers);
    if(!response.ok)return c.json({error:'Agent unavailable'},404);
    const agent=await response.json() as {visibility:string;ownerHumanId:string|null;mode:string};
    if(agent.visibility!=='PUBLIC'&&agent.ownerHumanId!==human.id)return c.json({error:'Only the owner can use this agent’s connection'},403);
    if(agent.mode==='WRAPPED')return c.json({error:'Model managed by external runtime'},400);
    try{
      const env=await orgops.agentModelEnv(name,options.engineToken??'');
      return c.json(await benchmarks(env.OPENROUTER_API_KEY??''));
    }catch{return c.json({error:'Intelligence scores are unavailable. You can still browse prices and choose a model below.'},503);}
  });
  // Which model providers this agent can call, so the picker offers only those. Labels only:
  // keys and the OpenAI-compatible base URL stay server-side.
  app.get('/api/agents/:name/model-providers',async c=>{
    c.header('Cache-Control','no-store');
    const human=await orgops.currentHuman(c.req.raw.headers);
    if(!human||human.mustChangePassword)return c.json({error:'Sign in to choose a model'},401);
    const name=c.req.param('name');
    const response=await orgops.humanRequest(`/api/agents/${encodeURIComponent(name)}`,c.req.raw.headers);
    if(!response.ok)return c.json({error:'Agent unavailable'},404);
    const agent=await response.json() as {visibility:string;ownerHumanId:string|null;mode:string};
    if(agent.visibility!=='PUBLIC'&&agent.ownerHumanId!==human.id)return c.json({error:'Only the owner can use this agent’s connection'},403);
    if(agent.mode==='WRAPPED')return c.json({error:'Model managed by external runtime'},400);
    try{
      const [openrouter,compatible]=await Promise.all(['openrouter',COMPATIBLE].map(p=>orgops.agentModelEnv(name,options.engineToken??'',p)));
      const ready=(env:Record<string,string|undefined>,p:string)=>providerEnvKeys(p).required.every(key=>env[key]);
      const providers=[
        ...(ready(openrouter,'openrouter')?[{id:'openrouter',label:'OpenRouter'}]:[]),
        ...(ready(compatible,COMPATIBLE)?[{id:'openai-compatible',label:modelProviderLabel('openai-compatible','',compatible.OPENAI_COMPATIBLE_BASE_URL)}]:[]),
      ];
      return c.json({providers});
    }catch{return c.json({error:'Model providers are unavailable.'},503);}
  });
  // The agent's OpenAI-compatible provider models (Fireworks), read with that agent's key and base URL.
  app.get('/api/agents/:name/compatible-models',async c=>{
    c.header('Cache-Control','no-store');
    const human=await orgops.currentHuman(c.req.raw.headers);
    if(!human||human.mustChangePassword)return c.json({error:'Sign in to choose a model'},401);
    const name=c.req.param('name');
    const response=await orgops.humanRequest(`/api/agents/${encodeURIComponent(name)}`,c.req.raw.headers);
    if(!response.ok)return c.json({error:'Agent unavailable'},404);
    const agent=await response.json() as {visibility:string;ownerHumanId:string|null;mode:string};
    if(agent.visibility!=='PUBLIC'&&agent.ownerHumanId!==human.id)return c.json({error:'Only the owner can use this agent’s connection'},403);
    if(agent.mode==='WRAPPED')return c.json({error:'Model managed by external runtime'},400);
    try{
      const env=await orgops.agentModelEnv(name,options.engineToken??'',COMPATIBLE);
      if(!env.OPENAI_COMPATIBLE_API_KEY||!env.OPENAI_COMPATIBLE_BASE_URL)return c.json({error:'No OpenAI-compatible key and base URL are configured for this agent.'},422);
      return c.json(await compatibleCatalog({apiKey:env.OPENAI_COMPATIBLE_API_KEY,baseUrl:env.OPENAI_COMPATIBLE_BASE_URL}));
    }catch{return c.json({error:'The provider’s model list is unavailable. You can still enter an exact model ID.'},503);}
  });
  app.post('/api/agents/:name/model-check', bodyLimit({maxSize:2048}), async c => {
    c.header('Cache-Control','no-store');
    const human = await orgops.currentHuman(c.req.raw.headers);
    if (!human || human.mustChangePassword) return c.json({error:'Sign in to test a model'},401);
    const name = c.req.param('name');
    const response = await orgops.humanRequest(`/api/agents/${encodeURIComponent(name)}`,c.req.raw.headers);
    if (!response.ok) return c.json({error:'Agent is unavailable'},response.status === 404 ? 404 : 403);
    const agent = await response.json() as {visibility:string;ownerHumanId:string|null;mode:string};
    if (agent.visibility !== 'PUBLIC' && agent.ownerHumanId !== human.id) return c.json({error:'Only the agent owner can test its credentials'},403);
    if (agent.mode === 'WRAPPED') return c.json({error:'This agent’s model is managed by its external runtime'},400);
    const body = await c.req.json().catch(() => null);
    const raw = typeof body?.model === 'string' ? body.model.trim() : '';
    // OpenRouter IDs stay the default; an openai-compatible reference is tested with that provider's keys.
    const compatible = raw.startsWith(COMPATIBLE);
    const model = compatible ? raw.slice(COMPATIBLE.length) : raw.replace(/^openrouter:/,'');
    if (compatible && (model.length > 180 || !compatibleModelName.test(model))) return c.json({error:'Enter an OpenAI-compatible model such as openai-compatible:accounts/fireworks/models/glm-5p3.'},400);
    if (!compatible && (model.length > 180 || !modelSlug.test(model))) return c.json({error:'Enter an OpenRouter ID such as google/gemini-2.5-flash. Variant suffixes are not supported by this runtime.'},400);
    const reference = compatible ? `${COMPATIBLE}${model}` : `openrouter:${model}`;
    const now = Date.now();
    for (const [key,time] of checks) if (now-time > 60_000) checks.delete(key);
    if (checks.has(human.id) && now-checks.get(human.id)! < 30_000) return c.json({error:'Wait 30 seconds between connection tests'},429);
    checks.set(human.id,now);
    try {
      const env = await orgops.agentModelEnv(name,options.engineToken ?? '',reference);
      if (providerEnvKeys(reference).required.some(key => !env[key])) return c.json({error:compatible
        ? 'No OpenAI-compatible API key and base URL are configured for this agent. Add OPENAI_COMPATIBLE_API_KEY and OPENAI_COMPATIBLE_BASE_URL in administration first.'
        : 'No OpenRouter key is configured for this agent. Add it in administration first.'},422);
      // A label derived from the base URL host; the URL itself stays server-side.
      const provider = modelProviderLabel(compatible ? 'openai-compatible' : 'openrouter', model, env.OPENAI_COMPATIBLE_BASE_URL);
      // Never send this agent's instructions, conversations or real tools.
      let toolCalled = false;
      const result = await probe(reference,[{role:'user',content:'Call nest_connection_check with value "ok" once to verify tool calling. Do nothing else.'}],{
        env,maxTokens:256,maxSteps:1,abortSignal:AbortSignal.timeout(20_000),
        tools:{nest_connection_check:{description:'Harmless connection check; no external effects.',inputSchema:z.object({value:z.literal('ok')}),execute:() => {toolCalled=true;return 'ok';}}},
      });
      if (!toolCalled) return c.json({error:result.text ? 'The model responded, but did not complete the tool-call check. Try another model or retry.' : 'No usable tool response received. Try another model or retry.'},422);
      return c.json({reference,provider,latencyMs:Date.now()-now,tools:true});
    } catch {
      return c.json({error:`Connection check failed or timed out. Check the model ID, agent’s ${compatible ? 'OpenAI-compatible key and base URL' : 'OpenRouter key'}, credits and provider availability. Your saved model is unchanged.`},502);
    }
  });
}
