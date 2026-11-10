import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp as createEngine } from '../../../vendor/orgops/apps/api/src/app';
import { createOrgOpsClient } from '@nest/orgops-client';
import { createApp } from './app';
import { createContextAgents } from './context-agents';

const RUNNER = 'runner-secret';
const KEY = /^nest_context_[a-f0-9]{64}$/;
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

describe('agent context keys and reads against the unchanged engine', () => {
  let dir: string, engine: ReturnType<typeof createEngine>, product: ReturnType<typeof createApp>;
  let client: ReturnType<typeof createOrgOpsClient>;
  let owner: Record<string, string>, mate: Record<string, string>, mateId: string;
  // Every engine request made with the service token, so tests can see when Nest calls the engine.
  let serviceCalls: string[];
  const json = { 'content-type': 'application/json' };
  const call = (h: Record<string, string>, method: string, path: string, body?: unknown) =>
    product.app.request(path, { method, headers: h, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const upload = async (path: string, name: string, content: string) => {
    const form = new FormData();
    form.append('file', new File([content], name, { type: 'text/plain' }));
    const res = await product.app.request(path, { method: 'POST', headers: { cookie: owner.cookie }, body: form });
    expect(res.status).toBe(201);
    return (await res.json())[0] as { id: string; name: string };
  };

  async function boot(canvasEnabled: boolean) {
    vi.stubEnv('ORGOPS_MASTER_KEY', Buffer.alloc(32, 99).toString('base64'));
    dir = mkdtempSync(join(tmpdir(), 'nest-context-agents-test-'));
    serviceCalls = [];
    engine = createEngine({ dbPath: join(dir, 'engine.sqlite'), dataDir: dir, projectRoot: dir, adminUser: 'owner', adminPass: 'password', runnerToken: RUNNER });
    client = createOrgOpsClient('http://engine', (async (url, init) => {
      if (new Headers(init?.headers).get('x-orgops-runner-token')) serviceCalls.push(`${init?.method ?? 'GET'} ${new URL(String(url)).pathname}`);
      return engine.app.fetch(new Request(url, init));
    }) as typeof fetch);
    product = createApp({ orgops: client, dbPath: join(dir, 'product.sqlite'), canvasEnabled, contextFilesDir: join(dir, 'context-files'), connectionEngineToken: RUNNER });
    const login = async (username: string) => {
      const r = await call(json, 'POST', '/api/auth/login', { username, password: 'password' });
      return { ...json, cookie: r.headers.get('set-cookie')!.split(';')[0] };
    };
    owner = await login('owner');
    expect((await call(owner, 'POST', '/api/humans/invite', { username: 'mate', tempPassword: 'password' })).status).toBeLessThan(300);
    mateId = (await (await call(owner, 'GET', '/api/humans')).json()).find((h: any) => h.username === 'mate').id;
    engine.db.prepare('UPDATE humans SET must_change_password=0 WHERE id=?').run(mateId);
    mate = await login('mate');
    await call(owner, 'POST', '/api/runners/register', { existingRunnerId: 'fixture-runner', displayName: 'Fixture' });
    for (const name of ['Pip', 'Pom']) {
      const res = await call(owner, 'POST', '/api/agents', { name, modelId: 'test', workspacePath: join(dir, name), enabledSkills: ['earlier-skill'], desiredState: 'STOPPED' });
      expect(res.status, await res.clone().text()).toBe(201);
    }
  }
  afterEach(() => {
    vi.unstubAllEnvs();
    product.store.close(); engine.db.close(); rmSync(dir, { recursive: true, force: true });
  });

  const agent = async (name: string) => (await call(owner, 'GET', `/api/agents/${name}`)).json();
  const chat = async (name: string, agents: string[]) => {
    const id = (await (await call(owner, 'POST', '/api/channels', { name, visibility: 'PRIVATE' })).json()).id as string;
    for (const subscriberId of agents) expect((await call(owner, 'POST', `/api/channels/${id}/subscribe`, { subscriberType: 'AGENT', subscriberId })).status).toBe(200);
    return id;
  };
  const chatEvents = async (channelId: string) => {
    const res = await call(owner, 'GET', `/api/events?channelId=${channelId}&limit=1000`);
    expect(res.status).toBe(200);
    return ((await res.json()) as unknown[]).length;
  };
  async function canvas(name: string, h = owner) {
    const id = randomUUID();
    expect((await call(h, 'POST', '/api/canvases', { id, name })).status).toBe(201);
    return id;
  }
  async function area(canvasId: string, title: string, h = owner) {
    const id = randomUUID();
    expect((await call(h, 'POST', `/api/canvases/${canvasId}/areas`, { id, title, x: 0, y: 0, w: 400, h: 300 })).status).toBe(201);
    return id;
  }
  async function notes(path: string, text: string, h = owner) {
    const current = (await (await call(h, 'GET', path)).json()).version;
    const res = await call(h, 'PUT', path, { notes: text, version: current });
    expect(res.status).toBe(200);
  }
  async function share(canvasId: string, role: 'edit' | 'view' | null) {
    const version = ((await (await call(owner, 'GET', '/api/canvases')).json()) as { id: string; version: number }[]).find(c => c.id === canvasId)!.version;
    const body = role ? { visibility: 'shared', members: [{ humanId: mateId, role }], version } : { visibility: 'private', members: [], version };
    expect((await call(owner, 'PUT', `/api/canvases/${canvasId}/members`, body)).status).toBe(200);
  }
  const place = async (canvasId: string, channelId: string, x = 10, y = 10) =>
    expect((await call(owner, 'POST', `/api/canvases/${canvasId}/cards`, { cards: [{ channelId, x, y }] })).status).toBe(201);
  const secretOf = async (agentName: string) => {
    const res = await engine.app.request('/api/secrets/env', { headers: { 'x-orgops-runner-token': RUNNER, 'x-orgops-agent-name': agentName } });
    expect(res.status).toBe(200);
    return (await res.json()).NEST_CONTEXT_TOKEN as string | undefined;
  };
  const activeKeys = (agentName: string) =>
    (product.store.db.prepare('SELECT COUNT(*) AS n FROM product_context_tokens WHERE agent_name=? AND revoked_at IS NULL').get(agentName) as { n: number }).n;
  const allKeys = (agentName: string) =>
    (product.store.db.prepare('SELECT COUNT(*) AS n FROM product_context_tokens WHERE agent_name=?').get(agentName) as { n: number }).n;
  const read = (key: string | undefined, channelId: string, extra: Record<string, string> = {}) =>
    product.app.request(`/api/context/agent?channelId=${channelId}`, { headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...extra } });
  const download = (key: string, channelId: string, fileId: string) =>
    product.app.request(`/api/context/agent/files/${fileId}?channelId=${channelId}`, { headers: { authorization: `Bearer ${key}` } });

  describe('flag off', () => {
    beforeEach(() => boot(false));
    it('hides the agent routes', async () => {
      const key = 'nest_context_' + 'a'.repeat(64);
      expect((await read(key, randomUUID())).status).toBe(404);
      expect((await read(undefined, randomUUID())).status).toBe(404);
      expect((await download(key, randomUUID(), randomUUID())).status).toBe(404);
    });
  });

  describe('flag on', () => {
    beforeEach(() => boot(true));

    it('sets up a key for a native agent in a chat with home context, and reads only that home', async () => {
      const launch = await chat('Launch', ['Pip']);
      const other = await chat('Other', []);
      const x = await canvas('Roadmap');
      const a = await area(x, 'Alpha');
      await place(x, launch);
      await place(x, other, 30, 30);
      expect(activeKeys('Pip')).toBe(0);

      const before = await chatEvents(launch);
      await notes(`/api/canvases/${x}/areas/${a}/context`, 'Alpha notes');
      await notes(`/api/canvases/${x}/context`, 'Canvas notes');
      const alphaFile = await upload(`/api/canvases/${x}/areas/${a}/context/files`, 'brief.txt', 'alpha brief');
      const canvasFile = await upload(`/api/canvases/${x}/context/files`, 'plan.txt', 'canvas plan');
      expect(await chatEvents(launch)).toBe(before);

      // Exactly one key, made once, installed as Pip's private secret; existing skills are kept.
      expect(activeKeys('Pip')).toBe(1);
      expect(allKeys('Pip')).toBe(1);
      const key = (await secretOf('Pip'))!;
      expect(key).toMatch(KEY);
      expect(product.store.canvasContext.agentForKey(sha256(key))).toBe('Pip');
      const secrets = await (await call(owner, 'GET', '/api/secrets')).json();
      expect(secrets).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'NEST_CONTEXT_TOKEN', scope_type: 'private', scope_id: 'Pip' })]));
      expect(JSON.stringify(secrets)).not.toContain(key);
      expect((await agent('Pip')).enabledSkills).toEqual(['earlier-skill', 'nest-context']);
      expect(product.store.canvasContext.skillEnabled('Pip')).toBe(true);
      // Pom is not in the chat and gets nothing.
      expect(allKeys('Pom')).toBe(0);
      expect(await secretOf('Pom')).toBeUndefined();
      expect((await agent('Pom')).enabledSkills).toEqual(['earlier-skill']);
      // The key is never in Nest's own tables or audit in the clear.
      expect(JSON.stringify(product.store.db.prepare('SELECT * FROM product_audit').all())).not.toContain('nest_context_');
      expect(JSON.stringify(product.store.db.prepare('SELECT * FROM product_context_tokens').all())).not.toContain(key);

      const res = await read(key, launch);
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
      const body = await res.json();
      expect(body).toMatchObject({
        canvas: { name: 'Roadmap', notes: 'Canvas notes', files: [{ id: canvasFile.id, name: 'plan.txt' }] },
        area: { title: 'Alpha', notes: 'Alpha notes', files: [{ id: alphaFile.id, name: 'brief.txt' }] },
        linked: [],
      });
      expect(JSON.stringify(body)).not.toContain(key);

      const file = await download(key, launch, alphaFile.id);
      expect(file.status).toBe(200);
      expect(file.headers.get('content-type')).toBe('application/octet-stream');
      expect(file.headers.get('cache-control')).toBe('private, no-store');
      expect(await file.text()).toBe('alpha brief');
      expect(await (await download(key, launch, canvasFile.id)).text()).toBe('canvas plan');
      expect((await download(key, launch, randomUUID())).status).toBe(404);
      expect((await download(key, launch, 'not-a-uuid')).status).toBe(404);

      // A chat Pip is not in: 403, and nothing about that chat's home.
      const denied = await read(key, other);
      expect(denied.status).toBe(403);
      const deniedText = await denied.text();
      expect(JSON.parse(deniedText)).toEqual({ error: 'This agent is not in that chat' });
      for (const secret of ['Alpha', 'Roadmap', 'Canvas notes']) expect(deniedText).not.toContain(secret);
      const deniedFile = await download(key, other, alphaFile.id);
      expect(deniedFile.status).toBe(403);
      expect(await deniedFile.text()).not.toContain('alpha brief');
      expect((await read(key, randomUUID())).status).toBe(403);
      expect((await read(key, '')).status).toBe(400);

      // No key, a malformed key, a cookie instead of a key, or an unknown key: 401.
      expect((await read(undefined, launch)).status).toBe(401);
      expect((await read(undefined, launch, { cookie: owner.cookie })).status).toBe(401);
      expect((await read('nest_context_short', launch)).status).toBe(401);
      expect((await read('nest_context_' + 'b'.repeat(64), launch)).status).toBe(401);
      expect((await product.app.request(`/api/context/agent?channelId=${launch}`, { headers: { authorization: `Bearer nest_connection_${'a'.repeat(64)}` } })).status).toBe(401);
      // Other methods never fall through to the engine proxy.
      expect((await product.app.request(`/api/context/agent?channelId=${launch}`, { method: 'POST', headers: { authorization: `Bearer ${key}` } })).status).toBe(404);

      // Membership is checked through the engine on every read: leaving the chat ends access at once.
      expect((await call(owner, 'POST', `/api/channels/${launch}/unsubscribe`, { subscriberType: 'AGENT', subscriberId: 'Pip' })).status).toBe(200);
      expect((await read(key, launch)).status).toBe(403);
      expect((await call(owner, 'POST', `/api/channels/${launch}/subscribe`, { subscriberType: 'AGENT', subscriberId: 'Pip' })).status).toBe(200);
      expect((await read(key, launch)).status).toBe(200);
      expect((await call(owner, 'POST', `/api/channels/${launch}/archive`)).status).toBe(200);
      expect((await read(key, launch)).status).toBe(403);
      expect((await call(owner, 'POST', `/api/channels/${launch}/unarchive`)).status).toBe(200);

      // A revoked key: 401.
      product.store.canvasContext.revokeKey(sha256(key));
      expect((await read(key, launch)).status).toBe(401);
      expect((await download(key, launch, alphaFile.id)).status).toBe(401);
    });

    it('never returns a private canvas the chat was also placed on (Review Focus 1)', async () => {
      const launch = await chat('Launch', ['Pip']);
      const x = await canvas('Roadmap');
      const a = await area(x, 'Alpha');
      await place(x, launch);
      const y = await canvas('Private board');
      const p = await area(y, 'Private area');
      await place(y, launch);
      const before = await chatEvents(launch);
      await notes(`/api/canvases/${x}/areas/${a}/context`, 'Alpha notes');
      await notes(`/api/canvases/${y}/areas/${p}/context`, 'Private P notes');
      await notes(`/api/canvases/${y}/context`, 'Private canvas notes');
      const privateFile = await upload(`/api/canvases/${y}/areas/${p}/context/files`, 'p.txt', 'private file');
      const privateCanvasFile = await upload(`/api/canvases/${y}/context/files`, 'pc.txt', 'private canvas file');
      expect(await chatEvents(launch)).toBe(before);

      const key = (await secretOf('Pip'))!;
      const res = await read(key, launch);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(JSON.parse(text)).toMatchObject({ canvas: { name: 'Roadmap' }, area: { title: 'Alpha', notes: 'Alpha notes' }, linked: [] });
      for (const secret of ['Private', 'p.txt', 'pc.txt']) expect(text).not.toContain(secret);
      expect((await download(key, launch, privateFile.id)).status).toBe(404);
      expect((await download(key, launch, privateCanvasFile.id)).status).toBe(404);
    });

    it('reads linked areas one level deep, only while the linker can read the source (Review Focus 2)', async () => {
      const launch = await chat('Launch', ['Pip']);
      const x = await canvas('Roadmap');
      const a = await area(x, 'Alpha');
      await place(x, launch);
      const s = await canvas('Research');
      const l = await area(s, 'Linked');
      const d = await canvas('Deep');
      const m = await area(d, 'Deeper');
      await share(x, 'edit');
      await share(s, 'view');

      const before = await chatEvents(launch);
      await notes(`/api/canvases/${s}/areas/${l}/context`, 'Linked notes');
      const linkedFile = await upload(`/api/canvases/${s}/areas/${l}/context/files`, 'l.txt', 'linked file');
      await notes(`/api/canvases/${d}/areas/${m}/context`, 'Deep notes');
      const deepFile = await upload(`/api/canvases/${d}/areas/${m}/context/files`, 'd.txt', 'deep file');
      // The source's own link is never followed.
      expect((await call(owner, 'POST', `/api/canvases/${s}/areas/${l}/context/links`, { sourceAreaId: m })).status).toBe(200);
      // The teammate links Alpha to Linked; the link alone is home context, so Pip is set up.
      expect((await call(mate, 'POST', `/api/canvases/${x}/areas/${a}/context/links`, { sourceAreaId: l })).status).toBe(200);
      expect(await chatEvents(launch)).toBe(before);

      const key = (await secretOf('Pip'))!;
      expect(key).toMatch(KEY);
      const res = await read(key, launch);
      const text = await res.text();
      expect(JSON.parse(text)).toMatchObject({ area: { title: 'Alpha', notes: '' }, linked: [{ title: 'Linked', notes: 'Linked notes', files: [{ id: linkedFile.id }] }] });
      expect(JSON.parse(text).linked).toHaveLength(1);
      expect(text).not.toContain('Deep');
      expect(await (await download(key, launch, linkedFile.id)).text()).toBe('linked file');
      expect((await download(key, launch, deepFile.id)).status).toBe(404);

      // The linker loses the source canvas: the link and its files drop out at once.
      await share(s, null);
      const after = await (await read(key, launch)).json();
      expect(after.linked).toEqual([]);
      expect(JSON.stringify(after)).not.toContain('Linked notes');
      expect((await download(key, launch, linkedFile.id)).status).toBe(404);
    });

    it('gives a wrapped agent no key and reports reader states', async () => {
      const created = await call(owner, 'POST', '/api/agents', { name: 'Wren', modelId: 'wrapped:none', workspacePath: join(dir, 'Wren'), assignedRunnerId: 'fixture-runner', mode: 'WRAPPED', desiredState: 'STOPPED' });
      expect(created.status, await created.clone().text()).toBe(201);
      const launch = await chat('Launch', ['Pip', 'Wren']);
      const quiet = await chat('Quiet', ['Pom']);
      const x = await canvas('Roadmap');
      await place(x, launch);
      await place(x, quiet, 500, 500);
      await notes(`/api/canvases/${x}/context`, 'Canvas notes');

      expect(allKeys('Wren')).toBe(0);
      expect(await secretOf('Wren')).toBeUndefined();
      expect((await agent('Wren')).enabledSkills ?? []).not.toContain('nest-context');
      // Pom's chat has a home with canvas notes too, so Pom is set up; a chat with no home is not.
      const lonely = await chat('Lonely', ['Pom']);
      const sort = (rows: { agentName: string }[]) => [...rows].sort((p, q) => p.agentName.localeCompare(q.agentName));
      expect(sort(await product.contextAgents.readers([launch]))).toEqual([
        { agentName: 'Pip', state: 'ready' },
        { agentName: 'Wren', state: 'wrapped' },
      ]);
      expect(await product.contextAgents.readers([quiet, lonely])).toEqual([{ agentName: 'Pom', state: 'ready' }]);
      product.store.db.prepare('DELETE FROM product_context_agents').run();
      expect(sort(await product.contextAgents.readers([launch]))).toEqual([
        { agentName: 'Pip', state: 'unconfigured' },
        { agentName: 'Wren', state: 'wrapped' },
      ]);
    });

    it('sets up agents from board reads without waiting, and makes no engine calls once they are ready (R2)', async () => {
      const launch = await chat('Launch', ['Pip']);
      const x = await canvas('Roadmap');
      await place(x, launch);
      await notes(`/api/canvases/${x}/context`, 'Canvas notes');
      expect(product.store.canvasContext.skillEnabled('Pip')).toBe(true);
      // Pom joins after the context exists; only a board read notices.
      expect((await call(owner, 'POST', `/api/channels/${launch}/subscribe`, { subscriberType: 'AGENT', subscriberId: 'Pom' })).status).toBe(200);
      expect((await call(owner, 'GET', `/api/canvases/${x}/board`)).status).toBe(200);
      await vi.waitFor(() => expect(product.store.canvasContext.skillEnabled('Pom')).toBe(true));
      expect(await secretOf('Pom')).toMatch(KEY);
      serviceCalls = [];
      for (let i = 0; i < 3; i++) expect((await call(owner, 'GET', `/api/canvases/${x}/board`)).status).toBe(200);
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(serviceCalls).toEqual([]);
    });

    it('makes one key for concurrent setups, does nothing without an engine token, and audits failures without the key', async () => {
      const launch = await chat('Launch', ['Pip']);
      const x = await canvas('Roadmap');
      await place(x, launch);
      // Context written directly, so no route has set Pip up yet.
      product.store.canvasContext.setNotes({ kind: 'canvas', canvasId: x }, 'Canvas notes', 0, 'owner');

      await createContextAgents({ store: product.store, orgops: client, engineToken: undefined }).ensureAgents([launch]);
      expect(allKeys('Pip')).toBe(0);

      const failing = createOrgOpsClient('http://engine', (async (url, init) => {
        if (new URL(String(url)).pathname === '/api/secrets' && init?.method === 'POST') return Response.json({ error: 'down' }, { status: 503 });
        return engine.app.fetch(new Request(url, init));
      }) as typeof fetch);
      await expect(createContextAgents({ store: product.store, orgops: failing, engineToken: RUNNER }).ensureAgents([launch])).resolves.toBeUndefined();
      expect(activeKeys('Pip')).toBe(0);
      expect(product.store.canvasContext.skillEnabled('Pip')).toBe(false);
      expect((await agent('Pip')).enabledSkills).toEqual(['earlier-skill']);
      const failures = product.store.db.prepare("SELECT payload_json FROM product_audit WHERE type='audit.canvas.context.agent_setup_failed'").all();
      expect(failures).toEqual([{ payload_json: JSON.stringify({ agentName: 'Pip' }) }]);

      const agents = createContextAgents({ store: product.store, orgops: client, engineToken: RUNNER });
      await Promise.all([agents.ensureAgents([launch]), agents.ensureAgents([launch, launch])]);
      expect(activeKeys('Pip')).toBe(1);
      expect(product.store.canvasContext.agentForKey(sha256((await secretOf('Pip'))!))).toBe('Pip');
      expect((await agent('Pip')).enabledSkills).toEqual(['earlier-skill', 'nest-context']);
      expect(JSON.stringify(product.store.db.prepare('SELECT * FROM product_audit').all())).not.toContain('nest_context_');
    });

    it('rate-limits each key to 60 requests a minute', async () => {
      const launch = await chat('Launch', ['Pip']);
      const x = await canvas('Roadmap');
      await place(x, launch);
      await notes(`/api/canvases/${x}/context`, 'Canvas notes');
      const key = (await secretOf('Pip'))!;
      for (let i = 0; i < 60; i++) expect((await read(key, launch)).status).toBe(200);
      expect((await read(key, launch)).status).toBe(429);
    });
  });
});
