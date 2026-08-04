/**
 * Gap Re-check - post-settle capability-gap detection.
 *
 * The pre-auction capability-gap floor (0.5) can be defeated by a single
 * hallucinated high bid: in the 2026-08 alarm request, task-queue-agent bid
 * 0.95 on a request it structurally cannot fulfill, sailed over the floor,
 * and its 0.80 dominance margin also skipped the orchestrator's LLM sanity
 * check. The winner then busted, two backups busted, and the last-resort
 * agent settled with a dead-end clarifying question -- revealed confidence
 * <= 0.15 -- yet the agent-builder offer was never re-evaluated.
 *
 * This module is the pure decision for the settle-time re-check: once
 * execution has REVEALED that the auction's confidence was fiction (busts +
 * an unresolved outcome), offer the capability-gap path after all.
 */

'use strict';

const DEFAULT_GAP_FLOOR = 0.5;

/**
 * Decide whether a settled task should trigger the capability-gap offer.
 *
 * @param {Object} f
 * @param {number} [f.bustCount] - how many agents busted before this settle
 * @param {number|null} [f.settledConfidence] - the settling agent's bid
 *   confidence if known (metadata often carries only the original winner's)
 * @param {boolean} f.resultResolved - isResolvedSuccess(result) for the
 *   settling result
 * @param {number} [f.floor] - the capability-gap confidence floor
 * @returns {{ offer: boolean, reason: string|null }}
 */
function shouldOfferGapAfterSettle(f = {}) {
  const bustCount = f.bustCount || 0;
  const floor = f.floor ?? DEFAULT_GAP_FLOOR;

  // A genuinely completed task is never a gap, no matter how rocky the road.
  if (f.resultResolved) return { offer: false, reason: null };

  // THE precise fiction signal (2026-08-04 live: task-queue bid 0.95 on
  // "set an alarm" with its backend down, busted immediately, and the single
  // bust kept the old >=2 threshold silent): the auction WINNER busted after
  // clearing the confidence floor. Its winning bid was revealed to be
  // fiction the moment it failed -- one bust is enough.
  if (f.winnerBusted === true && (f.winningConfidence ?? 1) >= floor) {
    return { offer: true, reason: 'winner-bust-revealed-gap' };
  }

  // 2+ busts followed by an unresolved outcome: the auction's confidence was
  // revealed to be fiction. This is the hallucinated-bid case.
  if (bustCount >= 2) {
    return { offer: true, reason: 'cascade-revealed-gap' };
  }

  // A weak-confidence settler that still couldn't resolve the request.
  if (
    typeof f.settledConfidence === 'number' &&
    f.settledConfidence < floor &&
    bustCount >= 1
  ) {
    return { offer: true, reason: 'weak-bid-unresolved' };
  }

  return { offer: false, reason: null };
}

module.exports = { shouldOfferGapAfterSettle, DEFAULT_GAP_FLOOR };
