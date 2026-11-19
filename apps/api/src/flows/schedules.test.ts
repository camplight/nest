import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp as createEngine } from '../../../../vendor/orgops/apps/api/src/app';
import { shouldHandleEventForAgent } from '../../../../vendor/orgops/apps/agent-runner/src/event-routing';
import { createOrgOpsClient, type EngineEvent } from '@nest/orgops-client';
import type { AgentMadeSchedule, FlowNeed, ScheduleRun, ScheduleView } from '@nest/schemas';
import { createApp } from '../app';
import { schedulePausedWhy } from './scheduler';

const RUNNER = 'runner-secret';
type H = Record<string, string>;
const json = { 'content-type': 'application/json' };
const MIN = 60_000;
const WEEK = 7 * 24 * 60 * MIN;
// Monday 2026-11-16. Schedules here run in UTC, so wall times are UTC times.
const MON_0800 = Date.UTC(2026, 10, 16, 8);
const MON_0900 = Date.UTC(2026, 10, 16, 9);
const WEEKLY = { kind: 'weekly', days: [0], time: '09:00' } as const;

/**
 * Schedules against the unchanged engine. Time is faked for Date only (S7), so the engine's createdAt and deliverAt
 * checks and Nest's injected clock (`flowsNow`) read the same time; timers stay real.
 */
