/**
 * Affect Classifier (Phase 6)
 *
 * Text-only classification of the user's current affect from their
 * most recent utterance plus lightweight context. Returns a label +
 * confidence + the signals that drove the decision.
 *
 *   classifyAffect({ text, recentErrors, recentRepeat })
 *     -> { label, confidence, signals }
 *
 * Labels (6):
 *   neutral      - default; no strong signal
 *   rushed       - user wants a quick answer ("quick", "hurry", caps, very terse)
 *   frustrated   - user is annoyed (profanity, sighs, repeated-request, recent errors)
 *   excited      - user is energized ("yes!", "awesome!!", "finally")
 *   hesitant     - user is uncertain ("um", "I guess", hedging)
 *   deliberate   - user is exploring / careful (verbose, "could you show me", details)
 *
 * Design principles:
 *   - CONSERVATIVE: neutral is the default. Non-neutral labels require
 *     strong, unambiguous signals. False positives in this classifier
 *     feel weirder than false negatives (user says "I'm fine" and the
 *     assistant suddenly gets sympathetic), so we prefer to under-fire.
 *   - PURE: no network, no LLM, no randomness. Deterministic on input.
 *   - OBSERVABLE: the returned `signals[]` explains what triggered the
 *     label, useful for debugging + user trust.
 *   - RANK-BASED: when multiple labels match, an explicit priority
 *     resolves ties so callers get predictable output.
 */

'use strict';

// ---------- LEXICONS ----------

// Strong-frustration signals. One match from this set is enough.
const FRUSTRATION_STRONG = new Set([
  'damn', 'damnit', 'dammit', 'goddamn', 'shit', 'fuck', 'fucking', 'bullshit',
  'wtf', 'ffs', 'ugh', 'argh', 'grr',
]);

// Mild-frustration signals. Need 2+ signals OR pairing with other cues.
const FRUSTRATION_MILD = new Set([
  'seriously', 'really', 'finally', 'again', 'still',
  'annoying', 'frustrating', 'ridiculous', 'useless',
  'broken', 'wrong', 'hate',
]);

// Excitement signals (positive high-energy).
const EXCITEMENT_WORDS = new Set([
  'yes', 'yay', 'yess', 'yesss', 'yeah', 'woohoo', 'whoo',
  'awesome', 'amazing', 'great', 'wonderful', 'perfect', 'fantastic',
  'nice', 'cool', 'sweet', 'love', 'loved', 'loving', 'excellent',
  'brilliant', 'beautiful', 'finally',
]);

// Rushed signals: explicit time pressure or abbreviation markers.
const RUSHED_WORDS = new Set([
  'quick', 'quickly', 'hurry', 'fast', 'now', 'asap', 'immediately',
  'rapidly', 'speedy', 'right-now',
]);

// Hesitation / hedging markers.
const HEDGE_WORDS = new Set([
  'um', 'uh', 'uhh', 'umm', 'hmm', 'er', 'erm',
  'maybe', 'perhaps', 'possibly', 'kinda', 'sorta',
  'guess', 'probably', 'might',
]);

// Deliberation signals: verbose / exploratory phrasing fragments.
const DELIBERATE_PHRASES = [
  /\bcould you (?:show|tell|explain|walk|help|describe)\b/i,
  /\bwhat (?:are|is) the (?:options|differences|details|tradeoffs|trade-offs)\b/i,
  /\bhow (?:do|does|would|should) (?:i|we|you)\b/i,
  /\bcan you (?:show|tell|explain|walk|help|describe|compare)\b/i,
  /\bwhat if\b/i,
];

// ---------- MAIN ----------

/**
 * @param {object} [input]
 * @param {string} [input.text]           - user utterance
 * @param {number} [input.recentErrors]   - count of error-marked turns in recent history
 * @param {boolean} [input.recentRepeat]  - true if user just repeated an earlier utterance
 * @returns {{label: string, confidence: number, signals: string[]}}
 */
