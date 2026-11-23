import { randomUUID } from 'node:crypto';
import type { Hono } from 'hono';
import { z } from 'zod';
import { CanvasConflictError, type ProductDb, type ScheduleRecord } from '@nest/db';
import { EngineError, type EngineChannel, type EngineEvent, type Human, type OrgOpsClient, type ServiceAgent, type ServiceClient } from '@nest/orgops-client';
import {
  MISSED_GRACE_MS, NewScheduleSchema, SchedulePatchSchema, atText, nextRunAt, ruleText,
  type AgentMadeSchedule, type FlowNeed, type MissedReason, type SchedulePausedReason, type ScheduleView, type TriggerView,
} from '@nest/schemas';
import type { Channel } from '../canvases';
import { accessReader, channelAccess, isAgentIn, serviceTeams } from './access';
import { SwitchyardUnavailableError, type Switchyard } from './identity';
import { FlowActionError, holdFlowsLease, type Actor } from './handoff';

type PauseReason = Exclude<SchedulePausedReason, null>;
import type { ForkRouteTools } from './forks';

/** How long after a missed run's due time a turn still marks it late. */
const LATE_WINDOW_MS = 24 * 3_600_000;
/** A booked run is checked once more for access and its agent on the tick within this long before it is due. */
const RECHECK_MS = 60_000;
const NOT_SET_UP = 'Schedules are not set up on this server';

const str = (value: unknown) => (typeof value === 'string' ? value : '');
const describe = (error: unknown) =>
  error instanceof EngineError ? `engine status ${error.status}` : error instanceof Error ? error.name : 'unknown error';
/** The trigger a scheduled run posts: who set it up first, then the prompt. */
export const scheduledRunText = (s: ScheduleRecord, username: string) => `Scheduled run · ${ruleText(s.rule)} · set up by ${username}\n\n${s.prompt}`;

/**
 * The scheduler. Each schedule has at most one booked run: an engine `agent.scheduled.trigger` posted by the stopped
 * Switchyard agent with `deliverAt` and the key `nest:schedule:<id>:<dueAt>`, so a retry after a crash or a lost
 * response returns the event already stored. The engine delivers it to the target agent when due. Each tick (under the
 * lease the hand-off worker holds) moves due schedules on to their next time, records runs that could not be booked in
 * time as missed, checks booked runs for a started turn, and books what is unbooked. Logs carry ids, never prompts.
 */
