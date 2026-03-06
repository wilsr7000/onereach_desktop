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

  const MODES = {
    TONE: 'tone',
    TONE_VISUAL: 'tone+visual',
    BRIEF: 'brief',
    FULL: 'full',
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

    // --- Silent mode: never speak ---
    if (pref === 'silent') {
      const tone = _pickTone(result);
      return {
        mode: hasPanel ? MODES.TONE_VISUAL : MODES.TONE,
        tone,
        speech: null,
        showPanel: hasPanel,
        soundCue,
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
      };
    }

    // --- Machine mode (default): tone-biased ---

    // Cancelled tasks
    if (result.cancelled) {
      return { mode: MODES.TONE, tone: 'cancelled', speech: null, showPanel: false, soundCue };
    }

    // Simple confirmations (message starts with an action verb)
    if (result.success && CONFIRM_PATTERN.test(msg)) {
      return {
        mode: hasPanel ? MODES.TONE_VISUAL : MODES.TONE,
        tone: 'confirm',
        speech: null,
        showPanel: hasPanel,
        soundCue,
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
      };
    }

    // Everything else -- full speech
    return {
      mode: MODES.FULL,
      tone: 'info',
      speech: msg,
      showPanel: hasPanel,
      soundCue,
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
    classify,
    dispatch,
    getPreference,
    setPreference,
  };
})();
