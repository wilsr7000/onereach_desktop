/**
 * Winner Selection (HUD Core)
 *
 * Pure ranking + fast-path logic for choosing the winning bid(s)
 * after an agent auction. Extracted from
 * `packages/agents/master-orchestrator.js`.
 *
 * Three deterministic decisions that DON'T need an LLM:
 *
 *   1. **Empty / single bid** -- trivial (no decision to make).
 *   2. **Dominant top bid** -- if the top score is >= 0.3 ahead of
 *      the runner-up, we pick the top directly and skip the LLM.
 *   3. **Multi-intent override** -- if an LLM picks multiple winners
 *      but the task text has no "and / then / also / plus" signals,
 *      we force single-winner mode (most follow-up questions are
 *      single-agent, not multi-domain).
 *
 * And a fallback:
 *
 *   4. **`fallbackSelection(bids)`** -- pick the highest-scored bid,
 *      single-winner mode. Used when the LLM is unreachable,
 *      returns an invalid winner, or is intentionally bypassed.
 *
 * These four building blocks compose into the full "pickWinner"
 * flow. The FULL flow (with LLM) stays in master-orchestrator.js
 * because it carries stateful feedback into per-agent memory; this
 * module contains only the parts that a GSX flow / WISER / CLI
 * could run identically.
 */

'use strict';

/**
 * Gap threshold for the dominant-top-bid fast path. If the winning
 * bid beats the runner-up by MORE than this margin, we skip any
 * further evaluation. 0.3 matches the value baked into the
 * desktop app's master orchestrator before extraction.
 */
const DEFAULT_DOMINANCE_GAP = 0.3;

/**
 * Regex that catches the common English multi-intent connectives.
 * When NONE of these appear, multi-winner LLM decisions get
 * overridden to single-winner.
 */
const MULTI_INTENT_PATTERN = /\band\b|\bthen\b|\balso\b|\bplus\b/i;

/**
 * Normalize a bid's score for comparison. Prefers `score` (the
 * exchange's consolidated ranking) over raw `confidence`, since
 * score factors in the agent's reputation.
 * @param {object} bid
 * @returns {number}
 */
function scoreOf(bid) {
  const s = bid && typeof bid.score === 'number' ? bid.score : null;
  if (s !== null) return s;
  const c = bid && typeof bid.confidence === 'number' ? bid.confidence : 0;
  return c;
}

/**
 * @typedef {object} Bid
 * @property {string} agentId
 * @property {string} [agentName]
 * @property {number} [confidence]
 * @property {number} [score]
 * @property {string} [reasoning]
 */

/**
 * @typedef {object} WinnerDecision
 * @property {string[]} winners                - 0..N agent IDs
 * @property {'single'|'parallel'|'series'} executionMode
 * @property {string} reasoning
 * @property {Array<{agentId:string,reason:string}>} rejectedBids
 * @property {Array<{agentId:string,feedback:string}>} agentFeedback
 */

/**
 * Try to decide a winner without an LLM. Returns a WinnerDecision
 * when one of the fast paths fires; returns null when LLM
 * evaluation is needed.
 *
 * @param {Bid[]} bids
 * @param {object} [options]
 * @param {number} [options.dominanceGap]   - default 0.3
 * @returns {WinnerDecision | null}
 */
