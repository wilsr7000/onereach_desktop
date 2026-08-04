/**
 * Daily brief count consistency -- voice and UI must tell the same story.
 *
 * Regression for the 2026-08 "said 3 meetings, showed 7 in the UI" report:
 * the spoken brief filtered blocks/declined and counted what's LEFT today,
 * while the dayView glance card and timeline used the raw timed-event tally.
 * Both channels now derive from ONE classifier (classifyBriefTimeline in
 * lib/calendar-format.js). Also pins the local-timezone day-identity fixes
 * (localDateKey; no UTC toISOString().slice(0,10) day keys in the calendar
 * query path -- the "today is tomorrow after 5 PM Pacific" bug class).
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../lib/log-event-queue', () => ({
  getLogQueue: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const fs = require('fs');
const path = require('path');

const {
  classifyBriefTimeline,
  localDateKey,
  buildDayViewSpec,
  BLOCK_TITLE_RE,
} = require('../../lib/calendar-format');
const calendarQueryAgent = require('../../packages/agents/calendar-query-agent');
const { renderAgentUI } = require('../../lib/agent-ui-renderer');

// One fixture, seven timed events on today's calendar:
//   3 real meetings still ahead (1 in-progress + 2 upcoming)
//   2 real meetings finished
//   1 "Don't book" block, 1 declined invite
// Voice must say 3 left (2 done); UI glance must say the same; timeline
// shows all 7 rows with the 2 non-meetings muted.
const TIMELINE = [
  { title: 'Design sync', start: '9:00 AM', end: '9:30 AM', status: 'completed', guests: ['a', 'b'] },
  { title: '1:1 with Sam', start: '10:00 AM', end: '10:30 AM', status: 'completed', guests: ['sam'] },
  { title: "Don't book — school run", start: '11:00 AM', end: '11:30 AM', status: 'completed', guests: [] },
  { title: 'Roadmap review', start: '2:00 PM', end: '3:00 PM', status: 'in-progress', guests: ['a'] },
  { title: 'Vendor pitch', start: '3:30 PM', end: '4:00 PM', status: 'upcoming', guests: ['v'], selfDeclined: true },
  { title: 'Board prep', start: '4:30 PM', end: '5:30 PM', status: 'upcoming', guests: ['c', 'd'] },
  { title: 'Watch demo', start: '6:00 PM', end: '6:30 PM', status: 'upcoming', guests: ['e'] },
];

const BRIEF_DATA = {
  isToday: true,
  timeline: TIMELINE,
  summary: { timedEvents: 7, completedCount: 3, upcomingCount: 3, inProgressCount: 1 },
  freeTime: { busyHours: 4, freeSlots: [{ duration: 45 }] },
};

describe('classifyBriefTimeline (the shared vocabulary)', () => {
  it('separates real meetings from blocks and declined invites', () => {
    const cls = classifyBriefTimeline(TIMELINE);
    expect(cls.meetings).toHaveLength(5);
    expect(cls.blocks.map((e) => e.title)).toEqual(["Don't book — school run"]);
    expect(cls.declined.map((e) => e.title)).toEqual(['Vendor pitch']);
    expect(cls.upcoming.map((e) => e.title)).toEqual(['Roadmap review', 'Board prep', 'Watch demo']);
    expect(cls.completed.map((e) => e.title)).toEqual(['Design sync', '1:1 with Sam']);
  });

  it('recognizes the block-title vocabulary', () => {
    for (const t of ["Don't book", 'do not book', 'HOLD', 'Blocked', 'focus time', 'Focus', 'busy']) {
      expect(BLOCK_TITLE_RE.test(t), t).toBe(true);
    }
    expect(BLOCK_TITLE_RE.test('Focus group interview readout')).toBe(true); // known-coarse: title filter
    expect(BLOCK_TITLE_RE.test('Roadmap review')).toBe(false);
  });

  it('is safe on empty/missing timelines', () => {
    expect(classifyBriefTimeline(null).meetings).toEqual([]);
    expect(classifyBriefTimeline([]).upcoming).toEqual([]);
  });
});

describe('voice and UI agree (the "said 3, showed 7" regression)', () => {
  it('the spoken contribution counts 3 left, 2 done', () => {
    const out = calendarQueryAgent._composeBriefingContribution({ timeline: TIMELINE }, 'today');
    expect(out.content).toContain('3 meetings left today');
    expect(out.content).toContain('(2 already done)');
    // The next-up line points at a REAL meeting, not the block/declined
    expect(out.content).toContain('Next: "Roadmap review"');
  });

  it('the dayView glance card says the same numbers', () => {
    const spokenCls = classifyBriefTimeline(TIMELINE);
    const ui = buildDayViewSpec(BRIEF_DATA, 'briefing text');
    const glance = ui.insightCards[0];
    expect(glance.title).toBe('Today at a glance');
    expect(glance.value).toBe(`${spokenCls.upcoming.length} meetings left`);
    expect(glance.sub).toContain(`${spokenCls.completed.length} done`);
    expect(glance.sub).toContain('2 blocks/declined');
  });

  it('the timeline still shows the WHOLE day, with non-meetings labeled + muted', () => {
    const ui = buildDayViewSpec(BRIEF_DATA, 'briefing text');
    expect(ui.events).toHaveLength(7); // timeline completeness preserved
    const muted = ui.events.filter((e) => e.muted);
    expect(muted.map((e) => e.type).sort()).toEqual(['Block', 'Declined']);
    // rows decompose into the spoken vocabulary: 7 = 3 left + 2 done + 2 muted
    const cls = classifyBriefTimeline(TIMELINE);
    expect(ui.events.length).toBe(
      cls.upcoming.length + cls.completed.length + cls.blocks.length + cls.declined.length
    );
  });

  it('all-done and empty days stay honest', () => {
    const doneDay = {
      isToday: true,
      timeline: TIMELINE.map((e) => ({ ...e, status: 'completed' })),
      summary: {},
      freeTime: {},
    };
    const ui = buildDayViewSpec(doneDay, 'x');
    expect(ui.insightCards[0].value).toBe('All 5 done');

    const blocksOnly = {
      isToday: true,
      timeline: [{ title: 'Focus time', start: '9:00 AM', end: '10:00 AM', status: 'upcoming', guests: [] }],
      summary: {},
      freeTime: {},
    };
    expect(buildDayViewSpec(blocksOnly, 'x').insightCards[0].value).toBe('No meetings');
  });

  it('the renderer dims muted rows and knows the Block/Declined badges', () => {
    const ui = buildDayViewSpec(BRIEF_DATA, 'briefing text');
    const html = renderAgentUI(ui);
    expect(html).toContain('opacity:0.5');
    expect(html).toContain('>Block</span>');
    expect(html).toContain('>Declined</span>');
  });
});

describe('local timezone day identity', () => {
  it('localDateKey names the LOCAL calendar day, even late evening', () => {
    // Constructed in local time, so these hold in every timezone.
    expect(localDateKey(new Date(2026, 7, 3, 23, 30))).toBe('2026-08-03');
    expect(localDateKey(new Date(2026, 7, 3, 0, 0))).toBe('2026-08-03');
    expect(localDateKey(new Date(2026, 0, 1, 23, 59, 59))).toBe('2026-01-01');
  });

  it('differs from the UTC slice exactly when the local evening crosses UTC midnight', () => {
    const lateEvening = new Date(2026, 7, 3, 23, 30);
    const utcKey = lateEvening.toISOString().slice(0, 10);
    const offsetMin = lateEvening.getTimezoneOffset();
    if (offsetMin > 90) {
      // UTC-negative zones (e.g. Pacific): 11:30 PM local is tomorrow in UTC.
      expect(utcKey).not.toBe(localDateKey(lateEvening));
    } else {
      expect(typeof utcKey).toBe('string');
    }
  });

  it('the calendar query path no longer derives day keys from UTC slices (source invariant)', () => {
    const agentSrc = fs.readFileSync(
      path.join(__dirname, '../../packages/agents/calendar-query-agent.js'),
      'utf8'
    );
    expect(agentSrc).not.toMatch(/toISOString\(\)\.slice\(0,\s*10\)/);
    expect(agentSrc).toMatch(/localDateKey\(now\)/); // LLM prompt "Today:" line
    const dataSrc = fs.readFileSync(path.join(__dirname, '../../lib/calendar-data.js'), 'utf8');
    expect(dataSrc).not.toMatch(/dateStr:\s*dayStart\.toISOString/);
  });
});
