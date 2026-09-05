/**
 * ADR-090 — Quartz cron evaluation in a time zone: the expressions GSX's
 * "Schedule execution" step writes, evaluated the way the platform means them.
 */
import { describe, it, expect } from 'vitest';
import { boundToMs, cronOccurrences, expandField, parseCron, zonedParts, zonedTimeToUtc } from '../../calendar/cron.js';

const GSX_5MIN = '0,5,10,15,20,25,30,35,40,45,50,55 0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23 1/1 * ? *';

describe('calendar cron — fields', () => {
  it('expands lists, ranges, steps, wildcards and wrapping ranges', () => {
    expect(expandField('0,5,10', 0, 59)).toEqual([0, 5, 10]);
    expect(expandField('1-3', 1, 31)).toEqual([1, 2, 3]);
    expect(expandField('*/15', 0, 59)).toEqual([0, 15, 30, 45]);
    expect(expandField('1/1', 1, 5)).toEqual([1, 2, 3, 4, 5]);
    expect(expandField('6-2', 1, 7)).toEqual([1, 2, 6, 7]);
  });
  it('parses the six-field GSX form (min hour dom month dow year) and the seven-field form with seconds', () => {
    const six = parseCron(GSX_5MIN);
    expect(six.minutes).toHaveLength(12);
    expect(six.hours).toHaveLength(24);
    expect(six.seconds).toEqual([0]);
    expect(six.dayOfWeek).toBeNull();
    expect(six.years).toBeNull();
    const seven = parseCron('30 0 12 ? * MON-FRI 2026');
    expect(seven.seconds).toEqual([30]);
    expect(seven.hours).toEqual([12]);
    expect(seven.dayOfMonth).toBeNull();
    expect(seven.dayOfWeek?.(2, 1, 30)).toBe(true); // MON
    expect(seven.dayOfWeek?.(1, 1, 30)).toBe(false); // SUN
    expect(seven.years?.has(2026)).toBe(true);
    expect(() => parseCron('* *')).toThrow(/5–7 fields/);
  });
  it('understands L and n#k day-of-month / day-of-week forms and month names', () => {
    const lastDay = parseCron('0 9 L * ? *');
    expect(lastDay.dayOfMonth?.(30, 30)).toBe(true);
    expect(lastDay.dayOfMonth?.(29, 30)).toBe(false);
    const secondTuesday = parseCron('0 9 ? * 3#2 *');
    expect(secondTuesday.dayOfWeek?.(3, 9, 31)).toBe(true);
    expect(secondTuesday.dayOfWeek?.(3, 2, 31)).toBe(false);
    const lastFriday = parseCron('0 9 ? * 6L *');
    expect(lastFriday.dayOfWeek?.(6, 27, 31)).toBe(true);
    expect(lastFriday.dayOfWeek?.(6, 20, 31)).toBe(false);
    expect([...parseCron('0 0 1 JAN,JUL ? *').months]).toEqual([1, 7]);
  });
});

describe('calendar cron — time zones', () => {
  it('round-trips wall time in a zone and reports Quartz weekdays', () => {
    const at = zonedTimeToUtc(2026, 9, 5, 9, 30, 0, 'Europe/Kiev');
    expect(at).not.toBeNull();
    const p = zonedParts(at ?? 0, 'Europe/Kiev');
    expect([p.year, p.month, p.day, p.hour, p.minute]).toEqual([2026, 9, 5, 9, 30]);
    expect(p.dow).toBe(7); // Saturday
    expect(zonedParts(at ?? 0, 'UTC').hour).toBe(6); // Kyiv is UTC+3 in summer
  });
  it('skips a wall time that does not exist on a spring-forward day', () => {
    // America/New_York, 2026-03-08: 02:30 does not exist.
    expect(zonedTimeToUtc(2026, 3, 8, 2, 30, 0, 'America/New_York')).toBeNull();
    expect(zonedTimeToUtc(2026, 3, 8, 3, 30, 0, 'America/New_York')).not.toBeNull();
  });
  it('produces the GSX every-five-minutes series in its zone: 288 a day, first at local midnight', () => {
    const from = zonedTimeToUtc(2026, 9, 5, 0, 0, 0, 'Europe/Kiev') ?? 0;
    const to = zonedTimeToUtc(2026, 9, 5, 23, 59, 59, 'Europe/Kiev') ?? 0;
    const runs = cronOccurrences(GSX_5MIN, 'Europe/Kiev', { fromMs: from, toMs: to });
    expect(runs).toHaveLength(288);
    expect(runs[0]).toBe(from);
    expect((runs[1] ?? 0) - (runs[0] ?? 0)).toBe(5 * 60000);
  });
  it('honours weekdays, the window edges and the limit', () => {
    const from = zonedTimeToUtc(2026, 9, 1, 0, 0, 0, 'UTC') ?? 0; // Tuesday
    const to = zonedTimeToUtc(2026, 9, 14, 23, 59, 59, 'UTC') ?? 0;
    const runs = cronOccurrences('0 0 12 ? * MON-FRI *', 'UTC', { fromMs: from, toMs: to });
    expect(runs).toHaveLength(10);
    expect(zonedParts(runs[0] ?? 0, 'UTC').day).toBe(1);
    expect(cronOccurrences('0 0 12 ? * MON-FRI *', 'UTC', { fromMs: from, toMs: to, limit: 3 })).toHaveLength(3);
    expect(cronOccurrences('0 0 12 ? * MON-FRI 2030', 'UTC', { fromMs: from, toMs: to })).toHaveLength(0);
  });
  it('turns a schedule bound into an instant in the zone, end-of-day when asked', () => {
    const start = boundToMs({ date: '2019-10-09', time: '00:00' }, 'Europe/Kiev');
    expect(zonedParts(start ?? 0, 'Europe/Kiev').hour).toBe(0);
    const end = boundToMs({ date: '2020-02-01', time: '' }, 'Europe/Kiev', true);
    expect(zonedParts(end ?? 0, 'Europe/Kiev').hour).toBe(23);
    expect(boundToMs({ date: 'never', time: '' }, 'UTC')).toBeNull();
    expect(boundToMs(null, 'UTC')).toBeNull();
  });
});