function classifyAffect(input = {}) {
  const text = (input.text || '').toString();
  const recentErrors = Number.isFinite(input.recentErrors) ? input.recentErrors : 0;
  const recentRepeat = Boolean(input.recentRepeat);

  const signals = [];
  const tokens = _tokenize(text);
  const tokenSet = new Set(tokens);

  // -------- FRUSTRATION --------
  // Strong signals fire directly. Mild signals need corroboration.
  let frustrationScore = 0;
  const hasStrongFrustration = tokens.some((t) => FRUSTRATION_STRONG.has(t));
  if (hasStrongFrustration) {
    frustrationScore += 3;
    signals.push('profanity-or-exclaim');
  }
  const mildHits = tokens.filter((t) => FRUSTRATION_MILD.has(t));
  if (mildHits.length > 0) {
    // Cap at 3 so a single-word utterance can't dominate, but let
    // "really annoying and frustrating" (3 hits) reach MIN_SCORE.
    frustrationScore += Math.min(mildHits.length, 3);
    if (mildHits.length >= 2) {
      signals.push(`mild-frustration-words:${mildHits.join(',')}`);
    }
  }
  if (recentErrors >= 2) {
    frustrationScore += 2;
    signals.push(`recent-errors:${recentErrors}`);
  } else if (recentErrors === 1) {
    frustrationScore += 1;
  }
  if (recentRepeat) {
    frustrationScore += 2;
    signals.push('repeated-request');
  }
  // "why isn't it working" / "why does this" / "stop doing that"
  if (/\bwhy (?:is|isn't|doesn't|can't|won't|does)\b/i.test(text)) {
    frustrationScore += 1;
  }
  if (/\bstop (?:doing|saying|asking|that)\b/i.test(text)) {
    frustrationScore += 3;
    signals.push('stop-doing');
  }

  // -------- EXCITEMENT --------
  let excitementScore = 0;
  const excitedHits = tokens.filter((t) => EXCITEMENT_WORDS.has(t));
  if (excitedHits.length > 0) {
    excitementScore += excitedHits.length === 1 ? 1 : 2;
    signals.push(`excitement-words:${excitedHits.join(',')}`);
  }
  const bangCount = (text.match(/!/g) || []).length;
  if (bangCount >= 2) {
    excitementScore += 2;
    signals.push(`exclamations:${bangCount}`);
  } else if (bangCount === 1) {
    excitementScore += 1;
  }
  // Excitement usually has positive + exclaim. Caps alone is rushed,
  // not excited.
  if (/[A-Z]{3,}/.test(text) && bangCount > 0 && excitedHits.length > 0) {
    excitementScore += 1;
    signals.push('positive-caps');
  }

  // -------- RUSHED --------
  let rushedScore = 0;
  const rushedHits = tokens.filter((t) => RUSHED_WORDS.has(t));
  if (rushedHits.length > 0) {
    // Explicit rush words are strong enough to fire on their own.
    rushedScore += 3;
    signals.push(`rushed-words:${rushedHits.join(',')}`);
  }
  // ALL CAPS without being excited suggests urgency / rushed.
  if (/^[A-Z !?'.,-]{4,}$/.test(text.trim()) && text.trim().length > 3) {
    rushedScore += 2;
    signals.push('all-caps');
  }
  // Very terse utterance (1-3 tokens) with imperative flavor.
  if (tokens.length <= 3 && tokens.length > 0 && _isImperative(tokens)) {
    rushedScore += 1;
  }

  // -------- HESITANT --------
  let hesitantScore = 0;
  const hedgeHits = tokens.filter((t) => HEDGE_WORDS.has(t));
  if (hedgeHits.length >= 2) {
    hesitantScore += 2;
    signals.push(`hedges:${hedgeHits.join(',')}`);
  } else if (hedgeHits.length === 1) {
    hesitantScore += 1;
  }
  // Statement ending in "?" - uncertainty about a fact.
  if (text.trim().endsWith('?') && !/^(?:what|when|where|who|why|how|which|can|could|is|are|do|does)\b/i.test(text.trim())) {
    hesitantScore += 1;
    signals.push('statement-question');
  }
  // "I think" / "I suppose" / "sort of"
  if (/\bi (?:think|suppose|guess|feel like|wonder)\b/i.test(text)) {
    hesitantScore += 1;
  }

  // -------- DELIBERATE --------
  let deliberateScore = 0;
  if (tokens.length >= 15) {
    deliberateScore += 1;
    signals.push(`verbose:${tokens.length}`);
  }
  for (const pat of DELIBERATE_PHRASES) {
    if (pat.test(text)) {
      deliberateScore += 2;
      signals.push(`deliberate-phrase:${pat.source.slice(0, 30)}`);
      break;
    }
  }

  // -------- RESOLUTION --------
  // Required confidence thresholds (conservative - keep neutral default).
  const MIN_SCORE = 3;

  const candidates = [
    { label: 'frustrated', score: frustrationScore, priority: 10 },
    { label: 'rushed', score: rushedScore, priority: 8 },
    { label: 'excited', score: excitementScore, priority: 7 },
    { label: 'hesitant', score: hesitantScore, priority: 5 },
    { label: 'deliberate', score: deliberateScore, priority: 3 },
  ];

  const eligible = candidates.filter((c) => c.score >= MIN_SCORE);
  if (eligible.length === 0) {
    return {
      label: 'neutral',
      confidence: 1 - (_maxScore(candidates) / (MIN_SCORE + 1)),
      signals,
    };
  }

  eligible.sort((a, b) => b.score - a.score || b.priority - a.priority);
  const winner = eligible[0];
  const confidence = Math.min(1, winner.score / 6);
  return { label: winner.label, confidence, signals };
}

// ---------- HELPERS ----------

function _tokenize(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[.,;:!?"'()\-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function _maxScore(candidates) {
  return candidates.reduce((m, c) => Math.max(m, c.score), 0);
}

const IMPERATIVE_HEADS = new Set([
  'stop', 'go', 'pause', 'play', 'skip', 'cancel', 'quit', 'exit',
  'yes', 'no', 'next', 'back', 'help', 'done',
]);
function _isImperative(tokens) {
  return tokens.length > 0 && IMPERATIVE_HEADS.has(tokens[0]);
}

module.exports = { classifyAffect };
