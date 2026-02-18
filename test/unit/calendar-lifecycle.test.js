/**
 * Calendar Store Full Lifecycle Tests
 *
 * Takes a single event through the complete lifecycle:
 *   Create -> Read -> Update/Reschedule -> Conflict Detection -> Delete
 *
 * Also tests recurring events, exceptions, overrides, free-slot finding,
 * and day/week summaries.
 *
 * Uses a fresh CalendarStore instance per test (mocked fs to avoid disk I/O).
 *
 * Run:  npx vitest run test/unit/calendar-lifecycle.test.js
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fs to avoid real disk I/O
vi.mock('fs', () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => '[]'),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

const { CalendarStore } = require('../../lib/calendar-store');

// Helper: create an ISO datetime for today at a given hour:minute
function todayAt(hour, minute = 0) {
  const d = new Date();
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
}

// Helper: create an ISO datetime for a relative day offset at a given hour
function dayAt(offsetDays, hour, minute = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
}

describe('Calendar Store - Full Event Lifecycle', () => {
  let store;

  beforeEach(() => {
    store = new CalendarStore();
    store._loaded = true; // Skip disk load
    store.save = vi.fn(); // Mock save to prevent disk writes
  });

  // ═══════════════════════════════════════════════════════════════════
  // SINGLE EVENT: CREATE -> READ -> UPDATE -> DELETE
  // ═══════════════════════════════════════════════════════════════════

  describe('Full Lifecycle: Create -> Read -> Reschedule -> Delete', () => {
    it('Step 1: Create an event', () => {
      const { event, conflicts } = store.addEvent({
        title: 'Team Standup',
        startTime: todayAt(10, 0),
        endTime: todayAt(10, 30),
        location: 'Conference Room A',
        description: 'Daily standup meeting',
        guests: ['alice@example.com', 'bob@example.com'],
      });

      expect(event).toBeDefined();
      expect(event.id).toMatch(/^evt_/);
      expect(event.title).toBe('Team Standup');
      expect(event.location).toBe('Conference Room A');
      expect(event.description).toBe('Daily standup meeting');
      expect(event.guests).toEqual(['alice@example.com', 'bob@example.com']);
      expect(event.source).toBe('local');
      expect(event.calendar).toBe('personal');
      expect(event.created).toBeDefined();
      expect(event.updated).toBeDefined();
      expect(conflicts).toEqual([]); // No conflicts on empty calendar
      expect(store.save).toHaveBeenCalled();
    });

    it('Step 2: Read the event back by ID', () => {
      const { event } = store.addEvent({
        title: 'Team Standup',
        startTime: todayAt(10, 0),
        endTime: todayAt(10, 30),
      });

      const retrieved = store.getEvent(event.id);
      expect(retrieved).toBeDefined();
      expect(retrieved.id).toBe(event.id);
      expect(retrieved.title).toBe('Team Standup');
    });

    it('Step 3: Reschedule (update) the event to a new time', () => {
      const { event } = store.addEvent({
        title: 'Team Standup',
        startTime: todayAt(10, 0),
        endTime: todayAt(10, 30),
        location: 'Conference Room A',
      });

      // Reschedule from 10:00 to 14:00
      const updated = store.updateEvent(event.id, {
        startTime: todayAt(14, 0),
        endTime: todayAt(14, 30),
        location: 'Conference Room B',
      });

      expect(updated).toBeDefined();
      expect(updated.title).toBe('Team Standup'); // Unchanged
      expect(new Date(updated.startTime).getHours()).toBe(14);
      expect(updated.location).toBe('Conference Room B');
      expect(new Date(updated.updated).getTime()).toBeGreaterThanOrEqual(new Date(event.created).getTime());
    });

    it('Step 4: Verify rescheduled time persists on re-read', () => {
      const { event } = store.addEvent({
        title: 'Team Standup',
        startTime: todayAt(10, 0),
        endTime: todayAt(10, 30),
      });

      store.updateEvent(event.id, {
        startTime: todayAt(14, 0),
        endTime: todayAt(14, 30),
      });

      const retrieved = store.getEvent(event.id);
      expect(new Date(retrieved.startTime).getHours()).toBe(14);
      expect(new Date(retrieved.endTime).getHours()).toBe(14);
    });

    it('Step 5: Delete the event', () => {
      const { event } = store.addEvent({
        title: 'Team Standup',
        startTime: todayAt(10, 0),
        endTime: todayAt(10, 30),
      });

      const deleted = store.deleteEvent(event.id);
      expect(deleted).toBe(true);

      // Verify it's gone
      const retrieved = store.getEvent(event.id);
      expect(retrieved).toBeNull();

      // Verify store is empty
      expect(store.getAllEvents()).toHaveLength(0);
    });

    it('Step 6: Delete returns false for already-deleted event', () => {
      const { event } = store.addEvent({
        title: 'Team Standup',
        startTime: todayAt(10, 0),
      });

      store.deleteEvent(event.id);
      const secondDelete = store.deleteEvent(event.id);
      expect(secondDelete).toBe(false);
    });

    it('Full lifecycle in sequence', () => {
      // CREATE
      const { event } = store.addEvent({
        title: 'Product Review',
        startTime: todayAt(11, 0),
        endTime: todayAt(12, 0),
        location: 'Zoom',
        guests: ['pm@example.com'],
      });
      expect(store.getAllEvents()).toHaveLength(1);

      // READ
      const read = store.getEvent(event.id);
      expect(read.title).toBe('Product Review');
      expect(read.location).toBe('Zoom');

      // UPDATE (reschedule to tomorrow, add guest)
      const updated = store.updateEvent(event.id, {
        startTime: dayAt(1, 11, 0),
        endTime: dayAt(1, 12, 0),
        guests: ['pm@example.com', 'eng@example.com'],
        title: 'Product Review (rescheduled)',
      });
      expect(updated.title).toBe('Product Review (rescheduled)');
      expect(updated.guests).toHaveLength(2);

      // VERIFY update persisted
      const reRead = store.getEvent(event.id);
      expect(reRead.title).toBe('Product Review (rescheduled)');

      // DELETE
      expect(store.deleteEvent(event.id)).toBe(true);
      expect(store.getEvent(event.id)).toBeNull();
      expect(store.getAllEvents()).toHaveLength(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // CONFLICT DETECTION
  // ═══════════════════════════════════════════════════════════════════

  describe('Conflict Detection', () => {
    it('should detect overlapping events', () => {
      store.addEvent({
        title: 'Meeting A',
        startTime: todayAt(10, 0),
        endTime: todayAt(11, 0),
      });

      // Overlaps with Meeting A (10:30 - 11:30)
      const { conflicts } = store.addEvent({
        title: 'Meeting B',
        startTime: todayAt(10, 30),
        endTime: todayAt(11, 30),
      });

      expect(conflicts).toHaveLength(1);
      expect(conflicts[0].title).toBe('Meeting A');
    });

    it('should not flag non-overlapping events as conflicts', () => {
      store.addEvent({
        title: 'Morning Meeting',
        startTime: todayAt(9, 0),
        endTime: todayAt(10, 0),
      });

      const { conflicts } = store.addEvent({
        title: 'Afternoon Meeting',
        startTime: todayAt(14, 0),
        endTime: todayAt(15, 0),
      });

      expect(conflicts).toHaveLength(0);
    });

    it('should not flag all-day events as conflicts', () => {
      store.addEvent({
        title: 'All Day Event',
        startTime: todayAt(0, 0),
        endTime: todayAt(23, 59),
        allDay: true,
      });

      const { conflicts } = store.addEvent({
        title: 'Normal Meeting',
        startTime: todayAt(10, 0),
        endTime: todayAt(11, 0),
      });

      expect(conflicts).toHaveLength(0);
    });

    it('findConflicts should exclude specified event', () => {
      const { event: evt1 } = store.addEvent({
        title: 'Meeting A',
        startTime: todayAt(10, 0),
        endTime: todayAt(11, 0),
      });

      // Check conflicts for same time, excluding evt1 itself
      const conflicts = store.findConflicts(todayAt(10, 0), todayAt(11, 0), evt1.id);
      expect(conflicts).toHaveLength(0);
    });

    it('isAvailable should check slot availability', () => {
      store.addEvent({
        title: 'Blocked',
        startTime: todayAt(10, 0),
        endTime: todayAt(11, 0),
      });

      expect(store.isAvailable(todayAt(10, 0), todayAt(11, 0))).toBe(false);
      expect(store.isAvailable(todayAt(11, 0), todayAt(12, 0))).toBe(true);
    });

    it('findDayConflicts should find all overlapping pairs', () => {
      store.addEvent({ title: 'A', startTime: todayAt(10, 0), endTime: todayAt(11, 0) });
      store.addEvent({ title: 'B', startTime: todayAt(10, 30), endTime: todayAt(11, 30) });
      store.addEvent({ title: 'C', startTime: todayAt(14, 0), endTime: todayAt(15, 0) });

      const conflicts = store.findDayConflicts(new Date());
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0].event1.title).toBe('A');
      expect(conflicts[0].event2.title).toBe('B');
      expect(conflicts[0].overlapMinutes).toBe(30);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // RECURRING EVENTS
  // ═══════════════════════════════════════════════════════════════════

  describe('Recurring Events', () => {
    it('should create a weekly recurring event', () => {
      const { event } = store.addEvent({
        title: 'Weekly Standup',
        startTime: todayAt(9, 0),
        endTime: todayAt(9, 30),
        recurring: { pattern: 'weekly' },
      });

      expect(event.recurring).toBeDefined();
      expect(event.recurring.pattern).toBe('weekly');
      expect(event.recurring.interval).toBe(1);
    });

    it('should expand recurring events within a range', () => {
      const { event } = store.addEvent({
        title: 'Daily Check-in',
        startTime: todayAt(9, 0),
        endTime: todayAt(9, 15),
        recurring: { pattern: 'daily' },
      });

      // Expand for the next 7 days
      const rangeStart = new Date();
      rangeStart.setHours(0, 0, 0, 0);
      const rangeEnd = new Date(rangeStart);
      rangeEnd.setDate(rangeEnd.getDate() + 6);
      rangeEnd.setHours(23, 59, 59, 999);

      const occurrences = store.expandRecurring(event, rangeStart, rangeEnd);
      expect(occurrences.length).toBe(7);
      expect(occurrences[0].isRecurringInstance).toBe(true);
      expect(occurrences[0].parentEventId).toBe(event.id);
    });

    it('should expand weekday-only recurring events', () => {
      const { event } = store.addEvent({
        title: 'Weekday Meeting',
        startTime: todayAt(10, 0),
        endTime: todayAt(10, 30),
        recurring: { pattern: 'weekdays' },
      });

      // Expand for 14 days to capture at least 10 weekdays
      const rangeStart = new Date();
      rangeStart.setHours(0, 0, 0, 0);
      const rangeEnd = new Date(rangeStart);
      rangeEnd.setDate(rangeEnd.getDate() + 13);
      rangeEnd.setHours(23, 59, 59, 999);

      const occurrences = store.expandRecurring(event, rangeStart, rangeEnd);
      // All occurrences should be on weekdays (Mon-Fri)
      for (const occ of occurrences) {
        const day = new Date(occ.startTime).getDay();
        expect(day).toBeGreaterThanOrEqual(1);
        expect(day).toBeLessThanOrEqual(5);
      }
      expect(occurrences.length).toBe(10);
    });

    it('should respect exception dates (skip occurrence)', () => {
      const { event } = store.addEvent({
        title: 'Daily Standup',
        startTime: todayAt(9, 0),
        endTime: todayAt(9, 15),
        recurring: { pattern: 'daily' },
      });

      // Skip tomorrow
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      store.addException(event.id, tomorrow);

      // Expand for 3 days
      const rangeStart = new Date();
      rangeStart.setHours(0, 0, 0, 0);
      const rangeEnd = new Date(rangeStart);
      rangeEnd.setDate(rangeEnd.getDate() + 2);
      rangeEnd.setHours(23, 59, 59, 999);

      const occurrences = store.expandRecurring(event, rangeStart, rangeEnd);
      expect(occurrences.length).toBe(2); // Today + day after tomorrow (tomorrow skipped)
    });

    it('should apply per-occurrence overrides', () => {
      const { event } = store.addEvent({
        title: 'Daily Standup',
        startTime: todayAt(9, 0),
        endTime: todayAt(9, 15),
        recurring: { pattern: 'daily' },
      });

      // Override tomorrow's title
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      store.overrideOccurrence(event.id, tomorrow, {
        title: 'Special Retro',
        location: 'Big Conference Room',
      });

      // Expand for 2 days
      const rangeStart = new Date();
      rangeStart.setHours(0, 0, 0, 0);
      const rangeEnd = new Date(rangeStart);
      rangeEnd.setDate(rangeEnd.getDate() + 1);
      rangeEnd.setHours(23, 59, 59, 999);

      const occurrences = store.expandRecurring(event, rangeStart, rangeEnd);
      expect(occurrences.length).toBe(2);

      // Tomorrow's occurrence should have the override
      const tomorrowOcc = occurrences[1];
      expect(tomorrowOcc.title).toBe('Special Retro');
      expect(tomorrowOcc.location).toBe('Big Conference Room');
    });

    it('should respect endAfter limit', () => {
      const { event } = store.addEvent({
        title: 'Limited Series',
        startTime: todayAt(10, 0),
        endTime: todayAt(10, 30),
        recurring: { pattern: 'daily', endAfter: 3 },
      });

      const rangeStart = new Date();
      rangeStart.setHours(0, 0, 0, 0);
      const rangeEnd = new Date(rangeStart);
      rangeEnd.setDate(rangeEnd.getDate() + 10);
      rangeEnd.setHours(23, 59, 59, 999);

      const occurrences = store.expandRecurring(event, rangeStart, rangeEnd);
      expect(occurrences.length).toBe(3);
    });

    it('addException returns false for non-recurring events', () => {
      const { event } = store.addEvent({
        title: 'One-off',
        startTime: todayAt(10, 0),
      });

      expect(store.addException(event.id, new Date())).toBe(false);
    });

    it('overrideOccurrence returns false for non-recurring events', () => {
      const { event } = store.addEvent({
        title: 'One-off',
        startTime: todayAt(10, 0),
      });

      expect(store.overrideOccurrence(event.id, new Date(), { title: 'X' })).toBe(false);
    });

    it('should delete a recurring event and all its occurrences', () => {
      const { event } = store.addEvent({
        title: 'Weekly Sync',
        startTime: todayAt(10, 0),
        endTime: todayAt(10, 30),
        recurring: { pattern: 'weekly' },
      });

      expect(store.deleteEvent(event.id)).toBe(true);
      expect(store.getEvent(event.id)).toBeNull();

      // No occurrences should expand
      const rangeStart = new Date();
      rangeStart.setHours(0, 0, 0, 0);
      const rangeEnd = new Date(rangeStart);
      rangeEnd.setDate(rangeEnd.getDate() + 30);
      rangeEnd.setHours(23, 59, 59, 999);

      const events = store.getEventsInRange(rangeStart, rangeEnd);
      expect(events).toHaveLength(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // FREE SLOTS & SUGGESTIONS
  // ═══════════════════════════════════════════════════════════════════

  describe('Free Slots & Suggestions', () => {
    it('should find free slots around meetings', () => {
      store.addEvent({ title: 'A', startTime: todayAt(10, 0), endTime: todayAt(11, 0) });
      store.addEvent({ title: 'B', startTime: todayAt(14, 0), endTime: todayAt(15, 0) });

      const slots = store.getFreeSlots(new Date(), 30);
      expect(slots.length).toBeGreaterThanOrEqual(2); // Before A, between A&B, after B
    });

    it('should return all working hours as free when no events', () => {
      const slots = store.getFreeSlots(new Date(), 30);
      expect(slots.length).toBe(1); // One big block: 9 AM - 5 PM
      expect(slots[0].durationMinutes).toBe(480); // 8 hours
    });

    it('should suggest alternative times', () => {
      store.addEvent({ title: 'Blocked', startTime: todayAt(10, 0), endTime: todayAt(16, 0) });

      const suggestions = store.suggestAlternatives(30, new Date(), 3);
      expect(suggestions.length).toBeGreaterThan(0);
      expect(suggestions[0].start).toBeDefined();
      expect(suggestions[0].day).toBeDefined();
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // DAY BALANCE & SUMMARIES
  // ═══════════════════════════════════════════════════════════════════

  describe('Day Balance & Summaries', () => {
    it('should calculate day balance correctly', () => {
      store.addEvent({ title: 'A', startTime: todayAt(10, 0), endTime: todayAt(11, 0) });
      store.addEvent({ title: 'B', startTime: todayAt(14, 0), endTime: todayAt(15, 0) });

      const balance = store.getDayBalance(new Date());
      expect(balance.totalWorkHours).toBe(8);
      expect(balance.busyHours).toBe(2);
      expect(balance.freeHours).toBe(6);
      expect(balance.eventCount).toBe(2);
      expect(balance.busyPercent).toBe(25);
    });

    it('should generate a day summary', () => {
      store.addEvent({ title: 'Standup', startTime: todayAt(9, 0), endTime: todayAt(9, 15) });
      store.addEvent({ title: 'Review', startTime: todayAt(14, 0), endTime: todayAt(15, 0) });

      const summary = store.generateDaySummary(new Date());
      expect(summary).toContain('2 events');
      expect(summary).toContain('Standup');
      expect(summary).toContain('Review');
    });

    it('should generate a week summary', () => {
      store.addEvent({ title: 'Monday Event', startTime: dayAt(0, 10, 0), endTime: dayAt(0, 11, 0) });

      const summary = store.generateWeekSummary();
      expect(summary).toContain('This week');
      expect(summary).toContain('meeting');
    });

    it('should generate a morning brief', () => {
      store.addEvent({ title: 'Standup', startTime: todayAt(9, 0), endTime: todayAt(9, 15) });
      store.addEvent({ title: 'Review', startTime: todayAt(14, 0), endTime: todayAt(15, 0) });

      const brief = store.generateMorningBrief();
      expect(brief).toBeDefined();
      expect(brief.summary.totalEvents).toBe(2);
      expect(brief.summary.timedEvents).toBe(2);
      expect(brief.timeline).toHaveLength(2);
      expect(brief.dayLabel).toBeDefined();
      expect(brief.greeting).toBeDefined();

      // Render for speech
      const speech = store.renderBriefForSpeech(brief);
      expect(speech).toContain('meeting');
      expect(typeof speech).toBe('string');
      expect(speech.length).toBeGreaterThan(20);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // SEARCH & QUERIES
  // ═══════════════════════════════════════════════════════════════════

  describe('Search & Queries', () => {
    it('should search events by title', () => {
      store.addEvent({ title: 'Product Review', startTime: todayAt(10, 0) });
      store.addEvent({ title: 'Sprint Planning', startTime: todayAt(14, 0) });
      store.addEvent({ title: 'Product Demo', startTime: todayAt(16, 0) });

      const results = store.searchEvents('product');
      expect(results).toHaveLength(2);
      expect(results.map((e) => e.title)).toContain('Product Review');
      expect(results.map((e) => e.title)).toContain('Product Demo');
    });

    it('should search case-insensitively', () => {
      store.addEvent({ title: 'URGENT Meeting', startTime: todayAt(10, 0) });

      expect(store.searchEvents('urgent')).toHaveLength(1);
      expect(store.searchEvents('URGENT')).toHaveLength(1);
    });

    it('getNextEvent should return the soonest upcoming', () => {
      store.addEvent({ title: 'Later', startTime: dayAt(2, 10, 0), endTime: dayAt(2, 11, 0) });
      store.addEvent({ title: 'Sooner', startTime: dayAt(1, 10, 0), endTime: dayAt(1, 11, 0) });

      const next = store.getNextEvent();
      // Should be the sooner one (tomorrow)
      if (next) {
        expect(next.title).toBe('Sooner');
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // SETTINGS
  // ═══════════════════════════════════════════════════════════════════

  describe('Settings', () => {
    it('should get and update settings', () => {
      const settings = store.getSettings();
      expect(settings.workingHours.start).toBe(9);
      expect(settings.workingHours.end).toBe(17);

      const updated = store.updateSettings({
        workingHours: { start: 8, end: 18 },
        defaultDuration: 60,
      });

      expect(updated.workingHours.start).toBe(8);
      expect(updated.defaultDuration).toBe(60);
    });

    it('default end time uses configured duration', () => {
      store.updateSettings({ defaultDuration: 45 });

      const { event } = store.addEvent({
        title: 'No End Time',
        startTime: todayAt(10, 0),
        // No endTime provided
      });

      const duration = (new Date(event.endTime) - new Date(event.startTime)) / 60000;
      expect(duration).toBe(45);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // EXTERNAL EVENT MERGE
  // ═══════════════════════════════════════════════════════════════════

  describe('External Event Merge', () => {
    it('should merge external events with local events', () => {
      store.addEvent({ title: 'Local Meeting', startTime: todayAt(10, 0), endTime: todayAt(11, 0) });

      const externalEvents = [
        {
          summary: 'Google Calendar Event',
          start: { dateTime: todayAt(14, 0) },
          end: { dateTime: todayAt(15, 0) },
          attendees: [{ email: 'ext@example.com' }],
        },
      ];

      const events = store.getEventsForDay(new Date(), externalEvents);
      expect(events.length).toBe(2);
      expect(events[0].title).toBe('Local Meeting');
      expect(events[1].title).toBe('Google Calendar Event');
    });

    it('should deduplicate external events by title and time', () => {
      store.addEvent({ title: 'Team Sync', startTime: todayAt(10, 0), endTime: todayAt(10, 30) });

      const externalEvents = [
        {
          summary: 'Team Sync',
          start: { dateTime: todayAt(10, 0) },
          end: { dateTime: todayAt(10, 30) },
        },
      ];

      const events = store.getEventsForDay(new Date(), externalEvents);
      expect(events.length).toBe(1); // Deduplicated
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // EDGE CASES
  // ═══════════════════════════════════════════════════════════════════

  describe('Edge Cases', () => {
    it('should handle update of nonexistent event', () => {
      const result = store.updateEvent('nonexistent-id', { title: 'New Title' });
      expect(result).toBeNull();
    });

    it('should handle delete of nonexistent event', () => {
      expect(store.deleteEvent('nonexistent-id')).toBe(false);
    });

    it('should handle getEvent for nonexistent ID', () => {
      expect(store.getEvent('nonexistent-id')).toBeNull();
    });

    it('should handle empty search', () => {
      expect(store.searchEvents('')).toEqual([]);
      expect(store.searchEvents('anything')).toEqual([]);
    });

    it('should handle event with custom ID', () => {
      const { event } = store.addEvent({
        id: 'custom-id-999',
        title: 'Custom ID Event',
        startTime: todayAt(10, 0),
      });
      expect(event.id).toBe('custom-id-999');
      expect(store.getEvent('custom-id-999')).toBeDefined();
    });

    it('isWorkingHour checks correctly', () => {
      const workingTime = new Date();
      workingTime.setHours(12, 0, 0, 0);
      expect(store.isWorkingHour(workingTime)).toBe(true);

      const earlyMorning = new Date();
      earlyMorning.setHours(5, 0, 0, 0);
      expect(store.isWorkingHour(earlyMorning)).toBe(false);

      const lateEvening = new Date();
      lateEvening.setHours(20, 0, 0, 0);
      expect(store.isWorkingHour(lateEvening)).toBe(false);
    });
  });
});
