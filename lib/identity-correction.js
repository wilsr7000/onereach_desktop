/**
 * Identity Correction
 *
 * Detects when the user is correcting a location (or other identity
 * fact) the system got wrong, applies the correction, and returns a
 * spoken acknowledgement the orb can speak back.
 *
 * Two kinds of corrections matter:
 *
 *   1. RETRACT only        "I don't live in Las Vegas"
 *                          "I'm not in Berkeley right now"
 *                          "I don't live there anymore"
 *                          -> Clear the stored value. Fall back to live
 *                             location service (precise > IP > stored).
 *                             If live returns a city, use that. If not,
 *                             ask the user.
 *
 *   2. RETRACT + ASSERT    "Not Vegas, I'm in Portland"
 *                          "I'm actually in San Francisco"
 *                          "I live in Austin, not Denver"
 *                          -> Clear the old value, write the new one.
 *                             Explicit first-person assertion required.
 *
 * This runs BEFORE normal agent routing in processSubmit, same pattern
 * as the negative-feedback shortcut. Deterministic (regex + live
 * location), no LLM call, so it reacts instantly.
 *
 * Exports:
 *   detectIdentityCorrection(text) -> { type, retractedValue, assertedValue, field } | null
 *   applyIdentityCorrection(detection, { locationService, userProfile }) -> { spokenResponse, actions }
 */

'use strict';

const { getLogQueue } = require('./log-event-queue');

const log = getLogQueue();

// Phrases that indicate the user is correcting their location. Ordered
// longest-first so more specific patterns win.
const RETRACTION_PATTERNS = [
  // "I don't live in Las Vegas anymore" / "I don't live there anymore"
  {
    pattern: /\bi\s+don'?t\s+live\s+(in|at)\s+(.+?)(?:\s+anymore)?[.?!]?$/i,
    extractRetracted: (m) => m[2].trim(),
    field: 'Home City',
  },
  {
    pattern: /\bi\s+don'?t\s+live\s+there\s+anymore[.?!]?$/i,
    extractRetracted: (_m) => '*',   // "*" = whatever's stored
    field: 'Home City',
  },
  // "I'm not in Berkeley" / "I'm not in Berkeley right now"
  {
    pattern: /\bi'?m\s+not\s+(in|at)\s+(.+?)(?:\s+(?:right\s+now|anymore|currently))?[.?!]?$/i,
    extractRetracted: (m) => m[2].trim(),
    field: 'Home City',
  },
  // "I moved away from Vegas"
  {
    pattern: /\bi\s+moved\s+away\s+from\s+(.+?)[.?!]?$/i,
    extractRetracted: (m) => m[1].trim(),
    field: 'Home City',
  },
];

// Positive assertion patterns that can be paired with a retraction
// (or stand alone as an identity update).
const ASSERTION_PATTERNS = [
  // "I'm in Portland now" / "I'm actually in Portland" / "I'm in Portland right now"
  /\bi'?m\s+(?:actually\s+|currently\s+|presently\s+)?(?:in|at)\s+(.+?)(?:\s+(?:now|right\s+now|currently))?[.?!]?$/i,
  // "I live in Portland [now]"
  /\bi\s+live\s+(?:in|at)\s+(.+?)(?:\s+now)?[.?!]?$/i,
  // "I moved to Portland"
  /\bi\s+(?:just\s+|recently\s+)?moved\s+to\s+(.+?)[.?!]?$/i,
];

// Connector phrases that link a retraction to an assertion, e.g.
// "Not Vegas, I'm in Portland" or "I don't live in Vegas. I live in Reno".
const COMBINED_CORRECTION_PATTERNS = [
  // "Not X, I'm in Y" / "It's not X, I'm in Y"
  /\b(?:it'?s\s+)?not\s+(.+?),?\s+(?:i'?m|i\s+am|i\s+live)\s+(?:in|at)\s+(.+?)[.?!]?$/i,
  // "I live in Y, not X"
  /\bi\s+live\s+(?:in|at)\s+(.+?),?\s+not\s+(.+?)[.?!]?$/i,
];

// Small list of common noise words we strip from extracted values.
const STRIP_TRAILING = /\s+(right\s+now|anymore|currently|presently|though|either)$/i;

