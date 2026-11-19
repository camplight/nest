import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { createApp as createEngine } from '../../../../vendor/orgops/apps/api/src/app';
import { shouldHandleEventForAgent } from '../../../../vendor/orgops/apps/agent-runner/src/event-routing';
import { createOrgOpsClient, type EngineEvent } from '@nest/orgops-client';
import type { FlowNeed } from '@nest/schemas';
import { createApp } from '../app';
import type { Summarize } from './summarize';
import { watchEngine } from './engine-watch';

const RUNNER = 'runner-secret';
type H = Record<string, string>;
const json = { 'content-type': 'application/json' };

describe('the hand-off worker against the unchanged engine', () => {
  let dir: string, engine: ReturnType<typeof createEngine>, product: ReturnType<typeof createApp>;
  let client: ReturnType<typeof createOrgOpsClient>;
  let owner: H, mate: H, ownerId: string, a: string, b: string, clock: number;
  let extraApps: ReturnType<typeof createApp>[];
  // Transport faults: reject every request, or drop the response of the next service POST /api/events.
  let outage: boolean, dropNextPost: boolean;
  // Rejects the next request that matches, before the engine sees it.
  let failNext: ((url: URL) => boolean) | null;
  // Holds the next service POST /api/events until its gate opens; `held` is called when it arrives.
  let hold: { held: () => void; gate: Promise<void> } | null;
  // Runs after the engine answers a matching request, before Nest sees the answer.
  let afterEngine: ((url: URL) => Promise<void>) | null;
  let summary: Summarize;
  const logs: string[] = [];

  const call = (h: H, method: string, path: string, body?: unknown) =>
    product.app.request(path, { method, headers: h, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const runner = (method: string, path: string, body?: unknown) =>
    engine.app.request(path, { method, headers: { ...json, 'x-orgops-runner-token': RUNNER }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const boot = (extra: Parameters<typeof createApp>[0] = {}) => createApp({
    orgops: client, dbPath: join(dir, 'product.sqlite'), canvasEnabled: true, contextFilesDir: join(dir, 'context-files'),
    connectionEngineToken: RUNNER, switchyardName: 'Switchyard', switchyardCreator: 'NestSystem', switchyardWorkspaceRoot: join(dir, 'managed'),
    summarize: input => summary(input), flowsNow: () => clock, ...extra,
  });
  const login = async (username: string) => {
    const r = await call(json, 'POST', '/api/auth/login', { username, password: 'password' });
    return { ...json, cookie: r.headers.get('set-cookie')!.split(';')[0] };
  };
  const chat = async (name: string, members: { type: 'HUMAN' | 'AGENT' | 'TEAM'; id: string }[]) => {
    const id = (await (await call(owner, 'POST', '/api/channels', { name, visibility: 'PRIVATE' })).json()).id as string;
    for (const m of members) expect((await call(owner, 'POST', `/api/channels/${id}/subscribe`, { subscriberType: m.type, subscriberId: m.id })).status).toBe(200);
    return id;
  };
  const emit = async (type: string, source: string, channelId: string, payload: Record<string, unknown>) => {
    const res = await runner('POST', '/api/events', { type, source, channelId, payload });
    expect(res.status, await res.clone().text()).toBe(201);
    return (await res.json()) as EngineEvent;
  };
  type Said = string | { text: string; attachments: { fileId: string; name: string; mime: string; size: number }[] };
  /** One agent turn: started, the agent's messages, completed (as the runner emits them). */
  const turn = async (channelId: string, said: Said[], { agent = 'Pip', noReply = false } = {}) => {
    const triggerEventId = randomUUID();
    await emit('agent.turn.started', `agent:${agent}`, channelId, { triggerEventId, eventCount: 1 });
    for (const s of said) await emit('message.created', `agent:${agent}`, channelId, typeof s === 'string' ? { text: s } : s);
    return emit('agent.turn.completed', `agent:${agent}`, channelId, { triggerEventId, eventCount: 1, ...(noReply ? { noReply: true } : {}) });
  };
  const upload = async (name: string, text: string) => {
    const form = new FormData();
    form.append('file', new Blob([text], { type: 'text/plain' }), name);
    const res = await engine.app.request('/api/files', { method: 'POST', headers: { 'x-orgops-runner-token': RUNNER }, body: form });
    expect(res.status).toBe(201);
    return { fileId: ((await res.json()) as { id: string }).id, name, mime: 'text/plain', size: text.length };
  };
  /** Hand-offs posted into a chat, oldest first. */
  const handoffs = async (channelId: string) =>
    ((await (await runner('GET', `/api/events?channelId=${channelId}&type=message.created&source=agent:Switchyard&order=asc&limit=1000`)).json()) as EngineEvent[])
      .filter(e => (e.payload.nestSwitchyard as { kind?: string } | undefined)?.kind === 'handoff');
  const link = async (h: H, body: Record<string, unknown>) => {
    const res = await call(h, 'POST', '/api/flows/links', { id: randomUUID(), ...body });
    expect(res.status, await res.clone().text()).toBe(201);
    return (await res.json()) as { id: string; version: number };
  };
  const tick = async (worker = product) => { clock += 1000; await worker.flows.tick(); };
  const needs = async (h: H) => {
    const res = await call(h, 'GET', '/api/flows/needs');
    expect(res.status).toBe(200);
    return ((await res.json()) as { items: FlowNeed[] }).items;
  };
  const deliveries = (linkId: string) =>
    (product.store.db.prepare('SELECT id FROM product_link_deliveries WHERE link_id=? ORDER BY created_at').all(linkId) as { id: string }[])
      .map(r => product.store.flows.delivery(r.id)!);
  const routes = (name: string, event: EngineEvent) =>
    shouldHandleEventForAgent({ name, workspacePath: join(dir, name), modelId: 'test', desiredState: 'RUNNING', runtimeState: 'RUNNING' }, event);

  beforeEach(async () => {
    vi.stubEnv('ORGOPS_MASTER_KEY', Buffer.alloc(32, 99).toString('base64'));
    dir = mkdtempSync(join(tmpdir(), 'nest-handoff-test-'));
    outage = false; dropNextPost = false; afterEngine = null; failNext = null; hold = null; extraApps = []; logs.length = 0;
    clock = Date.now();
    summary = async ({ texts }) => ({ text: `Summary unavailable. The latest result, shortened:\n${texts.at(-1) ?? ''}`, model: null });
    engine = createEngine({ dbPath: join(dir, 'engine.sqlite'), dataDir: dir, projectRoot: dir, adminUser: 'owner', adminPass: 'password', runnerToken: RUNNER });
    client = createOrgOpsClient('http://engine', (async (url, init) => {
      if (outage) throw new TypeError('fetch failed');
      const target = new URL(String(url));
      if (failNext?.(target)) { failNext = null; throw new TypeError('fetch failed'); }
      if (hold && init?.method === 'POST' && target.pathname === '/api/events' && new Headers(init?.headers).get('x-orgops-runner-token')) {
        const current = hold;
        hold = null;
        current.held();
        await current.gate;
      }
      const response = await engine.app.fetch(new Request(url, init));
      if (dropNextPost && init?.method === 'POST' && target.pathname === '/api/events' && new Headers(init?.headers).get('x-orgops-runner-token')) {
        // The engine stored the event; Nest never learns its id.
        dropNextPost = false;
        throw new TypeError('fetch failed');
      }
      if (afterEngine) await afterEngine(target);
      return response;
    }) as typeof fetch);
    product = boot();
    owner = await login('owner');
    ownerId = (await (await call(owner, 'GET', '/api/humans')).json()).find((h: any) => h.username === 'owner').id;
    expect((await call(owner, 'POST', '/api/humans/invite', { username: 'mate', tempPassword: 'password' })).status).toBeLessThan(300);
    engine.db.prepare("UPDATE humans SET must_change_password=0 WHERE username='mate'").run();
    mate = await login('mate');
    for (const name of ['Pip', 'Pom']) {
      const res = await call(owner, 'POST', '/api/agents', { name, modelId: 'test', workspacePath: join(dir, name), desiredState: 'STOPPED' });
      expect(res.status, await res.clone().text()).toBe(201);
    }
    // Nest's SYSTEM-role management agent: the engine takes Switchyard's owner and visibility only from one.
    expect((await call(owner, 'POST', '/api/agents', { name: 'NestSystem', agentRole: 'SYSTEM', modelId: 'test', workspacePath: join(dir, 'NestSystem'), desiredState: 'STOPPED' })).status).toBe(201);
    // A: Pip's chat. B: Pom's chat. Both owned by the owner, with mate as a member.
    a = await chat('A', [{ type: 'AGENT', id: 'Pip' }, { type: 'HUMAN', id: 'mate' }]);
    b = await chat('B', [{ type: 'AGENT', id: 'Pom' }, { type: 'HUMAN', id: 'mate' }]);
    vi.spyOn(console, 'warn').mockImplementation(line => { logs.push(String(line)); });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    for (const extra of extraApps) extra.store.close();
    product.store.close(); engine.db.close(); rmSync(dir, { recursive: true, force: true });
  });

  it('hands off results and files to the chosen agent once', async () => {
    const l = await link(owner, { from: a, to: b, who: 'Pom' });
    const file = await upload('draft.txt', 'the draft');
    const done = await turn(a, [{ text: 'Draft ready', attachments: [file] }]);
    await tick();
    const [handoff, ...rest] = await handoffs(b);
    expect(rest).toEqual([]);
    expect(handoff).toMatchObject({ source: 'agent:Switchyard', channelId: b, idempotencyKey: `nest:handoff:${l.id}:${done.id}` });
    expect(handoff.payload).toEqual({
      text: 'Hand-off from A · set up by owner\n\nDraft ready', targetAgentName: 'Pom', attachments: [file],
      nestSwitchyard: { kind: 'handoff', setBy: ownerId, linkId: l.id, sourceChannelId: a, sourceTurnId: done.id },
    });
    expect(routes('Pom', handoff)).toBe(true);
    expect(routes('Pip', handoff)).toBe(false);
    expect(deliveries(l.id)).toEqual([expect.objectContaining({ status: 'delivered', targetEventId: handoff.id, sourceTurnId: done.id })]);
    await tick();
    expect(await handoffs(b)).toHaveLength(1);

    // Several results: each cut to 8,000 characters, joined.
    await turn(a, ['x'.repeat(9000), 'And a note']);
    await tick();
    const second = (await handoffs(b))[1];
    expect(second.payload.text).toBe(`Hand-off from A · set up by owner\n\n${'x'.repeat(8000)}\n\nAnd a note`);
    expect(second.payload).not.toHaveProperty('attachments');
  });

  it('ignores turns before the link existed and turns with no results', async () => {
    await turn(a, ['Old work']);
    const l = await link(owner, { from: a, to: b, who: 'Pom' });
    await turn(a, ['Thinking out loud'], { noReply: true });
    const empty = await turn(a, []);
    // Another agent's words do not count as Pip's results.
    const triggerEventId = randomUUID();
    await emit('agent.turn.started', 'agent:Pip', a, { triggerEventId });
    await emit('message.created', 'human:owner', a, { text: 'Owner aside' });
    const quiet = await emit('agent.turn.completed', 'agent:Pip', a, { triggerEventId });
    await tick();
    expect(await handoffs(b)).toEqual([]);
    expect(deliveries(l.id)).toEqual([]);
    expect(product.store.flows.scannedTo(l.id)).toBe(quiet.createdAt);
    expect(quiet.createdAt).toBeGreaterThan(empty.createdAt);
    await turn(a, ['New work']);
    await tick();
    expect((await handoffs(b)).map(e => e.payload.text)).toEqual(['Hand-off from A · set up by owner\n\nNew work']);
  });

  it('hands off a turn that completes while the link is being created', async () => {
    // The link's newest-turn read finds nothing; a turn completes before the link row is written.
    let raced: EngineEvent | null = null;
    afterEngine = async url => {
      if (url.pathname === '/api/events' && url.searchParams.get('type') === 'agent.turn.completed' && url.searchParams.get('order') === 'desc' && !raced) {
        afterEngine = null;
        raced = await turn(a, ['Finished mid-setup']);
      }
    };
    const l = await link(owner, { from: a, to: b, who: 'Pom' });
    expect(raced).not.toBeNull();
    await tick();
    expect((await handoffs(b)).map(e => e.payload.nestSwitchyard)).toEqual([expect.objectContaining({ linkId: l.id, sourceTurnId: raced!.id })]);
  });

  it('never hands off its own posts', async () => {
    await link(owner, { from: b, to: a, who: 'Pip' });
    await product.switchyard.post({ channelId: b, text: 'A note in B', target: null, kind: 'note', setBy: ownerId, idempotencyKey: 'nest:note:test:1' });
    // A turn under the service agent's name (it never takes one) is skipped too.
    await turn(b, ['Switchyard talking'], { agent: 'Switchyard' });
    await tick();
    expect(await handoffs(a)).toEqual([]);
  });

  it('waits for approval and posts on approve', async () => {
    const l = await link(owner, { from: a, to: b, who: 'Pom', when: 'approve' });
    await turn(a, ['Draft ready']);
    await tick();
    expect(await handoffs(b)).toEqual([]);
    const [waiting] = deliveries(l.id);
    expect(waiting).toMatchObject({ status: 'awaiting', leaseUntil: null });
    expect(await needs(owner)).toEqual([{
      key: `approval:${waiting.id}`, kind: 'approval', channelId: a, at: waiting.createdAt, from: 'Pip',
      short: 'Approve hand-off to B', reason: 'Approve hand-off to B', detail: 'Pip finished something in A. It goes to B after your OK.',
      gate: { kind: 'approval', deliveryId: waiting.id, linkId: l.id }, chatTitle: 'A',
    }]);
    expect(await needs(mate)).toEqual([]);
    // Only the creator decides.
    expect((await call(mate, 'POST', `/api/flows/deliveries/${waiting.id}/decision`, { decision: 'approve' })).status).toBe(403);
    expect((await call(owner, 'POST', `/api/flows/deliveries/${waiting.id}/decision`, { decision: 'maybe' })).status).toBe(400);
    expect((await call(owner, 'POST', `/api/flows/deliveries/${waiting.id}/decision`, { decision: 'approve' })).status).toBe(204);
    expect((await handoffs(b)).map(e => e.payload.text)).toEqual(['Hand-off from A · set up by owner\n\nDraft ready']);
    expect(product.store.flows.delivery(waiting.id)).toMatchObject({ status: 'delivered', targetEventId: (await handoffs(b))[0].id });
    expect((await call(owner, 'POST', `/api/flows/deliveries/${waiting.id}/decision`, { decision: 'approve' })).status).toBe(409);
    await tick();
    expect(await handoffs(b)).toHaveLength(1);
    expect(await needs(owner)).toEqual([]);

    await turn(a, ['Second draft']);
    await tick();
    const declined = deliveries(l.id)[1];
    expect(declined.status).toBe('awaiting');
    expect((await call(owner, 'POST', `/api/flows/deliveries/${declined.id}/decision`, { decision: 'decline' })).status).toBe(204);
    await tick();
    expect(product.store.flows.delivery(declined.id)).toMatchObject({ status: 'declined', targetEventId: null });
    expect(await handoffs(b)).toHaveLength(1);
    expect((await call(owner, 'POST', `/api/flows/deliveries/${randomUUID()}/decision`, { decision: 'approve' })).status).toBe(404);
  });

  it('a paused link delivers nothing through Approve', async () => {
    const l = await link(owner, { from: a, to: b, who: 'Pom', when: 'approve' });
    await turn(a, ['Draft ready']);
    await tick();
    const [waiting] = deliveries(l.id);
    expect((await call(owner, 'PATCH', `/api/flows/links/${l.id}`, { on: false, version: 0 })).status).toBe(200);
    const refused = await call(owner, 'POST', `/api/flows/deliveries/${waiting.id}/decision`, { decision: 'approve' });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: 'This hand-off is paused' });
    await tick();
    expect(await handoffs(b)).toEqual([]);
    expect(product.store.flows.delivery(waiting.id)).toMatchObject({ status: 'awaiting' });
  });

  it('a decline racing an approve loses, and the approved hand-off is delivered', async () => {
    const l = await link(owner, { from: a, to: b, who: 'Pom', when: 'approve' });
    await turn(a, ['Draft ready']);
    await tick();
    const [waiting] = deliveries(l.id);
    let release!: () => void;
    const arrived = new Promise<void>(held => { hold = { held, gate: new Promise<void>(r => { release = r; }) }; });
    const approving = call(owner, 'POST', `/api/flows/deliveries/${waiting.id}/decision`, { decision: 'approve' });
    await arrived;
    // The approve holds the row while its post is in flight.
    expect(product.store.flows.delivery(waiting.id)).toMatchObject({ status: 'claimed' });
    const decline = await call(owner, 'POST', `/api/flows/deliveries/${waiting.id}/decision`, { decision: 'decline' });
    expect(decline.status).toBe(409);
    release();
    expect((await approving).status).toBe(204);
    const posted = await handoffs(b);
    expect(posted).toHaveLength(1);
    expect(product.store.flows.delivery(waiting.id)).toMatchObject({ status: 'delivered', targetEventId: posted[0].id });
  });

  it('a lost approve response is finished by the retry, exactly once', async () => {
    const l = await link(owner, { from: a, to: b, who: 'Pom', when: 'approve' });
    await turn(a, ['Draft ready']);
    await tick();
    const [waiting] = deliveries(l.id);
    dropNextPost = true;
    expect((await call(owner, 'POST', `/api/flows/deliveries/${waiting.id}/decision`, { decision: 'approve' })).status).toBe(502);
    expect(await handoffs(b)).toHaveLength(1);
    expect(product.store.flows.delivery(waiting.id)).toMatchObject({ status: 'claimed', targetEventId: null });
    // Declining now cannot rewrite what was approved.
    expect((await call(owner, 'POST', `/api/flows/deliveries/${waiting.id}/decision`, { decision: 'decline' })).status).toBe(409);
    expect(await needs(owner)).toEqual([]);
    clock += 61_000;
    await tick();
    const posted = await handoffs(b);
    expect(posted).toHaveLength(1);
    expect(product.store.flows.delivery(waiting.id)).toMatchObject({ status: 'delivered', targetEventId: posted[0].id });
  });

  it('disconnecting keeps what was already handed off', async () => {
    const l = await link(owner, { from: a, to: b, who: 'Pom' });
    await turn(a, ['Draft ready']);
    await tick();
    const [before] = await handoffs(b);
    expect((await call(owner, 'DELETE', `/api/flows/links/${l.id}?version=0`)).status).toBe(204);
    expect(await handoffs(b)).toEqual([before]);
    expect(deliveries(l.id)).toEqual([]);
    await turn(a, ['After disconnecting']);
    await tick();
    expect(await handoffs(b)).toEqual([before]);
  });

  it('Send now hands off the newest result on a manual link', async () => {
    const l = await link(owner, { from: a, to: b, who: 'Pom', when: 'manual' });
    expect((await call(owner, 'POST', `/api/flows/links/${l.id}/send`)).status).toBe(409);
    await turn(a, ['First']);
    await turn(a, ['Second']);
    await turn(a, []);
    await tick();
    expect(await handoffs(b)).toEqual([]);
    // A member of the receiving chat may send.
    const sent = await call(mate, 'POST', `/api/flows/links/${l.id}/send`);
    expect(sent.status, await sent.clone().text()).toBe(200);
    expect(await sent.json()).toEqual({ status: 'sent' });
    expect((await handoffs(b)).map(e => e.payload.text)).toEqual(['Hand-off from A · set up by owner\n\nSecond']);
    const again = await call(owner, 'POST', `/api/flows/links/${l.id}/send`);
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: 'Nothing new to hand off yet.' });
    await tick();
    expect(await handoffs(b)).toHaveLength(1);
    // A paused link sends nothing, whoever asks.
    await turn(a, ['Third']);
    expect((await call(owner, 'PATCH', `/api/flows/links/${l.id}`, { on: false, version: 0 })).status).toBe(200);
    const paused = await call(mate, 'POST', `/api/flows/links/${l.id}/send`);
    expect(paused.status).toBe(409);
    expect(await paused.json()).toEqual({ error: 'This hand-off is paused' });
    expect(await handoffs(b)).toHaveLength(1);
    expect(deliveries(l.id)).toHaveLength(1);
  });

  it('Send now on an approve or automatic link is the creator\'s alone, so a target member cannot skip the OK (final I3)', async () => {
    const l = await link(owner, { from: a, to: b, who: 'Pom', when: 'approve' });
    const auto = await link(owner, { from: b, to: a, who: 'Pip' });
    await turn(a, ['Draft ready']);
    await turn(b, ['Notes'], { agent: 'Pom' });
    for (const id of [l.id, auto.id]) {
      const refused = await call(mate, 'POST', `/api/flows/links/${id}/send`);
      expect(refused.status).toBe(403);
      expect(await refused.json()).toEqual({ error: 'Only the person who set up this hand-off can send it now' });
      expect(deliveries(id)).toEqual([]);
    }
    expect(await handoffs(b)).toEqual([]);
    expect(await handoffs(a)).toEqual([]);
    // The creator may.
    const sent = await call(owner, 'POST', `/api/flows/links/${l.id}/send`);
    expect(sent.status, await sent.clone().text()).toBe(200);
    expect((await handoffs(b)).map(e => e.payload.text)).toEqual(['Hand-off from A · set up by owner\n\nDraft ready']);
  });

  it('summary hand-offs carry the labelled summary', async () => {
    const asked: Parameters<Summarize>[0][] = [];
    summary = async input => { asked.push(input); return { text: 'Summary (by test-model):\n- Drafted the post', model: 'test-model' }; };
    const l = await link(owner, { from: a, to: b, who: 'Pom', what: 'summary' });
    await turn(a, ['Draft ready', 'Also fixed the title']);
    await tick();
    expect((await handoffs(b)).map(e => e.payload.text)).toEqual(['Hand-off from A · set up by owner\n\nSummary (by test-model):\n- Drafted the post']);
    expect(asked).toEqual([{ texts: ['Draft ready', 'Also fixed the title'], purpose: 'handoff', actor: ownerId, ref: { linkId: l.id } }]);
  });

  it('whole-conversation hand-offs attach a transcript', async () => {
    await link(owner, { from: a, to: b, who: 'Pom', what: 'all' });
    await emit('message.created', 'human:owner', a, { text: 'Kick off, please' });
    await turn(a, ['Draft ready']);
    await tick();
    const [handoff] = await handoffs(b);
    expect(handoff.payload.text).toBe('Hand-off from A · set up by owner\n\nThe whole conversation is attached.');
    const [file] = handoff.payload.attachments as { fileId: string; name: string; mime: string; size: number }[];
    expect(file).toMatchObject({ name: 'Transcript - A.md', mime: 'text/markdown' });
    const bytes = await (await runner('GET', `/api/files/${file.fileId}`)).text();
    expect(file.size).toBe(Buffer.byteLength(bytes));
    expect(bytes).toContain('**Pip** · ');
    expect(bytes).toContain('Draft ready');
    expect(bytes.indexOf('**owner**')).toBeLessThan(bytes.indexOf('**Pip**'));
  });

  it('a lost response and a restart deliver exactly once (Review Focus 1)', async () => {
    const l = await link(owner, { from: a, to: b, who: 'Pom' });
    await turn(a, ['Draft ready']);
    dropNextPost = true;
    await expect(tick()).resolves.toBeUndefined();
    expect(dropNextPost).toBe(false);
    // The engine has the hand-off; Nest does not know it yet.
    expect(await handoffs(b)).toHaveLength(1);
    expect(deliveries(l.id)).toEqual([expect.objectContaining({ status: 'claimed', targetEventId: null })]);
    expect(logs.some(line => line.includes('failed: EngineUnreachableError'))).toBe(true);

    // A new process on the same product DB, after both leases expired.
    clock += 61_000;
    const restarted = boot();
    extraApps.push(restarted);
    await restarted.flows.tick();
    const posted = await handoffs(b);
    expect(posted).toHaveLength(1);
    expect(deliveries(l.id)).toEqual([expect.objectContaining({ status: 'delivered', targetEventId: posted[0].id, attempts: 2 })]);
    await tick(restarted);
    expect(await handoffs(b)).toHaveLength(1);
  });

  it('an engine outage loses nothing', async () => {
    const l = await link(owner, { from: a, to: b, who: 'Pom' });
    const before = product.store.flows.scannedTo(l.id);
    await turn(a, ['Draft ready']);
    outage = true;
    await expect(tick()).resolves.toBeUndefined();
    expect(product.store.flows.scannedTo(l.id)).toBe(before);
    expect(deliveries(l.id)).toEqual([]);
    outage = false;
    await tick();
    await tick();
    expect(await handoffs(b)).toHaveLength(1);
    expect(deliveries(l.id)).toEqual([expect.objectContaining({ status: 'delivered' })]);
  });

  it('holds the cursor at a turn whose results could not be read', async () => {
    const l = await link(owner, { from: a, to: b, who: 'Pom' });
    const start = product.store.flows.scannedTo(l.id);
    await turn(a, ['First']);
    await turn(a, ['Second']);
    failNext = url => url.searchParams.get('type') === 'agent.turn.started';
    await tick();
    expect(failNext).toBeNull();
    expect(product.store.flows.scannedTo(l.id)).toBe(start);
    expect(await handoffs(b)).toEqual([]);
    await tick();
    expect((await handoffs(b)).map(e => e.payload.text)).toEqual(['Hand-off from A · set up by owner\n\nFirst', 'Hand-off from A · set up by owner\n\nSecond']);
  });

  it('a loop pauses at 20 an hour (Review Focus 2)', async () => {
    const ab = await link(owner, { from: a, to: b, who: 'Pom' });
    await link(owner, { from: b, to: a, who: 'Pip' });
    // 21 finished turns in A within one hour (S6), a tick after each.
    for (let i = 1; i <= 21; i++) {
      await turn(a, [`Round ${i}`]);
      clock += 60_000;
      await tick();
    }
    const posted = await handoffs(b);
    expect(posted).toHaveLength(20);
    expect(posted.at(-1)!.payload.text).toBe('Hand-off from A · set up by owner\n\nRound 20');
    expect(product.store.flows.link(ab.id)).toMatchObject({ on: false, pausedReason: 'cap' });
    expect(deliveries(ab.id)).toHaveLength(20);
    const items = await needs(owner);
    expect(items).toEqual([expect.objectContaining({ kind: 'paused', channelId: a, short: 'Hand-off to B paused · hit 20 an hour', gate: { kind: 'paused', linkId: ab.id } })]);
    // Switchyard's posts in B are not turns, so nothing flowed back into A.
    expect(await handoffs(a)).toEqual([]);
    await turn(a, ['Round 22']);
    await tick();
    expect(await handoffs(b)).toHaveLength(20);
  });

  it('pauses when the creator loses access to the target (Review Focus 3)', async () => {
    const l = await link(mate, { from: a, to: b, who: 'Pom' });
    expect((await call(owner, 'POST', `/api/channels/${b}/unsubscribe`, { subscriberType: 'HUMAN', subscriberId: 'mate' })).status).toBe(200);
    await turn(a, ['Draft ready']);
    await tick();
    expect(await handoffs(b)).toEqual([]);
    expect(product.store.flows.link(l.id)).toMatchObject({ on: false, pausedReason: 'access' });
    expect(deliveries(l.id)).toEqual([]);
    // Mate can no longer read B, so its title is withheld.
    expect(await needs(mate)).toEqual([expect.objectContaining({
      kind: 'paused', channelId: a, short: 'Hand-off to a private chat paused · access changed', gate: { kind: 'paused', linkId: l.id },
    })]);
    expect(await needs(owner)).toEqual([]);
  });

  it('reads a source shared to view, posts into a chat reached through a team, and pauses when the team goes (S9)', async () => {
    const team = (await (await call(owner, 'POST', '/api/teams', { name: 'Crew' })).json()).id as string;
    expect((await call(owner, 'POST', `/api/teams/${team}/members`, { memberType: 'HUMAN', memberId: 'mate' })).status).toBeLessThan(300);
    // S: the owner's own chat, shared with mate to view. T: Pom's chat, reached by mate only through the team.
    const s = await chat('S', [{ type: 'AGENT', id: 'Pip' }]);
    const t = await chat('T', [{ type: 'AGENT', id: 'Pom' }, { type: 'TEAM', id: team }]);
    expect((await call(owner, 'POST', `/api/channels/${s}/share`, { viewerType: 'HUMAN', viewerId: 'mate' })).status).toBe(200);
    const l = await link(mate, { from: s, to: t, who: 'Pom' });
    await turn(s, ['Draft ready']);
    await tick();
    expect((await handoffs(t)).map(e => e.payload.text)).toEqual(['Hand-off from S · set up by mate\n\nDraft ready']);
    expect(product.store.flows.link(l.id)).toMatchObject({ on: true, pausedReason: null });
    expect((await call(owner, 'DELETE', `/api/teams/${team}/members/HUMAN/mate`)).status).toBeLessThan(300);
    await turn(s, ['Second draft']);
    await tick();
    expect(await handoffs(t)).toHaveLength(1);
    expect(product.store.flows.link(l.id)).toMatchObject({ on: false, pausedReason: 'access' });
  });

  it('names the source chat a creator lost in Needs you, so the paused link is not dropped (final I1)', async () => {
    const l = await link(mate, { from: a, to: b, who: 'Pom' });
    expect((await call(owner, 'POST', `/api/channels/${a}/unsubscribe`, { subscriberType: 'HUMAN', subscriberId: 'mate' })).status).toBe(200);
    await turn(a, ['Draft ready']);
    await tick();
    expect(product.store.flows.link(l.id)).toMatchObject({ on: false, pausedReason: 'access' });
    expect(await needs(mate)).toEqual([expect.objectContaining({
      key: `paused:${l.id}`, kind: 'paused', channelId: a, chatTitle: 'a chat you can no longer open', short: 'Hand-off to B paused · access changed',
    })]);
  });

  it('pauses when the chosen agent leaves the target chat', async () => {
    const l = await link(owner, { from: a, to: b, who: 'Pom' });
    expect((await call(owner, 'POST', `/api/channels/${b}/unsubscribe`, { subscriberType: 'AGENT', subscriberId: 'Pom' })).status).toBe(200);
    await turn(a, ['Draft ready']);
    await tick();
    expect(await handoffs(b)).toEqual([]);
    expect(product.store.flows.link(l.id)).toMatchObject({ on: false, pausedReason: 'agent-left' });
    expect((await needs(owner)).map(i => i.short)).toEqual(['Hand-off to B paused · Pom left the chat']);
  });

  it('a paused link never delivers, and resuming does not replay', async () => {
    const l = await link(owner, { from: a, to: b, who: 'Pom' });
    const paused = await call(owner, 'PATCH', `/api/flows/links/${l.id}`, { on: false, version: 0 });
    expect(paused.status).toBe(200);
    const whilePaused = await turn(a, ['While paused']);
    await tick();
    expect(await handoffs(b)).toEqual([]);
    // Paused by a person: no reason, so no Needs you item.
    expect(await needs(owner)).toEqual([]);
    expect((await call(owner, 'PATCH', `/api/flows/links/${l.id}`, { on: true, version: 1 })).status).toBe(200);
    // The scan restarts after the newest finished turn, by engine time, not the Nest clock.
    expect(product.store.flows.scannedTo(l.id)).toBe(whilePaused.createdAt);
    await tick();
    expect(await handoffs(b)).toEqual([]);
    await turn(a, ['After resuming']);
    await tick();
    expect((await handoffs(b)).map(e => e.payload.text)).toEqual(['Hand-off from A · set up by owner\n\nAfter resuming']);
  });

  it('keeps going when one link fails', async () => {
    const c = await chat('C', [{ type: 'AGENT', id: 'Pom' }]);
    const broken = await link(owner, { from: a, to: b, who: 'Pom' });
    const fine = await link(owner, { from: a, to: c, who: 'Pom' });
    // The B chat disappears from the engine: that link pauses as unavailable, the other delivers.
    engine.db.prepare('DELETE FROM channel_subscriptions WHERE channel_id=?').run(b);
    engine.db.prepare('DELETE FROM channels WHERE id=?').run(b);
    await turn(a, ['Draft ready']);
    await tick();
    expect(product.store.flows.link(broken.id)).toMatchObject({ on: false, pausedReason: 'unavailable' });
    expect(await handoffs(c)).toHaveLength(1);
    expect(deliveries(fine.id)).toEqual([expect.objectContaining({ status: 'delivered' })]);
  });

  it('wakes on a completed turn without waiting for the next tick', async () => {
    await link(owner, { from: a, to: b, who: 'Pom' });
    await turn(a, ['Draft ready']);
    product.handoff.wake(a);
    product.handoff.wake(a);
    for (let i = 0; i < 40 && (await handoffs(b)).length === 0; i++) await new Promise(r => setTimeout(r, 50));
    expect(await handoffs(b)).toHaveLength(1);
  });

  it('Switchyard is never woken', async () => {
    const ab = await link(owner, { from: a, to: b, who: 'Pom' });
    await link(owner, { from: b, to: a });
    await turn(a, ['Draft ready']);
    await tick();
    await turn(b, ['Reviewed it'], { agent: 'Pom' });
    await tick();
    const toB = await handoffs(b), toA = await handoffs(a);
    expect(toB).toHaveLength(1);
    expect(toA).toHaveLength(1);
    // "Nobody": targeted at the service agent itself, which routing never wakes.
    expect(toA[0].payload.targetAgentName).toBe('Switchyard');
    for (const name of ['Pip', 'Pom', 'Switchyard']) expect(routes(name, toA[0])).toBe(false);
    const all = (await (await runner('GET', '/api/events?limit=10000')).json()) as EngineEvent[];
    const own = all.filter(e => e.source === 'agent:Switchyard');
    expect(own.length).toBeGreaterThanOrEqual(2);
    for (const event of own) expect(routes('Switchyard', event)).toBe(false);
    expect(all.filter(e => e.type.startsWith('agent.turn.') && e.source === 'agent:Switchyard')).toEqual([]);
    expect(await (await call(owner, 'GET', '/api/agents/Switchyard')).json()).toMatchObject({ desiredState: 'STOPPED' });
    expect(deliveries(ab.id)).toHaveLength(1);
  });
});

