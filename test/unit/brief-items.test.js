/**
 * lib/brief-items -- ONE vocabulary for conflict vs back-to-back, and ONE
 * compression of each event for screen + voice.
 *
 * Regression for 2026-09-15: the brief said "3 back-to-back. 3 conflicts."
 * with no names -- overlapping pairs were counted in BOTH tallies because
 * negative gaps passed the "gap < 15 min" back-to-back test.
 */
import { describe, it, expect } from 'vitest';

const {
  deriveScheduleFlags,
  compressTimeline,
  compressTimelineItem,
  buildCalendarBriefText,
  classifyBriefTimeline,
  describeLocation,
  describePeople,
  spokenSpan,
  compactSpan,
  parseClock,
} = require('../../lib/brief-items');

// Today's real shape (2026-09-15, with the two stale local "standup" rows):
const DAY = '2026-09-15';
const iso = (hhmm) => `${DAY}T${hhmm}:00-07:00`;
const ev = (title, start, end, extra = {}) => ({
  title,
  startTime: iso(start),
  endTime: iso(end),
  allDay: false,
  ...extra,
});

describe('deriveScheduleFlags -- conflict (overlap) vs back-to-back (no break)', () => {
  it('THE REGRESSION: overlapping pairs are conflicts and NEVER back-to-back', () => {
    const events = [
      ev('standup', '09:00', '09:15'),
      ev('daily standup', '09:00', '09:15'),
      ev('Think Tank - Pod leaders meeting', '09:00', '10:00'),
      ev('Library sync-up', '10:00', '10:50'),
      ev('Account Strategy Meetings', '12:00', '13:00'),
      ev("Don’t book", '15:00', '17:30'),
    ];
    const flags = deriveScheduleFlags(events, { minGapMinutes: 15 });

    // 3 overlaps among standup / daily standup / Think Tank
    expect(flags.conflicts).toHaveLength(3);
    const pairs = flags.conflicts.map((c) => `${c.first.title}|${c.second.title}`).sort();
    expect(pairs).toEqual([
      'daily standup|Think Tank - Pod leaders meeting',
      'standup|Think Tank - Pod leaders meeting',
      'standup|daily standup',
    ]);
    expect(flags.conflicts.find((c) => c.first.title === 'standup' && c.second.title === 'daily standup').overlapMinutes).toBe(15);

    // ONE true back-to-back: Think Tank ends 10:00, Library starts 10:00.
    expect(flags.backToBack).toHaveLength(1);
    expect(flags.backToBack[0].first.title).toBe('Think Tank - Pod leaders meeting');
    expect(flags.backToBack[0].second.title).toBe('Library sync-up');
    expect(flags.backToBack[0].gapMinutes).toBe(0);
  });

  it('a gap under the threshold is back-to-back; at or over it is not', () => {
    const tight = deriveScheduleFlags([ev('A', '09:00', '10:00'), ev('B', '10:10', '11:00')], { minGapMinutes: 15 });
    expect(tight.backToBack).toHaveLength(1);
    expect(tight.backToBack[0].gapMinutes).toBe(10);
    const loose = deriveScheduleFlags([ev('A', '09:00', '10:00'), ev('B', '10:15', '11:00')], { minGapMinutes: 15 });
    expect(loose.backToBack).toHaveLength(0);
    expect(loose.conflicts).toHaveLength(0);
  });

  it('finds the back-to-back across an intervening overlap (not just consecutive rows)', () => {
    // A 9-10, B 9-9:15 (overlaps A), C 10-10:30 -> A->C is back-to-back.
    const flags = deriveScheduleFlags([ev('A', '09:00', '10:00'), ev('B', '09:00', '09:15'), ev('C', '10:00', '10:30')]);
    expect(flags.backToBack.map((p) => `${p.first.title}>${p.second.title}`)).toEqual(['A>C']);
    expect(flags.conflicts).toHaveLength(1);
  });

  it('blocks, declined invites and all-day rows are neither conflicts nor back-to-back', () => {
    const flags = deriveScheduleFlags([
      ev("Don’t book", '09:00', '10:30'),
      ev('Focus time', '10:30', '11:00'),
      ev('Real meeting', '10:00', '11:00'),
      ev('Declined thing', '10:00', '11:00', { selfDeclined: true }),
      ev('Company holiday', '00:00', '23:59', { allDay: true }),
      ev('Next real', '11:00', '11:30'),
    ]);
    expect(flags.conflicts).toHaveLength(0);
    expect(flags.backToBack.map((p) => `${p.first.title}>${p.second.title}`)).toEqual(['Real meeting>Next real']);
  });

  it('with `now`, pairs that are entirely in the past are dropped', () => {
    const now = new Date(iso('12:00'));
    const flags = deriveScheduleFlags(
      [ev('Past A', '09:00', '10:00'), ev('Past B', '09:30', '10:30'), ev('Future A', '14:00', '15:00'), ev('Future B', '14:30', '15:30'), ev('Future C', '15:30', '16:00')],
      { now }
    );
    expect(flags.conflicts.map((c) => c.first.title)).toEqual(['Future A']);
    expect(flags.backToBack.map((p) => `${p.first.title}>${p.second.title}`)).toEqual(['Future B>Future C']);
  });

  it('accepts brief timeline entries that only carry clock strings', () => {
    const flags = deriveScheduleFlags(
      [
        { title: 'A', start: '9:00 AM', end: '10:00 AM', status: 'upcoming' },
        { title: 'B', start: '10:00 AM', end: '10:30 AM', status: 'upcoming' },
      ],
      { baseDate: new Date(2026, 8, 15) }
    );
    expect(flags.backToBack).toHaveLength(1);
  });
});

