/**
 * Bid Overlap Penalty (HUD Core, Phase 4 of self-learning arbitration)
 *
 * Pure pre-selection adjustment. When two agents bid on the same
 * interpretation of a task, their reasoning text overlaps. We measure
 * that overlap (token-set Jaccard, after lowercasing + stopword
 * removal) and shrink the lower-confidence bid's confidence in
 * proportion. The dominance gap then re-emerges and the existing fast
 * path picks a single winner without an LLM.
 *
 * Properties (all enforced by tests):
 *   - Pure. No LLM, no I/O.
 *   - Top-bid is never penalised. Each bid is compared only against
 *     bids ranked above it.
 *   - Tiebreaker for equal confidence: alphabetical agentId. (Bid
 *     order received is the production reality but non-deterministic
 *     across reruns; alphabetical is reproducible.)
 *   - Symmetric immutable contract: returns a new array, never mutates.
 *
 * The constants (`threshold`, `maxPenalty`) ship conservative on day
 * one and are replaced by [lib/agent-learning/overlap-tuner.js] once a
 * few weeks of arbitration-decisions data have accrued. Don't
 * hand-tune them in this module after the tuner is live.
 *
 * Why Jaccard rather than embeddings:
 *   - The auction window is 2s. Embeddings are async and add network
 *     latency to the hot path; Jaccard is in-process and free.
 *   - Bid count is small (3-5 typical), so O(N^2) string comparisons
 *     are negligible.
 *   - If Jaccard misses semantic overlap in shadow data, the upgrade
 *     path is documented in the plan: ai.embed() + cosine.
 */

'use strict';

// ============================================================
// Defaults (conservative seed values; tuner will replace at runtime)
// ============================================================

/**
 * Below this Jaccard, no penalty is applied.
 * Conservative seed: 0.5 means we only suppress on heavy overlap.
 */
const DEFAULT_THRESHOLD = 0.5;

/**
 * At full overlap (Jaccard=1) the lower-confidence bid is multiplied
 * by `(1 - maxPenalty)`. Conservative seed: 0.3 means at most a 30%
 * shrinkage even on full overlap. Tuner ratchets up if shadow data
 * shows persistent under-suppression.
 */
const DEFAULT_MAX_PENALTY = 0.3;

const DEFAULT_STOPWORDS = new Set([
  'i', 'a', 'an', 'the',
  'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'do', 'does', 'did', 'doing',
  'have', 'has', 'had',
  'can', 'could', 'will', 'would', 'should', 'shall',
  'to', 'for', 'of', 'in', 'on', 'at', 'by', 'with', 'from',
  'and', 'or', 'but', 'so', 'if',
  'this', 'that', 'these', 'those',
  'it', 'its',
  'my', 'your', 'their',
  'as', 'about', 'into',
  'agent', 'task', 'request', 'user',
]);

const DEFAULT_OVERLAP_CONFIG = Object.freeze({
  threshold: DEFAULT_THRESHOLD,
  maxPenalty: DEFAULT_MAX_PENALTY,
  stopwords: DEFAULT_STOPWORDS,
});

// ============================================================
// Token-set Jaccard
// ============================================================

function tokenize(text, stopwords) {
  if (typeof text !== 'string' || text.length === 0) return new Set();
  const set = new Set();
  const tokens = text.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/);
  for (const t of tokens) {
    if (!t) continue;
    if (stopwords && stopwords.has(t)) continue;
    set.add(t);
  }
  return set;
}

/**
 * Pure. Token-set Jaccard similarity.
 *
 * @param {string} a
 * @param {string} b
 * @param {Set<string>} [stopwords]
 * @returns {number} 0..1
 */
