import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp as createEngine } from '../../../../vendor/orgops/apps/api/src/app';
import { createOrgOpsClient, type EngineEvent } from '@nest/orgops-client';
import { createApp } from '../app';
import type { Summarize } from './summarize';

const RUNNER = 'runner-secret';
type H = Record<string, string>;
type Seed = EngineEvent & { payload: { text: string; targetAgentName: string; nestSwitchyard: Record<string, string> } };

describe('forks against the unchanged engine', () => {
  let dir: string, engine: ReturnType<typeof createEngine>, product: ReturnType<typeof createApp>;
  let owner: H, mate: H, reader: H, ownerId: string;
  let a: string, b: string;
  let summaries: Parameters<Summarize>[0][];
  // Runs inside the fork request, between Switchyard joining and posting the seed.
  let duringSummary: (() => Promise<void>) | null;
  const json = { 'content-type': 'application/json' };
  const call = (h: H, method: string, path: string, body?: unknown) =>
    product.app.request(path, { method, headers: h, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const engineCall = (method: string, path: string, body?: unknown) =>
    engine.app.request(path, { method, headers: { ...json, 'x-orgops-runner-token': RUNNER }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const login = async (username: string) => {
    const r = await call(json, 'POST', '/api/auth/login', { username, password: 'password' });
    return { ...json, cookie: r.headers.get('set-cookie')!.split(';')[0] };
  };
  const invite = async (username: string) => {
    expect((await call(owner, 'POST', '/api/humans/invite', { username, tempPassword: 'password' })).status).toBeLessThan(300);
    engine.db.prepare('UPDATE humans SET must_change_password=0 WHERE username=?').run(username);
    return login(username);
  };
  const chat = async (name: string, members: { type: 'HUMAN' | 'AGENT'; id: string }[]) => {
    const id = (await (await call(owner, 'POST', '/api/channels', { name, visibility: 'PRIVATE' })).json()).id as string;
    for (const m of members) expect((await call(owner, 'POST', `/api/channels/${id}/subscribe`, { subscriberType: m.type, subscriberId: m.id })).status).toBe(200);
    return id;
  };
  /** A project chat started by `h`, holding the given agents. */
  const project = async (h: H, name: string, agents: string[] = []) => {
    const res = await call(h, 'POST', '/api/projects', { id: randomUUID(), name, members: agents.map(subscriberId => ({ subscriberType: 'AGENT', subscriberId })), collaboration: 'team' });
    expect(res.status, await res.clone().text()).toBe(201);
    return (await res.json()).channelId as string;
  };
  const say = async (channelId: string, source: string, text: string) => {
    const res = await engineCall('POST', '/api/events', { type: 'message.created', source, channelId, payload: { text } });
    expect(res.status, await res.clone().text()).toBeLessThan(300);
    return (await res.json()) as EngineEvent;
  };
  const seeds = async (channelId: string) =>
    ((await (await engineCall('GET', `/api/events?channelId=${channelId}&type=message.created&limit=200`)).json()) as Seed[])
      .filter(e => e.source === 'agent:Switchyard');
  const fork = (h: H, body: Record<string, unknown>) => call(h, 'POST', '/api/flows/forks', body);

  beforeEach(async () => {
    vi.stubEnv('ORGOPS_MASTER_KEY', Buffer.alloc(32, 99).toString('base64'));
    dir = mkdtempSync(join(tmpdir(), 'nest-forks-test-'));
    engine = createEngine({ dbPath: join(dir, 'engine.sqlite'), dataDir: dir, projectRoot: dir, adminUser: 'owner', adminPass: 'password', runnerToken: RUNNER });
    const client = createOrgOpsClient('http://engine', (async (url, init) => engine.app.fetch(new Request(url, init))) as typeof fetch);
    summaries = []; duringSummary = null;
    product = createApp({
      orgops: client, dbPath: join(dir, 'product.sqlite'), canvasEnabled: true, contextFilesDir: join(dir, 'context-files'),
      connectionEngineToken: RUNNER, switchyardName: 'Switchyard', switchyardCreator: 'NestSystem', switchyardWorkspaceRoot: join(dir, 'managed'),
      summarize: async input => { summaries.push(input); await duringSummary?.(); return { text: `Summary (by test):\n${input.texts.length} messages`, model: 'test' }; },
    });
    owner = await login('owner');
    ownerId = (await (await call(owner, 'GET', '/api/humans')).json()).find((h: any) => h.username === 'owner').id;
    mate = await invite('mate');
    reader = await invite('reader');
    for (const name of ['Pip', 'Pom']) {
      const res = await call(owner, 'POST', '/api/agents', { name, modelId: 'test', workspacePath: join(dir, name), desiredState: 'STOPPED', visibility: 'PUBLIC' });
      expect(res.status, await res.clone().text()).toBe(201);
    }
    // Nest's SYSTEM-role management agent: the engine takes Switchyard's owner and visibility only from one.
    expect((await call(owner, 'POST', '/api/agents', { name: 'NestSystem', agentRole: 'SYSTEM', modelId: 'test', workspacePath: join(dir, 'NestSystem'), desiredState: 'STOPPED' })).status).toBe(201);
    // A: the owner's chat with Pip, which the reader can read and the mate cannot. B: another chat of the owner's.
    a = await chat('A', [{ type: 'AGENT', id: 'Pip' }, { type: 'HUMAN', id: 'reader' }]);
    b = await chat('B', [{ type: 'AGENT', id: 'Pom' }]);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    product.store.close(); engine.db.close(); rmSync(dir, { recursive: true, force: true });
  });

  it('seeds the fork with a summary up to the message and the quote, targeted at its author, and links findings back', async () => {
    await say(a, 'human:owner', 'Which pricing should we try?');
    const message = await say(a, 'agent:Pip', 'Agreed on more data. I will go deep on competitors.');
    await say(a, 'human:owner', 'A later message the fork never sees');
    const child = await project(owner, 'Fork: Agreed on more data', ['Pip']);

    const res = await fork(owner, { childChannelId: child, parentChannelId: a, parentEventId: message.id, timeZone: 'UTC' });
    expect(res.status, await res.clone().text()).toBe(201);
    const created = await res.json();
    expect(created).toEqual({ childChannelId: child, linkId: expect.any(String) });

    // One Switchyard message in the child, for Pip, naming the parent, the author, the time and who set it up.
    const [seed, ...rest] = await seeds(child);
    expect(rest).toEqual([]);
    const at = new Date(message.createdAt).toISOString().slice(11, 16);
    expect(seed.payload.text).toBe(`Forked from "A" · Pip, ${at} · set up by owner\n\nSummary (by test):\n2 messages\n\n> Agreed on more data. I will go deep on competitors.`);
    expect(seed.payload.targetAgentName).toBe('Pip');
    expect(seed.payload.nestSwitchyard).toMatchObject({ kind: 'fork-seed', setBy: ownerId, parentChannelId: a, parentEventId: message.id });
    // The summary covered the messages up to the forked one, attributed to the person forking.
    expect(summaries).toEqual([{ texts: ['owner: Which pricing should we try?', 'Pip: Agreed on more data. I will go deep on competitors.'], purpose: 'fork', actor: ownerId, ref: { forkId: child } }]);

    // Findings flow back: a fork link child → parent, and the fork is recorded.
    expect(product.store.flows.linksTouching([child])).toEqual([expect.objectContaining({
      id: created.linkId, kind: 'fork', from: child, to: a, what: 'results', when: 'done', who: null, label: 'fork · findings flow back', on: true, createdBy: ownerId,
    })]);
    expect(product.store.flows.forkOf([child])).toEqual([expect.objectContaining({ childChannelId: child, parentChannelId: a, parentEventId: message.id, linkId: created.linkId, createdBy: ownerId })]);
    // Switchyard joined both chats (it posts the seed and, later, the findings).
    const channels = (await (await call(owner, 'GET', '/api/channels?includeArchived=1')).json()) as { id: string; participants: { subscriberType: string; subscriberId: string }[] }[];
    for (const id of [a, child]) expect(channels.find(c => c.id === id)!.participants).toContainEqual({ subscriberType: 'AGENT', subscriberId: 'Switchyard' });

    // A repeat answers 200 with the same fork and posts no second seed; another message for the same child is a conflict.
    const again = await fork(owner, { childChannelId: child, parentChannelId: a, parentEventId: message.id });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual(created);
    expect(await seeds(child)).toHaveLength(1);
    const other = await say(a, 'agent:Pip', 'Another idea');
    expect((await fork(owner, { childChannelId: child, parentChannelId: a, parentEventId: other.id })).status).toBe(409);
    expect(summaries).toHaveLength(1);

    // The parent lists its forks: the owner sees the title, the reader (who cannot read the fork) a private chat.
    const listed = await call(owner, 'GET', `/api/flows/forks?parentChannelId=${a}`);
    expect(await listed.json()).toEqual({ forks: [{ childChannelId: child, parentEventId: message.id, title: 'Fork: Agreed on more data' }] });
    expect(await (await call(reader, 'GET', `/api/flows/forks?parentChannelId=${a}`)).json())
      .toEqual({ forks: [{ childChannelId: child, parentEventId: message.id, title: 'a private chat' }] });
    expect((await call(mate, 'GET', `/api/flows/forks?parentChannelId=${a}`)).status).toBe(404);
  });

  it('removes its findings link when a concurrent fork of the same chat from another message won (409)', async () => {
    const message = await say(a, 'agent:Pip', 'Agreed on more data.');
    const elsewhere = await say(b, 'agent:Pom', 'Something in B');
    const child = await project(owner, 'Fork: Agreed', ['Pip']);
    // The other request records its fork (child → B) while this one is summarising.
    duringSummary = async () => {
      const other = product.store.flows.createLink({ id: randomUUID(), kind: 'fork', from: child, to: b, label: 'fork · findings flow back', createdBy: ownerId, now: Date.now(), scannedTo: 0 });
      product.store.flows.recordFork({ childChannelId: child, parentChannelId: b, parentEventId: elsewhere.id, linkId: other.id, createdBy: ownerId });
    };
    const res = await fork(owner, { childChannelId: child, parentChannelId: a, parentEventId: message.id });
    expect(res.status).toBe(409);
    expect(product.store.flows.linksTouching([child]).map(l => [l.from, l.to])).toEqual([[child, b]]);
    expect(product.store.flows.forkOf([child])).toEqual([expect.objectContaining({ parentChannelId: b })]);
  });

  it('answers 503, not 502, when the service agent becomes unusable during a fork', async () => {
    const message = await say(a, 'agent:Pip', 'Agreed on more data.');
    const child = await project(owner, 'Fork: Agreed', ['Pip']);
    // After Switchyard joined, someone replaces it with an agent Nest did not make.
    duringSummary = async () => {
      expect((await call(owner, 'DELETE', '/api/agents/Switchyard')).status).toBe(200);
      expect((await call(owner, 'POST', '/api/agents', { name: 'Switchyard', modelId: 'test', workspacePath: join(dir, 'other'), description: 'Routes my trains', desiredState: 'STOPPED' })).status).toBe(201);
    };
    const res = await fork(owner, { childChannelId: child, parentChannelId: a, parentEventId: message.id });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Hand-offs are not set up on this server' });
    expect(product.store.flows.forkOf([child])).toEqual([]);
    expect(await seeds(child)).toEqual([]);
  });

  it('targets nobody when the author is not an agent in the fork, and uses the viewer\'s time zone', async () => {
    const message = await say(a, 'human:owner', 'Draft the survey: eight questions');
    const child = await project(owner, 'Fork: Draft the survey');
    const res = await fork(owner, { childChannelId: child, parentChannelId: a, parentEventId: message.id, timeZone: 'Asia/Kolkata' });
    expect(res.status, await res.clone().text()).toBe(201);
    const [seed] = await seeds(child);
    const at = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'Asia/Kolkata' }).format(message.createdAt);
    expect(seed.payload.text.startsWith(`Forked from "A" · owner, ${at} · set up by owner\n\n`)).toBe(true);
    expect(seed.payload.text.endsWith('\n\n> Draft the survey: eight questions')).toBe(true);
    // "Nobody, just context": the post targets the stopped service agent itself.
    expect(seed.payload.targetAgentName).toBe('Switchyard');
    expect((await fork(owner, { childChannelId: randomUUID(), parentChannelId: a, parentEventId: message.id, timeZone: 'Not/AZone' })).status).toBe(400);
  });

  it('refuses a viewer who cannot read the parent, a message from another chat and a child the viewer did not start', async () => {
    const message = await say(a, 'agent:Pip', 'Agreed on more data.');
    // The mate cannot read A, even into a chat of their own.
    const mates = await project(mate, 'Fork: Agreed');
    const refused = await fork(mate, { childChannelId: mates, parentChannelId: a, parentEventId: message.id });
    expect(refused.status).toBe(403);
    // A message from B, claimed to be in A.
    const child = await project(owner, 'Fork: Agreed', ['Pip']);
    const elsewhere = await say(b, 'agent:Pom', 'Something in B');
    expect((await fork(owner, { childChannelId: child, parentChannelId: a, parentEventId: elsewhere.id })).status).toBe(404);
    expect((await fork(owner, { childChannelId: child, parentChannelId: a, parentEventId: 'no-such-event' })).status).toBe(404);
    // A turn event is not a message.
    const turn = await engineCall('POST', '/api/events', { type: 'agent.turn.completed', source: 'agent:Pip', channelId: a, payload: { triggerEventId: message.id } });
    expect((await fork(owner, { childChannelId: child, parentChannelId: a, parentEventId: ((await turn.json()) as EngineEvent).id })).status).toBe(404);
    // The mate's project, and a plain chat that is not a project.
    expect((await fork(owner, { childChannelId: mates, parentChannelId: a, parentEventId: message.id })).status).toBe(403);
    expect((await fork(owner, { childChannelId: b, parentChannelId: a, parentEventId: message.id })).status).toBe(403);
    expect((await fork(owner, { childChannelId: a, parentChannelId: a, parentEventId: message.id })).status).toBe(400);
    expect(product.store.flows.forksOf(a)).toEqual([]);
    expect(product.store.flows.linksTouching([a])).toEqual([]);
    for (const id of [mates, child, b]) expect(await seeds(id)).toEqual([]);
  });
});
