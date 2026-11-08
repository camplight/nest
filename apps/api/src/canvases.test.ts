import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp as createEngine } from '../../../vendor/orgops/apps/api/src/app';
import { createOrgOpsClient } from '@nest/orgops-client';
import { createApp } from './app';

describe('canvas API against the unchanged engine', () => {
  let dir: string, engine: ReturnType<typeof createEngine>, product: ReturnType<typeof createApp>;
  let owner: Record<string, string>, mate: Record<string, string>, mateId: string;
  const json = { 'content-type': 'application/json' };
  const call = (h: Record<string, string>, method: string, path: string, body?: unknown) =>
    product.app.request(path, { method, headers: h, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const engineChannels = async () => await (await engine.app.request('/api/channels', { headers: { cookie: owner.cookie } })).text();
  let before = '';
  async function boot(canvasEnabled: boolean) {
    dir = mkdtempSync(join(tmpdir(), 'nest-canvas-test-'));
    engine = createEngine({ dbPath: join(dir, 'engine.sqlite'), dataDir: dir, adminUser: 'owner', adminPass: 'password', runnerToken: 'runner-secret' });
    const client = createOrgOpsClient('http://engine', (async (url, init) => engine.app.fetch(new Request(url, init))) as typeof fetch);
    product = createApp({ orgops: client, dbPath: join(dir, 'product.sqlite'), canvasEnabled });
    const login = async (username: string, password: string) => {
      const r = await call(json, 'POST', '/api/auth/login', { username, password });
      return { ...json, cookie: r.headers.get('set-cookie')!.split(';')[0] };
    };
    owner = await login('owner', 'password');
    expect((await call(owner, 'POST', '/api/humans/invite', { username: 'mate', tempPassword: 'password' })).status).toBeLessThan(300);
    const humans = await (await call(owner, 'GET', '/api/humans')).json();
    mateId = humans.find((h: any) => h.username === 'mate').id;
    engine.db.prepare('UPDATE humans SET must_change_password=0 WHERE id=?').run(mateId);
    mate = await login('mate', 'password');
    before = await engineChannels();
  }
  afterEach(async () => {
    if (before) expect(await engineChannels()).toBe(before);
    before = '';
    product.store.close(); engine.db.close(); rmSync(dir, { recursive: true, force: true });
  });

  describe('flag off', () => {
    beforeEach(() => boot(false));
    it('reports unavailable and hides every other route', async () => {
      expect(await (await call(owner, 'GET', '/api/canvases/availability')).json()).toEqual({ available: false });
      for (const p of ['/api/canvases', '/api/canvases/hidden', `/api/canvases/${randomUUID()}`, '/api/canvases/x/y/z'])
        expect(await call(owner, 'GET', p).then(r => [r.status])).toEqual([404]);
      expect((await call(owner, 'POST', '/api/canvases', { id: randomUUID(), name: 'x' })).status).toBe(404);
    });
  });

  describe('flag on', () => {
    beforeEach(() => boot(true));
    const create = async (name = 'Plan', id: string = randomUUID()) => { const r = await call(owner, 'POST', '/api/canvases', { id, name }); return { r, id }; };

    it('requires authentication and reports availability', async () => {
      expect((await product.app.request('/api/canvases')).status).toBe(401);
      expect((await product.app.request('/api/canvases/availability')).status).toBe(401);
      expect(await (await call(owner, 'GET', '/api/canvases/availability')).json()).toEqual({ available: true });
    });

    it('creates, lists, and rejects stale renames with the current state', async () => {
      const { r, id } = await create();
      expect(r.status).toBe(201);
      expect(await (await call(owner, 'GET', '/api/canvases')).json()).toMatchObject([{ id, name: 'Plan', role: 'owner', version: 0 }]);
      const ok = await call(owner, 'PATCH', `/api/canvases/${id}`, { name: 'Renamed', version: 0 });
      expect(ok.status).toBe(200);
      const stale = await call(owner, 'PATCH', `/api/canvases/${id}`, { name: 'Again', version: 0 });
      expect(stale.status).toBe(409);
      expect(await stale.json()).toMatchObject({ error: 'Canvas changed', current: { name: 'Renamed' } });
      expect((await call(owner, 'PATCH', `/api/canvases/${id}`, { name: '  ', version: 1 })).status).toBe(400);
    });

    it('treats a reused id idempotently for the same owner and name, otherwise 409', async () => {
      const { id } = await create('Plan');
      expect((await call(owner, 'POST', '/api/canvases', { id, name: 'Plan' })).status).toBe(200);
      expect(await (await call(owner, 'POST', '/api/canvases', { id, name: 'Other' })).json()).toEqual({ error: 'Canvas ID already used' });
      expect((await call(mate, 'POST', '/api/canvases', { id, name: 'Plan' })).status).toBe(409);
    });

    it('404s for malformed or inaccessible ids', async () => {
      const { id } = await create();
      expect((await call(owner, 'PATCH', '/api/canvases/not-a-uuid', { name: 'x', version: 0 })).status).toBe(404);
      expect((await call(mate, 'PATCH', `/api/canvases/${id}`, { name: 'x', version: 0 })).status).toBe(404);
      expect((await call(mate, 'GET', `/api/canvases/${id}/members`)).status).toBe(404);
      expect((await call(owner, 'DELETE', `/api/canvases/${randomUUID()}?version=0`)).status).toBe(404);
    });

    it('shares by role and enforces what each role may do', async () => {
      const { id } = await create();
      const share = await call(owner, 'PUT', `/api/canvases/${id}/members`, { visibility: 'shared', members: [{ humanId: mateId, role: 'view' }], version: 0 });
      expect(share.status).toBe(200);
      expect(await share.json()).toEqual({ visibility: 'shared', members: [{ humanId: mateId, username: 'mate', role: 'view' }] });
      expect(await (await call(mate, 'GET', '/api/canvases')).json()).toMatchObject([{ id, role: 'view' }]);
      expect((await call(mate, 'GET', `/api/canvases/${id}/members`)).status).toBe(200);
      expect((await call(mate, 'PATCH', `/api/canvases/${id}`, { name: 'Mine', version: 1 })).status).toBe(403);
      expect((await call(mate, 'PUT', `/api/canvases/${id}/members`, { visibility: 'private', members: [], version: 1 })).status).toBe(403);
      expect((await call(mate, 'DELETE', `/api/canvases/${id}?version=1`)).status).toBe(403);
    });

    it('rejects unknown members and stale sharing versions', async () => {
      const { id } = await create();
      expect((await call(owner, 'PUT', `/api/canvases/${id}/members`, { visibility: 'shared', members: [{ humanId: randomUUID(), role: 'edit' }], version: 0 })).status).toBe(400);
      expect((await call(owner, 'PUT', `/api/canvases/${id}/members`, { visibility: 'shared', members: [], version: 9 })).status).toBe(409);
    });

    it('deletes with a version and removes access', async () => {
      const { id } = await create();
      await call(owner, 'PUT', `/api/canvases/${id}/members`, { visibility: 'shared', members: [{ humanId: mateId, role: 'edit' }], version: 0 });
      expect((await call(owner, 'DELETE', `/api/canvases/${id}`)).status).toBe(400);
      expect((await call(owner, 'DELETE', `/api/canvases/${id}?version=0`)).status).toBe(409);
      expect((await call(owner, 'DELETE', `/api/canvases/${id}?version=1`)).status).toBe(204);
      expect((await call(mate, 'GET', `/api/canvases/${id}/members`)).status).toBe(404);
    });

    it('stores hides only for visible channels', async () => {
      const mine = await (await call(owner, 'POST', '/api/channels', { name: 'Mine', visibility: 'PRIVATE' })).json();
      before = await engineChannels();
      const theirs = await (await call(mate, 'POST', '/api/channels', { name: 'Theirs', visibility: 'PRIVATE' })).json();
      before = await engineChannels();
      const res = await call(owner, 'POST', '/api/canvases/hidden', { channelIds: [mine.id, theirs.id], hidden: true });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ channelIds: [mine.id] });
      expect(await (await call(owner, 'GET', '/api/canvases/hidden')).json()).toEqual({ channelIds: [mine.id] });
      expect(await (await call(mate, 'GET', '/api/canvases/hidden')).json()).toEqual({ channelIds: [] });
      expect(await (await call(owner, 'POST', '/api/canvases/hidden', { channelIds: [mine.id], hidden: false })).json()).toEqual({ channelIds: [] });
      expect((await call(owner, 'POST', '/api/canvases/hidden', { channelIds: [], hidden: true })).status).toBe(400);
    });

    it('returns 404 for unknown canvas paths', async () => {
      expect((await call(owner, 'GET', '/api/canvases/nope/what/ever')).status).toBe(404);
    });
  });
});
