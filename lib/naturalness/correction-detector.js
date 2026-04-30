/**
 * Correction Detector (Phase 5 / repairMemory)
 *
 * Given the user's latest utterance and the one immediately prior,
 * decide whether the latest is a correction of the prior, and if so
 * extract {heard, meant} so the repair-memory module can learn it.
 *
 * Handles several common English correction patterns:
 *
 *   "I meant X"            -> heard from prior, meant from X
 *   "no, I said X"         -> same
 *   "I said X not Y"       -> heard = Y, meant = X
 *   "not Y, X"             -> heard = Y, meant = X
 *   "actually X"           -> heard from prior, meant from X
 *
 * When the correction is too vague to map a specific token, returns
 * null so we don't poison the repair memory with phantom fixes.
 *
 * The detector is a pure regex-driven heuristic -- no LLM calls.
 * Cheap, deterministic, and good enough to catch the obvious cases.
 * Nuanced cases (multi-word meant/heard) should feed into an LLM-
 * backed detector in a later phase; that work is scoped out here.
 */

'use strict';

/**
 * @param {string} latestUtterance  - what the user just said
 * @param {string} [priorUtterance] - what was said immediately before (may be empty)
 * @returns {{heard: string, meant: string, pattern: string}|null}
 */
function detectCorrection(latestUtterance, priorUtterance = '') {
  const latest = _normalize(latestUtterance);
  const prior = _normalize(priorUtterance);
  if (!latest) return null;

  // Strip trailing punctuation so lazy anchors don't swallow the
  // last capture group for common-case "." / "!" endings.
  const body = latest.replace(/[.!?]+\s*$/, '').trim();

  // --- Pattern 1: "I said X not Y" or "I meant X not Y" ---
  // Two-slot explicit correction, doesn't need priorUtterance.
  let m = body.match(/^(?:i\s+(?:said|meant)|no,?\s+i\s+(?:said|meant))\s+(.+?)\s+not\s+(.+)$/i);
  if (m) {
    return { heard: _trim(m[2]), meant: _trim(m[1]), pattern: 'I-said-X-not-Y' };
  }

  // --- Pattern 2: "not Y, X" or "not Y I meant X" ---
  m = body.match(/^not\s+(.+?)(?:,\s*|\s+i\s+(?:meant|said)\s+)(.+)$/i);
  if (m) {
    return { heard: _trim(m[1]), meant: _trim(m[2]), pattern: 'not-Y-X' };
  }

  // --- Pattern 3: "I meant X" -- needs priorUtterance to diff against ---
  m = body.match(/^(?:i\s+(?:meant|said)|no,?\s+i\s+(?:meant|said))\s+(.+)$/i);
  if (m) {
    const meant = _trim(m[1]);
    const heard = _diffFromPrior(prior, meant);
    if (heard) return { heard, meant, pattern: 'I-meant-X' };
  }

  // --- Pattern 4: "actually X" -- needs priorUtterance ---
  m = body.match(/^actually,?\s+(.+)$/i);
  if (m) {
    const meant = _trim(m[1]);
    const heard = _diffFromPrior(prior, meant);
    if (heard) return { heard, meant, pattern: 'actually-X' };
  }

  // --- Pattern 5: "no it's X" / "no that was X" / "no that's X" ---
  // Note: longer alternatives first so "that was" isn't shadowed by
  // "that's" / bare "that".
  m = body.match(/^no,?\s+(?:that\s+was|it[''s]*|that[''s]*)\s+(.+)$/i);
  if (m) {
    const meant = _trim(m[1]);
    const heard = _diffFromPrior(prior, meant);
    if (heard) return { heard, meant, pattern: 'no-its-X' };
  }

  return null;
}

// ==================== HELPERS ====================

function _normalize(s) {
  return (s || '').toString().trim();
}

function _trim(s) {
  return (s || '').trim().replace(/\s+/g, ' ');
}

// Common command verbs / stopwords to skip when picking the heard
// token. The user's correction almost always targets a CONTENT word
// (name / noun / proper noun), not the imperative verb.
const SKIP_TOKENS = new Set([
  'play', 'pause', 'stop', 'start', 'skip', 'call', 'send', 'email',
  'text', 'message', 'open', 'close', 'show', 'tell', 'find', 'search',
  'schedule', 'book', 'create', 'add', 'set', 'turn', 'toggle',
  'remind', 'delete', 'remove', 'cancel', 'a', 'an', 'the', 'to',
  'of', 'for', 'with', 'on', 'at', 'in', 'from', 'my', 'me', 'some',
]);

/**
 * Given the prior utterance and the user's stated correction, find
 * the token in the prior that the "meant" value should replace.
 *
 * Strategy: ignore any tokens that already appear in `meant`, strip
 * common command verbs / stopwords, then return the LAST remaining
 * token (proper nouns / names are typically the tail of an
 * imperative). If nothing qualifies, return null.
 *
 * @param {string} prior
 * @param {string} meant
 * @returns {string|null}
 */
function _diffFromPrior(prior, meant) {
  if (!prior) return null;
  const meantTokens = new Set(_tokenize(meant));
  const candidates = _tokenize(prior).filter(
    (t) => !meantTokens.has(t) && !SKIP_TOKENS.has(t)
  );
  if (candidates.length === 0) return null;
  return candidates[candidates.length - 1];
}

function _tokenize(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[.,!?;:'"()\-]/g, '')
    .split(/\s+/)
    .filter(Boolean);
}

// ==================== UNDO DETECTOR ====================

/**
 * Undo-intent patterns. The user is asking us to roll back the most
 * recent learned fix (or a specific fix by name). We are deliberately
 * conservative -- only very clear undo phrasings match, so casual
 * "never mind" in other contexts (like cancelling a request) still
 * routes to the task agent.
 *
 * Patterns (all anchored, optional "please" / trailing punctuation):
 *
 *   forget that fix
 *   forget that correction
 *   forget the last fix / correction
 *   forget what you learned
 *   undo that fix / correction / that last fix
 *   undo the last fix / correction
 *   never mind that fix / correction / that last fix
 *   never mind, forget it                -> only when paired with "fix"/"correction"
 *   that was wrong, forget it            -> only when paired with "fix"/"correction"
 */
const UNDO_PATTERNS = [
  /^(?:please\s+)?forget\s+(?:that|the|my)\s*(?:last\s+)?(?:fix|correction|learning|rule)s?\s*[.!?]?$/i,
  /^(?:please\s+)?forget\s+what\s+you\s+(?:learned|learnt)\s*[.!?]?$/i,
  /^(?:please\s+)?undo\s+(?:that|the|my)\s*(?:last\s+)?(?:fix|correction|learning|rule)s?\s*[.!?]?$/i,
  /^never\s+mind\s+(?:that|the|my)\s*(?:last\s+)?(?:fix|correction|learning|rule)s?\s*[.!?]?$/i,
  /^(?:that|the)\s+(?:last\s+)?(?:fix|correction|learning|rule)s?\s+(?:was|were|is|are)\s+wrong\s*[.!?]?$/i,
];

/**
 * Detect whether the user is asking to undo the most recent learn.
 * @param {string} text
 * @returns {{undo: true, pattern: string}|null}
 */
function detectUndoCorrection(text) {
  const body = (text || '').toString().trim();
  if (!body) return null;
  for (const pat of UNDO_PATTERNS) {
    if (pat.test(body)) {
      return { undo: true, pattern: pat.source };
    }
  }
  return null;
}

module.exports = { detectCorrection, detectUndoCorrection };
