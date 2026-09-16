/**
 * lib/gps-for-life/routine -- the NEON Chore queue as the day's plan:
 * morning routine, later today, anytime, overdue one-offs. Mirrors the live
 * shape probed on 2026-09-15 (Child "Robb", 24 chores, RRULE strings).
 */
import { describe, it, expect } from 'vitest';

const { parseRule, occursOn, planDay, buildTasksBriefText, compressItem } = require('../../lib/gps-for-life/routine');
const { readTasksForBrief, resolveChild, CHILD_BY_NAME } = require('../../lib/gps-for-life/chores-read');
const CHILD_BY_NAME_HAS_UNIQUENESS_GUARD = /size\(matches\) = 1/.test(CHILD_BY_NAME);

// A Tuesday.
const DAY = new Date(2026, 8, 15, 7, 25);
const local = (y, m, d, hh, mm = 0) => new Date(y, m - 1, d, hh, mm).toISOString();

const CHORES = [
  { id: 'c1', title: 'Morning Workout', status: 'active', scheduled_at: local(2026, 4, 20, 7, 0), due_by: local(2026, 4, 20, 7, 10), priority: 'P2', recurrence_rule: 'FREQ=DAILY', energy_level: 4 },
  { id: 'c2', title: 'Stretch Calves', status: 'pending', scheduled_at: local(2026, 8, 16, 7, 30), due_by: local(2026, 8, 16, 7, 35), priority: 'P3', recurrence_rule: 'FREQ=DAILY' },
  { id: 'c3', title: 'Brush Teeth & Water Pick', status: 'snoozed', scheduled_at: local(2026, 4, 22, 9, 30), due_by: local(2026, 4, 22, 9, 35), priority: 'P1', recurrence_rule: 'FREQ=DAILY', energy_level: 1 },
  { id: 'c4', title: 'Nightly Stretch', status: 'pending', scheduled_at: local(2026, 4, 20, 22, 0), due_by: local(2026, 4, 20, 22, 10), priority: 'P2', recurrence_rule: 'FREQ=DAILY' },
  { id: 'c5', title: 'Laundry Duty', status: 'active', scheduled_at: local(2026, 4, 20, 9, 0), due_by: local(2026, 4, 20, 9, 45), priority: 'P2', recurrence_rule: 'FREQ=WEEKLY;BYDAY=SU' },
  { id: 'c6', title: 'Chess Club', status: 'snoozed', scheduled_at: local(2026, 4, 22, 15, 15), due_by: local(2026, 4, 22, 16, 15), priority: 'P1', recurrence_rule: 'FREQ=WEEKLY;BYDAY=WE' },
  { id: 'c7', title: 'Tuesday thing', status: 'pending', scheduled_at: local(2026, 4, 21, 13, 0), due_by: local(2026, 4, 21, 14, 0), priority: 'P2', recurrence_rule: 'FREQ=WEEKLY;BYDAY=TU' },
  { id: 'c8', title: 'Empty dishwasher', status: 'pending', scheduled_at: local(2026, 4, 19, 19, 0), due_by: local(2026, 4, 19, 20, 0), priority: 'P2', recurrence_rule: null },
  { id: 'c9', title: 'Create A Badge Notification', status: 'pending', scheduled_at: '2000-01-01T00:00:00', due_by: '2000-01-01T00:00:00', priority: 'P3', recurrence_rule: 'ANYTIME' },
  { id: 'c10', title: '', status: 'pending', scheduled_at: local(2026, 8, 16, 7, 30), due_by: local(2026, 8, 16, 7, 35), priority: 'P2', recurrence_rule: 'FREQ=DAILY' },
  { id: 'c11', title: 'Take out trash', status: 'completed', scheduled_at: local(2026, 9, 15, 6, 30), completed_at: local(2026, 9, 15, 6, 45), recurrence_rule: null },
  { id: 'c12', title: 'Dentist', status: 'pending', scheduled_at: local(2026, 9, 15, 15, 0), due_by: local(2026, 9, 15, 16, 0), priority: 'P1', recurrence_rule: null },
];

