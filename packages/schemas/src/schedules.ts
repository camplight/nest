import { z } from 'zod';

/** A booked run that has not started this long after it was due is missed. */
export const MISSED_GRACE_MS = 600_000;
export const MAX_SCHEDULES_PER_CHAT = 10;
export const MAX_SCHEDULES_PER_CREATOR = 100;
export const MAX_SCHEDULE_PROMPT = 4_000;

/** Days run Monday = 0 … Sunday = 6, as in the mock. */
export const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;
export const DAYL = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a time like 09:00');
const day = z.number().int().min(0).max(6);
const days = z.array(day).min(1).max(7)
  .refine(list => list.every((d, i) => i === 0 || d > list[i - 1]), { message: 'Days must be unique and in order' });

export const ScheduleRuleSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('once'), day, time }).strict(),
  z.object({ kind: z.literal('daily'), time }).strict(),
  z.object({ kind: z.literal('weekdays'), time }).strict(),
  z.object({ kind: z.literal('weekly'), days, time }).strict(),
  z.object({ kind: z.literal('monthly'), dom: z.number().int().min(1).max(28), time }).strict(),
  z.object({ kind: z.literal('interval'), mins: z.number().int().min(5).max(1440) }).strict(),
]);
export type ScheduleRule = z.infer<typeof ScheduleRuleSchema>;
/** Task 13's webhook triggers read like a rule in lists (S5). */
export type RuleLike = ScheduleRule | { kind: 'webhook' };

/** An IANA time zone this runtime knows. `supportedValuesOf` is not used: it leaves out 'UTC' (S3). */
export function isTimeZone(timeZone: string): boolean {
  try { new Intl.DateTimeFormat('en', { timeZone }); return true; } catch { return false; }
}

const prompt = z.string().trim().min(1).max(MAX_SCHEDULE_PROMPT);
const agent = z.string().min(1).max(200);

export const NewScheduleSchema = z.object({
  id: z.string().uuid(),
  channelId: z.string().min(1).max(200),
  agent,
  prompt,
  rule: ScheduleRuleSchema,
  timezone: z.string().min(1).max(64).refine(isTimeZone, { message: 'Unknown time zone' }),
}).strict();
export type NewSchedule = z.infer<typeof NewScheduleSchema>;

export const SchedulePatchSchema = z.object({
  prompt: prompt.optional(),
  agent: agent.optional(),
  rule: ScheduleRuleSchema.optional(),
  on: z.boolean().optional(),
  version: z.number().int().min(0),
}).strict();
export type SchedulePatch = z.infer<typeof SchedulePatchSchema>;

/** Why Nest paused a schedule; null when a person paused it. */
export type SchedulePausedReason = 'access' | 'agent-left' | 'unavailable' | null;
export type MissedReason = 'runner offline' | 'agent stopped' | 'no turn started' | 'engine unavailable';

export type Schedule = {
  id: string; channelId: string; agent: string; prompt: string; rule: ScheduleRule; timezone: string;
  on: boolean; pausedReason: SchedulePausedReason;
  /** The next due time while on; null when paused or when the rule never runs again. */
  nextAt: number | null;
  createdBy: string; createdAt: number; updatedAt: number; version: number;
};
export type ScheduleRun = {
  id: string; scheduleId: string; dueAt: number; eventId: string | null;
  kind: 'scheduled' | 'manual';
  status: 'booked' | 'started' | 'missed' | 'late' | 'superseded';
  reason: MissedReason | null; createdAt: number;
};
/** A schedule as GET /api/flows/schedules lists it. canManage: pause, delete, Run now. canEdit: prompt, agent and rule. */
export type ScheduleView = Schedule & { lastRun: ScheduleRun | null; chatTitle: string; canEdit: boolean; canManage: boolean };
/** A future scheduled event an agent booked itself (engine source `agent:<name>`), listed as `set by <name>`. */
export type AgentMadeSchedule = { eventId: string; channelId: string; agent: string; at: number; text: string };

// ---------------------------------------------------------------------------------------------------------------------
// Time zones. Pure: the only clock is the `after` argument.

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string) {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
    });
    formatters.set(timeZone, f);
  }
  return f;
}
type Wall = { y: number; mo: number; d: number; h: number; mi: number };
function wallAt(t: number, timeZone: string): Wall & { s: number } {
  const parts: Record<string, number> = {};
  for (const p of formatter(timeZone).formatToParts(t)) if (p.type !== 'literal') parts[p.type] = Number(p.value);
  return { y: parts.year, mo: parts.month - 1, d: parts.day, h: parts.hour % 24, mi: parts.minute, s: parts.second };
}
/** The zone's offset from UTC at instant `t`, in ms (wall clock minus UTC). */
function offsetAt(t: number, timeZone: string): number {
  const w = wallAt(t, timeZone);
  return Date.UTC(w.y, w.mo, w.d, w.h, w.mi, w.s) - Math.floor(t / 1000) * 1000;
}

