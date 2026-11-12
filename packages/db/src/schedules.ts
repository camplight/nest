// Schedules and their runs. Rules and ids only; each run is one engine agent.scheduled.trigger, never mirrored here.
import type Database from 'better-sqlite3';
import {
  MAX_SCHEDULES_PER_CHAT, MAX_SCHEDULES_PER_CREATOR, MAX_TRIGGERS_PER_CHAT,
  type MissedReason, type Schedule, type SchedulePausedReason, type ScheduleRule, type ScheduleRun, type Trigger,
} from '../../schemas/src/schedules';
import { CanvasConflictError, CanvasLimitError } from './canvases';

/** A stored schedule with the engine event booked for its next run (null while unbooked). */
export type ScheduleRecord = Schedule & { nextEventId: string | null };
export type NewScheduleRecord = {
  id: string; channelId: string; agent: string; prompt: string; rule: ScheduleRule; timezone: string;
  createdBy: string; now: number; nextAt: number | null;
};

type ScheduleRow = {
  id: string; channel_id: string; agent_name: string; prompt: string; rule_json: string; timezone: string; on_flag: number;
  created_by: string; version: number; next_at: number | null; next_event_id: string | null; paused_reason: SchedulePausedReason;
  created_at: number; updated_at: number;
};
type RunRow = {
  id: string; schedule_id: string; due_at: number; event_id: string | null; kind: ScheduleRun['kind'];
  status: ScheduleRun['status']; reason: MissedReason | null; created_at: number;
};
const toSchedule = (r: ScheduleRow): ScheduleRecord => ({
  id: r.id, channelId: r.channel_id, agent: r.agent_name, prompt: r.prompt, rule: JSON.parse(r.rule_json) as ScheduleRule,
  timezone: r.timezone, on: r.on_flag === 1, pausedReason: r.paused_reason, nextAt: r.next_at, nextEventId: r.next_event_id,
  createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at, version: r.version,
});
/** A new webhook trigger: the token's sha256 (hex) and its last 4 characters only, never the token. */
export type NewTriggerRecord = {
  id: string; channelId: string; agent: string; prompt: string; label: string;
  tokenHash: string; tokenHint: string; createdBy: string; now: number;
};
type TriggerRow = {
  id: string; channel_id: string; agent_name: string; prompt: string; label: string; token_hash: string; token_hint: string;
  on_flag: number; created_by: string; version: number; last_at: number | null; created_at: number; rotated_at: number;
  paused_reason: SchedulePausedReason; updated_at: number;
};
const toTrigger = (r: TriggerRow): Trigger => ({
  id: r.id, channelId: r.channel_id, agent: r.agent_name, prompt: r.prompt, label: r.label, on: r.on_flag === 1,
  pausedReason: r.paused_reason, tokenHint: r.token_hint, lastAt: r.last_at, createdBy: r.created_by,
  createdAt: r.created_at, rotatedAt: r.rotated_at, updatedAt: r.updated_at || r.created_at, version: r.version,
});
const toRun = (r: RunRow): ScheduleRun => ({
  id: r.id, scheduleId: r.schedule_id, dueAt: r.due_at, eventId: r.event_id, kind: r.kind, status: r.status, reason: r.reason, createdAt: r.created_at,
});

