/**
 * Response Modifier (Phase 6)
 *
 * Transforms an outgoing assistant message to match the user's
 * detected affect. Pure function, safe to call on every TTS text.
 *
 *   adjustResponse({ text, affect, rng })
 *     -> { text, modified, transforms }
 *
 * Behavior by affect label:
 *   frustrated  - prepend brief empathy ("Got it -- "), strip filler openings
 *   rushed      - aggressive filler-strip, cap at 2 sentences
 *   excited     - prepend energy-match phrase ("Nice! ") at most once
 *   hesitant    - no change (scaffolding handled elsewhere; avoid
 *                 adding words that could feel patronising)
 *   deliberate  - no change (preserve verbosity)
 *   neutral     - no change
 *   unknown     - no change
 *
 * The modifier is deliberately conservative:
 *   - NEVER rewrites meaningful content, only trims filler / prepends
 *   - NEVER adds a prefix that's already present (idempotent-ish)
 *   - Returns { modified: false } when no change was made, so callers
 *     can skip logging noise
 *
 * Deterministic: pass in `rng` (default Math.random) for test control.
 */

'use strict';

// ---------- FILLER OPENINGS TO STRIP ----------
// Matched at the very START of the response (case-insensitive).
// Trailing separator (",", ":", optional space) is also eaten.
const FILLER_OPENINGS = [
  /^ok(?:ay)?,?\s+(?:so|let me|let's|i'll|i will)\s+/i,
  /^sure,?\s+(?:i'll|i can|let me|thing|thing is)\s+/i,
  /^alright,?\s+(?:so|let me|let's)\s+/i,
  /^well,?\s+/i,
  /^so,?\s+(?:let me|i'll|first)\s+/i,
  /^let me\s+(?:see|check|think|find)\s+/i,
  /^i'll\s+(?:go ahead and|now|just)\s+/i,
  /^going to\s+/i,
  /^i\s+am\s+going\s+to\s+/i,
];

// ---------- EMPATHY PREFIXES (frustrated) ----------
const EMPATHY_PREFIXES = [
  'Got it - ',
  'No problem - ',
  'Right - ',
  'On it - ',
];

// ---------- ENERGY PREFIXES (excited) ----------
const ENERGY_PREFIXES = [
  'Nice! ',
  'Awesome! ',
  'Great! ',
  'Love it! ',
];

/**
 * Detects whether the text already opens with any of a list of
 * prefixes (case-insensitive). Used to keep the modifier idempotent.
 */
function _alreadyStartsWithAny(text, prefixes) {
  const lower = text.trim().toLowerCase();
  for (const p of prefixes) {
    if (lower.startsWith(p.trim().toLowerCase())) return true;
  }
  return false;
}

function _stripFillerOpening(text) {
  const trimmed = text.replace(/^\s+/, '');
  for (const pat of FILLER_OPENINGS) {
    if (pat.test(trimmed)) {
      return trimmed.replace(pat, '');
    }
  }
  return trimmed;
}

function _capSentences(text, n) {
  if (!text) return text;
  // Split on sentence-enders while keeping the punctuation attached.
  const matches = text.match(/[^.!?]+[.!?]+\s*/g);
  if (!matches || matches.length <= n) return text;
  return matches.slice(0, n).join('').trim();
}

function _pick(arr, rng) {
  const r = typeof rng === 'function' ? rng() : Math.random();
  return arr[Math.min(arr.length - 1, Math.floor(r * arr.length))];
}

/**
 * @param {object} input
 * @param {string} input.text                 - outgoing assistant text
 * @param {{label:string}|null} [input.affect]- current user affect
 * @param {() => number} [input.rng]          - deterministic rng for tests
 * @returns {{text:string, modified:boolean, transforms:string[]}}
 */
function adjustResponse(input = {}) {
  const originalText = (input.text || '').toString();
  const affect = input.affect && input.affect.label ? input.affect : null;
  const rng = input.rng;

  if (!originalText || !affect) {
    return { text: originalText, modified: false, transforms: [] };
  }

  const transforms = [];
  let working = originalText;

  switch (affect.label) {
    case 'frustrated': {
      const stripped = _stripFillerOpening(working);
      if (stripped !== working) {
        working = stripped;
        transforms.push('strip-filler');
      }
      if (!_alreadyStartsWithAny(working, EMPATHY_PREFIXES)) {
        const prefix = _pick(EMPATHY_PREFIXES, rng);
        working = prefix + working.charAt(0).toLowerCase() + working.slice(1);
        transforms.push('prepend-empathy');
      }
      break;
    }
    case 'rushed': {
      const stripped = _stripFillerOpening(working);
      if (stripped !== working) {
        working = stripped;
        transforms.push('strip-filler');
      }
      const capped = _capSentences(working, 2);
      if (capped !== working) {
        working = capped;
        transforms.push('cap-sentences:2');
      }
      break;
    }
    case 'excited': {
      if (!_alreadyStartsWithAny(working, ENERGY_PREFIXES)) {
        const prefix = _pick(ENERGY_PREFIXES, rng);
        working = prefix + working;
        transforms.push('prepend-energy');
      }
      break;
    }
    case 'hesitant':
    case 'deliberate':
    case 'neutral':
    default:
      // Intentional no-ops.
      break;
  }

  if (working === originalText) {
    return { text: originalText, modified: false, transforms: [] };
  }
  return { text: working, modified: true, transforms };
}

module.exports = { adjustResponse };