describe('schedules against the unchanged engine', () => {
  let dir: string, engine: ReturnType<typeof createEngine>, product: ReturnType<typeof createApp>;
  let client: ReturnType<typeof createOrgOpsClient>;
  let owner: H, mate: H, ownerId: string, a: string, c: string;
  // Transport faults: every request fails; every service POST /api/events fails; or the next one's answer is lost.
  let outage: boolean, failPosts: boolean, dropNextPost: boolean;
  // Holds the next service POST of a scheduled trigger until its gate opens; `held` is called when it arrives.
  let hold: { held: () => void; gate: Promise<void> } | null;
  const logs: string[] = [];

  const call = (h: H, method: string, path: string, body?: unknown) =>
    product.app.request(path, { method, headers: h, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const runner = (method: string, path: string, body?: unknown) =>
    engine.app.request(path, { method, headers: { ...json, 'x-orgops-runner-token': RUNNER }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const login = async (username: string) => {
    const r = await call(json, 'POST', '/api/auth/login', { username, password: 'password' });
    return { ...json, cookie: r.headers.get('set-cookie')!.split(';')[0] };
  };
  const chat = async (name: string, members: { type: 'HUMAN' | 'AGENT' | 'TEAM'; id: string }[]) => {
    const id = (await (await call(owner, 'POST', '/api/channels', { name, visibility: 'PRIVATE' })).json()).id as string;
    for (const m of members) expect((await call(owner, 'POST', `/api/channels/${id}/subscribe`, { subscriberType: m.type, subscriberId: m.id })).status).toBe(200);
    return id;
  };
  const emit = async (type: string, source: string, channelId: string, payload: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
    const res = await runner('POST', '/api/events', { type, source, channelId, payload, ...extra });
    expect(res.status, await res.clone().text()).toBe(201);
    return (await res.json()) as EngineEvent;
  };
  const turnStarted = (channelId: string, agent = 'Pip') => emit('agent.turn.started', `agent:${agent}`, channelId, { triggerEventId: randomUUID(), eventCount: 1 });
  /** Every scheduled trigger in a chat (the runner token lists future events too), oldest first. */
  const triggers = async (channelId: string) =>
    ((await (await runner('GET', `/api/events?channelId=${channelId}&type=agent.scheduled.trigger&order=asc&limit=200`)).json()) as EngineEvent[]);
  const notes = async (channelId: string) =>
    ((await (await runner('GET', `/api/events?channelId=${channelId}&type=message.created&source=agent:Switchyard&order=asc&limit=200`)).json()) as EngineEvent[]);
  const create = async (h: H, body: Record<string, unknown>, status = 201) => {
    const res = await call(h, 'POST', '/api/flows/schedules', { id: randomUUID(), channelId: a, agent: 'Pip', prompt: 'Recap the week', rule: WEEKLY, timezone: 'UTC', ...body });
    expect(res.status, await res.clone().text()).toBe(status);
    return (await res.json()) as ScheduleView;
  };
  const list = async (h: H) => {
    const res = await call(h, 'GET', '/api/flows/schedules');
    expect(res.status).toBe(200);
    return (await res.json()) as { schedules: ScheduleView[]; agentMade: AgentMadeSchedule[] };
  };
  const needs = async (h: H) => {
    const res = await call(h, 'GET', '/api/flows/needs');
    expect(res.status).toBe(200);
    return ((await res.json()) as { items: FlowNeed[] }).items;
  };
  const runs = (scheduleId: string): ScheduleRun[] =>
    (product.store.db.prepare('SELECT id FROM product_schedule_runs WHERE schedule_id=? ORDER BY due_at, kind').all(scheduleId) as { id: string }[])
      .map(r => product.store.schedules.run(r.id)!);
  const at = (ms: number) => vi.setSystemTime(ms);
  /** Holds the next trigger post: resolves once it is held, with the function that lets it through. */
  const holdNextTrigger = () => {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    return new Promise<() => void>(resolve => { hold = { held: () => resolve(release), gate }; });
  };
  const status = async (eventId: string) => (await runner('GET', `/api/events/${eventId}`)).status;
  const unsubscribe = (type: 'HUMAN' | 'AGENT', id: string) => call(owner, 'POST', `/api/channels/${a}/unsubscribe`, { subscriberType: type, subscriberId: id });
  const tick = () => product.flows.tick();

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at(MON_0800);
    vi.stubEnv('ORGOPS_MASTER_KEY', Buffer.alloc(32, 99).toString('base64'));
    dir = mkdtempSync(join(tmpdir(), 'nest-schedules-test-'));
    outage = false; failPosts = false; dropNextPost = false; hold = null; logs.length = 0;
    engine = createEngine({ dbPath: join(dir, 'engine.sqlite'), dataDir: dir, projectRoot: dir, adminUser: 'owner', adminPass: 'password', runnerToken: RUNNER });
    client = createOrgOpsClient('http://engine', (async (url, init) => {
      if (outage) throw new TypeError('fetch failed');
      const target = new URL(String(url));
      const servicePost = init?.method === 'POST' && target.pathname === '/api/events' && new Headers(init?.headers).get('x-orgops-runner-token');
      if (failPosts && servicePost) throw new TypeError('fetch failed');
      if (hold && servicePost && String(init?.body ?? '').includes('"agent.scheduled.trigger"')) {
        const current = hold;
        hold = null;
        current.held();
        await current.gate;
      }
      const response = await engine.app.fetch(new Request(url, init));
      if (dropNextPost && servicePost) {
        // The engine stored the event; Nest never learns its id.
        dropNextPost = false;
        throw new TypeError('fetch failed');
      }
      return response;
    }) as typeof fetch);
    product = createApp({
      orgops: client, dbPath: join(dir, 'product.sqlite'), canvasEnabled: true, contextFilesDir: join(dir, 'context-files'),
      connectionEngineToken: RUNNER, switchyardName: 'Switchyard', switchyardCreator: 'NestSystem', switchyardWorkspaceRoot: join(dir, 'managed'),
      summarize: async () => ({ text: 'unused', model: null }), flowsNow: () => Date.now(),
    });
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
    // A: Pip's chat, with mate as a member. C: Pom's chat, the owner's alone.
    a = await chat('A', [{ type: 'AGENT', id: 'Pip' }, { type: 'HUMAN', id: 'mate' }]);
    c = await chat('C', [{ type: 'AGENT', id: 'Pom' }]);
    vi.spyOn(console, 'warn').mockImplementation(line => { logs.push(String(line)); });
    vi.spyOn(console, 'error').mockImplementation(line => { logs.push(String(line)); });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.useRealTimers();
    product.store.close(); engine.db.close(); rmSync(dir, { recursive: true, force: true });
  });

  it('books the first run as an engine trigger from Switchyard, and posts a note', async () => {
    const s = await create(owner, {});
    expect(s).toMatchObject({ channelId: a, agent: 'Pip', on: true, nextAt: MON_0900, createdBy: ownerId, chatTitle: 'A', canEdit: true, canManage: true, lastRun: null });
    expect(s).not.toHaveProperty('nextEventId');
    const [trigger, ...rest] = await triggers(a);
    expect(rest).toEqual([]);
    expect(trigger).toMatchObject({ source: 'agent:Switchyard', deliverAt: MON_0900, status: 'PENDING', idempotencyKey: `nest:schedule:${s.id}:${MON_0900}` });
    expect(trigger.payload).toEqual({
      text: 'Scheduled run · Every Monday at 09:00 · set up by owner\n\nRecap the week', targetAgentName: 'Pip',
      nestSwitchyard: { kind: 'run', setBy: ownerId, scheduleId: s.id },
    });
    // The engine wakes only Pip, and only once it is due.
    const routes = (name: string) => shouldHandleEventForAgent({ name, workspacePath: join(dir, name), modelId: 'test', desiredState: 'RUNNING', runtimeState: 'RUNNING' }, trigger);
    expect([routes('Pip'), routes('Pom')]).toEqual([true, false]);
    const [note] = await notes(a);
    expect(note.payload).toMatchObject({ text: 'Scheduled · Every Monday at 09:00 · Pip', targetAgentName: 'Switchyard', nestSwitchyard: { kind: 'note', setBy: ownerId, scheduleId: s.id } });
    expect(note.idempotencyKey).toBe(`nest:note:schedule:${s.id}`);
    expect(runs(s.id)).toEqual([expect.objectContaining({ kind: 'scheduled', status: 'booked', dueAt: MON_0900, eventId: trigger.id })]);
    expect((await list(owner)).schedules).toEqual([expect.objectContaining({ id: s.id, nextAt: MON_0900, chatTitle: 'A', canEdit: true, canManage: true })]);
    expect((await list(mate)).schedules).toEqual([expect.objectContaining({ id: s.id, canEdit: false, canManage: true })]);

    // A retry of the same request answers 200 and books nothing more.
    const again = await call(owner, 'POST', '/api/flows/schedules', { id: s.id, channelId: a, agent: 'Pip', prompt: 'Recap the week', rule: WEEKLY, timezone: 'UTC' });
    expect(again.status).toBe(200);
    expect(await triggers(a)).toHaveLength(1);
    expect(await notes(a)).toHaveLength(1);
    // The prompt and the trigger text never reach the log.
    expect(logs.join('\n')).not.toContain('Recap the week');
  });

  it('books once across ticks, and reuses the event after a crash between post and save', async () => {
    const s = await create(owner, {});
    await tick(); await tick();
    expect(await triggers(a)).toHaveLength(1);
    expect(runs(s.id)).toHaveLength(1);

    // The engine stores the trigger but Nest never learns its id.
    dropNextPost = true;
    const lost = await create(owner, { prompt: 'Second', rule: { kind: 'daily', time: '10:00' } });
    expect(product.store.schedules.schedule(lost.id)?.nextEventId).toBeNull();
    await tick();
    const booked = (await triggers(a)).filter(t => (t.payload.nestSwitchyard as { scheduleId?: string }).scheduleId === lost.id);
    expect(booked).toHaveLength(1);
    expect(product.store.schedules.schedule(lost.id)?.nextEventId).toBe(booked[0].id);
    expect(runs(lost.id)).toEqual([expect.objectContaining({ status: 'booked', eventId: booked[0].id, dueAt: Date.UTC(2026, 10, 16, 10) })]);
  });

  it('shares the hand-off lease: a second API process books nothing while the first holds it', async () => {
    await tick();
    failPosts = true;
    const s = await create(owner, {});
    failPosts = false;
    const other = createApp({
      orgops: client, dbPath: join(dir, 'product.sqlite'), canvasEnabled: true, contextFilesDir: join(dir, 'context-files'),
      connectionEngineToken: RUNNER, switchyardName: 'Switchyard', switchyardCreator: 'NestSystem', switchyardWorkspaceRoot: join(dir, 'managed'),
      summarize: async () => ({ text: 'unused', model: null }), flowsNow: () => Date.now(),
    });
    try {
      await other.flows.tick();
      expect(await triggers(a)).toEqual([]);
      // The first process's hand-off tick renewed the lease; its scheduler, the same holder, books.
      await tick();
      expect((await triggers(a)).map(t => t.deliverAt)).toEqual([MON_0900]);
      expect(product.store.schedules.schedule(s.id)?.nextEventId).toBeTruthy();
    } finally { other.store.close(); }
  });

  it("never cancels an edit's booking when the edit lands while a tick is booking (I1)", async () => {
    failPosts = true;
    const s = await create(owner, {});
    failPosts = false;
    const held = holdNextTrigger();
    const ticking = tick();
    const release = await held;
    // The tick read version 0 and its post is in flight. Another process's edit lands meanwhile (same time, new
    // prompt) and its booking is already in the engine under the same key.
    product.store.schedules.patchSchedule(s.id, { prompt: 'Recap the month' }, 0, ownerId, MON_0900);
    const edit = await emit('agent.scheduled.trigger', 'agent:Switchyard', a, {
      text: 'Scheduled run · Every Monday at 09:00 · set up by owner\n\nRecap the month', targetAgentName: 'Pip',
      nestSwitchyard: { kind: 'run', setBy: ownerId, scheduleId: s.id },
    }, { deliverAt: MON_0900, idempotencyKey: `nest:schedule:${s.id}:${MON_0900}` });
    release();
    await ticking;
    expect(await status(edit.id)).toBe(200);
    await tick();
    expect((await triggers(a)).map(t => t.id)).toEqual([edit.id]);
    expect(product.store.schedules.schedule(s.id)?.nextEventId).toBe(edit.id);
  });

  it('books the edited text when a PATCH lands while a tick is booking the old one', async () => {
    failPosts = true;
    const s = await create(owner, {});
    failPosts = false;
    const held = holdNextTrigger();
    const ticking = tick();
    const release = await held;
    const patching = call(owner, 'PATCH', `/api/flows/schedules/${s.id}`, { prompt: 'Recap the month', version: 0 });
    for (let i = 0; i < 100 && product.store.schedules.schedule(s.id)!.version === 0; i++) await new Promise(r => setTimeout(r, 5));
    release();
    await ticking;
    expect((await patching).status).toBe(200);
    const [trigger, ...rest] = await triggers(a);
    expect(rest).toEqual([]);
    expect(trigger.payload.text).toBe('Scheduled run · Every Monday at 09:00 · set up by owner\n\nRecap the month');
    expect(product.store.schedules.schedule(s.id)?.nextEventId).toBe(trigger.id);
  });

  it('cancels and pauses a booked run when its creator lost access, on the tick within 60 s of its time (I2, I3)', async () => {
    const s = await create(mate, {});
    const booked = product.store.schedules.schedule(s.id)!.nextEventId!;
    expect((await unsubscribe('HUMAN', 'mate')).status).toBe(200);
    // Not re-checked on every tick: five minutes before, the booking stands.
    at(MON_0900 - 5 * MIN);
    await tick();
    expect(await status(booked)).toBe(200);
    at(MON_0900 - 30_000);
    await tick();
    expect(await status(booked)).toBe(404);
    expect(product.store.schedules.schedule(s.id)).toMatchObject({ on: false, pausedReason: 'access', nextEventId: null });
    expect(runs(s.id)).toEqual([]);
    const items = (await needs(mate)).filter(n => n.kind === 'paused');
    // Mate can no longer see chat A, so the server names it: the client lists the item instead of dropping it.
    expect(items).toEqual([expect.objectContaining({
      key: `schedule-paused:${s.id}`, channelId: a, short: "Schedule paused · you can't post here any more",
      gate: { kind: 'schedule-paused', scheduleId: s.id }, chatTitle: 'a chat you can no longer open',
    })]);
    expect((await needs(owner)).filter(n => n.kind === 'paused')).toEqual([]);
    // Back in the chat, the creator resumes; the item clears and the run is booked again.
    expect((await call(owner, 'POST', `/api/channels/${a}/subscribe`, { subscriberType: 'HUMAN', subscriberId: 'mate' })).status).toBe(200);
    const resumed = await call(mate, 'PATCH', `/api/flows/schedules/${s.id}`, { on: true, version: 1 });
    expect(resumed.status, await resumed.clone().text()).toBe(200);
    expect((await needs(mate)).filter(n => n.kind === 'paused')).toEqual([]);
    expect((await triggers(a)).map(t => t.deliverAt)).toEqual([MON_0900]);
  });

  it('counts a team the way the engine does, pauses when the creator leaves it, and refuses a viewer share', async () => {
    const team = (await (await call(owner, 'POST', '/api/teams', { name: 'Crew' })).json()).id as string;
    expect((await call(owner, 'POST', `/api/teams/${team}/members`, { memberType: 'HUMAN', memberId: 'mate' })).status).toBeLessThan(300);
    const t = await chat('T', [{ type: 'AGENT', id: 'Pom' }, { type: 'TEAM', id: team }]);
    const s = await create(mate, { channelId: t, agent: 'Pom' });
    // The creator edits and manages their own schedule, whatever their access comes through.
    expect(s).toMatchObject({ canEdit: true, canManage: true });
    expect((await call(mate, 'DELETE', `/api/teams/${team}/members/HUMAN/mate`)).status).toBeLessThan(300);
    at(MON_0900 - 30_000);
    await tick();
    expect(await triggers(t)).toEqual([]);
    expect(product.store.schedules.schedule(s.id)).toMatchObject({ on: false, pausedReason: 'access', nextEventId: null });
    expect((await needs(mate)).filter(n => n.kind === 'paused').map(n => n.short)).toEqual(["Schedule paused · you can't post here any more"]);
    // A chat shared with mate to view: mate reads it but may not schedule into it.
    expect((await call(owner, 'POST', `/api/channels/${c}/share`, { viewerType: 'HUMAN', viewerId: 'mate' })).status).toBe(200);
    const refused = await call(mate, 'POST', '/api/flows/schedules', { id: randomUUID(), channelId: c, agent: 'Pom', prompt: 'Recap', rule: WEEKLY, timezone: 'UTC' });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: 'You need to be able to post in this chat' });
  });

  it('pauses a schedule whose chat was deleted and names it in Needs you as a chat that can no longer be opened (final I1)', async () => {
    const d = await chat('D', [{ type: 'AGENT', id: 'Pom' }]);
    const s = await create(owner, { channelId: d, agent: 'Pom' });
    expect((await call(owner, 'DELETE', `/api/channels/${d}`)).status).toBeLessThan(300);
    at(MON_0900 - 30_000);
    await tick();
    expect(product.store.schedules.schedule(s.id)).toMatchObject({ on: false, pausedReason: 'unavailable', nextEventId: null });
    expect((await needs(owner)).filter(n => n.kind === 'paused')).toEqual([expect.objectContaining({
      key: `schedule-paused:${s.id}`, channelId: d, short: 'Schedule paused · this chat is no longer available',
      chatTitle: 'a chat you can no longer open',
    })]);
    // A chat the viewer still sees keeps its own title.
    await create(owner, {});
    at(MON_0900 + 11 * MIN);
    await tick();
    expect((await needs(owner)).find(n => n.kind === 'missed')?.chatTitle).toBe('A');
  });

  it('pauses with agent-left when the agent leaves before its run, until the schedule is deleted', async () => {
    const s = await create(owner, {});
    expect((await unsubscribe('AGENT', 'Pip')).status).toBe(200);
    at(MON_0900 - 30_000);
    await tick();
    expect(await triggers(a)).toEqual([]);
    expect(product.store.schedules.schedule(s.id)).toMatchObject({ on: false, pausedReason: 'agent-left' });
    expect((await needs(owner)).find(n => n.kind === 'paused')?.short).toBe('Schedule paused · Pip left the chat');
    expect([schedulePausedWhy('access', 'Pip'), schedulePausedWhy('unavailable', 'Pip')]).toEqual(["you can't post here any more", 'this chat is no longer available']);
    expect((await call(owner, 'DELETE', `/api/flows/schedules/${s.id}?version=1`)).status).toBe(204);
    expect((await needs(owner)).filter(n => n.kind === 'paused')).toEqual([]);
  });

  it('runs a once rule a single time, keeps intervals on their grid, and says no turn started for a running agent', async () => {
    const once = await create(owner, { rule: { kind: 'once', day: 0, time: '09:00' } });
    const every = await create(owner, { rule: { kind: 'interval', mins: 15 } });
    expect(every.nextAt).toBe(MON_0800 + 15 * MIN);
    at(MON_0800 + 15 * MIN + 7_000);
    await tick();
    expect(product.store.schedules.schedule(every.id)?.nextAt).toBe(MON_0800 + 30 * MIN);
    engine.db.prepare("UPDATE agents SET desired_state='RUNNING' WHERE name='Pip'").run();
    at(MON_0800 + 26 * MIN);
    await tick();
    expect(runs(every.id)[0]).toMatchObject({ status: 'missed', reason: 'no turn started' });
    at(MON_0900 + MIN);
    await turnStarted(a);
    await tick();
    expect(runs(once.id)).toEqual([expect.objectContaining({ status: 'started' })]);
    expect(product.store.schedules.schedule(once.id)).toMatchObject({ on: false, nextAt: null, pausedReason: null });
    expect((await triggers(a)).filter(t => (t.payload.nestSwitchyard as { scheduleId?: string }).scheduleId === once.id)).toHaveLength(1);
  });

  it('records one combined missed run for the occurrences a Nest restart skipped (final I2)', async () => {
    const every = await create(owner, { rule: { kind: 'interval', mins: 5 } });
    at(MON_0800 + 4 * MIN);
    await tick();
    expect(runs(every.id)).toEqual([expect.objectContaining({ dueAt: MON_0800 + 5 * MIN, status: 'booked' })]);
    // Nest is down for 12 minutes: 08:05 fires in the engine, 08:10 and 08:15 were never booked.
    at(MON_0800 + 16 * MIN);
    await tick();
    const missed = runs(every.id).filter(r => r.dueAt > MON_0800 + 5 * MIN && r.status === 'missed');
    expect(missed).toEqual([expect.objectContaining({ kind: 'scheduled', dueAt: MON_0800 + 15 * MIN, reason: 'no turn started', eventId: null })]);
    expect(product.store.schedules.schedule(every.id)?.nextAt).toBe(MON_0800 + 20 * MIN);
    expect((await needs(owner)).filter(n => n.kind === 'missed')).toEqual([expect.objectContaining({
      key: `missed:${missed[0].id}`, at: MON_0800 + 15 * MIN, short: 'Missed run · no turn started', gate: { kind: 'missed', scheduleId: every.id, runId: missed[0].id },
    })]);
    // Later ticks add nothing for the same window.
    await tick();
    expect(runs(every.id).filter(r => r.status === 'missed' && r.dueAt > MON_0800 + 5 * MIN)).toHaveLength(1);
  });

  it('records one missed run at the latest day a daily schedule skipped over two days down (final I2)', async () => {
    const daily = await create(owner, { rule: { kind: 'daily', time: '09:00' } });
    at(MON_0800 + 30 * MIN);
    await tick();
    at(MON_0900 + 2 * 24 * 60 * MIN + 30 * MIN);
    await tick();
    expect(runs(daily.id).filter(r => r.dueAt > MON_0900 && r.status === 'missed')).toEqual([expect.objectContaining({ dueAt: MON_0900 + 2 * 24 * 60 * MIN, reason: 'no turn started' })]);
    expect(product.store.schedules.schedule(daily.id)?.nextAt).toBe(MON_0900 + 3 * 24 * 60 * MIN);
  });

  it('says engine unavailable for occurrences skipped while the engine was unreachable (final I2)', async () => {
    const every = await create(owner, { rule: { kind: 'interval', mins: 5 } });
    at(MON_0800 + 4 * MIN);
    await tick();
    outage = true;
    at(MON_0800 + 16 * MIN);
    await tick();
    expect(runs(every.id).filter(r => r.status === 'missed')).toEqual([expect.objectContaining({ dueAt: MON_0800 + 15 * MIN, reason: 'engine unavailable' })]);
    outage = false;
  });

  it("answers 404 for a schedule in a chat the viewer cannot read, and lets its creator Run now in a chat they post in", async () => {
    const s = await create(owner, { channelId: c, agent: 'Pom' });
    expect((await call(mate, 'PATCH', `/api/flows/schedules/${s.id}`, { on: false, version: 0 })).status).toBe(404);
    expect((await call(mate, 'DELETE', `/api/flows/schedules/${s.id}?version=0`)).status).toBe(404);
    expect((await call(mate, 'POST', `/api/flows/schedules/${s.id}/run`)).status).toBe(404);
    expect((await call(owner, 'POST', `/api/flows/schedules/${s.id}/run`)).status).toBe(201);
  });

  it('marks a run started when the agent starts a turn in the grace, then books the next week', async () => {
    const s = await create(owner, {});
    at(MON_0900 + MIN);
    await turnStarted(a);
    await tick();
    expect(runs(s.id)).toEqual([
      expect.objectContaining({ dueAt: MON_0900, status: 'started' }),
      expect.objectContaining({ dueAt: MON_0900 + WEEK, status: 'booked' }),
    ]);
    const all = await triggers(a);
    expect(all.map(t => t.deliverAt)).toEqual([MON_0900, MON_0900 + WEEK]);
    const [view] = (await list(owner)).schedules;
    expect(view).toMatchObject({ nextAt: MON_0900 + WEEK, lastRun: { status: 'started', dueAt: MON_0900 } });
    expect((await needs(owner)).filter(n => n.kind === 'missed')).toEqual([]);
  });

  it('marks a run missed with its reason after the grace, lists it in Needs you, and late when a turn comes after', async () => {
    const s = await create(owner, {});
    at(MON_0900 + MIN);
    await tick();
    expect(runs(s.id)[0].status).toBe('booked');
    at(MON_0900 + 10 * MIN + 1000);
    await tick();
    const [missed] = runs(s.id);
    expect(missed).toMatchObject({ status: 'missed', reason: 'agent stopped' });
    const items = (await needs(owner)).filter(n => n.kind === 'missed');
    expect(items).toEqual([expect.objectContaining({
      key: `missed:${missed.id}`, channelId: a, from: 'Pip', at: MON_0900, short: 'Missed run · agent stopped', reason: 'agent stopped',
      gate: { kind: 'missed', scheduleId: s.id, runId: missed.id },
    })]);
    // Needs you is the creator's alone.
    expect((await needs(mate)).filter(n => n.kind === 'missed')).toEqual([]);
    expect(logs.some(l => l.includes(`schedule ${s.id}`) && l.includes('agent stopped'))).toBe(true);

    at(MON_0900 + 15 * MIN);
    await turnStarted(a);
    await tick();
    expect(product.store.schedules.run(missed.id)).toMatchObject({ status: 'late' });
    expect((await needs(owner)).filter(n => n.kind === 'missed')).toEqual([]);
  });

  it('runs now: an immediate trigger, the missed run superseded and the Needs you item gone', async () => {
    const s = await create(owner, {});
    at(MON_0900 + 11 * MIN);
    await tick();
    const [missed] = runs(s.id);
    expect(missed.status).toBe('missed');
    expect((await needs(owner)).some(n => n.kind === 'missed')).toBe(true);

    const res = await call(mate, 'POST', `/api/flows/schedules/${s.id}/run`);
    expect(res.status, await res.clone().text()).toBe(201);
    const { runId } = (await res.json()) as { runId: string };
    const now = (await triggers(a)).find(t => t.idempotencyKey === `nest:schedule:${s.id}:now:${runId}`)!;
    expect(now).toBeTruthy();
    expect(now.deliverAt).toBeUndefined();
    expect(now.payload).toEqual({
      text: 'Run started by mate\n\nRecap the week', targetAgentName: 'Pip',
      nestSwitchyard: { kind: 'run', setBy: expect.any(String), scheduleId: s.id, runId },
    });
    expect(product.store.schedules.run(missed.id)?.status).toBe('superseded');
    expect(product.store.schedules.run(runId)).toMatchObject({ kind: 'manual', status: 'booked', eventId: now.id });
    expect((await needs(owner)).filter(n => n.kind === 'missed')).toEqual([]);
  });

  it('cancels the booked event on pause and books again from now on resume; members pause but only the creator edits', async () => {
    const s = await create(owner, {});
    const booked = product.store.schedules.schedule(s.id)!.nextEventId!;
    const paused = await call(mate, 'PATCH', `/api/flows/schedules/${s.id}`, { on: false, version: 0 });
    expect(paused.status, await paused.clone().text()).toBe(200);
    expect(await paused.json()).toMatchObject({ on: false, nextAt: null, version: 1 });
    expect((await runner('GET', `/api/events/${booked}`)).status).toBe(404);
    expect(runs(s.id)).toEqual([]);
    await tick();
    expect(await triggers(a)).toEqual([]);

    expect((await call(mate, 'PATCH', `/api/flows/schedules/${s.id}`, { prompt: 'Mine now', version: 1 })).status).toBe(403);
    expect((await call(owner, 'PATCH', `/api/flows/schedules/${s.id}`, { on: true, version: 0 })).status).toBe(409);

    // Resumed after this week's time: the next run is next week.
    at(MON_0900 + 30 * MIN);
    const resumed = await call(owner, 'PATCH', `/api/flows/schedules/${s.id}`, { on: true, version: 1 });
    expect(resumed.status).toBe(200);
    expect(await resumed.json()).toMatchObject({ on: true, nextAt: MON_0900 + WEEK });
    expect((await triggers(a)).map(t => t.deliverAt)).toEqual([MON_0900 + WEEK]);

    // The creator edits the prompt: the booking is replaced with the new text.
    const edited = await call(owner, 'PATCH', `/api/flows/schedules/${s.id}`, { prompt: 'Recap the month', rule: { kind: 'daily', time: '18:00' }, version: 2 });
    expect(edited.status).toBe(200);
    const [trigger, ...rest] = await triggers(a);
    expect(rest).toEqual([]);
    expect(trigger).toMatchObject({ deliverAt: Date.UTC(2026, 10, 16, 18), payload: { text: 'Scheduled run · Every day at 18:00 · set up by owner\n\nRecap the month' } });

    // A member deletes it; the booked event goes too.
    expect((await call(mate, 'DELETE', `/api/flows/schedules/${s.id}?version=3`)).status).toBe(204);
    expect(await triggers(a)).toEqual([]);
    expect(product.store.schedules.schedule(s.id)).toBeNull();
  });

  it('records a run the engine could not book as missed, then books the next time once it is back', async () => {
    failPosts = true;
    const s = await create(owner, {});
    expect(product.store.schedules.schedule(s.id)).toMatchObject({ nextAt: MON_0900, nextEventId: null });
    outage = true;
    at(MON_0900 + 5 * MIN);
    await tick();
    expect(runs(s.id)).toEqual([]);
    at(MON_0900 + 10 * MIN);
    await tick();
    expect(runs(s.id)).toEqual([]);
    at(MON_0900 + 10 * MIN + 1000);
    await tick();
    expect(runs(s.id)).toEqual([expect.objectContaining({ dueAt: MON_0900, status: 'missed', reason: 'engine unavailable', eventId: null })]);
    expect(product.store.schedules.schedule(s.id)?.nextAt).toBe(MON_0900 + WEEK);
    outage = false; failPosts = false;
    await tick();
    expect((await triggers(a)).map(t => t.deliverAt)).toEqual([MON_0900 + WEEK]);
    expect((await needs(owner)).find(n => n.kind === 'missed')?.short).toBe('Missed run · engine unavailable');
  });

  it("lists agent-made schedules only in chats the viewer can read, and never Switchyard's", async () => {
    await create(owner, {});
    const pom = await emit('agent.scheduled.trigger', 'agent:Pom', c, { text: 'Check the build', targetAgentName: 'Pom' }, { deliverAt: MON_0900 + 60 * MIN });
    const pip = await emit('agent.scheduled.trigger', 'agent:Pip', a, { text: 'Follow up', targetAgentName: 'Pip' }, { deliverAt: MON_0900 + 120 * MIN });
    const mine = (await list(owner)).agentMade;
    expect(mine).toEqual(expect.arrayContaining([
      { eventId: pom.id, channelId: c, agent: 'Pom', at: MON_0900 + 60 * MIN, text: 'Check the build' },
      { eventId: pip.id, channelId: a, agent: 'Pip', at: MON_0900 + 120 * MIN, text: 'Follow up' },
    ]));
    expect(mine).toHaveLength(2);
    expect((await list(mate)).agentMade).toEqual([{ eventId: pip.id, channelId: a, agent: 'Pip', at: MON_0900 + 120 * MIN, text: 'Follow up' }]);
  });

  it('refuses a chat the viewer cannot post in, an agent not in the chat, and the 11th schedule in a chat', async () => {
    await create(mate, { channelId: c, agent: 'Pom' }, 403);
    await create(owner, { agent: 'Pom' }, 409);
    await create(owner, { agent: 'Switchyard' }, 400);
    await create(owner, { timezone: 'Mars/Olympus' }, 400);
    await create(owner, { rule: { kind: 'interval', mins: 4 } }, 400);
    expect((await call(mate, 'POST', `/api/flows/schedules/${randomUUID()}/run`)).status).toBe(404);
    for (let i = 0; i < 10; i++) await create(owner, { rule: { kind: 'interval', mins: 60 + i } });
    await create(owner, {}, 400);
    // Over the limit, Switchyard does not join the chat.
    const pomChat = await chat('D', [{ type: 'AGENT', id: 'Pom' }]);
    for (let i = 0; i < 10; i++) product.store.schedules.createSchedule({ id: randomUUID(), channelId: pomChat, agent: 'Pom', prompt: 'x', rule: { kind: 'daily', time: '09:00' }, timezone: 'UTC', createdBy: ownerId, now: 1, nextAt: null });
    await create(owner, { channelId: pomChat, agent: 'Pom' }, 400);
    const d = ((await (await call(owner, 'GET', '/api/channels')).json()) as { id: string; participants: { subscriberId: string }[] }[]).find(ch => ch.id === pomChat)!;
    expect(d.participants.map(p => p.subscriberId)).not.toContain('Switchyard');
  });
});
