/**
 * Barge Classifier (Phase 4 / bargeIn)
 *
 * Given a piece of user speech captured while TTS was playing (and
 * already filtered through echo-filter), decide WHAT the user meant:
 *
 *   'stop'     -- user wants TTS to stop; no new task.
 *   'ack'      -- user is affirming/backchanneling; TTS should continue.
 *                 The assistant should NOT cancel speaking.
 *   'command'  -- new user request; TTS should cancel AND the text is
 *                 submitted as a fresh task.
 *   'unclear'  -- genuinely ambiguous. Callers typically treat 'unclear'
 *                 as a soft stop (cancel TTS, do NOT auto-submit).
 *
 * All lookups are token-based and English-only for now; this classifier
 * is intentionally deterministic so tests and telemetry are reliable.
 *
 * Returns { kind, confidence, reason } where confidence is 0..1.
 */

'use strict';

// ==================== LEXICON ====================

const STOP_PHRASES = [
  'stop',
  'wait',
  'hold on',
  'hold please',
  'hold up',
  'cancel',
  'cancel that',
  'never mind',
  'nevermind',
  'actually',
  'forget it',
  'shut up',
  'be quiet',
  'quiet',
  'enough',
  'pause',
];

// Short affirmations during TTS playback. "okay" is intentionally
// included here not as a stop -- users use it as backchannel.
// Stored in their POST-normalize form (hyphens + punctuation stripped)
// so `_matchesPhraseList` can compare strictly against normalized input.
const ACK_PHRASES = [
  'yeah',
  'yep',
  'yes',
  'mhm',
  'mmhmm',
  'uhhuh',
  'okay',
  'ok',
  'right',
  'sure',
  'got it',
  'gotcha',
  'makes sense',
  'cool',
  'nice',
  'alright',
];

// Interrogative / command lead tokens that suggest a new task rather
// than a stop / ack.
const COMMAND_LEAD_TOKENS = new Set([
  'what', 'when', 'where', 'who', 'why', 'how', 'which',
  'play', 'pause', 'skip', 'next', 'previous',
  'open', 'close', 'show', 'hide', 'launch', 'run', 'find', 'search',
  'send', 'email', 'text', 'message', 'call', 'dial',
  'save', 'export', 'download', 'upload', 'share',
  'set', 'turn', 'toggle', 'enable', 'disable',
  'remind', 'alert', 'notify',
  'tell', 'read', 'list', 'describe', 'explain', 'summarize',
  'delete', 'remove', 'erase', 'clear', 'cancel', // cancel + noun = command
  'schedule', 'book', 'create', 'add', 'make',
  'change', 'update',
]);

const DEFAULT_THRESHOLDS = Object.freeze({
  // User speech shorter than this many words is classified by phrase-
  // match tables only; longer is treated as command territory.
  maxPhraseWords: 4,
});

// ==================== HELPERS ====================

function _normalize(s) {
  return (s || '')
    .toString()
    .toLowerCase()
    .replace(/[.,!?;:'"()\-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function _wordCount(s) {
  return s ? s.split(/\s+/).length : 0;
}

function _matchesPhraseList(text, phrases) {
  // Match when the normalized text EQUALS a phrase or starts with it
  // followed by a space. This catches "stop" / "stop please" /
  // "cancel that one" without also matching "please stop doing that".
  for (const p of phrases) {
    if (text === p) return p;
    if (text.startsWith(p + ' ')) return p;
  }
  return null;
}

function _startsWithCommand(text) {
  const firstTok = text.split(/\s+/)[0];
  return firstTok && COMMAND_LEAD_TOKENS.has(firstTok);
}

// ==================== MAIN ====================

/**
 * Classify a piece of user speech that was heard over TTS playback.
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {object} [opts.thresholds]
 * @returns {{ kind: 'stop'|'ack'|'command'|'unclear', confidence: number, reason: string }}
 */
function classifyBarge(text, opts = {}) {
  const normalized = _normalize(text);
  const t = opts.thresholds
    ? { ...DEFAULT_THRESHOLDS, ...opts.thresholds }
    : DEFAULT_THRESHOLDS;

  if (!normalized) {
    return { kind: 'unclear', confidence: 0, reason: 'empty input' };
  }

  // Stop phrases win over acks when both could match, because we
  // prefer a false-positive cancel over ignoring a genuine stop.
  const stopMatch = _matchesPhraseList(normalized, STOP_PHRASES);
  if (stopMatch) {
    return {
      kind: 'stop',
      confidence: 0.95,
      reason: `stop phrase: "${stopMatch}"`,
    };
  }

  // Short utterance -> phrase-match only.
  const wc = _wordCount(normalized);
  if (wc <= t.maxPhraseWords) {
    const ackMatch = _matchesPhraseList(normalized, ACK_PHRASES);
    if (ackMatch) {
      return {
        kind: 'ack',
        confidence: 0.9,
        reason: `ack phrase: "${ackMatch}"`,
      };
    }
    // Short but starts with a command lead is still a command.
    if (_startsWithCommand(normalized)) {
      return {
        kind: 'command',
        confidence: 0.7,
        reason: `short utterance starting with command verb`,
      };
    }
    return {
      kind: 'unclear',
      confidence: 0.3,
      reason: `short phrase, no clear match`,
    };
  }

  // Longer utterance -> probably a new command.
  if (_startsWithCommand(normalized)) {
    return {
      kind: 'command',
      confidence: 0.85,
      reason: `full command starting with "${normalized.split(/\s+/)[0]}"`,
    };
  }

  // Long utterance without a recognized command verb -- still most
  // likely a new task. Default to command with lower confidence.
  return {
    kind: 'command',
    confidence: 0.6,
    reason: `long utterance (${wc} words), default to command`,
  };
}

module.exports = {
  classifyBarge,
  STOP_PHRASES,
  ACK_PHRASES,
  COMMAND_LEAD_TOKENS,
  DEFAULT_THRESHOLDS,
};