/**
 * The instant a wall-clock time happens in `timeZone`. Offsets are read at the guess and a day either side; of the
 * candidates that really show this wall time, the earliest wins (an ambiguous time runs at its first occurrence). A
 * time that does not exist (a DST gap) moves one hour later.
 */
function wallToUtc(w: Wall, timeZone: string, shifted = false): number {
  const guess = Date.UTC(w.y, w.mo, w.d, w.h, w.mi);
  const offsets = new Set([offsetAt(guess - 86_400_000, timeZone), offsetAt(guess, timeZone), offsetAt(guess + 86_400_000, timeZone)]);
  const valid = [...offsets].map(o => guess - o).filter(t => offsetAt(t, timeZone) === guess - t).sort((a, b) => a - b);
  if (valid.length) return valid[0];
  if (!shifted) return wallToUtc({ ...w, h: w.h + 1 }, timeZone, true);
  return guess - offsetAt(guess - 86_400_000, timeZone);
}

const MAX_DAYS = 400;
/**
 * The first run strictly after `after`, or null when none falls within 400 days. Pure and deterministic: wall-clock
 * candidates in `tz`, day by day from `after`'s local date. `interval` is `after` plus its minutes.
 */
export function nextRunAt(rule: ScheduleRule, tz: string, after: number): number | null {
  if (rule.kind === 'interval') return after + rule.mins * 60_000;
  const [h, mi] = rule.time.split(':').map(Number);
  const start = wallAt(after, tz);
  for (let i = 0; i <= MAX_DAYS; i++) {
    const date = new Date(Date.UTC(start.y, start.mo, start.d + i));
    const weekday = (date.getUTCDay() + 6) % 7;
    const dom = date.getUTCDate();
    const matches = rule.kind === 'daily'
      || (rule.kind === 'weekdays' && weekday < 5)
      || (rule.kind === 'weekly' && rule.days.includes(weekday))
      || (rule.kind === 'monthly' && dom === rule.dom)
      || (rule.kind === 'once' && weekday === rule.day);
    if (!matches) continue;
    const t = wallToUtc({ y: date.getUTCFullYear(), mo: date.getUTCMonth(), d: dom, h, mi }, tz);
    if (t > after) return t;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------------
// Copy, exactly as the mock (excerpt 409-416). `at` is a once rule's run as atText; without it, the rule's own day.

export function ruleText(rule: RuleLike, at?: string): string {
  switch (rule.kind) {
    case 'webhook': return 'When the webhook is called';
    case 'interval': return `Every ${rule.mins} min`;
    case 'daily': return `Every day at ${rule.time}`;
    case 'weekdays': return `Weekdays at ${rule.time}`;
    case 'weekly': return `Every ${rule.days.map(d => DAYL[d]).join(', ') || '…'} at ${rule.time}`;
    case 'monthly': return `Monthly on day ${rule.dom} at ${rule.time}`;
    case 'once': return `Once · ${at ?? `${DAYL[rule.day]} ${rule.time}`}`;
  }
}

export function shortRule(rule: RuleLike, at?: string): string {
  switch (rule.kind) {
    case 'webhook': return 'webhook';
    case 'interval': return `${rule.mins} min`;
    case 'daily': return `Daily ${rule.time}`;
    case 'weekdays': return `Weekdays ${rule.time}`;
    case 'weekly': return `${rule.days.map(d => DAYS[d]).join(' ')} ${rule.time}`;
    case 'monthly': return 'Monthly';
    case 'once': return `Once ${at ?? `${DAYS[rule.day]} ${rule.time}`}`;
  }
}

/** The mock's `rel`: `in N min`, `in N h`, `tomorrow` or `in N days`; `—` without a time. */
export function relTime(t: number | null, now: number): string {
  if (!t) return '—';
  const m = Math.round((t - now) / 60_000);
  if (m < 60) return `in ${m} min`;
  if (m < 60 * 20) return `in ${Math.round(m / 60)} h`;
  const d = Math.round(m / 1440);
  return d <= 1 ? 'tomorrow' : `in ${d} days`;
}

/** The mock's `atTxt` in a time zone: `Mon 09:00`. */
export function atText(t: number, tz: string): string {
  const w = wallAt(t, tz);
  const weekday = (new Date(Date.UTC(w.y, w.mo, w.d)).getUTCDay() + 6) % 7;
  return `${DAYS[weekday]} ${String(w.h).padStart(2, '0')}:${String(w.mi).padStart(2, '0')}`;
}