export function createScheduleStore(db: Database.Database, clock: () => number = Date.now) {
  function audit(verb: string, actor: string, payload: Record<string, string | number | boolean | null>) {
    db.prepare('INSERT INTO product_audit(type,actor_id,payload_json,created_at) VALUES (?,?,?,?)').run(`audit.flows.${verb}`, actor, JSON.stringify(payload), clock());
  }
  const raw = (id: string) => db.prepare('SELECT * FROM product_schedules WHERE id=?').get(id) as ScheduleRow | undefined;
  const schedule = (id: string): ScheduleRecord | null => { const r = raw(id); return r ? toSchedule(r) : null; };
  const count = (column: 'channel_id' | 'created_by', value: string) =>
    (db.prepare(`SELECT COUNT(*) n FROM product_schedules WHERE ${column}=?`).get(value) as { n: number }).n;

  /** Throws CanvasLimitError when the chat (10) or the creator (100) has no room for another schedule. */
  function checkLimits(channelId: string, createdBy: string): void {
    if (count('channel_id', channelId) >= MAX_SCHEDULES_PER_CHAT) throw new CanvasLimitError(`A chat can have at most ${MAX_SCHEDULES_PER_CHAT} schedules`);
    if (count('created_by', createdBy) >= MAX_SCHEDULES_PER_CREATOR) throw new CanvasLimitError(`You can have at most ${MAX_SCHEDULES_PER_CREATOR} schedules`);
  }

  /** A retry with the same id and settings returns the stored schedule; the same id with other settings is a conflict. */
  function createSchedule(input: NewScheduleRecord): ScheduleRecord {
    return db.transaction(() => {
      const same = raw(input.id);
      if (same) {
        const s = toSchedule(same);
        if (s.channelId === input.channelId && s.agent === input.agent && s.prompt === input.prompt && s.timezone === input.timezone
          && s.createdBy === input.createdBy && JSON.stringify(s.rule) === JSON.stringify(input.rule)) return s;
        throw new CanvasConflictError(null);
      }
      checkLimits(input.channelId, input.createdBy);
      db.prepare('INSERT INTO product_schedules(id,channel_id,agent_name,prompt,rule_json,timezone,on_flag,created_by,version,next_at,next_event_id,paused_reason,created_at,updated_at) VALUES (?,?,?,?,?,?,1,?,0,?,NULL,NULL,?,?)')
        .run(input.id, input.channelId, input.agent, input.prompt, JSON.stringify(input.rule), input.timezone, input.createdBy, input.nextAt, input.now, input.now);
      audit('schedule-created', input.createdBy, { scheduleId: input.id, channelId: input.channelId, kind: input.rule.kind });
      return schedule(input.id)!;
    })();
  }

  function schedulesIn(channelIds: string[]): ScheduleRecord[] {
    if (!channelIds.length) return [];
    return (db.prepare(`SELECT * FROM product_schedules WHERE channel_id IN (${channelIds.map(() => '?').join(',')}) ORDER BY created_at, id`).all(...channelIds) as ScheduleRow[]).map(toSchedule);
  }
  /** Schedules that are on and have a next time but no engine event yet. */
  const unbooked = (): ScheduleRecord[] =>
    (db.prepare('SELECT * FROM product_schedules WHERE on_flag=1 AND next_at IS NOT NULL AND next_event_id IS NULL ORDER BY next_at, id').all() as ScheduleRow[]).map(toSchedule);
  /** Schedules whose booked run is due by `at`: time to move on to the next one. */
  const bookedDue = (at: number): ScheduleRecord[] =>
    (db.prepare('SELECT * FROM product_schedules WHERE next_event_id IS NOT NULL AND next_at<=? ORDER BY next_at, id').all(at) as ScheduleRow[]).map(toSchedule);

  /** Booked schedules due after `from` and by `to`. */
  const bookedBetween = (from: number, to: number): ScheduleRecord[] =>
    (db.prepare('SELECT * FROM product_schedules WHERE next_event_id IS NOT NULL AND next_at>? AND next_at<=? ORDER BY next_at, id').all(from, to) as ScheduleRow[]).map(toSchedule);
  /** The creator's schedules that Nest paused (a reason is set), oldest change first. */
  const pausedFor = (createdBy: string): ScheduleRecord[] =>
    (db.prepare('SELECT * FROM product_schedules WHERE created_by=? AND on_flag=0 AND paused_reason IS NOT NULL ORDER BY updated_at, id').all(createdBy) as ScheduleRow[]).map(toSchedule);

  /**
   * Records the engine event booked for `nextAt`, with its `booked` run, only while the schedule is still on, still
   * due at `nextAt`, unbooked and (given `version`) unchanged. False when a person paused, changed or removed it meanwhile.
   */
  function markBooked(id: string, nextAt: number, eventId: string, now: number, version?: number): boolean {
    return db.transaction(() => {
      const changed = db.prepare(`UPDATE product_schedules SET next_event_id=? WHERE id=? AND on_flag=1 AND next_at=? AND next_event_id IS NULL${version === undefined ? '' : ' AND version=?'}`)
        .run(eventId, id, nextAt, ...(version === undefined ? [] : [version])).changes;
      if (!changed) return false;
      db.prepare(`INSERT INTO product_schedule_runs(id,schedule_id,due_at,event_id,kind,status,reason,created_at) VALUES (?,?,?,?, 'scheduled','booked',NULL,?)
        ON CONFLICT(schedule_id,kind,due_at) DO UPDATE SET event_id=excluded.event_id WHERE status='booked'`).run(crypto.randomUUID(), id, nextAt, eventId, now);
      return true;
    })();
  }

  /**
   * Moves a schedule to its next time once its current one is done (`expected.eventId` booked) or could not be booked
   * (`expected.eventId` null). `off` turns a once schedule off. False when the schedule changed meanwhile.
   */
  function moveOn(id: string, expected: { nextAt: number; eventId: string | null }, nextAt: number | null, off: boolean): boolean {
    const booking = expected.eventId === null ? 'next_event_id IS NULL' : 'next_event_id=?';
    return db.prepare(`UPDATE product_schedules SET next_at=?,next_event_id=NULL,on_flag=CASE WHEN ? THEN 0 ELSE on_flag END,updated_at=? WHERE id=? AND next_at=? AND ${booking}`)
      .run(nextAt, off ? 1 : 0, clock(), id, expected.nextAt, ...(expected.eventId === null ? [] : [expected.eventId])).changes > 0;
  }

  /** Forgets a booking after its engine event was cancelled (`dropRun`: the run never happens) or was already due. */
  function unbook(id: string, eventId: string, dropRun: boolean): boolean {
    return db.transaction(() => {
      const changed = db.prepare('UPDATE product_schedules SET next_event_id=NULL WHERE id=? AND next_event_id=?').run(id, eventId).changes;
      if (dropRun) db.prepare("DELETE FROM product_schedule_runs WHERE schedule_id=? AND event_id=? AND status='booked'").run(id, eventId);
      return changed > 0;
    })();
  }

  /**
   * Settings, or on/off, by version. Turning on clears the paused reason. `nextAt` is the next time to book (computed
   * by the caller from now); the booking should already be cancelled. `dropped` is an engine event booked meanwhile,
   * which the caller cancels.
   */
  function patchSchedule(id: string, patch: { prompt?: string; agent?: string; rule?: ScheduleRule; on?: boolean }, version: number, actor: string, nextAt: number | null): { schedule: ScheduleRecord; dropped: string | null } {
    return db.transaction(() => {
      const before = raw(id);
      if (!before || before.version !== version) throw new CanvasConflictError(null);
      const on = patch.on ?? before.on_flag === 1;
      db.prepare('UPDATE product_schedules SET prompt=?,agent_name=?,rule_json=?,on_flag=?,paused_reason=?,next_at=?,next_event_id=NULL,updated_at=?,version=version+1 WHERE id=? AND version=?')
        .run(patch.prompt ?? before.prompt, patch.agent ?? before.agent_name, patch.rule ? JSON.stringify(patch.rule) : before.rule_json,
          on ? 1 : 0, on ? null : before.paused_reason, on ? nextAt : null, clock(), id, version);
      audit('schedule-updated', actor, { scheduleId: id, on });
      return { schedule: schedule(id)!, dropped: before.next_event_id };
    })();
  }

  /** Nest pauses a schedule it cannot run: the creator lost access, the agent left, or the chat is gone. */
  function pause(id: string, reason: Exclude<SchedulePausedReason, null>, actor: string): void {
    const changed = db.prepare('UPDATE product_schedules SET on_flag=0,paused_reason=?,next_at=NULL,updated_at=?,version=version+1 WHERE id=? AND on_flag=1').run(reason, clock(), id).changes;
    if (changed) audit('schedule-paused', actor, { scheduleId: id, reason });
  }

  /** Removes a schedule with its runs. Returns an engine event still booked for it, which the caller cancels. */
  function removeSchedule(id: string, actor: string): string | null {
    return db.transaction(() => {
      const before = raw(id);
      if (!before) return null;
      db.prepare('DELETE FROM product_schedules WHERE id=?').run(id);
      audit('schedule-removed', actor, { scheduleId: id });
      return before.next_event_id;
    })();
  }

  // Runs ----------------------------------------------------------------------------------------------------------------

  const run = (id: string): ScheduleRun | null => { const r = db.prepare('SELECT * FROM product_schedule_runs WHERE id=?').get(id) as RunRow | undefined; return r ? toRun(r) : null; };

  /** A new run, or null when this schedule already has one of that kind at that time. */
  function insertRun(input: { id?: string; scheduleId: string; dueAt: number; kind: ScheduleRun['kind']; status: ScheduleRun['status']; eventId?: string | null; reason?: MissedReason | null; now: number }): ScheduleRun | null {
    const id = input.id ?? crypto.randomUUID();
    const inserted = db.prepare('INSERT OR IGNORE INTO product_schedule_runs(id,schedule_id,due_at,event_id,kind,status,reason,created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, input.scheduleId, input.dueAt, input.eventId ?? null, input.kind, input.status, input.reason ?? null, input.now).changes;
    return inserted ? run(id) : null;
  }
  const setRunEvent = (id: string, eventId: string): void => { db.prepare('UPDATE product_schedule_runs SET event_id=? WHERE id=?').run(eventId, id); };
  const deleteRun = (id: string): void => { db.prepare('DELETE FROM product_schedule_runs WHERE id=?').run(id); };

  /** Booked runs that are due by `at`, waiting to be seen to start (or to be missed). */
  const runsDue = (at: number): ScheduleRun[] =>
    (db.prepare("SELECT * FROM product_schedule_runs WHERE status='booked' AND due_at<=? ORDER BY due_at, id").all(at) as RunRow[]).map(toRun);
  /** Missed runs with an engine event, due since `since`: a turn may still start late. */
  const missedSince = (since: number): ScheduleRun[] =>
    (db.prepare("SELECT * FROM product_schedule_runs WHERE status='missed' AND event_id IS NOT NULL AND due_at>=? ORDER BY due_at, id").all(since) as RunRow[]).map(toRun);
  /** The due time of this schedule's next run after `dueAt`, of either kind; null when there is none yet. */
  const runAfter = (scheduleId: string, dueAt: number): number | null =>
    (db.prepare("SELECT MIN(due_at) t FROM product_schedule_runs WHERE schedule_id=? AND due_at>? AND status!='superseded'").get(scheduleId, dueAt) as { t: number | null }).t;

  /** Settles a run that is still in one of `from`; false otherwise. */
  function settleRun(id: string, status: ScheduleRun['status'], reason: MissedReason | null, from: ScheduleRun['status'][]): boolean {
    return db.prepare(`UPDATE product_schedule_runs SET status=?,reason=? WHERE id=? AND status IN (${from.map(() => '?').join(',')})`)
      .run(status, reason, id, ...from).changes > 0;
  }
  /** Run now replaces every missed run of the schedule. */
  const supersedeMissed = (scheduleId: string): number =>
    db.prepare("UPDATE product_schedule_runs SET status='superseded' WHERE schedule_id=? AND status='missed'").run(scheduleId).changes;

  /** The newest run due by `at`, of either kind, except superseded ones. */
  const lastRun = (scheduleId: string, at: number): ScheduleRun | null => {
    const r = db.prepare("SELECT * FROM product_schedule_runs WHERE schedule_id=? AND due_at<=? AND status!='superseded' ORDER BY due_at DESC, created_at DESC LIMIT 1").get(scheduleId, at) as RunRow | undefined;
    return r ? toRun(r) : null;
  };

  /** Each of the creator's schedules whose newest settled run is missed: its newest missed run, for Needs you. */
  function missedFor(createdBy: string): { run: ScheduleRun; schedule: ScheduleRecord }[] {
    const rows = db.prepare(`SELECT r.* FROM product_schedule_runs r JOIN product_schedules s ON s.id=r.schedule_id
      WHERE s.created_by=? AND r.status='missed'
        AND NOT EXISTS (SELECT 1 FROM product_schedule_runs o WHERE o.schedule_id=r.schedule_id AND o.due_at>r.due_at AND o.status IN ('missed','started','late'))
      ORDER BY r.due_at, r.id`).all(createdBy) as RunRow[];
    return rows.map(r => ({ run: toRun(r), schedule: schedule(r.schedule_id)! }));
  }

  // Webhook triggers ------------------------------------------------------------------------------------------------------

  const rawTrigger = (id: string) => db.prepare('SELECT * FROM product_triggers WHERE id=?').get(id) as TriggerRow | undefined;
  const trigger = (id: string): Trigger | null => { const r = rawTrigger(id); return r ? toTrigger(r) : null; };

  /** Throws CanvasLimitError when the chat already has 5 webhook triggers. */
  function checkTriggerLimit(channelId: string): void {
    const n = (db.prepare('SELECT COUNT(*) n FROM product_triggers WHERE channel_id=?').get(channelId) as { n: number }).n;
    if (n >= MAX_TRIGGERS_PER_CHAT) throw new CanvasLimitError(`A chat can have at most ${MAX_TRIGGERS_PER_CHAT} webhooks`);
  }

  /**
   * A new trigger holding only the token's hash and hint. A retry by the same creator with the same settings is a
   * rotation (the first answer, and its URL, may never have arrived): it returns the trigger with `rotated: true`.
   * The same id with other settings is a conflict.
   */
  function createTrigger(input: NewTriggerRecord): { trigger: Trigger; rotated: boolean } {
    return db.transaction(() => {
      const same = rawTrigger(input.id);
      if (same) {
        const t = toTrigger(same);
        if (t.channelId !== input.channelId || t.agent !== input.agent || t.prompt !== input.prompt || t.label !== input.label || t.createdBy !== input.createdBy) {
          throw new CanvasConflictError(null);
        }
        return { trigger: rotateTrigger(input.id, input.tokenHash, input.tokenHint, input.now, input.createdBy)!, rotated: true };
      }
      checkTriggerLimit(input.channelId);
      db.prepare('INSERT INTO product_triggers(id,channel_id,agent_name,prompt,label,token_hash,token_hint,on_flag,created_by,version,last_at,created_at,rotated_at,paused_reason,updated_at) VALUES (?,?,?,?,?,?,?,1,?,0,NULL,?,?,NULL,?)')
        .run(input.id, input.channelId, input.agent, input.prompt, input.label, input.tokenHash, input.tokenHint, input.createdBy, input.now, input.now, input.now);
      audit('trigger-created', input.createdBy, { triggerId: input.id, channelId: input.channelId });
      return { trigger: trigger(input.id)!, rotated: false };
    })();
  }

  /** The trigger whose token hashes to `tokenHash`, on or off; null for none. */
  const triggerByHash = (tokenHash: string): Trigger | null => {
    const r = db.prepare('SELECT * FROM product_triggers WHERE token_hash=?').get(tokenHash) as TriggerRow | undefined;
    return r ? toTrigger(r) : null;
  };
  function triggersIn(channelIds: string[]): Trigger[] {
    if (!channelIds.length) return [];
    return (db.prepare(`SELECT * FROM product_triggers WHERE channel_id IN (${channelIds.map(() => '?').join(',')}) ORDER BY created_at, id`).all(...channelIds) as TriggerRow[]).map(toTrigger);
  }
  /** The creator's triggers that Nest paused (a reason is set), oldest change first. */
  const pausedTriggersFor = (createdBy: string): Trigger[] =>
    (db.prepare('SELECT * FROM product_triggers WHERE created_by=? AND on_flag=0 AND paused_reason IS NOT NULL ORDER BY updated_at, id').all(createdBy) as TriggerRow[]).map(toTrigger);

  /** A new token hash and hint; the old hash stops matching in the same write. Null when the trigger is gone. */
  function rotateTrigger(id: string, tokenHash: string, tokenHint: string, now: number, actor: string): Trigger | null {
    const changed = db.prepare('UPDATE product_triggers SET token_hash=?,token_hint=?,rotated_at=?,updated_at=? WHERE id=?').run(tokenHash, tokenHint, now, now, id).changes;
    if (!changed) return null;
    audit('trigger-rotated', actor, { triggerId: id });
    return trigger(id);
  }

  /** Settings, or on/off, by version. Turning on clears the paused reason. Throws CanvasConflictError on a stale version. */
  function patchTrigger(id: string, patch: { prompt?: string; agent?: string; label?: string; on?: boolean }, version: number, actor: string): Trigger {
    return db.transaction(() => {
      const before = rawTrigger(id);
      if (!before || before.version !== version) throw new CanvasConflictError(null);
      const on = patch.on ?? before.on_flag === 1;
      db.prepare('UPDATE product_triggers SET prompt=?,agent_name=?,label=?,on_flag=?,paused_reason=?,updated_at=?,version=version+1 WHERE id=? AND version=?')
        .run(patch.prompt ?? before.prompt, patch.agent ?? before.agent_name, patch.label ?? before.label, on ? 1 : 0, on ? null : before.paused_reason, clock(), id, version);
      audit('trigger-updated', actor, { triggerId: id, on });
      return trigger(id)!;
    })();
  }

  /** Nest pauses a trigger it cannot run: the creator lost post access, the agent left, or the chat is gone. */
  function pauseTrigger(id: string, reason: Exclude<SchedulePausedReason, null>, actor: string): boolean {
    const changed = db.prepare('UPDATE product_triggers SET on_flag=0,paused_reason=?,updated_at=?,version=version+1 WHERE id=? AND on_flag=1').run(reason, clock(), id).changes;
    if (changed) audit('trigger-paused', actor, { triggerId: id, reason });
    return changed > 0;
  }

  /** A call posted at `at`. */
  const touchTrigger = (id: string, at: number): void => { db.prepare('UPDATE product_triggers SET last_at=? WHERE id=?').run(at, id); };

  function removeTrigger(id: string, actor: string): boolean {
    const changed = db.prepare('DELETE FROM product_triggers WHERE id=?').run(id).changes;
    if (changed) audit('trigger-removed', actor, { triggerId: id });
    return changed > 0;
  }

  return {
    createSchedule, checkLimits, schedule, schedulesIn, unbooked, bookedDue, bookedBetween, pausedFor, markBooked, moveOn, unbook, patchSchedule, pause, removeSchedule,
    run, insertRun, setRunEvent, deleteRun, runsDue, missedSince, runAfter, settleRun, supersedeMissed, lastRun, missedFor,
    trigger, checkTriggerLimit, createTrigger, triggerByHash, triggersIn, pausedTriggersFor, rotateTrigger, patchTrigger, pauseTrigger, touchTrigger, removeTrigger,
  };
}
export type ScheduleStore = ReturnType<typeof createScheduleStore>;
