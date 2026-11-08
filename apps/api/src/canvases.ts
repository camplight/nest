import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import type { ProductDb } from '@nest/db';
import { CanvasConflictError, CanvasForbiddenError, CanvasLimitError } from '@nest/db';
import type { Human, OrgOpsClient } from '@nest/orgops-client';
import { NewCanvasSchema, CanvasRenameSchema, CanvasSharingSchema, HiddenSchema } from '@nest/schemas';

type Channel = { id: string };
type Person = { id: string; username: string };
const uuid = z.string().uuid();

export function registerCanvasRoutes(app: Hono, { store, orgops, enabled }: { store: ProductDb; orgops: OrgOpsClient; enabled: boolean }) {
  const routes = new Hono<{ Variables: { human: Human; channels: Channel[] } }>();
  const canvases = store.canvases;
  routes.onError((error, c) => {
    if (error instanceof HTTPException) return c.json({ error: error.message }, error.status);
    if (error instanceof CanvasConflictError) return c.json({ error: 'Canvas changed', current: error.current }, 409);
    if (error instanceof CanvasForbiddenError) return c.json({ error: error.message }, 403);
    if (error instanceof CanvasLimitError) return c.json({ error: error.message }, 400);
    console.error('Canvas request failed:', error.name);
    return c.json({ error: 'The engine is unavailable. Canvas data is retained; refresh and retry.' }, 502);
  });
  const notFound = () => new HTTPException(404, { message: 'Not found' });
  function parse<T>(schema: z.ZodType<T>, value: unknown): T {
    const result = schema.safeParse(value);
    if (!result.success) throw new HTTPException(400, { message: result.error.issues.map(i => i.message).join('; ') });
    return result.data;
  }
  const body = async (c: { req: { json(): Promise<unknown> } }) => c.req.json().catch(() => null);

  routes.use('/api/canvases', bodyLimit({ maxSize: 64_000, onError: c => c.json({ error: 'Request too large' }, 413) }));
  routes.use('/api/canvases/*', bodyLimit({ maxSize: 64_000, onError: c => c.json({ error: 'Request too large' }, 413) }));
  const auth = async (c: any, next: () => Promise<void>) => {
    const human = await orgops.currentHuman(c.req.raw.headers);
    if (!human) return c.json({ error: 'Unauthorized' }, 401);
    if (human.mustChangePassword) return c.json({ error: 'Complete password setup first' }, 403);
    c.set('human', human);
    c.header('Cache-Control', 'no-store');
    await next();
  };
  routes.use('/api/canvases', auth);
  routes.use('/api/canvases/*', auth);
  routes.get('/api/canvases/availability', c => c.json({ available: enabled }));
  routes.use('/api/canvases', async (_c, next) => { if (!enabled) throw notFound(); await next(); });
  routes.use('/api/canvases/*', async (c, next) => {
    if (!enabled) throw notFound();
    c.set('channels', await orgops.humanJson<Channel[]>('/api/channels', c.req.raw.headers));
    await next();
  });

  // Registered before /:id so these literal paths are never read as canvas ids.
  routes.get('/api/canvases/hidden', c => c.json({ channelIds: canvases.hidden(c.get('human').id) }));
  routes.post('/api/canvases/hidden', async c => {
    const input = parse(HiddenSchema, await body(c));
    const human = c.get('human');
    // Only channels the caller can see are stored; others are dropped silently.
    const visible = new Set(c.get('channels').map(channel => channel.id));
    canvases.setHidden(human.id, input.channelIds.filter(id => visible.has(id)), input.hidden);
    return c.json({ channelIds: canvases.hidden(human.id) });
  });

  routes.get('/api/canvases', c => c.json(canvases.list(c.get('human').id)));
  routes.post('/api/canvases', async c => {
    const input = parse(NewCanvasSchema, await body(c));
    const human = c.get('human');
    const used = store.db.prepare('SELECT owner_id AS ownerId, name FROM product_canvases WHERE id=?').get(input.id) as { ownerId: string; name: string } | undefined;
    if (used) {
      if (used.ownerId === human.id && used.name === input.name) return c.json(canvases.get(input.id, human.id));
      return c.json({ error: 'Canvas ID already used' }, 409);
    }
    return c.json(canvases.create(input, human.id), 201);
  });

  routes.all('/api/canvases/:id/*', async (c, next) => { if (!uuid.safeParse(c.req.param('id')).success) throw notFound(); await next(); });
  routes.all('/api/canvases/:id', async (c, next) => { if (!uuid.safeParse(c.req.param('id')).success) throw notFound(); await next(); });
  // Missing and inaccessible canvases are indistinguishable (404); only then can a write answer 403.
  function visible(c: { req: { param(name: string): string }; get(key: 'human'): Human }) {
    const canvas = canvases.get(c.req.param('id'), c.get('human').id);
    if (!canvas) throw notFound();
    return canvas;
  }
  routes.patch('/api/canvases/:id', async c => {
    const canvas = visible(c);
    const input = parse(CanvasRenameSchema, await body(c));
    return c.json(canvases.rename(canvas.id, input.name, input.version, c.get('human').id));
  });
  routes.delete('/api/canvases/:id', c => {
    const canvas = visible(c);
    const version = Number(c.req.query('version'));
    if (!c.req.query('version') || !Number.isInteger(version) || version < 0) throw new HTTPException(400, { message: 'version is required' });
    canvases.remove(canvas.id, version, c.get('human').id);
    return c.body(null, 204);
  });

  async function people(headers: HeadersInit) { return orgops.humanJson<Person[]>('/api/humans', headers); }
  function sharing(canvasId: string, humans: Person[], visibility: string) {
    const names = new Map(humans.map(h => [h.id, h.username]));
    return { visibility, members: canvases.members(canvasId).map(m => ({ humanId: m.humanId, username: names.get(m.humanId) ?? m.humanId, role: m.role })) };
  }
  routes.get('/api/canvases/:id/members', async c => {
    const canvas = visible(c);
    return c.json(sharing(canvas.id, await people(c.req.raw.headers), canvas.visibility));
  });
  routes.put('/api/canvases/:id/members', async c => {
    const canvas = visible(c);
    const human = c.get('human');
    if (canvas.role !== 'owner') throw new CanvasForbiddenError('Only the owner can change sharing');
    const input = parse(CanvasSharingSchema, await body(c));
    const humans = await people(c.req.raw.headers);
    const known = new Set(humans.map(h => h.id));
    if (input.members.some(m => !known.has(m.humanId))) throw new HTTPException(400, { message: 'Unknown teammate' });
    const updated = canvases.setSharing(canvas.id, input, human.id);
    return c.json(sharing(canvas.id, humans, updated.visibility));
  });

  routes.all('/api/canvases/*', () => { throw notFound(); });
  app.route('/', routes);
}
