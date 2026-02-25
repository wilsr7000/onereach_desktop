import { describe, it, expect } from 'vitest';
import {
  extractMeetingLink,
  identifyProvider,
  calcImportance,
  formatEventTime,
  formatEventTimeRange,
  buildEventsUISpec,
  buildDayUISpec,
  buildShortSpokenSummary,
  spokenDaySummary,
  confirmCreate,
  confirmDelete,
  confirmEdit,
} from '../../lib/calendar-format.js';
import { analyzeDay } from '../../lib/calendar-data.js';

// ─── Meeting Link Extraction ────────────────────────────────────────────────

describe('extractMeetingLink', () => {
  it('returns null for null event', () => {
    const result = extractMeetingLink(null);
    expect(result.url).toBeNull();
  });

  it('extracts hangoutLink (Google Meet)', () => {
    const event = { hangoutLink: 'https://meet.google.com/abc-defg-hij' };
    const result = extractMeetingLink(event);
    expect(result.url).toBe('https://meet.google.com/abc-defg-hij');
    expect(result.provider).toBe('Google Meet');
    expect(result.label).toBe('Join Google Meet');
  });

  it('extracts Zoom from conferenceData', () => {
    const event = {
      conferenceData: {
        entryPoints: [{ entryPointType: 'video', uri: 'https://zoom.us/j/12345' }],
      },
    };
    const result = extractMeetingLink(event);
    expect(result.url).toBe('https://zoom.us/j/12345');
    expect(result.provider).toBe('Zoom');
  });

  it('extracts meeting link from location field', () => {
    const event = { location: 'https://teams.microsoft.com/l/meetup-join/xyz' };
    const result = extractMeetingLink(event);
    expect(result.url).toBe('https://teams.microsoft.com/l/meetup-join/xyz');
    expect(result.provider).toBe('Microsoft Teams');
  });

  it('extracts meeting link from description field', () => {
    const event = { description: 'Join the call at https://zoom.us/j/99999 for the review.' };
    const result = extractMeetingLink(event);
    expect(result.url).toBe('https://zoom.us/j/99999');
    expect(result.provider).toBe('Zoom');
  });

  it('prioritizes hangoutLink over conferenceData', () => {
    const event = {
      hangoutLink: 'https://meet.google.com/aaa',
      conferenceData: {
        entryPoints: [{ entryPointType: 'video', uri: 'https://zoom.us/j/bbb' }],
      },
    };
    const result = extractMeetingLink(event);
    expect(result.url).toBe('https://meet.google.com/aaa');
  });

  it('returns null when no meeting link found', () => {
    const event = { summary: 'Lunch', location: '123 Main St', description: 'Team lunch' };
    const result = extractMeetingLink(event);
    expect(result.url).toBeNull();
  });
});

describe('identifyProvider', () => {
  it('identifies Zoom', () => expect(identifyProvider('https://zoom.us/j/123')).toBe('Zoom'));
  it('identifies Google Meet', () => expect(identifyProvider('https://meet.google.com/abc')).toBe('Google Meet'));
  it('identifies Teams', () =>
    expect(identifyProvider('https://teams.microsoft.com/l/meetup')).toBe('Microsoft Teams'));
  it('identifies Webex', () => expect(identifyProvider('https://example.webex.com/meet')).toBe('Webex'));
  it('returns "Video Call" for unknown', () => expect(identifyProvider('https://example.com/call')).toBe('Video Call'));
  it('returns "Video Call" for null', () => expect(identifyProvider(null)).toBe('Video Call'));
});

// ─── Importance Scoring ─────────────────────────────────────────────────────

