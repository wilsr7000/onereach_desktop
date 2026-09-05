/**
 * Calendar renderer (ADR-090) — pure builders: the month grid, the day
 * pane, the detail pane, and the series description.
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { buildDayPane, buildDetail, buildMonthGrid, describeSeries, groupRuns, keyOf, summaryText } from '../../calendar/renderer.js';

const occ = (atMs: number, over: Partial<LiteCalendarOccurrence> = {}): LiteCalendarOccurrence => ({ atMs, flowId: 'f1', botId: 'b1', botLabel: 'Reporting', flowLabel: 'Nightly report', description: 'Nightly reporting run', eventId: 'e1', eventName: 'Nightly', color: '#FFC107', timeZone: 'UTC', ...over });
const day = (y: number, m: number, d: number, h = 0, mi = 0): number => new Date(y, m - 1, d, h, mi).getTime();
const flow = (over: Partial<LiteCalendarScheduledFlow> = {}): LiteCalendarScheduledFlow => ({
  flowId: 'f1', botId: 'b1', botLabel: 'Reporting', flowLabel: 'Nightly report', description: 'Nightly reporting run', deployed: true, stepLabel: 'Schedule execution', modifiedMs: 0, active: true, armed: true, activatedMs: day(2026, 9, 1, 8), nextFireMs: day(2026, 9, 6, 2),
  events: [{ id: 'e1', name: 'Nightly', color: '#FFC107', timeZone: 'Europe/Kiev', cron: ['0 2 1/1 * ? *'], recurring: true, start: { date: '2026-01-01', time: '00:00' }, end: null, preview: 'Every 1st day', runAtActivation: true }],
  ...over,
});

describe('calendar UI — grid', () => {
  it('draws 42 cells for the month, marks today and the selection, and collapses a series into one chip with its count', () => {
    const runs = Array.from({ length: 288 }, (_, i) => occ(day(2026, 9, 5) + i * 5 * 60000, { eventName: '5min' }));
    runs.push(occ(day(2026, 9, 12, 9), { flowId: 'f2', flowLabel: 'Weekly digest', eventId: 'e2', eventName: 'Weekly' }));
    const onSelect = vi.fn();
    const grid = buildMonthGrid(runs, { year: 2026, month: 9, selected: '2026-09-12', today: '2026-09-05', onSelect });
    document.body.replaceChildren(grid);
    const cells = grid.querySelectorAll('.cal-day');
    expect(cells).toHaveLength(42);
    const fifth = grid.querySelector('[data-day="2026-09-05"]')!;
    expect(fifth.classList.contains('is-today')).toBe(true);
    expect(fifth.querySelectorAll('.cal-chip')).toHaveLength(1);
    expect(fifth.querySelector('.cal-chip-count')?.textContent).toBe('×288');
    expect(fifth.querySelector('.cal-chip')?.getAttribute('title')).toContain('every 5 min');
    const twelfth = grid.querySelector('[data-day="2026-09-12"]')!;
    expect(twelfth.classList.contains('is-selected')).toBe(true);
    expect(twelfth.querySelector('.cal-chip-text')?.textContent).toBe('Weekly · Weekly digest');
    (twelfth as HTMLButtonElement).click();
    expect(onSelect).toHaveBeenCalledWith('2026-09-12');
    expect(grid.querySelector('[data-day="2026-08-30"]')?.classList.contains('is-outside')).toBe(true);
  });
  it('describes a series: uniform interval, mixed times, single run', () => {
    const base = day(2026, 9, 5, 0, 0);
    expect(describeSeries([base, base + 5 * 60000, base + 10 * 60000])).toMatch(/^every 5 min, .*\(3 runs\)$/);
    expect(describeSeries([base, base + 3600000 * 2])).toMatch(/^every 2 h, /);
    expect(describeSeries([base, base + 60000, base + 600000])).toMatch(/^3 runs, /);
    expect(describeSeries([base])).not.toContain('runs');
    expect(groupRuns([occ(base), occ(base + 1, { flowId: 'f2', eventId: 'e2' }), occ(base + 2)]).map((g) => g.times.length)).toEqual([2, 1]);
  });
});

describe('calendar UI — panes', () => {
  it('the day pane lists each (flow, event) once and hands the pick back', () => {
    const onPick = vi.fn();
    const base = day(2026, 9, 5, 9);
    const pane = buildDayPane([occ(base), occ(base + 1800000), occ(base, { flowId: 'f2', flowLabel: 'Other', eventId: 'e9', eventName: 'Once' })], { key: '2026-09-05', onPick });
    document.body.replaceChildren(pane);
    const rows = pane.querySelectorAll('.cal-run');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.querySelector('.cal-run-meta')?.textContent).toContain('every 30 min');
    (rows[1] as HTMLElement).click();
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ flowId: 'f2', eventName: 'Once' }));
    expect(buildDayPane([], { key: '2026-09-06', onPick }).textContent).toContain('No scheduled runs');
  });
  it('the detail pane shows activation, the schedule as authored, next runs, and opens the flow', () => {
    const onOpen = vi.fn();
    const now = day(2026, 9, 5, 12);
    const upcoming = [occ(day(2026, 9, 6, 2)), occ(day(2026, 9, 7, 2)), occ(day(2026, 9, 4, 2))];
    const pane = buildDetail(flow(), { nowMs: now, upcoming, onOpen, onBack: vi.fn() });
    document.body.replaceChildren(pane);
    expect(pane.querySelector('.cal-badge')?.textContent).toBe('armed');
    expect(pane.textContent).toContain('Event Manager holds its schedule trigger');
    expect(pane.textContent).toContain('Every 1st day');
    expect(pane.textContent).toContain('Europe/Kiev');
    expect(pane.querySelector('code')?.textContent).toBe('0 2 1/1 * ? *');
    expect(pane.querySelectorAll('.cal-list li')).toHaveLength(2); // only future runs
    (pane.querySelector('#cal-open-flow') as HTMLButtonElement).click();
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ flowId: 'f1', botId: 'b1' }));
    const idle = buildDetail(flow({ active: false, armed: false, activatedMs: 0, nextFireMs: null }), { nowMs: now, upcoming: [], onOpen, onBack: vi.fn() });
    expect(idle.querySelector('.cal-badge')?.textContent).toBe('not active');
    expect(idle.textContent).toContain('nothing will fire until the flow is activated');
  });
  it('past runs get a "Get log summary" button that fetches only on click and renders the narrative; future runs do not', async () => {
    const now = day(2026, 9, 5, 12);
    const upcoming = [occ(day(2026, 9, 4, 2)), occ(day(2026, 9, 3, 2)), occ(day(2026, 9, 6, 2))];
    const onLogSummary = vi.fn(async () => ({ flowId: 'f1', fromMs: 0, toMs: 1, narrative: '1 execution, 3 log lines, billed 216 ms, no errors.', aiNarrative: 'It ran once and finished cleanly.', truncated: false, fetchedAtMs: 1, summary: { lines: 3, executions: [{ requestId: 'r', startMs: day(2026, 9, 4, 2), endMs: day(2026, 9, 4, 2) + 200, durationMs: 200, lines: 3, steps: [], errors: [], completed: true, billedMs: 216, memoryMb: 142 }], firstMs: 1, lastMs: 2, errorCount: 0, types: {}, steps: [], messages: ['Version: 1'] } }));
    const pane = buildDetail(flow(), { nowMs: now, upcoming, onOpen: vi.fn(), onBack: vi.fn(), onLogSummary });
    document.body.replaceChildren(pane);
    const buttons = pane.querySelectorAll<HTMLButtonElement>('.cal-logsum-btn');
    expect(buttons).toHaveLength(2); // Sep 4 and Sep 3, most recent first
    expect(pane.querySelectorAll('.cal-run-row__when')[0]?.textContent).toContain('Sep 4');
    expect(onLogSummary).not.toHaveBeenCalled();
    buttons[0]!.click();
    expect(onLogSummary).toHaveBeenCalledWith({ fromMs: day(2026, 9, 4, 2) - 60_000, toMs: day(2026, 9, 4, 2) + 15 * 60_000 });
    await Promise.resolve();
    await Promise.resolve();
    expect(pane.querySelector('.cal-logsum__narrative')?.textContent).toContain('billed 216 ms');
    expect(pane.querySelector('.cal-logsum__ai')?.textContent).toBe('It ran once and finished cleanly.');
    expect(pane.querySelector('.cal-logsum__runs li')?.textContent).toContain('finished · 216 ms billed');
    expect(buttons[0]!.textContent).toBe('Refresh log summary');
    // With no past runs, a "latest logs" button covers the last 24 hours.
    const none = buildDetail(flow(), { nowMs: now, upcoming: [occ(day(2026, 9, 6, 2))], onOpen: vi.fn(), onBack: vi.fn(), onLogSummary });
    expect(none.querySelector('.cal-run-row__when')?.textContent).toBe('Latest logs (last 24 h)');
  });
  it('the summary counts flows, armed flows and runs; keyOf uses the local day', () => {
    const snap: LiteCalendarSnapshot = { env: 'edison', accountId: 'a', fetchedAtMs: 0, botCount: 1, flowCount: 2, activeDeployments: 1, scheduled: [flow(), flow({ flowId: 'f2', armed: false })], errors: [] };
    expect(summaryText(snap, 30)).toBe('2 scheduled flows · 1 armed · 30 runs this month');
    expect(summaryText(null, 0)).toBe('scheduled flows');
    expect(keyOf(day(2026, 9, 5, 23, 59))).toBe('2026-09-05');
  });
});