function pickWinnerFastPath(bids, options = {}) {
  const dominanceGap =
    typeof options.dominanceGap === 'number'
      ? options.dominanceGap
      : DEFAULT_DOMINANCE_GAP;

  if (!Array.isArray(bids) || bids.length === 0) {
    return {
      winners: [],
      executionMode: 'single',
      reasoning: 'No bids received',
      rejectedBids: [],
      agentFeedback: [],
    };
  }

  if (bids.length === 1) {
    return {
      winners: [bids[0].agentId],
      executionMode: 'single',
      reasoning: 'Only one agent bid',
      rejectedBids: [],
      agentFeedback: [],
    };
  }

  // Dominance gap: if the top score is clearly ahead of #2, no LLM needed.
  const sorted = [...bids].sort((a, b) => scoreOf(b) - scoreOf(a));
  const topScore = scoreOf(sorted[0]);
  const secondScore = scoreOf(sorted[1]);
  const gap = topScore - secondScore;
  if (gap > dominanceGap) {
    return {
      winners: [sorted[0].agentId],
      executionMode: 'single',
      reasoning: `Clear winner by ${gap.toFixed(2)} confidence gap`,
      rejectedBids: [],
      agentFeedback: [],
    };
  }

  return null;
}

/**
 * True when the task's content contains a common English multi-
 * intent connective ("and", "then", "also", "plus"). Used to decide
 * whether multi-winner mode is justified.
 *
 * @param {string} taskText
 * @returns {boolean}
 */
function hasMultiIntent(taskText) {
  const text = (taskText || '').toString();
  if (!text) return false;
  return MULTI_INTENT_PATTERN.test(text);
}

/**
 * Enforce the single-winner default when the task doesn't look
 * multi-intent. Called AFTER the LLM returns a decision, to strip
 * spurious multi-winner choices on plain questions.
 *
 * Rules:
 *   - winners.length <= 1 -> force executionMode 'single' (sanity)
 *   - winners.length > 1 + task is NOT multi-intent -> take first
 *     winner, force 'single', leave reasoning intact
 *   - winners.length > 1 + task IS multi-intent -> pass through
 *     unchanged (LLM knows best)
 *
 * @param {{winners:string[], executionMode:string}} decision
 * @param {string} taskText
 * @returns {{winners:string[], executionMode:'single'|'parallel'|'series'}}
 */
function applyMultiIntentOverride(decision, taskText) {
  const winners = Array.isArray(decision?.winners) ? decision.winners : [];
  const mode = decision?.executionMode || 'single';

  if (winners.length <= 1) {
    return { winners, executionMode: 'single' };
  }

  if (!hasMultiIntent(taskText)) {
    return { winners: [winners[0]], executionMode: 'single' };
  }

  return { winners, executionMode: mode };
}

/**
 * Fallback when the LLM is unreachable, returns nonsense, or is
 * intentionally skipped: pick the highest-scoring bid and return
 * single-winner mode.
 *
 * @param {Bid[]} bids
 * @returns {WinnerDecision}
 */
function fallbackSelection(bids) {
  if (!Array.isArray(bids) || bids.length === 0) {
    return {
      winners: [],
      executionMode: 'single',
      reasoning: 'No bids received',
      rejectedBids: [],
      agentFeedback: [],
    };
  }
  const sorted = [...bids].sort((a, b) => scoreOf(b) - scoreOf(a));
  return {
    winners: [sorted[0].agentId],
    executionMode: 'single',
    reasoning: 'Fallback: selected highest scoring bid',
    rejectedBids: [],
    agentFeedback: [],
  };
}

/**
 * Validate a set of winner agent IDs against the original bid list.
 * Any winner that doesn't correspond to a bid gets dropped. Returns
 * an array (possibly empty) of the valid winner IDs.
 *
 * @param {string[]} winnerIds
 * @param {Bid[]} bids
 * @returns {string[]}
 */
function validateWinners(winnerIds, bids) {
  if (!Array.isArray(winnerIds) || !Array.isArray(bids)) return [];
  const bidIds = new Set(bids.map((b) => b && b.agentId).filter(Boolean));
  return winnerIds.filter((id) => typeof id === 'string' && bidIds.has(id));
}

module.exports = {
  scoreOf,
  pickWinnerFastPath,
  hasMultiIntent,
  applyMultiIntentOverride,
  fallbackSelection,
  validateWinners,
  DEFAULT_DOMINANCE_GAP,
  MULTI_INTENT_PATTERN,
};
