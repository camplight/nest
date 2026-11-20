import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp as createEngine } from '../../../vendor/orgops/apps/api/src/app';
import { createOrgOpsClient } from '@nest/orgops-client';
import { createApp } from './app';

describe('archiving a chat through Nest, against the unchanged engine', () => {
  let dir: string, engine: ReturnType<typeof createEngine>, product: ReturnType<typeof createApp>;
  let owner: Record<string, string>, mate: Record<string, string>, ownerId: string;
  const json = { 'content-type': 'application/json' };
  const call = (h: Record<string, string>, method: string, path: string, body?: unknown) =>
    product.app.request(path, { method, headers: h, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const chat = async (h: Record<string, string>, name: string) => (await (await call(h, 'POST', '/api/channels', { name, visibility: 'PRIVATE' })).json()).id as string;
  const link = (from: string, to: string) => product.store.flows.createLink({ id: randomUUID(), from, to, kind: 'link', createdBy: ownerId, now: 1000 });

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'nest-archive-test-'));
    engine = createEngine({ dbPath: join(dir, 'engine.sqlite'), dataDir: dir, adminUser: 'owner', adminPass: 'password', runnerToken: 'runner-secret' });
    const client = createOrgOpsClient('http://engine', (async (url, init) => engine.app.fetch(new Request(url, init))) as typeof fetch);
    product = createApp({ orgops: client, dbPath: join(dir, 'product.sqlite'), canvasEnabled: true });
    const login = async (username: string) => {
      const r = await call(json, 'POST', '/api/auth/login', { username, password: 'password' });
      return { ...json, cookie: r.headers.get('set-cookie')!.split(';')[0] };
    };
    owner = await login('owner');
    await call(owner, 'POST', '/api/humans/invite', { username: 'mate', tempPassword: 'password' });
    const humans = await (await call(owner, 'GET', '/api/humans')).json();
    ownerId = humans.find((h: any) => h.username === 'owner').id;
    engine.db.prepare('UPDATE humans SET must_change_password=0 WHERE username=?').run('mate');
    mate = await login('mate');
  });
  afterEach(() => { product.store.close(); engine.db.close(); rmSync(dir, { recursive: true, force: true }); });

  it('archiving through Nest pauses links to the chat and declines waiting hand-offs', async () => {
    const a = await chat(owner, 'Source'), b = await chat(owner, 'Target');
    const l = link(a, b);
    const waiting = product.store.flows.claimDelivery(l.id, 'turn-1', 'awaiting', 1000)!;
    const res = await call(owner, 'POST', `/api/channels/${b}/archive`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, id: b });
    expect(product.store.flows.link(l.id)).toMatchObject({ on: false, pausedReason: 'archived' });
    expect(product.store.flows.delivery(waiting.id)).toMatchObject({ status: 'declined' });
  });

  it('unarchiving resumes them unless the other end is still archived', async () => {
    const a = await chat(owner, 'Source'), b = await chat(owner, 'Target');
    const l = link(a, b);
    await call(owner, 'POST', `/api/channels/${b}/archive`);
    await call(owner, 'POST', `/api/channels/${a}/archive`);
    expect((await call(owner, 'POST', `/api/channels/${b}/unarchive`)).status).toBe(200);
    expect(product.store.flows.link(l.id)).toMatchObject({ on: false, pausedReason: 'archived' });
    await call(owner, 'POST', `/api/channels/${a}/unarchive`);
    expect(product.store.flows.link(l.id)).toMatchObject({ on: true, pausedReason: null });
  });

  it('unarchiving leaves a link paused while its creator still hides the other end', async () => {
    const a = await chat(owner, 'Source'), b = await chat(owner, 'Target');
    const l = link(a, b);
    await call(owner, 'POST', '/api/canvases/hidden', { channelIds: [a], hidden: true });
    await call(owner, 'POST', `/api/channels/${b}/archive`);
    await call(owner, 'POST', `/api/channels/${b}/unarchive`);
    expect(product.store.flows.link(l.id)).toMatchObject({ on: false, pausedReason: 'archived' });
  });

  it('an engine refusal changes nothing', async () => {
    const a = await chat(owner, 'Source'), b = await chat(owner, 'Target');
    const l = link(a, b);
    const res = await call(mate, 'POST', `/api/channels/${b}/archive`);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden' });
    expect(product.store.flows.link(l.id)).toMatchObject({ on: true, pausedReason: null });
  });

  it('deleting a chat through Nest removes its hand-off links; a refused delete keeps them', async () => {
    const a = await chat(owner, 'Source'), b = await chat(owner, 'Target'), c = await chat(owner, 'Other');
    const gone = link(a, b), kept = link(a, c);
    const waiting = product.store.flows.claimDelivery(gone.id, 'turn-1', 'awaiting', 1000)!;
    expect((await call(mate, 'DELETE', `/api/channels/${b}`)).status).toBe(403);
    expect(product.store.flows.link(gone.id)).not.toBeNull();
    expect((await call(owner, 'DELETE', `/api/channels/${b}`)).status).toBeLessThan(300);
    expect(product.store.flows.link(gone.id)).toBeNull();
    expect(product.store.flows.delivery(waiting.id)).toBeNull();
    expect(product.store.flows.link(kept.id)).not.toBeNull();
  });
});
