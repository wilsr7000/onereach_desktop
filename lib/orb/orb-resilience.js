/**
 * Orb Resilience - guarantees the voice orb never ends a turn in silence.
 *
 * "Smooth but did nothing" is the failure this closes: the orb hears the
 * user, dispatches the request, then the answer never arrives (agent hung,
 * result path broke, socket dropped) and the orb's processing/session
 * watchdog silently force-idles. The user is left with no audio, no error,
 * no cue.
 *
 * These pure helpers classify the *reason* an orb turn ended and produce a
 * short spoken fallback for the dead-end cases, so the idle-entry handler in
 * orb.html can always say something. Extracted so the policy is unit-tested
 * in isolation. Loaded as a <script> in orb.html (window.OrbResilience) and
 * required directly by tests (module.exports).
 */

'use strict';

(function () {
  // Reasons that mean "we dispatched a request but nothing came back". These
  // are the silent dead-ends we must voice. Connection/mic setup failures and
  // normal completions/user-stops are intentionally excluded -- they already
  // have their own visible handling, and voicing them would be noise.
  const DEAD_END_REASONS = new Set([
    'processing-timeout', // agent never answered within the processing budget
    'session-timeout', // the whole session aged out mid-turn
    'ws-reconnect-timeout', // realtime dropped and never recovered mid-turn
  ]);

  /**
   * @param {string} reason - the transition reason that drove the orb to idle
   * @returns {boolean} true when the turn dead-ended with no answer delivered
   */
  function isDeadEndReason(reason) {
    return DEAD_END_REASONS.has(reason);
  }

  /**
   * Short, friendly spoken fallback for a dead-ended turn. Kept generic (no
   * blame, no jargon) and phrased to invite a retry.
   *
   * @param {string} reason
   * @returns {string}
   */
  function deadEndMessage(reason) {
    if (reason === 'ws-reconnect-timeout') {
      return "Sorry, my connection dropped before I could answer. Please try again.";
    }
    // processing-timeout / session-timeout and any future dead-end reason
    return "Sorry, I didn't get a response to that. Please try again.";
  }

  const api = { isDeadEndReason, deadEndMessage, DEAD_END_REASONS };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    window.OrbResilience = api;
  }
})();