describe('calcImportance', () => {
  it('gives base score of 1 for minimal event', () => {
    const event = { start: { dateTime: '2026-02-16T10:00:00' }, end: { dateTime: '2026-02-16T10:30:00' } };
    expect(calcImportance(event)).toBe(1);
  });

  it('adds score for many attendees', () => {
    const event = {
      start: { dateTime: '2026-02-16T10:00:00' },
      end: { dateTime: '2026-02-16T10:30:00' },
      attendees: [{}, {}, {}, {}, {}, {}],
    };
    expect(calcImportance(event)).toBeGreaterThanOrEqual(3);
  });

  it('adds score for long duration', () => {
    const event = {
      start: { dateTime: '2026-02-16T10:00:00' },
      end: { dateTime: '2026-02-16T11:30:00' },
    };
    expect(calcImportance(event)).toBe(2);
  });

  it('caps at 5', () => {
    const event = {
      start: { dateTime: '2026-02-16T10:00:00' },
      end: { dateTime: '2026-02-16T12:00:00' },
      attendees: [{}, {}, {}, {}, {}, {}, {}, {}],
      description: 'Very important detailed meeting with agenda and notes',
      recurringEventId: 'abc',
    };
    expect(calcImportance(event)).toBe(5);
  });
});

// ─── Time Formatting ────────────────────────────────────────────────────────

describe('formatEventTime', () => {
  it('formats dateTime events', () => {
    const event = { start: { dateTime: '2026-02-16T14:30:00' } };
    const result = formatEventTime(event);
    expect(result).toMatch(/2:30\s*PM/i);
  });

  it('returns "All Day" for date-only events', () => {
    const event = { start: { date: '2026-02-16' } };
    expect(formatEventTime(event)).toBe('All Day');
  });

  it('returns "TBD" for events with no start', () => {
    expect(formatEventTime({})).toBe('TBD');
  });
});

describe('formatEventTimeRange', () => {
  it('formats start and end time', () => {
    const event = {
      start: { dateTime: '2026-02-16T14:00:00' },
      end: { dateTime: '2026-02-16T15:00:00' },
    };
    const result = formatEventTimeRange(event);
    expect(result).toMatch(/2:00\s*PM/i);
    expect(result).toMatch(/3:00\s*PM/i);
    expect(result).toContain('-');
  });
});

// ─── HUD UI Specs ───────────────────────────────────────────────────────────

describe('buildEventsUISpec', () => {
  it('builds eventList spec from raw events', () => {
    const events = [
      { summary: 'Standup', start: { dateTime: '2026-02-16T09:00:00' }, end: { dateTime: '2026-02-16T09:30:00' } },
      { summary: 'Lunch', start: { dateTime: '2026-02-16T12:00:00' }, end: { dateTime: '2026-02-16T13:00:00' } },
    ];
    const spec = buildEventsUISpec(events, 'Today');
    expect(spec.type).toBe('eventList');
    expect(spec.title).toBe('Today');
    expect(spec.events).toHaveLength(2);
    expect(spec.events[0].title).toBe('Standup');
    expect(spec.events[1].title).toBe('Lunch');
  });

  it('handles empty events array', () => {
    const spec = buildEventsUISpec([], 'Today');
    expect(spec.events).toHaveLength(0);
  });
});

describe('buildDayUISpec', () => {
  it('builds from DayAnalysis object (current is single object)', () => {
    // analyzeDay() returns current as a single enriched event or null, NOT an array
    const dayAnalysis = {
      label: 'Today',
      current: {
        event: {
          summary: 'Now Meeting',
          start: { dateTime: '2026-02-16T10:00:00' },
          end: { dateTime: '2026-02-16T11:00:00' },
        },
        status: 'current',
      },
      remaining: [
        {
          event: {
            summary: 'Later',
            start: { dateTime: '2026-02-16T14:00:00' },
            end: { dateTime: '2026-02-16T15:00:00' },
          },
          status: 'upcoming',
        },
      ],
      past: [],
      conflicts: [],
      summary: { total: 2, past: 0, current: 1, upcoming: 1 },
    };
    const spec = buildDayUISpec(dayAnalysis);
    expect(spec.type).toBe('eventList');
    expect(spec.events).toHaveLength(2);
    expect(spec.events[0].title).toBe('Now Meeting');
    expect(spec.events[0].status).toBe('current');
  });

  it('builds when current is null (no meeting in progress)', () => {
    const dayAnalysis = {
      label: 'Today',
      current: null,
      remaining: [
        {
          event: {
            summary: 'Afternoon Meeting',
            start: { dateTime: '2026-02-16T14:00:00' },
            end: { dateTime: '2026-02-16T15:00:00' },
          },
          status: 'upcoming',
        },
      ],
      past: [],
      conflicts: [],
      summary: { total: 1, past: 0, current: 0, upcoming: 1 },
    };
    const spec = buildDayUISpec(dayAnalysis);
    expect(spec.events).toHaveLength(1);
    expect(spec.events[0].title).toBe('Afternoon Meeting');
  });

  it('handles null dayAnalysis', () => {
    const spec = buildDayUISpec(null, 'Today');
    expect(spec.events).toHaveLength(0);
  });
});

