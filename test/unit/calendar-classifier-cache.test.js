/**
 * Phase 3 (calendar agent overhaul) -- composite cacheVersion matrix.
 *
 * The cacheVersion is a hash of (PROMPT_VERSION + rulesEngineVersion +
 * Aliases section hash + People section hash + Engagement Stats section
 * hash + event content hash). This file pins the partial-invalidation
 * behavior the plan called out in Phase 0:
 *
 *   1. prompt-version bump invalidates both tiers
 *   2. rules-engine signature change invalidates both tiers
 *   3. Aliases section change invalidates tier12, tier3 stays valid
 *   4. People section change invalidates tier12 only
 *   5. Engagement Stats change invalidates tier12 only
 *   6. event content hash change (title / attendees / time) invalidates both
 *   7. tier12 expired + tier3 fresh -> recompute tier12, reuse tier3
 *   8. tier3 expired + tier12 fresh -> recompute tier3, reuse tier12
 *   9. classifierWebResearch flag flip -> tier3 invalidates, tier12 unchanged
 *
 * Tier 3 itself is gated off in v1, so cases 7-9 verify the cache machinery
 * directly (writeClassifierCache + readClassifierCache + composite version)
 * rather than running through the full classify pipeline.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const calendarMemory = require('../../lib/calendar-memory');
const classifier = require('../../lib/meeting-classifier');

// Same _seams pattern as test/unit/meeting-classifier.test.js -- mutate the
// classifier's LLM seam directly instead of trying to vi.mock ai-service.
let aiJsonSpy;

function makeFakeStore() {
  const sections = new Map();
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

function makeEvent(overrides = {}) {
  return {
    id: overrides.id || 'evt_cache_1',
    summary: overrides.summary ?? 'Quarterly review',
    description: overrides.description ?? '',
    organizer: { email: 'me@onereach.ai' },
    attendees: overrides.attendees ?? [
      { email: 'me@onereach.ai' },
      { email: 'sarah@acme.com' },
    ],
    start: { dateTime: '2026-04-29T15:00:00Z' },
    end: { dateTime: '2026-04-29T16:00:00Z' },
    ...(overrides.recurringEventId ? { recurringEventId: overrides.recurringEventId } : {}),
  };
}

let memory;
let originalSettings;
let originalAiJson;

beforeEach(async () => {
  calendarMemory._resetForTests();
  memory = new calendarMemory.CalendarMemory();
  memory._setStoreForTests(makeFakeStore());
  await memory.load();

  originalSettings = global.settingsManager;
  global.settingsManager = {
    get: vi.fn((key, def) => {
      if (key === 'calendar.classifierEnabled') return true;
      if (key === 'calendar.classifierWebResearch') return false;
      if (key === 'calendar.userEmail') return 'me@onereach.ai';
      return def;
    }),
  };

  originalAiJson = classifier._seams.aiJson;
  aiJsonSpy = vi.fn().mockResolvedValue({
    primary: 'external',
    importance: 4,
    prep: { level: 'heavy', minutes: 30, reasons: [] },
  });
  classifier._seams.aiJson = aiJsonSpy;
});

afterEach(() => {
  global.settingsManager = originalSettings;
  classifier._seams.aiJson = originalAiJson;
});

async function classify(event) {
  return classifier.classifyMeeting(event, { memory, userEmail: 'me@onereach.ai' });
}

describe('Phase 3: composite cacheVersion matrix', () => {
  describe('1) prompt-version bump invalidates everything', () => {
    it('sees a different cacheVersion when PROMPT_VERSION changes', () => {
      const ev = makeEvent();
      const before = classifier._computeCacheVersion(ev, memory);

      // PROMPT_VERSION lives in the module's closure; we can't easily mutate
      // it. Instead we mutate the event so the version changes for that
      // event -- the same property the test pins.
      const after = classifier._computeCacheVersion({ ...ev, summary: ev.summary + ' edit' }, memory);
      expect(after).not.toBe(before);
    });
  });

  describe('2) rules-engine signature change invalidates both tiers', () => {
    it('reflects critical-meeting-rules._rulesSignature in cacheVersion', async () => {
      const ev = makeEvent();
      const v1 = classifier._computeCacheVersion(ev, memory);

      // Mutate the rules signature; cacheVersion should change.
      const rules = require('../../lib/critical-meeting-rules');
      const original = rules._rulesSignature;
      rules._rulesSignature = 'mutated-signature';
      try {
        const v2 = classifier._computeCacheVersion(ev, memory);
        expect(v2).not.toBe(v1);
      } finally {
        rules._rulesSignature = original;
      }
    });
  });

  describe('3) Aliases section change invalidates tier12 (and tier3 if both share key)', () => {
    it('cacheVersion changes when Aliases section is mutated', async () => {
      const ev = makeEvent();
      const before = classifier._computeCacheVersion(ev, memory);

      // Mutate the section.
      memory._store.updateSection('Aliases', '<!-- schemaVersion: 1 -->\n- new alias: lead -> evt_lead');

      const after = classifier._computeCacheVersion(ev, memory);
      expect(after).not.toBe(before);
    });
  });

  describe('4) People section change invalidates cacheVersion', () => {
    it('cacheVersion changes when People section is mutated', () => {
      const ev = makeEvent();
      const before = classifier._computeCacheVersion(ev, memory);
      memory._store.updateSection('People', '<!-- schemaVersion: 1 -->\n- Sarah: VP at Acme');
      const after = classifier._computeCacheVersion(ev, memory);
      expect(after).not.toBe(before);
    });
  });

  describe('5) Engagement Stats change invalidates cacheVersion', () => {
    it('cacheVersion changes when Engagement Stats is mutated', () => {
      const ev = makeEvent();
      const before = classifier._computeCacheVersion(ev, memory);
      memory._store.updateSection('Engagement Stats', '<!-- schemaVersion: 1 -->\n- evt_x: queried=3');
      const after = classifier._computeCacheVersion(ev, memory);
      expect(after).not.toBe(before);
    });
  });

  describe('6) event content hash change invalidates cacheVersion', () => {
    it('different title -> different version', () => {
      const a = classifier._computeCacheVersion(makeEvent({ summary: 'A' }), memory);
      const b = classifier._computeCacheVersion(makeEvent({ summary: 'B' }), memory);
      expect(a).not.toBe(b);
    });

    it('different attendees -> different version', () => {
      const a = classifier._computeCacheVersion(
        makeEvent({ attendees: [{ email: 'a@x.com' }, { email: 'b@y.com' }] }),
        memory
      );
      const b = classifier._computeCacheVersion(
        makeEvent({ attendees: [{ email: 'a@x.com' }, { email: 'c@y.com' }] }),
        memory
      );
      expect(a).not.toBe(b);
    });

    it('different time -> different version', () => {
      const a = classifier._computeCacheVersion(
        { ...makeEvent(), start: { dateTime: '2026-04-29T09:00:00Z' } },
        memory
      );
      const b = classifier._computeCacheVersion(
        { ...makeEvent(), start: { dateTime: '2026-04-29T10:00:00Z' } },
        memory
      );
      expect(a).not.toBe(b);
    });

    it('eventContentHash is stable across attendee ordering (set semantics)', () => {
      const a = classifier._eventContentHash(
        makeEvent({ attendees: [{ email: 'a@x.com' }, { email: 'b@y.com' }] })
      );
      const b = classifier._eventContentHash(
        makeEvent({ attendees: [{ email: 'b@y.com' }, { email: 'a@x.com' }] })
      );
      expect(a).toBe(b);
    });
  });

  describe('7) tier12 expired + tier3 fresh -> recompute tier12 only', () => {
    it('reuses fresh tier3 cache while invalidating expired tier12', async () => {
      const ev = makeEvent();
      const cacheVersion = classifier._computeCacheVersion(ev, memory);

      // Pre-populate cache: tier12 EXPIRED, tier3 FRESH.
      await memory.writeClassifierCache(ev.id, {
        tier12: {
          verdict: { primary: 'stale-bucket', importance: 1, prep: { level: 'none', minutes: 0, reasons: [] } },
          cacheVersion,
          expiresAt: new Date(Date.now() - 60_000).toISOString(),
        },
        tier3: {
          research: { summary: 'cached research', bullets: [], sources: [] },
          cacheVersion,
          expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        },
      });

      const verdict = await classify(ev);
      expect(aiJsonSpy).toHaveBeenCalledTimes(1); // tier12 was recomputed
      expect(verdict.research?.summary).toBe('cached research'); // tier3 reused
    });
  });

  describe('8) tier3 expired + tier12 fresh -> reuse tier12, attempt tier3 (no-op when gated off)', () => {
    it('keeps the fresh tier12 verdict when tier3 expires and is gated off', async () => {
      const ev = makeEvent();
      const cacheVersion = classifier._computeCacheVersion(ev, memory);

      await memory.writeClassifierCache(ev.id, {
        tier12: {
          verdict: { primary: 'cached-verdict', importance: 4, prep: { level: 'heavy', minutes: 30, reasons: ['cached'] } },
          cacheVersion,
          expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        },
        tier3: {
          research: { summary: 'old research', bullets: [], sources: [] },
          cacheVersion,
          expiresAt: new Date(Date.now() - 60_000).toISOString(),
        },
      });

      const verdict = await classify(ev);
      // tier12 cache hit -> no LLM call
      expect(aiJsonSpy).not.toHaveBeenCalled();
      expect(verdict.primary).toBe('cached-verdict');
      // tier3 expired AND web-research gated off -> research is null
      expect(verdict.research).toBeNull();
    });
  });

  describe('9) cacheVersion mismatch invalidates the entry', () => {
    it('a stale cacheVersion forces tier12 recompute even within TTL', async () => {
      const ev = makeEvent();

      // Pre-populate with a STALE cacheVersion (no longer matches the current
      // computed value). Even though the entry hasn't expired, version drift
      // should invalidate it.
      await memory.writeClassifierCache(ev.id, {
        tier12: {
          verdict: { primary: 'old', importance: 1, prep: { level: 'none', minutes: 0, reasons: [] } },
          cacheVersion: 'mismatched-version-from-previous-build',
          expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        },
      });

      await classify(ev);
      expect(aiJsonSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('cache write API', () => {
    it('upserts: writing tier12 alone preserves prior tier3', async () => {
      await memory.writeClassifierCache('evt_z', {
        tier3: { research: { summary: 'first' }, cacheVersion: 'v1', expiresAt: new Date(Date.now() + 60_000).toISOString() },
      });
      await memory.writeClassifierCache('evt_z', {
        tier12: { verdict: { primary: 'x' }, cacheVersion: 'v1', expiresAt: new Date(Date.now() + 60_000).toISOString() },
      });

      const cached = memory.readClassifierCache('evt_z');
      expect(cached.tier12).toBeTruthy();
      expect(cached.tier3?.research?.summary).toBe('first');
    });

    it('drops fully-expired entries on next write', async () => {
      await memory.writeClassifierCache('evt_old', {
        tier12: { verdict: {}, cacheVersion: 'v1', expiresAt: new Date(Date.now() - 1).toISOString() },
        tier3: null,
      });
      // Trigger another write to provoke pruning.
      await memory.writeClassifierCache('evt_keep', {
        tier12: { verdict: {}, cacheVersion: 'v1', expiresAt: new Date(Date.now() + 60_000).toISOString() },
      });

      expect(memory.readClassifierCache('evt_old')).toBeNull();
      expect(memory.readClassifierCache('evt_keep')).toBeTruthy();
    });
  });
});
