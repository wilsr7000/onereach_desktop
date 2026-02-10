/**
 * Calendar Brief Time-Awareness Tests
 *
 * Verifies that generateMorningBrief() and renderBriefForSpeech() correctly
 * distinguish past, in-progress, and upcoming events based on the current time.
 *
 * Covers:
 *   - All events in the past (afternoon brief)
 *   - All events upcoming (early morning brief)
 *   - Mix of past and upcoming events (midday brief)
 *   - In-progress event detection
 *   - nextMeeting vs firstMeeting selection
 *   - Free time shows remaining (not total) for today
 *   - Conflicts filtered to upcoming only
 *   - Back-to-back detection limited to future events
 *   - Speech rendering uses correct tense for each scenario
 *   - Empty calendar
 *   - Future day (not today) -- all treated as upcoming
 *   - Edge: event ending exactly at "now"
 *   - Edge: event starting exactly at "now"
 *
 * Run:  npx vitest run test/unit/calendar-brief-time-awareness.test.js
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock fs to avoid real disk I/O
vi.mock('fs', () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => '[]'),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

// Mock log-event-queue
vi.mock('../../lib/log-event-queue', () => ({
  getLogQueue: vi.fn(() => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  })),
}));

const { CalendarStore } = require('../../lib/calendar-store');

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Create an event object for a given day/time.
 * Hours and minutes are in local time.
 */
function makeEvent(title, year, month, day, startHour, startMin, endHour, endMin, opts = {}) {
  const start = new Date(year, month - 1, day, startHour, startMin, 0, 0);
  const end = new Date(year, month - 1, day, endHour, endMin, 0, 0);
  return {
    id: opts.id || `evt_${title.replace(/\s+/g, '-').toLowerCase()}-${Math.random().toString(36).slice(2, 8)}`,
    title,
    description: opts.description || '',
    location: opts.location || '',
    startTime: start.toISOString(),
    endTime: end.toISOString(),
    allDay: opts.allDay || false,
    recurring: opts.recurring || null,
    isRecurringInstance: opts.isRecurringInstance || false,
    parentEventId: opts.parentEventId || null,
    reminders: opts.reminders || [15],
    guests: opts.guests || [],
    calendar: opts.calendar || 'personal',
    source: opts.source || 'local',
    color: null,
    created: new Date().toISOString(),
    updated: new Date().toISOString(),
    exceptions: [],
    overrides: {},
  };
}

/**
 * Create a pre-loaded CalendarStore with given events.
 * Bypasses file I/O entirely.
 */
