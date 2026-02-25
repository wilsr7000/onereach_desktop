/**
 * Orb Event Router - Single persistent event handler for all incoming IPC events.
 *
 * Classifies events into three categories:
 *   OUTPUT    - TTS audio/text from voice-speaker (always processed)
 *   INPUT     - Speech transcripts from voice-listener (gated by phase + noise filter)
 *   LIFECYCLE - Connection state changes (always processed)
 *
 * Input gating:
 *   Primary:   voice-listener.js drops mic audio when hudApi.isSpeaking() (source-level)
 *   Secondary: This router rejects transcripts during TTS cooldown, noise, and dedup
 *
 * Loaded as a <script> in orb.html after orb-state.js.
 * Exposes window.OrbEventRouter namespace.
 */

'use strict';

(function () {
  /**
   * Start the event router. Registers a single persistent onEvent handler.
   *
   * @param {object} orbAPI - window.orbAPI with onEvent method
   * @param {object} handlers - Map of event.type -> handler function
   * @param {object} [config] - Optional configuration
   * @param {number} [config.ttsCooldownMs=2500] - Ignore input for this long after TTS ends
   * @param {number} [config.dedupWindowMs=3000] - Dedup window for identical transcripts
   * @param {function} [config.isLikelyNoise] - Function to check if text is noise
   */
  let _started = false;
  let _unsubscribe = null;

  function start(orbAPI, handlers, config = {}) {
    if (!orbAPI || !orbAPI.onEvent) {
      console.error('[OrbRouter] orbAPI.onEvent not available');
      return;
    }

    // Prevent duplicate handler registration on reconnect/reload
    if (_started && _unsubscribe) {
      console.log('[OrbRouter] Already started, cleaning up previous handler');
      _unsubscribe();
    }
    _started = true;

    const OUTPUT = new Set([
      'audio_delta',
      'audio_wav',
      'audio_done',
      'clear_audio_buffer',
      'speech_text_delta',
      'speech_text',
      'response_cancelled',
    ]);
    const LIFECYCLE = new Set(['disconnected', 'error', 'reconnecting', 'reconnected']);

    const TTS_COOLDOWN_MS = config.ttsCooldownMs || 2500;
    const DEDUP_WINDOW_MS = config.dedupWindowMs || 3000;

    /**
     * Secondary noise gate for INPUT events.
     * Primary mic gating happens in voice-listener.js via hudApi.isSpeaking().
     * This is a safety net for transcripts that slip through.
     *
     * @returns {string|false} Rejection reason or false if input is accepted
     */
    function shouldRejectInput(event, S) {
      // TTS cooldown: ignore echo after speaking
      const ttsEndTime = S.get('ttsEndTime') || 0;
      if (ttsEndTime > 0 && Date.now() - ttsEndTime < TTS_COOLDOWN_MS) {
        return 'cooldown';
      }

      const text = event.transcript || event.text || '';
      if (!text) return false;

      // Noise: short jibberish, filler words
      if (config.isLikelyNoise && config.isLikelyNoise(text)) {
        return 'noise';
      }

      // Dedup: same transcript within window
      if (event.type === 'transcript' || event.type === 'function_call_transcript') {
        const lastTranscript = S.get('lastProcessedTranscript') || '';
        const lastTime = S.get('lastProcessedTime') || 0;
        if (
          text.toLowerCase().trim() === lastTranscript.toLowerCase().trim() &&
          Date.now() - lastTime < DEDUP_WINDOW_MS
        ) {
          return 'dedup';
        }
      }

      return false;
    }

    // Register the single persistent handler
    _unsubscribe = orbAPI.onEvent((event) => {
      const S = window.OrbState;
      if (!S) {
        console.error('[OrbRouter] OrbState not available');
        return;
      }

      // OUTPUT: always process (voice-speaker events flow independent of WebSocket)
      if (OUTPUT.has(event.type)) {
        if (handlers[event.type]) handlers[event.type](event);
        return;
      }

      // LIFECYCLE: always process for cleanup/recovery
      if (LIFECYCLE.has(event.type)) {
        if (handlers[event.type]) handlers[event.type](event);
        return;
      }

      // INPUT: only when state machine accepts input
      if (!S.canAcceptInput()) {
        // Special case: session_updated is technically INPUT but should be
        // accepted during connecting phase (canAcceptInput returns true for connecting)
        // All other input during non-accepting phases is silently dropped
        return;
      }

      // Secondary noise gate (transcript events only)
      if (
        event.type === 'transcript' ||
        event.type === 'function_call_transcript' ||
        event.type === 'transcript_delta'
      ) {
        const rejection = shouldRejectInput(event, S);
        if (rejection) {
          console.log(`[OrbRouter] Rejected ${event.type}: ${rejection}`);
          return;
        }
      }

      if (handlers[event.type]) handlers[event.type](event);
    });

    console.log('[OrbRouter] Event router started');
  }

  // Expose to window
  window.OrbEventRouter = { start };
})();