export function createScheduler({ store, orgops, token, switchyard, now = Date.now, holder = randomUUID(), log = line => console.warn(line) }: {
  store: ProductDb; orgops: OrgOpsClient; token: string | undefined; switchyard: Switchyard;
  now?: () => number; holder?: string; log?: (line: string) => void;
}) {
  const schedules = store.schedules;

  /** Engine records read at most once per tick or action. */
  function snapshot(service: ServiceClient) {
    let channels: Promise<Map<string, EngineChannel>> | null = null;
    let humans: Promise<Map<string, Actor>> | null = null;
    let runners: Promise<Map<string, boolean>> | null = null;
    const agents = new Map<string, Promise<ServiceAgent | null>>();
    return {
      service,
      access: accessReader(serviceTeams(service)),
      channels: () => (channels ??= service.channels().then(list => new Map(list.map(ch => [ch.id, ch])))),
      humans: () => (humans ??= service.humans().then(list => new Map(list.map(h => [h.id, { id: h.id, username: h.username }])))),
      runners: () => (runners ??= service.runners().then(list => new Map(list.map(r => [r.id, r.online])))),
      agent: (name: string) => { let found = agents.get(name); if (!found) agents.set(name, found = service.agent(name)); return found; },
    };
  }
  type Snapshot = ReturnType<typeof snapshot>;

  async function serviceOrNull(): Promise<ServiceClient | null> {
    try {
      const state = await switchyard.ensure();
      return state.ok && token ? orgops.service(token) : null;
    } catch (error) {
      log(`[flows] the service agent check failed: ${describe(error)}`);
      return null;
    }
  }

  /**
   * The time after a run due at `due`, seen at `at`. Intervals stay on their grid (due + k·mins), so ticks running late
   * never make them drift; the other rules take their next wall-clock time after `at`.
   */
  function following(s: ScheduleRecord, due: number, at: number): number | null {
    if (s.rule.kind === 'once') return null;
    if (s.rule.kind === 'interval') {
      const step = s.rule.mins * 60_000;
      return due + (Math.floor(Math.max(0, at - due) / step) + 1) * step;
    }
    return nextRunAt(s.rule, s.timezone, Math.max(at, due));
  }
  /**
   * The latest occurrence strictly between `due` and `next` (the time `following` chose): one Nest skipped because it
   * was not ticking (a restart or downtime), or null when none was skipped.
   */
  function skippedBefore(s: ScheduleRecord, due: number, next: number | null): number | null {
    if (next === null || s.rule.kind === 'once') return null;
    if (s.rule.kind === 'interval') {
      const latest = next - s.rule.mins * 60_000;
      return latest > due ? latest : null;
    }
    let latest: number | null = null;
    // Bounded: a weekly rule covers about 19 years of downtime; past that, the newest counted one is recorded.
    for (let t = nextRunAt(s.rule, s.timezone, due), i = 0; t !== null && t < next && i < 1000; t = nextRunAt(s.rule, s.timezone, t), i++) latest = t;
    return latest;
  }
  function pause(s: ScheduleRecord, reason: PauseReason) {
    schedules.pause(s.id, reason, 'system');
    log(`[flows] schedule ${s.id} paused: ${reason}`);
  }

  /** Whether a schedule may run now, by the flows access rule: its creator posts in the chat and its agent is in it. */
  async function check(s: ScheduleRecord, ctx: Snapshot): Promise<{ reason: PauseReason } | { creator: Actor }> {
    const channel = (await ctx.channels()).get(s.channelId);
    if (!channel) return { reason: 'unavailable' };
    const creator = (await ctx.humans()).get(s.createdBy);
    if (!creator || !(await ctx.access(channel, creator)).post) return { reason: 'access' };
    if (!isAgentIn(channel, s.agent)) return { reason: 'agent-left' };
    return { creator };
  }

  /** Cancels an engine event booked for a schedule. True when it is gone; false when it is already due (409). */
  async function cancelEvent(service: ServiceClient, eventId: string): Promise<boolean> {
    try { return await service.deleteEvent(eventId); } catch (error) {
      if (error instanceof EngineError && error.status === 404) return true;
      throw error;
    }
  }

  /**
   * True when the schedule as stored now would book exactly this event: on, due at the same time, and either already
   * booked with it or about to post the same text to the same agent. Such an event belongs to whoever changed the
   * schedule last (or to the next tick, which gets it back by its key), so it is never cancelled.
   */
  function wantedNow(before: ScheduleRecord, event: EngineEvent, username: string): boolean {
    const current = schedules.schedule(before.id);
    if (!current || !current.on || current.nextAt !== before.nextAt) return false;
    if (current.nextEventId) return current.nextEventId === event.id;
    return !event.payloadTruncated && str(event.payload?.text) === scheduledRunText(current, username) && event.payload?.targetAgentName === current.agent;
  }
  async function dropUnlessWanted(ctx: Snapshot, before: ScheduleRecord, event: EngineEvent, username: string) {
    if (wantedNow(before, event, username)) return;
    await cancelEvent(ctx.service, event.id).catch(error => log(`[flows] cancelling a stale booking for schedule ${before.id} failed: ${describe(error)}`));
  }

  /**
   * Books a schedule's next run, unless it is off, booked or has no next time. Pauses it when its creator can no longer
   * post in the chat (`access`), its agent left (`agent-left`) or the chat is gone (`unavailable`). An engine event
   * stored under the key with other text (a booking left over from before an edit) is replaced once, but only while
   * the schedule is still as this booking read it; a newer writer's event is left to that writer.
   */
  async function bookOne(s: ScheduleRecord, ctx: Snapshot, at: number): Promise<EngineEvent | null> {
    if (!s.on || s.nextEventId || s.nextAt === null) return null;
    const verdict = await check(s, ctx);
    if ('reason' in verdict) { pause(s, verdict.reason); return null; }
    const { username } = verdict.creator;
    const text = scheduledRunText(s, username);
    const post = () => switchyard.post({
      type: 'agent.scheduled.trigger', channelId: s.channelId, deliverAt: s.nextAt!, target: s.agent, text,
      kind: 'run', setBy: s.createdBy, idempotencyKey: `nest:schedule:${s.id}:${s.nextAt}`, meta: { scheduleId: s.id },
    });
    let event: EngineEvent;
    try {
      event = await post();
      const stale = !event.payloadTruncated && (str(event.payload?.text) !== text || event.payload?.targetAgentName !== s.agent);
      if (stale) {
        const current = schedules.schedule(s.id);
        if (!current || current.version !== s.version || current.nextEventId !== null) {
          await dropUnlessWanted(ctx, s, event, username);
          return null;
        }
        if (await cancelEvent(ctx.service, event.id)) event = await post();
      }
    } catch (error) {
      if (error instanceof EngineError && error.status === 400) {
        // The engine refuses a trigger whose target is not an agent in the chat; any other refusal is only logged.
        const fresh = (await ctx.service.channels()).find(ch => ch.id === s.channelId);
        if (!fresh || !isAgentIn(fresh, s.agent)) { pause(s, 'agent-left'); return null; }
      }
      throw error;
    }
    if (schedules.markBooked(s.id, s.nextAt, event.id, at, s.version)) return event;
    // Paused, changed or removed meanwhile: cancel the event unless the schedule as it is now wants exactly it.
    await dropUnlessWanted(ctx, s, event, username);
    return null;
  }

  // Booked runs already re-checked shortly before they are due, as `<scheduleId>:<eventId>`.
  const rechecked = new Set<string>();
  /**
   * Once per booking, on the first tick within 60 s of its time: a creator who can no longer post, or an agent (or
   * chat) that is gone, cancels the booked event and pauses the schedule, so the prompt never runs without access.
   */
  async function recheckSoon(ctx: Snapshot, at: number) {
    const soon = schedules.bookedBetween(at, at + RECHECK_MS);
    const keys = new Set(soon.map(s => `${s.id}:${s.nextEventId}`));
    for (const key of rechecked) if (!keys.has(key)) rechecked.delete(key);
    for (const s of soon) {
      const key = `${s.id}:${s.nextEventId}`;
      if (rechecked.has(key)) continue;
      try {
        const verdict = await check(s, ctx);
        if ('reason' in verdict) {
          await cancel(s);
          pause(s, verdict.reason);
        }
        rechecked.add(key);
      } catch (error) {
        log(`[flows] re-checking schedule ${s.id} failed: ${describe(error)}`);
      }
    }
  }

  /**
   * Local work, no engine needed: move booked schedules past their due time on, and miss what could not be booked.
   * Occurrences a booked schedule skipped while Nest was not ticking (a restart or downtime) are recorded as one
   * combined missed run at the latest of them, with `skipReason`, so none is lost silently.
   */
  function moveOn(at: number, skipReason: MissedReason) {
    for (const s of schedules.bookedDue(at)) {
      try {
        const next = following(s, s.nextAt!, at);
        const skipped = skippedBefore(s, s.nextAt!, next);
        if (!schedules.moveOn(s.id, { nextAt: s.nextAt!, eventId: s.nextEventId }, next, s.rule.kind === 'once') || skipped === null) continue;
        schedules.insertRun({ scheduleId: s.id, dueAt: skipped, kind: 'scheduled', status: 'missed', reason: skipReason, now: at });
        log(`[flows] schedule ${s.id} missed skipped runs: ${skipReason}`);
      } catch (error) { log(`[flows] moving schedule ${s.id} on failed: ${describe(error)}`); }
    }
    for (const s of schedules.unbooked()) {
      if (at <= s.nextAt! + MISSED_GRACE_MS) continue;
      try {
        const next = following(s, s.nextAt!, at);
        schedules.insertRun({ scheduleId: s.id, dueAt: s.nextAt!, kind: 'scheduled', status: 'missed', reason: 'engine unavailable', now: at });
        schedules.moveOn(s.id, { nextAt: s.nextAt!, eventId: null }, next, s.rule.kind === 'once');
        log(`[flows] schedule ${s.id} missed a run: engine unavailable`);
      } catch (error) { log(`[flows] moving schedule ${s.id} on failed: ${describe(error)}`); }
    }
  }

  /** Why a run did not start: the agent's runner is offline, the agent is not running, or neither. */
  async function missedReason(ctx: Snapshot, agentName: string): Promise<MissedReason> {
    const agent = await ctx.agent(agentName);
    if (agent?.assignedRunnerId && !(await ctx.runners()).get(agent.assignedRunnerId)) return 'runner offline';
    if (agent?.desiredState !== 'RUNNING') return 'agent stopped';
    return 'no turn started';
  }

  /** The first turn the agent started in the chat after `after`, or undefined. */
  async function firstTurnAfter(ctx: Snapshot, s: ScheduleRecord, after: number): Promise<EngineEvent | undefined> {
    return (await ctx.service.events({ channelId: s.channelId, type: 'agent.turn.started', source: `agent:${s.agent}`, after: String(after), order: 'asc', limit: '1' }))[0];
  }

  /** Booked runs that are due: started when the agent started a turn within the grace, else missed after it. */
  async function settleDue(ctx: Snapshot, at: number) {
    for (const run of schedules.runsDue(at)) {
      try {
        const s = schedules.schedule(run.scheduleId);
        if (!s) continue;
        const turn = await firstTurnAfter(ctx, s, run.dueAt - 1);
        if (turn && turn.createdAt <= run.dueAt + MISSED_GRACE_MS) { schedules.settleRun(run.id, 'started', null, ['booked']); continue; }
        if (at <= run.dueAt + MISSED_GRACE_MS) continue;
        const reason = await missedReason(ctx, s.agent);
        if (schedules.settleRun(run.id, 'missed', reason, ['booked'])) log(`[flows] schedule ${s.id} missed a run: ${reason}`);
      } catch (error) {
        log(`[flows] checking run ${run.id} failed: ${describe(error)}`);
      }
    }
  }

  /** A turn after the grace (within a day, and before the schedule's next run) turns a missed run late. */
  async function settleLate(ctx: Snapshot, at: number) {
    for (const run of schedules.missedSince(at - LATE_WINDOW_MS)) {
      try {
        const s = schedules.schedule(run.scheduleId);
        if (!s) continue;
        const turn = await firstTurnAfter(ctx, s, run.dueAt + MISSED_GRACE_MS);
        const bound = Math.min(schedules.runAfter(s.id, run.dueAt) ?? Infinity, run.dueAt + LATE_WINDOW_MS);
        if (turn && turn.createdAt < bound) schedules.settleRun(run.id, 'late', run.reason, ['missed']);
      } catch (error) {
        log(`[flows] checking run ${run.id} failed: ${describe(error)}`);
      }
    }
  }

  async function run() {
    const at = now();
    if (!holdFlowsLease(store, holder, at)) return;
    // Asked first, so runs skipped while Nest was down say whether the engine could be reached.
    const service = await serviceOrNull();
    moveOn(at, service ? 'no turn started' : 'engine unavailable');
    if (!service) return;
    const ctx = snapshot(service);
    try { await settleDue(ctx, at); } catch (error) { log(`[flows] checking scheduled runs failed: ${describe(error)}`); }
    try { await settleLate(ctx, at); } catch (error) { log(`[flows] checking missed runs failed: ${describe(error)}`); }
    try { await recheckSoon(ctx, at); } catch (error) { log(`[flows] re-checking booked runs failed: ${describe(error)}`); }
    for (const s of schedules.unbooked()) {
      try { await bookOne(s, ctx, at); } catch (error) { log(`[flows] booking schedule ${s.id} failed: ${describe(error)}`); }
    }
  }

  // Ticks and bookings asked for by a person run one at a time in this process; across processes, only the lease holder
  // books. So the only writes that can land during a booking are a person's cancel and change, which bookOne re-checks.
  let lock: Promise<unknown> = Promise.resolve();
  function exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const result = lock.then(fn);
    lock = result.catch(() => undefined);
    return result;
  }

  // One tick at a time; a tick asked for while one runs runs once after it.
  let current: Promise<void> | null = null;
  let queued: Promise<void> | null = null;
  function tick(): Promise<void> {
    if (!current) {
      current = exclusive(run).catch(error => log(`[flows] schedule tick failed: ${describe(error)}`)).finally(() => { current = null; });
      return current;
    }
    queued ??= current.then(() => { queued = null; return tick(); });
    return queued;
  }

  /**
   * Books one schedule now (after create, resume or edit), after any running tick and only while this process holds the
   * flows lease; otherwise the holder books it on its next tick. Failures are logged; the next tick retries.
   */
  function book(scheduleId: string): Promise<boolean> {
    return exclusive(async () => {
      try {
        const at = now();
        if (!holdFlowsLease(store, holder, at)) return false;
        const s = schedules.schedule(scheduleId);
        if (!s?.on || s.nextEventId) return false;
        const service = await serviceOrNull();
        if (!service) return false;
        return (await bookOne(s, snapshot(service), at)) !== null;
      } catch (error) {
        log(`[flows] booking schedule ${scheduleId} failed: ${describe(error)}`);
        return false;
      }
    });
  }

  /**
   * Cancels a schedule's booked event before a pause, edit or delete. An event already due (409) is left to the run
   * check. An outage throws, so the person's change is refused (502) rather than leaving a stale run booked.
   */
  async function cancel(s: ScheduleRecord): Promise<void> {
    if (!s.nextEventId) return;
    if (!token) throw new FlowActionError(503, NOT_SET_UP);
    const gone = await cancelEvent(orgops.service(token), s.nextEventId);
    schedules.unbook(s.id, s.nextEventId, gone);
  }
  /** Cancels an event booked while a change was being made; logged, never thrown (the change already stands). */
  async function cancelDropped(scheduleId: string, eventId: string | null): Promise<void> {
    if (!eventId || !token) return;
    try { schedules.unbook(scheduleId, eventId, await cancelEvent(orgops.service(token), eventId)); } catch (error) {
      log(`[flows] cancelling a replaced booking for schedule ${scheduleId} failed: ${describe(error)}`);
    }
  }

  /**
   * Run now: an immediate trigger (no deliverAt) with the key `nest:schedule:<id>:now:<runId>`, recorded as a manual
   * run, which then settles like any other. The schedule's missed runs are superseded.
   */
  async function runNow(scheduleId: string, actor: Actor): Promise<{ runId: string }> {
    const s = schedules.schedule(scheduleId);
    if (!s) throw new FlowActionError(404, 'Not found');
    const at = now();
    const runId = randomUUID();
    if (!schedules.insertRun({ id: runId, scheduleId: s.id, dueAt: at, kind: 'manual', status: 'booked', now: at })) {
      throw new FlowActionError(409, 'A run was just started');
    }
    try {
      const event = await switchyard.post({
        type: 'agent.scheduled.trigger', channelId: s.channelId, target: s.agent, text: `Run started by ${actor.username}\n\n${s.prompt}`,
        kind: 'run', setBy: actor.id, idempotencyKey: `nest:schedule:${s.id}:now:${runId}`, meta: { scheduleId: s.id, runId },
      });
      schedules.setRunEvent(runId, event.id);
    } catch (error) {
      schedules.deleteRun(runId);
      if (error instanceof SwitchyardUnavailableError) throw new FlowActionError(503, NOT_SET_UP);
      if (error instanceof EngineError && error.status === 400) throw new FlowActionError(409, `Add ${s.agent} to the chat first`);
      throw error;
    }
    schedules.supersedeMissed(s.id);
    return { runId };
  }

  return { tick, book, cancel, cancelDropped, runNow, now };
}
export type Scheduler = ReturnType<typeof createScheduler>;

