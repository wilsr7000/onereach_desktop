/**
 * gap-recheck -- post-settle capability-gap detection
 *
 * Regression for the hallucinated-bid suppression: task-queue-agent bid 0.95
 * on "set an alarm" (real field: 0.05-0.15 across all other agents), cleared
 * the 0.5 pre-auction gap floor, and its dominance margin skipped the LLM
 * sanity check. Winner + two backups busted; the last resort settled with a
 * dead-end question — revealed confidence <= 0.15 — and the agent-builder
 * offer never fired. The re-check catches exactly this at settle time.
 */

import { describe, it, expect } from 'vitest';

const { shouldOfferGapAfterSettle, DEFAULT_GAP_FLOOR } = require('../../lib/exchange/gap-recheck.js');

describe('shouldOfferGapAfterSettle', () => {
  it('offers after the exact alarm scenario: 3 busts + unresolved needsInput settle', () => {
    const out = shouldOfferGapAfterSettle({
      bustCount: 3,
      settledConfidence: null, // metadata only carried the hallucinated winner's 0.95
      resultResolved: false,
    });
    expect(out.offer).toBe(true);
    expect(out.reason).toBe('cascade-revealed-gap');
  });

  it('offers at exactly 2 busts + unresolved', () => {
    expect(shouldOfferGapAfterSettle({ bustCount: 2, resultResolved: false }).offer).toBe(true);
  });

  it('does NOT offer when the task genuinely completed, regardless of busts', () => {
    expect(shouldOfferGapAfterSettle({ bustCount: 4, resultResolved: true }).offer).toBe(false);
  });

  it('does NOT offer for a clean single-agent needsInput (legit clarifying question)', () => {
    // No busts, no weak-bid signal: an agent asking a follow-up is normal
    // multi-turn behavior, not a capability gap.
    expect(shouldOfferGapAfterSettle({ bustCount: 0, resultResolved: false }).offer).toBe(false);
  });

  it('offers for a weak-confidence settler that could not resolve (1 bust)', () => {
    const out = shouldOfferGapAfterSettle({
      bustCount: 1,
      settledConfidence: 0.15,
      resultResolved: false,
    });
    expect(out.offer).toBe(true);
    expect(out.reason).toBe('weak-bid-unresolved');
  });

  it('does NOT offer for a confident settler asking a follow-up after 1 bust', () => {
    expect(
      shouldOfferGapAfterSettle({ bustCount: 1, settledConfidence: 0.8, resultResolved: false }).offer
    ).toBe(false);
  });

  it('respects a custom floor', () => {
    expect(
      shouldOfferGapAfterSettle({ bustCount: 1, settledConfidence: 0.55, resultResolved: false, floor: 0.6 }).offer
    ).toBe(true);
  });

  it('default floor matches the pre-auction gap floor (0.5)', () => {
    expect(DEFAULT_GAP_FLOOR).toBe(0.5);
  });

  it('is safe on empty input', () => {
    expect(shouldOfferGapAfterSettle().offer).toBe(false);
    expect(shouldOfferGapAfterSettle({}).offer).toBe(false);
  });
});
