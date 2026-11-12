// Scheduled jobs as the canvas shows them (the mock's SCHED rows, read by schedBadge, schedStrip, the Setup chip, the
// top-bar count and renderSchedList): the viewer's schedules and webhooks from GET /api/flows/schedules and the runs agents
// booked themselves, in one shape. Pure: the clock is an argument.
import {atText,relTime,ruleText,shortRule,type AgentMadeSchedule,type ScheduleView,type TriggerView} from '@nest/schemas';

export type ScheduleJob = {
  key: string;
  channelId: string;
  /** Who does it. */
  agent: string;
  /** `ruleText`: `Every Monday, Wednesday at 09:00`. */
  text: string;
  /** `shortRule`: `Mon Wed 09:00`. */
  short: string;
  /** `set by {name}`: a person other than the viewer, or the agent that booked its own run; null for the viewer's own. */
  setBy: string | null;
  on: boolean;
  /** The next run while on; null when paused or when nothing is booked. */
  next: number | null;
  /** The zone its times are shown in: the schedule's own, or the browser's for an agent's run. */
  tz: string;
  /** Its newest settled run was missed: when (`Mon 09:00`) and why. */
  missed: {at: string; reason: string} | null;
  /** Its newest settled run started (on time or late): when. */
  lastOk: string | null;
  /** The Nest schedule (with canEdit and canManage); null for a webhook and for an agent's own run (read-only, mockup deviation 8). */
  schedule: ScheduleView | null;
  /** The webhook (with canEdit and canManage); its job has no next run and is listed under `Starts when something happens`. */
  trigger?: TriggerView;
  /** A webhook's name (what calls it), shown after its rule so two webhooks in a chat can be told apart. */
  label?: string;
};

/** Every job, Nest's schedules first in the server's order, then its webhooks, then agents' runs by time. */
export function scheduleJobs({schedules, agentMade, triggers = [], viewerId, names, tz}: {
  schedules: readonly ScheduleView[]; agentMade: readonly AgentMadeSchedule[]; triggers?: readonly TriggerView[]; viewerId: string;
  /** Usernames by human id, for `set by {creator}`. */
  names: ReadonlyMap<string, string>;
  /** The browser's time zone. */
  tz: string;
}): ScheduleJob[] {
  const own = schedules.map((s): ScheduleJob => {
    const last = s.lastRun;
    return {
      key: s.id, channelId: s.channelId, agent: s.agent, text: ruleText(s.rule), short: shortRule(s.rule),
      setBy: s.createdBy === viewerId ? null : names.get(s.createdBy) ?? 'someone else',
      on: s.on, next: s.on ? s.nextAt : null, tz: s.timezone,
      missed: last?.status === 'missed' ? {at: atText(last.dueAt, s.timezone), reason: last.reason ?? 'no turn started'} : null,
      lastOk: last && (last.status === 'started' || last.status === 'late') ? atText(last.dueAt, s.timezone) : null,
      schedule: s,
    };
  });
  const hooks = triggers.map((t): ScheduleJob => ({
    key: `hook:${t.id}`, channelId: t.channelId, agent: t.agent, text: ruleText({kind: 'webhook'}), short: shortRule({kind: 'webhook'}),
    setBy: t.createdBy === viewerId ? null : names.get(t.createdBy) ?? 'someone else',
    on: t.on, next: null, tz, missed: null, lastOk: t.lastAt === null ? null : atText(t.lastAt, tz),
    schedule: null, trigger: t, label: t.label,
  }));
  const agents = [...agentMade].sort((a, b) => a.at - b.at).map((e): ScheduleJob => {
    const at = atText(e.at, tz);
    return {
      key: `agent:${e.eventId}`, channelId: e.channelId, agent: e.agent, text: `Once · ${at}`, short: `Once ${at}`,
      setBy: e.agent, on: true, next: e.at, tz, missed: null, lastOk: null, schedule: null,
    };
  });
  return [...own, ...hooks, ...agents];
}