/** How a schedule Nest paused reads in Needs you (ruling T10-R2). */
export function schedulePausedWhy(reason: PauseReason, agent: string): string {
  if (reason === 'access') return "you can't post here any more";
  if (reason === 'agent-left') return `${agent} left the chat`;
  return 'this chat is no longer available';
}

/**
 * The creator's schedule items for Needs you: each schedule Nest paused (until it is resumed or deleted), and each
 * schedule's newest missed run (until a later run settles or Run now).
 */
export function missedNeeds(store: ProductDb, creatorId: string): FlowNeed[] {
  const paused = store.schedules.pausedFor(creatorId).map((s): FlowNeed => {
    const why = schedulePausedWhy(s.pausedReason!, s.agent);
    return {
      key: `schedule-paused:${s.id}`, kind: 'paused', channelId: s.channelId, at: s.updatedAt, from: null,
      short: `Schedule paused · ${why}`, reason: why,
      detail: `${ruleText(s.rule)} · ${s.agent} does not run until you resume it.`,
      gate: { kind: 'schedule-paused', scheduleId: s.id },
    };
  });
  return [...paused, ...store.schedules.missedFor(creatorId).map(({ run, schedule: s }): FlowNeed => {
    const reason = run.reason ?? 'no turn started';
    return {
      key: `missed:${run.id}`, kind: 'missed', channelId: s.channelId, at: run.dueAt, from: s.agent,
      short: `Missed run · ${reason}`, reason,
      detail: `Scheduled run · ${ruleText(s.rule)} · ${s.agent}. Missed ${atText(run.dueAt, s.timezone)}: ${reason}. Nothing ran.`,
      gate: { kind: 'missed', scheduleId: s.id, runId: run.id },
    };
  })];
}

