/**
 * Segment packing for the all-day row and month weeks.
 *
 * Each item covering any day of the run becomes one segment spanning
 * `[startCol, endCol]` (clipped, with continuation flags). The last day
 * an item covers follows the end-exclusive rule: an item ending exactly
 * at local midnight does not cover that day. Segments are sorted by
 * start column, then longer first, then id, and take the first row in
 * which no placed segment shares a column — so a bar keeps one row
 * across the days of the run. A multi-week item is laid out per week;
 * its row may differ between weeks.
 */
import { compareDates, daysBetween, isLocalMidnight, localDate } from './time.js';
import type { AllDaySegment, CalendarItem, DayRun } from './types.js';

interface Span {
  itemId: string;
  startCol: number;
  endCol: number;
  continuesBefore: boolean;
  continuesAfter: boolean;
}

/** First and last (inclusive) local days an item covers, or null for a broken interval. */
export function coveredDays(item: CalendarItem, timeZone: string): { first: import('@internationalized/date').CalendarDate; last: import('@internationalized/date').CalendarDate } {
  const first = localDate(item.start, timeZone);
  const endsAfterStart = item.end.compare(item.start) > 0;
  let last = endsAfterStart ? localDate(item.end, timeZone) : first;
  if (endsAfterStart && isLocalMidnight(item.end, timeZone)) last = last.subtract({ days: 1 });
  if (compareDates(last, first) < 0) last = first;
  return { first, last };
}

export function layoutAllDay(items: readonly CalendarItem[], run: DayRun): AllDaySegment[] {
  const days = run.days;
  const firstDay = days[0];
  const lastDay = days[days.length - 1];
  if (firstDay === undefined || lastDay === undefined) return [];
  const spans: Span[] = [];
  for (const item of items) {
    const { first, last } = coveredDays(item, run.timeZone);
    if (compareDates(last, firstDay) < 0 || compareDates(first, lastDay) > 0) continue;
    const startCol = Math.max(0, daysBetween(firstDay, first));
    const endCol = Math.min(days.length - 1, daysBetween(firstDay, last));
    spans.push({ itemId: item.id, startCol, endCol, continuesBefore: compareDates(first, firstDay) < 0, continuesAfter: compareDates(last, lastDay) > 0 });
  }
  spans.sort((a, b) => a.startCol - b.startCol || b.endCol - b.startCol - (a.endCol - a.startCol) || (a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0));
  const rows: Array<Array<[number, number]>> = [];
  const out: AllDaySegment[] = [];
  for (const s of spans) {
    let row = rows.findIndex((placed) => placed.every(([a, b]) => s.endCol < a || s.startCol > b));
    if (row === -1) {
      row = rows.length;
      rows.push([]);
    }
    rows[row]?.push([s.startCol, s.endCol]);
    out.push({ itemId: s.itemId, row, startCol: s.startCol, endCol: s.endCol, continuesBefore: s.continuesBefore, continuesAfter: s.continuesAfter });
  }
  return out;
}

/** The segments that cover a column, in row order. */
export function segmentsInColumn(segments: readonly AllDaySegment[], col: number): AllDaySegment[] {
  return segments.filter((s) => s.startCol <= col && col <= s.endCol).sort((a, b) => a.row - b.row);
}
