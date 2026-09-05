import { endOfMonth, startOfMonth, type CalendarDate } from '@internationalized/date';
import { alignToWeekStart, chunkWeeks, daysBetween, enumerateDays } from './time.js';
import type { View, VisibleRange, WeekStartsOn } from './types.js';

export interface VisibleRangeOptions {
  /** Month view always shows six rows (42 days) so the grid height never changes. */
  fixedWeeks?: boolean;
}

/**
 * The exact dates a view renders. Month: from the first day of the
 * month aligned back to `weekStartsOn`, through the last day aligned
 * forward to the end of its week (leading and trailing days included),
 * five or six rows as needed. Week: seven days from the aligned start.
 * Day: the anchor. `end` is exclusive.
 */
export function visibleRange(view: View, anchorDate: CalendarDate, weekStartsOn: WeekStartsOn, timeZone: string, options: VisibleRangeOptions = {}): VisibleRange {
  let start: CalendarDate;
  let count: number;
  if (view === 'month') {
    start = alignToWeekStart(startOfMonth(anchorDate), weekStartsOn);
    const lastWeekStart = alignToWeekStart(endOfMonth(anchorDate), weekStartsOn);
    count = daysBetween(start, lastWeekStart) + 7;
    if (options.fixedWeeks === true) count = 42;
  } else if (view === 'week') {
    start = alignToWeekStart(anchorDate, weekStartsOn);
    count = 7;
  } else {
    start = anchorDate;
    count = 1;
  }
  const days = enumerateDays(start, count);
  return { view, timeZone, anchor: anchorDate, start, end: start.add({ days: count }), days, weeks: chunkWeeks(days, view === 'day' ? 1 : 7) };
}
