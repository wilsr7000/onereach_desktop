/**
 * Task Command Router (HUD Core)
 *
 * Pure text classifier that distinguishes "critical system commands"
 * (cancel the task, stop the TTS, repeat the last response, undo) from
 * "intent utterances that happen to contain those words" (e.g. "cancel
 * the meeting", "stop the recording", "repeat the introduction").
 *
 * The first category is handled by the local router immediately --
 * never routed to agents, never confirmed. The second is a normal
 * task that should go through the regular agent-routing pipeline.
 *
 * Key design constraint: getting this classifier WRONG in either
 * direction is bad UX. False positives cancel a real task ("stop the
 * alarm" would drop the pending alarm-setting task). False negatives
 * let "cancel" fall through to an agent that wastes a turn asking
 * "cancel what?". We err on the side of STRICT classification: only
 * the exact-critical phrase OR that phrase + a pronoun filler counts.
 *
 * PURE: no host dependencies, no I/O, deterministic on input. Safe
 * to call millions of times per second; no caching needed.
 */

'use strict';

/**
 * Exact phrases that ALWAYS count as a critical command, regardless
 * of what follows (only if they're the entire utterance).
 */
const EXACT_CRITICAL = Object.freeze([
  'cancel',
  'stop',
  'nevermind',
  'never mind',
  'repeat',
  'say that again',
  'undo',
  'undo that',
  'take that back',
]);

/**
 * Pronouns that, when they follow "cancel" or "stop", preserve the
 * critical-command interpretation:
 *
 *   "cancel it", "stop that", "stop now", "cancel everything"
 *
 * Without a pronoun, the verb most likely takes a direct object and
 * is an intent for an agent ("cancel the meeting", "stop the music").
 */
const PRONOUN_FOLLOWERS = Object.freeze([
  'it',
  'that',
  'this',
  'everything',
  'all',
  'now',
]);

/**
 * Verbs that trigger the pronoun-follower check. Kept separate from
 * EXACT_CRITICAL because "undo" / "repeat" stand alone but don't
 * compose with pronoun followers (e.g. "undo it" isn't meaningfully
 * different from "undo", both fire).
 */
const PRONOUN_ELIGIBLE_VERBS = Object.freeze(['cancel', 'stop']);

/**
 * Classify a user utterance as a critical command or not.
 *
 * @param {string} text - the user's utterance (post-STT, post-repair)
 * @returns {{
 *   critical: boolean,
 *   matched: string | null,
 *   pattern: 'exact' | 'verb-pronoun' | null
 * }}
 */
function classifyTaskCommand(text) {
  const normalized = _normalize(text);
  if (!normalized) {
    return { critical: false, matched: null, pattern: null };
  }

  if (EXACT_CRITICAL.includes(normalized)) {
    return { critical: true, matched: normalized, pattern: 'exact' };
  }

  for (const verb of PRONOUN_ELIGIBLE_VERBS) {
    const prefix = verb + ' ';
    if (!normalized.startsWith(prefix)) continue;
    const rest = normalized.slice(prefix.length).trim();
    if (PRONOUN_FOLLOWERS.includes(rest)) {
      return {
        critical: true,
        matched: `${verb} ${rest}`,
        pattern: 'verb-pronoun',
      };
    }
  }

  return { critical: false, matched: null, pattern: null };
}

/**
 * Convenience boolean shortcut for callers that only care about
 * the decision.
 * @param {string} text
 * @returns {boolean}
 */
function isCriticalCommand(text) {
  return classifyTaskCommand(text).critical;
}

/**
 * Lower-case + trim. Punctuation is preserved because "cancel!" is
 * still a critical command -- we'd strip trailing punctuation but
 * the upstream code has already handled it.
 *
 * We DO strip trailing punctuation here so "cancel." / "cancel!" /
 * "cancel?" all map to "cancel".
 */
function _normalize(text) {
  return (text || '')
    .toString()
    .toLowerCase()
    .replace(/[.!?]+$/, '')
    .trim();
}

module.exports = {
  classifyTaskCommand,
  isCriticalCommand,
  EXACT_CRITICAL,
  PRONOUN_FOLLOWERS,
  PRONOUN_ELIGIBLE_VERBS,
};
