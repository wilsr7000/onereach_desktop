/**
 * Calendar Pipeline Integration Tests
 *
 * These tests connect real producers to real consumers with NO mocks.
 * They verify that the data shapes returned by calendar-data.js functions
 * are correctly consumed by calendar-format.js and calendar-query-agent helpers.
 *
 * This prevents the class of bug where unit tests with hand-written fixtures
 * pass while the real pipeline is broken due to contract mismatches.
 */

import { describe, it, expect } from 'vitest';
import { analyzeDay, analyzeWeek, getNextEvent, findConflicts, findFreeSlots } from '../../lib/calendar-data.js';
import {
  buildDayUISpec,
  spokenDaySummary,
  formatEventTime,
  extractMeetingLink,
} from '../../lib/calendar-format.js';

// ─── Test Data ──────────────────────────────────────────────────────────────

const FEB_16 = new Date('2026-02-16T00:00:00');

function makeEvent(summary, startHour, endHour, opts = {}) {
  const date = opts.date || '2026-02-16';
  return {
    id: `evt-${summary.toLowerCase().replace(/\s/g, '-')}`,
    summary,
    start: { dateTime: `${date}T${String(startHour).padStart(2, '0')}:00:00` },
    end: { dateTime: `${date}T${String(endHour).padStart(2, '0')}:00:00` },
    attendees: opts.attendees || [],
    hangoutLink: opts.hangoutLink || undefined,
    conferenceData: opts.conferenceData || undefined,
    recurringEventId: opts.recurringEventId || undefined,
  };
}

const EVENTS = [
  makeEvent('Standup', 9, 10),
  makeEvent('Sprint Planning', 10, 11),
  makeEvent('Lunch', 12, 13),
  makeEvent('Design Review', 14, 15, { hangoutLink: 'https://meet.google.com/abc-def' }),
  makeEvent('Retrospective', 16, 17),
];

const CONFLICTING_EVENTS = [
  makeEvent('Meeting A', 10, 11),
  makeEvent('Meeting B', 10, 12),
  makeEvent('Meeting C', 14, 15),
];

// ─── analyzeDay → buildDayUISpec ────────────────────────────────────────────

describe('analyzeDay → buildDayUISpec', () => {
  it('handles empty calendar', () => {
    const day = analyzeDay([], FEB_16, new Date('2026-02-16T09:00:00'));
    const spec = buildDayUISpec(day);
    expect(spec.type).toBe('eventList');
    expect(spec.events).toHaveLength(0);
  });

  it('handles all events upcoming', () => {
    const now = new Date('2026-02-16T08:00:00');
    const day = analyzeDay(EVENTS, FEB_16, now);
    const spec = buildDayUISpec(day);
    expect(spec.events).toHaveLength(5);
    expect(spec.events.every((e) => typeof e.title === 'string')).toBe(true);
    expect(spec.events.every((e) => typeof e.time === 'string')).toBe(true);
  });

  it('handles a meeting in progress', () => {
    const now = new Date('2026-02-16T09:30:00');
    const day = analyzeDay(EVENTS, FEB_16, now);
    expect(day.current).not.toBeNull();
    expect(day.current.event.summary).toBe('Standup');

    const spec = buildDayUISpec(day);
    expect(spec.events[0].status).toBe('current');
    expect(spec.events[0].title).toBe('Standup');
  });

  it('handles all events past', () => {
    const now = new Date('2026-02-16T18:00:00');
    const day = analyzeDay(EVENTS, FEB_16, now);
    expect(day.current).toBeNull();
    expect(day.remaining).toHaveLength(0);
    expect(day.past).toHaveLength(5);

    const spec = buildDayUISpec(day);
    expect(spec.events).toHaveLength(5);
  });

  it('preserves label and summary from analyzeDay', () => {
    const now = new Date('2026-02-16T09:30:00');
    const day = analyzeDay(EVENTS, FEB_16, now);
    const spec = buildDayUISpec(day);
    expect(spec.title).toBeTruthy();
    expect(spec.summary).toBeDefined();
    expect(spec.summary.total).toBe(5);
  });
});

// ─── analyzeDay → spokenDaySummary ──────────────────────────────────────────

