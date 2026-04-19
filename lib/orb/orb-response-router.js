/**
 * Orb Response Mode Router
 *
 * Classifies each agent result into a response mode and dispatches through
 * the cheapest channel that conveys the meaning.
 *
 * Modes (cheapest to most expensive):
 *   tone        - Orb chirps + color pulse. No words.
 *   tone+visual - Tone + HUD panel. No speech.
 *   brief       - Tone + compressed 1-sentence speech.
 *   full        - Tone + full TTS (current behavior).
 *
 * Loaded as a <script> in orb.html after orb-audio.js.
 * Exposes window.OrbResponseRouter namespace.
 */

'use strict';

(function () {
  const CONFIRM_PATTERN =
    /^(done|ok|got it|set|saved|sent|deleted|cancelled|noted|added|removed|updated|created|started|stopped|cleared|copied|moved|queued|scheduled|recorded)\b/i;

  // Detect when an agent's spoken response is a question waiting for a
  // reply, even if the agent didn't set the `needsInput` protocol field.
  // Covers:
  //   - Ends with "?" (most reliable signal)
  //   - Starts with an interrogative word / phrase
  //   - Contains common "follow-up offer" phrasings
  // We intentionally keep this permissive: a false positive just adds a
  // ~25s listening window that auto-times-out if the user says nothing,
  // whereas a false negative makes the orb feel broken (the user
  // complaint: "it asks me questions but doesn't listen").
  const TRAILING_QUESTION_MARK = /\?\s*[)\]'"]*\s*$/;
  const INTERROGATIVE_LEAD =
    /^(who|what|when|where|why|how|which|whose|do(es)?|did|is|are|was|were|will|would|can|could|should|shall|may|might|have|has|had|want|would you like|do you want|shall i|should i|want me to|ready to|ok to)\b/i;
  const FOLLOWUP_OFFER =
    /\b(anything else|want me to|want to|would you like|should i|shall i|ready to|let me know|tell me|just say the word|which one|pick one)\b/i;

  function _messageIsQuestion(message) {
    if (!message) return false;
    const text = String(message).trim();
    if (!text) return false;
    if (TRAILING_QUESTION_MARK.test(text)) return true;
    // Only check leads / phrasings on short messages to avoid false positives
    // in long paragraphs that merely contain a "how" or "when".
    const words = text.split(/\s+/).length;
    if (words <= 25) {
      if (INTERROGATIVE_LEAD.test(text)) return true;
      if (FOLLOWUP_OFFER.test(text)) return true;
    }
    return false;
  }

  const MODES = {
    TONE: 'tone',
    TONE_VISUAL: 'tone+visual',
    BRIEF: 'brief',
    FULL: 'full',
  };

  // ==================== DYNAMIC DWELL CONFIGURATION ====================
  // After the orb finishes speaking, it stays in listening mode for dwellMs
  // before going idle. This makes the interaction feel conversational --
  // like a colleague who pauses to see if you have a follow-up.
  //
  // The TTS echo-suppression cooldown (2.5s) runs during this window,
  // so effective listening time = dwellMs - 2500ms.
  const DWELL = {
    NONE: 0,              // Go idle immediately (cancelled, user-initiated stop)
    CONFIRMATION: 3500,   // "Done", "Sent" -- brief pause, user rarely follows up
    SHORT_INFO: 5000,     // Quick answers -- moderate chance of follow-up
    LONG_INFO: 6000,      // Detailed answers -- user might want clarification
    ERROR: 7000,          // Something failed -- user likely wants to retry or rephrase
    QUESTION: 0,          // needsInput handles its own 30s await (no dwell needed)
    IMPLICIT_QUESTION: 25000, // Agent's message is phrased as a question but didn't
                              // set needsInput -- give the user a real chance to
                              // answer. 25s balances patience with auto-idle.
    PANEL: 4000,          // Visual result shown -- user might ask about what they see
    CAPABILITY_GAP: 8000, // Agent builder / can't-do-that -- high chance of follow-up
    ADEQUACY_RETRY: 8000, // Phase 5 multi-turn adequacy loop retry -- slightly
                          // longer than CONFIRMATION so the user has room to
                          // rephrase; still shorter than IMPLICIT_QUESTION
                          // because we know the system is actively listening.
  };

  /**
   * User preference for response verbosity.
   *   "machine" (default) - tone-biased routing
   *   "vocal"             - always speak (accessibility / preference)
   *   "silent"            - tones + visual only, never speak
   */
  function getPreference() {
    try {
      return localStorage.getItem('orb-response-mode') || 'machine';
    } catch (_) {
      return 'machine';
    }
  }

  function setPreference(mode) {
    try {
      localStorage.setItem('orb-response-mode', mode);
    } catch (_) { /* noop */ }
  }

  /**
   * Classify an agent result into a response mode.
   *
   * @param {Object} result - Agent result from exchange bridge / HUD API
   * @param {boolean} result.success
   * @param {string}  result.message - Text the agent wants to communicate
   * @param {string}  [result.html] - Rendered HTML panel (calendar cards, etc.)
   * @param {Object}  [result.needsInput] - Agent asking a follow-up question
   * @param {boolean} [result.cancelled]
   * @param {Object}  [result.soundCue] - Sound cue to dispatch to the sound engine
   * @param {Object}  [context] - Additional context
   * @param {boolean} [context.userAskedToHear] - User said "read", "tell me", etc.
   * @returns {{ mode: string, tone: string, speech: string|null, showPanel: boolean, soundCue?: Object }}
   */
  function classify(result, context = {}) {
    const pref = getPreference();
    const msg = (result.message || '').trim();
    const wordCount = msg ? msg.split(/\s+/).length : 0;
    const hasPanel = !!result.html;
    const needsInput = !!result.needsInput;
    const soundCue = result.soundCue || null;

    // Capability gap or agent-builder response -- extra dwell for follow-up
    const isCapabilityGap = !!result.capabilityGap || result.agentId === 'agent-builder-agent';

    // Implicit question: the agent's spoken message is phrased as a question
    // (ends with "?", opens with an interrogative, or offers a follow-up)
    // even though it didn't set the explicit `needsInput` protocol flag.
    // Treat it like a follow-up: speak the question, then go into a long
    // listening window so the user can actually answer.
    const isImplicitQuestion = !needsInput && _messageIsQuestion(msg);

    // --- Silent mode: never speak ---
    if (pref === 'silent') {
      const tone = _pickTone(result);
      return {
        mode: hasPanel ? MODES.TONE_VISUAL : MODES.TONE,
        tone,
        speech: null,
        showPanel: hasPanel,
        soundCue,
        dwellMs: isCapabilityGap ? DWELL.CAPABILITY_GAP : hasPanel ? DWELL.PANEL : DWELL.CONFIRMATION,
      };
    }

    // --- Vocal mode: always speak (current behavior) ---
    if (pref === 'vocal') {
      return {
        mode: MODES.FULL,
        tone: _pickTone(result),
        speech: msg || null,
        showPanel: hasPanel,
        soundCue,
        dwellMs: isCapabilityGap ? DWELL.CAPABILITY_GAP : !result.success ? DWELL.ERROR : DWELL.LONG_INFO,
      };
    }

    // --- Machine mode (default): tone-biased ---

    // Cancelled tasks
    if (result.cancelled) {
      return { mode: MODES.TONE, tone: 'cancelled', speech: null, showPanel: false, soundCue, dwellMs: DWELL.NONE };
    }

    // Simple confirmations (message starts with an action verb)
    if (result.success && CONFIRM_PATTERN.test(msg)) {
      return {
        mode: hasPanel ? MODES.TONE_VISUAL : MODES.TONE,
        tone: 'confirm',
        speech: null,
        showPanel: hasPanel,
        soundCue,
        dwellMs: DWELL.CONFIRMATION,
      };
    }

    // Errors with short messages -- tone + brief tooltip, no speech
    if (!result.success && wordCount < 15) {
      return {
        mode: MODES.TONE,
        tone: 'error',
        speech: null,
        showPanel: hasPanel,
        tooltip: msg,
        soundCue,
        dwellMs: isCapabilityGap ? DWELL.CAPABILITY_GAP : DWELL.ERROR,
      };
    }

    // Has HTML panel -- show it, skip narrating
    if (hasPanel && !needsInput) {
      return {
        mode: MODES.TONE_VISUAL,
        tone: result.success === false ? 'error' : 'info',
        speech: null,
        showPanel: true,
        soundCue,
        dwellMs: DWELL.PANEL,
      };
    }

    // Agent asking a follow-up question -- brief the question only
    if (needsInput) {
      const question = result.needsInput.prompt || result.message || '';
      return {
        mode: MODES.BRIEF,
        tone: 'yourTurn',
        speech: question,
        showPanel: hasPanel,
        soundCue,
        awaitAnswer: true, // triggers orb's awaitingInput state (30s)
        dwellMs: DWELL.QUESTION, // needsInput manages its own 30s awaitingInput
      };
    }

    // Agent *implicitly* asked a question (phrased as one but no needsInput
    // flag). Most agents don't bother with the protocol and just speak a
    // question -- we still need to listen for the answer.
    if (isImplicitQuestion) {
      return {
        mode: MODES.BRIEF,
        tone: 'yourTurn',
        speech: msg,
        showPanel: hasPanel,
        soundCue,
        awaitAnswer: true, // orb transitions to awaitingInput (30s timeout)
        dwellMs: DWELL.IMPLICIT_QUESTION,
      };
    }

    // User explicitly asked to hear content
    if (context.userAskedToHear) {
      return {
        mode: MODES.FULL,
        tone: 'info',
        speech: msg,
        showPanel: hasPanel,
        soundCue,
        dwellMs: DWELL.LONG_INFO,
      };
    }

    // Short responses (under 20 words) -- brief
    if (wordCount <= 20) {
      return {
        mode: MODES.BRIEF,
        tone: result.success === false ? 'error' : 'info',
        speech: msg,
        showPanel: hasPanel,
        soundCue,
        dwellMs: isCapabilityGap ? DWELL.CAPABILITY_GAP : !result.success ? DWELL.ERROR : DWELL.SHORT_INFO,
      };
    }

    // Everything else -- full speech
    return {
      mode: MODES.FULL,
      tone: 'info',
      speech: msg,
      showPanel: hasPanel,
      soundCue,
      dwellMs: isCapabilityGap ? DWELL.CAPABILITY_GAP : DWELL.LONG_INFO,
    };
  }

  /**
   * Pick the appropriate tone name for a result.
   */
  function _pickTone(result) {
    if (result.cancelled) return 'cancelled';
    if (!result.success) return 'error';
    if (result.needsInput) return 'yourTurn';
    const msg = (result.message || '').trim();
    if (CONFIRM_PATTERN.test(msg)) return 'confirm';
    return 'info';
  }

  /**
   * Execute a routed response: play tone, optionally show panel, optionally speak.
   *
   * @param {Object} route - Output from classify()
   * @param {Object} audio - window.OrbAudio reference
   * @param {Object} callbacks
   * @param {function} callbacks.showPanel - fn(html) to display HUD panel
   * @param {function} callbacks.speak - fn(text) to trigger TTS
   * @param {function} callbacks.showTooltip - fn(text) to show brief tooltip on orb
   */
  function dispatch(route, audio, callbacks = {}) {
    if (!audio) return;

    // Play the tone
    const toneFn = _toneMap(route.tone, audio);
    if (toneFn) toneFn();

    // Dispatch sound cue to the sound engine (ambient, SFX, generated audio)
    if (route.soundCue) {
      _dispatchSoundCue(route.soundCue);
    }

    // Show panel if routed
    if (route.showPanel && callbacks.showPanel) {
      callbacks.showPanel();
    }

    // Show tooltip for tone-only errors
    if (route.tooltip && callbacks.showTooltip) {
      callbacks.showTooltip(route.tooltip);
    }

    // Speak if mode requires it
    if (route.speech && (route.mode === MODES.BRIEF || route.mode === MODES.FULL)) {
      if (callbacks.speak) callbacks.speak(route.speech);
    }
  }

  /**
   * Handle a soundCue from an agent result.
   * Routes to the appropriate sound subsystem.
   */
  function _dispatchSoundCue(cue) {
    if (!cue || !cue.type) return;

    const engine = window.OrbSoundEngine;
    const ambient = window.OrbAmbient;
    const lib = window.OrbSoundLibrary;

    switch (cue.type) {
      case 'ambient-blend':
        if (ambient && cue.name) {
          if (cue.duration) {
            ambient.blendTemporary(cue.name, cue.duration, cue.volume || 0.3);
          } else {
            ambient.setScene(cue.name);
          }
        }
        break;

      case 'ambient-stop':
        if (ambient) ambient.stop();
        break;

      case 'one-shot':
      case 'tone':
        if (engine) {
          engine.dispatchCue(cue);
        } else if (lib) {
          lib.play(cue.name, { volume: cue.volume || 0.5 });
        }
        break;

      case 'generated-sfx':
        if (cue.base64 && lib) {
          lib.cacheSound(cue.name, cue.base64);
          lib.play(cue.name, { volume: cue.volume || 0.5 });
        }
        break;

      default:
        if (engine) engine.dispatchCue(cue);
    }
  }

  function _toneMap(name, audio) {
    const map = {
      confirm: audio.playConfirm,
      error: audio.playErrorTone,
      uncertain: audio.playUncertainTone,
      attention: audio.playAttentionTone,
      yourTurn: audio.playYourTurnTone,
      cancelled: audio.playCancelledTone,
      info: audio.playInfoTone,
      ready: audio.playReadyChime,
      acknowledge: audio.playAcknowledgeTone,
      completion: audio.playCompletionTone,
      working: audio.playWorkingTone,
    };
    return map[name] || null;
  }

  window.OrbResponseRouter = {
    MODES,
    DWELL,
    classify,
    dispatch,
    getPreference,
    setPreference,
  };
})();
