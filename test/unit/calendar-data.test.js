/**
 * Tests for lib/calendar-data.js — Pure Calendar Analysis Functions
 *
 * Every test uses fixture events and a frozen `now` — no API calls, no mocking.
 */

import { describe, it, expect } from 'vitest';
import {
  analyzeDay,
  analyzeWeek,
  analyzeMonth,
  findConflicts,
  findFreeSlots,
  getNextEvent,
  enrichEvent,
  isEventInRange,
  deduplicateEvents,
  parseEventTimes,
  formatElapsed,
  dayLabel,
} from '../../lib/calendar-data.js';

// ── Fixture helpers ─────────────────────────────────────────────────────────

function makeEvent(summary, startISO, endISO, opts = {}) {
  return {
    id: opts.id || `evt-${summary.toLowerCase().replace(/\s+/g, '-')}`,
    summary,
    start: opts.allDay ? { date: startISO.slice(0, 10) } : { dateTime: startISO },
    end: opts.allDay ? { date: endISO.slice(0, 10) } : { dateTime: endISO },
    attendees: opts.attendees || [],
    location: opts.location || '',
    description: opts.description || '',
    ...(opts.calendarId ? { calendarId: opts.calendarId } : {}),
  };
}

// ── Shared fixtures ─────────────────────────────────────────────────────────

// A typical Tuesday: Feb 17, 2026
const FEB_17 = new Date('2026-02-17T00:00:00');

