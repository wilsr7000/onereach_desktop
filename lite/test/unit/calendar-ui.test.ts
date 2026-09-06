/**
 * Calendar renderer (ADR-090) — pure builders: the month grid, the day
 * pane, the detail pane, and the series description.
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { buildDayPane, buildDayView, buildDetail, buildMonthGrid, buildWeekView, describeSeries, groupRuns, keyOf, rangeFor, summaryText, titleFor, weekStartOf } from '../../calendar/renderer.js';

const occ = (atMs: number, over: Partial<LiteCalendarOccurrence> = {}): LiteCalendarOccurrence => ({ atMs, flowId: 'f1', botId: 'b1', botLabel: 'Reporting', flowLabel: 'Nightly report', description: 'Nightly reporting run', eventId: 'e1', eventName: 'Nightly', color: '#FFC107', timeZone: 'UTC', pastWindow: false, ...over });
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
    expect(twelfth.querySelector('.cal-chip-text')?.textContent).toBe('Weekly digest');
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
    expect(summaryText(snap, 8661, 2, 8640)).toBe('2 scheduled flows · 1 armed · 8,661 runs this month · 8,640 grey (will not fire) · 2 Space events');
    expect(summaryText(null, 0)).toBe('scheduled flows');
    expect(keyOf(day(2026, 9, 5, 23, 59))).toBe('2026-09-05');
  });
});

const NOW = day(2026, 9, 5, 12);
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('calendar UI — armed and not armed', () => {
  it('unarmed runs are dimmed in the grid and badged in the day pane; the account list counts and badges every scheduled flow', () => {
    const base = day(2026, 9, 5, 9);
    const armedById = new Map([['f1', true], ['f2', false]]);
    const grid = buildMonthGrid([occ(base), occ(base, { flowId: 'f2', flowLabel: 'Idle', eventId: 'e2' })], { year: 2026, month: 9, selected: null, today: '2026-09-05', onSelect: vi.fn(), armedById });
    const chips = Array.from(grid.querySelectorAll('.cal-chip'));
    expect(chips).toHaveLength(2);
    expect(chips.filter((c) => c.classList.contains('is-unarmed')).map((c) => c.textContent)).toEqual([expect.stringContaining('Idle')]);
    const onPickFlow = vi.fn();
    const pane = buildDayPane([occ(base, { flowId: 'f2', flowLabel: 'Idle', eventId: 'e2' })], { key: '2026-09-05', onPick: vi.fn(), armedById, flows: [flow(), flow({ flowId: 'f2', flowLabel: 'Idle', active: false, armed: false })], onPickFlow });
    expect(pane.querySelector('.cal-run.is-unarmed .cal-badge')?.textContent).toBe('not armed');
    expect(pane.textContent).toContain('In this account · 2 scheduled, 1 armed, 1 not armed');
    const rows = Array.from(pane.querySelectorAll<HTMLElement>('.cal-flows__row'));
    expect(rows.map((r) => r.querySelector('.cal-badge')?.textContent)).toEqual(['armed', 'not armed']);
    rows[1]!.click();
    expect(onPickFlow).toHaveBeenCalledWith(expect.objectContaining({ flowId: 'f2' }));
  });

  it('Arm/Disarm asks inline, cancels, confirms through onSetArmed, and is inert without a handler; an ended window is noted', () => {
    const onSetArmed = vi.fn(async () => null);
    const pane = buildDetail(flow(), { nowMs: NOW, upcoming: [], onOpen: vi.fn(), onBack: vi.fn(), onSetArmed });
    const arm = pane.querySelector<HTMLButtonElement>('#cal-arm')!;
    const confirm = pane.querySelector<HTMLElement>('.cal-arm__confirm')!;
    expect(arm.textContent).toBe('Disarm');
    expect(confirm.hidden).toBe(true);
    arm.click();
    expect(confirm.hidden).toBe(false);
    confirm.querySelectorAll('button')[1]!.click();
    expect(confirm.hidden).toBe(true);
    expect(onSetArmed).not.toHaveBeenCalled();
    arm.click();
    pane.querySelector<HTMLButtonElement>('#cal-arm-confirm')!.click();
    expect(onSetArmed).toHaveBeenCalledWith(expect.objectContaining({ flowId: 'f1' }), false);
    expect(arm.disabled).toBe(true);
    const idle = buildDetail(flow({ active: false, armed: false }), { nowMs: NOW, upcoming: [], onOpen: vi.fn(), onBack: vi.fn() });
    expect(idle.querySelector<HTMLButtonElement>('#cal-arm')?.textContent).toBe('Arm');
    expect(idle.querySelector<HTMLButtonElement>('#cal-arm')?.disabled).toBe(true);
    expect(idle.querySelector('.cal-note')).toBeNull();
    const ended = buildDetail(flow({ events: [{ ...flow().events[0]!, end: { date: '2020-02-01', time: '' } }] }), { nowMs: NOW, upcoming: [], onOpen: vi.fn(), onBack: vi.fn() });
    expect(ended.querySelector('.cal-note')?.textContent).toContain('Every schedule window ended');
    expect(ended.querySelector('.cal-note')?.classList.contains('is-warn')).toBe(true);
  });

  it('the links block lists Space, playbook and journey-map buttons and opens each; none → a plain line; failure → unavailable', async () => {
    const links: LiteCalendarFlowLinks = {
      flowId: 'f1',
      spaces: [{ id: 'sp-1', name: 'Omni Data', via: 'asset', assetId: 'as-1', assetTitle: 'HTTP toolkit' }, { id: 'sp-2', name: 'Ops', via: 'name', assetId: null, assetTitle: null }],
      playbooks: [{ id: 'pb-1', title: 'HTTP toolkit playbook', spaceId: null, spaceName: null, via: 'build', builtAtMs: null, status: 'completed' }],
      journeys: [{ id: 'j-1', title: 'Onboarding', spaceId: 'sp-1', spaceName: 'Omni Data', via: 'asset' }],
      unavailable: false,
      fetchedAtMs: 0,
    };
    const onOpenSpace = vi.fn();
    const onOpenPlaybook = vi.fn();
    const onOpenJourney = vi.fn();
    const pane = buildDetail(flow(), { nowMs: NOW, upcoming: [], onOpen: vi.fn(), onBack: vi.fn(), onLinks: async () => links, onOpenSpace, onOpenPlaybook, onOpenJourney });
    expect(pane.querySelector('#cal-links')?.textContent).toContain('Looking for');
    await tick();
    const btns = Array.from(pane.querySelectorAll<HTMLButtonElement>('.cal-links__btn'));
    expect(btns.map((b) => b.textContent)).toEqual(['In Space · Omni Data', 'Near Space · Ops', 'Open playbook · HTTP toolkit playbook', 'Open journey map · Onboarding']);
    expect(btns[0]!.title).toContain('“HTTP toolkit”');
    btns[0]!.click();
    btns[2]!.click();
    btns[3]!.click();
    expect(onOpenSpace).toHaveBeenCalledWith('sp-1');
    expect(onOpenPlaybook).toHaveBeenCalledWith('pb-1');
    expect(onOpenJourney).toHaveBeenCalledWith('j-1');
    const none = buildDetail(flow(), { nowMs: NOW, upcoming: [], onOpen: vi.fn(), onBack: vi.fn(), onLinks: async () => ({ ...links, spaces: [], playbooks: [], journeys: [] }) });
    await tick();
    expect(none.querySelector('#cal-links')?.textContent).toContain('in no Space');
    const failed = buildDetail(flow(), { nowMs: NOW, upcoming: [], onOpen: vi.fn(), onBack: vi.fn(), onLinks: async () => { throw new Error('x'); } });
    await tick();
    expect(failed.querySelector('#cal-links')?.textContent).toContain('unavailable');
    expect(buildDetail(flow(), { nowMs: NOW, upcoming: [], onOpen: vi.fn(), onBack: vi.fn() }).querySelector('#cal-links')).toBeNull();
  });
});

describe('calendar UI — week and day views', () => {
  it('the week view has seven Sunday-first columns with runs in time order; a chip selects its day and picks the flow', () => {
    const onSelect = vi.fn();
    const onPick = vi.fn();
    const base = day(2026, 9, 3, 9);
    const week = buildWeekView([occ(base + 3600_000, { flowId: 'f2', flowLabel: 'Idle', eventId: 'e2' }), occ(base)], { anchorKey: '2026-09-05', selected: '2026-09-05', today: '2026-09-05', onSelect, onPick, armedById: new Map([['f2', false]]) });
    const cols = Array.from(week.querySelectorAll<HTMLElement>('.cal-week__day'));
    expect(cols.map((c) => c.dataset['key'])).toEqual(['2026-08-30', '2026-08-31', '2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05']);
    expect(cols[6]!.classList.contains('is-selected')).toBe(true);
    expect(cols[6]!.classList.contains('is-today')).toBe(true);
    const chips = Array.from(cols[4]!.querySelectorAll<HTMLButtonElement>('.cal-week__chip'));
    expect(chips.map((c) => c.querySelector('.cal-chip-name')?.textContent)).toEqual(['Nightly report', 'Idle']);
    expect(chips[1]!.classList.contains('is-unarmed')).toBe(true);
    expect(cols[0]!.querySelector('.cal-week__none')).not.toBeNull();
    chips[0]!.click();
    expect(onSelect).toHaveBeenCalledWith('2026-09-03');
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ flowId: 'f1' }));
    cols[1]!.querySelector<HTMLButtonElement>('.cal-week__head')!.click();
    expect(onSelect).toHaveBeenLastCalledWith('2026-08-31');
  });

  it('the day view has 24 hour rows with each run in its hour; titles and ranges follow the view', () => {
    const base = day(2026, 9, 5, 14, 30);
    const onPick = vi.fn();
    const view = buildDayView([occ(base), occ(base + 5 * 60_000)], { key: '2026-09-05', today: '2026-09-05', onPick });
    const rows = Array.from(view.querySelectorAll<HTMLElement>('.cal-dayview__hour'));
    expect(rows).toHaveLength(24);
    expect(rows.filter((r) => r.classList.contains('has-runs')).map((r) => r.dataset['hour'])).toEqual(['14']);
    const chip = rows[14]!.querySelector<HTMLButtonElement>('.cal-dayview__chip')!;
    expect(chip.querySelector('.cal-chip-when')?.textContent).toMatch(/×2$/);
    chip.click();
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ flowId: 'f1', times: [base, base + 5 * 60_000] }));
    expect(buildDayView([], { key: '2026-09-06', today: '2026-09-05', onPick }).textContent).toContain('No scheduled runs');
    expect(weekStartOf('2026-09-05').getDay()).toBe(0);
    expect(titleFor('month', 2026, 9, null)).toBe('September 2026');
    expect(titleFor('week', 2026, 9, '2026-09-05')).toBe('Aug 30 – Sep 5, 2026');
    expect(titleFor('day', 2026, 9, '2026-09-05')).toContain('September 5, 2026');
    expect(rangeFor('day', 2026, 9, '2026-09-05')).toEqual({ fromMs: day(2026, 9, 5), toMs: day(2026, 9, 6) });
    expect(rangeFor('week', 2026, 9, '2026-09-05')).toEqual({ fromMs: day(2026, 8, 30), toMs: day(2026, 9, 6) });
    expect(rangeFor('month', 2026, 9, null)).toEqual({ fromMs: day(2026, 9, 1), toMs: day(2026, 10, 1) });
  });
});

describe('calendar UI — grey means it will not fire', () => {
  it('a not-armed run is grey (no series colour), an armed one keeps its colour; past-window runs say so in the tooltip', () => {
    const base = day(2026, 9, 5, 9);
    const grid = buildMonthGrid([occ(base, { pastWindow: true }), occ(base, { flowId: 'f2', flowLabel: 'Idle', eventId: 'e2', pastWindow: true })], { year: 2026, month: 9, selected: null, today: '2026-09-05', onSelect: vi.fn(), armedById: new Map([['f1', true], ['f2', false]]) });
    const chips = Array.from(grid.querySelectorAll<HTMLElement>('.cal-chip'));
    const armed = chips.find((c) => !c.classList.contains('is-unarmed'))!;
    const grey = chips.find((c) => c.classList.contains('is-unarmed'))!;
    expect(armed.style.borderLeftColor).not.toBe('');
    expect(armed.title).toContain('Past its schedule window: the platform still holds the trigger');
    expect(grey.style.borderLeftColor).toBe('');
    expect(grey.title).toContain('Grey: the flow is not armed');
    const groups = groupRuns([occ(base), occ(base + 60_000, { pastWindow: true })]);
    expect(groups[0]?.pastWindow).toBe(true);
  });
});
