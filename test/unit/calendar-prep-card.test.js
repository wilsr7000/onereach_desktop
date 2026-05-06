/**
 * Phase 7 (calendar agent overhaul) -- prep card.
 *
 * Three slices, tested independently:
 *
 *   7a -- deterministic: window gating, join button, travel-aware leave-early
 *         hint (incl. the "two video calls -> no hint" fix from prior plan
 *         critique).
 *   7b -- memory-backed: attendee notes from People section, classifier
 *         prep.reasons surface as the prep summary header.
 *   7c -- cross-agent: meeting-notes lookup with timeout, agenda from
 *         classifier research bullets, fallback to event description.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const calendarMemory = require('../../lib/calendar-memory');
const prepCard = require('../../lib/calendar-prep-card');

function makeFakeStore(seedSections = {}) {
  const sections = new Map();
  for (const [k, v] of Object.entries(seedSections)) sections.set(k, v);
  return {
    isLoaded: () => true,
    isDirty: () => false,
    async load() { return true; },
    async save() { return true; },
    getSection(name) { return sections.get(name) || null; },
    updateSection(name, content) { sections.set(name, content); },
    appendToSection(name, entry) {
      const cur = sections.get(name) || '';
      sections.set(name, cur ? `${cur}\n${entry}` : entry);
    },
    getSectionNames() { return [...sections.keys()].filter((k) => k !== '_header'); },
    parseSectionAsKeyValue() { return {}; },
    getRaw() { return ''; },
    setRaw() {},
  };
}

let memory;
let originalSettings;

beforeEach(async () => {
  calendarMemory._resetForTests();
  memory = new calendarMemory.CalendarMemory();
  memory._setStoreForTests(makeFakeStore());
  await memory.load();

  originalSettings = global.settingsManager;
  global.settingsManager = {
    get: vi.fn((key, def) => {
      if (key === 'calendar.prepCardEnabled') return true;
      if (key === 'calendar.prepCard.windowMinutes') return 30;
      if (key === 'calendar.prepCard.meetingNotesTimeoutMs') return 200;
      return def;
    }),
  };

  // Stub classifier + meeting-notes seams so tests don't load real modules.
  prepCard._seams.classifier = {
    classifyMeeting: vi.fn().mockResolvedValue(null),
  };
  prepCard._seams.meetingNotes = null;
  prepCard._seams.contactStore = null;
});

afterEach(() => {
  global.settingsManager = originalSettings;
  prepCard._seams.classifier = null;
  prepCard._seams.meetingNotes = null;
  prepCard._seams.contactStore = null;
});

const NOW = new Date('2026-04-29T08:30:00Z');

function evt(overrides = {}) {
  return {
    id: 'evt_1',
    summary: 'Quarterly review',
    start: { dateTime: '2026-04-29T09:00:00Z' }, // 30 min from NOW
    end: { dateTime: '2026-04-29T10:00:00Z' },
    attendees: [{ email: 'me@onereach.ai' }, { email: 'sarah@acme.com', displayName: 'Sarah Smith' }],
    ...overrides,
  };
}

describe('Phase 7: window gating', () => {
  it('returns null when event is outside windowMinutes (more than 30 min away)', async () => {
    const ev = evt({ start: { dateTime: '2026-04-29T11:00:00Z' } });
    const card = await prepCard.buildPrepCard(ev, { now: NOW, memory });
    expect(card).toBeNull();
  });

  it('returns a card when event is within window', async () => {
    const card = await prepCard.buildPrepCard(evt(), { now: NOW, memory });
    expect(card).toBeTruthy();
    expect(card.eventId).toBe('evt_1');
    expect(card.minutesUntil).toBeGreaterThanOrEqual(0);
    expect(card.minutesUntil).toBeLessThanOrEqual(30);
  });

  it('returns a card for an event that started up to 5 min ago (running late)', async () => {
    const ev = evt({ start: { dateTime: '2026-04-29T08:27:00Z' } });
    const card = await prepCard.buildPrepCard(ev, { now: NOW, memory });
    expect(card).toBeTruthy();
  });

  it('returns null when the prep-card flag is off', async () => {
    global.settingsManager.get = vi.fn((k) => (k === 'calendar.prepCardEnabled' ? false : undefined));
    expect(await prepCard.buildPrepCard(evt(), { now: NOW, memory })).toBeNull();
  });
});

describe('Phase 7a: deterministic join button', () => {
  it('extracts and surfaces the join link', async () => {
    const ev = evt({ hangoutLink: 'https://meet.google.com/abc-defg-hij' });
    const card = await prepCard.buildPrepCard(ev, { now: NOW, memory });
    expect(card.join).toBeTruthy();
    expect(card.join.url).toContain('meet.google.com');
  });

  it('omits the join section when no link is present', async () => {
    const card = await prepCard.buildPrepCard(evt(), { now: NOW, memory });
    expect(card.join).toBeNull();
  });
});

describe('Phase 7a: travel-aware leave-early', () => {
  it('flags leave-early when next event starts back-to-back at a different physical location', () => {
    const a = { end: { dateTime: '2026-04-29T10:00:00Z' }, location: 'Conference Room 3A' };
    const b = { start: { dateTime: '2026-04-29T10:01:00Z' }, location: 'Building 7, Floor 4' };
    expect(prepCard.shouldHintLeaveEarly(a, b)).toBe(true);
  });

  it('does NOT flag when both meetings are video calls', () => {
    const a = { end: { dateTime: '2026-04-29T10:00:00Z' }, location: 'https://zoom.us/j/123' };
    const b = { start: { dateTime: '2026-04-29T10:01:00Z' }, location: 'https://meet.google.com/xyz' };
    expect(prepCard.shouldHintLeaveEarly(a, b)).toBe(false);
  });

  it('does NOT flag when both meetings are at the same location', () => {
    const a = { end: { dateTime: '2026-04-29T10:00:00Z' }, location: 'Room 5' };
    const b = { start: { dateTime: '2026-04-29T10:01:00Z' }, location: 'Room 5' };
    expect(prepCard.shouldHintLeaveEarly(a, b)).toBe(false);
  });

  it('does NOT flag when there is more than 5 min gap between meetings', () => {
    const a = { end: { dateTime: '2026-04-29T10:00:00Z' }, location: 'Room A' };
    const b = { start: { dateTime: '2026-04-29T10:30:00Z' }, location: 'Room B' };
    expect(prepCard.shouldHintLeaveEarly(a, b)).toBe(false);
  });

  it('does NOT flag when video -> unknown next location (avoid speculation)', () => {
    const a = { end: { dateTime: '2026-04-29T10:00:00Z' }, location: 'https://zoom.us/j/123' };
    const b = { start: { dateTime: '2026-04-29T10:01:00Z' } };
    expect(prepCard.shouldHintLeaveEarly(a, b)).toBe(false);
  });
});

describe('Phase 7b: memory-backed attendee notes', () => {
  it('joins People notes onto attendees when they match', async () => {
    memory._setStoreForTests(
      makeFakeStore({
        People:
          '<!-- schemaVersion: 1 -->\n- Sarah Smith (sarah@acme.com): VP at Acme; we usually discuss roadmap',
      })
    );
    await memory.load();

    const card = await prepCard.buildPrepCard(evt(), { now: NOW, memory });
    const sarah = (card.attendees || []).find((a) => a.email === 'sarah@acme.com');
    expect(sarah?.note).toContain('VP at Acme');
  });

  it('surfaces classifier prep.reasons as the prepSummary section', async () => {
    prepCard._seams.classifier = {
      classifyMeeting: vi.fn().mockResolvedValue({
        primary: 'external',
        prep: { level: 'heavy', minutes: 30, reasons: ["you're presenting", 'doc attached'] },
        research: null,
      }),
    };
    const card = await prepCard.buildPrepCard(evt(), { now: NOW, memory });
    expect(card.prepSummary?.level).toBe('heavy');
    expect(card.prepSummary?.reasons).toContain("you're presenting");
  });

  it('attendee section is null when there are no attendees', async () => {
    const card = await prepCard.buildPrepCard(evt({ attendees: [] }), { now: NOW, memory });
    expect(card.attendees).toBeNull();
  });
});

describe('Phase 7c: cross-agent enrichment', () => {
  it('queries meeting-notes-agent and surfaces lastNote', async () => {
    prepCard._seams.classifier = {
      classifyMeeting: vi.fn().mockResolvedValue({ primary: 'external', prep: {}, research: null }),
    };
    prepCard._seams.meetingNotes = {
      findNoteForTitle: vi.fn().mockResolvedValue('Last week we agreed to revisit pricing.'),
    };
    const card = await prepCard.buildPrepCard(evt(), { now: NOW, memory });
    expect(card.lastNote).toContain('revisit pricing');
  });

  it('skips meeting-notes lookup for focus-block / personal events', async () => {
    prepCard._seams.classifier = {
      classifyMeeting: vi.fn().mockResolvedValue({ primary: 'focus-block', prep: {}, research: null }),
    };
    prepCard._seams.meetingNotes = {
      findNoteForTitle: vi.fn().mockResolvedValue('should not be called'),
    };
    const card = await prepCard.buildPrepCard(evt(), { now: NOW, memory });
    expect(card.lastNote).toBeNull();
    expect(prepCard._seams.meetingNotes.findNoteForTitle).not.toHaveBeenCalled();
  });

  it('meeting-notes timeout is non-fatal -- card still returns', async () => {
    prepCard._seams.classifier = {
      classifyMeeting: vi.fn().mockResolvedValue({ primary: 'external', prep: {}, research: null }),
    };
    prepCard._seams.meetingNotes = {
      findNoteForTitle: () => new Promise(() => { /* never resolves */ }),
    };
    const card = await prepCard.buildPrepCard(evt(), { now: NOW, memory });
    expect(card).toBeTruthy();
    expect(card.lastNote).toBeNull();
  });

  it('agenda comes from classifier research bullets when available', async () => {
    prepCard._seams.classifier = {
      classifyMeeting: vi.fn().mockResolvedValue({
        primary: 'external',
        prep: {},
        research: {
          summary: 'Q4 planning session',
          bullets: ['budget caps', 'hiring freeze', 'feature prioritization'],
          sources: [],
        },
      }),
    };
    const card = await prepCard.buildPrepCard(evt(), { now: NOW, memory });
    expect(card.agenda).toEqual(expect.arrayContaining(['budget caps']));
  });

  it('agenda falls back to event description when no research bullets', async () => {
    const ev = evt({ description: 'Discuss Q2 forecast and review pricing changes.' });
    const card = await prepCard.buildPrepCard(ev, { now: NOW, memory });
    expect(card.agenda?.[0]).toContain('Q2 forecast');
  });
});

describe('Phase 7: card payload shape', () => {
  it('always returns the documented top-level fields', async () => {
    const card = await prepCard.buildPrepCard(evt(), { now: NOW, memory });
    expect(card).toMatchObject({
      type: 'prepCard',
      eventId: expect.any(String),
      title: expect.any(String),
      start: expect.any(String),
      minutesUntil: expect.any(Number),
    });
    // Optional sections may be null but must be present.
    expect('join' in card).toBe(true);
    expect('leaveEarly' in card).toBe(true);
    expect('attendees' in card).toBe(true);
    expect('prepSummary' in card).toBe(true);
    expect('lastNote' in card).toBe(true);
    expect('agenda' in card).toBe(true);
  });
});