const TUESDAY_EVENTS = [
  makeEvent('Standup', '2026-02-17T09:00:00', '2026-02-17T09:15:00'),
  makeEvent('Sprint Planning', '2026-02-17T14:00:00', '2026-02-17T15:00:00'),
  makeEvent('1:1 with John', '2026-02-17T14:30:00', '2026-02-17T15:00:00'),
  makeEvent('Team Retro', '2026-02-17T16:00:00', '2026-02-17T17:00:00'),
];

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// parseEventTimes
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('parseEventTimes', () => {
  it('parses a timed event', () => {
    const ev = makeEvent('Test', '2026-02-17T09:00:00', '2026-02-17T10:00:00');
    const { startTime, endTime, isAllDay } = parseEventTimes(ev);
    expect(isAllDay).toBe(false);
    expect(startTime.getHours()).toBe(9);
    expect(endTime.getHours()).toBe(10);
  });

  it('parses an all-day event', () => {
    const ev = makeEvent('All Day', '2026-02-17', '2026-02-18', { allDay: true });
    const { isAllDay } = parseEventTimes(ev);
    expect(isAllDay).toBe(true);
  });

  it('defaults to 1h duration when end is missing', () => {
    const ev = { summary: 'No end', start: { dateTime: '2026-02-17T09:00:00' } };
    const { startTime, endTime } = parseEventTimes(ev);
    expect(endTime - startTime).toBe(3600000);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// formatElapsed
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('formatElapsed', () => {
  it('formats less than a minute', () => {
    expect(formatElapsed(20000)).toBe('less than a minute');
  });
  it('formats 1 minute', () => {
    expect(formatElapsed(60000)).toBe('1 minute');
  });
  it('formats minutes', () => {
    expect(formatElapsed(300000)).toBe('5 minutes');
  });
  it('formats hours', () => {
    expect(formatElapsed(7200000)).toBe('2 hours');
  });
  it('formats hours and minutes', () => {
    expect(formatElapsed(5400000)).toBe('1 hour 30 min');
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// dayLabel
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('dayLabel', () => {
  const now = new Date('2026-02-17T10:00:00');

  it('returns Today for same day', () => {
    expect(dayLabel(new Date('2026-02-17T00:00:00'), now)).toBe('Today');
  });
  it('returns Tomorrow for next day', () => {
    expect(dayLabel(new Date('2026-02-18T00:00:00'), now)).toBe('Tomorrow');
  });
  it('returns Yesterday for previous day', () => {
    expect(dayLabel(new Date('2026-02-16T00:00:00'), now)).toBe('Yesterday');
  });
  it('returns formatted date for other days', () => {
    const label = dayLabel(new Date('2026-02-20T00:00:00'), now);
    expect(label).toContain('Feb');
    expect(label).toContain('20');
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// deduplicateEvents
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('deduplicateEvents', () => {
  it('removes duplicates by id', () => {
    const events = [
      makeEvent('A', '2026-02-17T09:00:00', '2026-02-17T10:00:00', { id: 'x1' }),
      makeEvent('A', '2026-02-17T09:00:00', '2026-02-17T10:00:00', { id: 'x1' }),
    ];
    expect(deduplicateEvents(events)).toHaveLength(1);
  });

  it('removes duplicates by summary+time fallback', () => {
    const events = [
      { summary: 'Standup', start: { dateTime: '2026-02-17T09:00:00' }, end: { dateTime: '2026-02-17T09:15:00' } },
      { summary: 'Standup', start: { dateTime: '2026-02-17T09:01:00' }, end: { dateTime: '2026-02-17T09:16:00' } },
    ];
    expect(deduplicateEvents(events)).toHaveLength(1);
  });

  it('keeps events with different times', () => {
    const events = [
      makeEvent('Standup', '2026-02-17T09:00:00', '2026-02-17T09:15:00', { id: 'a' }),
      makeEvent('Standup', '2026-02-18T09:00:00', '2026-02-18T09:15:00', { id: 'b' }),
    ];
    expect(deduplicateEvents(events)).toHaveLength(2);
  });

  it('handles empty input', () => {
    expect(deduplicateEvents([])).toEqual([]);
    expect(deduplicateEvents(null)).toEqual([]);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// enrichEvent
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('enrichEvent', () => {
  it('marks a past event correctly', () => {
    const now = new Date('2026-02-17T12:00:00');
    const ev = makeEvent('Standup', '2026-02-17T09:00:00', '2026-02-17T09:15:00');
    const enriched = enrichEvent(ev, now);
    expect(enriched.status).toBe('past');
    expect(enriched.endedAgoMs).toBeGreaterThan(0);
    expect(enriched.endedAgo).toContain('ago');
  });

  it('marks a current event correctly', () => {
    const now = new Date('2026-02-17T14:15:00');
    const ev = makeEvent('Sprint Planning', '2026-02-17T14:00:00', '2026-02-17T15:00:00');
    const enriched = enrichEvent(ev, now);
    expect(enriched.status).toBe('current');
    expect(enriched.percentComplete).toBe(25);
    expect(enriched.startedAgo).toContain('15 minutes ago');
    expect(enriched.endsIn).toContain('45 minutes');
  });

  it('marks an upcoming event correctly', () => {
    const now = new Date('2026-02-17T08:00:00');
    const ev = makeEvent('Standup', '2026-02-17T09:00:00', '2026-02-17T09:15:00');
    const enriched = enrichEvent(ev, now);
    expect(enriched.status).toBe('upcoming');
    expect(enriched.startsInMs).toBe(3600000);
    expect(enriched.startsIn).toContain('1 hour');
  });

  it('computes duration correctly', () => {
    const now = new Date('2026-02-17T08:00:00');
    const ev = makeEvent('Long Meeting', '2026-02-17T10:00:00', '2026-02-17T11:30:00');
    const enriched = enrichEvent(ev, now);
    expect(enriched.durationMinutes).toBe(90);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// isEventInRange
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('isEventInRange', () => {
  it('returns true when event is within range', () => {
    const ev = makeEvent('Test', '2026-02-17T09:00:00', '2026-02-17T10:00:00');
    expect(isEventInRange(ev, new Date('2026-02-17T00:00:00'), new Date('2026-02-17T23:59:59'))).toBe(true);
  });

  it('returns false when event is outside range', () => {
    const ev = makeEvent('Test', '2026-02-18T09:00:00', '2026-02-18T10:00:00');
    expect(isEventInRange(ev, new Date('2026-02-17T00:00:00'), new Date('2026-02-17T23:59:59'))).toBe(false);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// findConflicts
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('findConflicts', () => {
  it('detects overlapping events', () => {
    const conflicts = findConflicts(TUESDAY_EVENTS);
    expect(conflicts).toHaveLength(1);
    const names = conflicts[0].events.map((e) => e.summary);
    expect(names).toContain('Sprint Planning');
    expect(names).toContain('1:1 with John');
    expect(conflicts[0].overlapMinutes).toBe(30);
  });

  it('returns empty for no overlaps', () => {
    const events = [
      makeEvent('A', '2026-02-17T09:00:00', '2026-02-17T10:00:00'),
      makeEvent('B', '2026-02-17T10:00:00', '2026-02-17T11:00:00'),
    ];
    expect(findConflicts(events)).toHaveLength(0);
  });

  it('detects contained events', () => {
    const events = [
      makeEvent('Long', '2026-02-17T09:00:00', '2026-02-17T12:00:00'),
      makeEvent('Short', '2026-02-17T10:00:00', '2026-02-17T10:30:00'),
    ];
    const conflicts = findConflicts(events);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].overlapMinutes).toBe(30);
  });

  it('ignores all-day events', () => {
    const events = [
      makeEvent('Holiday', '2026-02-17', '2026-02-18', { allDay: true }),
      makeEvent('Meeting', '2026-02-17T09:00:00', '2026-02-17T10:00:00'),
    ];
    expect(findConflicts(events)).toHaveLength(0);
  });

  it('handles empty and single-event arrays', () => {
    expect(findConflicts([])).toHaveLength(0);
    expect(findConflicts([TUESDAY_EVENTS[0]])).toHaveLength(0);
  });

  it('includes a human-readable description', () => {
    const conflicts = findConflicts(TUESDAY_EVENTS);
    expect(conflicts[0].description).toContain('Sprint Planning');
    expect(conflicts[0].description).toContain('1:1 with John');
    expect(conflicts[0].description).toContain('30 min');
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// findFreeSlots
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('findFreeSlots', () => {
  const dayStart = new Date('2026-02-17T00:00:00');
  const dayEnd = new Date('2026-02-17T23:59:59');

  it('finds gaps between events', () => {
    const slots = findFreeSlots(TUESDAY_EVENTS, dayStart, dayEnd);
    expect(slots.length).toBeGreaterThanOrEqual(2);
    // Should find gap between standup end (9:15) and sprint planning (14:00)
    const bigGap = slots.find((s) => s.durationMinutes > 200);
    expect(bigGap).toBeDefined();
  });

  it('returns full working day when no events', () => {
    const slots = findFreeSlots([], dayStart, dayEnd);
    expect(slots).toHaveLength(1);
    expect(slots[0].durationMinutes).toBe(600); // 10 hours (8am-6pm)
  });

  it('respects working hours', () => {
    const events = [
      makeEvent('Early', '2026-02-17T06:00:00', '2026-02-17T07:00:00'),
      makeEvent('Late', '2026-02-17T20:00:00', '2026-02-17T21:00:00'),
    ];
    const slots = findFreeSlots(events, dayStart, dayEnd);
    // Should not include before 8am or after 6pm
    for (const slot of slots) {
      expect(slot.start.getHours()).toBeGreaterThanOrEqual(8);
      expect(slot.end.getHours()).toBeLessThanOrEqual(18);
    }
  });

  it('merges overlapping busy intervals', () => {
    const events = [
      makeEvent('A', '2026-02-17T09:00:00', '2026-02-17T10:30:00'),
      makeEvent('B', '2026-02-17T10:00:00', '2026-02-17T11:00:00'),
    ];
    const slots = findFreeSlots(events, dayStart, dayEnd);
    // 8-9, 11-18 = two free slots
    expect(slots).toHaveLength(2);
  });

  it('ignores tiny gaps under 15 minutes', () => {
    const events = [
      makeEvent('A', '2026-02-17T09:00:00', '2026-02-17T09:50:00'),
      makeEvent('B', '2026-02-17T10:00:00', '2026-02-17T11:00:00'),
    ];
    const slots = findFreeSlots(events, dayStart, dayEnd);
    const tinyGap = slots.find((s) => s.durationMinutes === 10);
    expect(tinyGap).toBeUndefined();
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// getNextEvent
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('getNextEvent', () => {
  it('finds the nearest upcoming event', () => {
    const now = new Date('2026-02-17T10:00:00');
    const next = getNextEvent(TUESDAY_EVENTS, now);
    expect(next).not.toBeNull();
    expect(next.event.summary).toBe('Sprint Planning');
  });

  it('skips events in the past', () => {
    const now = new Date('2026-02-17T15:30:00');
    const next = getNextEvent(TUESDAY_EVENTS, now);
    expect(next.event.summary).toBe('Team Retro');
  });

  it('returns null when no upcoming events', () => {
    const now = new Date('2026-02-17T20:00:00');
    expect(getNextEvent(TUESDAY_EVENTS, now)).toBeNull();
  });

  it('returns null for empty events', () => {
    expect(getNextEvent([], new Date())).toBeNull();
  });

  it('skips all-day events', () => {
    const events = [
      makeEvent('Holiday', '2026-02-17', '2026-02-18', { allDay: true }),
      makeEvent('Meeting', '2026-02-17T14:00:00', '2026-02-17T15:00:00'),
    ];
    const now = new Date('2026-02-17T10:00:00');
    const next = getNextEvent(events, now);
    expect(next.event.summary).toBe('Meeting');
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// analyzeDay
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('analyzeDay', () => {
  describe('temporal bucketing', () => {
    it('classifies past, current, and upcoming at mid-morning', () => {
      const now = new Date('2026-02-17T10:00:00');
      const day = analyzeDay(TUESDAY_EVENTS, FEB_17, now);

      expect(day.past).toHaveLength(1); // Standup is over
      expect(day.past[0].event.summary).toBe('Standup');
      expect(day.current).toBeNull(); // Nothing at 10am
      expect(day.remaining).toHaveLength(3);
      expect(day.next.event.summary).toBe('Sprint Planning');
    });

    it('classifies current event during a meeting', () => {
      const now = new Date('2026-02-17T14:15:00');
      const day = analyzeDay(TUESDAY_EVENTS, FEB_17, now);

      expect(day.current).not.toBeNull();
      expect(day.current.event.summary).toBe('Sprint Planning');
      expect(day.current.percentComplete).toBe(25);
    });

    it('handles all events past at end of day', () => {
      const now = new Date('2026-02-17T20:00:00');
      const day = analyzeDay(TUESDAY_EVENTS, FEB_17, now);

      expect(day.past).toHaveLength(4);
      expect(day.current).toBeNull();
      expect(day.remaining).toHaveLength(0);
      expect(day.next).toBeNull();
    });

    it('handles all events upcoming at start of day', () => {
      const now = new Date('2026-02-17T07:00:00');
      const day = analyzeDay(TUESDAY_EVENTS, FEB_17, now);

      expect(day.past).toHaveLength(0);
      expect(day.remaining).toHaveLength(4);
      expect(day.next.event.summary).toBe('Standup');
      expect(day.next.isFirstOfDay).toBe(true);
    });
  });

  describe('metadata', () => {
    it('sets correct label and flags for today', () => {
      const now = new Date('2026-02-17T10:00:00');
      const day = analyzeDay(TUESDAY_EVENTS, FEB_17, now);

      expect(day.label).toBe('Today');
      expect(day.isToday).toBe(true);
      expect(day.isPast).toBe(false);
      expect(day.isFuture).toBe(false);
      expect(day.dateStr).toBe('2026-02-17');
    });

    it('sets correct label for tomorrow', () => {
      const now = new Date('2026-02-16T10:00:00');
      const day = analyzeDay(TUESDAY_EVENTS, FEB_17, now);

      expect(day.label).toBe('Tomorrow');
      expect(day.isToday).toBe(false);
      expect(day.isFuture).toBe(true);
    });

    it('sets correct firstOfDay and lastOfDay', () => {
      const now = new Date('2026-02-17T10:00:00');
      const day = analyzeDay(TUESDAY_EVENTS, FEB_17, now);

      expect(day.firstOfDay.event.summary).toBe('Standup');
      expect(day.lastOfDay.event.summary).toBe('Team Retro');
    });
  });

  describe('conflicts', () => {
    it('detects conflicts within the day', () => {
      const now = new Date('2026-02-17T10:00:00');
      const day = analyzeDay(TUESDAY_EVENTS, FEB_17, now);

      expect(day.conflicts).toHaveLength(1);
      expect(day.summary.hasConflicts).toBe(true);
      expect(day.summary.conflictCount).toBe(1);
    });

    it('reports zero conflicts on a clean day', () => {
      const events = [
        makeEvent('A', '2026-02-17T09:00:00', '2026-02-17T10:00:00'),
        makeEvent('B', '2026-02-17T11:00:00', '2026-02-17T12:00:00'),
      ];
      const now = new Date('2026-02-17T08:00:00');
      const day = analyzeDay(events, FEB_17, now);

      expect(day.conflicts).toHaveLength(0);
      expect(day.summary.hasConflicts).toBe(false);
    });
  });

  describe('free slots', () => {
    it('computes free slots within working hours', () => {
      const now = new Date('2026-02-17T08:00:00');
      const day = analyzeDay(TUESDAY_EVENTS, FEB_17, now);

      expect(day.freeSlots.length).toBeGreaterThanOrEqual(2);
      expect(day.summary.freeMinutes).toBeGreaterThan(0);
    });
  });

  describe('summary stats', () => {
    it('computes correct counts', () => {
      const now = new Date('2026-02-17T10:00:00');
      const day = analyzeDay(TUESDAY_EVENTS, FEB_17, now);

      expect(day.summary.total).toBe(4);
      expect(day.summary.pastCount).toBe(1);
      expect(day.summary.remainingCount).toBe(3);
      expect(day.summary.busyMinutes).toBeGreaterThan(0);
    });

    it('handles empty calendar', () => {
      const now = new Date('2026-02-17T10:00:00');
      const day = analyzeDay([], FEB_17, now);

      expect(day.summary.total).toBe(0);
      expect(day.past).toHaveLength(0);
      expect(day.current).toBeNull();
      expect(day.next).toBeNull();
      expect(day.remaining).toHaveLength(0);
      expect(day.firstOfDay).toBeNull();
      expect(day.lastOfDay).toBeNull();
      expect(day.conflicts).toHaveLength(0);
    });
  });

  describe('event filtering', () => {
    it('only includes events for the target day', () => {
      const events = [
        makeEvent('Yesterday', '2026-02-16T09:00:00', '2026-02-16T10:00:00'),
        makeEvent('Today', '2026-02-17T09:00:00', '2026-02-17T10:00:00'),
        makeEvent('Tomorrow', '2026-02-18T09:00:00', '2026-02-18T10:00:00'),
      ];
      const now = new Date('2026-02-17T08:00:00');
      const day = analyzeDay(events, FEB_17, now);

      expect(day.summary.total).toBe(1);
      expect(day.all[0].event.summary).toBe('Today');
    });

    it('deduplicates events', () => {
      const events = [
        makeEvent('Dup', '2026-02-17T09:00:00', '2026-02-17T10:00:00', { id: 'same' }),
        makeEvent('Dup', '2026-02-17T09:00:00', '2026-02-17T10:00:00', { id: 'same' }),
      ];
      const now = new Date('2026-02-17T08:00:00');
      const day = analyzeDay(events, FEB_17, now);
      expect(day.summary.total).toBe(1);
    });
  });

  describe('edge case: event ending exactly at now', () => {
    it('marks event as past when endTime equals now', () => {
      const ev = makeEvent('Just Ended', '2026-02-17T09:00:00', '2026-02-17T10:00:00');
      const now = new Date('2026-02-17T10:00:00');
      const day = analyzeDay([ev], FEB_17, now);
      expect(day.past).toHaveLength(1);
      expect(day.current).toBeNull();
    });
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// analyzeWeek
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('analyzeWeek', () => {
  const WEEK_EVENTS = [
    ...TUESDAY_EVENTS,
    makeEvent('Wednesday Sync', '2026-02-18T10:00:00', '2026-02-18T11:00:00'),
    makeEvent('Thursday 1:1', '2026-02-19T14:00:00', '2026-02-19T14:30:00'),
    makeEvent('Friday Demo', '2026-02-20T15:00:00', '2026-02-20T16:00:00'),
  ];

  // Week starting Monday Feb 16
  const WEEK_START = new Date('2026-02-16T00:00:00');
  const NOW = new Date('2026-02-17T10:00:00');

  it('returns 7 day analyses', () => {
    const week = analyzeWeek(WEEK_EVENTS, WEEK_START, NOW);
    expect(week.days).toHaveLength(7);
  });

  it('aggregates total events across the week', () => {
    const week = analyzeWeek(WEEK_EVENTS, WEEK_START, NOW);
    expect(week.summary.totalEvents).toBe(7);
  });

  it('identifies busiest and lightest days', () => {
    const week = analyzeWeek(WEEK_EVENTS, WEEK_START, NOW);
    expect(week.busiestDay.eventCount).toBe(4); // Tuesday
    expect(week.summary.busiestDay).toBe('Today'); // Feb 17 is "Today"
  });

  it('lists empty days', () => {
    const week = analyzeWeek(WEEK_EVENTS, WEEK_START, NOW);
    expect(week.summary.emptyDays.length).toBeGreaterThan(0);
  });

  it('flattens conflicts from all days', () => {
    const week = analyzeWeek(WEEK_EVENTS, WEEK_START, NOW);
    expect(week.allConflicts).toHaveLength(1); // Only Tuesday has a conflict
    expect(week.summary.totalConflicts).toBe(1);
  });

  it('sets correct label', () => {
    const week = analyzeWeek(WEEK_EVENTS, WEEK_START, NOW);
    expect(week.label).toBe('This Week');
  });

  it('labels next week correctly', () => {
    const nextWeekStart = new Date('2026-02-23T00:00:00');
    const week = analyzeWeek([], nextWeekStart, NOW);
    expect(week.label).toBe('Next Week');
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// analyzeMonth
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('analyzeMonth', () => {
  const MONTH_START = new Date('2026-02-01T00:00:00');
  const NOW = new Date('2026-02-17T10:00:00');

  it('returns correct number of days for February', () => {
    const month = analyzeMonth(TUESDAY_EVENTS, MONTH_START, NOW);
    expect(month.daysInMonth).toBe(28);
    expect(month.days).toHaveLength(28);
  });

  it('returns correct number of days for March', () => {
    const marchStart = new Date('2026-03-01T00:00:00');
    const month = analyzeMonth([], marchStart, NOW);
    expect(month.daysInMonth).toBe(31);
    expect(month.days).toHaveLength(31);
  });

  it('labels current month correctly', () => {
    const month = analyzeMonth(TUESDAY_EVENTS, MONTH_START, NOW);
    expect(month.label).toBe('This Month');
  });

  it('labels other months by name', () => {
    const marchStart = new Date('2026-03-01T00:00:00');
    const month = analyzeMonth([], marchStart, NOW);
    expect(month.label).toContain('March');
  });

  it('aggregates events correctly', () => {
    const month = analyzeMonth(TUESDAY_EVENTS, MONTH_START, NOW);
    expect(month.summary.totalEvents).toBe(4); // All on Feb 17
    expect(month.summary.daysWithEvents).toBe(1);
  });
});
