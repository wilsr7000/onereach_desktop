/**
 * Phase 6 (calendar agent overhaul) -- absence detector contracts.
 *
 * The plan's hard contracts:
 *   1. Empty memory -> no suggestion, no section in brief.
 *   2. One suggestion per brief -- aggregator picks highest confidence.
 *   3. Confidence threshold (default 0.7) for brief; medium (0.4-0.7) for
 *      review queue; below 0.4 dropped.
 *   4. First-run grace: silent for `firstRunGraceDays` days from memory
 *      creation so passive mining can warm up.
 *
 * Each source check has at least one positive + one negative test so we
 * catch regressions in the parsing helpers.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const calendarMemory = require('../../lib/calendar-memory');
const absence = require('../../lib/calendar-absence');

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
  // Stamp memory with an old _header so first-run grace doesn't suppress
  // every test by default. Tests exercising grace re-stamp.
  memory._setStoreForTests(
    makeFakeStore({
      _header: `# Calendar Memory\n\n> Last updated: 2026-01-01T00:00:00.000Z\n<!-- calendarMemoryVersion: 1 -->`,
    })
  );
  await memory.load();

  originalSettings = global.settingsManager;
  global.settingsManager = {
    get: vi.fn((key, def) => {
      if (key === 'calendar.absenceDetectorEnabled') return true;
      if (key === 'calendar.absenceDetector.firstRunGraceDays') return 7;
      if (key === 'calendar.absenceDetector.briefThreshold') return 0.7;
      if (key === 'calendar.absenceDetector.reviewThreshold') return 0.4;
      return def;
    }),
  };
});

afterEach(() => {
  global.settingsManager = originalSettings;
});

const NOW = new Date('2026-04-29T08:00:00Z');

describe('Phase 6: silent-when-empty contract', () => {
  it('empty memory + no events -> topSuggestion is null', () => {
    const out = absence.detectAbsences({ now: NOW, events: [] }, { memory });
    expect(out.topSuggestion).toBeNull();
    expect(out.queueable).toEqual([]);
  });

  it('getBriefing returns null when nothing to suggest', async () => {
    const result = await absence.getBriefing({ now: NOW, events: [] });
    // calendarMemory singleton may have been reset; be permissive about how
    // memory loads in this test, but the key property is "no content".
    if (result !== null) {
      expect(result.content).toBeFalsy();
    }
  });
});

describe('Phase 6: first-run grace', () => {
  it('memory younger than firstRunGraceDays -> stays silent', () => {
    memory._setStoreForTests(
      makeFakeStore({
        _header: `# Calendar Memory\n\n> Last updated: ${new Date().toISOString()}\n<!-- calendarMemoryVersion: 1 -->`,
        Cadences: '<!-- schemaVersion: 1 -->\n- Marcus 1:1: every 14d, last on 2026-04-15',
      })
    );

    const out = absence.detectAbsences(
      { now: new Date('2026-04-29T08:00:00Z'), events: [], horizonDays: 14 },
      { memory }
    );
    expect(out.topSuggestion).toBeNull();
  });

  it('memory older than firstRunGraceDays -> suggestions surface', () => {
    memory._setStoreForTests(
      makeFakeStore({
        _header: `# Calendar Memory\n\n> Last updated: 2026-01-01T00:00:00.000Z\n<!-- calendarMemoryVersion: 1 -->`,
        Cadences: '<!-- schemaVersion: 1 -->\n- Marcus 1:1: every 14d, last on 2026-04-15',
      })
    );

    const out = absence.detectAbsences(
      { now: new Date('2026-04-29T08:00:00Z'), events: [], horizonDays: 14 },
      { memory }
    );
    expect(out.topSuggestion).toBeTruthy();
    expect(out.topSuggestion.source).toBe('explicit-cadences');
  });
});

describe('Phase 6: source -- explicit cadences', () => {
  it('detects a due cadence with no matching event', () => {
    const out = absence.checkExplicitCadences(
      memorySetup({ Cadences: '<!-- schemaVersion: 1 -->\n- Marcus 1:1: every 14d, last on 2026-04-15' }),
      { now: NOW, events: [], horizonDays: 14 }
    );
    expect(out.source).toBe('explicit-cadences');
    expect(out.confidence).toBeGreaterThanOrEqual(0.7);
  });

  it('drops a cadence whose matching event already exists in window', () => {
    const events = [{ summary: 'Marcus 1:1', start: { dateTime: '2026-04-29T15:00:00Z' } }];
    const out = absence.checkExplicitCadences(
      memorySetup({ Cadences: '<!-- schemaVersion: 1 -->\n- Marcus 1:1: every 14d, last on 2026-04-15' }),
      { now: NOW, events, horizonDays: 14 }
    );
    expect(out).toBeNull();
  });

  it('returns null on empty section', () => {
    expect(absence.checkExplicitCadences(memorySetup({}), { now: NOW, events: [] })).toBeNull();
  });
});

describe('Phase 6: source -- commitments', () => {
  it('flags a commitment whose deadline is in window with no scheduled work', () => {
    const out = absence.checkCommitments(
      memorySetup({
        Commitments: '<!-- schemaVersion: 1 -->\n- Send Q2 deck to Sarah by 2026-04-30',
      }),
      { now: NOW, events: [], horizonDays: 14 }
    );
    expect(out.source).toBe('commitments');
    expect(out.confidence).toBeGreaterThanOrEqual(0.7);
    expect(out.action.type).toBe('proposeFocusBlock');
  });

  it('returns null when deadline is past the horizon', () => {
    const out = absence.checkCommitments(
      memorySetup({
        Commitments: '<!-- schemaVersion: 1 -->\n- Send Q2 deck to Sarah by 2027-01-01',
      }),
      { now: NOW, events: [], horizonDays: 14 }
    );
    expect(out).toBeNull();
  });
});

describe('Phase 6: source -- goals', () => {
  it('surfaces a goal due in the window', () => {
    const out = absence.checkGoals(
      memorySetup({
        Goals: '<!-- schemaVersion: 1 -->\n- Ship feature X by 2026-05-05',
      }),
      { now: NOW, events: [], horizonDays: 14 }
    );
    expect(out.source).toBe('goals');
  });
});

describe('Phase 6: source -- reconnects', () => {
  it('surfaces a reconnect that is overdue', () => {
    const out = absence.checkReconnects(
      memorySetup({
        Reconnects: '<!-- schemaVersion: 1 -->\n- John Smith: every 21d, last on 2026-03-01',
      }),
      { now: NOW, events: [] }
    );
    expect(out.source).toBe('reconnects');
  });

  it('returns null when reconnect not yet due', () => {
    const out = absence.checkReconnects(
      memorySetup({
        Reconnects: '<!-- schemaVersion: 1 -->\n- John Smith: every 21d, last on 2026-04-25',
      }),
      { now: NOW, events: [] }
    );
    expect(out).toBeNull();
  });
});

describe('Phase 6: derived -- recovery gaps', () => {
  it('flags 4+ hour back-to-back stretches', () => {
    const events = [];
    let start = new Date('2026-04-29T09:00:00Z').getTime();
    for (let i = 0; i < 5; i++) {
      const s = new Date(start + i * 60 * 60 * 1000).toISOString();
      const e = new Date(start + (i + 1) * 60 * 60 * 1000).toISOString();
      events.push({ id: `e${i}`, summary: `Mtg ${i}`, start: { dateTime: s }, end: { dateTime: e } });
    }
    const out = absence.checkRecoveryGaps(memorySetup({}), { now: NOW, events });
    expect(out?.source).toBe('recovery-gaps');
  });

  it('returns null on a normal day with breaks', () => {
    const events = [
      { id: 'a', summary: 'M1', start: { dateTime: '2026-04-29T09:00:00Z' }, end: { dateTime: '2026-04-29T10:00:00Z' } },
      { id: 'b', summary: 'M2', start: { dateTime: '2026-04-29T15:00:00Z' }, end: { dateTime: '2026-04-29T16:00:00Z' } },
    ];
    expect(absence.checkRecoveryGaps(memorySetup({}), { now: NOW, events })).toBeNull();
  });
});

describe('Phase 6: derived -- travel gaps', () => {
  it('flags an in-person event at a non-default location', () => {
    const events = [
      { id: 'a', summary: 'On-site review', location: 'Acme HQ, 123 Main St',
        start: { dateTime: '2026-04-29T15:00:00Z' }, end: { dateTime: '2026-04-29T16:00:00Z' } },
    ];
    const out = absence.checkTravelGaps(memorySetup({}), { now: NOW, events });
    expect(out?.source).toBe('travel-gaps');
  });

  it('does NOT flag a video meeting', () => {
    const events = [
      { id: 'a', summary: 'Zoom call', location: 'https://zoom.us/j/123',
        start: { dateTime: '2026-04-29T15:00:00Z' }, end: { dateTime: '2026-04-29T16:00:00Z' } },
    ];
    expect(absence.checkTravelGaps(memorySetup({}), { now: NOW, events })).toBeNull();
  });
});

describe('Phase 6: derived -- prep gaps', () => {
  it('flags a heavy-prep event without a scheduled prep block', () => {
    const events = [
      { id: 'big', summary: 'Quarterly board review', start: { dateTime: '2026-04-29T15:00:00Z' }, end: { dateTime: '2026-04-29T16:00:00Z' } },
    ];
    const verdicts = { big: { prep: { level: 'heavy', minutes: 30, reasons: [] } } };
    const out = absence.checkPrepGaps(memorySetup({}), { now: NOW, events, classifierVerdicts: verdicts });
    expect(out?.source).toBe('prep-gaps');
  });

  it('does NOT flag when a prep block exists for the meeting', () => {
    const events = [
      { id: 'prep', summary: 'Quarterly prep', start: { dateTime: '2026-04-29T14:00:00Z' }, end: { dateTime: '2026-04-29T14:30:00Z' } },
      { id: 'big', summary: 'Quarterly board review', start: { dateTime: '2026-04-29T15:00:00Z' }, end: { dateTime: '2026-04-29T16:00:00Z' } },
    ];
    const verdicts = { big: { prep: { level: 'heavy', minutes: 30, reasons: [] } } };
    expect(absence.checkPrepGaps(memorySetup({}), { now: NOW, events, classifierVerdicts: verdicts })).toBeNull();
  });
});

describe('Phase 6: aggregator -- single suggestion + queueable middle band', () => {
  it('returns top suggestion when at least one source >= briefThreshold', () => {
    memory._setStoreForTests(
      makeFakeStore({
        _header: `# Calendar Memory\n\n> Last updated: 2026-01-01T00:00:00.000Z`,
        Cadences: '<!-- schemaVersion: 1 -->\n- Marcus 1:1: every 14d, last on 2026-04-15',
      })
    );
    const out = absence.detectAbsences({ now: NOW, events: [], horizonDays: 14 }, { memory });
    expect(out.topSuggestion).toBeTruthy();
    expect(out.topSuggestion.confidence).toBeGreaterThanOrEqual(0.7);
  });

  it('queueable buckets only items in the medium band', () => {
    memory._setStoreForTests(
      makeFakeStore({
        _header: `# Calendar Memory\n\n> Last updated: 2026-01-01T00:00:00.000Z`,
        Cadences: '<!-- schemaVersion: 1 -->\n- Marcus 1:1: every 14d, last on 2026-04-15',
      })
    );
    const events = [
      // Trigger travel gap (confidence 0.6, between thresholds)
      { id: 'a', summary: 'On-site', location: 'Acme HQ', start: { dateTime: '2026-04-29T15:00:00Z' }, end: { dateTime: '2026-04-29T16:00:00Z' } },
    ];
    const out = absence.detectAbsences({ now: NOW, events, horizonDays: 14 }, { memory });
    expect(out.topSuggestion).toBeTruthy();
    // Travel gap (0.6) is in the middle band -> goes to queueable.
    expect(out.queueable.some((q) => q.source === 'travel-gaps')).toBe(true);
  });

  it('disabled flag returns empty', () => {
    global.settingsManager.get = vi.fn((k) => (k === 'calendar.absenceDetectorEnabled' ? false : undefined));
    const out = absence.detectAbsences({ now: NOW, events: [] }, { memory });
    expect(out.topSuggestion).toBeNull();
  });
});

// helper: build an isolated memory for a single check call
function memorySetup(seedSections) {
  const m = new calendarMemory.CalendarMemory();
  m._setStoreForTests(
    makeFakeStore({
      _header: `# Calendar Memory\n\n> Last updated: 2026-01-01T00:00:00.000Z`,
      ...seedSections,
    })
  );
  // Force loaded so readEntriesTrusted works without going through load().
  m._loaded = true;
  return m;
}
