/**
 * Echo Filter (Phase 4 / bargeIn)
 *
 * Rejects mic-heard audio that is almost certainly the device hearing
 * its own TTS playback instead of a real user interrupt. Runs as a
 * pure string comparison between a candidate user-speech partial and
 * the text the TTS is currently speaking; callers feed us both and
 * we return an echo verdict.
 *
 * This is intentionally simple. In production, a phase-correlated
 * echo canceller on the audio device is the primary defense; this
 * layer is a post-STT safety net against self-listening loops that
 * slip through (e.g. the speaker leaking into the mic picks up the
 * TTS as a fuzzy transcript).
 *
 * DESIGN:
 *   - Token-level Jaccard similarity between the two texts.
 *   - Short candidate + high overlap => echo.
 *   - Long candidate or unique tokens => user speech, not echo.
 *   - Known barge-in verbs ("stop", "wait", "cancel", "actually")
 *     can override the echo heuristic if they appear in the
 *     candidate but NOT in the TTS text -- we do not want users
 *     silenced by a rare overlap against TTS that happens to say
 *     "okay".
 *
 * RETURNS { isEcho, similarity, reason, nonEchoContent }:
 *   - isEcho:         final decision
 *   - similarity:     0..1 token Jaccard
 *   - reason:         short trace for logs
 *   - nonEchoContent: candidate text stripped of tokens that overlap
 *                     the current TTS. Useful downstream if we still
 *                     want to process whatever the user genuinely said
 *                     on top of an echo tail.
 */

'use strict';

// Hard barge markers -- if any of these appear in the user candidate
// but not in the TTS text, it's almost certainly a real interrupt
// regardless of other similarity.
const HARD_BARGE_TOKENS = new Set([
  'stop', 'wait', 'cancel', 'actually', 'hold', 'pause',
  'shut', 'quiet', 'enough', 'nevermind',
]);

const DEFAULT_THRESHOLDS = Object.freeze({
  // Above this Jaccard similarity, a short candidate is considered echo.
  echoSimilarity: 0.75,
  // Candidates longer than this many words need full overlap to be echo.
  shortCandidateMaxWords: 6,
  // Candidates at or below this word count with no overlap are treated
  // as ambiguous rather than speech (e.g. "uh" while TTS plays).
  noiseMaxWords: 1,
});

/**
 * @param {object} input
 * @param {string} input.candidate - user mic partial (possibly echo)
 * @param {string} input.ttsText   - current TTS text being spoken
 * @param {object} [input.thresholds]
 *
 * @returns {{
 *   isEcho: boolean,
 *   similarity: number,
 *   reason: string,
 *   nonEchoContent: string
 * }}
 */
function isLikelyEcho(input = {}) {
  const candidate = _normalize(input.candidate);
  const tts = _normalize(input.ttsText);
  const t = input.thresholds
    ? { ...DEFAULT_THRESHOLDS, ...input.thresholds }
    : DEFAULT_THRESHOLDS;

  if (!candidate) {
    return {
      isEcho: false,
      similarity: 0,
      reason: 'empty candidate',
      nonEchoContent: '',
    };
  }
  if (!tts) {
    return {
      isEcho: false,
      similarity: 0,
      reason: 'no TTS context -- not echo',
      nonEchoContent: candidate,
    };
  }

  const candTokens = _tokenize(candidate);
  const ttsTokens = _tokenize(tts);

  // Hard barge override: unique barge verb in candidate.
  for (const tok of candTokens) {
    if (HARD_BARGE_TOKENS.has(tok) && !ttsTokens.has(tok)) {
      return {
        isEcho: false,
        similarity: 0,
        reason: `hard barge token "${tok}" present in user speech but not in TTS`,
        nonEchoContent: candidate,
      };
    }
  }

  const similarity = _jaccard(candTokens, ttsTokens);
  const nonEchoContent = _stripOverlap(candidate, candTokens, ttsTokens);
  const wordCount = candTokens.size;

  // Primary heuristic: if every word in the candidate also appears in
  // the TTS text, the mic is almost certainly catching TTS leakage.
  // This covers the common case where a short phrase the TTS is
  // speaking gets picked up verbatim, with or without extra padding.
  if (_allTokensOverlap(candTokens, ttsTokens)) {
    return {
      isEcho: true,
      similarity,
      reason: `every candidate token (${wordCount}) present in TTS`,
      nonEchoContent: '',
    };
  }

  // Secondary heuristic: short candidate with high Jaccard overlap is
  // likely the mic hearing TTS plus a bit of noise that didn't match.
  if (wordCount <= t.shortCandidateMaxWords && similarity >= t.echoSimilarity) {
    return {
      isEcho: true,
      similarity,
      reason: `short candidate (${wordCount} words) sim=${similarity.toFixed(2)} >= ${t.echoSimilarity}`,
      nonEchoContent,
    };
  }

  return {
    isEcho: false,
    similarity,
    reason: `below echo threshold (sim=${similarity.toFixed(2)})`,
    nonEchoContent,
  };
}

// ==================== HELPERS ====================

function _normalize(s) {
  return (s || '').toString().toLowerCase().replace(/[.,!?;:'"()\-]/g, '').trim();
}

function _tokenize(s) {
  const set = new Set();
  for (const w of s.split(/\s+/)) {
    if (w) set.add(w);
  }
  return set;
}

function _jaccard(a, b) {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

function _allTokensOverlap(candTokens, ttsTokens) {
  if (candTokens.size === 0) return false;
  for (const t of candTokens) {
    if (!ttsTokens.has(t)) return false;
  }
  return true;
}

function _stripOverlap(candidate, candTokens, ttsTokens) {
  const result = [];
  for (const w of candidate.split(/\s+/)) {
    const norm = w.toLowerCase();
    if (candTokens.has(norm) && ttsTokens.has(norm)) continue;
    result.push(w);
  }
  return result.join(' ').trim();
}

module.exports = {
  isLikelyEcho,
  HARD_BARGE_TOKENS,
  DEFAULT_THRESHOLDS,
};
