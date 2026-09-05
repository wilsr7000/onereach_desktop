/**
 * Calendar module event types — per-module typed event surface (ADR-032).
 *
 * The Calendar shows the account's scheduled flows (ADR-090). Every
 * snapshot is a span (`calendar.snapshot.*`), opening the window and a
 * flow are events; token minting failures surface as CALENDAR_TOKEN_FAILED
 * errors on the snapshot span.
 */
import type { EventRecord } from '../logging/events.js';

export const CALENDAR_EVENTS = {
  SNAPSHOT_START: 'calendar.snapshot.start',
  SNAPSHOT_FINISH: 'calendar.snapshot.finish',
  SNAPSHOT_FAIL: 'calendar.snapshot.fail',
  OPEN_WINDOW: 'calendar.open-window',
  OPEN_FLOW: 'calendar.open-flow',
  SPACE_EVENTS_START: 'calendar.space-events.start',
  SPACE_EVENTS_FINISH: 'calendar.space-events.finish',
  SPACE_EVENTS_FAIL: 'calendar.space-events.fail',
  FLOW_LOGS_START: 'calendar.flow-logs.start',
  FLOW_LOGS_FINISH: 'calendar.flow-logs.finish',
  FLOW_LOGS_FAIL: 'calendar.flow-logs.fail',
} as const;

export type CalendarEventName = (typeof CALENDAR_EVENTS)[keyof typeof CALENDAR_EVENTS];

const CALENDAR_EVENT_NAMES: ReadonlySet<string> = new Set(Object.values(CALENDAR_EVENTS));

export interface CalendarEvent extends EventRecord {
  name: CalendarEventName;
  category: 'calendar';
}

export function isCalendarEvent(record: EventRecord): record is CalendarEvent {
  return CALENDAR_EVENT_NAMES.has(record.name);
}
