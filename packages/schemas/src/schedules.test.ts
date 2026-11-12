import { describe, expect, it } from 'vitest';
import {
  MAX_SCHEDULES_PER_CHAT, MAX_SCHEDULES_PER_CREATOR, MISSED_GRACE_MS, NewScheduleSchema, ScheduleRuleSchema, SchedulePatchSchema,
  atText, isTimeZone, nextRunAt, parseScheduleText, relTime, ruleText, shortRule, type ScheduleRule,
} from './schedules';

const id = '11111111-1111-4111-8111-111111111111';
const MIN = 60_000;

describe('nextRunAt', () => {
  it('runs weekly Monday 09:00 in Sofia at 07:00 UTC before DST and 06:00 UTC after (Review Focus 4)', () => {
    const rule: ScheduleRule = { kind: 'weekly', days: [0], time: '09:00' };
    expect(nextRunAt(rule, 'Europe/Sofia', Date.UTC(2026, 2, 23, 6))).toBe(Date.UTC(2026, 2, 23, 7));
    expect(nextRunAt(rule, 'Europe/Sofia', Date.UTC(2026, 2, 23, 8))).toBe(Date.UTC(2026, 2, 30, 6));
  });
  it('moves a time in the DST gap one hour later and takes the first of an ambiguous time (Review Focus 4)', () => {
    const rule: ScheduleRule = { kind: 'daily', time: '03:30' };
    expect(nextRunAt(rule, 'Europe/Sofia', Date.UTC(2026, 2, 28, 23))).toBe(Date.UTC(2026, 2, 29, 1, 30));
    expect(nextRunAt(rule, 'Europe/Sofia', Date.UTC(2026, 9, 24, 23))).toBe(Date.UTC(2026, 9, 25, 0, 30));
  });
  it('skips the weekend for weekdays', () => {
    // Friday 2026-11-13, 18:00 UTC.
    expect(nextRunAt({ kind: 'weekdays', time: '08:00' }, 'UTC', Date.UTC(2026, 10, 13, 18))).toBe(Date.UTC(2026, 10, 16, 8));
  });
  it('runs monthly on its day of the month', () => {
    expect(nextRunAt({ kind: 'monthly', dom: 1, time: '09:00' }, 'UTC', Date.UTC(2026, 0, 31, 12))).toBe(Date.UTC(2026, 1, 1, 9));
  });
  it('adds the interval to the time it is given', () => {
    const after = Date.UTC(2026, 10, 11, 11, 7, 3);
    expect(nextRunAt({ kind: 'interval', mins: 15 }, 'Europe/Sofia', after)).toBe(after + 900_000);
  });
  it('moves a once rule already past this week to the next week', () => {
    // Wednesday 2026-11-11, 11:00 UTC; the rule is Wednesday 10:00.
    expect(nextRunAt({ kind: 'once', day: 2, time: '10:00' }, 'UTC', Date.UTC(2026, 10, 11, 11))).toBe(Date.UTC(2026, 10, 18, 10));
    expect(nextRunAt({ kind: 'once', day: 2, time: '12:00' }, 'UTC', Date.UTC(2026, 10, 11, 11))).toBe(Date.UTC(2026, 10, 11, 12));
  });
  it('is strictly after the time it is given', () => {
    expect(nextRunAt({ kind: 'daily', time: '09:00' }, 'UTC', Date.UTC(2026, 10, 11, 9))).toBe(Date.UTC(2026, 10, 12, 9));
  });
});

