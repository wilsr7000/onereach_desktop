/**
 * Phase 1 (calendar agent overhaul) -- regression guard for the daily-brief
 * calendar contribution.
 *
 * The bug being prevented: prior to this change, calendar-query-agent.getBriefing()
 * called store.generateMorningBrief(date) with no externalEvents, so the brief
 * only saw events in the local CalendarStore -- never live Omnical events. This
 * test locks the live-events merge into place behind the
 * `calendar.briefIncludeLiveEvents` flag and verifies the flag-off / failure
 * paths degrade safely.
 *
 * Approach: the agent exposes test seams (`_fetchLiveEventsForBrief`,
 * `_getStore`) that wrap the calendar-fetch and calendar-store imports. Tests
 * use `vi.spyOn` against those seams instead of `vi.mock` against the modules.
 * This sidesteps a vitest+CJS-require quirk where module-level mocks don't
 * reliably intercept the agent's `require()` chain in this project.
 *
 * This is the highest-priority test in the Phase 0 test priority list -- if this
 * test passes, the user-facing regression cannot recur.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const calendarQueryAgent = require('../../packages/agents/calendar-query-agent');

describe('Phase 1: calendar brief merges live Omnical events', () => {
  let mockStore;
  let originalSettings;
  let fetchSpy;
  let storeSpy;

  beforeEach(() => {
    mockStore = {
      generateMorningBrief: vi.fn().mockResolvedValue({
        timeline: [{ title: 'Standup', start: '9:00 AM', status: 'upcoming' }],
        conflicts: [],
        backToBack: [],
        longestFree: { durationMinutes: 0 },
      }),
    };

    fetchSpy = vi.spyOn(calendarQueryAgent, '_fetchLiveEventsForBrief').mockResolvedValue([]);
    storeSpy = vi.spyOn(calendarQueryAgent, '_getStore').mockReturnValue(mockStore);

    originalSettings = global.settingsManager;
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    storeSpy.mockRestore();
    global.settingsManager = originalSettings;
  });

  describe('flag on (calendar.briefIncludeLiveEvents = true)', () => {
    beforeEach(() => {
      global.settingsManager = {
        get: vi.fn((key, def) => {
          if (key === 'calendar.briefIncludeLiveEvents') return true;
          if (key === 'calendar.briefMerge.maxLiveEvents') return 50;
          return def;
        }),
      };
    });

    it('fetches live events and passes them as externalEvents to generateMorningBrief', async () => {
      const liveEvents = [
        { id: 'live-1', summary: 'Marcus 1:1' },
        { id: 'live-2', summary: 'Acme demo' },
        { id: 'live-3', summary: 'Roadmap review' },
      ];
      fetchSpy.mockResolvedValue(liveEvents);

      const result = await calendarQueryAgent.getBriefing();

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(mockStore.generateMorningBrief).toHaveBeenCalledTimes(1);
      const [, externalEvents] = mockStore.generateMorningBrief.mock.calls[0];
      expect(externalEvents).toEqual(liveEvents);

      expect(result.section).toBe('Calendar');
      expect(result.priority).toBe(3);
      expect(result.briefData).toBeTruthy();
    });

    it('caps live events at maxLiveEvents (configurable backstop)', async () => {
      global.settingsManager = {
        get: vi.fn((key, def) => {
          if (key === 'calendar.briefIncludeLiveEvents') return true;
          if (key === 'calendar.briefMerge.maxLiveEvents') return 2;
          return def;
        }),
      };
      fetchSpy.mockResolvedValue(
        Array.from({ length: 5 }, (_, i) => ({ id: `e${i}`, summary: `Event ${i}` }))
      );

      await calendarQueryAgent.getBriefing();

      const [, externalEvents] = mockStore.generateMorningBrief.mock.calls[0];
      expect(externalEvents).toHaveLength(2);
    });

    it('Omnical fetch failure: falls back to local-only brief, never throws', async () => {
      fetchSpy.mockRejectedValue(new Error('network down'));

      const result = await calendarQueryAgent.getBriefing();

      expect(mockStore.generateMorningBrief).toHaveBeenCalledTimes(1);
      const [, externalEvents] = mockStore.generateMorningBrief.mock.calls[0];
      expect(externalEvents).toEqual([]);
      expect(result.section).toBe('Calendar');
      expect(result.briefData).toBeTruthy();
    });

    it('uses target date from context (tomorrow brief fetches tomorrow events)', async () => {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      tomorrow.setHours(0, 0, 0, 0);
      fetchSpy.mockResolvedValue([]);

      await calendarQueryAgent.getBriefing({ targetDate: tomorrow, dateLabel: 'tomorrow' });

      const [timeframe] = fetchSpy.mock.calls[0];
      expect(timeframe).toBe('tomorrow');
    });
  });

  describe('flag off (calendar.briefIncludeLiveEvents undefined or false)', () => {
    beforeEach(() => {
      global.settingsManager = {
        get: vi.fn(() => undefined),
      };
    });

    it('does not fetch live events; passes empty externalEvents to generateMorningBrief', async () => {
      await calendarQueryAgent.getBriefing();

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(mockStore.generateMorningBrief).toHaveBeenCalledTimes(1);
      const [, externalEvents] = mockStore.generateMorningBrief.mock.calls[0];
      expect(externalEvents).toEqual([]);
    });

    it('explicit flag = false also skips fetch', async () => {
      global.settingsManager = {
        get: vi.fn((key) => (key === 'calendar.briefIncludeLiveEvents' ? false : undefined)),
      };

      await calendarQueryAgent.getBriefing();

      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('settingsManager unavailable: still skips fetch (no crash)', async () => {
      global.settingsManager = undefined;

      const result = await calendarQueryAgent.getBriefing();

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(result.section).toBe('Calendar');
    });
  });

  describe('briefing content composition', () => {
    beforeEach(() => {
      global.settingsManager = { get: vi.fn(() => undefined) };
    });

    it('mentions count, next upcoming meeting, back-to-back, conflict events, longest free block', async () => {
      mockStore.generateMorningBrief.mockResolvedValue({
        timeline: [
          { title: 'Standup', start: '9:00 AM', status: 'completed' },
          { title: 'Sync', start: '10:00 AM', status: 'upcoming' },
          { title: 'Demo', start: '11:00 AM', status: 'upcoming' },
        ],
        conflicts: [{ event1: { title: 'Sync' }, event2: { title: 'Demo' } }],
        backToBack: [{}, {}],
        longestFree: { durationMinutes: 120 },
      });

      const result = await calendarQueryAgent.getBriefing();

      expect(result.content).toContain('3 meetings');
      expect(result.content).toContain('Sync');
      expect(result.content).not.toMatch(/Next.*Standup/);
      expect(result.content).toContain('back-to-back');
      expect(result.content).toContain('conflict');
      expect(result.content).toContain('Demo');
      expect(result.content).toContain('Longest free block');
    });

    it('empty timeline: returns "no meetings" message', async () => {
      mockStore.generateMorningBrief.mockResolvedValue({ timeline: [] });

      const result = await calendarQueryAgent.getBriefing({ dateLabel: 'tomorrow' });

      expect(result.content).toMatch(/[Nn]o meetings/);
      expect(result.content).toContain('tomorrow');
    });

    it('store throws: degrades to "Calendar unavailable"', async () => {
      mockStore.generateMorningBrief.mockRejectedValue(new Error('store boom'));

      const result = await calendarQueryAgent.getBriefing();

      expect(result.section).toBe('Calendar');
      expect(result.content).toMatch(/Calendar unavailable/);
    });

    it('singular meeting count uses "meeting" not "meetings"', async () => {
      mockStore.generateMorningBrief.mockResolvedValue({
        timeline: [{ title: 'Solo', start: '9:00 AM', status: 'upcoming' }],
      });

      const result = await calendarQueryAgent.getBriefing();
      expect(result.content).toContain('1 meeting today');
      expect(result.content).not.toContain('1 meetings');
    });
  });

  describe('Phase 2e: snapshot diff appended to brief content', () => {
    let diffSpy;
    let writeSnapshotSpy;

    beforeEach(() => {
      // Stub _buildSnapshotDiff so we control what diff line lands in the
      // brief; stub the underlying writeBriefSnapshot so the test doesn't
      // touch the calendar-memory machinery.
      diffSpy = vi.spyOn(calendarQueryAgent, '_buildSnapshotDiff');
      writeSnapshotSpy = vi.fn().mockResolvedValue(true);
      calendarQueryAgent.calendarMemory = {
        writeBriefSnapshot: writeSnapshotSpy,
        readEntriesTrusted: vi.fn(() => []),
      };
      global.settingsManager = {
        get: vi.fn((key, def) => {
          if (key === 'calendar.briefIncludeLiveEvents') return true;
          return def;
        }),
      };
    });

    afterEach(() => {
      diffSpy.mockRestore();
      calendarQueryAgent.calendarMemory = null;
    });

    it('appends the diff line to brief content when present', async () => {
      diffSpy.mockResolvedValue({
        line: '2 new since yesterday: "lunch with Marcus", "board prep".',
        diff: { added: [], removed: [], moved: [], retitled: [] },
        ageDays: 1,
      });
      fetchSpy.mockResolvedValue([{ id: 'e1', summary: 'Standup' }]);

      const result = await calendarQueryAgent.getBriefing();
      expect(result.content).toContain('new since yesterday');
      expect(result.briefDiff).toBeDefined();
    });

    it('omits the diff line when the diff is empty', async () => {
      diffSpy.mockResolvedValue(null);
      fetchSpy.mockResolvedValue([{ id: 'e1', summary: 'Standup' }]);

      const result = await calendarQueryAgent.getBriefing();
      expect(result.content).not.toContain('since yesterday');
      expect(result.briefDiff).toBeUndefined();
    });

    it("writes today's snapshot AFTER reading the prior diff", async () => {
      diffSpy.mockResolvedValue(null);
      fetchSpy.mockResolvedValue([{ id: 'e1', summary: 'Standup' }]);

      await calendarQueryAgent.getBriefing();

      // Order matters: diff first (so we don't diff against ourselves),
      // snapshot write second.
      expect(diffSpy).toHaveBeenCalled();
      expect(writeSnapshotSpy).toHaveBeenCalled();
      const diffOrder = diffSpy.mock.invocationCallOrder[0];
      const writeOrder = writeSnapshotSpy.mock.invocationCallOrder[0];
      expect(diffOrder).toBeLessThan(writeOrder);
    });

    it('snapshot write failure is non-fatal -- brief still returns', async () => {
      diffSpy.mockResolvedValue(null);
      writeSnapshotSpy.mockRejectedValue(new Error('disk full'));
      fetchSpy.mockResolvedValue([{ id: 'e1', summary: 'Standup' }]);

      const result = await calendarQueryAgent.getBriefing();
      expect(result.section).toBe('Calendar');
      expect(result.content).toContain('1 meeting');
    });

    it('skips snapshot write when no live events were fetched', async () => {
      diffSpy.mockResolvedValue(null);
      fetchSpy.mockResolvedValue([]);

      await calendarQueryAgent.getBriefing();
      expect(writeSnapshotSpy).not.toHaveBeenCalled();
    });
  });

  describe('_timeframeForDate helper', () => {
    it('null/undefined -> today', () => {
      expect(calendarQueryAgent._timeframeForDate(null)).toBe('today');
      expect(calendarQueryAgent._timeframeForDate(undefined)).toBe('today');
    });

    it('today date -> today', () => {
      expect(calendarQueryAgent._timeframeForDate(new Date())).toBe('today');
    });

    it('tomorrow date -> tomorrow', () => {
      const t = new Date();
      t.setDate(t.getDate() + 1);
      expect(calendarQueryAgent._timeframeForDate(t)).toBe('tomorrow');
    });

    it('yesterday date -> yesterday', () => {
      const y = new Date();
      y.setDate(y.getDate() - 1);
      expect(calendarQueryAgent._timeframeForDate(y)).toBe('yesterday');
    });

    it('arbitrary future date -> ISO YYYY-MM-DD', () => {
      const future = new Date();
      future.setDate(future.getDate() + 7);
      const result = calendarQueryAgent._timeframeForDate(future);
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('invalid input -> today (graceful degrade)', () => {
      expect(calendarQueryAgent._timeframeForDate('not a date')).toBe('today');
    });
  });
});
