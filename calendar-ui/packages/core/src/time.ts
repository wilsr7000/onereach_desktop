/**
 * Date math on top of @internationalized/date. Every function takes the
 * time zone explicitly; nothing here reads the system zone. `instantMs`
 * is the one place an instant becomes a number, so fractions of a day
 * are computed in absolute time (DST days are 23 or 25 hours long, and
 * the layout says so).
 */
import { CalendarDate, CalendarDateTime, getDayOfWeek, toCalendarDate, toTimeZone, toZoned, type ZonedDateTime } from '@internationalized/date';
import type { TimeRange, WeekStartsOn } from './types.js';

export const MINUTE_MS = 60_000;
export const DAY_MS = 86_400_000;

/** Epoch milliseconds of an instant. */
export function instantMs(z: ZonedDateTime): number {
  return z.toDate().getTime();
}

/** Midnight of a calendar day in a zone (on a day whose midnight does not exist, the first valid wall time). */
export function startOfZonedDay(date: CalendarDate, timeZone: string): ZonedDateTime {
  return toZoned(new CalendarDateTime(date.year, date.month, date.day, 0, 0, 0, 0), timeZone, 'compatible');
}

/** The absolute range a day column spans: zoned midnight to the next zoned midnight. */
export function dayRangeOf(date: CalendarDate, timeZone: string): TimeRange {
  return { start: startOfZonedDay(date, timeZone), end: startOfZonedDay(date.add({ days: 1 }), timeZone) };
}

/** The calendar day an instant falls on in a zone. */
export function localDate(z: ZonedDateTime, timeZone: string): CalendarDate {
  return toCalendarDate(toTimeZone(z, timeZone));
}

export function isLocalMidnight(z: ZonedDateTime, timeZone: string): boolean {
  const l = toTimeZone(z, timeZone);
  return l.hour === 0 && l.minute === 0 && l.second === 0 && l.millisecond === 0;
}

/** 0 = Sunday … 6 = Saturday, independent of locale. */
export function dayOfWeekSunday0(date: CalendarDate): number {
  return getDayOfWeek(date, 'en-US');
}

/** The first day of the week containing `date`. */
export function alignToWeekStart(date: CalendarDate, weekStartsOn: WeekStartsOn): CalendarDate {
  const back = (dayOfWeekSunday0(date) - weekStartsOn + 7) % 7;
  return back === 0 ? date : date.subtract({ days: back });
}

/** Whole days from `a` to `b` (negative when b is earlier). Computed at UTC midnight, where days are always 24 h. */
export function daysBetween(a: CalendarDate, b: CalendarDate): number {
  return Math.round((instantMs(startOfZonedDay(b, 'UTC')) - instantMs(startOfZonedDay(a, 'UTC'))) / DAY_MS);
}

export function enumerateDays(start: CalendarDate, count: number): CalendarDate[] {
  const out: CalendarDate[] = [];
  for (let i = 0; i < count; i += 1) out.push(start.add({ days: i }));
  return out;
}

export function chunkWeeks(days: readonly CalendarDate[], size = 7): CalendarDate[][] {
  const out: CalendarDate[][] = [];
  for (let i = 0; i < days.length; i += size) out.push(days.slice(i, i + size));
  return out;
}

export function sameDate(a: CalendarDate, b: CalendarDate): boolean {
  return a.year === b.year && a.month === b.month && a.day === b.day;
}

export function compareDates(a: CalendarDate, b: CalendarDate): number {
  return a.year !== b.year ? a.year - b.year : a.month !== b.month ? a.month - b.month : a.day - b.day;
}

export function maxDate(a: CalendarDate, b: CalendarDate): CalendarDate {
  return compareDates(a, b) >= 0 ? a : b;
}
export function minDate(a: CalendarDate, b: CalendarDate): CalendarDate {
  return compareDates(a, b) <= 0 ? a : b;
}

/** Snap an instant to a slot size, in the zone's wall clock. */
export function snapToSlot(z: ZonedDateTime, slotMinutes: number): ZonedDateTime {
  const total = z.hour * 60 + z.minute + z.second / 60;
  const snapped = Math.round(total / slotMinutes) * slotMinutes;
  const hour = Math.min(23, Math.floor(snapped / 60));
  const minute = snapped >= 24 * 60 ? 59 : snapped % 60;
  return z.set({ hour, minute, second: 0, millisecond: 0 });
}