describe('parseRule / occursOn', () => {
  it('parses the three real rule shapes', () => {
    expect(parseRule('FREQ=DAILY')).toEqual({ freq: 'daily', byDay: [] });
    expect(parseRule('FREQ=WEEKLY;BYDAY=SU,WE')).toEqual({ freq: 'weekly', byDay: [0, 3] });
    expect(parseRule('ANYTIME')).toEqual({ freq: 'anytime', byDay: [] });
    expect(parseRule(null)).toEqual({ freq: 'once', byDay: [] });
  });
  it('daily fires every day from its first date; weekly on its BYDAY; once only on its day', () => {
    expect(occursOn(CHORES[0], DAY)).toBe(true);
    expect(occursOn(CHORES[4], DAY)).toBe(false); // Sunday-only, today is Tuesday
    expect(occursOn(CHORES[6], DAY)).toBe(true); // Tuesday
    expect(occursOn(CHORES[11], DAY)).toBe(true); // one-off today
    expect(occursOn(CHORES[7], DAY)).toBe(false); // one-off in April
    expect(occursOn({ recurrence_rule: 'FREQ=DAILY', scheduled_at: local(2026, 9, 20, 7) }, DAY)).toBe(false); // starts later
  });
});

describe('planDay', () => {
  const plan = planDay(CHORES, { day: DAY, now: DAY });

  it('splits the morning routine, later today, anytime and overdue one-offs', () => {
    expect(plan.morning.map((i) => i.title)).toEqual(['Morning Workout', 'Stretch Calves', 'Brush Teeth & Water Pick']);
    expect(plan.later.map((i) => i.title)).toEqual(['Tuesday thing', 'Dentist', 'Nightly Stretch']);
    expect(plan.anytime.map((i) => i.title)).toEqual(['Create A Badge Notification']);
    expect(plan.overdue.map((i) => i.title)).toEqual(['Empty dishwasher']);
    expect(plan.overdue[0].line).toBe('overdue 149 days · Empty dishwasher');
    expect(plan.doneToday).toBe(1);
  });

  it('a one-off due today with no scheduled time is on the plan (reviewer finding #4)', () => {
    const p = planDay([{ id: 'x', title: 'Renew passport', status: 'pending', scheduled_at: null, due_by: local(2026, 9, 15, 16, 0), priority: 'P1', recurrence_rule: null }], { day: DAY, now: DAY });
    expect(p.later.map((i) => i.line)).toEqual(['4:00 PM \u00B7 Renew passport \u00B7 high priority']);
    expect(p.overdue).toEqual([]);
  });

  it('untitled seed rows are skipped', () => {
    expect(plan.items.some((i) => i.title === 'Untitled task')).toBe(false);
  });

  it('items read the same on screen and out loud', () => {
    const workout = plan.morning[0];
    expect(workout.line).toBe('7:00 AM · Morning Workout · energy 4');
    expect(workout.spoken).toBe('7 AM, Morning Workout.');
    const teeth = plan.morning[2];
    expect(teeth.line).toBe('9:30 AM · Brush Teeth & Water Pick · high priority · snoozed');
    expect(teeth.spoken).toBe('9:30 AM, Brush Teeth & Water Pick, high priority.');
  });

  it('TaskItems from the graph queue join the plan (alarms today, overdue if past)', () => {
    const p = planDay([], {
      day: DAY,
      now: DAY,
      taskItems: [
        { id: 't1', name: 'Call the bank', status: 'pending', priority: 8, fire_at: local(2026, 9, 15, 10, 0) },
        { id: 't2', name: 'Old reminder', status: 'pending', priority: 5, fire_at: local(2026, 9, 10, 10, 0) },
        { id: 't3', name: 'Someday', status: 'pending', priority: 5, fire_at: null },
        { id: 't4', name: 'Done one', status: 'completed', fire_at: local(2026, 9, 15, 10, 0) },
      ],
    });
    expect(p.morning.map((i) => i.line)).toEqual(['10:00 AM · Call the bank · high priority']);
    expect(p.overdue.map((i) => i.title)).toEqual(['Old reminder']);
    expect(p.anytime.map((i) => i.title)).toEqual(['Someday']);
  });
});