/**
 * Schedule routes. Chats and agent-made schedules are read with the viewer's own session; booking and Run now post as
 * Switchyard. Creating needs post access to the chat (by the flows rule) and the agent in it. Settings (prompt, agent,
 * rule) are the creator's; pausing, deleting and Run now are open to the creator and the chat's members.
 */
export function registerScheduleRoutes(routes: Hono<{ Variables: { human: Human } }>, { store, orgops, switchyard, scheduler, tools, triggers = () => [] }: {
  store: ProductDb; orgops: OrgOpsClient; switchyard: Switchyard; scheduler: Scheduler; tools: ForkRouteTools;
  /** The webhook triggers in the viewer's chats, listed with the schedules. */
  triggers?: (channels: Map<string, Channel>, viewer: Human) => TriggerView[];
}) {
  const { fail, parse, body, viewerChannels, viewerAccess, titles, join } = tools;
  const schedules = store.schedules;
  const notFound = () => fail(404, 'Not found');
  const uuid = z.string().uuid();

  const rightsOf = (s: ScheduleRecord, channel: Channel | undefined, viewer: Human) => {
    const creator = s.createdBy === viewer.id;
    return { canEdit: creator, canManage: creator || channelAccess(channel, viewer).member };
  };
  function view(s: ScheduleRecord, channels: Map<string, Channel>, viewer: Human, title: (id: string) => string): ScheduleView {
    const { nextEventId: _booked, ...rest } = s;
    return { ...rest, nextAt: s.on ? s.nextAt : null, lastRun: schedules.lastRun(s.id, scheduler.now()), chatTitle: title(s.channelId), ...rightsOf(s, channels.get(s.channelId), viewer) };
  }
  /** A schedule the viewer may act on; someone who cannot read its chat and did not create it gets 404. */
  async function scheduleFor(c: any) {
    if (!uuid.safeParse(c.req.param('id')).success) throw notFound();
    const human = c.get('human') as Human;
    const channels = await viewerChannels(c.req.raw.headers);
    const s = schedules.schedule(c.req.param('id'));
    if (!s || (s.createdBy !== human.id && !channels.has(s.channelId))) throw notFound();
    return { s, human, channels, rights: rightsOf(s, channels.get(s.channelId), human), title: titles(channels, [s.channelId]) };
  }
  const requireAgent = (channel: Channel | undefined, agent: string) => {
    if (agent === switchyard.name) throw fail(400, `${agent} cannot run scheduled work`);
    if (!isAgentIn(channel, agent)) throw fail(409, `Add ${agent} to the chat first`);
  };
  const conflict = (c: any, s: ScheduleRecord, channels: Map<string, Channel>, human: Human) => {
    const current = schedules.schedule(s.id);
    return c.json({ error: 'Schedule changed', current: current && view(current, channels, human, titles(channels, [s.channelId])) }, 409);
  };

  routes.get('/api/flows/schedules', async c => {
    const human = c.get('human');
    const channels = await viewerChannels(c.req.raw.headers);
    const list = schedules.schedulesIn([...channels.keys()]);
    const title = titles(channels, list.map(s => s.channelId));
    // The engine lists future scheduled events in chats the viewer can see; agents' own, not Switchyard's.
    const events = await orgops.humanJson<EngineEvent[]>('/api/events?scheduled=1&limit=200', c.req.raw.headers);
    const agentMade: AgentMadeSchedule[] = events
      .filter(e => e.source.startsWith('agent:') && e.source !== `agent:${switchyard.name}` && e.channelId && typeof e.deliverAt === 'number')
      .map(e => ({ eventId: e.id, channelId: e.channelId!, agent: e.source.slice('agent:'.length), at: e.deliverAt!, text: str(e.payload?.text) }));
    return c.json({ schedules: list.map(s => view(s, channels, human, title)), agentMade, triggers: triggers(channels, human) });
  });

  routes.post('/api/flows/schedules', async c => {
    const input = parse(NewScheduleSchema, await body(c));
    const human = c.get('human');
    const channels = await viewerChannels(c.req.raw.headers);
    const channel = channels.get(input.channelId);
    if (!(await viewerAccess(c.req.raw.headers, human)(channel)).post) throw fail(403, 'You need to be able to post in this chat');
    requireAgent(channel, input.agent);
    const at = scheduler.now();
    const nextAt = nextRunAt(input.rule, input.timezone, at);
    if (nextAt === null) throw fail(400, 'This schedule never runs');
    const existed = schedules.schedule(input.id) !== null;
    // The limits come before Switchyard joins, so a refused schedule changes nothing in the engine.
    if (!existed) schedules.checkLimits(input.channelId, human.id);
    await join([input.channelId]);
    let s: ScheduleRecord;
    try {
      s = schedules.createSchedule({ ...input, createdBy: human.id, now: at, nextAt });
    } catch (error) {
      if (error instanceof CanvasConflictError) throw fail(409, 'Schedule ID already used');
      throw error;
    }
    await scheduler.book(s.id);
    try {
      await switchyard.post({
        channelId: s.channelId, text: `Scheduled · ${ruleText(s.rule)} · ${s.agent}`, target: null,
        kind: 'note', setBy: human.id, idempotencyKey: `nest:note:schedule:${s.id}`, meta: { scheduleId: s.id },
      });
    } catch (error) {
      // The schedule stands without its note; retrying the request posts it.
      console.error('The schedule note could not be posted:', (error as Error).name);
    }
    return c.json(view(schedules.schedule(s.id) ?? s, channels, human, titles(channels, [s.channelId])), existed ? 200 : 201);
  });

  routes.patch('/api/flows/schedules/:id', async c => {
    const { version, ...patch } = parse(SchedulePatchSchema, await body(c));
    const { s, human, channels, rights, title } = await scheduleFor(c);
    const settings = patch.prompt !== undefined || patch.agent !== undefined || patch.rule !== undefined;
    if (settings && !rights.canEdit) throw fail(403, 'Only the person who set up this schedule can change it');
    if (!rights.canManage) throw fail(403, 'Only the person who set up this schedule or a member of the chat can pause it');
    if (patch.agent !== undefined && patch.agent !== s.agent) requireAgent(channels.get(s.channelId), patch.agent);
    if (s.version !== version) return conflict(c, s, channels, human);
    const on = patch.on ?? s.on;
    if (!settings && on === s.on) return c.json(view(s, channels, human, title));
    const nextAt = on ? nextRunAt(patch.rule ?? s.rule, s.timezone, scheduler.now()) : null;
    if (on && nextAt === null) throw fail(400, 'This schedule never runs');
    await scheduler.cancel(s);
    let updated: ScheduleRecord;
    try {
      const result = schedules.patchSchedule(s.id, patch, version, human.id, nextAt);
      updated = result.schedule;
      await scheduler.cancelDropped(s.id, result.dropped);
    } catch (error) {
      if (error instanceof CanvasConflictError) return conflict(c, s, channels, human);
      throw error;
    }
    if (updated.on) await scheduler.book(updated.id);
    return c.json(view(schedules.schedule(updated.id) ?? updated, channels, human, title));
  });

  // Runs already posted stay in the chat; only the schedule and its booked run go.
  routes.delete('/api/flows/schedules/:id', async c => {
    const raw = c.req.query('version');
    const version = Number(raw);
    if (!raw || !Number.isInteger(version) || version < 0) throw fail(400, 'version is required');
    const { s, human, channels, rights } = await scheduleFor(c);
    if (!rights.canManage) throw fail(403, 'Only the person who set up this schedule or a member of the chat can delete it');
    if (s.version !== version) return conflict(c, s, channels, human);
    await scheduler.cancel(s);
    await scheduler.cancelDropped(s.id, schedules.removeSchedule(s.id, human.id));
    return c.body(null, 204);
  });

  routes.post('/api/flows/schedules/:id/run', async c => {
    const { s, human, channels, rights } = await scheduleFor(c);
    const channel = channels.get(s.channelId);
    if (!rights.canManage || !(await viewerAccess(c.req.raw.headers, human)(channel)).post) throw fail(403, 'Only the person who set up this schedule or a member of the chat can start a run');
    if (!isAgentIn(channel, s.agent)) throw fail(409, `Add ${s.agent} to the chat first`);
    return c.json(await scheduler.runNow(s.id, human), 201);
  });
}