function _cleanValue(v) {
  if (!v) return '';
  let s = String(v).trim();
  // Strip surrounding punctuation
  s = s.replace(/^[,."'`]+|[,."'`]+$/g, '').trim();
  // Strip trailing noise adverbs ("anymore", "right now", ...).
  while (STRIP_TRAILING.test(s)) s = s.replace(STRIP_TRAILING, '').trim();
  // Strip a leading preposition that sometimes gets captured by the
  // combined retract-and-assert pattern (e.g. captured "in Berkeley"
  // instead of "Berkeley").
  s = s.replace(/^(in|at|from|to)\s+/i, '').trim();
  return s;
}

/**
 * Inspect a user utterance and decide whether it's a location correction.
 * Returns null for non-corrections.
 *
 * @param {string} text  Raw user transcript
 * @returns {{ type: 'retract-only' | 'retract-and-assert', retractedValue: string, assertedValue: ?string, field: string } | null}
 */
function detectIdentityCorrection(text) {
  if (!text) return null;
  const trimmed = String(text).trim();
  if (!trimmed) return null;

  // 1. Combined retract-and-assert in one sentence.
  for (const pat of COMBINED_CORRECTION_PATTERNS) {
    const m = trimmed.match(pat);
    if (m) {
      // The two patterns have retracted / asserted in different capture groups.
      // Pattern 1: "Not X, I'm in Y"  -> [1]=X retracted, [2]=Y asserted
      // Pattern 2: "I live in Y, not X" -> [1]=Y asserted, [2]=X retracted
      const isYFirst = pat === COMBINED_CORRECTION_PATTERNS[1];
      const retracted = _cleanValue(isYFirst ? m[2] : m[1]);
      const asserted = _cleanValue(isYFirst ? m[1] : m[2]);
      if (retracted && asserted) {
        return {
          type: 'retract-and-assert',
          retractedValue: retracted,
          assertedValue: asserted,
          field: 'Home City',
        };
      }
    }
  }

  // 2. Standalone retraction. Look for a retraction pattern first; then
  //    check whether the same message also contains an assertion that
  //    isn't the retracted value.
  let retraction = null;
  for (const spec of RETRACTION_PATTERNS) {
    const m = trimmed.match(spec.pattern);
    if (m) {
      retraction = {
        retractedValue: _cleanValue(spec.extractRetracted(m)),
        field: spec.field,
      };
      break;
    }
  }

  if (retraction) {
    // Also try an assertion pattern to see if the user supplied a new value.
    let assertedValue = null;
    for (const pat of ASSERTION_PATTERNS) {
      const m = trimmed.match(pat);
      if (m) {
        const candidate = _cleanValue(m[1]);
        // Don't treat the retracted value as the assertion.
        if (
          candidate &&
          candidate.toLowerCase() !== retraction.retractedValue.toLowerCase()
        ) {
          assertedValue = candidate;
          break;
        }
      }
    }
    return {
      type: assertedValue ? 'retract-and-assert' : 'retract-only',
      retractedValue: retraction.retractedValue,
      assertedValue,
      field: retraction.field,
    };
  }

  return null;
}

/**
 * Apply a detected correction.
 *
 * Steps:
 *   - Clear the stored profile value (always).
 *   - If the user asserted a new value, write it.
 *   - Otherwise, consult the live location service. If it has a city,
 *     write that. Else, leave the field empty.
 *   - Build a one-sentence spoken response summarizing what happened.
 *
 * Pure side-effects except for the two services, which are
 * dependency-injected so this function stays testable.
 *
 * @param {Object} detection  Output from detectIdentityCorrection
 * @param {Object} deps
 *   @param {Object} deps.userProfile - object with updateFact(key, value), save()
 *   @param {Object} deps.locationService - optional, object with getLocation()
 * @returns {Promise<{ spokenResponse: string, actions: string[] }>}
 */
async function applyIdentityCorrection(detection, { userProfile, locationService } = {}) {
  if (!detection) return { spokenResponse: '', actions: [] };

  const actions = [];
  let finalValue = null;
  let liveCityUsed = false;

  // Clear the stored value unconditionally.
  if (userProfile) {
    try {
      userProfile.updateFact(detection.field, '(not yet learned)');
      actions.push(`cleared stored ${detection.field}="${detection.retractedValue}"`);
    } catch (err) {
      log.warn('app', '[IdentityCorrection] clear failed', { error: err.message });
    }
  }

  // If the user asserted a new value, use it.
  if (detection.assertedValue) {
    finalValue = detection.assertedValue;
    if (userProfile) {
      try {
        userProfile.updateFact(detection.field, finalValue);
        actions.push(`set ${detection.field}="${finalValue}" from user assertion`);
      } catch (err) {
        log.warn('app', '[IdentityCorrection] assert failed', { error: err.message });
      }
    }
  } else if (locationService && typeof locationService.getLocation === 'function') {
    // Otherwise, try live location service.
    try {
      const live = await locationService.getLocation({ refresh: true });
      if (live && live.city && live.source !== 'unknown' && live.source !== 'stored') {
        finalValue = live.city;
        liveCityUsed = true;
        if (userProfile) {
          try {
            userProfile.updateFact(detection.field, finalValue);
            actions.push(`set ${detection.field}="${finalValue}" from live location (${live.source})`);
          } catch (err) {
            log.warn('app', '[IdentityCorrection] live-write failed', { error: err.message });
          }
        }
      }
    } catch (err) {
      log.warn('app', '[IdentityCorrection] location lookup failed', { error: err.message });
    }
  }

  if (userProfile && typeof userProfile.save === 'function') {
    try { await userProfile.save(); } catch (err) {
      log.warn('app', '[IdentityCorrection] save failed', { error: err.message });
    }
  }

  // Build spoken response.
  let spokenResponse;
  if (finalValue && liveCityUsed) {
    spokenResponse = `Got it -- I've updated your location to ${finalValue} based on where you are now.`;
  } else if (finalValue) {
    spokenResponse = `Got it -- I've updated your location to ${finalValue}.`;
  } else if (detection.retractedValue && detection.retractedValue !== '*') {
    spokenResponse = `Got it, you're not in ${detection.retractedValue}. Where are you right now?`;
  } else {
    spokenResponse = `Got it, I've cleared that. Where are you right now?`;
  }

  log.info('app', '[IdentityCorrection] Applied', {
    type: detection.type,
    retracted: detection.retractedValue,
    asserted: detection.assertedValue,
    finalValue,
    liveCityUsed,
  });

  return { spokenResponse, actions, finalValue, liveCityUsed };
}

module.exports = {
  detectIdentityCorrection,
  applyIdentityCorrection,
};
