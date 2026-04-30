/**
 * Confirmation Phrases (Phase 1 / calibratedConfirmation)
 *
 * Small template library that turns a policy decision into the exact
 * English the user will hear. Keeping phrasing in its own module means
 * the pipeline integration never has to decide "what do we say?" --
 * it just asks for the phrase that matches the current decision and
 * context.
 *
 * This is intentionally deterministic + injectable. Tests can pass
 * `rng: () => 0` to lock in a specific phrase choice. Integration
 * code passes `Math.random` (or omits the argument) for real variety.
 *
 * DESIGN RULES:
 *   1. Acks are SHORT (<= 4 words). Long acks delay the real answer
 *      and feel chatty. Variety only comes from rotation, not length.
 *   2. Confirmations are QUESTIONS that end on a rising-intonation
 *      word -- "right?", "go ahead?", "should I proceed?" -- so TTS
 *      prosody matches.
 *   3. Stakes determines tone. Low = light ("got it"). Medium = named
 *      ("scheduling that"). High = cautious + reversible language.
 *   4. The phrase helpers NEVER include the agent's own output -- that
 *      remains the agent's job. This layer only sets up the turn.
 */

'use strict';

const { STAKES } = require('./stakes-classifier');
const { DECISIONS } = require('./confirmation-policy');

// ---- Phrase pools ----------------------------------------------------

const ACK_POOLS = Object.freeze({
  // Used when stakes = 'low'. The shortest acks -- fire-and-forget.
  low: Object.freeze(['got it', 'on it', 'one sec', 'okay', 'doing that']),

  // Used when stakes = 'medium'. Slightly more specific so the user
  // hears what the system thinks it is about to do without waiting
  // for the agent's own response.
  medium: Object.freeze([
    'got it, on that now',
    'okay, working on it',
    'on it -- one moment',
    'doing that now',
  ]),
});

// Confirmation prompt templates. Each takes { intent, planSummary,
// reason } and returns the full utterance. Pick-one helpers below
// select among them based on why the policy chose confirm-first.

function _templateLowIntent({ intent }) {
  return `I think you want to ${intent}. Should I go ahead?`;
}

function _templateLowWinner({ intent, planSummary }) {
  if (planSummary && planSummary.trim()) {
    return `I was going to ${planSummary}. Is that right?`;
  }
  return `I was going to ${intent}. Is that right?`;
}

function _templateMediumStakes({ intent }) {
  return `Want me to ${intent}?`;
}

function _templateHighStakesDestructive({ intent }) {
  return `This would ${intent}. That cannot be undone -- want me to continue?`;
}

function _templateHighStakesMoney({ intent }) {
  return `This would ${intent} -- real money. Want me to proceed?`;
}

function _templateHighStakesBroadcast({ intent }) {
  return `This would ${intent} to multiple people. Want me to send it?`;
}

function _templateHighStakesGeneric({ intent }) {
  return `Want me to ${intent}? This is a big one.`;
}

// ---- Ack selection ---------------------------------------------------

/**
 * Pick a short acknowledgment phrase. Deterministic when `rng` is
 * passed (tests) and varied otherwise.
 *
 * @param {object} [opts]
 * @param {string} [opts.stakes='low']
 * @param {() => number} [opts.rng=Math.random] - returns a float in [0,1)
 * @returns {string}
 */
function pickAckPhrase(opts = {}) {
  const stakes = opts.stakes || STAKES.LOW;
  const rng = typeof opts.rng === 'function' ? opts.rng : Math.random;
  const pool = ACK_POOLS[stakes] || ACK_POOLS.low;
  const idx = Math.floor(rng() * pool.length) % pool.length;
  return pool[idx];
}

// ---- Confirmation selection ------------------------------------------

/**
 * Build the confirmation utterance for a decision.
 *
 * @param {object} input
 * @param {object} input.policy           - result from confirmation-policy.decide
 * @param {string} [input.intent]         - user-facing verb phrase, e.g. "schedule a meeting tomorrow at 3"
 * @param {string} [input.planSummary]    - winner bid's plan text, if any
 * @param {string} [input.stakes='low']
 * @param {string} [input.content]        - raw task content, for high-stakes subtype detection
 * @returns {string}
 */
function buildConfirmationPhrase(input = {}) {
  const intent = (input.intent || input.content || 'do that').trim();
  const planSummary = input.planSummary || '';
  const stakes = input.stakes || STAKES.LOW;
  const reason = (input.policy && input.policy.reason) || '';
  const contentLower = (input.content || '').toLowerCase();

  // Stakes-driven templates first -- they are most important.
  if (stakes === STAKES.HIGH) {
    if (/\b(purchase|buy|pay|transfer|wire|charge)\b/.test(contentLower)) {
      return _templateHighStakesMoney({ intent });
    }
    if (/\b(everyone|team|all contacts|group|publicly|broadcast)\b/.test(contentLower)) {
      return _templateHighStakesBroadcast({ intent });
    }
    if (/\b(delete|remove|erase|wipe|purge|clear|destroy|cancel)\b/.test(contentLower)) {
      return _templateHighStakesDestructive({ intent });
    }
    return _templateHighStakesGeneric({ intent });
  }

  if (stakes === STAKES.MEDIUM) {
    return _templateMediumStakes({ intent });
  }

  // Low stakes: split by policy reason.
  if (/low winner confidence/i.test(reason)) {
    return _templateLowWinner({ intent, planSummary });
  }
  if (/low intent confidence/i.test(reason)) {
    return _templateLowIntent({ intent });
  }

  // Default.
  return _templateLowIntent({ intent });
}

/**
 * Unified entry: given a policy decision + context, produce either an
 * ack phrase or a confirmation question. Returns null for 'dispatch'
 * (no phrase -- silent entry).
 *
 * @param {object} input
 * @param {object} input.policy - { decision, reason }
 * @returns {string|null}
 */
function phraseForDecision(input = {}) {
  const policy = input.policy || {};
  if (policy.decision === DECISIONS.ACK) {
    return pickAckPhrase({ stakes: input.stakes, rng: input.rng });
  }
  if (policy.decision === DECISIONS.CONFIRM) {
    return buildConfirmationPhrase(input);
  }
  return null;
}

module.exports = {
  ACK_POOLS,
  pickAckPhrase,
  buildConfirmationPhrase,
  phraseForDecision,
};
