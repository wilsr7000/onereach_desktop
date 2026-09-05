import { describe, expect, it } from 'vitest';
import { coveredDays, layoutAllDay, segmentsInColumn } from './allday.js';
import { visibleRange } from './range.js';
import { cd, item, NY, UTC } from './test-helpers.js';

const week = (start: string, tz = UTC) => ({ days: visibleRange('week', cd(start), 0, tz).days, timeZone: tz });
const allDay = (id: string, start: string, end: string, tz = UTC) => item(id, start, end, tz, { allDay: true });

describe('layoutAllDay', () => {
  it('a single all-day item (end-exclusive midnight) covers one cell', () => {
    const s = layoutAllDay([allDay('a', '2026-09-05', '2026-09-06')], week('2026-08-30'));
    expect(s).toEqual([{ itemId: 'a', row: 0, startCol: 6, endCol: 6, continuesBefore: false, continuesAfter: false }]);
  });
  it('a timed item crossing midnight spans two cells in a month row; an item ending at midnight does not', () => {
    const cross = layoutAllDay([item('x', '2026-09-04T23:00', '2026-09-05T01:00', UTC)], week('2026-08-30'))[0];
    expect(cross).toMatchObject({ startCol: 5, endCol: 6 });
    const flush = layoutAllDay([item('y', '2026-09-04T22:00', '2026-09-05T00:00', UTC)], week('2026-08-30'))[0];
    expect(flush).toMatchObject({ startCol: 5, endCol: 5 });
    expect(coveredDays(item('z', '2026-09-04T10:00', '2026-09-04T10:00', UTC), UTC).last.day).toBe(4);
  });
  it('bars keep a stable row across the days they span; first fit in start order, so a short Monday bar takes row 1 before Tue–Fri arrives', () => {
    const items = [
      allDay('mon-wed', '2026-08-31', '2026-09-03'),
      allDay('tue-fri', '2026-09-01', '2026-09-05'),
      allDay('thu', '2026-09-03', '2026-09-04'),
      allDay('mon', '2026-08-31', '2026-09-01'),
    ];
    const s = Object.fromEntries(layoutAllDay(items, week('2026-08-30')).map((x) => [x.itemId, x]));
    expect(s['mon-wed']).toMatchObject({ row: 0, startCol: 1, endCol: 3 });
    expect(s['mon']).toMatchObject({ row: 1, startCol: 1, endCol: 1 }); // placed second: same start, shorter
    expect(s['tue-fri']).toMatchObject({ row: 1, startCol: 2, endCol: 5 }); // row 1 is free from Tuesday on
    expect(s['thu']).toMatchObject({ row: 0, startCol: 4, endCol: 4 }); // after mon-wed ends
    expect(segmentsInColumn(Object.values(s), 4).map((x) => x.itemId)).toEqual(['thu', 'tue-fri']);
  });
  it('a multi-week item is one clipped segment per week with continuation flags', () => {
    const long = allDay('long', '2026-09-03', '2026-09-18'); // Sep 3 through Sep 17
    const w1 = layoutAllDay([long], week('2026-08-30'))[0];
    const w2 = layoutAllDay([long], week('2026-09-06'))[0];
    const w3 = layoutAllDay([long], week('2026-09-13'))[0];
    const w4 = layoutAllDay([long], week('2026-09-20'));
    expect(w1).toMatchObject({ startCol: 4, endCol: 6, continuesBefore: false, continuesAfter: true });
    expect(w2).toMatchObject({ startCol: 0, endCol: 6, continuesBefore: true, continuesAfter: true });
    expect(w3).toMatchObject({ startCol: 0, endCol: 4, continuesBefore: true, continuesAfter: false });
    expect(w4).toHaveLength(0);
  });
  it('coverage is decided in the target zone: a UTC-midnight all-day item lands on one local day in New York', () => {
    // 2026-09-05 00:00 UTC → 2026-09-04 20:00 in New York; 2026-09-06 00:00 UTC → 2026-09-05 20:00 New York.
    const s = layoutAllDay([allDay('u', '2026-09-05', '2026-09-06', UTC)], week('2026-08-30', NY))[0];
    expect(s).toMatchObject({ startCol: 5, endCol: 6 });
    const local = layoutAllDay([allDay('l', '2026-09-05', '2026-09-06', NY)], week('2026-08-30', NY))[0];
    expect(local).toMatchObject({ startCol: 6, endCol: 6 });
  });
  it('an empty run yields nothing', () => {
    expect(layoutAllDay([allDay('a', '2026-09-05', '2026-09-06')], { days: [], timeZone: UTC })).toEqual([]);
  });
});