describe('the engine watch', () => {
  let dir: string, engine: ReturnType<typeof createEngine>, server: Server;
  beforeEach(async () => {
    vi.stubEnv('ORGOPS_MASTER_KEY', Buffer.alloc(32, 99).toString('base64'));
    dir = mkdtempSync(join(tmpdir(), 'nest-engine-watch-test-'));
    engine = createEngine({ dbPath: join(dir, 'engine.sqlite'), dataDir: dir, projectRoot: dir, adminUser: 'owner', adminPass: 'password', runnerToken: RUNNER });
    server = serve({ fetch: engine.app.fetch, hostname: '127.0.0.1', port: 0 }) as Server;
    engine.injectWebSocket(server);
    await once(server, 'listening');
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    server.closeAllConnections();
    await new Promise(r => server.close(r));
    engine.db.close(); rmSync(dir, { recursive: true, force: true });
  });

  it('calls back once per completed turn', async () => {
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const emit = (type: string, channelId: string) => engine.app.request('/api/events', {
      method: 'POST', headers: { ...json, 'x-orgops-runner-token': RUNNER },
      body: JSON.stringify({ type, source: 'agent:Pip', channelId, payload: { triggerEventId: 't', text: 'hi' } }),
    });
    const seen: string[] = [];
    const watcher = watchEngine({ baseUrl: base, token: RUNNER, onTurnCompleted: id => seen.push(id) });
    try {
      // Probe until the subscription is live.
      for (let i = 0; i < 100 && !seen.includes('probe'); i++) {
        await emit('agent.turn.completed', 'probe');
        await new Promise(r => setTimeout(r, 30));
      }
      expect(seen).toContain('probe');
      await emit('agent.turn.started', 'room');
      await emit('message.created', 'room');
      await emit('agent.turn.completed', 'room');
      for (let i = 0; i < 40 && !seen.includes('room'); i++) await new Promise(r => setTimeout(r, 25));
      await new Promise(r => setTimeout(r, 100));
      expect(seen.filter(id => id === 'room')).toEqual(['room']);
    } finally {
      watcher.close();
    }
  });
});