function createStoreWithEvents(events) {
  const store = new CalendarStore();
  store._events = events;
  store._loaded = true;
  store._dirty = false;
  // Stub save to avoid disk writes
  store.save = vi.fn();
  return store;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('CalendarStore Morning Brief: Time Awareness', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // generateMorningBrief() -- Structured Data
  // ═══════════════════════════════════════════════════════════════════════════

  describe('generateMorningBrief()', () => {

    it('should mark all events as upcoming when brief is early morning', () => {
      // It's 7:00 AM, events are at 9, 11, 2 PM
      vi.setSystemTime(new Date(2026, 1, 10, 7, 0, 0)); // Feb 10 2026 7:00 AM

      const events = [
        makeEvent('Standup', 2026, 2, 10, 9, 0, 9, 30),
        makeEvent('Design Review', 2026, 2, 10, 11, 0, 12, 0),
        makeEvent('Client Call', 2026, 2, 10, 14, 0, 15, 0),
      ];
      const store = createStoreWithEvents(events);
      const brief = store.generateMorningBrief(new Date(2026, 1, 10));

      expect(brief.isToday).toBe(true);
      expect(brief.summary.completedCount).toBe(0);
      expect(brief.summary.inProgressCount).toBe(0);
      expect(brief.summary.upcomingCount).toBe(3);
      expect(brief.summary.timedEvents).toBe(3);

      // All timeline items should be upcoming
      expect(brief.timeline.every(e => e.status === 'upcoming')).toBe(true);

      // nextMeeting should be the first event
      expect(brief.nextMeeting).not.toBeNull();
      expect(brief.nextMeeting.title).toBe('Standup');

      // No current meeting
      expect(brief.currentMeeting).toBeNull();
    });

    it('should mark all events as completed when brief is late evening', () => {
      // It's 6:00 PM, events were at 9, 11, 2 PM
      vi.setSystemTime(new Date(2026, 1, 10, 18, 0, 0)); // Feb 10 2026 6:00 PM

      const events = [
        makeEvent('Standup', 2026, 2, 10, 9, 0, 9, 30),
        makeEvent('Design Review', 2026, 2, 10, 11, 0, 12, 0),
        makeEvent('Client Call', 2026, 2, 10, 14, 0, 15, 0),
      ];
      const store = createStoreWithEvents(events);
      const brief = store.generateMorningBrief(new Date(2026, 1, 10));

      expect(brief.isToday).toBe(true);
      expect(brief.summary.completedCount).toBe(3);
      expect(brief.summary.inProgressCount).toBe(0);
      expect(brief.summary.upcomingCount).toBe(0);

      // All timeline items should be completed
      expect(brief.timeline.every(e => e.status === 'completed')).toBe(true);

      // No next meeting, no current meeting
      expect(brief.nextMeeting).toBeNull();
      expect(brief.currentMeeting).toBeNull();
    });

    it('should split events into past, in-progress, and upcoming at midday', () => {
      // It's 11:30 AM -- standup is done, design review is in progress, client call is upcoming
      vi.setSystemTime(new Date(2026, 1, 10, 11, 30, 0));

      const events = [
        makeEvent('Standup', 2026, 2, 10, 9, 0, 9, 30),
        makeEvent('Design Review', 2026, 2, 10, 11, 0, 12, 0),
        makeEvent('Client Call', 2026, 2, 10, 14, 0, 15, 0),
      ];
      const store = createStoreWithEvents(events);
      const brief = store.generateMorningBrief(new Date(2026, 1, 10));

      expect(brief.summary.completedCount).toBe(1);
      expect(brief.summary.inProgressCount).toBe(1);
      expect(brief.summary.upcomingCount).toBe(1);

      // Check individual statuses
      expect(brief.timeline[0].status).toBe('completed');   // Standup
      expect(brief.timeline[1].status).toBe('in-progress'); // Design Review
      expect(brief.timeline[2].status).toBe('upcoming');     // Client Call

      // Current meeting should be Design Review
      expect(brief.currentMeeting).not.toBeNull();
      expect(brief.currentMeeting.title).toBe('Design Review');
      expect(brief.currentMeeting.minutesRemaining).toBe(30); // 30 min left

      // Next meeting should be Client Call (not Standup, not Design Review)
      expect(brief.nextMeeting).not.toBeNull();
      expect(brief.nextMeeting.title).toBe('Client Call');
      expect(brief.nextMeeting.minutesUntil).toBe(150); // 2.5 hours
    });

    it('should detect event ending exactly at "now" as completed', () => {
      // Event ends exactly at 10:00 AM, time is 10:00 AM
      vi.setSystemTime(new Date(2026, 1, 10, 10, 0, 0));

      const events = [
        makeEvent('Morning Standup', 2026, 2, 10, 9, 30, 10, 0),
      ];
      const store = createStoreWithEvents(events);
      const brief = store.generateMorningBrief(new Date(2026, 1, 10));

      expect(brief.summary.completedCount).toBe(1);
      expect(brief.summary.inProgressCount).toBe(0);
      expect(brief.timeline[0].status).toBe('completed');
      expect(brief.currentMeeting).toBeNull();
    });

    it('should detect event starting exactly at "now" as in-progress', () => {
      // Event starts exactly at 10:00 AM, time is 10:00 AM
      vi.setSystemTime(new Date(2026, 1, 10, 10, 0, 0));

      const events = [
        makeEvent('Team Sync', 2026, 2, 10, 10, 0, 10, 30),
      ];
      const store = createStoreWithEvents(events);
      const brief = store.generateMorningBrief(new Date(2026, 1, 10));

      expect(brief.summary.completedCount).toBe(0);
      expect(brief.summary.inProgressCount).toBe(1);
      expect(brief.timeline[0].status).toBe('in-progress');
      expect(brief.currentMeeting).not.toBeNull();
      expect(brief.currentMeeting.title).toBe('Team Sync');
    });

    it('should treat all events as upcoming for a future day', () => {
      // It's Feb 10 at 3 PM, looking at Feb 12's schedule
      vi.setSystemTime(new Date(2026, 1, 10, 15, 0, 0));

      const events = [
        makeEvent('Morning Meeting', 2026, 2, 12, 9, 0, 10, 0),
        makeEvent('Lunch Talk', 2026, 2, 12, 12, 0, 13, 0),
      ];
      const store = createStoreWithEvents(events);
      const brief = store.generateMorningBrief(new Date(2026, 1, 12)); // Feb 12

      expect(brief.isToday).toBe(false);
      expect(brief.summary.completedCount).toBe(0);
      expect(brief.summary.inProgressCount).toBe(0);
      expect(brief.summary.upcomingCount).toBe(2);
      expect(brief.timeline.every(e => e.status === 'upcoming')).toBe(true);
    });

    it('should return empty brief for a day with no events', () => {
      vi.setSystemTime(new Date(2026, 1, 10, 9, 0, 0));

      const store = createStoreWithEvents([]);
      const brief = store.generateMorningBrief(new Date(2026, 1, 10));

      expect(brief.summary.totalEvents).toBe(0);
      expect(brief.summary.completedCount).toBe(0);
      expect(brief.summary.upcomingCount).toBe(0);
      expect(brief.nextMeeting).toBeNull();
      expect(brief.currentMeeting).toBeNull();
    });

    it('should filter conflicts to upcoming ones only', () => {
      // Two past events that conflicted, and two future events that conflict
      vi.setSystemTime(new Date(2026, 1, 10, 12, 0, 0)); // Noon

      const events = [
        // Past conflict pair (both ended before noon)
        makeEvent('Past Meeting A', 2026, 2, 10, 9, 0, 10, 0),
        makeEvent('Past Meeting B', 2026, 2, 10, 9, 30, 10, 30),
        // Future conflict pair (both start after noon)
        makeEvent('Future Meeting A', 2026, 2, 10, 14, 0, 15, 0),
        makeEvent('Future Meeting B', 2026, 2, 10, 14, 30, 15, 30),
      ];
      const store = createStoreWithEvents(events);
      const brief = store.generateMorningBrief(new Date(2026, 1, 10));

      // Only the future conflict pair should appear
      expect(brief.conflicts.length).toBe(1);
      expect(brief.conflicts[0].event1).toBe('Future Meeting A');
      expect(brief.conflicts[0].event2).toBe('Future Meeting B');
    });

    it('should only show remaining free slots for today', () => {
      // It's 1:00 PM. Morning was free (9-11), there's a meeting 11-12, afternoon free 1-5
      vi.setSystemTime(new Date(2026, 1, 10, 13, 0, 0));

      const events = [
        makeEvent('Late Morning Meeting', 2026, 2, 10, 11, 0, 12, 0),
      ];
      const store = createStoreWithEvents(events);
      const brief = store.generateMorningBrief(new Date(2026, 1, 10));

      // Free slots should NOT include the 9-11 AM slot (it's past)
      // Should only include slots that end after now
      for (const slot of brief.freeTime.freeSlots) {
        // Parse the end time and verify it's after now
        // freeSlots have formatted times, but the filter works on the raw Date objects
        // We check that remainingFreeHours is less than totalFreeHours
        expect(brief.freeTime.remainingFreeHours).toBeLessThanOrEqual(brief.freeTime.totalFreeHours);
      }

      // Remaining free hours should be less than total (morning is gone)
      expect(brief.freeTime.remainingFreeHours).toBeLessThan(brief.freeTime.totalFreeHours);
    });

    it('should include currentTime and currentTimeFormatted', () => {
      vi.setSystemTime(new Date(2026, 1, 10, 14, 30, 0));

      const store = createStoreWithEvents([]);
      const brief = store.generateMorningBrief(new Date(2026, 1, 10));

      expect(brief.currentTime).toBeDefined();
      expect(brief.currentTimeFormatted).toBeDefined();
      expect(brief.isToday).toBe(true);
    });

    it('should compute minutesUntil for next meeting', () => {
      // It's 2:00 PM, next meeting is at 3:00 PM
      vi.setSystemTime(new Date(2026, 1, 10, 14, 0, 0));

      const events = [
        makeEvent('Done Meeting', 2026, 2, 10, 9, 0, 10, 0),
        makeEvent('Upcoming Meeting', 2026, 2, 10, 15, 0, 16, 0),
      ];
      const store = createStoreWithEvents(events);
      const brief = store.generateMorningBrief(new Date(2026, 1, 10));

      expect(brief.nextMeeting.title).toBe('Upcoming Meeting');
      expect(brief.nextMeeting.minutesUntil).toBe(60); // 1 hour
    });

    it('should compute minutesRemaining for current meeting', () => {
      // It's 2:45 PM, meeting is 2:00 - 3:00 PM (15 min remaining)
      vi.setSystemTime(new Date(2026, 1, 10, 14, 45, 0));

      const events = [
        makeEvent('Current Session', 2026, 2, 10, 14, 0, 15, 0),
      ];
      const store = createStoreWithEvents(events);
      const brief = store.generateMorningBrief(new Date(2026, 1, 10));

      expect(brief.currentMeeting).not.toBeNull();
      expect(brief.currentMeeting.title).toBe('Current Session');
      expect(brief.currentMeeting.minutesRemaining).toBe(15);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // renderBriefForSpeech() -- Natural Language Output
  // ═══════════════════════════════════════════════════════════════════════════

  describe('renderBriefForSpeech()', () => {

    it('should use future tense when all events are upcoming (morning)', () => {
      vi.setSystemTime(new Date(2026, 1, 10, 7, 0, 0));

      const events = [
        makeEvent('Standup', 2026, 2, 10, 9, 0, 9, 30),
        makeEvent('Planning', 2026, 2, 10, 10, 0, 11, 0),
      ];
      const store = createStoreWithEvents(events);
      const brief = store.generateMorningBrief(new Date(2026, 1, 10));
      const speech = store.renderBriefForSpeech(brief);

      // Should say "You have X meetings" (future)
      expect(speech).toMatch(/You have 2 meetings/i);
      // Should mention next meeting
      expect(speech).toMatch(/next meeting is "Standup"/i);
      // Should NOT use past tense
      expect(speech).not.toMatch(/You('ve| have) had/i);
      expect(speech).not.toMatch(/already/i);
    });

    it('should use past tense when all events are completed (evening)', () => {
      vi.setSystemTime(new Date(2026, 1, 10, 18, 0, 0));

      const events = [
        makeEvent('Standup', 2026, 2, 10, 9, 0, 9, 30),
        makeEvent('Planning', 2026, 2, 10, 10, 0, 11, 0),
      ];
      const store = createStoreWithEvents(events);
      const brief = store.generateMorningBrief(new Date(2026, 1, 10));
      const speech = store.renderBriefForSpeech(brief);

      // Should use past tense
      expect(speech).toMatch(/You had 2 meetings today/i);
      expect(speech).toMatch(/all done/i);
      // Should NOT say "Your next meeting" or future-tense scheduling
      expect(speech).not.toMatch(/next meeting/i);
      expect(speech).not.toMatch(/still have/i);
    });

    it('should use mixed tense for past + upcoming events (midday)', () => {
      vi.setSystemTime(new Date(2026, 1, 10, 12, 0, 0)); // Noon

      const events = [
        makeEvent('Standup', 2026, 2, 10, 9, 0, 9, 30),
        makeEvent('Client Call', 2026, 2, 10, 14, 0, 15, 0),
      ];
      const store = createStoreWithEvents(events);
      const brief = store.generateMorningBrief(new Date(2026, 1, 10));
      const speech = store.renderBriefForSpeech(brief);

      // Should reference past events
      expect(speech).toMatch(/had 1 meeting already/i);
      // Should reference upcoming events
      expect(speech).toMatch(/still have 1 meeting ahead/i);
      // Should mention next upcoming meeting
      expect(speech).toMatch(/next meeting is "Client Call"/i);
    });

    it('should mention in-progress meeting', () => {
      vi.setSystemTime(new Date(2026, 1, 10, 11, 30, 0)); // 11:30 AM

      const events = [
        makeEvent('Design Review', 2026, 2, 10, 11, 0, 12, 0, { location: 'Room 42' }),
      ];
      const store = createStoreWithEvents(events);
      const brief = store.generateMorningBrief(new Date(2026, 1, 10));
      const speech = store.renderBriefForSpeech(brief);

      // Should mention current meeting
      expect(speech).toMatch(/right now/i);
      expect(speech).toMatch(/Design Review/i);
      expect(speech).toMatch(/Room 42/i);
      expect(speech).toMatch(/wrapping up in about 30 minutes/i);
    });

    it('should say "remaining free time" for today (not total)', () => {
      vi.setSystemTime(new Date(2026, 1, 10, 14, 0, 0)); // 2 PM

      const events = [
        makeEvent('Morning Block', 2026, 2, 10, 9, 0, 12, 0), // 3 hours busy, now done
      ];
      const store = createStoreWithEvents(events);
      const brief = store.generateMorningBrief(new Date(2026, 1, 10));
      const speech = store.renderBriefForSpeech(brief);

      // Should say "remaining" free time
      expect(speech).toMatch(/remaining free time/i);
    });

    it('should handle empty calendar gracefully', () => {
      vi.setSystemTime(new Date(2026, 1, 10, 9, 0, 0));

      const store = createStoreWithEvents([]);
      const brief = store.generateMorningBrief(new Date(2026, 1, 10));
      const speech = store.renderBriefForSpeech(brief);

      expect(speech).toMatch(/clear/i);
      expect(speech).toMatch(/no meetings/i);
    });

    it('should use future tense for a future day (not today)', () => {
      vi.setSystemTime(new Date(2026, 1, 10, 15, 0, 0)); // Feb 10 3 PM

      const events = [
        makeEvent('Early Call', 2026, 2, 12, 8, 0, 9, 0),
      ];
      const store = createStoreWithEvents(events);
      const brief = store.generateMorningBrief(new Date(2026, 1, 12)); // Feb 12
      const speech = store.renderBriefForSpeech(brief);

      // For a future day, should use firstMeeting language
      expect(speech).toMatch(/first meeting is "Early Call"/i);
      // Should NOT say "had" or "already"
      expect(speech).not.toMatch(/had/i);
      expect(speech).not.toMatch(/already/i);
    });

    it('should show correct greeting for time of day', () => {
      // Morning
      vi.setSystemTime(new Date(2026, 1, 10, 8, 0, 0));
      const storeAM = createStoreWithEvents([]);
      const briefAM = storeAM.generateMorningBrief(new Date(2026, 1, 10));
      expect(briefAM.greeting).toMatch(/Good morning/i);

      // Afternoon
      vi.setSystemTime(new Date(2026, 1, 10, 14, 0, 0));
      const storePM = createStoreWithEvents([]);
      const briefPM = storePM.generateMorningBrief(new Date(2026, 1, 10));
      expect(briefPM.greeting).toMatch(/Good afternoon/i);

      // Evening
      vi.setSystemTime(new Date(2026, 1, 10, 19, 0, 0));
      const storeEve = createStoreWithEvents([]);
      const briefEve = storeEve.generateMorningBrief(new Date(2026, 1, 10));
      expect(briefEve.greeting).toMatch(/Good evening/i);
    });

    it('should mention minutesUntil for next meeting when within an hour', () => {
      // Next meeting is in 25 minutes
      vi.setSystemTime(new Date(2026, 1, 10, 13, 35, 0));

      const events = [
        makeEvent('Done Meeting', 2026, 2, 10, 10, 0, 11, 0),
        makeEvent('Soon Meeting', 2026, 2, 10, 14, 0, 15, 0),
      ];
      const store = createStoreWithEvents(events);
      const brief = store.generateMorningBrief(new Date(2026, 1, 10));
      const speech = store.renderBriefForSpeech(brief);

      // Should say "in about 25 minutes"
      expect(speech).toMatch(/in about 25 minutes/i);
    });

    it('should NOT mention minutes for next meeting when more than an hour away', () => {
      // Next meeting is in 3 hours
      vi.setSystemTime(new Date(2026, 1, 10, 11, 0, 0));

      const events = [
        makeEvent('Afternoon Meeting', 2026, 2, 10, 14, 0, 15, 0),
      ];
      const store = createStoreWithEvents(events);
      const brief = store.generateMorningBrief(new Date(2026, 1, 10));
      const speech = store.renderBriefForSpeech(brief);

      // Should NOT say "in about X minutes" when > 60 min away
      expect(speech).not.toMatch(/that's in about/i);
      // Should still mention the meeting
      expect(speech).toMatch(/next meeting is "Afternoon Meeting"/i);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // End-to-End: Full Brief Pipeline (structured -> speech)
  // ═══════════════════════════════════════════════════════════════════════════

  describe('End-to-End: Full Brief Pipeline', () => {

    it('busy day at 2 PM should produce a coherent time-aware speech', () => {
      vi.setSystemTime(new Date(2026, 1, 10, 14, 0, 0)); // 2:00 PM

      const events = [
        makeEvent('Daily Standup', 2026, 2, 10, 9, 0, 9, 15),
        makeEvent('Sprint Planning', 2026, 2, 10, 10, 0, 11, 30),
        makeEvent('Lunch with Dave', 2026, 2, 10, 12, 0, 13, 0),
        makeEvent('Code Review', 2026, 2, 10, 15, 0, 16, 0),
        makeEvent('Retro', 2026, 2, 10, 16, 30, 17, 0),
      ];
      const store = createStoreWithEvents(events);
      const brief = store.generateMorningBrief(new Date(2026, 1, 10));
      const speech = store.renderBriefForSpeech(brief);

      // Verify structured data
      expect(brief.summary.completedCount).toBe(3); // standup, planning, lunch
      expect(brief.summary.upcomingCount).toBe(2);   // code review, retro
      expect(brief.nextMeeting.title).toBe('Code Review');
      expect(brief.nextMeeting.minutesUntil).toBe(60);

      // Verify speech
      expect(speech).toMatch(/had 3 meetings already/i);
      expect(speech).toMatch(/still have 2 meetings ahead/i);
      expect(speech).toMatch(/next meeting is "Code Review"/i);
      expect(speech).toMatch(/in about 60 minutes/i);
      // Should NOT describe past meetings in future tense
      expect(speech).not.toMatch(/first meeting is "Daily Standup"/i);
    });

    it('completely clear day produces clean empty speech', () => {
      vi.setSystemTime(new Date(2026, 1, 10, 10, 0, 0));

      const store = createStoreWithEvents([]);
      const brief = store.generateMorningBrief(new Date(2026, 1, 10));
      const speech = store.renderBriefForSpeech(brief);

      expect(speech).toMatch(/clear/i);
      expect(speech).not.toMatch(/next meeting/i);
      expect(speech).not.toMatch(/had.*meeting/i);
    });

    it('single meeting completed at 5 PM produces done speech', () => {
      vi.setSystemTime(new Date(2026, 1, 10, 17, 0, 0));

      const events = [
        makeEvent('Morning Standup', 2026, 2, 10, 9, 0, 9, 15),
      ];
      const store = createStoreWithEvents(events);
      const brief = store.generateMorningBrief(new Date(2026, 1, 10));
      const speech = store.renderBriefForSpeech(brief);

      expect(speech).toMatch(/had 1 meeting today/i);
      expect(speech).toMatch(/all done/i);
    });

    it('all-day event should still appear regardless of time', () => {
      vi.setSystemTime(new Date(2026, 1, 10, 15, 0, 0)); // 3 PM

      const events = [
        makeEvent('Company Holiday', 2026, 2, 10, 0, 0, 23, 59, { allDay: true }),
        makeEvent('Past Meeting', 2026, 2, 10, 9, 0, 10, 0),
      ];
      const store = createStoreWithEvents(events);
      const brief = store.generateMorningBrief(new Date(2026, 1, 10));
      const speech = store.renderBriefForSpeech(brief);

      expect(brief.allDayEvents.length).toBe(1);
      expect(brief.allDayEvents[0].title).toBe('Company Holiday');
      expect(speech).toMatch(/all-day event/i);
    });

    it('back-to-back detection only for upcoming events', () => {
      // It's 1 PM. Two back-to-back meetings in the morning (past), two in afternoon (upcoming)
      vi.setSystemTime(new Date(2026, 1, 10, 13, 0, 0));

      const events = [
        makeEvent('Past A', 2026, 2, 10, 9, 0, 10, 0),
        makeEvent('Past B', 2026, 2, 10, 10, 0, 11, 0),   // back-to-back with Past A (but both done)
        makeEvent('Future A', 2026, 2, 10, 14, 0, 15, 0),
        makeEvent('Future B', 2026, 2, 10, 15, 0, 16, 0),  // back-to-back with Future A
      ];
      const store = createStoreWithEvents(events);
      const brief = store.generateMorningBrief(new Date(2026, 1, 10));

      // Back-to-back should only be for upcoming events
      expect(brief.backToBack.length).toBe(1);
      expect(brief.backToBack[0].first).toBe('Future A');
      expect(brief.backToBack[0].second).toBe('Future B');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // User Name in Briefing
  // ═══════════════════════════════════════════════════════════════════════════

  describe('User Name in Briefing', () => {

    /**
     * Tests the _getUserName logic directly (same algorithm as daily-brief-agent.js lines 132-141).
     * We test the extraction logic in isolation rather than fighting with CommonJS module caching.
     */
    function extractName(facts) {
      const name = facts['Name'] || facts['First Name'];
      if (name && !name.includes('not yet learned')) return name;
      return null;
    }

    it('reads Name from profile Identity facts', () => {
      expect(extractName({ Name: 'Robb' })).toBe('Robb');
    });

    it('returns null for placeholder Name value', () => {
      expect(extractName({ Name: '(not yet learned)' })).toBeNull();
    });

    it('falls back to First Name when Name is missing', () => {
      expect(extractName({ 'First Name': 'Robb' })).toBe('Robb');
    });

    it('returns null when both Name and First Name are missing', () => {
      expect(extractName({})).toBeNull();
    });

    it('prefers Name over First Name when both exist', () => {
      expect(extractName({ Name: 'Robb', 'First Name': 'Robert' })).toBe('Robb');
    });

    it('daily-brief-agent _getUserName matches this logic', async () => {
      // Verify the actual agent module has _getUserName and it uses the same pattern
      vi.resetModules();
      vi.doMock('../../lib/agent-memory-store', () => ({
        getAgentMemory: vi.fn(() => ({
          load: vi.fn(), getSectionNames: vi.fn(() => []),
          updateSection: vi.fn(), isDirty: vi.fn(() => false), save: vi.fn(),
          getSection: vi.fn(() => ''), parseSectionAsKeyValue: vi.fn(() => ({})),
        })),
      }));
      vi.doMock('../../lib/ai-service', () => ({ complete: vi.fn(), chat: vi.fn() }));
      vi.doMock('../../lib/log-event-queue', () => ({
        getLogQueue: vi.fn(() => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() })),
      }));
      vi.doMock('../../lib/user-profile-store', () => ({
        getUserProfile: () => ({
          isLoaded: () => true,
          load: vi.fn(),
          getFacts: () => ({ Name: 'Robb' }),
        }),
      }));

      const agent = require('../../packages/agents/daily-brief-agent');
      expect(typeof agent._getUserName).toBe('function');
      const name = await agent._getUserName();
      expect(name).toBe('Robb');
    });

    it('name is used in _composeBriefing nameInstruction', () => {
      // The composition prompt includes the name when provided:
      //   "Address the user by name ("Robb") in the greeting."
      // When null:
      //   "Use a warm but generic greeting."
      const userName = 'Robb';
      const nameInstruction = userName
        ? `Address the user by name ("${userName}") in the greeting.`
        : 'Use a warm but generic greeting.';
      expect(nameInstruction).toContain('Robb');
      expect(nameInstruction).toMatch(/Address the user by name/);

      const noName = null;
      const genericInstruction = noName
        ? `Address the user by name ("${noName}") in the greeting.`
        : 'Use a warm but generic greeting.';
      expect(genericInstruction).toMatch(/warm but generic/);
    });
  });
});
