/**
 * CalendarStore: conflict vs back-to-back semantics + the live-first merge
 * policy (2026-09-15).
 *
 *  - generateMorningBrief() must not count an overlap as a back-to-back.
 *  - blocks / declined invites are neither.
 *  - `includeLocal: false` keeps the app-local store's rows (the stale
 *    Feb-2026 "standup" test events) out of the merge.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('fs', () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => '[]'),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));
vi.mock('../../lib/log-event-queue', () => ({
  getLogQueue: vi.fn(() => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() })),
}));

const { CalendarStore } = require('../../lib/calendar-store');

function makeEvent(title, hh, mm, endHh, endMm, opts = {}) {
  const start = new Date(2026, 8, 15, hh, mm, 0, 0);
  const end = new Date(2026, 8, 15, endHh, endMm, 0, 0);
  return {
    id: opts.id || `evt_${title.replace(/\s+/g, '-')}`,
    title,
    description: '',
    location: opts.location || '',
    startTime: start.toISOString(),
    endTime: end.toISOString(),
    allDay: false,
    recurring: null,
    isRecurringInstance: false,
    parentEventId: null,
    reminders: [],
    guests: opts.guests || [],
    selfDeclined: !!opts.selfDeclined,
    calendar: 'personal',
    source: opts.source || 'local',
    color: null,
    created: '',
    updated: '',
    exceptions: [],
    overrides: {},
  };
}

function storeWith(events) {
  const store = new CalendarStore();
  store._events = events;
  store._loaded = true;
  store._dirty = false;
  store.save = vi.fn();
  return store;
}

const omnical = (title, hh, mm, endHh, endMm, extra = {}) => ({
  id: `live_${title.replace(/\s+/g, '-')}`,
  summary: title,
  start: { dateTime: new Date(2026, 8, 15, hh, mm).toISOString() },
  end: { dateTime: new Date(2026, 8, 15, endHh, endMm).toISOString() },
  ...extra,
});

describe('generateMorningBrief: overlaps are conflicts, not back-to-backs', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 15, 7, 25, 0)); // 7:25 AM, before everything
  });
  afterEach(() => vi.useRealTimers());

  it('THE REGRESSION: today with the two stale local standups merged in', () => {
    const store = storeWith([makeEvent('standup', 9, 0, 9, 15), makeEvent('daily standup', 9, 0, 9, 15)]);
    const live = [
      omnical('Think Tank - Pod leaders meeting', 9, 0, 10, 0),
      omnical('Library sync-up', 10, 0, 10, 50),
      omnical('Account Strategy Meetings', 12, 0, 13, 0),
      omnical("Don’t book", 15, 0, 17, 30),
    ];
    const brief = store.generateMorningBrief(new Date(2026, 8, 15), live);

    expect(brief.conflicts).toHaveLength(3);
    expect(brief.backToBack).toHaveLength(1);
    expect(brief.backToBack[0]).toMatchObject({
      first: 'Think Tank - Pod leaders meeting',
      second: 'Library sync-up',
      transitionTime: '10:00 AM',
      gapMinutes: 0,
    });
    // The overlapping pair is never ALSO a back-to-back.
    expect(brief.backToBack.some((p) => p.first === 'standup' || p.second === 'standup')).toBe(false);
    // Conflicts carry both names + the overlap.
    expect(brief.conflicts.map((c) => [c.event1, c.event2, c.overlapMinutes])).toContainEqual(['standup', 'daily standup', 15]);
    // Timeline rows carry ISO times for downstream compression.
    expect(brief.timeline[0].startISO).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('includeLocal:false leaves the app-local rows out -> no phantom conflicts', () => {
    const store = storeWith([makeEvent('standup', 9, 0, 9, 15), makeEvent('daily standup', 9, 0, 9, 15)]);
    const live = [omnical('Think Tank - Pod leaders meeting', 9, 0, 10, 0), omnical('Library sync-up', 10, 0, 10, 50)];
    const brief = store.generateMorningBrief(new Date(2026, 8, 15), live, { includeLocal: false });

    expect(brief.timeline.map((e) => e.title)).toEqual(['Think Tank - Pod leaders meeting', 'Library sync-up']);
    expect(brief.conflicts).toHaveLength(0);
    expect(brief.backToBack).toHaveLength(1);
    expect(brief.summary.timedEvents).toBe(2);
  });

  it('default keeps local rows (backward compatible)', () => {
    const store = storeWith([makeEvent('standup', 9, 0, 9, 15)]);
    const brief = store.generateMorningBrief(new Date(2026, 8, 15), []);
    expect(brief.timeline.map((e) => e.title)).toEqual(['standup']);
  });

  it('a block overlapping a meeting is not a conflict; declined invites are ignored too', () => {
    const store = storeWith([]);
    const live = [
      omnical("Don’t book", 9, 0, 10, 30),
      omnical('Real meeting', 10, 0, 11, 0),
      omnical('Declined', 10, 0, 11, 0, { attendees: [{ email: 'me@x.com', self: true, responseStatus: 'declined' }] }),
      omnical('Follow-up', 11, 0, 11, 30),
    ];
    const brief = store.generateMorningBrief(new Date(2026, 8, 15), live);
    expect(brief.conflicts).toHaveLength(0);
    expect(brief.backToBack.map((p) => `${p.first}>${p.second}`)).toEqual(['Real meeting>Follow-up']);
  });

  it('findDayConflicts and _findBackToBack share the definition', () => {
    const store = storeWith([makeEvent('A', 9, 0, 10, 0), makeEvent('B', 9, 30, 10, 30), makeEvent('C', 10, 30, 11, 0)]);
    const conflicts = store.findDayConflicts(new Date(2026, 8, 15));
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].event1.title).toBe('A');
    expect(conflicts[0].overlapMinutes).toBe(30);
    const pairs = store._findBackToBack(store.getEventsForDay(new Date(2026, 8, 15)));
    expect(pairs.map(([a, b]) => `${a.title}>${b.title}`)).toEqual(['B>C']);
  });
});
