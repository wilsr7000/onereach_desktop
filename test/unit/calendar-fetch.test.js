import { describe, it, expect } from 'vitest';

// calendar-fetch uses require() internally but we test the pure functions
// by importing just the date resolution functions
const { resolveTimeframe, resolveEventDate } = await import('../../lib/calendar-fetch.js');

// Fixed reference date: Monday Feb 16 2026
const NOW = new Date('2026-02-16T10:30:00');

describe('resolveTimeframe', () => {
  it('resolves "today" to the current day', () => {
    const result = resolveTimeframe('today', NOW);
    expect(result.label).toBe('Today');
    expect(result.start.getDate()).toBe(16);
    expect(result.start.getHours()).toBe(0);
    expect(result.end.getHours()).toBe(23);
  });

  it('resolves "tomorrow" to the next day', () => {
    const result = resolveTimeframe('tomorrow', NOW);
    expect(result.label).toBe('Tomorrow');
    expect(result.start.getDate()).toBe(17);
    expect(result.end.getDate()).toBe(17);
  });

  it('resolves "yesterday" to the previous day', () => {
    const result = resolveTimeframe('yesterday', NOW);
    expect(result.label).toBe('Yesterday');
    expect(result.start.getDate()).toBe(15);
  });

  it('resolves "this_week" to Monday-Sunday', () => {
    const result = resolveTimeframe('this_week', NOW);
    expect(result.label).toBe('This Week');
    expect(result.start.getDay()).toBe(1); // Monday
    expect(result.end.getDay()).toBe(0); // Sunday
    expect(result.start.getDate()).toBe(16);
    expect(result.end.getDate()).toBe(22);
  });

  it('resolves "this week" with space', () => {
    const result = resolveTimeframe('this week', NOW);
    expect(result.label).toBe('This Week');
    expect(result.start.getDate()).toBe(16);
  });

  it('resolves "next_week" to the following Monday-Sunday', () => {
    const result = resolveTimeframe('next_week', NOW);
    expect(result.label).toBe('Next Week');
    expect(result.start.getDay()).toBe(1); // Monday
    expect(result.start.getDate()).toBe(23);
    expect(result.end.getDate()).toBe(1); // March 1
  });

  it('resolves "this_month" to February boundaries', () => {
    const result = resolveTimeframe('this_month', NOW);
    expect(result.label).toBe('February');
    expect(result.start.getDate()).toBe(1);
    expect(result.end.getDate()).toBe(28); // 2026 is not a leap year
  });

  it('resolves day names to next occurrence', () => {
    // NOW is Monday Feb 16
    const wed = resolveTimeframe('wednesday', NOW);
    expect(wed.start.getDate()).toBe(18); // next Wednesday
    expect(wed.start.getDay()).toBe(3);

    const fri = resolveTimeframe('friday', NOW);
    expect(fri.start.getDate()).toBe(20);

    // Monday wraps to next Monday
    const mon = resolveTimeframe('monday', NOW);
    expect(mon.start.getDate()).toBe(23); // next Monday, not today
  });

  it('resolves ISO date string', () => {
    const result = resolveTimeframe('2026-03-15', NOW);
    expect(result.start.getMonth()).toBe(2); // March
    expect(result.start.getDate()).toBe(15);
    expect(result.label).toContain('Mar');
  });

  it('handles unrecognized input by defaulting to today', () => {
    const result = resolveTimeframe('gobbledygook', NOW);
    expect(result.label).toBe('Today');
    expect(result.start.getDate()).toBe(16);
  });

  it('handles empty/null input by defaulting to today', () => {
    const result = resolveTimeframe(null, NOW);
    expect(result.label).toBe('Today');

    const result2 = resolveTimeframe('', NOW);
    expect(result2.label).toBe('Today');
  });

  it('start is always before end', () => {
    const cases = ['today', 'tomorrow', 'yesterday', 'this_week', 'next_week', 'this_month', 'friday', '2026-06-01'];
    for (const tf of cases) {
      const result = resolveTimeframe(tf, NOW);
      expect(result.start.getTime()).toBeLessThan(result.end.getTime(), `${tf}: start should be before end`);
    }
  });
});

describe('resolveEventDate', () => {
  it('resolves "today" to current ISO date', () => {
    const result = resolveEventDate('today', NOW);
    expect(result).toBe('2026-02-16');
  });

  it('resolves "tomorrow"', () => {
    const result = resolveEventDate('tomorrow', NOW);
    expect(result).toBe('2026-02-17');
  });

  it('resolves day name to next occurrence', () => {
    const result = resolveEventDate('friday', NOW);
    expect(result).toBe('2026-02-20');
  });

  it('resolves "next friday"', () => {
    const result = resolveEventDate('next friday', NOW);
    expect(result).toBe('2026-02-20');
  });

  it('passes through valid ISO date', () => {
    const result = resolveEventDate('2026-03-15', NOW);
    expect(result).toBe('2026-03-15');
  });

  it('throws on invalid ISO date', () => {
    expect(() => resolveEventDate('2026-13-99', NOW)).toThrow();
  });

  it('throws on empty input', () => {
    expect(() => resolveEventDate('', NOW)).toThrow('Date is required');
    expect(() => resolveEventDate(null, NOW)).toThrow('Date is required');
  });

  it('throws on unresolvable input', () => {
    expect(() => resolveEventDate('sometime next spring', NOW)).toThrow('Cannot resolve date');
  });

  it('throws if date is more than a year away', () => {
    expect(() => resolveEventDate('2028-01-01', NOW)).toThrow('more than a year away');
  });

  it('accepts dates within a year', () => {
    const result = resolveEventDate('2027-01-01', NOW);
    expect(result).toBe('2027-01-01');
  });
});

describe('resolveTimeframe edge cases', () => {
  it('handles Sunday as reference day for this_week', () => {
    const sunday = new Date('2026-02-22T10:00:00'); // Sunday
    const result = resolveTimeframe('this_week', sunday);
    expect(result.start.getDay()).toBe(1); // Monday
    expect(result.start.getDate()).toBe(16); // Previous Monday
    expect(result.end.getDate()).toBe(22); // This Sunday
  });

  it('handles Saturday as reference day', () => {
    const saturday = new Date('2026-02-21T10:00:00');
    const result = resolveTimeframe('this_week', saturday);
    expect(result.start.getDay()).toBe(1);
    expect(result.start.getDate()).toBe(16);
  });

  it('handles year boundary for next_week in late December', () => {
    const dec = new Date('2026-12-28T10:00:00'); // Monday
    const result = resolveTimeframe('next_week', dec);
    expect(result.start.getFullYear()).toBe(2027);
    expect(result.start.getMonth()).toBe(0); // January
  });

  it('resolves "this month" for December correctly', () => {
    const dec = new Date('2026-12-15T10:00:00');
    const result = resolveTimeframe('this_month', dec);
    expect(result.label).toBe('December');
    expect(result.start.getDate()).toBe(1);
    expect(result.end.getDate()).toBe(31);
  });
});
