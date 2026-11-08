import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp as createEngine } from '../../../vendor/orgops/apps/api/src/app';
import { createOrgOpsClient } from '@nest/orgops-client';
import { createApp } from './app';

describe('canvas board against the unchanged engine', () => {
  let dir: string, engine: ReturnType<typeof createEngine>, product: ReturnType<typeof createApp>;
  let owner: Record<string, string>, mate: Record<string, string>, mateId: string;
  const json = { 'content-type': 'application/json' };
  const call = (h: Record<string, string>, method: string, path: string, body?: unknown) =>
    product.app.request(path, { method, headers: h, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const eventCount = async () => {
    const res = await call(owner, 'GET', '/api/events?limit=1000');
    expect(res.status).toBe(200);
    return ((await res.json()) as unknown[]).length;
  };
  const channel = async (h: Record<string, string>, name: string) => (await (await call(h, 'POST', '/api/channels', { name, visibility: 'PRIVATE' })).json()).id as string;
  const subscribe = (h: Record<string, string>, id: string, username: string) => call(h, 'POST', `/api/channels/${id}/subscribe`, { subscriberType: 'HUMAN', subscriberId: username });
  const board = async (h: Record<string, string>, id: string) => (await call(h, 'GET', `/api/canvases/${id}/board`)).json();

  let canvasId: string, a: string, b: string;
  const SECRET = 'Secret-Hiring-Plan';
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'nest-canvas-board-'));
    engine = createEngine({ dbPath: join(dir, 'engine.sqlite'), dataDir: dir, adminUser: 'owner', adminPass: 'password', runnerToken: 'runner-secret' });
    const client = createOrgOpsClient('http://engine', (async (url, init) => engine.app.fetch(new Request(url, init))) as typeof fetch);
    product = createApp({ orgops: client, dbPath: join(dir, 'product.sqlite'), canvasEnabled: true });
    const login = async (username: string, password: string) => {
      const r = await call(json, 'POST', '/api/auth/login', { username, password });
      return { ...json, cookie: r.headers.get('set-cookie')!.split(';')[0] };
    };
    owner = await login('owner', 'password');
    expect((await call(owner, 'POST', '/api/humans/invite', { username: 'mate', tempPassword: 'password' })).status).toBeLessThan(300);
    mateId = (await (await call(owner, 'GET', '/api/humans')).json()).find((h: any) => h.username === 'mate').id;
    engine.db.prepare('UPDATE humans SET must_change_password=0 WHERE id=?').run(mateId);
    mate = await login('mate', 'password');

    a = await channel(owner, SECRET);
    b = await channel(owner, 'Shared-Chat');
    await subscribe(owner, b, 'mate');
    canvasId = randomUUID();
    await call(owner, 'POST', '/api/canvases', { id: canvasId, name: 'Plan' });
    await call(owner, 'PUT', `/api/canvases/${canvasId}/members`, { visibility: 'shared', members: [{ humanId: mateId, role: 'edit' }], version: 0 });
  });
  afterEach(() => { product.store.close(); engine.db.close(); rmSync(dir, { recursive: true, force: true }); });

  const place = (h: Record<string, string>, cards: unknown[], extra: object = {}) => call(h, 'POST', `/api/canvases/${canvasId}/cards`, { cards, ...extra });

  it('shows an unseen chat as locked with no identifying data, and a seen one as open', async () => {
    const before = await eventCount();
    const placed = await place(owner, [{ channelId: a, x: 0, y: 0 }, { channelId: b, x: 400, y: 0 }]);
    expect(placed.status, await placed.clone().text()).toBe(201);
    const res = await call(mate, 'GET', `/api/canvases/${canvasId}/board`);
    const text = await res.text();
    expect(text).not.toContain(SECRET);
    const data = JSON.parse(text);
    const cards = Object.fromEntries(data.cards.map((c: any) => [c.channelId === b ? 'b' : 'a', c]));
    expect(cards.b).toMatchObject({ access: 'open', title: 'Shared-Chat', archived: false, projectId: null });
    expect(cards.b.participants).toEqual(expect.arrayContaining([{ subscriberType: 'HUMAN', subscriberId: 'mate' }]));
    expect(cards.a.access).toBe('locked');
    expect(cards.a.ownerLabel).toBe('owner');
    for (const k of ['title', 'participants', 'projectId', 'kind', 'canManage']) expect(cards.a).not.toHaveProperty(k);
    expect(data.canvas).toMatchObject({ id: canvasId, role: 'edit' });
    expect(await eventCount()).toBe(before);
  });

  it('prefers the product project name and never leaks it on locked cards', async () => {
    const room = await channel(owner, 'Project-Room');
    const project = { id: randomUUID(), channelId: room };
    expect((await call(owner, 'POST', '/api/projects', { id: project.id, name: 'Launch-Codename', description: 'Ship it', channelId: room })).status).toBe(201);
    await place(owner, [{ channelId: room, x: 0, y: 0 }]);
    const mine = await board(owner, canvasId);
    expect(mine.cards[0]).toMatchObject({ access: 'open', title: 'Launch-Codename', projectId: project.id });
    const text = await (await call(mate, 'GET', `/api/canvases/${canvasId}/board`)).text();
    expect(text).not.toContain('Launch-Codename');
    expect(text).not.toContain(project.id);
    expect(JSON.parse(text).cards[0].access).toBe('locked');
  });

  it('marks a card the caller placed but can no longer see as unavailable', async () => {
    const c = await channel(mate, 'Mates-Private');
    expect((await subscribe(mate, c, 'owner')).status).toBe(200);
    expect((await place(owner, [{ channelId: c, x: 0, y: 0 }])).status).toBe(201);
    expect((await board(owner, canvasId)).cards[0].access).toBe('open');
    expect((await call(mate, 'POST', `/api/channels/${c}/unsubscribe`, { subscriberType: 'HUMAN', subscriberId: 'owner' })).status).toBe(200);
    const text = await (await call(owner, 'GET', `/api/canvases/${canvasId}/board`)).text();
    expect(text).not.toContain('Mates-Private');
    expect(JSON.parse(text).cards[0]).toMatchObject({ access: 'unavailable', channelId: c });
    expect(JSON.parse(text).cards[0]).not.toHaveProperty('ownerLabel');
    // The teammate who can see it gets it open; a third party would see it locked.
    expect((await board(mate, canvasId)).cards[0].access).toBe('open');
  });

  it('answers ?etag=E with unchanged only while the resolved board is identical', async () => {
    await place(owner, [{ channelId: b, x: 0, y: 0 }]);
    const first = await board(owner, canvasId);
    expect(first.etag).toMatch(/^[0-9a-f]{64}$/);
    expect(await (await call(owner, 'GET', `/api/canvases/${canvasId}/board?etag=${first.etag}`)).json()).toEqual({ unchanged: true });
    expect((await (await call(owner, 'GET', `/api/canvases/${canvasId}/board?etag=`)).json()).cards).toHaveLength(1);
    expect((await (await call(owner, 'GET', `/api/canvases/${canvasId}/board?etag=nope`)).json()).etag).toBe(first.etag);
    // An engine-side rename never bumps the canvas version but must change the etag.
    expect((await call(owner, 'PATCH', `/api/channels/${b}`, { name: 'Renamed-Chat' })).status).toBe(200);
    const after = await (await call(owner, 'GET', `/api/canvases/${canvasId}/board?etag=${first.etag}`)).json();
    expect(after.unchanged).toBeUndefined();
    expect(after.canvas.version).toBe(first.canvas.version);
    expect(after.cards[0].title).toBe('Renamed-Chat');
    expect(after.etag).not.toBe(first.etag);
  });

  it('moves an area with its cards and reports the moved cards', async () => {
    const before = await eventCount();
    const area = { id: randomUUID(), title: 'Hiring', x: 0, y: 0, w: 800, h: 400 };
    expect((await call(mate, 'POST', `/api/canvases/${canvasId}/areas`, area)).status).toBe(201);
    await place(owner, [{ channelId: b, x: 100, y: 100 }, { channelId: a, x: 5000, y: 5000 }]);
    const moved = await call(mate, 'PATCH', `/api/canvases/${canvasId}/areas/${area.id}?moveCards=1`, { x: 1000, y: 50, version: 0 });
    expect(moved.status).toBe(200);
    const body = await moved.json();
    expect(body.area).toMatchObject({ id: area.id, x: 1000, y: 50, version: 1 });
    expect(body.cards.map((c: any) => c.channelId)).toEqual([b]);
    expect(body.cards[0]).toMatchObject({ x: 1100, y: 150 });
    expect(body.areas).toEqual([]);
    const after = await board(owner, canvasId);
    expect(after.cards.find((c: any) => c.channelId === b)).toMatchObject({ x: 1100, y: 150 });
    expect(after.cards.find((c: any) => c.channelId === a)).toMatchObject({ x: 5000, y: 5000 });
    expect((await call(mate, 'DELETE', `/api/canvases/${canvasId}/areas/${area.id}?version=1`)).status).toBe(204);
    expect((await board(owner, canvasId)).areas).toEqual([]);
    expect((await board(owner, canvasId)).cards).toHaveLength(2);
    expect(await eventCount()).toBe(before);
  });

  it('rejects a channel the caller cannot see without naming any title', async () => {
    const res = await place(mate, [{ channelId: a, x: 0, y: 0 }]);
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).not.toContain(SECRET);
    expect(await board(owner, canvasId)).toMatchObject({ cards: [] });
  });

  it('answers a stale card patch with 409 and the current row, without leaking a locked card', async () => {
    await place(owner, [{ channelId: a, x: 0, y: 0 }, { channelId: b, x: 400, y: 0 }]);
    expect((await call(owner, 'PATCH', `/api/canvases/${canvasId}/cards/${b}`, { x: 10, y: 10, version: 0 })).status).toBe(200);
    const stale = await call(mate, 'PATCH', `/api/canvases/${canvasId}/cards/${b}`, { x: 20, y: 20, version: 0 });
    expect(stale.status).toBe(409);
    expect((await stale.json()).current).toMatchObject({ channelId: b, x: 10, y: 10, version: 1 });
    // A teammate may move a locked card, but the response carries no project id.
    const locked = await call(mate, 'PATCH', `/api/canvases/${canvasId}/cards/${a}`, { x: 7, y: 7, version: 0 });
    expect(locked.status).toBe(200);
    expect(await locked.json()).toMatchObject({ channelId: a, x: 7, projectId: null });
  });

  it('forbids a view-role teammate from changing layout', async () => {
    await call(owner, 'PUT', `/api/canvases/${canvasId}/members`, { visibility: 'shared', members: [{ humanId: mateId, role: 'view' }], version: 1 });
    expect((await place(mate, [{ channelId: b, x: 0, y: 0 }])).status).toBe(403);
    expect((await call(mate, 'POST', `/api/canvases/${canvasId}/areas`, { id: randomUUID(), title: 'x', x: 0, y: 0, w: 200, h: 200 })).status).toBe(403);
    expect((await call(mate, 'GET', `/api/canvases/${canvasId}/board`)).status).toBe(200);
  });

  it('places idempotently, removes with a version, and adds an area in the same call', async () => {
    const area = { id: randomUUID(), title: 'From these', x: 0, y: 0, w: 900, h: 500 };
    const first = await place(owner, [{ channelId: b, x: 10, y: 10 }], { area });
    expect(first.status, await first.clone().text()).toBe(201);
    expect((await first.json()).areas).toHaveLength(1);
    await place(owner, [{ channelId: b, x: 99, y: 99 }]);
    const cards = (await board(owner, canvasId)).cards;
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ x: 10, y: 10 });
    expect((await call(owner, 'DELETE', `/api/canvases/${canvasId}/cards/${b}?version=5`)).status).toBe(409);
    expect((await call(owner, 'DELETE', `/api/canvases/${canvasId}/cards/${b}?version=0`)).status).toBe(204);
    expect((await call(owner, 'DELETE', `/api/canvases/${canvasId}/cards/${b}`)).status).toBe(400);
  });

  it('labels a card whose owner cannot be resolved as a teammate', async () => {
    const pub = (await (await call(owner, 'POST', '/api/channels', { name: 'Open-Chat' })).json()).id as string;
    await place(owner, [{ channelId: pub, x: 0, y: 0 }]);
    const row = product.store.canvases.cards(canvasId)[0];
    expect(row.ownerLabel).toBe('a teammate');
  });

  it('reports shifted nested areas from the same transaction', async () => {
    const outer = { id: randomUUID(), title: 'Outer', x: 0, y: 0, w: 2000, h: 2000 };
    const inner = { id: randomUUID(), title: 'Inner', x: 100, y: 100, w: 400, h: 400 };
    await call(owner, 'POST', `/api/canvases/${canvasId}/areas`, outer);
    await call(owner, 'POST', `/api/canvases/${canvasId}/areas`, inner);
    const res = await (await call(owner, 'PATCH', `/api/canvases/${canvasId}/areas/${outer.id}?moveCards=1`, { x: 10, y: 20, version: 0 })).json();
    expect(res.areas).toMatchObject([{ id: inner.id, x: 110, y: 120 }]);
    expect(res.cards).toEqual([]);
  });

  it('never leaks a project id, project name or owner label in card conflicts on a locked card', async () => {
    const room = await channel(owner, 'Hidden-Room');
    const projectId = randomUUID();
    expect((await call(owner, 'POST', '/api/projects', { id: projectId, name: 'Codename-Zeta', description: 'x', channelId: room })).status).toBe(201);
    await place(owner, [{ channelId: room, x: 0, y: 0 }]);
    const patch = await call(mate, 'PATCH', `/api/canvases/${canvasId}/cards/${room}`, { x: 1, y: 1, version: 999 });
    const del = await call(mate, 'DELETE', `/api/canvases/${canvasId}/cards/${room}?version=999`);
    for (const res of [patch, del]) {
      expect(res.status).toBe(409);
      const text = await res.text();
      expect(text).not.toContain(projectId);
      expect(text).not.toContain('Codename-Zeta');
      expect(text).not.toContain('ownerLabel');
      expect(JSON.parse(text).current).toMatchObject({ channelId: room });
    }
    // The owner, who can open the chat, still gets the full row.
    const own = await call(owner, 'DELETE', `/api/canvases/${canvasId}/cards/${room}?version=999`);
    expect((await own.json()).current).toMatchObject({ projectId });
  });
});
