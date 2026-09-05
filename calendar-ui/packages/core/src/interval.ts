/**
 * Greedy interval partitioning for timed items in one day column.
 *
 * 1. Clip every timed item to the day range (absolute instants). Items
 *    that miss the range drop out; a zero-duration item stays if its
 *    instant is inside the range.
 * 2. For clustering only, a zero-duration item is widened to one minute.
 *    Overlap is `a.start < b.end && b.start < a.end`.
 * 3. Sort by start ascending, then longer first, then id.
 * 4. Sweep: items form clusters of transitive overlap; inside a cluster
 *    each item takes the lowest column whose last end is at or before
 *    the item's start (first-fit). Every member of a cluster shares the
 *    cluster's column count, so widths are even.
 * 5. Lanes pack independently: items in different lanes never cluster.
 *
 * Output positions are fractions of the day range, never pixels.
 */
import { MINUTE_MS, instantMs } from './time.js';
import type { CalendarItem, TimedPlacement, TimeRange } from './types.js';

interface Clipped {
  itemId: string;
  lane: string | null;
  start: number;
  end: number;
  overlapEnd: number;
  clippedStart: boolean;
  clippedEnd: boolean;
}

export function packIntervals(items: readonly CalendarItem[], dayRange: TimeRange): TimedPlacement[] {
  const rangeStart = instantMs(dayRange.start);
  const rangeEnd = instantMs(dayRange.end);
  const length = rangeEnd - rangeStart;
  if (!(length > 0)) throw new RangeError('packIntervals: dayRange must be a positive interval');

  const byLane = new Map<string | null, Clipped[]>();
  for (const item of items) {
    if (item.allDay) continue;
    const s = instantMs(item.start);
    const rawEnd = instantMs(item.end);
    const e = rawEnd < s ? s : rawEnd;
    const zero = e === s;
    if (zero ? s < rangeStart || s >= rangeEnd : e <= rangeStart || s >= rangeEnd) continue;
    const start = Math.max(s, rangeStart);
    const end = Math.min(e, rangeEnd);
    const clipped: Clipped = {
      itemId: item.id,
      lane: item.lane ?? null,
      start,
      end,
      overlapEnd: Math.max(end, start + MINUTE_MS),
      clippedStart: s < rangeStart,
      clippedEnd: e > rangeEnd,
    };
    const list = byLane.get(clipped.lane);
    if (list === undefined) byLane.set(clipped.lane, [clipped]);
    else list.push(clipped);
  }

  const out: TimedPlacement[] = [];
  for (const [lane, list] of byLane) {
    list.sort((a, b) => a.start - b.start || b.overlapEnd - a.overlapEnd || (a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0));
    let cluster: Array<{ c: Clipped; column: number }> = [];
    let columnEnds: number[] = [];
    let clusterEnd = -Infinity;
    const flush = (): void => {
      const columnCount = columnEnds.length;
      for (const { c, column } of cluster) {
        out.push({ itemId: c.itemId, lane, column, columnCount, top: (c.start - rangeStart) / length, height: (c.end - c.start) / length, clippedStart: c.clippedStart, clippedEnd: c.clippedEnd });
      }
      cluster = [];
      columnEnds = [];
    };
    for (const c of list) {
      if (c.start >= clusterEnd) flush();
      let column = columnEnds.findIndex((end) => end <= c.start);
      if (column === -1) {
        column = columnEnds.length;
        columnEnds.push(c.overlapEnd);
      } else columnEnds[column] = c.overlapEnd;
      cluster.push({ c, column });
      clusterEnd = Math.max(clusterEnd, c.overlapEnd);
    }
    flush();
  }
  out.sort((a, b) => a.top - b.top || a.column - b.column || (a.itemId < b.itemId ? -1 : 1));
  return out;
}
