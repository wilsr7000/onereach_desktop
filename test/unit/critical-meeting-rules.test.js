/**
 * Unit tests for lib/critical-meeting-rules.js
 *
 * Covers:
 *   - Event-tag evaluator: [!], [critical], !critical markers
 *   - Agent-memory evaluator: VIP attendees, keyword triggers, free-form rules
 *   - Merge logic: OR criticality, union lead times, channel overrides
 *   - Exclusions override criticality
 *   - LLM parse of free-form ## Rules section (mocked)
 *   - reloadFromMemory() signature change detection
 *   - Seed missing sections
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../lib/log-event-queue', () => ({
  getLogQueue: () => ({ info: () => {}, warn: () => {}, error: () => {} }),
}));

const rules = require('../../lib/critical-meeting-rules');

// ────────────────────────────────────────────────────────────────────────────

/**
 * Minimal in-memory fake of AgentMemoryStore. Supports the exact surface
 * the rules engine uses (getSection, getSectionNames, parseSectionAsKeyValue,
 * updateSection, isLoaded, save).
 */
function makeFakeMemory(sections = {}) {
  const store = new Map(Object.entries(sections));
  let savedCount = 0;
  return {
    isLoaded: () => true,
    getSection: (name) => store.get(name) ?? null,
    getSectionNames: () => Array.from(store.keys()),
    updateSection: (name, content) => store.set(name, content),
    appendToSection: (name, entry) => {
      const cur = store.get(name) || '';
      store.set(name, entry + '\n' + cur);
    },
    parseSectionAsKeyValue: (name) => {
      const raw = store.get(name) || '';
      const out = {};
      for (const line of raw.split('\n')) {
        const m = line.match(/^-?\s*([^:]+):\s*(.+)$/);
        if (m) out[m[1].trim()] = m[2].trim();
      }
      return out;
    },
    save: async () => {
      savedCount++;
      return true;
    },
    _savedCount: () => savedCount,
    _store: store,
  };
}

function sampleEvent(overrides = {}) {
  return {
    id: 'evt-1',
    summary: 'Sync meeting',
    description: '',
    start: { dateTime: new Date(Date.now() + 60 * 60 * 1000).toISOString() },
    attendees: [{ email: 'alice@team.com' }, { email: 'bob@team.com' }],
    organizer: { email: 'alice@team.com' },
    ...overrides,
  };
}

// ────────────────────────────────────────────────────────────────────────────