describe('buildTasksBriefText', () => {
  it('writes the composer text + items, morning routine in full', () => {
    const plan = planDay(CHORES, { day: DAY, now: DAY });
    const { headline, content, items } = buildTasksBriefText(plan, { dateLabel: 'today' });
    expect(headline).toBe('7 tasks today (3 in your morning routine), 1 overdue.');
    expect(content).toContain('Morning routine (in order):\n- 7:00 AM · Morning Workout · energy 4');
    expect(content).toContain('Later today:');
    expect(content).toContain('Anytime: Create A Badge Notification.');
    expect(content).toContain('Overdue one-offs: 1 — Empty dishwasher (overdue 149 days).');
    expect(content).toContain('Already done today: 1.');
    expect(items.map((i) => i.kind)).toEqual(['morning', 'morning', 'morning', 'later', 'later', 'later', 'anytime', 'overdue']);
  });
  it('an empty queue says so', () => {
    const { content } = buildTasksBriefText(planDay([], { day: DAY, now: DAY }), { dateLabel: 'today' });
    expect(content).toBe('No tasks queued today.');
  });
});

describe('chores-read (injected reader)', () => {
  it('resolves the Child by explicit phone, else by profile first name, and reads chores + task items', async () => {
    const calls = [];
    const read = async (cypher, params) => {
      calls.push({ cypher, params });
      if (cypher.includes('c.phone = ') || cypher.includes('{phone: $phone})\nRETURN')) return [];
      if (cypher.includes('toLower($name)')) return [{ phone: '1003', name: 'Robb' }];
      if (cypher.includes('HAS_CHORE')) return [{ id: 'c1', title: 'Morning Workout', status: 'active' }];
      if (cypher.includes(':TaskItem')) return [];
      return [];
    };
    const out = await readTasksForBrief({ profileName: 'Robb Wilson', userEmail: 'robb@onereach.com', read });
    expect(out.child).toEqual({ phone: '1003', name: 'Robb' });
    expect(out.chores).toHaveLength(1);
    expect(calls.find((c) => c.cypher.includes('toLower($name)')).params).toEqual({ name: 'Robb' });
    expect(calls.find((c) => c.cypher.includes('HAS_CHORE')).params).toEqual({ phone: '1003' });
    expect(calls.find((c) => c.cypher.includes(':TaskItem')).params).toEqual({ user: 'robb@onereach.com' });
    // No user text is ever interpolated into the Cypher.
    expect(calls.every((c) => !c.cypher.includes('Robb'))).toBe(true);
  });
  it('no name and no phone -> no child, no chores', async () => {
    const out = await resolveChild({ profileName: null, read: async () => [] });
    expect(out).toBeNull();
  });
  it('an anonymous session never reads chores by name, and never reads TaskItems', async () => {
    const calls = [];
    const read = async (cypher, params) => { calls.push({ cypher, params }); return [{ phone: '1003', name: 'Robb' }]; };
    const out = await readTasksForBrief({ profileName: 'Robb', userEmail: null, read });
    expect(out.child).toBeNull();
    expect(out.chores).toEqual([]);
    expect(out.taskItems).toEqual([]);
    expect(calls).toEqual([]);
  });
  it('the name match is only trusted when the graph returns exactly one child', async () => {
    const read = async (cypher) => (cypher.includes('toLower($name)') ? [{ phone: '1003', name: 'Robb' }, { phone: '2001', name: 'Robb' }] : []);
    expect(await resolveChild({ profileName: 'Robb', userEmail: 'robb@onereach.com', read })).toBeNull();
    expect(CHILD_BY_NAME_HAS_UNIQUENESS_GUARD).toBe(true);
  });
});
