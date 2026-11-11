import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp as createEngine } from '../../../../vendor/orgops/apps/api/src/app';
import { createOrgOpsClient, type EngineEvent } from '@nest/orgops-client';
import { createApp } from '../app';

const RUNNER = 'runner-secret';
type H = Record<string, string>;

describe('the link API against the unchanged engine', () => {
  let dir: string, engine: ReturnType<typeof createEngine>, product: ReturnType<typeof createApp>;
  let client: ReturnType<typeof createOrgOpsClient>;
  let owner: H, mate: H, reader: H, stranger: H, ownerId: string, mateId: string, strangerId: string;
  let a: string, b: string;
  const json = { 'content-type': 'application/json' };
  const call = (h: H, method: string, path: string, body?: unknown) =>
    product.app.request(path, { method, headers: h, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const engineCall = (method: string, path: string, body?: unknown) =>
    engine.app.request(path, { method, headers: { ...json, 'x-orgops-runner-token': RUNNER }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const boot = (extra: Parameters<typeof createApp>[0] = {}) => createApp({
    orgops: client, dbPath: join(dir, 'product.sqlite'), canvasEnabled: true, contextFilesDir: join(dir, 'context-files'),
    connectionEngineToken: RUNNER, switchyardName: 'Switchyard', switchyardWorkspaceRoot: join(dir, 'managed'), ...extra,
  });
  const login = async (username: string) => {
    const r = await call(json, 'POST', '/api/auth/login', { username, password: 'password' });
    return { ...json, cookie: r.headers.get('set-cookie')!.split(';')[0] };
  };
  const invite = async (username: string) => {
    expect((await call(owner, 'POST', '/api/humans/invite', { username, tempPassword: 'password' })).status).toBeLessThan(300);
    const id = (await (await call(owner, 'GET', '/api/humans')).json()).find((h: any) => h.username === username).id as string;
    engine.db.prepare('UPDATE humans SET must_change_password=0 WHERE id=?').run(id);
    return { id, headers: await login(username) };
  };
  const chat = async (name: string, members: { type: 'HUMAN' | 'AGENT' | 'TEAM'; id: string }[]) => {
    const id = (await (await call(owner, 'POST', '/api/channels', { name, visibility: 'PRIVATE' })).json()).id as string;
    for (const m of members) expect((await call(owner, 'POST', `/api/channels/${id}/subscribe`, { subscriberType: m.type, subscriberId: m.id })).status).toBe(200);
    return id;
  };
  const participants = async (channelId: string) =>
    ((await (await call(owner, 'GET', '/api/channels?includeArchived=1')).json()) as { id: string; participants: { subscriberType: string; subscriberId: string }[] }[])
      .find(c => c.id === channelId)!.participants;
  const engineEvents = () => (engine.db.prepare('SELECT COUNT(*) n FROM events').get() as { n: number }).n;
  const link = (h: H, body: Record<string, unknown>) => call(h, 'POST', '/api/flows/links', { id: randomUUID(), ...body });

  beforeEach(async () => {
    vi.stubEnv('ORGOPS_MASTER_KEY', Buffer.alloc(32, 99).toString('base64'));
    dir = mkdtempSync(join(tmpdir(), 'nest-links-test-'));
    engine = createEngine({ dbPath: join(dir, 'engine.sqlite'), dataDir: dir, projectRoot: dir, adminUser: 'owner', adminPass: 'password', runnerToken: RUNNER });
    client = createOrgOpsClient('http://engine', (async (url, init) => engine.app.fetch(new Request(url, init))) as typeof fetch);
    product = boot();
    owner = await login('owner');
    ownerId = (await (await call(owner, 'GET', '/api/humans')).json()).find((h: any) => h.username === 'owner').id;
    ({ id: mateId, headers: mate } = await invite('mate'));
    ({ headers: reader } = await invite('reader'));
    ({ id: strangerId, headers: stranger } = await invite('stranger'));
    for (const name of ['Pip', 'Pom']) {
      const res = await call(owner, 'POST', '/api/agents', { name, modelId: 'test', workspacePath: join(dir, name), desiredState: 'STOPPED' });
      expect(res.status, await res.clone().text()).toBe(201);
    }
    // A: the owner's research chat, which the reader can read. B: the owner's chat with mate and Pip.
    a = await chat('Alpha', [{ type: 'AGENT', id: 'Pom' }, { type: 'HUMAN', id: 'reader' }]);
    b = await chat('Beta', [{ type: 'AGENT', id: 'Pip' }, { type: 'HUMAN', id: 'mate' }]);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    product.store.close(); engine.db.close(); rmSync(dir, { recursive: true, force: true });
  });

  it('links A to B for the owner and joins Switchyard to both chats', async () => {
    const turn = await engineCall('POST', '/api/events', { type: 'agent.turn.completed', source: 'agent:Pom', channelId: a, payload: { triggerEventId: 'seed' } });
    expect(turn.status, await turn.clone().text()).toBeLessThan(300);
    const turnAt = ((await turn.json()) as EngineEvent).createdAt;
    const id = randomUUID();
    const res = await call(owner, 'POST', '/api/flows/links', { id, from: a, to: b, who: 'Pip' });
    expect(res.status, await res.clone().text()).toBe(201);
    const created = await res.json();
    expect(created).toMatchObject({ id, kind: 'link', from: a, to: b, who: 'Pip', what: 'results', when: 'done', label: 'results', on: true, pausedReason: null, createdBy: ownerId, version: 0 });
    for (const channel of [a, b]) expect(await participants(channel)).toContainEqual({ subscriberType: 'AGENT', subscriberId: 'Switchyard' });
    // Only turns after the newest one at creation are handed off.
    expect(product.store.flows.scannedTo(id)).toBe(turnAt);
    // A retry answers with the stored link.
    const again = await call(owner, 'POST', '/api/flows/links', { id, from: a, to: b, who: 'Pip' });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual(created);
  });

  it('starts the scan at 0 when the first chat has no finished turns, so none completing during creation is missed', async () => {
    const res = await link(owner, { from: a, to: b });
    const created = await res.json();
    expect(created.who).toBeNull();
    expect(product.store.flows.scannedTo(created.id)).toBe(0);
  });

  it('refuses a creator without read and post access, a missing agent and a link to itself', async () => {
    const refused = await link(mate, { from: a, to: b });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: 'You need to read the first chat and post in the second' });
    // The reader can read A but not post in B.
    expect((await link(reader, { from: b, to: a })).status).toBe(403);
    expect((await link(reader, { from: a, to: b })).status).toBe(403);
    const missing = await link(owner, { from: a, to: b, who: 'Pom' });
    expect(missing.status).toBe(409);
    expect(await missing.json()).toEqual({ error: 'Add Pom to the chat first' });
    // A human participant is not an agent.
    expect((await link(owner, { from: a, to: b, who: 'mate' })).status).toBe(409);
    expect((await link(owner, { from: a, to: a })).status).toBe(400);
    expect((await link(owner, { from: a, to: 'no-such-chat' })).status).toBe(403);
    expect(product.store.flows.linksTouching([a, b])).toEqual([]);
  });

  it('refuses an archived target and access that comes only through a team (S9)', async () => {
    const archived = await chat('Old', [{ type: 'AGENT', id: 'Pip' }]);
    expect((await call(owner, 'POST', `/api/channels/${archived}/archive`)).status).toBe(200);
    expect((await link(owner, { from: a, to: archived })).status).toBe(403);
    // The engine lets mate read and post in C through a team; flows count that as no access.
    const team = (await (await call(owner, 'POST', '/api/teams', { name: 'Crew' })).json()).id as string;
    expect((await call(owner, 'POST', `/api/teams/${team}/members`, { memberType: 'HUMAN', memberId: 'mate' })).status).toBeLessThan(300);
    const c = await chat('Crew-Room', [{ type: 'TEAM', id: team }, { type: 'AGENT', id: 'Pip' }]);
    const seen = ((await (await call(mate, 'GET', '/api/channels')).json()) as { id: string; canPost: boolean }[]).find(ch => ch.id === c);
    expect(seen?.canPost).toBe(true);
    expect((await link(mate, { from: c, to: b })).status).toBe(403);
    expect((await link(mate, { from: b, to: c })).status).toBe(403);
  });

  it('lets a target member pause or disconnect but only the creator change settings', async () => {
    const created = await (await link(owner, { from: a, to: b, who: 'Pip' })).json();
    const path = `/api/flows/links/${created.id}`;
    // mate is a HUMAN participant of B.
    expect((await call(mate, 'PATCH', path, { what: 'summary', version: 0 })).status).toBe(403);
    expect((await call(mate, 'PATCH', path, { on: false, what: 'summary', version: 0 })).status).toBe(403);
    const paused = await call(mate, 'PATCH', path, { on: false, version: 0 });
    expect(paused.status, await paused.clone().text()).toBe(200);
    expect(await paused.json()).toMatchObject({ on: false, what: 'results', version: 1 });
    // The reader can read A but is not a member of B.
    expect((await call(reader, 'PATCH', path, { on: true, version: 1 })).status).toBe(403);
    expect((await call(reader, 'PATCH', path, { what: 'summary', version: 1 })).status).toBe(403);
    expect((await call(reader, 'DELETE', `${path}?version=1`)).status).toBe(403);
    // Someone who reads neither chat cannot tell the link exists.
    expect((await call(stranger, 'PATCH', path, { on: true, version: 1 })).status).toBe(404);
    expect((await call(stranger, 'DELETE', `${path}?version=1`)).status).toBe(404);
    // The creator changes settings; `who` is checked as at creation.
    expect((await call(owner, 'PATCH', path, { who: 'Pom', version: 1 })).status).toBe(409);
    const edited = await call(owner, 'PATCH', path, { what: 'summary', label: 'digest', on: true, version: 1 });
    expect(edited.status).toBe(200);
    expect(await edited.json()).toMatchObject({ what: 'summary', label: 'digest', on: true, version: 2 });
    // A stale version is a conflict that carries the current link.
    const stale = await call(owner, 'PATCH', path, { on: false, version: 1 });
    expect(stale.status).toBe(409);
    expect((await stale.json()).current).toMatchObject({ id: created.id, version: 2 });
    expect((await call(mate, 'DELETE', `${path}?version=1`)).status).toBe(409);
    expect((await call(mate, 'DELETE', path)).status).toBe(400);
    expect((await call(mate, 'DELETE', `${path}?version=2`)).status).toBe(204);
    expect(product.store.flows.link(created.id)).toBeNull();
    expect((await call(owner, 'DELETE', `${path}?version=2`)).status).toBe(404);
  });

  it('lists a chat\'s links with titles only for chats the viewer can read', async () => {
    const created = await (await link(owner, { from: a, to: b })).json();
    const mine = await call(owner, 'GET', `/api/flows/links?channelId=${b}`);
    expect(mine.status).toBe(200);
    expect((await mine.json()).links).toEqual([{ ...created, fromTitle: 'Alpha', toTitle: 'Beta', canManage: true, canEdit: true }]);
    const theirs = await call(mate, 'GET', `/api/flows/links?channelId=${b}`);
    const text = await theirs.text();
    expect(text).not.toContain('Alpha');
    expect(JSON.parse(text).links).toEqual([{ ...created, fromTitle: 'a private chat', toTitle: 'Beta', canManage: true, canEdit: false }]);
    expect((await call(reader, 'GET', `/api/flows/links?channelId=${a}`)).status).toBe(200);
    expect((await (await call(reader, 'GET', `/api/flows/links?channelId=${a}`)).json()).links[0]).toMatchObject({ toTitle: 'a private chat', canManage: false });
    expect((await call(stranger, 'GET', `/api/flows/links?channelId=${b}`)).status).toBe(404);
    expect((await call(owner, 'GET', '/api/flows/links')).status).toBe(400);
  });

  describe('on the board', () => {
    let canvasId: string;
    const board = async (h: H, id = canvasId) => {
      const res = await call(h, 'GET', `/api/canvases/${id}/board`);
      expect(res.status).toBe(200);
      return res.json();
    };
    beforeEach(async () => {
      canvasId = randomUUID();
      expect((await call(owner, 'POST', '/api/canvases', { id: canvasId, name: 'Plan' })).status).toBe(201);
      expect((await call(owner, 'PUT', `/api/canvases/${canvasId}/members`, { visibility: 'shared', members: [{ humanId: mateId, role: 'edit' }, { humanId: strangerId, role: 'view' }], version: 0 })).status).toBe(200);
      expect((await call(owner, 'POST', `/api/canvases/${canvasId}/cards`, { cards: [{ channelId: a, x: 0, y: 0 }, { channelId: b, x: 400, y: 0 }] })).status).toBe(201);
    });

    it('shows the link with its label to readers and as a bare line to anyone else', async () => {
      const created = await (await link(owner, { from: a, to: b, who: 'Pip' })).json();
      const base = { id: created.id, kind: 'link', from: a, to: b, on: true };
      expect((await board(owner)).links).toEqual([{ ...base, access: 'open', label: 'results', what: 'results', when: 'done', who: 'Pip', pausedReason: null, canManage: true, canEdit: true }]);
      expect((await board(mate)).links).toEqual([{ ...base, access: 'open', label: 'results', what: 'results', when: 'done', who: 'Pip', pausedReason: null, canManage: true, canEdit: false }]);
      const text = await (await call(stranger, 'GET', `/api/canvases/${canvasId}/board`)).text();
      expect(text).not.toContain('results');
      expect(text).not.toContain('Pip');
      expect(JSON.parse(text).links).toEqual([{ ...base, access: 'locked' }]);
    });

    it('lists no link when only one of its chats is on the canvas', async () => {
      await link(owner, { from: a, to: b });
      const only = randomUUID();
      await call(owner, 'POST', '/api/canvases', { id: only, name: 'Solo' });
      await call(owner, 'POST', `/api/canvases/${only}/cards`, { cards: [{ channelId: a, x: 0, y: 0 }] });
      expect((await board(owner, only)).links).toEqual([]);
    });

    it('changes the etag when a link changes, so a poll sees it (S2)', async () => {
      const first = await board(owner);
      expect(first.links).toEqual([]);
      const created = await (await link(owner, { from: a, to: b })).json();
      const second = await (await call(owner, 'GET', `/api/canvases/${canvasId}/board?etag=${first.etag}`)).json();
      expect(second.unchanged).toBeUndefined();
      expect(second.links).toHaveLength(1);
      expect((await call(mate, 'PATCH', `/api/flows/links/${created.id}`, { on: false, version: 0 })).status).toBe(200);
      const third = await (await call(owner, 'GET', `/api/canvases/${canvasId}/board?etag=${second.etag}`)).json();
      expect(third.unchanged).toBeUndefined();
      expect(third.links[0]).toMatchObject({ on: false });
    });
  });

  it('posts one intro note into the target that wakes nobody, once', async () => {
    const id = randomUUID();
    const body = { id, from: a, to: b, who: 'Pip', intro: true };
    expect((await call(owner, 'POST', '/api/flows/links', body)).status).toBe(201);
    expect((await call(owner, 'POST', '/api/flows/links', body)).status).toBe(200);
    const notes = ((await (await engineCall('GET', `/api/events?channelId=${b}&type=message.created&limit=100`)).json()) as EngineEvent[])
      .filter(e => e.source === 'agent:Switchyard');
    expect(notes).toHaveLength(1);
    expect(notes[0].idempotencyKey).toBe(`nest:note:new-step:${id}`);
    expect(notes[0].payload).toEqual({ text: 'Picks up what "Alpha" produces.', targetAgentName: 'Switchyard', nestSwitchyard: { kind: 'note', setBy: ownerId, linkId: id } });
  });

  it('creates no engine event other than the intro note', async () => {
    const before = engineEvents();
    expect((await call(owner, 'GET', '/api/flows/availability')).status).toBe(200);
    const created = await (await link(owner, { from: a, to: b, who: 'Pip' })).json();
    await call(owner, 'GET', `/api/flows/links?channelId=${a}`);
    expect((await call(mate, 'PATCH', `/api/flows/links/${created.id}`, { on: false, version: 0 })).status).toBe(200);
    expect((await call(owner, 'PATCH', `/api/flows/links/${created.id}`, { what: 'all', version: 1 })).status).toBe(200);
    expect((await call(owner, 'DELETE', `/api/flows/links/${created.id}?version=2`)).status).toBe(204);
    expect(engineEvents()).toBe(before);
    expect((await link(owner, { from: b, to: a, intro: true })).status).toBe(201);
    expect(engineEvents()).toBe(before + 1);
  });

  it('reports availability and refuses links without a service token', async () => {
    expect(await (await call(owner, 'GET', '/api/flows/availability')).json())
      .toEqual({ enabled: true, serviceAgent: 'Switchyard', summaries: 'fallback', webhooks: false });
    product.store.close();
    vi.stubEnv('NEST_CONNECTION_METADATA_TOKEN', '');
    vi.stubEnv('NEST_RUNNER_TOKEN', '');
    product = boot({ connectionEngineToken: '' });
    expect(await (await call(owner, 'GET', '/api/flows/availability')).json())
      .toEqual({ enabled: false, reason: 'no-service-token', serviceAgent: null, summaries: 'fallback', webhooks: false });
    const res = await link(owner, { from: a, to: b });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Hand-offs are not set up on this server' });
  });

  it('reports a refused service token as unavailable without details', async () => {
    product.store.close();
    const log = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    product = boot({ connectionEngineToken: 'wrong-token' });
    const availability = await call(owner, 'GET', '/api/flows/availability');
    expect(availability.status).toBe(200);
    expect(await availability.json()).toMatchObject({ enabled: false, reason: 'engine-unavailable' });
    const res = await link(owner, { from: a, to: b });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Hand-offs are not set up on this server' });
    expect(product.store.flows.linksTouching([a])).toEqual([]);
    expect(JSON.stringify(log.mock.calls)).not.toContain('wrong-token');
  });

  it('answers 404 on every route with the canvas flag off', async () => {
    const created = await (await link(owner, { from: a, to: b })).json();
    product.store.close();
    product = boot({ canvasEnabled: false });
    const before = engineEvents();
    for (const [method, path, body] of [
      ['GET', '/api/flows/availability'], ['GET', `/api/flows/links?channelId=${a}`],
      ['POST', '/api/flows/links', { id: randomUUID(), from: b, to: a }],
      ['PATCH', `/api/flows/links/${created.id}`, { on: false, version: 0 }],
      ['DELETE', `/api/flows/links/${created.id}?version=0`],
    ] as const) expect((await call(owner, method, path, body)).status, `${method} ${path}`).toBe(404);
    expect(product.store.flows.link(created.id)).toMatchObject({ on: true });
    expect(engineEvents()).toBe(before);
  });
});
