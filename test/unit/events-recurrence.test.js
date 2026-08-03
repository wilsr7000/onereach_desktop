/**
 * Unit tests for lib/events/recurrence.js -- pure occurrence math for the
 * manage-events feature (one-off + daily/weekly/monthly recurring events).
 */

import { describe, it, expect } from 'vitest';
import { nextOccurrence, upcoming, describeOccurrence, RECURRENCES } from '../../lib/events/recurrence.js';

// Monday 2026-08-03 10:00 local
const NOW = new Date(2026, 7, 3, 10, 0, 0);

describe('nextOccurrence', () => {
  it('a future one-off returns its start time', () => {
    const at = nextOccurrence({ startsAt: new Date(2026, 7, 4, 15, 0).toISOString(), recurrence: 'none' }, NOW);
    expect(at.getTime()).toBe(new Date(2026, 7, 4, 15, 0).getTime());
  });

  it('a past one-off has no next occurrence', () => {
    expect(nextOccurrence({ startsAt: new Date(2026, 7, 1, 9, 0).toISOString(), recurrence: 'none' }, NOW)).toBeNull();
  });

  it('daily: later today when the time has not passed yet', () => {
    const at = nextOccurrence({ startsAt: new Date(2026, 6, 1, 15, 0).toISOString(), recurrence: 'daily' }, NOW);
    expect(at.getTime()).toBe(new Date(2026, 7, 3, 15, 0).getTime());
  });

  it('daily: tomorrow when the time already passed today', () => {
    const at = nextOccurrence({ startsAt: new Date(2026, 6, 1, 8, 0).toISOString(), recurrence: 'daily' }, NOW);
    expect(at.getTime()).toBe(new Date(2026, 7, 4, 8, 0).getTime());
  });

  it('weekly: defaults to the start weekday', () => {
    // started Wednesday 2026-07-01 18:00 -> next Wednesday from Monday NOW is 2026-08-05
    const at = nextOccurrence({ startsAt: new Date(2026, 6, 1, 18, 0).toISOString(), recurrence: 'weekly' }, NOW);
    expect(at.getDay()).toBe(3);
    expect(at.getTime()).toBe(new Date(2026, 7, 5, 18, 0).getTime());
  });

  it('weekly with byDay: picks the soonest listed weekday (weekday standup)', () => {
    // Mon-Fri 9:30; from Monday 10:00 the 9:30 slot has passed -> Tuesday 9:30
    const at = nextOccurrence(
      { startsAt: new Date(2026, 6, 6, 9, 30).toISOString(), recurrence: 'weekly', byDay: [1, 2, 3, 4, 5] },
      NOW
    );
    expect(at.getTime()).toBe(new Date(2026, 7, 4, 9, 30).getTime());
  });

  it('weekly with byDay: same-day occurrence still ahead is chosen', () => {
    const at = nextOccurrence(
      { startsAt: new Date(2026, 6, 6, 16, 0).toISOString(), recurrence: 'weekly', byDay: [1] },
      NOW
    );
    expect(at.getTime()).toBe(new Date(2026, 7, 3, 16, 0).getTime());
  });

  it('monthly: same day-of-month, skipping months that lack it', () => {
    // Started Jan 31; from Feb 1 the next valid occurrence is Mar 31 (Feb has no 31st)
    const from = new Date(2026, 1, 1, 12, 0);
    const at = nextOccurrence({ startsAt: new Date(2026, 0, 31, 9, 0).toISOString(), recurrence: 'monthly' }, from);
    expect(at.getTime()).toBe(new Date(2026, 2, 31, 9, 0).getTime());
  });

  it('handles malformed input without throwing', () => {
    expect(nextOccurrence(null, NOW)).toBeNull();
    expect(nextOccurrence({ startsAt: 'not a date' }, NOW)).toBeNull();
    expect(nextOccurrence({ startsAt: NOW.toISOString() }, 'not a date')).toBeNull();
  });

  it('unknown recurrence values degrade to one-off (none)', () => {
    expect(
      nextOccurrence({ startsAt: new Date(2026, 7, 1, 9, 0).toISOString(), recurrence: 'fortnightly' }, NOW)
    ).toBeNull();
    expect(RECURRENCES).toEqual(['none', 'daily', 'weekly', 'monthly']);
  });
});

describe('upcoming', () => {
  const events = [
    { id: 'a', title: 'Dentist', startsAt: new Date(2026, 7, 4, 15, 0).toISOString(), recurrence: 'none' },
    { id: 'b', title: 'Standup', startsAt: new Date(2026, 6, 6, 9, 30).toISOString(), recurrence: 'weekly', byDay: [1, 2, 3, 4, 5] },
    { id: 'c', title: 'Old party', startsAt: new Date(2026, 6, 1, 20, 0).toISOString(), recurrence: 'none' },
    { id: 'd', title: 'Rent', startsAt: new Date(2026, 0, 1, 8, 0).toISOString(), recurrence: 'monthly' },
  ];

  it('sorts soonest-first, drops dead one-offs, respects limit', () => {
    const list = upcoming(events, NOW, 10);
    expect(list.map((e) => e.event.id)).toEqual(['b', 'a', 'd']); // Tue 9:30 standup, Tue 15:00 dentist, Sep 1 rent
    expect(upcoming(events, NOW, 1)).toHaveLength(1);
  });

  it('is safe on empty/undefined input', () => {
    expect(upcoming([], NOW)).toEqual([]);
    expect(upcoming(undefined, NOW)).toEqual([]);
  });
});

describe('describeOccurrence', () => {
  it('says today / tomorrow / weekday for near dates', () => {
    expect(describeOccurrence(new Date(2026, 7, 3, 15, 0), NOW)).toMatch(/^today at/);
    expect(describeOccurrence(new Date(2026, 7, 4, 9, 30), NOW)).toMatch(/^tomorrow at/);
    expect(describeOccurrence(new Date(2026, 7, 6, 9, 30), NOW)).toMatch(/^Thursday at/);
  });

  it('falls back to a short date beyond a week', () => {
    expect(describeOccurrence(new Date(2026, 8, 1, 8, 0), NOW)).toMatch(/Sep 1 at/);
  });
});
