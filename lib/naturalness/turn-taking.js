/**
 * Turn-Taking Policy (Phase 3 / pauseDetection)
 *
 * Pure decision function. Given a partial transcript and the amount
 * of silence observed after it, decide whether to:
 *
 *   'commit-now'   - the turn is over; send input_audio_buffer.commit
 *   'check-llm'    - ambiguous; ask the utterance classifier
 *   'keep-waiting' - the utterance looks incomplete; stay open longer
 *
 * Fast-path rules live here as pattern tables so the common cases
 * never pay for an LLM call. The classifier (utterance-classifier.js)
 * is only consulted when this policy returns 'check-llm'.
 *
 * THRESHOLDS (caller can override):
 *   fastFinalizeMs  -- silence after clearly-complete utterance
 *   waitMs          -- give the LLM / server another chance
 *   maxWaitMs       -- absolute ceiling; pipeline must commit by then
 *
 * The server-side default (OpenAI Realtime VAD, 1200ms) continues to
 * serve as the floor when this policy says 'keep-waiting'. The policy
 * only ever commits *earlier* than the server would.
 */

'use strict';

// ==================== DEFAULT THRESHOLDS ====================

const DEFAULT_THRESHOLDS = Object.freeze({
  // A complete-looking partial commits this fast after speech stops.
  fastFinalizeMs: 400,

  // If the partial is ambiguous, we wait a bit longer before asking
  // the LLM classifier (so user has time to resume speaking).
  waitMs: 700,

  // Hard ceiling -- even if nothing looks complete, commit here so the
  // pipeline doesn't hang. Stays well under the server VAD's 1200ms.
  maxWaitMs: 1100,
});

// ==================== FAST-PATH PATTERNS ====================

// Single-word complete commands / acknowledgments. Anchored via \b so
// we only match whole words (not "cancels" or "stopping").
const SINGLE_WORD_FAST_PATHS = new Set([
  'pause', 'resume', 'stop', 'cancel', 'continue',
  'yes', 'no', 'yeah', 'nope', 'okay', 'ok', 'sure',
  'help', 'undo', 'repeat', 'next', 'previous', 'back', 'done',
  'mute', 'unmute',
  // Closers / pleasantries that are meaningful alone
  'thanks', 'goodbye', 'bye', 'hi', 'hello', 'hey',
]);

