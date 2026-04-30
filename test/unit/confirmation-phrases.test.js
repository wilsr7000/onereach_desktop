/**
 * Confirmation Phrases - Unit Tests
 *
 * Verifies ack selection, confirmation template branching by stakes,
 * and the unified phraseForDecision entry point.
 *
 * Run:  npx vitest run test/unit/confirmation-phrases.test.js
 */

import { describe, it, expect } from 'vitest';

const {
  ACK_POOLS,
  pickAckPhrase,
  buildConfirmationPhrase,
  phraseForDecision,
} = require('../../lib/naturalness/confirmation-phrases');

const { DECISIONS } = require('../../lib/naturalness/confirmation-policy');
const { STAKES } = require('../../lib/naturalness/stakes-classifier');

describe('pickAckPhrase', () => {
  it('defaults to the low-stakes pool', () => {
    const phrase = pickAckPhrase({ rng: () => 0 });
    expect(ACK_POOLS.low).toContain(phrase);
  });

  it('uses the medium pool when stakes=medium', () => {
    const phrase = pickAckPhrase({ stakes: STAKES.MEDIUM, rng: () => 0 });
    expect(ACK_POOLS.medium).toContain(phrase);
  });

  it('is deterministic when rng is provided', () => {
    const seqRng = mkSeqRng([0, 0.5, 0.99]);
    const a = pickAckPhrase({ rng: seqRng });
    const b = pickAckPhrase({ rng: seqRng });
    const c = pickAckPhrase({ rng: seqRng });
    expect(a).toBe(ACK_POOLS.low[0]);
    expect(b).toBe(ACK_POOLS.low[Math.floor(0.5 * ACK_POOLS.low.length)]);
    expect(c).toBe(ACK_POOLS.low[ACK_POOLS.low.length - 1]);
  });

  it('every ack is short (<= 4 words)', () => {
    for (const pool of Object.values(ACK_POOLS)) {
      for (const phrase of pool) {
        expect(phrase.split(/\s+/).length).toBeLessThanOrEqual(5);
      }
    }
  });

  it('falls back to low pool for unknown stakes', () => {
    const phrase = pickAckPhrase({ stakes: 'galactic', rng: () => 0 });
    expect(ACK_POOLS.low).toContain(phrase);
  });
});

describe('buildConfirmationPhrase', () => {
  describe('low stakes', () => {
    it('uses the low-intent template when policy reason mentions intent', () => {
      const phrase = buildConfirmationPhrase({
        policy: { decision: DECISIONS.CONFIRM, reason: 'action with low intent confidence (0.4)' },
        intent: 'set the timer to five minutes',
        stakes: STAKES.LOW,
      });
      expect(phrase).toMatch(/^I think you want to /);
      expect(phrase).toMatch(/set the timer to five minutes/);
      expect(phrase.endsWith('?')).toBe(true);
    });

    it('uses the low-winner template when policy reason mentions winner', () => {
      const phrase = buildConfirmationPhrase({
        policy: { decision: DECISIONS.CONFIRM, reason: 'action with low winner confidence (0.45)' },
        intent: 'play some jazz',
        planSummary: 'search for jazz music and start playback',
        stakes: STAKES.LOW,
      });
      expect(phrase).toContain('search for jazz music and start playback');
      expect(phrase).toMatch(/\?$/);
    });

    it('falls back to intent template when planSummary is missing', () => {
      const phrase = buildConfirmationPhrase({
        policy: { decision: DECISIONS.CONFIRM, reason: 'action with low winner confidence' },
        intent: 'do the thing',
      });
      expect(phrase).toContain('do the thing');
    });
  });

  describe('medium stakes', () => {
    it('uses the medium template regardless of reason', () => {
      const phrase = buildConfirmationPhrase({
        policy: { decision: DECISIONS.CONFIRM, reason: 'medium-stakes action' },
        intent: 'schedule a meeting tomorrow at 3',
        stakes: STAKES.MEDIUM,
      });
      expect(phrase).toBe('Want me to schedule a meeting tomorrow at 3?');
    });
  });

  describe('high stakes', () => {
    it('uses destructive template for delete-style content', () => {
      const phrase = buildConfirmationPhrase({
        policy: { decision: DECISIONS.CONFIRM, reason: 'stakes=high always requires confirmation' },
        intent: 'delete all my emails',
        content: 'delete all my emails',
        stakes: STAKES.HIGH,
      });
      expect(phrase).toMatch(/cannot be undone/i);
      expect(phrase).toMatch(/delete all my emails/);
    });

    it('uses money template for purchases', () => {
      const phrase = buildConfirmationPhrase({
        policy: { decision: DECISIONS.CONFIRM, reason: 'stakes=high' },
        intent: 'transfer 500 dollars to savings',
        content: 'transfer 500 dollars to savings',
        stakes: STAKES.HIGH,
      });
      expect(phrase).toMatch(/real money/i);
    });

    it('uses broadcast template for public / group sends', () => {
      const phrase = buildConfirmationPhrase({
        policy: { decision: DECISIONS.CONFIRM, reason: 'stakes=high' },
        intent: 'email everyone about the outage',
        content: 'email everyone about the outage',
        stakes: STAKES.HIGH,
      });
      expect(phrase).toMatch(/multiple people/i);
    });

    it('uses generic template for high-stakes content without a subtype match', () => {
      const phrase = buildConfirmationPhrase({
        policy: { decision: DECISIONS.CONFIRM, reason: 'stakes=high' },
        intent: 'do the serious thing',
        content: 'do the serious thing',
        stakes: STAKES.HIGH,
      });
      expect(phrase).toMatch(/big one/i);
    });
  });

  describe('defensive defaults', () => {
    it('missing intent uses a polite fallback', () => {
      const phrase = buildConfirmationPhrase({
        policy: { decision: DECISIONS.CONFIRM, reason: 'low intent confidence' },
      });
      expect(phrase).toContain('do that');
    });

    it('empty input does not throw', () => {
      expect(() => buildConfirmationPhrase()).not.toThrow();
    });
  });
});

describe('phraseForDecision', () => {
  it('returns null for dispatch', () => {
    const p = phraseForDecision({ policy: { decision: DECISIONS.DISPATCH } });
    expect(p).toBeNull();
  });

  it('returns an ack for ack-and-dispatch', () => {
    const p = phraseForDecision({
      policy: { decision: DECISIONS.ACK },
      stakes: STAKES.LOW,
      rng: () => 0,
    });
    expect(ACK_POOLS.low).toContain(p);
  });

  it('returns a confirmation question for confirm-first', () => {
    const p = phraseForDecision({
      policy: { decision: DECISIONS.CONFIRM, reason: 'stakes=high' },
      intent: 'delete my inbox',
      content: 'delete my inbox',
      stakes: STAKES.HIGH,
    });
    expect(p).toMatch(/\?$/);
  });

  it('returns null when the decision is unrecognized', () => {
    const p = phraseForDecision({ policy: { decision: 'mystery-meat' } });
    expect(p).toBeNull();
  });
});

function mkSeqRng(values) {
  let i = 0;
  return () => values[i++ % values.length];
}