// ─── Spoken Summaries ───────────────────────────────────────────────────────

describe('buildShortSpokenSummary', () => {
  it('says calendar is clear for 0 events', () => {
    const result = buildShortSpokenSummary([], 'Today');
    expect(result).toContain('clear');
  });

  it('names the event for 1 event', () => {
    const events = [{ summary: 'Standup', start: { dateTime: '2026-02-16T09:00:00' } }];
    const result = buildShortSpokenSummary(events, 'Today');
    expect(result).toContain('one meeting');
    expect(result).toContain('Standup');
  });

  it('lists names for 2-3 events', () => {
    const events = [
      { summary: 'A', start: { dateTime: '2026-02-16T09:00:00' } },
      { summary: 'B', start: { dateTime: '2026-02-16T10:00:00' } },
    ];
    const result = buildShortSpokenSummary(events, 'Today');
    expect(result).toContain('2 meetings');
    expect(result).toContain('"A"');
    expect(result).toContain('"B"');
  });

  it('gives count and first for 4+ events', () => {
    const events = Array.from({ length: 5 }, (_, i) => ({
      summary: `Meeting ${i}`,
      start: { dateTime: `2026-02-16T${9 + i}:00:00` },
    }));
    const result = buildShortSpokenSummary(events, 'Today');
    expect(result).toContain('5 meetings');
    expect(result).toContain('Meeting 0');
  });
});

describe('spokenDaySummary', () => {
  it('handles null analysis', () => {
    const result = spokenDaySummary(null, 'Today');
    expect(result).toContain("couldn't load");
  });

  it('handles empty day', () => {
    // current is null when no meeting in progress (matches analyzeDay contract)
    const day = { summary: { total: 0 }, current: null, remaining: [], past: [], next: null, conflicts: [] };
    const result = spokenDaySummary(day, 'Today');
    expect(result).toContain('clear');
  });

  it('mentions current meeting (single object)', () => {
    // analyzeDay returns current as single enriched event, not array
    const day = {
      summary: { total: 1 },
      current: { event: { summary: 'Design Review' }, status: 'current' },
      remaining: [],
      past: [],
      next: null,
      conflicts: [],
    };
    const result = spokenDaySummary(day);
    expect(result).toContain('Design Review');
    expect(result).toContain('currently in');
  });

  it('handles null current gracefully', () => {
    const day = {
      summary: { total: 2 },
      current: null,
      remaining: [{ event: { summary: 'Later' } }],
      past: [{ event: { summary: 'Earlier' } }],
      next: { event: { summary: 'Later', start: { dateTime: '2026-02-16T14:00:00' } }, startsInMs: 1800000 },
      conflicts: [],
    };
    const result = spokenDaySummary(day);
    expect(result).not.toContain('currently in');
    expect(result).toContain('Later');
  });

  it('mentions conflicts', () => {
    const day = {
      summary: { total: 3 },
      current: null,
      remaining: [{ event: { summary: 'A' } }, { event: { summary: 'B' } }],
      past: [],
      next: { event: { summary: 'A', start: { dateTime: '2026-02-16T14:00:00' } }, startsInMs: 3600000 },
      conflicts: [[{}, {}]],
    };
    const result = spokenDaySummary(day);
    expect(result).toContain('conflict');
  });
});

// ─── Mutation Confirmations ─────────────────────────────────────────────────

