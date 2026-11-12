import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp as createEngine } from '../../../../vendor/orgops/apps/api/src/app';
import { shouldHandleEventForAgent } from '../../../../vendor/orgops/apps/agent-runner/src/event-routing';
import { createOrgOpsClient, type EngineEvent } from '@nest/orgops-client';
import { createApp } from '../app';
import { createSwitchyard, SWITCHYARD_MARKER } from './identity';

const RUNNER = 'runner-secret';

describe('the Switchyard service identity against the unchanged engine', () => {
  let dir: string, engine: ReturnType<typeof createEngine>, product: ReturnType<typeof createApp>;
  let client: ReturnType<typeof createOrgOpsClient>;
  let owner: Record<string, string>, ownerId: string, clock: number;
  // Every engine request made with the service token.
  let serviceCalls: string[];
  const json = { 'content-type': 'application/json' };
  const call = (h: Record<string, string>, method: string, path: string, body?: unknown) =>
    product.app.request(path, { method, headers: h, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const runner = (path: string) => engine.app.request(path, { headers: { 'x-orgops-runner-token': RUNNER } });
  const switchyard = (...args: [token?: string]) =>
    createSwitchyard({ store: product.store, orgops: client, token: args.length ? args[0] : RUNNER, name: 'Switchyard', workspaceRoot: join(dir, 'managed'), defaultModelId: 'test', now: () => clock });

  beforeEach(async () => {
    vi.stubEnv('ORGOPS_MASTER_KEY', Buffer.alloc(32, 99).toString('base64'));
    dir = mkdtempSync(join(tmpdir(), 'nest-switchyard-test-'));
    serviceCalls = [];
    clock = Date.now();
    engine = createEngine({ dbPath: join(dir, 'engine.sqlite'), dataDir: dir, projectRoot: dir, adminUser: 'owner', adminPass: 'password', runnerToken: RUNNER });
    client = createOrgOpsClient('http://engine', (async (url, init) => {
      if (new Headers(init?.headers).get('x-orgops-runner-token')) serviceCalls.push(`${init?.method ?? 'GET'} ${new URL(String(url)).pathname}`);
      return engine.app.fetch(new Request(url, init));
    }) as typeof fetch);
    product = createApp({ orgops: client, dbPath: join(dir, 'product.sqlite'), canvasEnabled: true, contextFilesDir: join(dir, 'context-files'), connectionEngineToken: RUNNER });
    const r = await call(json, 'POST', '/api/auth/login', { username: 'owner', password: 'password' });
    owner = { ...json, cookie: r.headers.get('set-cookie')!.split(';')[0] };
    ownerId = (await (await call(owner, 'GET', '/api/humans')).json()).find((h: any) => h.username === 'owner').id;
    // A second, later human: the owner is the first by createdAt, not whoever happens to sort first.
    expect((await call(owner, 'POST', '/api/humans/invite', { username: 'aaron', tempPassword: 'password' })).status).toBeLessThan(300);
    for (const name of ['Pip', 'Pom']) {
      const res = await call(owner, 'POST', '/api/agents', { name, modelId: 'test', workspacePath: join(dir, name), desiredState: 'STOPPED' });
      expect(res.status, await res.clone().text()).toBe(201);
    }
  });
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
  const participants = async (channelId: string) =>
    ((await (await call(owner, 'GET', '/api/channels?includeArchived=1')).json()) as { id: string; participants: { subscriberType: string; subscriberId: string }[] }[])
      .find(c => c.id === channelId)!.participants;
  const messages = async (channelId: string) =>
    ((await (await call(owner, 'GET', `/api/events?channelId=${channelId}&type=message.created&limit=1000`)).json()) as EngineEvent[]).length;
  const receipt = (eventId: string, agentName: string) =>
    (engine.db.prepare('SELECT status FROM event_receipts WHERE event_id=? AND agent_name=?').get(eventId, agentName) as { status: string } | undefined)?.status;
  const runnerRead = async (agentName: string, channelId: string) => {
    const res = await runner(`/api/events?agentName=${agentName}&channelId=${channelId}`);
    expect(res.status).toBe(200);
    return (await res.json()) as EngineEvent[];
  };
  const routes = (name: string, event: EngineEvent) =>
    shouldHandleEventForAgent({ name, workspacePath: join(dir, name), modelId: 'test', desiredState: 'RUNNING', runtimeState: 'RUNNING' }, event);
  const audits = (type: string) =>
    product.store.db.prepare('SELECT actor_id AS actorId, payload_json AS payload FROM product_audit WHERE type=?').all(type) as { actorId: string; payload: string }[];

  it('creates a stopped Switchyard agent and posts a targeted message as it', async () => {
    const sy = switchyard();
    expect(await sy.ensure()).toEqual({ ok: true, name: 'Switchyard' });
    const created = await agent('Switchyard');
    expect(created).toMatchObject({ desiredState: 'STOPPED', visibility: 'PRIVATE', ownerHumanId: ownerId, mode: 'CLASSIC', description: SWITCHYARD_MARKER, emitAuditEvents: false, workspacePath: join(dir, 'managed', 'switchyard') });
    const setting = product.store.db.prepare("SELECT value_json FROM product_settings WHERE key='switchyard.agent'").get() as { value_json: string };
    expect(JSON.parse(setting.value_json)).toMatchObject({ id: created.id, name: 'Switchyard' });

    const room = await chat('Room', ['Pip', 'Pom']);
    await sy.join(room);
    await sy.join(room);
    expect((await participants(room)).filter(p => p.subscriberType === 'AGENT').map(p => p.subscriberId).sort()).toEqual(['Pip', 'Pom', 'Switchyard']);

    const posted = await sy.post({ channelId: room, text: 'Hand-off from A · set up by owner\n\nhi', target: 'Pip', kind: 'handoff', setBy: ownerId, idempotencyKey: 'nest:test:1', meta: { linkId: 'l1' } });
    expect(posted).toMatchObject({ type: 'message.created', source: 'agent:Switchyard', channelId: room, idempotencyKey: 'nest:test:1' });
    expect(posted.payload).toEqual({ text: 'Hand-off from A · set up by owner\n\nhi', targetAgentName: 'Pip', nestSwitchyard: { linkId: 'l1', kind: 'handoff', setBy: ownerId } });

    expect(receipt(posted.id, 'Pip')).toBe('PENDING');
    const pip = (await runnerRead('Pip', room)).find(e => e.id === posted.id)!;
    expect(pip).toBeDefined();
    expect(receipt(posted.id, 'Pip')).toBe('DELIVERED');
    expect(routes('Pip', pip)).toBe(true);
    expect(routes('Pom', pip)).toBe(false);
    expect(routes('Switchyard', pip)).toBe(false);
    // Not a future scheduled event: nothing to cancel.
    expect(await client.service(RUNNER).deleteEvent(posted.id)).toBe(false);

    // A fresh process adopts the agent carrying the marker instead of making another.
    expect(await switchyard().ensure()).toEqual({ ok: true, name: 'Switchyard' });
    expect((await agent('Switchyard')).id).toBe(created.id);
  });

  it('never wakes anyone for a post targeted at itself', async () => {
    const sy = switchyard();
    const room = await chat('Room', ['Pip', 'Pom']);
    await sy.join(room);
    const { fileId } = await client.service(RUNNER).upload('notes.txt', new TextEncoder().encode('context'), 'text/plain');
    const attachments = [{ fileId, name: 'notes.txt', mime: 'text/plain', size: 7 }];
    const posted = await sy.post({ channelId: room, text: 'Just context', target: null, kind: 'note', setBy: ownerId, idempotencyKey: 'nest:test:nobody', attachments });
    expect(posted.payload).toMatchObject({ targetAgentName: 'Switchyard', attachments });
    expect(await (await call(owner, 'GET', `/api/files/${fileId}`)).text()).toBe('context');
    const seen = (await runnerRead('Pip', room)).find(e => e.id === posted.id)!;
    for (const name of ['Pip', 'Pom', 'Switchyard']) expect(routes(name, seen)).toBe(false);
  });

  it('repeats a post with the same idempotency key as the same event', async () => {
    const sy = switchyard();
    const room = await chat('Room', ['Pip', 'Pom']);
    await sy.join(room);
    const before = await messages(room);
    const input = { channelId: room, text: 'Once', target: 'Pip', kind: 'handoff' as const, setBy: ownerId, idempotencyKey: 'nest:test:repeat' };
    const first = await sy.post(input);
    const second = await sy.post(input);
    expect(second.id).toBe(first.id);
    expect(await messages(room)).toBe(before + 1);
  });

  it('refuses an event under its key that it did not post, as a conflict', async () => {
    const sy = switchyard();
    const room = await chat('Room', ['Pip']);
    await sy.join(room);
    // A person can set any idempotency key through the proxy, and the engine's lookup is global.
    const forged = await call(owner, 'POST', '/api/events', { type: 'message.created', source: 'human:owner', channelId: room, idempotencyKey: 'nest:handoff:forged', payload: { text: 'Not a hand-off' } });
    expect(forged.status).toBeLessThan(300);
    await expect(sy.post({ channelId: room, text: 'Real', target: 'Pip', kind: 'handoff', setBy: ownerId, idempotencyKey: 'nest:handoff:forged' }))
      .rejects.toMatchObject({ name: 'EngineError', status: 409 });
    // Its own repeat still returns its event.
    const first = await sy.post({ channelId: room, text: 'Mine', target: 'Pip', kind: 'handoff', setBy: ownerId, idempotencyKey: 'nest:handoff:mine' });
    expect((await sy.post({ channelId: room, text: 'Mine', target: 'Pip', kind: 'handoff', setBy: ownerId, idempotencyKey: 'nest:handoff:mine' })).id).toBe(first.id);
  });

  it('joins a chat before its first post there when this agent has not, once per process (a renamed or re-created agent)', async () => {
    const sy = switchyard();
    const room = await chat('Room', ['Pip']);
    await sy.join(room);
    // Renamed: a new service agent name posts in a chat only the old one joined.
    const renamed = createSwitchyard({ store: product.store, orgops: client, token: RUNNER, name: 'Yard', workspaceRoot: join(dir, 'managed'), defaultModelId: 'test', now: () => clock });
    serviceCalls = [];
    await renamed.post({ channelId: room, text: 'First', target: 'Pip', kind: 'handoff', setBy: ownerId, idempotencyKey: 'nest:test:renamed:1' });
    expect(serviceCalls).toContain(`POST /api/channels/${room}/subscribe`);
    expect(await participants(room)).toContainEqual(expect.objectContaining({ subscriberType: 'AGENT', subscriberId: 'Yard' }));
    serviceCalls = [];
    await renamed.post({ channelId: room, text: 'Second', target: 'Pip', kind: 'handoff', setBy: ownerId, idempotencyKey: 'nest:test:renamed:2' });
    expect(serviceCalls).toEqual(['GET /api/agents/Yard', 'POST /api/events']);
    // Re-created under the same name: the new agent joins again.
    expect((await call(owner, 'DELETE', '/api/agents/Switchyard')).status).toBe(200);
    expect(await participants(room)).not.toContainEqual(expect.objectContaining({ subscriberId: 'Switchyard' }));
    clock += 61_000;
    await sy.post({ channelId: room, text: 'After re-creation', target: 'Pip', kind: 'handoff', setBy: ownerId, idempotencyKey: 'nest:test:recreated' });
    expect(await participants(room)).toContainEqual(expect.objectContaining({ subscriberType: 'AGENT', subscriberId: 'Switchyard' }));
  });

  it('drains its own receipts', async () => {
    const sy = switchyard();
    const room = await chat('Room', ['Pip', 'Pom']);
    await sy.join(room);
    const posted = await sy.post({ channelId: room, text: 'Drain me', target: 'Pip', kind: 'handoff', setBy: ownerId, idempotencyKey: 'nest:test:drain' });
    await runnerRead('Pip', room);
    await runnerRead('Pom', room);
    const service = client.service(RUNNER);
    // Only the stopped service agent's receipt still holds the event back.
    expect((await service.event(posted.id))!.status).toBe('PENDING');
    expect(receipt(posted.id, 'Switchyard')).toBe('PENDING');
    expect(await sy.drain()).toBe(1);
    expect(receipt(posted.id, 'Switchyard')).toBe('DELIVERED');
    expect((await service.event(posted.id))!.status).toBe('DELIVERED');
  });

  it('stops itself again after someone starts it, before the next post', async () => {
    const sy = switchyard();
    const room = await chat('Room', ['Pip']);
    await sy.join(room);
    expect((await call(owner, 'POST', '/api/agents/Switchyard/start')).status).toBe(200);
    expect((await agent('Switchyard')).desiredState).toBe('RUNNING');
    // Within the 60 s adoption cache: the post itself must stop the agent first.
    serviceCalls = [];
    const posted = await sy.post({ channelId: room, text: 'After a start', target: 'Pip', kind: 'handoff', setBy: ownerId, idempotencyKey: 'nest:test:started' });
    expect(serviceCalls).toEqual(['GET /api/agents/Switchyard', 'POST /api/agents/Switchyard/stop', 'POST /api/events']);
    const stop = engine.db.prepare("SELECT created_at AS at FROM events WHERE type='agent.control.stop' AND payload_json LIKE '%\"Switchyard\"%'").get() as { at: number };
    expect(stop.at).toBeLessThan(posted.createdAt);
    expect((await agent('Switchyard')).desiredState).toBe('STOPPED');
    const stopped = audits('audit.flows.service_agent.stopped');
    expect(stopped).toHaveLength(1);
    expect(stopped[0].actorId).toBe('system');
    expect(JSON.parse(stopped[0].payload)).toMatchObject({ agentName: 'Switchyard', desiredState: 'RUNNING' });
    // A stopped agent costs one read per post and is not stopped again.
    serviceCalls = [];
    await sy.post({ channelId: room, text: 'Again', target: 'Pip', kind: 'handoff', setBy: ownerId, idempotencyKey: 'nest:test:again' });
    expect(serviceCalls).toEqual(['GET /api/agents/Switchyard', 'POST /api/events']);
  });

  it('stops a started agent before it joins or drains', async () => {
    const sy = switchyard();
    expect((await sy.ensure()).ok).toBe(true);
    const room = await chat('Room', ['Pip']);
    expect((await call(owner, 'POST', '/api/agents/Switchyard/start')).status).toBe(200);
    serviceCalls = [];
    await sy.join(room);
    expect(serviceCalls).toEqual(['GET /api/agents/Switchyard', 'POST /api/agents/Switchyard/stop', `POST /api/channels/${room}/subscribe`]);
    expect((await call(owner, 'POST', '/api/agents/Switchyard/start')).status).toBe(200);
    serviceCalls = [];
    expect(await sy.drain()).toBe(0);
    expect(serviceCalls).toEqual(['GET /api/agents/Switchyard', 'POST /api/agents/Switchyard/stop', 'GET /api/events']);
    expect((await agent('Switchyard')).desiredState).toBe('STOPPED');
    expect(audits('audit.flows.service_agent.stopped')).toHaveLength(2);
  });

  it('decides again when the agent is replaced within the cache window', async () => {
    const sy = switchyard();
    expect((await sy.ensure()).ok).toBe(true);
    expect((await call(owner, 'DELETE', '/api/agents/Switchyard')).status).toBe(200);
    expect((await call(owner, 'POST', '/api/agents', { name: 'Switchyard', modelId: 'test', workspacePath: join(dir, 'other'), description: 'Routes my trains', visibility: 'PRIVATE', mode: 'CLASSIC', desiredState: 'STOPPED' })).status).toBe(201);
    const room = await chat('Room', ['Pip', 'Switchyard']);
    const message = (await (await call(owner, 'POST', '/api/events', { type: 'message.created', source: 'human:owner', channelId: room, payload: { text: 'for the real Switchyard' } })).json()) as EngineEvent;
    await expect(sy.post({ channelId: room, text: 'x', target: 'Pip', kind: 'handoff', setBy: ownerId, idempotencyKey: 'nest:test:replaced' })).rejects.toMatchObject({ reason: 'name-taken' });
    expect(await sy.drain()).toBe(0);
    expect(receipt(message.id, 'Switchyard')).toBe('PENDING');
    expect(await sy.ensure()).toEqual({ ok: false, reason: 'name-taken' });
  });

  it('reports a refused token as an error, not as engine-unavailable', async () => {
    // A scoped runner token (a common misconfiguration) may read humans but not create this agent: 403.
    const invite = await (await call(owner, 'POST', '/api/runners/invites', {})).json();
    const scoped = decodeURIComponent(String(invite.invite.inviteUrl).split('/').pop()!);
    for (const [token, status] of [[scoped, 403], ['not-the-runner-token', 401]] as const) {
      const lines: string[] = [];
      const sy = createSwitchyard({ store: product.store, orgops: client, token, name: 'Switchyard', workspaceRoot: join(dir, 'managed'), defaultModelId: 'test', now: () => clock, log: line => lines.push(line) });
      await expect(sy.ensure()).rejects.toMatchObject({ name: 'EngineError', status });
      await expect(sy.post({ channelId: 'c', text: 'x', target: null, kind: 'note', setBy: ownerId, idempotencyKey: 'nest:test:refused' })).rejects.toMatchObject({ status });
      // One line per change of problem, holding the status but never the token.
      expect(lines).toEqual([`[switchyard] service agent Switchyard unavailable: engine status ${status}`]);
      expect(lines.join()).not.toContain(token);
    }
    expect((await call(owner, 'GET', '/api/agents/Switchyard')).status).toBe(404);
  });

  it('reports engine-unavailable only for an unreachable engine', async () => {
    const lines: string[] = [];
    const down = createOrgOpsClient('http://engine', (async () => { throw new TypeError('fetch failed'); }) as typeof fetch);
    const sy = createSwitchyard({ store: product.store, orgops: down, token: RUNNER, name: 'Switchyard', workspaceRoot: join(dir, 'managed'), defaultModelId: 'test', now: () => clock, log: line => lines.push(line) });
    expect(await sy.ensure()).toEqual({ ok: false, reason: 'engine-unavailable' });
    expect(await sy.ensure()).toEqual({ ok: false, reason: 'engine-unavailable' });
    expect(lines).toEqual(['[switchyard] service agent Switchyard unavailable: EngineUnreachableError']);
  });

  it('refuses a same-name agent it did not create', async () => {
    // Everything matches what Nest would make except the description marker.
    const res = await call(owner, 'POST', '/api/agents', { name: 'Switchyard', modelId: 'test', workspacePath: join(dir, 'other'), description: 'Routes my trains', visibility: 'PRIVATE', mode: 'CLASSIC', desiredState: 'STOPPED' });
    expect(res.status).toBe(201);
    expect(await agent('Switchyard')).toMatchObject({ ownerHumanId: ownerId, visibility: 'PRIVATE', mode: 'CLASSIC' });
    const room = await chat('Room', ['Pip']);
    const theirs = await chat('Theirs', ['Switchyard']);
    const message = (await (await call(owner, 'POST', '/api/events', { type: 'message.created', source: 'human:owner', channelId: theirs, payload: { text: 'for the real Switchyard' } })).json()) as EngineEvent;
    const sy = switchyard();
    expect(await sy.ensure()).toEqual({ ok: false, reason: 'name-taken' });
    await expect(sy.join(room)).rejects.toThrow();
    await expect(sy.post({ channelId: room, text: 'x', target: 'Pip', kind: 'handoff', setBy: ownerId, idempotencyKey: 'nest:test:taken' })).rejects.toThrow();
    // Draining would steal the other agent's receipts.
    expect(await sy.drain()).toBe(0);
    expect(receipt(message.id, 'Switchyard')).toBe('PENDING');
    expect((await participants(room)).some(p => p.subscriberId === 'Switchyard')).toBe(false);
    expect(serviceCalls.filter(c => c.startsWith('POST'))).toEqual([]);
    expect(product.store.db.prepare("SELECT 1 FROM product_settings WHERE key='switchyard.agent'").get()).toBeUndefined();
    // Not adopted, and its description is kept.
    expect((await agent('Switchyard')).description).toBe('Routes my trains');
  });

  it('reports no-service-token without a token', async () => {
    for (const token of [undefined, '']) {
      const sy = switchyard(token);
      expect(await sy.ensure()).toEqual({ ok: false, reason: 'no-service-token' });
      expect(await sy.drain()).toBe(0);
    }
    expect(serviceCalls).toEqual([]);
    expect((await call(owner, 'GET', '/api/agents/Switchyard')).status).toBe(404);
  });
});
