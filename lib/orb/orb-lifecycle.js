/**
 * Orb Lifecycle - pure decision helpers for realtime connection lifecycle
 * events (disconnected / reconnecting / reconnected).
 *
 * Extracted from orb.html so the renderer's resilience decisions can be
 * unit-tested in isolation. Loaded as a <script> in orb.html (exposes
 * window.OrbLifecycle) and required directly by tests (module.exports).
 *
 * Context: the main process (voice-listener.js) owns realtime reconnection.
 * On a recoverable drop (e.g. an end-of-turn 1005) it auto-reconnects and
 * emits `reconnecting` then `reconnected`; it emits `disconnected` ONLY when
 * the session is genuinely over -- a user-initiated close (code 1000), a
 * give-up after exhausting retries (`permanent: true`), or nothing left to
 * serve. The renderer must not unilaterally tear down an in-flight turn on a
 * drop the main process is still recovering from.
 */

'use strict';

(function () {
  /**
   * Decide how the renderer should treat a `disconnected` event.
   *
   * Returns 'terminal' when the session is truly over and the orb should end
   * the turn (user stop, or a permanent give-up). Returns 'recoverable' for
   * anything else -- defensively, so a stray/ambiguous disconnected can't
   * kill a turn the main process may still be reconnecting; the caller arms a
   * bounded safety timer for that case so the orb can never wedge.
   *
   * @param {{code?: number, permanent?: boolean}} [e]
   * @returns {'terminal'|'recoverable'}
   */
  function classifyDisconnect(e) {
    const code = e && e.code;
    const permanent = !!(e && e.permanent);
    if (permanent) return 'terminal'; // main gave up after retries
    if (code === 1000) return 'terminal'; // user-initiated normal close
    return 'recoverable';
  }

  /**
   * Whether a `reconnected` event should force the orb back to `listening`.
   *
   * Only resume from states that were WAITING on the socket. A brief
   * drop+reconnect that happens while the orb is mid-turn -- `processing` a
   * request or `speaking` a response -- must NOT be yanked back to listening:
   * the turn's own completion path (task:settled / audio_done) owns the next
   * transition, and reopening the mic mid-answer re-admits the TTS as echo.
   * `idle` (dormant) and `listening` (already there) need no transition.
   *
   * @param {string} phase - current orb phase
   * @returns {boolean}
   */
  function shouldResumeListening(phase) {
    return phase === 'awaitingInput' || phase === 'connecting';
  }

  const api = { classifyDisconnect, shouldResumeListening };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    window.OrbLifecycle = api;
  }
})();