describe('rule copy (mock excerpt 409-416)', () => {
  const cases: [ScheduleRule | { kind: 'webhook' }, string, string][] = [
    [{ kind: 'interval', mins: 30 }, 'Every 30 min', '30 min'],
    [{ kind: 'daily', time: '07:30' }, 'Every day at 07:30', 'Daily 07:30'],
    [{ kind: 'weekdays', time: '08:00' }, 'Weekdays at 08:00', 'Weekdays 08:00'],
    [{ kind: 'weekly', days: [0, 4], time: '09:00' }, 'Every Monday, Friday at 09:00', 'Mon Fri 09:00'],
    [{ kind: 'monthly', dom: 3, time: '10:00' }, 'Monthly on day 3 at 10:00', 'Monthly'],
    [{ kind: 'once', day: 2, time: '10:00' }, 'Once · Wednesday 10:00', 'Once Wed 10:00'],
    [{ kind: 'webhook' }, 'When the webhook is called', 'webhook'],
  ];
  it.each(cases)('%j reads "%s" and "%s"', (rule, text, short) => {
    expect(ruleText(rule)).toBe(text);
    expect(shortRule(rule)).toBe(short);
  });
  it('uses the given run time for a once rule', () => {
    expect(ruleText({ kind: 'once', day: 2, time: '10:00' }, 'Wed 10:00')).toBe('Once · Wed 10:00');
    expect(shortRule({ kind: 'once', day: 2, time: '10:00' }, 'Thu 09:15')).toBe('Once Thu 09:15');
  });
  it('reads relative and absolute times like the mock', () => {
    const now = Date.UTC(2026, 10, 11, 9);
    expect(relTime(now + 5 * MIN, now)).toBe('in 5 min');
    expect(relTime(now + 3 * 60 * MIN, now)).toBe('in 3 h');
    expect(relTime(now + 22 * 60 * MIN, now)).toBe('tomorrow');
    expect(relTime(now + 3 * 1440 * MIN, now)).toBe('in 3 days');
    expect(relTime(null, now)).toBe('—');
    expect(atText(Date.UTC(2026, 2, 30, 6), 'Europe/Sofia')).toBe('Mon 09:00');
    expect(atText(Date.UTC(2026, 10, 15, 23, 5), 'UTC')).toBe('Sun 23:05');
  });
});

describe('schedule schemas', () => {
  const base = { id, channelId: 'c1', agent: 'Pip', prompt: 'Recap the week', rule: { kind: 'daily', time: '09:00' }, timezone: 'Europe/Sofia' };
  it('accepts every rule kind and UTC', () => {
    for (const rule of [
      { kind: 'once', day: 6, time: '23:59' }, { kind: 'daily', time: '00:00' }, { kind: 'weekdays', time: '08:00' },
      { kind: 'weekly', days: [0, 1, 2, 3, 4, 5, 6], time: '09:00' }, { kind: 'monthly', dom: 28, time: '09:00' },
      { kind: 'interval', mins: 5 }, { kind: 'interval', mins: 1440 },
    ]) expect(ScheduleRuleSchema.safeParse(rule).success, JSON.stringify(rule)).toBe(true);
    expect(NewScheduleSchema.safeParse({ ...base, timezone: 'UTC' }).success).toBe(true);
    expect(isTimeZone('UTC')).toBe(true);
  });
  it('rejects mins 4, 24:00, dom 29, an unknown time zone and bad weekly days', () => {
    expect(ScheduleRuleSchema.safeParse({ kind: 'interval', mins: 4 }).success).toBe(false);
    expect(ScheduleRuleSchema.safeParse({ kind: 'interval', mins: 1441 }).success).toBe(false);
    expect(ScheduleRuleSchema.safeParse({ kind: 'daily', time: '24:00' }).success).toBe(false);
    expect(ScheduleRuleSchema.safeParse({ kind: 'daily', time: '9:00' }).success).toBe(false);
    expect(ScheduleRuleSchema.safeParse({ kind: 'monthly', dom: 29, time: '09:00' }).success).toBe(false);
    expect(ScheduleRuleSchema.safeParse({ kind: 'once', day: 7, time: '09:00' }).success).toBe(false);
    expect(ScheduleRuleSchema.safeParse({ kind: 'weekly', days: [], time: '09:00' }).success).toBe(false);
    expect(ScheduleRuleSchema.safeParse({ kind: 'weekly', days: [1, 1], time: '09:00' }).success).toBe(false);
    expect(ScheduleRuleSchema.safeParse({ kind: 'weekly', days: [2, 1], time: '09:00' }).success).toBe(false);
    expect(ScheduleRuleSchema.safeParse({ kind: 'weekly', days: [7], time: '09:00' }).success).toBe(false);
    expect(ScheduleRuleSchema.safeParse({ kind: 'webhook' }).success).toBe(false);
    expect(NewScheduleSchema.safeParse({ ...base, timezone: 'Mars/Olympus' }).success).toBe(false);
    expect(isTimeZone('Mars/Olympus')).toBe(false);
  });
  it('limits the prompt and needs a version on a patch', () => {
    expect(NewScheduleSchema.safeParse({ ...base, prompt: '' }).success).toBe(false);
    expect(NewScheduleSchema.safeParse({ ...base, prompt: 'x'.repeat(4001) }).success).toBe(false);
    expect(NewScheduleSchema.safeParse({ ...base, prompt: 'x'.repeat(4000) }).success).toBe(true);
    expect(SchedulePatchSchema.safeParse({ on: false }).success).toBe(false);
    expect(SchedulePatchSchema.safeParse({ on: false, version: 0 }).success).toBe(true);
    expect(SchedulePatchSchema.safeParse({ version: 0, timezone: 'UTC' }).success).toBe(false);
  });
  it('exports the limits', () => {
    expect([MISSED_GRACE_MS, MAX_SCHEDULES_PER_CHAT, MAX_SCHEDULES_PER_CREATOR]).toEqual([600_000, 10, 100]);
  });
});

