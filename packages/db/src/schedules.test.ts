import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { CanvasConflictError, CanvasLimitError, openProductDb } from './index';

let dir: string;
let store: ReturnType<typeof openProductDb>;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'nest-schedules-')); store = openProductDb(join(dir, 'product.sqlite')); });
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
const mk = (channelId: string, extra: Record<string, unknown> = {}) => store.schedules.createSchedule({
  id: randomUUID(), channelId, agent: 'Pip', prompt: 'Recap', rule: { kind: 'daily', time: '09:00' }, timezone: 'UTC',
  createdBy: 'u', now: 1000, nextAt: 5000, ...extra,
});

describe('schedule store', () => {
  it('applies the 015_schedules migration, with the triggers table for webhooks', () => {
    const names = (store.db.prepare('SELECT name FROM product_migrations').all() as { name: string }[]).map(r => r.name);
    expect(names.at(-1)).toBe('015_schedules');
    expect(store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='product_triggers'").get()).toBeTruthy();
  });
  it('creates a schedule, idempotent by id', () => {
    const s = mk('c1');
    expect(s).toMatchObject({ channelId: 'c1', agent: 'Pip', on: true, nextAt: 5000, pausedReason: null, version: 0, rule: { kind: 'daily', time: '09:00' } });
    expect(store.schedules.createSchedule({ id: s.id, channelId: 'c1', agent: 'Pip', prompt: 'Recap', rule: { kind: 'daily', time: '09:00' }, timezone: 'UTC', createdBy: 'u', now: 9, nextAt: 9 })).toEqual(s);
    expect(() => store.schedules.createSchedule({ id: s.id, channelId: 'c1', agent: 'Pom', prompt: 'Recap', rule: { kind: 'daily', time: '09:00' }, timezone: 'UTC', createdBy: 'u', now: 9, nextAt: 9 })).toThrow(CanvasConflictError);
  });
  it('caps schedules at 10 per chat and 100 per creator', () => {
    for (let i = 0; i < 10; i++) mk('hub');
    expect(() => mk('hub')).toThrow(CanvasLimitError);
    for (let i = 0; i < 90; i++) mk(`c${i % 9}`, { createdBy: 'u' });
    expect(() => mk('fresh')).toThrow(CanvasLimitError);
    expect(mk('fresh', { createdBy: 'other' })).toBeTruthy();
  });
  it('keeps one run per (schedule, kind, due_at)', () => {
    const s = mk('c1');
    expect(store.schedules.insertRun({ scheduleId: s.id, dueAt: 5000, kind: 'scheduled', status: 'booked', eventId: 'e1', now: 1 })).not.toBeNull();
    expect(store.schedules.insertRun({ scheduleId: s.id, dueAt: 5000, kind: 'scheduled', status: 'missed', now: 2 })).toBeNull();
    expect(store.schedules.insertRun({ scheduleId: s.id, dueAt: 5000, kind: 'manual', status: 'booked', now: 3 })).not.toBeNull();
  });
  it('removes the runs with their schedule', () => {
    const s = mk('c1');
    store.schedules.insertRun({ scheduleId: s.id, dueAt: 5000, kind: 'scheduled', status: 'missed', reason: 'agent stopped', now: 1 });
    store.schedules.removeSchedule(s.id, 'u');
    expect(store.db.prepare('SELECT COUNT(*) n FROM product_schedule_runs').get()).toEqual({ n: 0 });
  });
  it('books only the schedule as it was read, then moves it on', () => {
    const s = mk('c1');
    expect(store.schedules.unbooked().map(x => x.id)).toEqual([s.id]);
    expect(store.schedules.markBooked(s.id, 4000, 'e0', 2)).toBe(false);
    expect(store.schedules.markBooked(s.id, 5000, 'e1', 2)).toBe(true);
    expect(store.schedules.markBooked(s.id, 5000, 'e2', 2)).toBe(false);
    expect(store.schedules.schedule(s.id)?.nextEventId).toBe('e1');
    expect(store.schedules.runsDue(5000)).toMatchObject([{ scheduleId: s.id, dueAt: 5000, eventId: 'e1', status: 'booked' }]);
    expect(store.schedules.unbooked()).toEqual([]);
    expect(store.schedules.bookedDue(4999)).toEqual([]);
    expect(store.schedules.moveOn(s.id, { nextAt: 5000, eventId: 'e1' }, 9000, false)).toBe(true);
    expect(store.schedules.schedule(s.id)).toMatchObject({ nextAt: 9000, nextEventId: null, on: true });
  });
  it('turns a once schedule off after its run', () => {
    const s = mk('c1', { rule: { kind: 'once', day: 2, time: '10:00' } });
    expect(store.schedules.moveOn(s.id, { nextAt: 5000, eventId: null }, null, true)).toBe(true);
    expect(store.schedules.schedule(s.id)).toMatchObject({ on: false, nextAt: null, pausedReason: null });
  });
  it('lists the newest missed run per schedule for its creator until a later run starts', () => {
    const s = mk('c1');
    const old = store.schedules.insertRun({ scheduleId: s.id, dueAt: 100, kind: 'scheduled', status: 'missed', reason: 'agent stopped', now: 1 })!;
    const newer = store.schedules.insertRun({ scheduleId: s.id, dueAt: 200, kind: 'scheduled', status: 'missed', reason: 'runner offline', now: 2 })!;
    expect(store.schedules.missedFor('u').map(m => m.run.id)).toEqual([newer.id]);
    expect(store.schedules.missedFor('other')).toEqual([]);
    expect(store.schedules.supersedeMissed(s.id)).toBe(2);
    expect(store.schedules.run(old.id)?.status).toBe('superseded');
    expect(store.schedules.missedFor('u')).toEqual([]);
    store.schedules.insertRun({ scheduleId: s.id, dueAt: 300, kind: 'scheduled', status: 'missed', reason: 'agent stopped', now: 3 });
    store.schedules.insertRun({ scheduleId: s.id, dueAt: 400, kind: 'scheduled', status: 'started', now: 4 });
    expect(store.schedules.missedFor('u')).toEqual([]);
  });
  it('settles a run only from the statuses given', () => {
    const s = mk('c1');
    const run = store.schedules.insertRun({ scheduleId: s.id, dueAt: 100, kind: 'scheduled', status: 'booked', eventId: 'e', now: 1 })!;
    expect(store.schedules.settleRun(run.id, 'started', null, ['missed'])).toBe(false);
    expect(store.schedules.settleRun(run.id, 'missed', 'agent stopped', ['booked'])).toBe(true);
    expect(store.schedules.run(run.id)).toMatchObject({ status: 'missed', reason: 'agent stopped' });
    expect(store.schedules.lastRun(s.id, 100)).toMatchObject({ id: run.id });
    expect(store.schedules.lastRun(s.id, 99)).toBeNull();
  });
  it('changes settings by version and records the booking it cancelled', () => {
    const s = mk('c1');
    store.schedules.markBooked(s.id, 5000, 'e1', 2);
    expect(store.schedules.unbook(s.id, 'e1', true)).toBe(true);
    expect(store.schedules.runsDue(10_000)).toEqual([]);
    expect(() => store.schedules.patchSchedule(s.id, { prompt: 'x' }, 7, 'u', 1)).toThrow(CanvasConflictError);
    const p = store.schedules.patchSchedule(s.id, { prompt: 'Weekly recap', on: false }, 0, 'u', null);
    expect(p).toMatchObject({ schedule: { prompt: 'Weekly recap', on: false, nextAt: null, version: 1 }, dropped: null });
    expect(store.schedules.patchSchedule(s.id, { on: true }, 1, 'u', 6000).schedule).toMatchObject({ on: true, nextAt: 6000, version: 2 });
    // Booked meanwhile: the patch reports the event it dropped, and a stale version no longer books.
    expect(store.schedules.markBooked(s.id, 6000, 'e9', 3, 1)).toBe(false);
    expect(store.schedules.markBooked(s.id, 6000, 'e9', 3, 2)).toBe(true);
    expect(store.schedules.patchSchedule(s.id, { prompt: 'Again' }, 2, 'u', 6000).dropped).toBe('e9');
    expect(store.schedules.removeSchedule(s.id, 'u')).toBeNull();
    expect(store.schedules.schedule(s.id)).toBeNull();
  });
  it('lists bookings due soon and the schedules Nest paused', () => {
    const s = mk('c1');
    store.schedules.markBooked(s.id, 5000, 'e1', 2);
    expect(store.schedules.bookedBetween(4000, 5000).map(x => x.id)).toEqual([s.id]);
    expect(store.schedules.bookedBetween(5000, 6000)).toEqual([]);
    expect(store.schedules.pausedFor('u')).toEqual([]);
    store.schedules.pause(s.id, 'agent-left', 'system');
    expect(store.schedules.pausedFor('u')).toEqual([expect.objectContaining({ id: s.id, pausedReason: 'agent-left' })]);
    expect(() => store.schedules.checkLimits('c1', 'u')).not.toThrow();
  });
  it('pauses and resumes', () => {
    const s = mk('c1');
    store.schedules.pause(s.id, 'access', 'system');
    expect(store.schedules.schedule(s.id)).toMatchObject({ on: false, pausedReason: 'access', nextAt: null, version: 1 });
    expect(store.schedules.patchSchedule(s.id, { on: true }, 1, 'u', 7000).schedule).toMatchObject({ on: true, pausedReason: null, nextAt: 7000 });
  });
});
