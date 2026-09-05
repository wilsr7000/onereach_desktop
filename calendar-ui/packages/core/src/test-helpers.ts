import { CalendarDate, CalendarDateTime, toZoned, type ZonedDateTime } from '@internationalized/date';
import type { CalendarItem } from './types.js';

export const NY = 'America/New_York';
export const UTC = 'UTC';

export function zdt(iso: string, timeZone: string): ZonedDateTime {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(iso);
  if (m === null) throw new Error(`bad iso ${iso}`);
  const n = (v: string | undefined): number => (v === undefined ? 0 : Number.parseInt(v, 10));
  return toZoned(new CalendarDateTime(n(m[1]), n(m[2]), n(m[3]), n(m[4]), n(m[5]), n(m[6]), 0), timeZone, 'compatible');
}

export const cd = (iso: string): CalendarDate => {
  const [y, m, d] = iso.split('-').map((v) => Number.parseInt(v, 10)) as [number, number, number];
  return new CalendarDate(y, m, d);
};

export function item(id: string, start: string, end: string, timeZone: string, extra: Partial<CalendarItem> = {}): CalendarItem {
  return { id, start: zdt(start, timeZone), end: zdt(end, timeZone), allDay: false, type: 'text', payload: { title: id }, ...extra };
}