function tokenSetJaccard(a, b, stopwords = DEFAULT_STOPWORDS) {
  const ta = tokenize(a, stopwords);
  const tb = tokenize(b, stopwords);
  if (ta.size === 0 && tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter += 1;
  const union = ta.size + tb.size - inter;
  return union === 0 ? 0 : inter / union;
}

// ============================================================
// Penalty function
// ============================================================

/**
 * Smooth ramp from `threshold` to 1.0:
 *   jac < threshold       -> penalty 0
 *   jac == 1.0            -> penalty maxPenalty
 *   linear interpolation between
 *
 * @returns {number} penalty in [0, maxPenalty]
 */
function _penaltyFromJaccard(jac, threshold, maxPenalty) {
  if (jac <= threshold) return 0;
  const span = 1 - threshold;
  if (span <= 0) return maxPenalty;
  const ratio = (jac - threshold) / span;
  return Math.min(maxPenalty, maxPenalty * ratio);
}

/**
 * Apply overlap penalty to a bid array. Pure: returns a NEW array.
 *
 * Each bid (in confidence-descending order, alphabetical-tiebreak)
 * is compared against every higher-ranked bid's reasoning. The
 * highest Jaccard wins; the bid's confidence and score get scaled by
 * `(1 - penalty)`. The top-ranked bid is never penalised.
 *
 * Bid shape required:
 *   { agentId: string, confidence: number, reasoning: string, score?: number }
 *
 * Output shape: same shape, plus `_overlapAdjustment` on bids that
 * were penalised, carrying { jaccard, against, factor, before, after }.
 *
 * @param {Array} bids
 * @param {object} [config]
 * @returns {Array}
 */
function applyOverlapPenalty(bids, config = {}) {
  if (!Array.isArray(bids) || bids.length < 2) {
    return Array.isArray(bids) ? bids.slice() : [];
  }
  const cfg = {
    threshold: typeof config.threshold === 'number' ? config.threshold : DEFAULT_THRESHOLD,
    maxPenalty: typeof config.maxPenalty === 'number' ? config.maxPenalty : DEFAULT_MAX_PENALTY,
    stopwords: config.stopwords instanceof Set ? config.stopwords : DEFAULT_STOPWORDS,
  };
  // Clamp config.
  cfg.threshold = Math.max(0, Math.min(1, cfg.threshold));
  cfg.maxPenalty = Math.max(0, Math.min(1, cfg.maxPenalty));

  // Sort: confidence desc, alphabetical id asc on ties (deterministic).
  const ranked = [...bids].sort((a, b) => {
    const cd = (b?.confidence || 0) - (a?.confidence || 0);
    if (cd !== 0) return cd;
    return String(a?.agentId || '').localeCompare(String(b?.agentId || ''));
  });

  const adjustments = new Map(); // agentId -> adjustment record

  for (let i = 1; i < ranked.length; i += 1) {
    const cur = ranked[i];
    if (!cur || !cur.agentId) continue;
    let bestJac = 0;
    let bestAgainst = null;
    for (let j = 0; j < i; j += 1) {
      const ref = ranked[j];
      if (!ref || ref.agentId === cur.agentId) continue;
      const jac = tokenSetJaccard(cur.reasoning, ref.reasoning, cfg.stopwords);
      if (jac > bestJac) { bestJac = jac; bestAgainst = ref.agentId; }
    }
    if (bestJac >= cfg.threshold) {
      const penalty = _penaltyFromJaccard(bestJac, cfg.threshold, cfg.maxPenalty);
      // Skip when the resolved penalty is effectively 0 (e.g. threshold
      // is at 1.0 from clamping, or maxPenalty is 0). Recording a
      // no-op adjustment would surface in the LLM prompt and downstream
      // telemetry as if a real change happened.
      if (penalty <= 0) continue;
      const factor = Math.max(0, 1 - penalty);
      const before = typeof cur.confidence === 'number' ? cur.confidence : 0;
      adjustments.set(cur.agentId, {
        jaccard: bestJac,
        against: bestAgainst,
        factor,
        before,
        after: before * factor,
      });
    }
  }

  // Apply (immutable copies).
  return bids.map((b) => {
    if (!b || !b.agentId) return b;
    const adj = adjustments.get(b.agentId);
    if (!adj) return b;
    return {
      ...b,
      confidence: adj.after,
      score: typeof b.score === 'number' ? b.score * adj.factor : adj.after,
      _overlapAdjustment: adj,
    };
  });
}

/**
 * Convenience: did this round of overlap penalty change the top-1
 * winner identity vs. the unadjusted bids? Used for shadow-mode
 * telemetry ("would-have-changed" rate).
 */
function wouldChangeWinner(rawBids, adjustedBids) {
  const pickTop = (bs) => {
    if (!Array.isArray(bs) || bs.length === 0) return null;
    return [...bs].sort((a, b) => {
      const cd = (b?.confidence || 0) - (a?.confidence || 0);
      if (cd !== 0) return cd;
      return String(a?.agentId || '').localeCompare(String(b?.agentId || ''));
    })[0]?.agentId || null;
  };
  const a = pickTop(rawBids);
  const b = pickTop(adjustedBids);
  return a !== null && b !== null && a !== b;
}

module.exports = {
  tokenize,
  tokenSetJaccard,
  applyOverlapPenalty,
  wouldChangeWinner,
  DEFAULT_OVERLAP_CONFIG,
  DEFAULT_THRESHOLD,
  DEFAULT_MAX_PENALTY,
  DEFAULT_STOPWORDS,
};