describe('analyzeDay → spokenDaySummary', () => {
  it('reports clear calendar for empty day', () => {
    const day = analyzeDay([], FEB_16, new Date('2026-02-16T09:00:00'));
    const spoken = spokenDaySummary(day);
    expect(spoken).toContain('clear');
  });

  it('mentions current meeting when one is in progress', () => {
    const now = new Date('2026-02-16T09:30:00');
    const day = analyzeDay(EVENTS, FEB_16, now);
    const spoken = spokenDaySummary(day);
    expect(spoken).toContain('currently in');
    expect(spoken).toContain('Standup');
  });

  it('mentions next meeting when none is in progress', () => {
    const now = new Date('2026-02-16T08:00:00');
    const day = analyzeDay(EVENTS, FEB_16, now);
    const spoken = spokenDaySummary(day);
    expect(spoken).toContain('Standup');
  });

  it('handles day with all events past', () => {
    const now = new Date('2026-02-16T18:00:00');
    const day = analyzeDay(EVENTS, FEB_16, now);
    const spoken = spokenDaySummary(day);
    expect(typeof spoken).toBe('string');
    expect(spoken.length).toBeGreaterThan(0);
  });

  it('mentions conflicts when present', () => {
    const now = new Date('2026-02-16T08:00:00');
    const day = analyzeDay(CONFLICTING_EVENTS, FEB_16, now);
    const spoken = spokenDaySummary(day);
    expect(spoken).toContain('conflict');
  });
});

// ─── getNextEvent contract ──────────────────────────────────────────────────

describe('getNextEvent → consumer contract', () => {
  it('returns enriched event with .event sub-object', () => {
    const now = new Date('2026-02-16T08:00:00');
    const next = getNextEvent(EVENTS, now);
    expect(next).not.toBeNull();

    // Enriched event shape
    expect(next.event).toBeDefined();
    expect(next.event.summary).toBe('Standup');
    expect(next.startTime).toBeInstanceOf(Date);
    expect(next.endTime).toBeInstanceOf(Date);
    expect(typeof next.status).toBe('string');
  });

  it('works with formatEventTime (needs raw event)', () => {
    const now = new Date('2026-02-16T08:00:00');
    const next = getNextEvent(EVENTS, now);
    const time = formatEventTime(next.event);
    expect(typeof time).toBe('string');
    expect(time).not.toBe('TBD');
  });

  it('works with extractMeetingLink (needs raw event)', () => {
    const now = new Date('2026-02-16T13:30:00');
    const next = getNextEvent(EVENTS, now);
    expect(next.event.summary).toBe('Design Review');

    const link = extractMeetingLink(next.event);
    expect(link.url).toContain('meet.google.com');
  });

  it('returns null when no upcoming events', () => {
    const now = new Date('2026-02-16T18:00:00');
    const next = getNextEvent(EVENTS, now);
    expect(next).toBeNull();
  });
});

// ─── findConflicts contract ─────────────────────────────────────────────────

describe('findConflicts → consumer contract', () => {
  it('returns array of conflict objects with .events property', () => {
    const conflicts = findConflicts(CONFLICTING_EVENTS);
    expect(conflicts.length).toBeGreaterThan(0);

    for (const conflict of conflicts) {
      expect(conflict.events).toBeDefined();
      expect(Array.isArray(conflict.events)).toBe(true);
      expect(conflict.events.length).toBe(2);
      expect(conflict.events[0].summary).toBeDefined();
      expect(conflict.events[1].summary).toBeDefined();
      expect(typeof conflict.overlapMinutes).toBe('number');
    }
  });

  it('conflict events work with formatEventTime', () => {
    const conflicts = findConflicts(CONFLICTING_EVENTS);
    for (const conflict of conflicts) {
      const [a] = conflict.events;
      const time = formatEventTime(a);
      expect(typeof time).toBe('string');
    }
  });

  it('returns empty array for non-conflicting events', () => {
    const conflicts = findConflicts(EVENTS);
    expect(conflicts).toHaveLength(0);
  });
});

// ─── findFreeSlots contract ─────────────────────────────────────────────────

describe('findFreeSlots → consumer contract', () => {
  it('returns slots with start/end Date objects', () => {
    const dayStart = new Date('2026-02-16T08:00:00');
    const dayEnd = new Date('2026-02-16T18:00:00');
    const slots = findFreeSlots(EVENTS, dayStart, dayEnd);

    expect(slots.length).toBeGreaterThan(0);
    for (const slot of slots) {
      expect(slot.start).toBeInstanceOf(Date);
      expect(slot.end).toBeInstanceOf(Date);
      expect(typeof slot.durationMinutes).toBe('number');
      expect(slot.durationMinutes).toBeGreaterThan(0);
    }
  });
});

// ─── analyzeWeek → buildDayUISpec per day ───────────────────────────────────

describe('analyzeWeek integration', () => {
  it('each day in week analysis works with buildDayUISpec', () => {
    const weekStart = new Date('2026-02-16T00:00:00');
    const now = new Date('2026-02-16T09:00:00');
    const week = analyzeWeek(EVENTS, weekStart, now);

    expect(week.days).toHaveLength(7);
    for (const day of week.days) {
      const spec = buildDayUISpec(day);
      expect(spec.type).toBe('eventList');
      expect(Array.isArray(spec.events)).toBe(true);
    }
  });
});
