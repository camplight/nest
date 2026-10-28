import type { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { generate } from '@orgops/llm';
import type { OrgOpsClient } from '@nest/orgops-client';
import { createOpenRouterCatalog, modelSlug } from './openrouter-catalog';

export function registerModelPickerRoutes(app:Hono, orgops:OrgOpsClient, options:{engineToken?:string;catalog?:ReturnType<typeof createOpenRouterCatalog>;probe?:typeof generate} = {}) {
  const catalog = options.catalog ?? createOpenRouterCatalog();
  const probe = options.probe ?? generate;
  const checks = new Map<string,number>();
  app.get('/api/openrouter-models', async c => {
    c.header('Cache-Control','no-store');
    if (!await orgops.currentHuman(c.req.raw.headers)) return c.json({error:'Unauthorized'},401);
    try { return c.json(await catalog()); }
    catch { return c.json({error:'OpenRouter catalog unavailable. Use a configured model or an exact model ID.'},503); }
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
    const model = typeof body?.model === 'string' ? body.model.trim().replace(/^openrouter:/,'') : '';
    if (model.length > 180 || !modelSlug.test(model)) return c.json({error:'Enter an OpenRouter ID such as google/gemini-2.5-flash. Variant suffixes are not supported by this runtime.'},400);
    const now = Date.now();
    for (const [key,time] of checks) if (now-time > 60_000) checks.delete(key);
    if (checks.has(human.id) && now-checks.get(human.id)! < 30_000) return c.json({error:'Wait 30 seconds between connection tests'},429);
    checks.set(human.id,now);
    try {
      const env = await orgops.agentModelEnv(name,options.engineToken ?? '');
      if (!env.OPENROUTER_API_KEY) return c.json({error:'No OpenRouter key is configured for this agent. Add it in administration first.'},422);
      // Never send this agent's instructions, conversations or real tools.
      let toolCalled = false;
      const result = await probe(`openrouter:${model}`,[{role:'user',content:'Call nest_connection_check with value "ok" once to verify tool calling. Do nothing else.'}],{
        env,maxTokens:256,maxSteps:1,abortSignal:AbortSignal.timeout(20_000),
        tools:{nest_connection_check:{description:'Harmless connection check; no external effects.',inputSchema:z.object({value:z.literal('ok')}),execute:() => {toolCalled=true;return 'ok';}}},
      });
      if (!toolCalled) return c.json({error:result.text ? 'The model responded, but did not complete the tool-call check. Try another model or retry.' : 'No usable tool response received. Try another model or retry.'},422);
      return c.json({reference:`openrouter:${model}`,latencyMs:Date.now()-now,tools:true});
    } catch {
      return c.json({error:'Connection check failed or timed out. Check the model ID, agent’s OpenRouter key, credits and provider availability. Your saved model is unchanged.'},502);
    }
  });
}
