/**
 * Regression: external (Omnical/cache) events must be range-filtered in
 * getEventsInRange, exactly like internal events.
 *
 * The "54 meetings today" fabrication: calendar-fetch always returns a 14-day
 * window and, when Omnical is offline, returns the WHOLE multi-day stale cache.
 * getEventsForDay(today, cache) then merged every cached day into "today"
 * because external events skipped the [rangeStart,rangeEnd] overlap check that
 * internal events go through. This locks the fix.
 *
 * Run: npx vitest run test/unit/calendar-store-external-range.test.js
 */

import { describe, it, expect, beforeEach } from 'vitest';

const { CalendarStore } = require('../../lib/calendar-store');

function isoAt(dayOffset, hour) {
  // A fixed base date so the test is deterministic regardless of "now".
  const base = new Date('2026-07-02T00:00:00');
  const d = new Date(base.getTime() + dayOffset * 24 * 60 * 60 * 1000);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
}

function extEvent(id, summary, dayOffset, hour) {
  return {
    id,
    summary,
    start: { dateTime: isoAt(dayOffset, hour) },
    end: { dateTime: isoAt(dayOffset, hour + 1) },
  };
}

describe('getEventsInRange range-filters external events', () => {
  let store;
  const dayStart = new Date('2026-07-02T00:00:00');
  const dayEnd = new Date('2026-07-02T23:59:59');

  beforeEach(() => {
    store = new CalendarStore();
    store._loaded = true; // skip disk load
    store._events = []; // no internal events; isolate the external-merge path
  });

  it('keeps only today\'s external events, drops the rest of a 14-day cache', () => {
    // Simulate the offline stale cache: 14 days of events, only 3 are "today".
    const cache = [];
    cache.push(extEvent('t1', 'Standup', 0, 9));
    cache.push(extEvent('t2', 'Marcus 1:1', 0, 11));
    cache.push(extEvent('t3', 'Demo', 0, 14));
    for (let d = 1; d < 14; d++) {
      cache.push(extEvent(`d${d}a`, `Future ${d}a`, d, 10));
      cache.push(extEvent(`d${d}b`, `Future ${d}b`, d, 15));
    }
    expect(cache.length).toBe(3 + 13 * 2); // 29 in the cache

    const today = store.getEventsInRange(dayStart, dayEnd, cache);

    // Before the fix this returned all 29; now only today's 3.
    expect(today.map((e) => e.title).sort()).toEqual(['Demo', 'Marcus 1:1', 'Standup']);
    expect(today.length).toBe(3);
  });

  it('an all-today external set is unchanged', () => {
    const cache = [extEvent('a', 'A', 0, 9), extEvent('b', 'B', 0, 13)];
    const today = store.getEventsInRange(dayStart, dayEnd, cache);
    expect(today.length).toBe(2);
  });

  it('an external set entirely outside the range yields nothing', () => {
    const cache = [extEvent('x', 'X', 5, 9), extEvent('y', 'Y', 9, 13)];
    const today = store.getEventsInRange(dayStart, dayEnd, cache);
    expect(today.length).toBe(0);
  });

  it('getEventsForDay(today, cache) counts only today (the brief timeline source)', () => {
    const cache = [
      extEvent('t', 'Today', 0, 10),
      extEvent('tomorrow', 'Tomorrow', 1, 10),
      extEvent('nextweek', 'Next week', 7, 10),
    ];
    const day = store.getEventsForDay(new Date('2026-07-02T08:00:00'), cache);
    expect(day.map((e) => e.title)).toEqual(['Today']);
  });
});