// Patterns that look like complete questions or imperatives. These
// are safe to finalize after the short silence window.
const COMPLETE_UTTERANCE_PATTERNS = [
  // Simple wh-questions ending on a noun phrase
  /^what('?s|s| is| are|'re)?\s+.{2,}$/i,
  /^where('?s| is| are|'re)?\s+.{2,}$/i,
  /^when('?s| is| did| will)?\s+.{2,}$/i,
  /^who('?s| is| was)?\s+.{2,}$/i,
  /^how\s+(many|much|long|far|do i|do you|does|did)\s+.{2,}$/i,
  /^why\s+(is|are|did|do)\s+.{2,}$/i,

  // Clear imperatives with an object
  /^(play|pause|stop|start|skip|next|previous)\s+[a-z]+.{0,}$/i,
  /^(open|close|show|hide|launch|run|find|search)\s+[a-z]+.{0,}$/i,
  /^(send|email|text|message|call|dial)\s+[a-z]+.{0,}$/i,
  /^(save|export|download|upload|share|copy|move|rename)\s+[a-z]+.{0,}$/i,
  /^(set|turn|toggle|enable|disable)\s+[a-z]+.{0,}$/i,
  /^(remind|alert|notify) me\s+.{2,}$/i,
  /^(tell|show|read|list|describe|explain|summarize)\s+.{2,}$/i,
  /^(delete|remove|erase|clear|cancel)\s+[a-z]+.{0,}$/i,
  /^(schedule|book|create|add|make)\s+.{2,}$/i,

  // Greetings / conversational closers (single clauses)
  /^(good\s+(morning|afternoon|evening|night))\b.{0,}$/i,
  /^(thanks|thank you|goodbye|bye)\b.{0,}$/i,
  /^(give me|give us)\s+.{2,}$/i,
];

// Strong "keep waiting" signals -- partial clearly ends mid-thought.
const INCOMPLETE_PATTERNS = [
  // Ends with a conjunction or discourse marker
  /\b(and|but|or|so|because|if|while|when|since)\s*$/i,
  // Ends with a preposition
  /\b(to|from|for|with|about|on|in|at|by|of|as)\s*$/i,
  // Ends with an article
  /\b(the|a|an)\s*$/i,
  // Ends with a pause-filler (um/uh/er/mm)
  /\b(um|uh|er|ah|eh|mm|hmm)[.,!?\s]*$/i,
  // Single word that isn't in the fast-path set (handled separately in decide())
];

// ==================== HELPERS ====================

function _normalize(text) {
  return (text || '').toString().trim().toLowerCase();
}

function _isSingleWord(text) {
  const n = _normalize(text).replace(/[.,!?;:]/g, '');
  return n.length > 0 && !/\s/.test(n);
}

/**
 * Classify a partial transcript purely by regex. No LLM cost.
 *
 * @param {string} partial
 * @returns {'complete' | 'incomplete' | 'ambiguous'}
 */
function heuristicClassify(partial) {
  const n = _normalize(partial);
  if (!n) return 'ambiguous';

  // Strip trailing punctuation for fair comparison
  const body = n.replace(/[.,!?;:]+$/g, '').trim();
  if (!body) return 'ambiguous';

  // Strong incomplete signals win over everything. Covers single
  // fillers ("uh"), trailing conjunctions ("call alice and"), and
  // articles left hanging ("the").
  for (const rx of INCOMPLETE_PATTERNS) {
    if (rx.test(body)) return 'incomplete';
  }

  // Single-word complete commands (after incomplete has had its say
  // -- so "the" doesn't accidentally match as ambiguous).
  if (_isSingleWord(body)) {
    return SINGLE_WORD_FAST_PATHS.has(body) ? 'complete' : 'ambiguous';
  }

  for (const rx of COMPLETE_UTTERANCE_PATTERNS) {
    if (rx.test(body)) return 'complete';
  }

  return 'ambiguous';
}

// ==================== POLICY ====================

/**
 * Decide whether to commit the turn, wait longer, or ask the LLM.
 *
 * @param {object} input
 * @param {string} input.partial          - the current partial transcript
 * @param {number} input.silenceMs        - ms since last speech detected
 * @param {object} [input.thresholds]     - overrides
 * @returns {{
 *   action: 'commit-now' | 'check-llm' | 'keep-waiting',
 *   reason: string,
 *   classification: 'complete'|'incomplete'|'ambiguous',
 *   hitMaxWait: boolean
 * }}
 */
function decide(input = {}) {
  const partial = input.partial || '';
  const silenceMs = Number.isFinite(input.silenceMs) ? input.silenceMs : 0;
  const t = input.thresholds
    ? { ...DEFAULT_THRESHOLDS, ...input.thresholds }
    : DEFAULT_THRESHOLDS;

  const classification = heuristicClassify(partial);

  // Absolute ceiling: commit even if things look incomplete.
  if (silenceMs >= t.maxWaitMs) {
    return {
      action: 'commit-now',
      reason: `silenceMs ${silenceMs} >= maxWaitMs ${t.maxWaitMs} (ceiling)`,
      classification,
      hitMaxWait: true,
    };
  }

  // Fast-path: clear complete + minimal silence -> commit now.
  if (classification === 'complete' && silenceMs >= t.fastFinalizeMs) {
    return {
      action: 'commit-now',
      reason: `complete utterance after ${silenceMs}ms silence`,
      classification,
      hitMaxWait: false,
    };
  }

  // Strongly incomplete -> keep listening until the ceiling.
  if (classification === 'incomplete') {
    return {
      action: 'keep-waiting',
      reason: `incomplete partial ("${_tail(partial)}"), awaiting resumption`,
      classification,
      hitMaxWait: false,
    };
  }

  // Ambiguous: wait a bit, then ask the LLM classifier.
  if (classification === 'ambiguous' && silenceMs >= t.waitMs) {
    return {
      action: 'check-llm',
      reason: `ambiguous partial after ${silenceMs}ms silence`,
      classification,
      hitMaxWait: false,
    };
  }

  return {
    action: 'keep-waiting',
    reason: `waiting (classification=${classification}, silenceMs=${silenceMs})`,
    classification,
    hitMaxWait: false,
  };
}

function _tail(text, n = 20) {
  if (!text) return '';
  return String(text).slice(-n);
}

module.exports = {
  DEFAULT_THRESHOLDS,
  SINGLE_WORD_FAST_PATHS,
  COMPLETE_UTTERANCE_PATTERNS,
  INCOMPLETE_PATTERNS,
  heuristicClassify,
  decide,
};