describe('compressTimelineItem -- one useful item, same on screen and out loud', () => {
  const timeline = [
    {
      title: 'Think Tank - Pod leaders meeting',
      start: '9:00 AM',
      end: '10:00 AM',
      status: 'upcoming',
      location: 'https://onereach.zoom.us/j/836?pwd=x',
      guests: Array.from({ length: 95 }, (_, i) => `p${i}@onereach.com`),
    },
    { title: 'Library sync-up', start: '10:00 AM', end: '10:50 AM', status: 'upcoming', guests: ['antony.peklo@onereach.com', 'robb@onereach.com'] },
    { title: 'Account Strategy Meetings', start: '12:00 PM', end: '1:00 PM', status: 'upcoming', guests: [] },
    { title: "Don’t book", start: '3:00 PM', end: '5:30 PM', status: 'upcoming', guests: [] },
  ];
  const flags = {
    conflicts: [],
    backToBack: [{ first: 'Think Tank - Pod leaders meeting', second: 'Library sync-up', transitionTime: '10:00 AM' }],
  };

  it('compresses the 95-person Zoom meeting with its back-to-back flag', () => {
    const [tt] = compressTimeline(timeline, { flags, selfEmail: 'robb@onereach.com' });
    expect(tt.where).toBe('Zoom');
    expect(tt.who).toBe('95 people');
    expect(tt.flag).toBe('back-to-back');
    expect(tt.line).toBe('9:00–10:00 AM · Think Tank - Pod leaders meeting · Zoom · 95 people · no break before Library sync-up');
    expect(tt.spoken).toBe('9 to 10 AM, Think Tank - Pod leaders meeting on Zoom with 95 people then straight into Library sync-up.');
  });

  it('names one or two other attendees, leaving the user out', () => {
    const items = compressTimeline(timeline, { flags, selfEmail: 'robb@onereach.com' });
    expect(items[1].who).toBe('with Antony Peklo');
    expect(items[1].spoken).toBe('10 to 10:50 AM, Library sync-up with Antony.');
    expect(items[1].flagDetail).toBe('right after Think Tank - Pod leaders meeting');
  });

  it('marks blocks as blocks, in both channels', () => {
    const items = compressTimeline(timeline, { flags });
    const block = items[3];
    expect(block.kind).toBe('block');
    expect(block.line).toBe("3:00–5:30 PM · Don’t book · block");
    expect(block.spoken).toMatch(/held for Don’t book, not a meeting/);
  });

  it('phrases done / in-progress / declined rows for the voice', () => {
    expect(compressTimelineItem({ title: 'Standup', start: '9:00 AM', end: '9:15 AM', status: 'completed' }).spoken).toBe('Standup is done.');
    expect(compressTimelineItem({ title: 'Roadmap', start: '2:00 PM', end: '3:00 PM', status: 'in-progress', location: 'https://meet.google.com/abc' }).spoken).toBe(
      "Right now you're in Roadmap on Google Meet, until 3:00 PM."
    );
    expect(compressTimelineItem({ title: 'Vendor pitch', start: '3:30 PM', end: '4:00 PM', status: 'upcoming', selfDeclined: true }).spoken).toMatch(/you declined it/);
  });

  it('a conflict names the other side and the overlap', () => {
    const item = compressTimelineItem(
      { title: 'A', start: '9:00 AM', end: '10:00 AM', status: 'upcoming' },
      { flags: { conflicts: [{ event1: 'A', event2: 'B', overlapMinutes: 30 }], backToBack: [] } }
    );
    expect(item.flag).toBe('conflict');
    expect(item.flagDetail).toBe('overlaps B by 30 min');
    expect(item.spoken).toBe('9 to 10 AM, A which overlaps B.');
  });
});

