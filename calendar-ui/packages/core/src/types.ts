import type { CalendarDate, ZonedDateTime } from '@internationalized/date';

export type ItemId = string;

/** An immutable calendar item. Mutations produce new objects. */
export interface CalendarItem<TPayload = unknown> {
  id: ItemId;
  start: ZonedDateTime;
  end: ZonedDateTime;
  allDay: boolean;
  /** Registry key: the grid never branches on it. */
  type: string;
  payload: TPayload;
  /** Optional grouping (e.g. per-person columns). Items in different lanes never share a column cluster. */
  lane?: string;
  meta?: Record<string, unknown>;
}

export type View = 'month' | 'week' | 'day';
export type WeekStartsOn = 0 | 1 | 6;

/** Absolute interval; both ends are instants (zoned). */
export interface TimeRange {
  start: ZonedDateTime;
  end: ZonedDateTime;
}

/** A contiguous run of days as the views render them (a week, or one day). */
export interface DayRun {
  days: CalendarDate[];
  timeZone: string;
}

/** The exact dates a view renders. `end` is exclusive. */
export interface VisibleRange {
  view: View;
  timeZone: string;
  anchor: CalendarDate;
  start: CalendarDate;
  end: CalendarDate;
  days: CalendarDate[];
  /** `days` in rows of seven (month) or one row (week / day). */
  weeks: CalendarDate[][];
}

/** A timed item's place inside one day column, in fractions of the day range (never pixels). */
export interface TimedPlacement {
  itemId: ItemId;
  lane: string | null;
  column: number;
  columnCount: number;
  /** 0..1 from the top of the day range. */
  top: number;
  /** 0..1 of the day range; 0 for a zero-duration item. */
  height: number;
  /** The item started before the day range (it continues from an earlier day). */
  clippedStart: boolean;
  /** The item ends after the day range. */
  clippedEnd: boolean;
}

/** A bar in the all-day row or a month week: which columns it spans and which row it sits in. */
export interface AllDaySegment {
  itemId: ItemId;
  row: number;
  /** First column (0-based, inclusive). */
  startCol: number;
  /** Last column (inclusive). */
  endCol: number;
  continuesBefore: boolean;
  continuesAfter: boolean;
}

export interface CellOverflow {
  visible: AllDaySegment[];
  hidden: AllDaySegment[];
  /** How many items the "+N more" affordance stands for. */
  overflow: number;
}
