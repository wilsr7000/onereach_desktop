import { describe, expect, it } from 'vitest';
import { visibleRange } from './range.js';
import { cd, NY } from './test-helpers.js';

const iso = (d: { year: number; month: number; day: number }): string => `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;

describe('visibleRange', () => {
  it('month view includes leading and trailing days aligned to the week start', () => {
    // September 2026 starts on a Tuesday.
    const r = visibleRange('month', cd('2026-09-15'), 0, NY);
    expect(iso(r.start)).toBe('2026-08-30');
    expect(iso(r.end)).toBe('2026-10-04');
    expect(r.days).toHaveLength(35);
    expect(r.weeks).toHaveLength(5);
    expect(r.weeks.every((w) => w.length === 7)).toBe(true);
    const monday = visibleRange('month', cd('2026-09-15'), 1, NY);
    expect(iso(monday.start)).toBe('2026-08-31');
    expect(iso(monday.end)).toBe('2026-10-05');
  });
  it('a month that fits four weeks exactly renders four rows, or six with fixedWeeks', () => {
    // February 2026 starts on a Sunday and has 28 days.
    const r = visibleRange('month', cd('2026-02-10'), 0, NY);
    expect(iso(r.start)).toBe('2026-02-01');
    expect(r.days).toHaveLength(28);
    const fixed = visibleRange('month', cd('2026-02-10'), 0, NY, { fixedWeeks: true });
    expect(fixed.days).toHaveLength(42);
    expect(iso(fixed.end)).toBe('2026-03-15');
  });
  it('week view is seven days from the aligned start, for any week start', () => {
    const friday = cd('2026-09-04');
    expect(iso(visibleRange('week', friday, 0, NY).start)).toBe('2026-08-30');
    expect(iso(visibleRange('week', friday, 1, NY).start)).toBe('2026-08-31');
    expect(iso(visibleRange('week', friday, 6, NY).start)).toBe('2026-08-29');
    const w = visibleRange('week', friday, 6, NY);
    expect(w.days).toHaveLength(7);
    expect(iso(w.end)).toBe('2026-09-05');
    expect(w.weeks).toHaveLength(1);
  });
  it('day view is the anchor alone; the zone and anchor travel with the range', () => {
    const r = visibleRange('day', cd('2026-09-04'), 1, NY);
    expect(r.days.map(iso)).toEqual(['2026-09-04']);
    expect(iso(r.end)).toBe('2026-09-05');
    expect(r.timeZone).toBe(NY);
    expect(iso(r.anchor)).toBe('2026-09-04');
    expect(r.weeks).toEqual([[r.days[0]]]);
  });
});
