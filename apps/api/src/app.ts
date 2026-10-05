import { registerProjectRoutes } from './projects';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { openProductDb, type ProductDb } from '@nest/db';
import { BrandingSchema } from '@nest/schemas';
import { createOrgOpsClient, productHeaders, type OrgOpsClient } from '@nest/orgops-client';

export function createApp(config: { store?: ProductDb; orgops?: OrgOpsClient; dbPath?: string; orgopsUrl?: string } = {}) {
  const store = config.store ?? openProductDb(config.dbPath ?? resolve(fileURLToPath(new URL('../../../', import.meta.url)), process.env.NEST_PRODUCT_DB_PATH ?? '.nest-product/nest.sqlite'));
  const orgops = config.orgops ?? createOrgOpsClient(config.orgopsUrl ?? process.env.ORGOPS_URL ?? 'http://127.0.0.1:8788');
  const app = new Hono();
  app.onError((error, c) => {
    console.error('Nest request failed:', error.name);
    return c.json({error: 'Upstream service unavailable'}, 502);
  });
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
  registerProjectRoutes(app, {store, orgops});
  // Unknown product endpoints do not fall through to a privileged service account.
  app.all('/api/branding/*', c => c.json({error: 'Not found'}, 404));
  const proxy = async (c: any) => {
    const source = c.req.raw as Request;
    const url = new URL(source.url);
    const headers = new Headers(source.headers);
    headers.set('x-forwarded-host', url.host);
    headers.set('x-forwarded-proto', source.headers.get('x-forwarded-proto') ?? url.protocol.slice(0, -1));
    const init: RequestInit & {duplex?: string} = { method: source.method, headers, signal: source.signal };
    if (!['GET', 'HEAD'].includes(source.method)) { init.body = source.body; init.duplex = 'half'; }
    const response = await orgops.request(url.pathname + url.search, init);
    return new Response(response.body, { status: response.status, headers: productHeaders(response.headers) });
  };
  app.all('/api/*', proxy);
  app.all('/v1/*', proxy);
  return { app, store, orgops };
}
