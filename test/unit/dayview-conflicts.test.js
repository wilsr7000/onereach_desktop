/**
 * dayView conflict handling (2026-08-05: "the visual for my daily brief did
 * not handle conflicts").
 *
 * Conflicts existed only as a summary insight card ("2 conflicts — A / B")
 * while the timeline rendered colliding meetings as ordinary sequential rows,
 * so a double-booked slot was invisible AT the row. The spec now marks each
 * participating event and the renderer shows a badge + "Overlaps X · N min".
 */

import { describe, it, expect } from 'vitest';

const { buildDayViewSpec } = require('../../lib/calendar-format');
const { renderAgentUI } = require('../../lib/agent-ui-renderer');

function brief(overrides = {}) {
  return {
    date: new Date('2026-08-05T12:00:00Z').toISOString(),
    timeline: [
      { title: 'Finance Angels', start: '8:00 AM', end: '9:00 AM', status: 'upcoming', guests: ['a@x.com'] },
      { title: 'Think Tank', start: '9:00 AM', end: '10:00 AM', status: 'upcoming', guests: ['b@x.com'] },
      { title: 'Solo work', start: '11:00 AM', end: '11:30 AM', status: 'upcoming', guests: [] },
    ],
    conflicts: [{ event1: 'Finance Angels', event2: 'Think Tank', overlapMinutes: 30, time: '8:00 AM' }],
    backToBack: [],
    summary: {},
    freeTime: {},
    ...overrides,
  };
}

describe('buildDayViewSpec — conflict marking', () => {
  it('marks BOTH sides of a conflict, each naming the other', () => {
    const spec = buildDayViewSpec(brief(), 'Today');
    const byTitle = Object.fromEntries(spec.events.map((e) => [e.title, e]));
    expect(byTitle['Finance Angels'].conflictsWith).toEqual(['Think Tank']);
    expect(byTitle['Think Tank'].conflictsWith).toEqual(['Finance Angels']);
    expect(byTitle['Finance Angels'].overlapMinutes).toBe(30);
  });

  it('leaves non-conflicting events unmarked', () => {
    const spec = buildDayViewSpec(brief(), 'Today');
    const solo = spec.events.find((e) => e.title === 'Solo work');
    expect(solo.conflictsWith).toBeUndefined();
  });

  it('handles an event colliding with two others', () => {
    const spec = buildDayViewSpec(
      brief({
        conflicts: [
          { event1: 'Finance Angels', event2: 'Think Tank', overlapMinutes: 30 },
          { event1: 'Finance Angels', event2: 'Solo work', overlapMinutes: 15 },
        ],
      }),
      'Today'
    );
    const fa = spec.events.find((e) => e.title === 'Finance Angels');
    expect(fa.conflictsWith).toEqual(['Think Tank', 'Solo work']);
    expect(fa.overlapMinutes).toBe(30); // worst overlap wins
  });

  it('does NOT flag personal blocks as conflicts (a hold is not a double-booking)', () => {
    const spec = buildDayViewSpec(
      brief({
        timeline: [
          { title: 'Don’t book', start: '3:00 PM', end: '5:30 PM', status: 'upcoming', guests: [] },
          { title: 'Think Tank', start: '3:30 PM', end: '4:00 PM', status: 'upcoming', guests: ['b@x.com'] },
        ],
        conflicts: [{ event1: 'Don’t book', event2: 'Think Tank', overlapMinutes: 30 }],
      }),
      'Today'
    );
    const block = spec.events.find((e) => e.title === 'Don’t book');
    expect(block.conflictsWith).toBeUndefined();
  });

  it('is safe when there are no conflicts at all', () => {
    const spec = buildDayViewSpec(brief({ conflicts: [] }), 'Today');
    expect(spec.events.every((e) => e.conflictsWith === undefined)).toBe(true);
  });
});

describe('renderAgentUI(dayView) — conflicts are visible on the row', () => {
  it('renders a warning badge and an "Overlaps" line for each conflicting event', () => {
    const html = renderAgentUI(buildDayViewSpec(brief(), 'Today'));
    expect((html.match(/⚠ Conflict/g) || []).length).toBe(2);
    expect(html).toMatch(/Overlaps Think Tank · 30 min/);
    expect(html).toMatch(/Overlaps Finance Angels · 30 min/);
  });

  it('renders no conflict markers on a clean day', () => {
    const html = renderAgentUI(buildDayViewSpec(brief({ conflicts: [] }), 'Today'));
    expect(html).not.toMatch(/⚠ Conflict/);
    expect(html).not.toMatch(/Overlaps /);
  });

  it('escapes conflicting titles (no HTML injection through event names)', () => {
    const html = renderAgentUI(
      buildDayViewSpec(
        brief({
          timeline: [
            { title: '<img src=x onerror=alert(1)>', start: '8:00 AM', end: '9:00 AM', status: 'upcoming', guests: ['a@x.com'] },
            { title: 'Think Tank', start: '8:30 AM', end: '9:00 AM', status: 'upcoming', guests: ['b@x.com'] },
          ],
          conflicts: [{ event1: '<img src=x onerror=alert(1)>', event2: 'Think Tank', overlapMinutes: 30 }],
        }),
        'Today'
      )
    );
    expect(html).not.toMatch(/<img src=x/);
    expect(html).toMatch(/&lt;img/);
  });
});