/** Jobs by chat. A chat whose jobs read the same as before keeps its previous array, so its memoized card does not re-render. */
export function jobsByChannel(jobs: readonly ScheduleJob[], previous?: ReadonlyMap<string, readonly ScheduleJob[]>): Map<string, readonly ScheduleJob[]> {
  const grouped = new Map<string, ScheduleJob[]>();
  for (const job of jobs) {
    const list = grouped.get(job.channelId);
    if (list) list.push(job); else grouped.set(job.channelId, [job]);
  }
  const result = new Map<string, readonly ScheduleJob[]>();
  for (const [channelId, list] of grouped) {
    const old = previous?.get(channelId);
    result.set(channelId, old && JSON.stringify(old) === JSON.stringify(list) ? old : list);
  }
  return result;
}

/** The mock's schedBadge: the first missed job, else the first live one, else the first; `+N` for the rest. */
export function badgeOf(jobs: readonly ScheduleJob[]): {kind: 'missed' | 'on' | 'off'; text: string; title: string} | null {
  if (!jobs.length) return null;
  const job = jobs.find(j => j.missed) ?? jobs.find(j => j.on) ?? jobs[0];
  const more = jobs.length - 1;
  return {
    kind: job.missed ? 'missed' : job.on ? 'on' : 'off',
    text: `${job.missed ? 'missed' : job.short}${more ? ` +${more}` : ''}`,
    title: `${job.text}${more ? ` (+${more} more)` : ''}`,
  };
}

/** The Setup line's chip (the mock's cfgBlock): `missed run` when any job missed, else the first job's short rule. */
export function setupChip(jobs: readonly ScheduleJob[]): {text: string; warn: boolean} | null {
  if (!jobs.length) return null;
  const warn = jobs.some(j => j.missed);
  return {text: warn ? 'missed run' : jobs[0].short, warn};
}

/** The strip's state after the agent: `next in 3 days`, `waiting for it` or `paused`. */
export function stripState(job: ScheduleJob, now: number): string {
  return job.on ? job.next ? `next ${relTime(job.next, now)}` : 'waiting for it' : 'paused';
}

/** The top-bar count (the mock's renderSchedCount): `N missed` (coral) when any missed, else how many are live. */
export function scheduledCount(jobs: readonly ScheduleJob[]): {text: string; hot: boolean} {
  const missed = jobs.filter(j => j.missed).length;
  return missed ? {text: `${missed} missed`, hot: true} : {text: String(jobs.filter(j => j.on).length), hot: false};
}

export type ListFilter = 'all' | 'agents';
export type ListGroup = {title: string; jobs: ScheduleJob[]};
const DAY_MS = 864e5;
/** The mock's renderSchedList groups, empty ones left out: Missed, Starts when something happens, Next 24 hours, Later, Paused. */
export function listGroups(jobs: readonly ScheduleJob[], filter: ListFilter, now: number): ListGroup[] {
  const shown = jobs.filter(j => filter === 'all' || isAgentMade(j));
  const missed = shown.filter(j => j.missed);
  const paused = shown.filter(j => !j.on && !j.missed);
  const live = shown.filter(j => j.on && !j.missed);
  const timed = live.filter(j => j.next !== null).sort((a, b) => a.next! - b.next!);
  return [
    {title: 'Missed', jobs: missed},
    {title: 'Starts when something happens', jobs: live.filter(j => j.next === null)},
    {title: 'Next 24 hours', jobs: timed.filter(j => j.next! - now < DAY_MS)},
    {title: 'Later', jobs: timed.filter(j => j.next! - now >= DAY_MS)},
    {title: 'Paused', jobs: paused},
  ].filter(group => group.jobs.length);
}
/** An agent's own booked run: neither a Nest schedule nor a webhook. */
export const isAgentMade = (job: ScheduleJob) => job.schedule === null && !job.trigger;
/** How many the `Set by agents` filter shows. */
export const agentMadeCount = (jobs: readonly ScheduleJob[]) => jobs.filter(isAgentMade).length;

/** A row's `when` column: bold first line, then the second. */
export function rowWhen(job: ScheduleJob, now: number): [string, string] {
  if (job.missed) return [`Missed ${job.missed.at}`, job.missed.reason];
  if (!job.on) return ['Paused', ''];
  if (job.next !== null) return [atText(job.next, job.tz), relTime(job.next, now)];
  return ['On event', job.lastOk ? `last ${job.lastOk}` : 'waiting'];
}
