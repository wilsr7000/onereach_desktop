// GPS for Life — ICS parser/expansion contract (lib/gps-for-life/ics.js).
// Fixture mirrors what Google Calendar "secret address" feeds actually
// emit: folded lines, TZID wall times, UTC times, weekly BYDAY rules
// with UNTIL + EXDATE, all-day VALUE=DATE events, CANCELLED status.
import { describe, it, expect } from 'vitest';
import { expandIcsFeed, parseIcs, _internals } from '../../lib/gps-for-life/ics.js';

const FEED = [
  'BEGIN:VCALENDAR',
  'X-WR-CALNAME:Family',
  'BEGIN:VEVENT',
  'UID:one@google.com',
  'SUMMARY:Dentist for the ',
  ' kids', // RFC 5545 folded continuation (CRLF + single space)
  'DTSTART;TZID=America/Denver:20260818T090000',
  'DTEND;TZID=America/Denver:20260818T100000',
  'LOCATION:Main St\\, Suite 4',
  'STATUS:CONFIRMED',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:two@google.com',
  'SUMMARY:Standup',
  'DTSTART:20260817T150000Z',
  'DTEND:20260817T151500Z',
  'RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR;UNTIL=20260901T000000Z',
  'EXDATE:20260821T150000Z',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:allday@google.com',
  'SUMMARY:Trip day',
  'DTSTART;VALUE=DATE:20260820',
  'DTEND;VALUE=DATE:20260821',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:cancelled@google.com',
  'SUMMARY:Ghost',
  'DTSTART:20260819T100000Z',
  'STATUS:CANCELLED',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

const RANGE_START = Date.UTC(2026, 7, 16);
const RANGE_END = Date.UTC(2026, 8, 1);

describe('gps-for-life ics', () => {
  it('unfolds lines and unescapes text values', () => {
    const { events, calendarName } = parseIcs(FEED);
    expect(calendarName).toBe('Family');
    const dentist = events.find((e) => e.uid === 'one@google.com');
    expect(dentist.title).toBe('Dentist for the kids');
    expect(dentist.location).toBe('Main St, Suite 4');
  });

  it('converts TZID wall time to UTC (Denver DST)', () => {
    const { occurrences } = expandIcsFeed(FEED, RANGE_START, RANGE_END);
    const dentist = occurrences.find((o) => o.uid === 'one@google.com');
    // 09:00 America/Denver in August = 15:00 UTC (MDT)
    expect(new Date(dentist.startMs).toISOString()).toBe('2026-08-18T15:00:00.000Z');
    expect(new Date(dentist.endMs).toISOString()).toBe('2026-08-18T16:00:00.000Z');
  });

  it('expands weekly BYDAY with UNTIL and honors EXDATE', () => {
    const { occurrences } = expandIcsFeed(FEED, RANGE_START, RANGE_END);
    const dates = occurrences
      .filter((o) => o.uid === 'two@google.com')
      .map((o) => new Date(o.startMs).toISOString().slice(0, 10));
    // Mon/Wed/Fri from Aug 17; Aug 21 excluded by EXDATE; UNTIL caps at Sep 1.
    expect(dates).toEqual([
      '2026-08-17', '2026-08-19', '2026-08-24', '2026-08-26', '2026-08-28', '2026-08-31',
    ]);
  });

  it('handles all-day events and skips CANCELLED', () => {
    const { occurrences } = expandIcsFeed(FEED, RANGE_START, RANGE_END);
    const allday = occurrences.find((o) => o.uid === 'allday@google.com');
    expect(allday.allDay).toBe(true);
    expect(occurrences.some((o) => o.uid === 'cancelled@google.com')).toBe(false);
  });

  it('drops malformed date values instead of throwing', () => {
    expect(_internals.parseIcsDate('garbage', {})).toBeNull();
    const { occurrences } = expandIcsFeed('BEGIN:VEVENT\r\nDTSTART:nope\r\nEND:VEVENT', 0, Date.now());
    expect(occurrences).toEqual([]);
  });

  it('caps runaway recurrences (COUNT/no-UNTIL rules stay bounded)', () => {
    const feed = [
      'BEGIN:VEVENT', 'UID:daily@x', 'SUMMARY:Forever',
      'DTSTART:20200101T000000Z', 'RRULE:FREQ=DAILY', 'END:VEVENT',
    ].join('\r\n');
    const { occurrences } = expandIcsFeed(feed, Date.UTC(2020, 0, 1), Date.UTC(2030, 0, 1));
    expect(occurrences.length).toBeLessThanOrEqual(1000);
  });
});
