import { dayRangeOf, layoutAllDay, packIntervals, visibleRange, weekOverflow, type AllDaySegment, type CalendarItem, type CellOverflow, type TimedPlacement, type View, type VisibleRange, type WeekStartsOn } from '@calendar/core';
import type { CalendarDate } from '@internationalized/date';
import { useMemo } from 'react';

export interface DayLayout {
  date: CalendarDate;
  placements: TimedPlacement[];
}
export interface WeekLayout {
  days: CalendarDate[];
  segments: AllDaySegment[];
  overflow: CellOverflow[];
}
export interface CalendarLayout {
  range: VisibleRange;
  /** Timed items per day (week and day views). */
  days: DayLayout[];
  /** All-day bars per week row (month view: every item; week view: all-day items). */
  weeks: WeekLayout[];
  itemsById: Map<string, CalendarItem>;
}

export interface LayoutInputs {
  items: readonly CalendarItem[];
  view: View;
  anchorDate: CalendarDate;
  timeZone: string;
  weekStartsOn: WeekStartsOn;
  hourRange: readonly [number, number];
  maxVisiblePerCell: number;
}

/** Pure computation, exported for tests and for non-React consumers. */
export function computeLayout(input: LayoutInputs): CalendarLayout {
  const range = visibleRange(input.view, input.anchorDate, input.weekStartsOn, input.timeZone);
  const itemsById = new Map(input.items.map((i) => [i.id, i] as const));
  const days: DayLayout[] = input.view === 'month' ? [] : range.days.map((date) => ({ date, placements: packIntervals(input.items, dayRangeOf(date, input.timeZone)) }));
  const barItems = input.view === 'month' ? input.items : input.items.filter((i) => i.allDay);
  const weeks: WeekLayout[] = range.weeks.map((weekDays) => {
    const segments = layoutAllDay(barItems, { days: weekDays, timeZone: input.timeZone });
    return { days: weekDays, segments, overflow: weekOverflow(segments, input.maxVisiblePerCell, weekDays.length) };
  });
  return { range, days, weeks, itemsById };
}

/** Memoised per visible range: recomputes only when items, view, anchor, zone, week start, hour range or the cell cap change. */
export function useLayout(input: LayoutInputs): CalendarLayout {
  const [h0, h1] = input.hourRange;
  return useMemo(
    () => computeLayout({ ...input, hourRange: [h0, h1] }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [input.items, input.view, input.anchorDate, input.timeZone, input.weekStartsOn, h0, h1, input.maxVisiblePerCell]
  );
}
