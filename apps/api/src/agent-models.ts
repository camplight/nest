import type { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { productHeaders, type OrgOpsClient } from '@nest/orgops-client';

// Engine authentication and permissions remain authoritative, including scoped runners.
export function registerAgentModelRoutes(app: Hono, orgops: OrgOpsClient, defaultModelId?: string) {
  app.get('/api/agent-models', async c => {
    c.header('Cache-Control', 'no-store');
    const response = await orgops.request('/api/models', {headers:c.req.raw.headers});
    if (!response.ok) return new Response(response.body, {status:response.status});
    const models = orgops.nativeModels(await response.json());
    return c.json({models, defaultModel:models.find(m => m.id === defaultModelId || m.reference === defaultModelId)?.reference ?? null});
  });
  app.post('/api/agents', bodyLimit({maxSize:1_000_000}), async c => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return c.json({error:'Expected an agent object'},400);
    if (body.mode !== 'WRAPPED' && (body.modelId == null || body.modelId === '')) {
      const response = await orgops.request('/api/models', {headers:c.req.raw.headers});
      if (!response.ok) return new Response(response.body, {status:response.status});
      const models = orgops.nativeModels(await response.json());
      const model = models.find(m => m.id === defaultModelId || m.reference === defaultModelId);
      if (!model) return c.json({error:'No enabled default model is configured. Choose a model or ask your administrator.'},503);
      body.modelId = model.reference;
    }
    const headers = new Headers(c.req.raw.headers);
    headers.set('content-type','application/json');
    const response = await orgops.request('/api/agents',{method:'POST',headers,body:JSON.stringify(body)});
    return new Response(response.body,{status:response.status,headers:productHeaders(response.headers)});
  });
}
