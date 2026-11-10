import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp as createEngine } from '../../../vendor/orgops/apps/api/src/app';
import { createOrgOpsClient } from '@nest/orgops-client';
import { MAX_CONTEXT_BYTES_PER_CANVAS, MAX_CONTEXT_FILE_BYTES } from '@nest/schemas';
import { createApp } from './app';

describe('canvas context API against the unchanged engine', () => {
  let dir: string, filesDir: string, engine: ReturnType<typeof createEngine>, product: ReturnType<typeof createApp>;
  let owner: Record<string, string>, mate: Record<string, string>, mateId: string;
  const json = { 'content-type': 'application/json' };
  const call = (h: Record<string, string>, method: string, path: string, body?: unknown) =>
    product.app.request(path, { method, headers: h, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const upload = (h: Record<string, string>, path: string, parts: { name: string; content: string | Uint8Array }[]) => {
    const form = new FormData();
    for (const part of parts) form.append('file', new File([part.content], part.name, { type: 'text/plain' }));
    return product.app.request(path, { method: 'POST', headers: { cookie: h.cookie }, body: form });
  };
  // Every call in this file must leave the engine's event log alone.
  const engineEvents = async () => {
    const r = await call(owner, 'GET', '/api/events?limit=1000');
    expect(r.status).toBe(200);
    return (await r.json()).length as number;
  };
  const stored = () => (existsSync(filesDir) ? readdirSync(filesDir) : []);
  let before: number | null = null;

  // `engineToken: ''` boots a server whose agents cannot be given context keys (no service token configured).
  async function boot(canvasEnabled: boolean, engineToken?: string) {
    vi.stubEnv('ORGOPS_MASTER_KEY', Buffer.alloc(32, 99).toString('base64'));
    dir = mkdtempSync(join(tmpdir(), 'nest-canvas-context-test-'));
    filesDir = join(dir, 'context-files');
    engine = createEngine({ dbPath: join(dir, 'engine.sqlite'), dataDir: dir, projectRoot: dir, adminUser: 'owner', adminPass: 'password', runnerToken: 'runner-secret' });
    const client = createOrgOpsClient('http://engine', (async (url, init) => engine.app.fetch(new Request(url, init))) as typeof fetch);
    product = createApp({ orgops: client, dbPath: join(dir, 'product.sqlite'), canvasEnabled, contextFilesDir: filesDir, ...(engineToken === undefined ? {} : { connectionEngineToken: engineToken }) });
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
    before = await engineEvents();
  }
  afterEach(async () => {
    if (before !== null) expect(await engineEvents()).toBe(before);
    before = null;
    vi.unstubAllEnvs();
    product.store.close(); engine.db.close(); rmSync(dir, { recursive: true, force: true });
  });

  async function canvas(h: Record<string, string>, name: string) {
    const id = randomUUID();
    expect((await call(h, 'POST', '/api/canvases', { id, name })).status).toBe(201);
    return id;
  }
  async function area(h: Record<string, string>, canvasId: string, title: string) {
    const id = randomUUID();
    expect((await call(h, 'POST', `/api/canvases/${canvasId}/areas`, { id, title, x: 0, y: 0, w: 400, h: 300 })).status).toBe(201);
    return id;
  }
  async function version(canvasId: string) {
    return ((await (await call(owner, 'GET', '/api/canvases')).json()) as { id: string; version: number }[]).find(c => c.id === canvasId)!.version;
  }
  async function share(canvasId: string, role: 'edit' | 'view' | null) {
    const body = role ? { visibility: 'shared', members: [{ humanId: mateId, role }], version: await version(canvasId) } : { visibility: 'private', members: [], version: await version(canvasId) };
    expect((await call(owner, 'PUT', `/api/canvases/${canvasId}/members`, body)).status).toBe(200);
  }

  async function chat(name: string, agentNames: string[]) {
    const id = (await (await call(owner, 'POST', '/api/channels', { name, visibility: 'PRIVATE' })).json()).id as string;
    for (const subscriberId of agentNames) expect((await call(owner, 'POST', `/api/channels/${id}/subscribe`, { subscriberType: 'AGENT', subscriberId })).status).toBe(200);
    return id;
  }
  async function agent(name: string, mode?: 'WRAPPED') {
    const res = await call(owner, 'POST', '/api/agents', {
      name, modelId: mode ? 'wrapped:none' : 'test', workspacePath: join(dir, name), desiredState: 'STOPPED',
      ...(mode ? { mode, assignedRunnerId: 'fixture-runner' } : {}),
    });
    expect(res.status, await res.clone().text()).toBe(201);
  }
  // Areas are 400 × 300 at the origin, so a card at (10, 10) sits inside and its first placement homes the chat there.
  const place = async (canvasId: string, channelId: string, x = 10, y = 10) =>
    expect((await call(owner, 'POST', `/api/canvases/${canvasId}/cards`, { cards: [{ channelId, x, y }] })).status).toBe(201);

  describe('flag off', () => {
    beforeEach(() => boot(false));
    it('hides every context route', async () => {
      const id = randomUUID(), areaId = randomUUID(), fileId = randomUUID();
      const paths: [string, string, unknown?][] = [
        ['GET', '/api/canvases/context-sources'],
        ['GET', `/api/canvases/${id}/context`],
        ['PUT', `/api/canvases/${id}/context`, { notes: 'x', version: 0 }],
        ['GET', `/api/canvases/${id}/areas/${areaId}/context`],
        ['PUT', `/api/canvases/${id}/areas/${areaId}/context`, { notes: 'x', version: 0 }],
        ['GET', `/api/canvases/${id}/context/files/${fileId}`],
        ['DELETE', `/api/canvases/${id}/context/files/${fileId}`],
        ['DELETE', `/api/canvases/${id}/areas/${areaId}/context/files/${fileId}`],
        ['POST', `/api/canvases/${id}/areas/${areaId}/context/links`, { sourceAreaId: randomUUID() }],
        ['DELETE', `/api/canvases/${id}/areas/${areaId}/context/links/${randomUUID()}`],
        ['GET', `/api/canvases/${id}/context/summary`],
        ['GET', `/api/canvases/${id}/areas/${areaId}/context/readers`],
      ];
      for (const [method, path, body] of paths) expect([method, path, (await call(owner, method, path, body)).status]).toEqual([method, path, 404]);
      expect((await upload(owner, `/api/canvases/${id}/context/files`, [{ name: 'a.txt', content: 'a' }])).status).toBe(404);
      expect((await upload(owner, `/api/canvases/${id}/areas/${areaId}/context/files`, [{ name: 'a.txt', content: 'a' }])).status).toBe(404);
      expect(stored()).toEqual([]);
    });
  });

  describe('flag on', () => {
    beforeEach(() => boot(true));

    it('requires authentication', async () => {
      expect((await product.app.request(`/api/canvases/${randomUUID()}/context`)).status).toBe(401);
      expect((await product.app.request('/api/canvases/context-sources')).status).toBe(401);
    });

    it('lets a viewer read notes but not write them, and rejects stale writes with the current notes', async () => {
      const a = await canvas(owner, 'Launch');
      const a1 = await area(owner, a, 'Research');
      const put = await call(owner, 'PUT', `/api/canvases/${a}/areas/${a1}/context`, { notes: 'Ship on Friday', version: 0 });
      expect(put.status).toBe(200);
      expect(await put.json()).toEqual({ notes: 'Ship on Friday', version: 1, files: [], links: [], usedBy: [], inChats: false });
      const canvasPut = await call(owner, 'PUT', `/api/canvases/${a}/context`, { notes: 'Whole canvas', version: 0 });
      expect(await canvasPut.json()).toEqual({ notes: 'Whole canvas', version: 1, files: [], links: [], usedBy: [], inChats: false });

      expect((await call(mate, 'GET', `/api/canvases/${a}/areas/${a1}/context`)).status).toBe(404);
      await share(a, 'view');
      const read = await call(mate, 'GET', `/api/canvases/${a}/areas/${a1}/context`);
      expect(read.status).toBe(200);
      expect(read.headers.get('cache-control')).toBe('no-store');
      expect(await read.json()).toMatchObject({ notes: 'Ship on Friday', version: 1 });
      expect(await (await call(mate, 'GET', `/api/canvases/${a}/context`)).json()).toMatchObject({ notes: 'Whole canvas' });
      expect((await call(mate, 'PUT', `/api/canvases/${a}/areas/${a1}/context`, { notes: 'Mine', version: 1 })).status).toBe(403);

      const stale = await call(owner, 'PUT', `/api/canvases/${a}/areas/${a1}/context`, { notes: 'Older', version: 0 });
      expect(stale.status).toBe(409);
      expect(await stale.json()).toMatchObject({ error: 'Context changed', current: { notes: 'Ship on Friday', version: 1 } });
      expect((await call(owner, 'PUT', `/api/canvases/${a}/areas/${a1}/context`, { notes: 'x'.repeat(20_001), version: 1 })).status).toBe(400);
    });

    it('404s for areas that are missing or belong to another canvas', async () => {
      const a = await canvas(owner, 'A');
      const b = await canvas(owner, 'B');
      const b1 = await area(owner, b, 'B1');
      expect((await call(owner, 'GET', `/api/canvases/${a}/areas/${b1}/context`)).status).toBe(404);
      expect((await call(owner, 'PUT', `/api/canvases/${a}/areas/${b1}/context`, { notes: 'x', version: 0 })).status).toBe(404);
      expect((await call(owner, 'GET', `/api/canvases/${a}/areas/${randomUUID()}/context`)).status).toBe(404);
      expect((await call(owner, 'GET', `/api/canvases/${a}/areas/not-a-uuid/context`)).status).toBe(404);
      expect((await call(owner, 'GET', '/api/canvases/not-a-uuid/context')).status).toBe(404);
      expect((await upload(owner, `/api/canvases/${a}/areas/${b1}/context/files`, [{ name: 'a.txt', content: 'a' }])).status).toBe(404);
      expect(stored()).toEqual([]);
    });

    it('uploads, serves and deletes context files within the canvas only', async () => {
      const a = await canvas(owner, 'A');
      const a1 = await area(owner, a, 'A1');
      const b = await canvas(owner, 'B');
      const res = await upload(owner, `/api/canvases/${a}/areas/${a1}/context/files`, [{ name: 'brief.txt', content: 'first brief' }, { name: 'notes "q".md', content: 'second' }]);
      expect(res.status).toBe(201);
      const files = await res.json();
      expect(files).toMatchObject([{ name: 'brief.txt', size: 11, mime: 'text/plain' }, { name: 'notes "q".md', size: 6 }]);
      expect(stored()).toHaveLength(2);
      // Files uploaded in the same millisecond list by id, so compare without order.
      const byId = (rows: { id: string }[]) => [...rows].sort((x, y) => x.id.localeCompare(y.id));
      expect(byId((await (await call(owner, 'GET', `/api/canvases/${a}/areas/${a1}/context`)).json()).files)).toEqual(byId(files));

      await share(a, 'view');
      const download = await call(mate, 'GET', `/api/canvases/${a}/context/files/${files[0].id}`);
      expect(download.status).toBe(200);
      expect(await download.text()).toBe('first brief');
      expect(Object.fromEntries(['content-type', 'content-disposition', 'x-content-type-options', 'content-security-policy', 'cache-control', 'referrer-policy'].map(k => [k, download.headers.get(k)]))).toEqual({
        'content-type': 'application/octet-stream',
        'content-disposition': "attachment; filename*=UTF-8''brief.txt",
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; sandbox",
        'cache-control': 'private, no-store',
        'referrer-policy': 'no-referrer',
      });
      expect((await call(owner, 'GET', `/api/canvases/${a}/context/files/${files[1].id}`)).headers.get('content-disposition')).toBe(`attachment; filename*=UTF-8''${encodeURIComponent('notes "q".md')}`);
      expect((await call(owner, 'GET', `/api/canvases/${b}/context/files/${files[0].id}`)).status).toBe(404);
      expect((await call(owner, 'GET', `/api/canvases/${a}/context/files/${randomUUID()}`)).status).toBe(404);
      expect((await call(owner, 'DELETE', `/api/canvases/${b}/context/files/${files[0].id}`)).status).toBe(404);
      expect((await upload(mate, `/api/canvases/${a}/areas/${a1}/context/files`, [{ name: 'x.txt', content: 'x' }])).status).toBe(403);
      expect((await call(mate, 'DELETE', `/api/canvases/${a}/areas/${a1}/context/files/${files[0].id}`)).status).toBe(403);

      expect((await call(owner, 'DELETE', `/api/canvases/${a}/areas/${a1}/context/files/${files[0].id}`)).status).toBe(204);
      expect(stored()).toHaveLength(1);
      expect((await call(owner, 'GET', `/api/canvases/${a}/context/files/${files[0].id}`)).status).toBe(404);

      const canvasFile = await upload(owner, `/api/canvases/${a}/context/files`, [{ name: 'canvas.txt', content: 'c' }]);
      expect(canvasFile.status).toBe(201);
      const [cf] = await canvasFile.json();
      expect((await (await call(owner, 'GET', `/api/canvases/${a}/context`)).json()).files).toEqual([cf]);
      expect((await call(owner, 'DELETE', `/api/canvases/${a}/context/files/${cf.id}`)).status).toBe(204);
      expect(stored()).toHaveLength(1);
    });

    it('rejects a 21st part or an oversized file and leaves nothing on disk', async () => {
      const a = await canvas(owner, 'A');
      const a1 = await area(owner, a, 'A1');
      const path = `/api/canvases/${a}/areas/${a1}/context/files`;
      const parts = Array.from({ length: 21 }, (_, i) => ({ name: `f${i}.txt`, content: String(i) }));
      expect((await upload(owner, path, parts)).status).toBe(400);
      expect((await upload(owner, path, parts.slice(0, 20))).status).toBe(201);
      for (const key of stored()) rmSync(join(filesDir, key));
      const before = (await (await call(owner, 'GET', `/api/canvases/${a}/areas/${a1}/context`)).json()).files.length;
      const big = new Uint8Array(MAX_CONTEXT_FILE_BYTES + 1);
      const res = await upload(owner, path, [{ name: 'ok.txt', content: 'ok' }, { name: 'big.bin', content: big }]);
      expect(res.status).toBe(400);
      expect(stored()).toEqual([]);
      expect((await (await call(owner, 'GET', `/api/canvases/${a}/areas/${a1}/context`)).json()).files).toHaveLength(before);
      expect((await upload(owner, path, [])).status).toBe(400);
    });

    it('answers 413 without reading an upload whose declared size exceeds the canvas budget', async () => {
      const a = await canvas(owner, 'A');
      const path = `/api/canvases/${a}/context/files`;
      const first = await upload(owner, path, [{ name: 'big.bin', content: new Uint8Array(2 * 1024 * 1024) }]);
      expect(first.status).toBe(201);
      const kept = stored();
      const declared = async (length: number) => {
        const form = new FormData();
        form.append('file', new File(['tiny'], 'tiny.txt', { type: 'text/plain' }));
        const body = await new Response(form).arrayBuffer();
        const contentType = new Response(form).headers.get('content-type')!;
        return product.app.request(path, { method: 'POST', headers: { cookie: owner.cookie, 'content-type': contentType, 'content-length': String(length) }, body });
      };
      // 200 MiB fits under the request cap but not in the 198 MiB (+1 MiB overhead) this canvas has left.
      for (const length of [MAX_CONTEXT_BYTES_PER_CANVAS, MAX_CONTEXT_BYTES_PER_CANVAS + 2 * 1024 * 1024]) {
        const res = await declared(length);
        expect([length, res.status]).toEqual([length, 413]);
        expect(await res.json()).toEqual({ error: 'Upload too large' });
      }
      expect(stored()).toEqual(kept);
      expect((await (await call(owner, 'GET', `/api/canvases/${a}/context`)).json()).files).toHaveLength(1);
    });

    it('records all files of an upload or none of them when a scope limit is hit', async () => {
      const a = await canvas(owner, 'A');
      const path = `/api/canvases/${a}/context/files`;
      const parts = Array.from({ length: 20 }, (_, i) => ({ name: `f${i}.txt`, content: String(i) }));
      expect((await upload(owner, path, parts)).status).toBe(201);
      expect((await upload(owner, path, parts)).status).toBe(201);
      const over = await upload(owner, path, parts);
      expect(over.status).toBe(400);
      expect(await over.json()).toEqual({ error: 'A context can hold at most 50 files' });
      expect((await (await call(owner, 'GET', `/api/canvases/${a}/context`)).json()).files).toHaveLength(40);
      expect(stored()).toHaveLength(40);
    });

    it('marks a link unavailable once its linker loses the source canvas', async () => {
      const a = await canvas(owner, 'A');
      const a1 = await area(owner, a, 'A1');
      const b = await canvas(owner, 'B');
      const b1 = await area(owner, b, 'B1');
      const b2 = await area(owner, b, 'B2');
      const linksPath = `/api/canvases/${a}/areas/${a1}/context/links`;

      const own = await call(owner, 'POST', linksPath, { sourceAreaId: b1 });
      expect(own.status).toBe(200);
      expect((await own.json()).links).toEqual([{ sourceAreaId: b1, title: 'B1', canvasName: 'B', available: true }]);

      await share(a, 'edit');
      await share(b, 'view');
      const theirs = await call(mate, 'POST', linksPath, { sourceAreaId: b2 });
      expect(theirs.status).toBe(200);
      expect((await theirs.json()).links).toEqual([
        { sourceAreaId: b1, title: 'B1', canvasName: 'B', available: true },
        { sourceAreaId: b2, title: 'B2', canvasName: 'B', available: true },
      ]);
      expect(await (await call(owner, 'GET', `/api/canvases/${b}/areas/${b1}/context`)).json()).toMatchObject({ usedBy: [{ areaId: a1, title: 'A1' }] });

      await share(b, null);
      expect((await (await call(mate, 'GET', `/api/canvases/${a}/areas/${a1}/context`)).json()).links).toEqual([
        { sourceAreaId: b1, title: 'Unavailable area', canvasName: null, available: true },
        { sourceAreaId: b2, title: 'Unavailable area', canvasName: null, available: false },
      ]);
      expect((await (await call(owner, 'GET', `/api/canvases/${a}/areas/${a1}/context`)).json()).links).toEqual([
        { sourceAreaId: b1, title: 'B1', canvasName: 'B', available: true },
        { sourceAreaId: b2, title: 'B2', canvasName: 'B', available: false },
      ]);

      // Linking needs read access to the source canvas; a missing source is the same 404.
      expect((await call(mate, 'POST', linksPath, { sourceAreaId: b1 })).status).toBe(404);
      expect((await call(owner, 'POST', linksPath, { sourceAreaId: randomUUID() })).status).toBe(404);
      expect((await call(owner, 'POST', linksPath, { sourceAreaId: a1 })).status).toBe(400);
      expect((await call(owner, 'POST', linksPath, { sourceAreaId: 'nope' })).status).toBe(400);

      // A teammate who only views the area's canvas cannot change its links.
      const mine = await canvas(mate, 'Mine');
      const m1 = await area(mate, mine, 'M1');
      await share(a, 'view');
      expect((await call(mate, 'POST', linksPath, { sourceAreaId: m1 })).status).toBe(403);
      expect((await call(mate, 'DELETE', `${linksPath}/${b2}`)).status).toBe(403);

      expect((await call(owner, 'DELETE', `${linksPath}/${b2}`)).status).toBe(204);
      expect((await (await call(owner, 'GET', `/api/canvases/${a}/areas/${a1}/context`)).json()).links.map((l: any) => l.sourceAreaId)).toEqual([b1]);
    });

    it('shows usedBy titles only for canvases the viewer can read', async () => {
      const a = await canvas(owner, 'A');
      const a1 = await area(owner, a, 'A1');
      const b = await canvas(owner, 'B');
      const b1 = await area(owner, b, 'B1');
      expect((await call(owner, 'POST', `/api/canvases/${a}/areas/${a1}/context/links`, { sourceAreaId: b1 })).status).toBe(200);
      await share(b, 'view');
      expect((await (await call(mate, 'GET', `/api/canvases/${b}/areas/${b1}/context`)).json()).usedBy).toEqual([{ areaId: a1, title: null }]);
    });

    it('lists context sources only from readable canvases', async () => {
      const a = await canvas(owner, 'A');
      const a1 = await area(owner, a, 'A1');
      const b = await canvas(owner, 'B');
      const b1 = await area(owner, b, 'B1');
      const mine = await canvas(mate, 'Mine');
      const m1 = await area(mate, mine, 'M1');
      await share(a, 'view');
      const sort = (rows: any[]) => [...rows].sort((x, y) => x.title.localeCompare(y.title));
      expect(sort(await (await call(owner, 'GET', '/api/canvases/context-sources')).json())).toEqual([
        { canvasId: a, canvasName: 'A', areaId: a1, title: 'A1' },
        { canvasId: b, canvasName: 'B', areaId: b1, title: 'B1' },
      ]);
      expect(sort(await (await call(mate, 'GET', '/api/canvases/context-sources')).json())).toEqual([
        { canvasId: a, canvasName: 'A', areaId: a1, title: 'A1' },
        { canvasId: mine, canvasName: 'Mine', areaId: m1, title: 'M1' },
      ]);
    });

    it('removes stored files when their area or canvas is deleted', async () => {
      const a = await canvas(owner, 'A');
      const a1 = await area(owner, a, 'A1');
      const a2 = await area(owner, a, 'A2');
      expect((await upload(owner, `/api/canvases/${a}/areas/${a1}/context/files`, [{ name: '1.txt', content: '1' }, { name: '2.txt', content: '2' }])).status).toBe(201);
      const [kept] = await (await upload(owner, `/api/canvases/${a}/areas/${a2}/context/files`, [{ name: '3.txt', content: '3' }])).json();
      expect((await upload(owner, `/api/canvases/${a}/context/files`, [{ name: '4.txt', content: '4' }])).status).toBe(201);
      expect(stored()).toHaveLength(4);

      expect((await call(owner, 'DELETE', `/api/canvases/${a}/areas/${a1}?version=99`)).status).toBe(409);
      expect(stored()).toHaveLength(4);
      expect((await call(owner, 'DELETE', `/api/canvases/${a}/areas/${a1}?version=0`)).status).toBe(204);
      expect(stored()).toHaveLength(2);
      expect(await (await call(owner, 'GET', `/api/canvases/${a}/context/files/${kept.id}`)).text()).toBe('3');

      expect((await call(owner, 'DELETE', `/api/canvases/${a}?version=${await version(a)}`)).status).toBe(204);
      expect(stored()).toEqual([]);
    });

    it("summarises every area's context and links for the board in one request", async () => {
      const a = await canvas(owner, 'A');
      const a1 = await area(owner, a, 'Notes area');
      const a2 = await area(owner, a, 'Files area');
      const a3 = await area(owner, a, 'Linking area');
      const b = await canvas(owner, 'B');
      const b1 = await area(owner, b, 'Brand kit');
      const summary = async (h: Record<string, string>, canvasId = a) => {
        const res = await call(h, 'GET', `/api/canvases/${canvasId}/context/summary`);
        expect(res.status).toBe(200);
        expect(res.headers.get('cache-control')).toBe('no-store');
        const body = await res.json();
        // Links made in the same millisecond list by source id, so compare them by id too.
        const byId = (rows: { areaId?: string; sourceAreaId?: string }[]) => [...rows].sort((x, y) => (x.areaId ?? x.sourceAreaId)!.localeCompare((y.areaId ?? y.sourceAreaId)!));
        return { ...body, areas: byId(body.areas).map((row: any) => ({ ...row, links: byId(row.links) })) };
      };
      const sorted = <T extends { areaId: string }>(rows: T[]) => [...rows].sort((x, y) => x.areaId.localeCompare(y.areaId));
      expect(await summary(owner)).toEqual({
        canvas: { hasContext: false },
        areas: sorted([a1, a2, a3].map(areaId => ({ areaId, hasContext: false, links: [] }))),
      });

      expect((await call(owner, 'PUT', `/api/canvases/${a}/areas/${a1}/context`, { notes: 'Ship on Friday', version: 0 })).status).toBe(200);
      expect((await upload(owner, `/api/canvases/${a}/areas/${a2}/context/files`, [{ name: 'brief.txt', content: 'brief' }])).status).toBe(201);
      expect((await call(owner, 'PUT', `/api/canvases/${a}/context`, { notes: 'Whole canvas', version: 0 })).status).toBe(200);
      expect((await call(owner, 'POST', `/api/canvases/${a}/areas/${a3}/context/links`, { sourceAreaId: a1 })).status).toBe(200);
      expect((await call(owner, 'POST', `/api/canvases/${a}/areas/${a3}/context/links`, { sourceAreaId: b1 })).status).toBe(200);
      expect(await summary(owner)).toEqual({
        canvas: { hasContext: true },
        areas: sorted([
          { areaId: a1, hasContext: true, links: [] },
          { areaId: a2, hasContext: true, links: [] },
          // A link alone is not this area's own context.
          { areaId: a3, hasContext: false, links: [
            { sourceAreaId: a1, title: 'Notes area', available: true },
            { sourceAreaId: b1, title: 'Brand kit', available: true },
          ].sort((x, y) => x.sourceAreaId.localeCompare(y.sourceAreaId)) },
        ]),
      });
      // Emptied notes no longer count.
      expect((await call(owner, 'PUT', `/api/canvases/${a}/context`, { notes: '', version: 1 })).status).toBe(200);
      expect((await summary(owner)).canvas).toEqual({ hasContext: false });

      // A viewer never learns the title of an area on a canvas they cannot read.
      expect((await call(mate, 'GET', `/api/canvases/${a}/context/summary`)).status).toBe(404);
      await share(a, 'view');
      expect((await summary(mate)).areas.find((row: { areaId: string }) => row.areaId === a3).links).toEqual([
        { sourceAreaId: a1, title: 'Notes area', available: true },
        { sourceAreaId: b1, title: 'Unavailable area', available: true },
      ].sort((x, y) => x.sourceAreaId.localeCompare(y.sourceAreaId)));
      expect(await summary(owner, b)).toEqual({ canvas: { hasContext: false }, areas: [{ areaId: b1, hasContext: false, links: [] }] });
    });

    it('lists no readers for an area on another canvas or with no chats, and unconfigured agents on a server without a service token', async () => {
      await call(owner, 'POST', '/api/runners/register', { existingRunnerId: 'fixture-runner', displayName: 'Fixture' });
      await agent('Pip');
      const launch = await chat('Launch', ['Pip']);
      const a = await canvas(owner, 'A');
      const a1 = await area(owner, a, 'A1');
      // Away from A1, so the card's first placement homes the chat in A1 only.
      const a2 = randomUUID();
      expect((await call(owner, 'POST', `/api/canvases/${a}/areas`, { id: a2, title: 'A2', x: 1000, y: 0, w: 400, h: 300 })).status).toBe(201);
      const b = await canvas(owner, 'B');
      const b1 = await area(owner, b, 'B1');
      await place(a, launch);
      before = await engineEvents();
      const readers = (h: Record<string, string>, canvasId: string, areaId: string) => call(h, 'GET', `/api/canvases/${canvasId}/areas/${areaId}/context/readers`);

      expect((await readers(owner, a, b1)).status).toBe(404);
      expect((await readers(owner, a, randomUUID())).status).toBe(404);
      expect((await readers(mate, a, a1)).status).toBe(404);
      const res = await readers(owner, a, a1);
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(product.store.canvasContext.home(launch)).toEqual({ canvasId: a, areaId: a1 });
      expect(await res.json()).toEqual([{ agentName: 'Pip', state: 'unconfigured' }]);
      expect(await (await readers(owner, a, a2)).json()).toEqual([]);
      // Context in the area changes nothing: this server cannot give Pip a key.
      expect((await call(owner, 'PUT', `/api/canvases/${a}/areas/${a1}/context`, { notes: 'Ship on Friday', version: 0 })).status).toBe(200);
      expect(await (await readers(owner, a, a1)).json()).toEqual([{ agentName: 'Pip', state: 'unconfigured' }]);
      // A canvas viewer outside the chat learns nothing about who is in it.
      await share(a, 'view');
      expect(await (await readers(mate, a, a1)).json()).toEqual([]);

      // The panel warning's signal: a scope is in chats when a chat's home reads it, including through a link.
      const inChats = async (path: string) => ((await (await call(owner, 'GET', path)).json()) as { inChats: boolean }).inChats;
      expect(await inChats(`/api/canvases/${a}/areas/${a1}/context`)).toBe(true);
      expect(await inChats(`/api/canvases/${a}/context`)).toBe(true);
      expect(await inChats(`/api/canvases/${a}/areas/${a2}/context`)).toBe(false);
      expect(await inChats(`/api/canvases/${b}/areas/${b1}/context`)).toBe(false);
      expect((await call(owner, 'POST', `/api/canvases/${a}/areas/${a1}/context/links`, { sourceAreaId: b1 })).status).toBe(200);
      expect(await inChats(`/api/canvases/${b}/areas/${b1}/context`)).toBe(true);
      expect(await inChats(`/api/canvases/${b}/context`)).toBe(false);
    });
  });

  describe('flag on with a service token', () => {
    beforeEach(() => boot(true, 'runner-secret'));

    it("reports which agents in the area's chats can read its context", async () => {
      await call(owner, 'POST', '/api/runners/register', { existingRunnerId: 'fixture-runner', displayName: 'Fixture' });
      await agent('Pip');
      await agent('Wren', 'WRAPPED');
      const launch = await chat('Launch', ['Pip', 'Wren']);
      const a = await canvas(owner, 'A');
      const a1 = await area(owner, a, 'A1');
      await place(a, launch);
      const readers = async () => {
        const res = await call(owner, 'GET', `/api/canvases/${a}/areas/${a1}/context/readers`);
        expect(res.status).toBe(200);
        return [...await res.json()].sort((x: { agentName: string }, y: { agentName: string }) => x.agentName.localeCompare(y.agentName));
      };
      // Setting up an agent's key writes engine secrets and skills (and their events); the chat itself stays quiet.
      before = null;
      const chatEvents = async () => ((await (await call(owner, 'GET', `/api/events?channelId=${launch}&limit=1000`)).json()) as unknown[]).length;
      const quiet = await chatEvents();
      // No context yet, so Pip has no key; the first write sets Pip up before it answers, so Pip reads as ready (R8).
      expect(product.store.canvasContext.keyFor('Pip')).toBeFalsy();
      expect(await readers()).toEqual([{ agentName: 'Pip', state: 'ready' }, { agentName: 'Wren', state: 'wrapped' }]);
      expect((await call(owner, 'PUT', `/api/canvases/${a}/areas/${a1}/context`, { notes: 'Ship on Friday', version: 0 })).status).toBe(200);
      expect(product.store.canvasContext.keyFor('Pip')).toBeTruthy();
      expect(await readers()).toEqual([{ agentName: 'Pip', state: 'ready' }, { agentName: 'Wren', state: 'wrapped' }]);
      // A key lost once the home has context means setup failed: unconfigured.
      product.store.db.prepare('DELETE FROM product_context_agents').run();
      expect(await readers()).toEqual([{ agentName: 'Pip', state: 'unconfigured' }, { agentName: 'Wren', state: 'wrapped' }]);
      expect(await chatEvents()).toBe(quiet);
    });
  });
});