describe('confirmCreate', () => {
  it('builds confirmation message', () => {
    const msg = confirmCreate({ title: 'Standup', date: '2026-02-17', time: '09:00', duration: '30m' }, true);
    expect(msg).toContain('Standup');
    expect(msg).toContain('30m');
    expect(msg).not.toContain('pending');
  });

  it('warns if not verified', () => {
    const msg = confirmCreate({ title: 'Standup', date: '2026-02-17', time: '09:00' }, false);
    expect(msg).toContain('pending');
  });

  it('mentions guests', () => {
    const msg = confirmCreate(
      { title: 'Sync', date: '2026-02-17', time: '10:00', guests: ['a@b.com', 'c@d.com'] },
      true
    );
    expect(msg).toContain('2 guests');
  });
});

describe('confirmDelete', () => {
  it('builds deletion confirmation', () => {
    const msg = confirmDelete('Team Sync', true);
    expect(msg).toContain('removed');
    expect(msg).toContain('Team Sync');
  });

  it('warns if not verified', () => {
    const msg = confirmDelete('Team Sync', false);
    expect(msg).toContain('moment');
  });
});

describe('confirmEdit', () => {
  it('builds edit confirmation with changes', () => {
    const msg = confirmEdit('Old Name', { title: 'New Name', time: '15:00' }, true);
    expect(msg).toContain('updated');
    expect(msg).toContain('Old Name');
    expect(msg).toContain('renamed');
    expect(msg).toContain('3:00');
  });

  it('warns if not verified', () => {
    const msg = confirmEdit('Meeting', { time: '14:00' }, false);
    expect(msg).toContain('pending');
  });
});

// ─── Integration: analyzeDay → formatters ───────────────────────────────────
// These ensure real analyzeDay() output flows through formatters without error.

describe('analyzeDay → format integration', () => {
  const makeEvent = (summary, startHour, endHour, date = '2026-02-16') => ({
    id: summary.toLowerCase().replace(/\s/g, '-'),
    summary,
    start: { dateTime: `${date}T${String(startHour).padStart(2, '0')}:00:00` },
    end: { dateTime: `${date}T${String(endHour).padStart(2, '0')}:00:00` },
  });

  const FEB_16 = new Date('2026-02-16T00:00:00');

  it('buildDayUISpec works with real analyzeDay output (no current meeting)', () => {
    const now = new Date('2026-02-16T08:00:00');
    const events = [makeEvent('Standup', 9, 10), makeEvent('Lunch', 12, 13)];
    const day = analyzeDay(events, FEB_16, now);
    const spec = buildDayUISpec(day);
    expect(spec.type).toBe('eventList');
    expect(spec.events).toHaveLength(2);
    expect(spec.events[0].title).toBe('Standup');
  });

  it('buildDayUISpec works with real analyzeDay output (meeting in progress)', () => {
    const now = new Date('2026-02-16T09:30:00');
    const events = [makeEvent('Standup', 9, 10), makeEvent('Lunch', 12, 13)];
    const day = analyzeDay(events, FEB_16, now);
    expect(day.current).not.toBeNull();
    const spec = buildDayUISpec(day);
    expect(spec.events).toHaveLength(2);
    expect(spec.events[0].title).toBe('Standup');
    expect(spec.events[0].status).toBe('current');
  });

  it('spokenDaySummary works with real analyzeDay output (empty day)', () => {
    const now = new Date('2026-02-16T08:00:00');
    const day = analyzeDay([], FEB_16, now);
    const spoken = spokenDaySummary(day);
    expect(spoken).toContain('clear');
  });

  it('spokenDaySummary works with real analyzeDay output (meeting in progress)', () => {
    const now = new Date('2026-02-16T09:30:00');
    const events = [makeEvent('Standup', 9, 10), makeEvent('Lunch', 12, 13)];
    const day = analyzeDay(events, FEB_16, now);
    const spoken = spokenDaySummary(day);
    expect(spoken).toContain('currently in');
    expect(spoken).toContain('Standup');
  });

  it('spokenDaySummary works with real analyzeDay output (all past)', () => {
    const now = new Date('2026-02-16T18:00:00');
    const events = [makeEvent('Standup', 9, 10), makeEvent('Lunch', 12, 13)];
    const day = analyzeDay(events, FEB_16, now);
    const spoken = spokenDaySummary(day);
    expect(typeof spoken).toBe('string');
    expect(spoken.length).toBeGreaterThan(0);
  });
});
