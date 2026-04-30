/**
 * Confirmation Policy (Phase 1 / calibratedConfirmation)
 *
 * Pure decision function. Given a normalized snapshot of what the
 * pipeline just decided, returns one of three actions:
 *
 *   'dispatch'           -> run the agent now, silent entry (status quo)
 *   'ack-and-dispatch'   -> play a short acknowledgment then run (new)
 *   'confirm-first'      -> speak a confirmation prompt, wait for user (new)
 *
 * The policy is intentionally boring (table-driven) so it can be
 * exhaustively unit-tested and tuned without touching the pipeline.
 *
 * DESIGN RULES:
 *   1. System-type tasks (error-agent, meeting-monitor) NEVER play an
 *      ack or confirmation -- they are infrastructure, not user-facing.
 *   2. Informational tasks default to 'dispatch'. A confirmation only
 *      fires when intent is genuinely uncertain AND there is no prior
 *      context for pronoun resolution.
 *   3. Action tasks with high stakes ALWAYS confirm regardless of
 *      confidence. "Delete all my emails" never sneaks through.
 *   4. Action tasks with confident routing get a light ack so the
 *      user hears acknowledgment before the agent's own response
 *      lands. Destroys "did it hear me?" silence.
 *
 * INPUTS (all optional, sensible defaults):
 *   intentConfidence    number  0..1  -- from normalizeIntent
 *   winnerConfidence    number  0..1  -- top bid from unified-bidder
 *   executionType       string        -- 'informational' | 'action' | 'system'
 *   stakes              string        -- 'low' | 'medium' | 'high'
 *   hasPriorContext     boolean       -- conversation history exists
 *
 * OUTPUT:
 *   {
 *     decision: 'dispatch' | 'ack-and-dispatch' | 'confirm-first',
 *     reason:   string   // human-readable trace
 *   }
 *
 * Thresholds live on DEFAULT_THRESHOLDS and are overridable so tests
 * and future phases can tune without editing the decision code.
 */

'use strict';

const DEFAULT_THRESHOLDS = Object.freeze({
  // Intent normalizer confidence below this = suspicious input.
  // Empirically, normalizeIntent returns ~1.0 for fast-path utterances
  // and 0.6-0.85 for LLM-rewritten ones. 0.70 is the knee.
  lowIntent: 0.7,

  // Winner bid: "strong fit" line. Auction bids >= this are safe to
  // dispatch immediately (with an ack for actions).
  highWinnerConfidence: 0.82,

  // Winner bid: below this is "shaky fit" -- better to confirm.
  mediumWinnerConfidence: 0.65,
});

const EXEC_TYPES = Object.freeze({
  INFORMATIONAL: 'informational',
  ACTION: 'action',
  SYSTEM: 'system',
});

const STAKES = Object.freeze({
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
});

const DECISIONS = Object.freeze({
  DISPATCH: 'dispatch',
  ACK: 'ack-and-dispatch',
  CONFIRM: 'confirm-first',
});

/**
 * @param {object} input
 * @param {number}  [input.intentConfidence=1.0]
 * @param {number}  [input.winnerConfidence=1.0]
 * @param {string}  [input.executionType='informational']
 * @param {string}  [input.stakes='low']
 * @param {boolean} [input.hasPriorContext=true]
 * @param {object}  [input.thresholds] - overrides for DEFAULT_THRESHOLDS
 * @returns {{decision: string, reason: string}}
 */
function decide(input = {}) {
  const {
    intentConfidence = 1.0,
    winnerConfidence = 1.0,
    executionType = EXEC_TYPES.INFORMATIONAL,
    stakes = STAKES.LOW,
    hasPriorContext = true,
    thresholds,
  } = input;

  const t = thresholds ? { ...DEFAULT_THRESHOLDS, ...thresholds } : DEFAULT_THRESHOLDS;

  // Rule 1: system agents are infrastructure. Never inject naturalness.
  if (executionType === EXEC_TYPES.SYSTEM) {
    return {
      decision: DECISIONS.DISPATCH,
      reason: 'system executionType bypasses naturalness layer',
    };
  }

  // Rule 3 (checked early): high stakes always confirms, regardless of
  // routing confidence. The user must opt in to destructive things.
  if (stakes === STAKES.HIGH) {
    return {
      decision: DECISIONS.CONFIRM,
      reason: `stakes=${stakes} always requires confirmation`,
    };
  }

  // Rule 2: informational. Default to dispatch. Only confirm when the
  // intent normalizer was actively unsure AND we have no prior context
  // for the system to lean on (otherwise "it" / "that" resolution
  // would have worked and we should trust it).
  if (executionType === EXEC_TYPES.INFORMATIONAL) {
    if (intentConfidence < t.lowIntent && !hasPriorContext) {
      return {
        decision: DECISIONS.CONFIRM,
        reason: `informational with low intent confidence (${intentConfidence}) and no prior context`,
      };
    }
    return {
      decision: DECISIONS.DISPATCH,
      reason: 'informational task, confident enough to answer directly',
    };
  }

  // Rule 4: action tasks. Multiple reasons to confirm, otherwise ack.
  if (executionType === EXEC_TYPES.ACTION) {
    if (intentConfidence < t.lowIntent) {
      return {
        decision: DECISIONS.CONFIRM,
        reason: `action with low intent confidence (${intentConfidence})`,
      };
    }
    if (winnerConfidence < t.mediumWinnerConfidence) {
      return {
        decision: DECISIONS.CONFIRM,
        reason: `action with low winner confidence (${winnerConfidence})`,
      };
    }
    if (stakes === STAKES.MEDIUM && winnerConfidence < t.highWinnerConfidence) {
      return {
        decision: DECISIONS.CONFIRM,
        reason: `medium-stakes action with non-high winner confidence (${winnerConfidence})`,
      };
    }
    return {
      decision: DECISIONS.ACK,
      reason: 'confident action gets pre-dispatch acknowledgment',
    };
  }

  // Unknown executionType -- be conservative, dispatch but note it.
  return {
    decision: DECISIONS.DISPATCH,
    reason: `unknown executionType "${executionType}", defaulting to dispatch`,
  };
}

module.exports = {
  decide,
  DEFAULT_THRESHOLDS,
  EXEC_TYPES,
  STAKES,
  DECISIONS,
};
