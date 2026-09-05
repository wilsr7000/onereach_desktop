import { describe, expect, it } from 'vitest';
import { packIntervals } from './interval.js';
import { dayRangeOf, instantMs } from './time.js';
import { cd, item, NY, UTC } from './test-helpers.js';

const day = (iso: string, tz = UTC) => dayRangeOf(cd(iso), tz);
const byId = (p: ReturnType<typeof packIntervals>) => Object.fromEntries(p.map((x) => [x.itemId, x]));

describe('packIntervals', () => {
  it('places a lone item by fraction of the day', () => {
    const p = packIntervals([item('a', '2026-09-04T09:00', '2026-09-04T10:30', UTC)], day('2026-09-04'));
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ itemId: 'a', column: 0, columnCount: 1, clippedStart: false, clippedEnd: false });
    expect(p[0]?.top).toBeCloseTo(9 / 24, 10);
    expect(p[0]?.height).toBeCloseTo(1.5 / 24, 10);
  });
  it('overlapping items share the width evenly; non-overlapping items reuse columns (first fit)', () => {
    const items = [
      item('a', '2026-09-04T09:00', '2026-09-04T10:00', UTC),
      item('b', '2026-09-04T09:30', '2026-09-04T11:00', UTC),
      item('c', '2026-09-04T10:00', '2026-09-04T10:30', UTC), // fits back into column 0 after a
      item('d', '2026-09-04T13:00', '2026-09-04T14:00', UTC), // its own cluster
    ];
    const p = byId(packIntervals(items, day('2026-09-04')));
    expect([p['a']?.column, p['b']?.column, p['c']?.column]).toEqual([0, 1, 0]);
    expect([p['a']?.columnCount, p['b']?.columnCount, p['c']?.columnCount]).toEqual([2, 2, 2]);
    expect(p['d']).toMatchObject({ column: 0, columnCount: 1 });
  });
  it('twelve items at the same hour get twelve columns; a staircase reuses three', () => {
    const same = Array.from({ length: 12 }, (_, i) => item(`s${i}`, '2026-09-04T09:00', '2026-09-04T10:00', UTC));
    const p = packIntervals(same, day('2026-09-04'));
    expect(new Set(p.map((x) => x.column)).size).toBe(12);
    expect(p.every((x) => x.columnCount === 12)).toBe(true);
    const stairs = Array.from({ length: 10 }, (_, i) => item(`t${i}`, `2026-09-04T${String(9 + Math.floor((i * 20) / 60)).padStart(2, '0')}:${String((i * 20) % 60).padStart(2, '0')}`, `2026-09-04T${String(9 + Math.floor((i * 20 + 45) / 60)).padStart(2, '0')}:${String((i * 20 + 45) % 60).padStart(2, '0')}`, UTC));
    const q = packIntervals(stairs, day('2026-09-04'));
    expect(Math.max(...q.map((x) => x.columnCount))).toBe(3);
  });
  it('an item crossing midnight is clipped into each day with the continuation flags set', () => {
    const it1 = item('x', '2026-09-04T23:00', '2026-09-05T01:00', UTC);
    const d1 = packIntervals([it1], day('2026-09-04'))[0];
    const d2 = packIntervals([it1], day('2026-09-05'))[0];
    expect(d1).toMatchObject({ clippedStart: false, clippedEnd: true });
    expect(d1?.top).toBeCloseTo(23 / 24, 10);
    expect(d1?.height).toBeCloseTo(1 / 24, 10);
    expect(d2).toMatchObject({ clippedStart: true, clippedEnd: false, top: 0 });
    expect(d2?.height).toBeCloseTo(1 / 24, 10);
    expect(packIntervals([it1], day('2026-09-06'))).toHaveLength(0);
  });
  it('a zero-duration item is placed with height 0 and still clusters with what surrounds it', () => {
    const items = [item('z', '2026-09-04T10:00', '2026-09-04T10:00', UTC), item('a', '2026-09-04T09:30', '2026-09-04T10:30', UTC)];
    const p = byId(packIntervals(items, day('2026-09-04')));
    expect(p['z']?.height).toBe(0);
    expect(p['z']?.top).toBeCloseTo(10 / 24, 10);
    expect(p['z']?.columnCount).toBe(2);
    expect(p['a']?.columnCount).toBe(2);
    // A zero-duration item at the very end of the range is outside it.
    expect(packIntervals([item('e', '2026-09-05T00:00', '2026-09-05T00:00', UTC)], day('2026-09-04'))).toHaveLength(0);
    // An inverted interval is treated as zero-duration at its start.
    expect(packIntervals([item('inv', '2026-09-04T12:00', '2026-09-04T11:00', UTC)], day('2026-09-04'))[0]?.height).toBe(0);
  });
  it('spring-forward: the day is 23 hours and an item across the gap keeps its real duration', () => {
    // America/New_York, 2026-03-08: 02:00 → 03:00.
    const range = day('2026-03-08', NY);
    expect(instantMs(range.end) - instantMs(range.start)).toBe(23 * 3_600_000);
    const p = packIntervals([item('g', '2026-03-08T01:30', '2026-03-08T03:30', NY)], range)[0];
    expect(p?.top).toBeCloseTo(90 / (23 * 60), 10);
    expect(p?.height).toBeCloseTo(60 / (23 * 60), 10); // one real hour, not two
  });
  it('fall-back: the day is 25 hours and a late-evening item sits where the clock says', () => {
    // America/New_York, 2026-11-01: 02:00 → 01:00.
    const range = day('2026-11-01', NY);
    expect(instantMs(range.end) - instantMs(range.start)).toBe(25 * 3_600_000);
    const p = packIntervals([item('l', '2026-11-01T23:00', '2026-11-01T23:30', NY)], range)[0];
    expect(p?.top).toBeCloseTo((24 * 60) / (25 * 60), 10);
  });
  it('lanes pack independently and all-day items are ignored', () => {
    const items = [
      item('p1', '2026-09-04T09:00', '2026-09-04T10:00', UTC, { lane: 'alice' }),
      item('p2', '2026-09-04T09:00', '2026-09-04T10:00', UTC, { lane: 'bob' }),
      item('ad', '2026-09-04T00:00', '2026-09-05T00:00', UTC, { allDay: true }),
    ];
    const p = byId(packIntervals(items, day('2026-09-04')));
    expect(Object.keys(p).sort()).toEqual(['p1', 'p2']);
    expect(p['p1']).toMatchObject({ lane: 'alice', column: 0, columnCount: 1 });
    expect(p['p2']).toMatchObject({ lane: 'bob', column: 0, columnCount: 1 });
  });
  it('rejects an empty day range', () => {
    const r = day('2026-09-04');
    expect(() => packIntervals([], { start: r.start, end: r.start })).toThrow(RangeError);
  });
});
