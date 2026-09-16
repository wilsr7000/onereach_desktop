/**
 * calendar-query-agent brief scoping (2026-09-15):
 *  - live events are scoped to the TARGET DAY before the cap;
 *  - the app-local store is left out whenever the live calendar answered;
 *  - the "what changed" diff compares only the target day and skips
 *    baselines older than a week ("39 new since 12 days ago" was the
 *    fortnight sliding, not the day changing).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../lib/log-event-queue', () => ({
  getLogQueue: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const agent = require('../../packages/agents/calendar-query-agent');

const day = (d, hh, mm = 0) => new Date(2026, 8, d, hh, mm).toISOString();
const live = (title, d, hh, endHh) => ({
  id: `live_${title}_${d}`,
  summary: title,
  start: { dateTime: day(d, hh) },
  end: { dateTime: day(d, endHh) },
});

describe('_eventsOnDay', () => {
  it('keeps only events touching the target local day, keeps undated rows', () => {
    const events = [live('today', 15, 9, 10), live('tomorrow', 16, 9, 10), { id: 'x', summary: 'undated' }, live('late-yesterday', 14, 23, 23)];
    const kept = agent._eventsOnDay(events, new Date(2026, 8, 15, 7, 0));
    expect(kept.map((e) => e.summary)).toEqual(['today', 'undated']);
  });
  it('an all-day row on the target day is kept', () => {
    const kept = agent._eventsOnDay([{ id: 'ad', summary: 'OOO', start: { date: '2026-09-15' }, end: { date: '2026-09-16' } }], new Date(2026, 8, 15, 12));
    expect(kept).toHaveLength(1);
  });
});

describe('getBriefing: day scope + live-first merge policy', () => {
  let store, fetchSpy, storeSpy, initSpy, diffSpy, selfSpy;
  beforeEach(() => {
    store = { generateMorningBrief: vi.fn().mockResolvedValue({ timeline: [{ title: 'X', start: '9:00 AM', end: '10:00 AM', status: 'upcoming' }], conflicts: [], backToBack: [] }) };
    fetchSpy = vi.spyOn(agent, '_fetchLiveEventsForBrief');
    storeSpy = vi.spyOn(agent, '_getStore').mockReturnValue(store);
    initSpy = vi.spyOn(agent, 'initialize').mockResolvedValue(undefined);
    diffSpy = vi.spyOn(agent, '_buildSnapshotDiff').mockResolvedValue(null);
    selfSpy = vi.spyOn(agent, '_selfEmail').mockResolvedValue('robb@onereach.com');
    global.settingsManager = { get: vi.fn(() => undefined) };
    agent.calendarMemory = null;
  });
  afterEach(() => {
    fetchSpy.mockRestore();
    storeSpy.mockRestore();
    initSpy.mockRestore();
    diffSpy.mockRestore();
    selfSpy.mockRestore();
    delete global.settingsManager;
  });

  it('scopes the 14-day window to the target day BEFORE capping, and excludes the local store', async () => {
    const window = [live('today-a', 15, 9, 10), live('tomorrow', 16, 9, 10), live('today-b', 15, 11, 12), live('next-week', 22, 9, 10)];
    fetchSpy.mockResolvedValue(window);
    await agent.getBriefing({ targetDate: new Date(2026, 8, 15, 7), dateLabel: 'today' });
    const [, externalEvents, opts] = store.generateMorningBrief.mock.calls[0];
    expect(externalEvents.map((e) => e.summary)).toEqual(['today-a', 'today-b']);
    expect(opts).toEqual({ includeLocal: false });
  });

  it('when the live fetch fails, the local store is merged (nothing else to show)', async () => {
    fetchSpy.mockRejectedValue(new Error('omnical down'));
    await agent.getBriefing({ targetDate: new Date(2026, 8, 15, 7), dateLabel: 'today' });
    const [, externalEvents, opts] = store.generateMorningBrief.mock.calls[0];
    expect(externalEvents).toEqual([]);
    expect(opts).toEqual({ includeLocal: true });
  });

  it('calendar.briefIncludeLocalEvents = true opts the local store back in', async () => {
    global.settingsManager = { get: vi.fn((k) => (k === 'calendar.briefIncludeLocalEvents' ? true : undefined)) };
    fetchSpy.mockResolvedValue([live('today-a', 15, 9, 10)]);
    await agent.getBriefing({ targetDate: new Date(2026, 8, 15, 7), dateLabel: 'today' });
    const [, , opts] = store.generateMorningBrief.mock.calls[0];
    expect(opts).toEqual({ includeLocal: true });
  });

  it('the contribution carries { line, spoken } items for the dayView', async () => {
    fetchSpy.mockResolvedValue([live('today-a', 15, 9, 10)]);
    const result = await agent.getBriefing({ targetDate: new Date(2026, 8, 15, 7), dateLabel: 'today' });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ title: 'X', line: expect.stringContaining('X'), spoken: expect.stringContaining('X') });
    expect(result.content).toContain('Schedule conflicts (overlapping meetings): none.');
  });
});

describe('_buildSnapshotDiff: target-day only, recent baselines only', () => {
  const T = new Date(2026, 8, 15, 7, 0);
  const priorEvents = {
    'k-tt': { title: 'Think Tank', startISO: day(15, 9), endISO: day(15, 10), recurringEventId: 'r1' },
    'k-old': { title: 'Old thing', startISO: day(15, 14), endISO: day(15, 15), recurringEventId: null },
    'k-next-week': { title: 'Next week', startISO: day(22, 9), endISO: day(22, 10), recurringEventId: null },
  };
  function withPrior(ageDays) {
    agent.calendarMemory = { getMostRecentBriefSnapshot: vi.fn(() => ({ date: '2026-09-14', events: priorEvents, ageDays })) };
  }
  afterEach(() => {
    agent.calendarMemory = null;
  });

  it('diffs only the target day: window shifts are not "new" or "cancelled"', async () => {
    withPrior(1);
    const today = [
      { id: 'k-tt', summary: 'Think Tank', start: { dateTime: day(15, 9) }, end: { dateTime: day(15, 10) } },
      { id: 'k-new', summary: 'Added today', start: { dateTime: day(15, 16) }, end: { dateTime: day(15, 17) } },
      { id: 'k-far', summary: 'Two weeks out', start: { dateTime: day(28, 9) }, end: { dateTime: day(28, 10) } },
    ];
    const diff = await agent._buildSnapshotDiff(T, today);
    expect(diff.diff.added.map((e) => e.title)).toEqual(['Added today']);
    expect(diff.diff.removed.map((e) => e.title)).toEqual(['Old thing']); // was on the 15th in the baseline, gone now
    expect(diff.line).toBe('new since yesterday: "Added today"; "Old thing" was cancelled.');
  });

  it('a baseline older than a week yields no diff line', async () => {
    withPrior(12);
    const diff = await agent._buildSnapshotDiff(T, [{ id: 'k-new', summary: 'Added', start: { dateTime: day(15, 16) }, end: { dateTime: day(15, 17) } }]);
    expect(diff).toBeNull();
  });
});