describe('parseScheduleText', () => {
  // Wednesday 2026-11-11, 12:00 in Sofia.
  const now = Date.UTC(2026, 10, 11, 10);
  const parse = (text: string, at = now, tz = 'Europe/Sofia') => parseScheduleText(text, at, tz);
  it('reads the brief\'s examples', () => {
    expect(parse('every Monday at 9 send the digest')).toEqual({ kind: 'weekly', days: [0], time: '09:00' });
    expect(parse('every 15 min check errors')).toEqual({ kind: 'interval', mins: 15 });
    expect(parse('every 2 min')).toBeNull();
    expect(parse('daily at 6pm')).toEqual({ kind: 'daily', time: '18:00' });
    expect(parse('tomorrow at 9:30am')).toEqual({ kind: 'once', day: 3, time: '09:30' });
    expect(parse('weekdays at 8')).toEqual({ kind: 'weekdays', time: '08:00' });
    expect(parse('every month')).toEqual({ kind: 'monthly', dom: 1, time: '09:00' });
    expect(parse('every day at 25:00')).toBeNull();
    expect(parse('do it every time')).toBeNull();
    expect(parse('every evening')).toEqual({ kind: 'daily', time: '18:00' });
  });
  it('needs a trigger word', () => {
    expect(parse('send the digest at 9')).toBeNull();
    expect(parse('everyone at 9')).toBeNull();
    expect(parse('')).toBeNull();
    expect(parse('@Pip every Monday at 9 post the recap')).toEqual({ kind: 'weekly', days: [0], time: '09:00' });
    expect(parse('Every Friday post the notes')).toEqual({ kind: 'weekly', days: [4], time: '09:00' });
  });
  it('keeps intervals between 5 and 1440 minutes', () => {
    expect(parse('every 5 minutes')).toEqual({ kind: 'interval', mins: 5 });
    expect(parse('every 1440 mins')).toEqual({ kind: 'interval', mins: 1440 });
    expect(parse('every 1441 min')).toBeNull();
    expect(parse('every 4min')).toBeNull();
  });
  it('reads 12am, 12pm and minutes, and refuses impossible times', () => {
    expect(parse('daily at 12am')).toEqual({ kind: 'daily', time: '00:00' });
    expect(parse('daily at 12pm')).toEqual({ kind: 'daily', time: '12:00' });
    expect(parse('daily at 7:05 pm')).toEqual({ kind: 'daily', time: '19:05' });
    expect(parse('every morning')).toEqual({ kind: 'weekdays', time: '08:00' });
    expect(parse('every weekday at 17:45')).toEqual({ kind: 'weekdays', time: '17:45' });
    expect(parse('every day at 9:60')).toBeNull();
    expect(parse('every day at 9:5')).toBeNull();
    expect(parse('every day at 123')).toBeNull();
  });
  it('takes tomorrow\'s weekday in the given time zone', () => {
    // Wednesday 23:30 UTC is already Thursday 01:30 in Sofia: tomorrow is Friday.
    expect(parse('tomorrow at 9', Date.UTC(2026, 10, 11, 23, 30))).toEqual({ kind: 'once', day: 4, time: '09:00' });
    expect(parse('tomorrow at 9', Date.UTC(2026, 10, 11, 23, 30), 'UTC')).toEqual({ kind: 'once', day: 3, time: '09:00' });
    // Sunday in Sofia: tomorrow is Monday.
    expect(parse('tomorrow', Date.UTC(2026, 10, 15, 10))).toEqual({ kind: 'once', day: 0, time: '09:00' });
  });
  it('never throws: an unknown time zone or odd input is null, and every result passes the schema', () => {
    expect(parse('tomorrow at 9', now, 'Mars/Olympus')).toBeNull();
    expect(parseScheduleText(undefined as unknown as string, now, 'UTC')).toBeNull();
    expect(parse('every day', Number.NaN)).toEqual({ kind: 'daily', time: '09:00' });
    expect(parse('tomorrow', Number.NaN)).toBeNull();
    for (const text of ['every week', 'every Sunday at 11pm', 'daily', 'every 30 min', 'tomorrow at 12am', 'every month at 6:15am']) {
      expect(ScheduleRuleSchema.safeParse(parse(text)).success, text).toBe(true);
    }
  });
});
