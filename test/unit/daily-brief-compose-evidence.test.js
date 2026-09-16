/**
 * daily-brief-agent (2026-09-15):
 *  - the composer prompt defines CONFLICT vs BACK-TO-BACK and asks for one
 *    sentence per meeting, the wear tip first, tasks in order;
 *  - the result carries `sources` (evidence) so the answer reflector stops
 *    judging real numbers as fabricated;
 *  - contributors' { line, spoken } items become dayView sections, so what
 *    is spoken is also on screen.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../lib/log-event-queue', () => ({
  getLogQueue: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const agent = require('../../packages/agents/daily-brief-agent');
const { renderAgentUI } = require('../../lib/agent-ui-renderer');

const CONTRIBUTIONS = [
  { section: 'Time & Date', priority: 1, content: 'Current time: 7:25 AM. Date: Tuesday, September 15, 2026. Time of day: morning.' },
  {
    section: 'Weather',
    priority: 2,
    content: 'Now 54°F and clear in San Francisco, high 69°F, low 54°F. Wear a light jacket, shed it by afternoon.',
    headline: 'Wear a light jacket, bring sunscreen for midday',
    items: [{ line: '54°F now · high 69°F, low 54°F · a light jacket · bring sunscreen', spoken: 'Grab a light jacket.' }],
  },
  {
    section: 'Calendar',
    priority: 3,
    content: '3 meetings left today.\nSchedule conflicts (overlapping meetings): none.\nMeetings back-to-back (no break between, NOT a conflict): 1 — "Think Tank" → "Library sync-up" at 10:00 AM.',
    items: [
      { title: 'Think Tank', kind: 'meeting', status: 'upcoming', line: '9:00–10:00 AM · Think Tank · Zoom · 95 people · no break before Library sync-up', spoken: '9 to 10 AM, Think Tank on Zoom with 95 people then straight into Library sync-up.' },
      { title: 'Library sync-up', kind: 'meeting', status: 'upcoming', line: '10:00–10:50 AM · Library sync-up', spoken: '10 to 10:50 AM, Library sync-up.' },
      { title: 'Account Strategy Meetings', kind: 'meeting', status: 'upcoming', line: '12:00–1:00 PM · Account Strategy Meetings', spoken: '12 to 1 PM, Account Strategy Meetings.' },
      { title: 'Don’t book', kind: 'block', status: 'upcoming', line: '3:00–5:30 PM · Don’t book · block', spoken: '3 to 5:30 PM is held for Don’t book, not a meeting.' },
    ],
    briefData: {
      isToday: true,
      date: new Date(2026, 8, 15).toISOString(),
      currentTimeFormatted: '7:25 AM',
      timeline: [
        { title: 'Think Tank', start: '9:00 AM', end: '10:00 AM', status: 'upcoming', guests: ['a', 'b'], location: 'https://onereach.zoom.us/j/1' },
        { title: 'Library sync-up', start: '10:00 AM', end: '10:50 AM', status: 'upcoming', guests: ['a'] },
        { title: 'Account Strategy Meetings', start: '12:00 PM', end: '1:00 PM', status: 'upcoming', guests: [] },
        { title: 'Don’t book', start: '3:00 PM', end: '5:30 PM', status: 'upcoming', guests: [] },
      ],
      conflicts: [],
      backToBack: [{ first: 'Think Tank', second: 'Library sync-up', transitionTime: '10:00 AM', gapMinutes: 0 }],
      summary: { timedEvents: 4, completedCount: 0, upcomingCount: 4, inProgressCount: 0 },
      freeTime: { busyHours: 3.5, freeSlots: [{ start: '10:50 AM', end: '12:00 PM', duration: 70 }], longestFreeBlock: '70 minutes starting at 10:50 AM' },
    },
  },
  {
    section: 'Tasks',
    priority: 5,
    content: '3 tasks today (2 in your morning routine).\nMorning routine (in order):\n- 7:00 AM · Morning Workout',
    headline: '3 tasks today (2 in your morning routine).',
    items: [{ line: '7:00 AM · Morning Workout', spoken: '7 AM, Morning Workout.' }, { line: '7:30 AM · Stretch Calves', spoken: '7:30 AM, Stretch Calves.' }],
  },
  { section: 'Email', priority: 4, content: 'Email isn\'t connected yet. Say "set up email" to link an inbox.' },
];

describe('_composeBriefing prompt', () => {
  let spy;
  beforeEach(() => {
    spy = vi.fn().mockResolvedValue('Good morning, Robb. It is seven twenty-five. Grab a light jacket. Straight from Think Tank into Library sync-up. That is your day.');
    agent._aiOverride = { complete: spy };
  });
  afterEach(() => {
    agent._aiOverride = null;
  });

  it('defines conflict vs back-to-back, asks for one sentence per meeting, wear tip first, tasks in order, never "check the logs"', async () => {
    const text = await agent._composeBriefing(CONTRIBUTIONS, { Length: 'standard (80-150 words)' }, 'Robb', 'today');
    expect(text).toMatch(/^Good morning, Robb/);
    const prompt = spy.mock.calls[0][0];
    expect(prompt).toContain('A CONFLICT is two meetings that OVERLAP in time.');
    expect(prompt).toContain('BACK-TO-BACK means one meeting ends exactly as the next begins -- there is NO overlap');
    expect(prompt).toContain('never call it a conflict');
    expect(prompt).toContain('If the data says the schedule conflicts are none, say there are no conflicts.');
    expect(prompt).toContain('one short, useful sentence per meeting still ahead');
    expect(prompt).toContain('lead with the wear-and-bring tip');
    expect(prompt).toContain('read the morning routine items in order');
    expect(prompt).toContain('Never tell the user to "check the logs"');
    // The section texts are handed over verbatim.
    expect(prompt).toContain('[Calendar]\n3 meetings left today.');
    expect(prompt).toContain('Meetings back-to-back (no break between, NOT a conflict): 1');
    // Existing pins.
    expect(prompt).toContain('Open with a SINGLE time-of-day greeting');
    expect(prompt).toContain('Do NOT repeat the greeting');
    expect(prompt).toContain('"Time of day" field');
    expect(spy.mock.calls[0][1]).toMatchObject({ feature: 'daily-brief-compose' });
  });

  it('with more than three meetings ahead the length rule prefers one sentence per meeting', async () => {
    const many = CONTRIBUTIONS.map((c) =>
      c.section === 'Calendar'
        ? { ...c, items: [...c.items, { title: 'Extra', kind: 'meeting', status: 'upcoming', line: 'x', spoken: 'x' }] }
        : c
    );
    await agent._composeBriefing(many, {}, 'Robb', 'today');
    expect(spy.mock.calls[0][0]).toContain('one short sentence per meeting matters more than the word count');
  });
});

describe('LLM-unavailable fallback', () => {
  it('speaks the contributors\' spoken sentences, not their bullet lists', async () => {
    agent._aiOverride = { complete: async () => { throw new Error('no key'); } };
    try {
      const text = await agent._composeBriefing(CONTRIBUTIONS, {}, 'Robb', 'today');
      expect(text).toMatch(/^Good (morning|afternoon|evening), Robb\. /);
      expect(text).toContain('Grab a light jacket.');
      expect(text).toContain('9 to 10 AM, Think Tank on Zoom with 95 people then straight into Library sync-up.');
      expect(text).toContain('7 AM, Morning Workout.');
      expect(text).not.toContain('Schedule items (one per event');
      expect(text).not.toContain('- 9:00');
    } finally {
      agent._aiOverride = null;
    }
  });
});

describe('sections, evidence and panel sizing', () => {
  it('_buildSections turns items into on-screen cards, skipping Calendar and Time', () => {
    const sections = agent._buildSections(CONTRIBUTIONS);
    expect(sections.map((s) => s.title)).toEqual(['Weather', 'Tasks', 'Email']);
    expect(sections[0]).toEqual({ title: 'Weather', headline: 'Wear a light jacket, bring sunscreen for midday', lines: ['54°F now · high 69°F, low 54°F · a light jacket · bring sunscreen'] });
    expect(sections[1].lines).toEqual(['7:00 AM · Morning Workout', '7:30 AM · Stretch Calves']);
    expect(sections[2].lines).toEqual(['Email isn\'t connected yet. Say "set up email" to link an inbox.']);
  });

  it('_buildEvidence hands the reflector every section text', () => {
    const ev = agent._buildEvidence(CONTRIBUTIONS);
    expect(ev).toHaveLength(5);
    expect(ev[2]).toMatch(/^\[Calendar\] 3 meetings left today\./);
  });

  it('computePanelHeight grows with sections, still capped at 900', () => {
    expect(agent.computePanelHeight({ events: [], sections: [] })).toBe(540);
    expect(agent.computePanelHeight({ events: [{}, {}], sections: [{}, {}] })).toBe(540 + 140 + 160);
    expect(agent.computePanelHeight({ events: new Array(10).fill({}), sections: new Array(5).fill({}) })).toBe(900);
  });

  it('a failed calendar never renders as a clear day (reviewer finding #3)', () => {
    const { buildDayViewSpec } = require('../../lib/calendar-format');
    const failed = buildDayViewSpec(null, 'Calendar unavailable.', { sections: [], calendarUnavailable: true });
    expect(failed.insightCards[0]).toEqual({ title: 'Today at a glance', value: 'Calendar unavailable', sub: 'Could not read your calendar' });
    const clear = buildDayViewSpec(null, null, { sections: [] });
    expect(clear.insightCards[0].value).toBe('Clear day');
  });

  it('the dayView spec + renderer carry the sections and the back-to-back marker', () => {
    const { buildDayViewSpec } = require('../../lib/calendar-format');
    const cal = CONTRIBUTIONS.find((c) => c.section === 'Calendar');
    const ui = buildDayViewSpec(cal.briefData, 'Good morning.', { sections: agent._buildSections(CONTRIBUTIONS) });
    expect(ui.sections.map((s) => s.title)).toEqual(['Weather', 'Tasks', 'Email']);
    const tt = ui.events.find((e) => e.title === 'Think Tank');
    expect(tt.tightAfter).toBe('Library sync-up');
    expect(tt.conflictsWith).toBeUndefined();
    expect(tt.line).toContain('no break before Library sync-up');
    expect(ui.events.find((e) => e.title === 'Library sync-up').tightBefore).toBe('Think Tank');
    expect(ui.insightCards.find((c) => c.title === 'Conflict check')).toEqual({
      title: 'Conflict check',
      value: 'Clear',
      sub: 'No overlaps · 1 back-to-back (Think Tank → Library sync-up)',
    });
    const html = renderAgentUI(ui);
    expect(html).toContain('No break');
    expect(html).toContain('Straight into Library sync-up');
    expect(html).toContain('Wear a light jacket, bring sunscreen for midday');
    expect(html).toContain('7:00 AM · Morning Workout');
    expect(html).not.toContain('⚠ Conflict');
  });
});
