/**
 * lib/meetings/meeting-history.js — timeline rows behind the meeting-history
 * modal. Pins: source merging (meeting objects claim their transcripts,
 * orphans surface on their own), the summary fallback chain
 * (analysis → transcript preview → none), and newest-first ordering.
 *
 * Run:  npx vitest run test/unit/meeting-history.test.js
 */

import { describe, it, expect } from 'vitest';

const {
  buildMeetingHistory,
  transcriptPreviewSummary,
} = require('../../lib/meetings/meeting-history.js');

const T0 = 1786500000000;

function meetingJson(overrides = {}) {
  return JSON.stringify({
    id: 'meeting_1',
    calendar: { vevent: { summary: 'Co-Design Session' } },
    contacts: [{ displayName: 'robb' }, { displayName: 'JimJ' }],
    during: { actualDuration: 62 },
    post: { summary: 'Discussed knowledge models and agreed next steps.', transcriptItemId: 't-1' },
    status: 'completed',
    ...overrides,
  });
}

const TRANSCRIPT = `# Meeting Transcript

**Recorded:** 8/11/2026, 4:38:49 PM
**Duration:** 136:13
**Lines:** 194

---

**robb**

**[00:04]** Hey hey

**JimJ**

**[00:07]** How are you? Good, hey Ben.`;

function fixture() {
  const entries = [
    { id: 'm-1', spaceId: 's-1', type: 'text', tags: ['wiser-meeting'], preview: '{"id":"meeting_1"', timestamp: T0 + 2000 },
    { id: 't-1', spaceId: 's-1', type: 'text', preview: TRANSCRIPT.slice(0, 120), timestamp: T0 + 1000 },
    { id: 't-orphan', spaceId: 's-2', type: 'text', preview: TRANSCRIPT.slice(0, 120), timestamp: T0 + 5000 },
    { id: 'note', spaceId: 's-1', type: 'text', preview: 'just a note', timestamp: T0 + 9000 },
  ];
  const contents = {
    'm-1': meetingJson(),
    't-1': TRANSCRIPT,
    't-orphan': TRANSCRIPT,
  };
  return {
    getEntries: () => entries,
    loadContent: (id) => contents[id] || null,
  };
}

describe('buildMeetingHistory', () => {
  it('merges meeting objects + orphan transcripts, newest first, notes excluded', async () => {
    const rows = await buildMeetingHistory(fixture());
    expect(rows.map((r) => r.key)).toEqual(['transcript:t-orphan', 'meeting:m-1']);
  });

  it('a meeting claims its transcript — no duplicate row for t-1', async () => {
    const rows = await buildMeetingHistory(fixture());
    expect(rows.some((r) => r.key === 'transcript:t-1')).toBe(false);
    const m = rows.find((r) => r.key === 'meeting:m-1');
    expect(m.transcriptItemId).toBe('t-1');
  });

  it('uses the analysis summary when present', async () => {
    const rows = await buildMeetingHistory(fixture());
    const m = rows.find((r) => r.key === 'meeting:m-1');
    expect(m.summary).toBe('Discussed knowledge models and agreed next steps.');
    expect(m.summarySource).toBe('analysis');
    expect(m.title).toBe('Co-Design Session');
    expect(m.durationMin).toBe(62);
    expect(m.participants).toEqual(['robb', 'JimJ']);
  });

  it('falls back to transcript lines when analysis never ran', async () => {
    const f = fixture();
    const noSummary = meetingJson({ post: { summary: null, transcriptItemId: 't-1' } });
    f.loadContent = (id) => (id === 'm-1' ? noSummary : id.startsWith('t') ? TRANSCRIPT : null);
    const rows = await buildMeetingHistory(f);
    const m = rows.find((r) => r.key === 'meeting:m-1');
    expect(m.summarySource).toBe('transcript');
    expect(m.summary).toContain('Hey hey');
    expect(m.summary).not.toContain('# Meeting Transcript');
  });

  it('orphan transcripts carry a dated title and transcript-only status', async () => {
    const rows = await buildMeetingHistory(fixture());
    const o = rows.find((r) => r.key === 'transcript:t-orphan');
    expect(o.title).toContain('8/11/2026');
    expect(o.status).toBe('transcript-only');
    expect(o.summarySource).toBe('transcript');
  });

  it('unparseable meeting JSON is skipped, not fatal', async () => {
    const f = fixture();
    const orig = f.loadContent;
    f.loadContent = (id) => (id === 'm-1' ? '{broken json' : orig(id));
    const rows = await buildMeetingHistory(f);
    expect(rows.some((r) => r.key === 'meeting:m-1')).toBe(false);
    expect(rows.length).toBeGreaterThan(0); // transcripts still listed
  });
});

describe('transcriptPreviewSummary', () => {
  it('drops headers/metadata and keeps dialogue', () => {
    const s = transcriptPreviewSummary(TRANSCRIPT);
    expect(s).toContain('robb');
    expect(s).toContain('Hey hey');
    expect(s).not.toContain('# Meeting');
    expect(s).not.toContain('Recorded:');
  });

  it('caps length with an ellipsis', () => {
    const long = '# Meeting Transcript\n\n' + '**robb**\n\n**[00:01]** word '.repeat(80);
    const s = transcriptPreviewSummary(long, 120);
    expect(s.length).toBeLessThanOrEqual(120);
    expect(s.endsWith('…')).toBe(true);
  });

  it('returns null for empty or no-dialogue input', () => {
    expect(transcriptPreviewSummary('')).toBeNull();
    expect(transcriptPreviewSummary('# Meeting Transcript\n\n---\n')).toBeNull();
  });
});