describe('buildCalendarBriefText -- what the composer reads', () => {
  const brief = {
    timeline: [
      { title: 'Think Tank - Pod leaders meeting', start: '9:00 AM', end: '10:00 AM', status: 'upcoming', guests: [] },
      { title: 'Library sync-up', start: '10:00 AM', end: '10:50 AM', status: 'upcoming', guests: [] },
      { title: "Don’t book", start: '3:00 PM', end: '5:30 PM', status: 'upcoming', guests: [] },
    ],
    conflicts: [],
    backToBack: [{ first: 'Think Tank - Pod leaders meeting', second: 'Library sync-up', transitionTime: '10:00 AM' }],
    freeTime: { longestFreeBlock: '70 minutes starting at 10:50 AM' },
  };

  it('spells out counts, one line per event, and DEFINED conflict / back-to-back lines', () => {
    const { content, headline, items } = buildCalendarBriefText({ brief, label: 'today' });
    expect(headline).toBe('2 meetings left today. Plus 1 block (not meetings).');
    expect(content).toContain('Next: "Think Tank - Pod leaders meeting" at 9:00 AM.');
    expect(content).toContain('Schedule items (one per event, in order):');
    expect(content).toContain('- 9:00–10:00 AM · Think Tank - Pod leaders meeting · no break before Library sync-up');
    expect(content).toContain('Schedule conflicts (overlapping meetings): none.');
    expect(content).toContain('Meetings back-to-back (no break between, NOT a conflict): 1 — "Think Tank - Pod leaders meeting" → "Library sync-up" at 10:00 AM.');
    expect(content).toContain('Longest free block: 70 minutes starting at 10:50 AM.');
    expect(items).toHaveLength(3);
  });

  it('names conflicts with both titles and the overlap, and never as back-to-back', () => {
    const { content } = buildCalendarBriefText({
      brief: {
        timeline: [
          { title: 'Sync', start: '10:00 AM', end: '11:00 AM', status: 'upcoming' },
          { title: 'Demo', start: '10:30 AM', end: '11:30 AM', status: 'upcoming' },
        ],
        conflicts: [{ event1: 'Sync', event2: 'Demo', overlapMinutes: 30, time: '10:30 AM' }],
        backToBack: [],
      },
      label: 'today',
    });
    expect(content).toContain('Schedule conflicts (overlapping meetings, you cannot attend both in full): 1 — "Sync" overlaps "Demo" by 30 min around 10:30 AM.');
    expect(content).toContain('Meetings back-to-back (no break between): none.');
  });

  it('keeps the legacy object shape working (event1.title)', () => {
    const { content } = buildCalendarBriefText({
      brief: {
        timeline: [{ title: 'Sync', start: '10:00 AM', status: 'upcoming' }],
        conflicts: [{ event1: { title: 'Sync' }, event2: { title: 'Demo' } }],
        backToBack: [{}, {}],
        longestFree: { durationMinutes: 120 },
      },
      label: 'today',
    });
    expect(content).toContain('"Sync" overlaps "Demo"');
    expect(content).toContain('Meetings back-to-back (no break between, NOT a conflict): 2.');
    expect(content).toContain('Longest free block: 2h.');
  });
});

describe('helpers', () => {
  it('classifyBriefTimeline is the same classifier calendar-format re-exports', () => {
    const fmt = require('../../lib/calendar-format');
    expect(fmt.classifyBriefTimeline).toBe(classifyBriefTimeline);
    expect(fmt.BLOCK_TITLE_RE.test("Don’t book")).toBe(true);
  });
  it('describeLocation shortens video links and long addresses', () => {
    expect(describeLocation('https://onereach.zoom.us/j/1')).toBe('Zoom');
    expect(describeLocation('https://teams.microsoft.com/l/meetup-join/x')).toBe('Teams');
    expect(describeLocation('https://example.com/room')).toBe('video call');
    expect(describeLocation('Room 4B')).toBe('Room 4B');
    expect(describeLocation('')).toBeNull();
  });
  it('describePeople counts others and names up to two', () => {
    expect(describePeople(['a.b@x.com', 'me@x.com'], 'me@x.com')).toEqual({ count: 1, line: 'with A B', spoken: 'with A' });
    expect(describePeople(['a@x.com', 'b@x.com', 'c@x.com']).line).toBe('3 people');
    expect(describePeople([]).line).toBe('');
  });
  it('spans read cleanly', () => {
    expect(compactSpan('9:00 AM', '10:00 AM')).toBe('9:00–10:00 AM');
    expect(compactSpan('11:30 AM', '1:00 PM')).toBe('11:30 AM–1:00 PM');
    expect(spokenSpan('9:00 AM', '10:00 AM')).toBe('9 to 10 AM');
    expect(spokenSpan('11:30 AM', '1:00 PM')).toBe('11:30 AM to 1 PM');
    expect(parseClock('12:15 AM')).toBe(15);
    expect(parseClock('12:00 PM')).toBe(720);
    expect(parseClock('nope')).toBeNull();
  });
});
