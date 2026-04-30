/**
 * Handoff Phrases - Unit Tests
 *
 * Under the always-on single Cap Chew voice, buildHandoffPhrase()
 * always returns null (there is no voice change to bridge). These
 * tests lock that in. If multi-voice is ever reintroduced, unwrap
 * the unreachable post-return pool lookup and bring back richer
 * tests.
 *
 * Run:  npx vitest run test/unit/handoff-phrases.test.js
 */

import { describe, it, expect } from 'vitest';

const {
  HANDOFF_PHRASES,
  NAMED_HANDOFF_TEMPLATES,
  buildHandoffPhrase,
  hasHandoff,
} = require('../../lib/naturalness/handoff-phrases');

describe('handoff-phrases', () => {
  describe('always-on single-voice mode', () => {
    it('returns null for different agents', () => {
      const phrase = buildHandoffPhrase({
        fromAgentId: 'time-agent',
        toAgentId: 'weather-agent',
        toAgent: { name: 'Weather Agent' },
      });
      expect(phrase).toBeNull();
    });

    it('returns null for same agent', () => {
      expect(
        buildHandoffPhrase({ fromAgentId: 'dj-agent', toAgentId: 'dj-agent' })
      ).toBeNull();
    });

    it('returns null when no prior agent', () => {
      expect(buildHandoffPhrase({ toAgentId: 'dj-agent' })).toBeNull();
    });

    it('hasHandoff is always false', () => {
      expect(
        hasHandoff({ fromAgentId: 'a', toAgentId: 'b', toAgent: { name: 'B' } })
      ).toBe(false);
    });
  });

  describe('preserved pools (ready for multi-voice revival)', () => {
    it('un-named pool is non-empty and phrases are short', () => {
      expect(HANDOFF_PHRASES.length).toBeGreaterThan(0);
      for (const phrase of HANDOFF_PHRASES) {
        expect(phrase.split(/\s+/).length).toBeLessThanOrEqual(6);
      }
    });

    it('named templates all contain the {name} slot', () => {
      expect(NAMED_HANDOFF_TEMPLATES.length).toBeGreaterThan(0);
      for (const tmpl of NAMED_HANDOFF_TEMPLATES) {
        expect(tmpl).toContain('{name}');
      }
    });
  });
});
