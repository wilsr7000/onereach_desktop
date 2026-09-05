/**
 * ADR-090 addendum — Space events on the Calendar: the sight-filtered
 * commit query, row mapping, per-day / per-Space grouping, the API, and
 * the day link + modal builders.
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { SPACE_EVENTS_CYPHER, groupSpaceEventsByDay, kindOf, rowToSpaceEvent, type SpaceEvent } from '../../calendar/space-events.js';
import { CalendarService } from '../../calendar/api.js';
import { buildDayEventsLink, buildSpaceEventsModal, summaryText } from '../../calendar/renderer.js';

const ev = (id: string, atMs: number, spaceId: string, spaceName: string, over: Partial<SpaceEvent> = {}): SpaceEvent => ({ id, atMs, kind: 'added', author: 'robb@onereach.com', spaceId, spaceName, itemId: `i-${id}`, itemTitle: `Item ${id}`, itemKind: 'note', ...over });

describe('space events — query contract', () => {
  it('is a time-range read over commits with the ADR-084 predicate and nothing inferred', () => {
    expect(SPACE_EVENTS_CYPHER).toContain('MATCH (c:Commit)');
    expect(SPACE_EVENTS_CYPHER).toContain('c.timestamp >= $fromMs AND c.timestamp < $toMs');
    expect(SPACE_EVENTS_CYPHER).toContain('HAS_ACCESS');
    expect(SPACE_EVENTS_CYPHER).not.toContain('[:OWNS]');
    expect(SPACE_EVENTS_CYPHER).toContain('[:TOUCHED]->(a:Asset)');
    // An edgeless commit is visible only to its author or through a visible Space.
    expect(SPACE_EVENTS_CYPHER).toContain("toLower(coalesce(c.author, '')) = $viewerId");
  });
  it('maps rows and normalises kinds', () => {
    expect(kindOf('item:added')).toBe('added');
    expect(kindOf('item:Updated')).toBe('updated');
    expect(kindOf('custom')).toBe('custom');
    const e = rowToSpaceEvent({ id: 'h1', atMs: 1000, message: 'item:edited', author: 'a@b.c', spaceId: 's1', spaceName: 'Gartner MQ', item: { id: 'i1', title: 'Doc', kind: 'note' } });
    expect(e).toEqual({ id: 'h1', atMs: 1000, kind: 'edited', author: 'a@b.c', spaceId: 's1', spaceName: 'Gartner MQ', itemId: 'i1', itemTitle: 'Doc', itemKind: 'note' });
    expect(rowToSpaceEvent({ id: '', atMs: 1 })).toBeNull();
    expect(rowToSpaceEvent({ id: 'x', atMs: 'nope' })).toBeNull();
    expect(rowToSpaceEvent({ id: 'x', atMs: '5', message: 'item:added', spaceName: '' })?.spaceName).toBe('Uncategorized');
  });
  it('groups per local day (in the given zone) and per Space, most active Space first', () => {
    const base = Date.UTC(2026, 8, 4, 23, 30); // 23:30 UTC Sep 4 = 16:30 Sep 4 in Los Angeles, 02:30 Sep 5 in Kyiv
    const events = [ev('a', base, 's1', 'Gartner MQ'), ev('b', base + 60000, 's1', 'Gartner MQ'), ev('c', base + 120000, 's2', 'WISER Meetings'), ev('d', base + 86400000, 's2', 'WISER Meetings')];
    const la = groupSpaceEventsByDay(events, 'America/Los_Angeles');
    expect(la.map((d) => [d.date, d.total])).toEqual([['2026-09-04', 3], ['2026-09-05', 1]]);
    expect(la[0]?.spaces).toEqual([{ spaceId: 's1', spaceName: 'Gartner MQ', count: 2 }, { spaceId: 's2', spaceName: 'WISER Meetings', count: 1 }]);
    const kyiv = groupSpaceEventsByDay(events, 'Europe/Kiev');
    expect(kyiv.map((d) => d.date)).toEqual(['2026-09-05', '2026-09-06']);
    expect(groupSpaceEventsByDay([], 'UTC')).toEqual([]);
  });
});

describe('space events — API', () => {
  const svc = (query?: (c: string, p: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>) => {
    let now = 1_800_000_000_000;
    const s = new CalendarService({ getSession: () => ({ env: 'edison', accountId: 'acct' }), fetch: (async () => { throw new Error('no fetch in this test'); }) as never, openGsxWindow: async () => ({}), openCalendarWindow: () => undefined, now: () => now, ...(query !== undefined ? { query, viewerId: () => 'Robb@onereach.com' } : {}) });
    return { s, tick: (ms: number) => { now += ms; } };
  };
  it('injects the viewer, the range and the cap; groups; caches for a minute; refresh re-reads', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const query = vi.fn(async (_c: string, p: Record<string, unknown>) => { calls.push(p); return [{ id: 'h1', atMs: 1_799_999_000_000, message: 'item:added', author: 'a', spaceId: 's1', spaceName: 'Gartner MQ', item: null }]; });
    const { s, tick } = svc(query);
    const r = await s.spaceEvents({ fromMs: 1_799_000_000_000, toMs: 1_800_000_000_000, timeZone: 'UTC' });
    expect(r.unavailable).toBe(false);
    expect(r.total).toBe(1);
    expect(r.days[0]?.spaces[0]).toEqual({ spaceId: 's1', spaceName: 'Gartner MQ', count: 1 });
    expect(calls[0]).toMatchObject({ fromMs: 1_799_000_000_000, toMs: 1_800_000_000_000, limit: 5000, viewerId: 'robb@onereach.com', nowMs: 1_800_000_000_000 });
    await s.spaceEvents({ fromMs: 1_799_000_000_000, toMs: 1_800_000_000_000, timeZone: 'UTC' });
    expect(query).toHaveBeenCalledTimes(1);
    tick(61_000);
    await s.spaceEvents({ fromMs: 1_799_000_000_000, toMs: 1_800_000_000_000, timeZone: 'UTC' });
    expect(query).toHaveBeenCalledTimes(2);
    await s.spaceEvents({ fromMs: 1_799_000_000_000, toMs: 1_800_000_000_000, timeZone: 'UTC', refresh: true });
    expect(query).toHaveBeenCalledTimes(3);
  });
  it('without a graph, or when it fails, the calendar still works: unavailable, no events', async () => {
    const { s } = svc();
    expect(await s.spaceEvents({ fromMs: 0, toMs: 1000, timeZone: 'UTC' })).toMatchObject({ unavailable: true, total: 0, events: [] });
    const { s: failing } = svc(async () => { throw new Error('neon down'); });
    expect((await failing.spaceEvents({ fromMs: 0, toMs: 1000, timeZone: 'UTC' })).unavailable).toBe(true);
    await expect(s.spaceEvents({ fromMs: 10, toMs: 5, timeZone: 'UTC' })).rejects.toMatchObject({ code: 'CALENDAR_INVALID_INPUT' });
  });
});

describe('space events — day link and modal', () => {
  const day = { date: '2026-09-04', total: 3, spaces: [{ spaceId: 's1', spaceName: 'Gartner MQ', count: 2 }, { spaceId: 's2', spaceName: 'WISER Meetings', count: 1 }] };
  const base = new Date(2026, 8, 4, 10, 0).getTime();
  const events = [ev('a', base, 's1', 'Gartner MQ', { itemTitle: 'RFI answers' }), ev('b', base + 3600000, 's1', 'Gartner MQ', { kind: 'updated', itemTitle: 'RFI answers' }), ev('c', base + 7200000, 's2', 'WISER Meetings', { author: 'device_mac.lan_x', itemTitle: '', itemKind: 'meeting' })];
  it('the day link says how many and in how many Spaces, and does not select the day', () => {
    const onClick = vi.fn();
    const link = buildDayEventsLink(day, onClick);
    expect(link.textContent).toBe('3 events · 2 Spaces');
    expect(link.title).toContain('Gartner MQ: 2');
    const parent = document.createElement('div');
    const parentClick = vi.fn();
    parent.addEventListener('click', parentClick);
    parent.appendChild(link);
    link.click();
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(parentClick).not.toHaveBeenCalled();
  });
  it('the modal lists counts by Space and every event, closes by ×, Escape and the backdrop, and opens a Space', () => {
    const onClose = vi.fn();
    const onOpenSpace = vi.fn();
    const modal = buildSpaceEventsModal({ day, events, onClose, onOpenSpace });
    document.body.replaceChildren(modal);
    const dialog = modal.querySelector('[role="dialog"]')!;
    expect(dialog.getAttribute('aria-label')).toContain('Friday, September 4, 2026');
    expect(modal.querySelector('.cal-modal__summary')?.textContent).toBe('3 events across 2 Spaces');
    const groups = modal.querySelectorAll('.cal-modal__space');
    expect(groups).toHaveLength(2);
    expect(groups[0]?.querySelector('.cal-modal__space-name')?.textContent).toBe('Gartner MQ');
    expect(groups[0]?.querySelector('.cal-modal__space-count')?.textContent).toBe('2 events');
    expect(groups[0]?.querySelectorAll('.cal-modal__event')).toHaveLength(2);
    expect(groups[1]?.querySelector('.cal-modal__what')?.textContent).toBe('a meeting added');
    expect(groups[1]?.querySelector('.cal-modal__who')?.textContent).toBe('by a device');
    (groups[0]?.querySelector('button.cal-btn-quiet') as HTMLButtonElement).click();
    expect(onOpenSpace).toHaveBeenCalledWith('s1');
    (modal.querySelector('.cal-modal__close') as HTMLButtonElement).click();
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    modal.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onClose).toHaveBeenCalledTimes(3);
  });
  it('the header summary counts Space events this month', () => {
    const snap = { env: 'e', accountId: 'a', fetchedAtMs: 0, botCount: 1, flowCount: 1, activeDeployments: 1, scheduled: [], errors: [] };
    expect(summaryText(snap, 4, 12)).toBe('0 scheduled flows · 0 armed · 4 runs this month · 12 Space events');
    expect(summaryText(snap, 1, 0)).toBe('0 scheduled flows · 0 armed · 1 run this month');
  });
});