describe('critical-meeting-rules', () => {
  beforeEach(() => {
    rules._clearRuleSet();
    rules._resetInjections();
  });

  // ──────────────────────────────────────────────────────────────────────
  // Event-tag evaluator
  // ──────────────────────────────────────────────────────────────────────

  describe('event tags', () => {
    it('flags events with a [!] title prefix as critical', async () => {
      const verdict = await rules.evaluate(sampleEvent({ summary: '[!] Board call' }));
      expect(verdict.critical).toBe(true);
      expect(verdict.reasons.join(' ')).toMatch(/tagged as critical/i);
    });

    it('flags events with a [critical] title prefix', async () => {
      const verdict = await rules.evaluate(sampleEvent({ summary: '[critical] Retro' }));
      expect(verdict.critical).toBe(true);
    });

    it('flags events containing !critical anywhere', async () => {
      const verdict = await rules.evaluate(
        sampleEvent({ summary: 'Retro', description: 'Please treat as !critical -- investor joining.' })
      );
      expect(verdict.critical).toBe(true);
    });

    it('does not flag normal events', async () => {
      const verdict = await rules.evaluate(sampleEvent());
      expect(verdict.critical).toBe(false);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Memory: VIP attendees
  // ──────────────────────────────────────────────────────────────────────

  describe('VIP attendees', () => {
    it('flags an event when a VIP email is on the invite', async () => {
      const memory = makeFakeMemory({
        [rules.SECTION_NAMES.vipAttendees]: '- ceo@company.com\n- board@company.com',
      });
      await rules.reloadFromMemory(memory, { forceReparse: true });
      const verdict = await rules.evaluate(
        sampleEvent({
          attendees: [{ email: 'me@team.com' }, { email: 'ceo@company.com' }],
        })
      );
      expect(verdict.critical).toBe(true);
      expect(verdict.reasons.some((r) => r.includes('ceo@company.com'))).toBe(true);
    });

    it('flags an event when the ORGANIZER is a VIP', async () => {
      const memory = makeFakeMemory({
        [rules.SECTION_NAMES.vipAttendees]: '- ceo@company.com',
      });
      await rules.reloadFromMemory(memory, { forceReparse: true });
      const verdict = await rules.evaluate(
        sampleEvent({ organizer: { email: 'ceo@company.com' }, attendees: [] })
      );
      expect(verdict.critical).toBe(true);
    });

    it('is case-insensitive', async () => {
      const memory = makeFakeMemory({
        [rules.SECTION_NAMES.vipAttendees]: '- CEO@Company.COM',
      });
      await rules.reloadFromMemory(memory, { forceReparse: true });
      const verdict = await rules.evaluate(
        sampleEvent({ attendees: [{ email: 'ceo@company.com' }] })
      );
      expect(verdict.critical).toBe(true);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Memory: keyword triggers
  // ──────────────────────────────────────────────────────────────────────

  describe('keyword triggers', () => {
    it('flags events whose title contains a trigger', async () => {
      const memory = makeFakeMemory({
        [rules.SECTION_NAMES.keywords]: '- board\n- investor\n- quarterly review',
      });
      await rules.reloadFromMemory(memory, { forceReparse: true });
      const verdict = await rules.evaluate(
        sampleEvent({ summary: 'Quarterly Review with investors' })
      );
      expect(verdict.critical).toBe(true);
      expect(verdict.reasons.some((r) => /"quarterly review"/.test(r))).toBe(true);
    });

    it('matches description too', async () => {
      const memory = makeFakeMemory({
        [rules.SECTION_NAMES.keywords]: '- interview',
      });
      await rules.reloadFromMemory(memory, { forceReparse: true });
      const verdict = await rules.evaluate(
        sampleEvent({ summary: 'Candidate chat', description: 'First-round interview with Priya.' })
      );
      expect(verdict.critical).toBe(true);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Memory: exclusions
  // ──────────────────────────────────────────────────────────────────────

  describe('exclusions', () => {
    it('overrides a keyword match', async () => {
      const memory = makeFakeMemory({
        [rules.SECTION_NAMES.keywords]: '- sync',
        [rules.SECTION_NAMES.exclusions]: '- daily standup',
      });
      await rules.reloadFromMemory(memory, { forceReparse: true });
      const verdict = await rules.evaluate(
        sampleEvent({ summary: 'Daily Standup (team sync)' })
      );
      expect(verdict.critical).toBe(false);
      expect(verdict.reasons.join(' ')).toMatch(/exclusion/i);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Memory: free-form rules (LLM-parsed)
  // ──────────────────────────────────────────────────────────────────────

  describe('free-form rules', () => {
    it('parses free-form rules via ai-service.json once, then evaluates deterministically', async () => {
      const jsonSpy = vi.fn().mockResolvedValue({
        rules: [
          {
            description: 'Any event organized by Jennifer is always critical.',
            matchKind: 'organizer_email',
            pattern: 'jennifer@company.com',
            negate: false,
            leadTimesMin: [10],
            channels: ['hud', 'voice'],
          },
          {
            description: 'Any event with more than 20 attendees is critical.',
            matchKind: 'attendee_count_gt',
            pattern: '20',
          },
        ],
      });
      rules._setAiService({ json: jsonSpy });
      const memory = makeFakeMemory({
        [rules.SECTION_NAMES.rules]:
          '- Any event organized by Jennifer is always critical.\n- Any event with more than 20 attendees is critical.',
      });
      await rules.reloadFromMemory(memory, { forceReparse: true });
      expect(jsonSpy).toHaveBeenCalledOnce();

      const verdict = await rules.evaluate(
        sampleEvent({ organizer: { email: 'jennifer@company.com' } })
      );
      expect(verdict.critical).toBe(true);
      // Rule-supplied lead time overrode the default list
      expect(verdict.leadTimesMin).toContain(10);
    });

    it('does not re-run the LLM when the ## Rules text is unchanged', async () => {
      const jsonSpy = vi.fn().mockResolvedValue({ rules: [] });
      rules._setAiService({ json: jsonSpy });
      const memory = makeFakeMemory({
        [rules.SECTION_NAMES.rules]: '- Something.',
      });
      await rules.reloadFromMemory(memory);
      await rules.reloadFromMemory(memory); // second call, no change
      expect(jsonSpy).toHaveBeenCalledTimes(1);
    });

    it('does re-run the LLM when the ## Rules text changes', async () => {
      const jsonSpy = vi.fn().mockResolvedValue({ rules: [] });
      rules._setAiService({ json: jsonSpy });
      const memory = makeFakeMemory({
        [rules.SECTION_NAMES.rules]: '- Rule one.',
      });
      await rules.reloadFromMemory(memory);
      memory.updateSection(rules.SECTION_NAMES.rules, '- Rule one.\n- Rule two (new).');
      await rules.reloadFromMemory(memory);
      expect(jsonSpy).toHaveBeenCalledTimes(2);
    });

    it('negated rules do NOT flag the event', async () => {
      rules._setAiService({
        json: vi.fn().mockResolvedValue({
          rules: [
            {
              description: 'Never alarm for events titled "Focus Time".',
              matchKind: 'keyword',
              pattern: 'focus time',
              negate: true,
            },
          ],
        }),
      });
      const memory = makeFakeMemory({
        [rules.SECTION_NAMES.rules]: '- Never alarm for events titled "Focus Time".',
      });
      await rules.reloadFromMemory(memory, { forceReparse: true });
      const verdict = await rules.evaluate(sampleEvent({ summary: 'Focus Time' }));
      expect(verdict.critical).toBe(false);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Lead times + channels
  // ──────────────────────────────────────────────────────────────────────

  describe('lead times and channels', () => {
    it('reads lead times from the section', async () => {
      const memory = makeFakeMemory({
        [rules.SECTION_NAMES.vipAttendees]: '- ceo@company.com',
        [rules.SECTION_NAMES.leadTimes]: '- 30, 10, 2',
      });
      await rules.reloadFromMemory(memory, { forceReparse: true });
      const verdict = await rules.evaluate(
        sampleEvent({ attendees: [{ email: 'ceo@company.com' }] })
      );
      expect(verdict.leadTimesMin).toEqual([30, 10, 2]);
    });

    it('uses defaults when the lead-times section is missing', async () => {
      const memory = makeFakeMemory({
        [rules.SECTION_NAMES.vipAttendees]: '- ceo@company.com',
      });
      await rules.reloadFromMemory(memory, { forceReparse: true });
      const verdict = await rules.evaluate(
        sampleEvent({ attendees: [{ email: 'ceo@company.com' }] })
      );
      expect(verdict.leadTimesMin).toEqual(rules.DEFAULT_LEAD_TIMES_MIN);
    });

    it('exposes channelsForLead mapping', async () => {
      const memory = makeFakeMemory({
        [rules.SECTION_NAMES.vipAttendees]: '- ceo@company.com',
        [rules.SECTION_NAMES.channels]: '- 15: hud\n- 5: hud, voice\n- 1: hud, voice, os, sound',
      });
      await rules.reloadFromMemory(memory, { forceReparse: true });
      const verdict = await rules.evaluate(
        sampleEvent({ attendees: [{ email: 'ceo@company.com' }] })
      );
      expect(verdict.channelsForLead(15)).toEqual({ hud: true, voice: false, os: false, sound: false });
      expect(verdict.channelsForLead(1)).toEqual({ hud: true, voice: true, os: true, sound: true });
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Merge logic
  // ──────────────────────────────────────────────────────────────────────

  describe('merge logic', () => {
    it('aggregates reasons from every matching source', async () => {
      const memory = makeFakeMemory({
        [rules.SECTION_NAMES.vipAttendees]: '- ceo@company.com',
        [rules.SECTION_NAMES.keywords]: '- board',
      });
      await rules.reloadFromMemory(memory, { forceReparse: true });
      const verdict = await rules.evaluate(
        sampleEvent({
          summary: '[!] Board meeting with CEO',
          attendees: [{ email: 'ceo@company.com' }],
        })
      );
      expect(verdict.critical).toBe(true);
      expect(verdict.reasons.length).toBeGreaterThanOrEqual(3); // tag + VIP + keyword
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Seeding
  // ──────────────────────────────────────────────────────────────────────

  describe('seedMemorySections', () => {
    it('adds every missing section on first boot', async () => {
      const memory = makeFakeMemory({});
      const changed = await rules.seedMemorySections(memory);
      expect(changed).toBe(true);
      const names = memory.getSectionNames();
      for (const name of Object.values(rules.SECTION_NAMES)) {
        expect(names).toContain(name);
      }
      expect(memory._savedCount()).toBe(1);
    });

    it('preserves user-edited sections', async () => {
      const memory = makeFakeMemory({
        [rules.SECTION_NAMES.vipAttendees]: '- ceo@myco.com\n- investor@vc.com',
      });
      await rules.seedMemorySections(memory);
      const kept = memory.getSection(rules.SECTION_NAMES.vipAttendees);
      expect(kept).toContain('ceo@myco.com');
      expect(kept).toContain('investor@vc.com');
    });
  });
});
