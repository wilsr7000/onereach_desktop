/**
 * Orb Audio Module - AudioContext management, WAV/PCM playback, ready chime.
 *
 * Extracted from orb.html to reduce monolith size.
 * Loaded as a <script> in orb.html before the main script block.
 * Exposes window.OrbAudio namespace.
 */

'use strict';

(function () {
  let ttsAudioContext = null;
  let ttsAudioChunks = [];
  let _ttsAudioInitialized = false;
  let _currentSource = null;

  // Callbacks injected by the main orb script
  let _onSpeakingEnd = null;

  // =========================================================================
  // DEBUG INSTRUMENTATION
  //
  // Ring buffer of the last 50 sound emissions. When "noises from the orb"
  // fire unexpectedly, inspect `window.OrbAudio.lastSounds()` to see exactly
  // which function produced them and from where. Each entry captures:
  //   - wall-clock timestamp (ms since page load AND ISO)
  //   - function name that emitted the sound
  //   - orb phase at emit time (if OrbState is available)
  //   - 4-frame stack trace to identify the caller
  //   - "muted" flag if the mute kill-switch was active
  //
  // Kill switch: `window.OrbAudio.mute()` / `.unmute()` / `.isMuted()`.
  // When muted, every tone/WAV/PCM path short-circuits instead of playing.
  // The instrumentation still records the entry so we can see what WOULD
  // have played even when silenced.
  // =========================================================================
  const _soundLog = [];
  const _SOUND_LOG_MAX = 50;
  let _muted = false;

  try {
    _muted = localStorage.getItem('orb-audio-muted') === '1';
  } catch (_e) { /* localStorage may be unavailable */ }

  function _recordSound(fnName, meta = {}) {
    const ts = Date.now();
    const phase = (window.OrbState && typeof window.OrbState.getPhase === 'function')
      ? window.OrbState.getPhase()
      : null;
    const stack = (new Error().stack || '').split('\n').slice(2, 6).map((l) => l.trim());
    const entry = {
      t: ts,
      iso: new Date(ts).toISOString(),
      sincePageLoadMs: Math.round(performance.now()),
      fn: fnName,
      phase,
      muted: _muted,
      meta,
      stack,
    };
    _soundLog.push(entry);
    if (_soundLog.length > _SOUND_LOG_MAX) _soundLog.shift();
    // Always print to console so the Chromium log capture picks it up.
    console.log('[OrbAudio:emit]', fnName, {
      phase,
      muted: _muted,
      meta,
      caller: stack[0] || '(unknown)',
    });
    return entry;
  }

  function _isMuted() { return _muted; }

  function mute() {
    _muted = true;
    try { localStorage.setItem('orb-audio-muted', '1'); } catch (_e) { /* noop */ }
    try {
      if (_currentSource) { _currentSource.stop(); _currentSource = null; }
    } catch (_e) { /* already stopped */ }
    ttsAudioChunks = [];
    if (_workingInterval) { clearInterval(_workingInterval); _workingInterval = null; }
    console.log('[OrbAudio] Muted. All tones / TTS playback will no-op.');
  }

  function unmute() {
    _muted = false;
    try { localStorage.setItem('orb-audio-muted', '0'); } catch (_e) { /* noop */ }
    console.log('[OrbAudio] Unmuted.');
  }

  /**
   * Initialize TTS AudioContext (lazy, reusable)
   */
  function initTTSAudio() {
    if (ttsAudioContext && ttsAudioContext.state !== 'closed') {
      return ttsAudioContext;
    }
    ttsAudioContext = new AudioContext({ sampleRate: 24000 });
    _ttsAudioInitialized = true;
    console.log('[OrbAudio] Created AudioContext, state:', ttsAudioContext.state);
    return ttsAudioContext;
  }

  /**
   * Ensure TTS audio is ready (call on user interaction)
   */
  function ensureTTSAudioReady() {
    try {
      const ctx = initTTSAudio();
      if (ctx.state === 'suspended') {
        ctx.resume().then(() => {
          console.log('[OrbAudio] AudioContext resumed, state:', ctx.state);
        }).catch((err) => {
          console.warn('[OrbAudio] AudioContext resume failed:', err);
        });
      }
      return ctx.state === 'running';
    } catch (e) {
      console.error('[OrbAudio] Failed to initialize TTS AudioContext:', e);
      return false;
    }
  }

  // Initialize audio on first user interaction
  document.addEventListener('click', () => ensureTTSAudioReady(), { once: true });
  document.addEventListener('touchstart', () => ensureTTSAudioReady(), { once: true });
  document.addEventListener('keydown', () => ensureTTSAudioReady(), { once: true });

  /**
   * Convert base64 PCM16 to Float32 for Web Audio playback
   */
  function base64ToFloat32(base64) {
    const binaryString = atob(base64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    const pcm16 = new Int16Array(bytes.buffer);
    const float32 = new Float32Array(pcm16.length);
    for (let i = 0; i < pcm16.length; i++) {
      float32[i] = pcm16[i] / 32768;
    }
    return float32;
  }

  /**
   * Play WAV audio from base64 string (from TTS API)
   */
  async function playWAVAudio(base64Audio) {
    _recordSound('playWAVAudio', { bytes: base64Audio?.length || 0 });
    if (_muted) {
      if (_onSpeakingEnd) _onSpeakingEnd();
      return;
    }
    try {
      console.log('[OrbAudio] playWAVAudio: decoding WAV...');

      // Stop any currently playing audio to prevent overlap
      if (_currentSource) {
        try { _currentSource.stop(); } catch (_) { /* already stopped */ }
        _currentSource = null;
      }

      const binaryString = atob(base64Audio);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }

      const ctx = initTTSAudio();
      if (ctx.state === 'suspended') {
        console.log('[OrbAudio] playWAVAudio: resuming AudioContext...');
        await ctx.resume();
      }

      const audioBuffer = await ctx.decodeAudioData(bytes.buffer.slice(0));
      console.log(`[OrbAudio] playWAVAudio: decoded ${audioBuffer.duration.toFixed(2)}s of audio`);

      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(ctx.destination);
      _currentSource = source;

      source.onended = () => {
        console.log('[OrbAudio] playWAVAudio: playback complete');
        _currentSource = null;
        if (_onSpeakingEnd) _onSpeakingEnd();
      };

      source.start(0);
      console.log('[OrbAudio] playWAVAudio: playing...');
    } catch (e) {
      console.error('[OrbAudio] playWAVAudio error:', e);
      _currentSource = null;
      if (_onSpeakingEnd) _onSpeakingEnd();
    }
  }

  /**
   * Play accumulated PCM audio chunks
   */
  async function playTTSAudio() {
    if (ttsAudioChunks.length === 0) {
      console.log('[OrbAudio] playTTSAudio called but no chunks');
      return;
    }

    _recordSound('playTTSAudio', { chunks: ttsAudioChunks.length });
    if (_muted) {
      ttsAudioChunks = [];
      if (_onSpeakingEnd) _onSpeakingEnd();
      return;
    }

    console.log('[OrbAudio] playTTSAudio called with', ttsAudioChunks.length, 'chunks');

    try {
      const ctx = initTTSAudio();

      if (ctx.state === 'suspended') {
        console.log('[OrbAudio] Attempting to resume AudioContext...');
        try {
          await ctx.resume();
          console.log('[OrbAudio] AudioContext resumed, state:', ctx.state);
        } catch (resumeError) {
          console.error('[OrbAudio] Failed to resume AudioContext:', resumeError);
          ttsAudioContext = null;
          _ttsAudioInitialized = false;
          const newCtx = initTTSAudio();
          await newCtx.resume();
        }
      }

      const currentCtx = ttsAudioContext;
      if (!currentCtx || currentCtx.state !== 'running') {
        console.error('[OrbAudio] AudioContext not running, state:', currentCtx?.state);
        ttsAudioChunks = [];
        if (_onSpeakingEnd) _onSpeakingEnd();
        return;
      }

      const totalLength = ttsAudioChunks.reduce((sum, chunk) => sum + chunk.length, 0);
      const combined = new Float32Array(totalLength);
      let offset = 0;
      for (const chunk of ttsAudioChunks) {
        combined.set(chunk, offset);
        offset += chunk.length;
      }

      const buffer = currentCtx.createBuffer(1, combined.length, 24000);
      buffer.copyToChannel(combined, 0);

      const source = currentCtx.createBufferSource();
      source.buffer = buffer;
      source.connect(currentCtx.destination);
      source.start();

      console.log(
        '[OrbAudio] Playing TTS audio, samples:',
        combined.length,
        'duration:',
        (combined.length / 24000).toFixed(2) + 's'
      );
      ttsAudioChunks = [];
    } catch (e) {
      console.error('[OrbAudio] Error playing TTS audio:', e);
      ttsAudioChunks = [];
      if (_onSpeakingEnd) _onSpeakingEnd();
    }
  }

  // ===========================================================================
  // TONAL VOCABULARY -- "Subtle R2-D2"
  //
  // All tones share a common "orb voice":
  //   - Layered oscillators (sine + triangle at ~30% mix)
  //   - Pitch sweeps instead of static notes
  //   - Micro-randomization (+/-3% pitch, +/-10ms timing)
  //   - Low-pass filter at ~4kHz for warmth
  //   - Soft gain ceiling (0.18 max)
  // ===========================================================================

  let _workingInterval = null;

  function _rand(base, pct) {
    return base * (1 + (Math.random() * 2 - 1) * pct);
  }

  /**
   * Core tone engine. Takes an array of note specs and plays them with the
   * shared orb voice timbre.
   *
   * @param {Object} spec
   * @param {Array} spec.notes - [{from, to, dur, delay?}] frequencies in Hz
   * @param {number} [spec.maxGain=0.18]
   * @param {number} [spec.filterFreq=4000]
   * @param {boolean} [spec.randomize=true]
   * @param {number} [spec.vibrato] - vibrato depth in Hz (0 = none)
   * @param {number} [spec.vibratoRate=6] - vibrato speed in Hz
   * @returns {Promise<void>}
   */
  async function _playOrbTone(spec) {
    _recordSound('_playOrbTone', {
      tag: spec?.tag || null,
      noteCount: spec?.notes?.length || 0,
    });
    if (_muted) return;
    try {
      const ctx = new AudioContext();
      if (ctx.state === 'suspended') await ctx.resume();

      const now = ctx.currentTime;
      const maxGain = spec.maxGain || 0.18;
      const doRand = spec.randomize !== false;
      let totalDuration = 0;

      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = spec.filterFreq || 4000;
      filter.Q.value = 0.7;
      filter.connect(ctx.destination);

      for (const note of spec.notes) {
        const delay = note.delay || 0;
        const dur = doRand ? _rand(note.dur, 0.08) : note.dur;
        const freqFrom = doRand ? _rand(note.from, 0.03) : note.from;
        const freqTo = doRand ? _rand(note.to, 0.03) : note.to;
        const startT = now + delay;
        const endT = startT + dur;
        const noteGain = (note.gain !== undefined ? note.gain : 1) * maxGain;

        // Primary oscillator (sine)
        const osc1 = ctx.createOscillator();
        osc1.type = 'sine';
        osc1.frequency.setValueAtTime(freqFrom, startT);
        if (freqFrom !== freqTo) {
          osc1.frequency.linearRampToValueAtTime(freqTo, endT);
        }

        // Secondary oscillator (triangle, 30% mix for warmth)
        const osc2 = ctx.createOscillator();
        osc2.type = 'triangle';
        osc2.frequency.setValueAtTime(freqFrom, startT);
        if (freqFrom !== freqTo) {
          osc2.frequency.linearRampToValueAtTime(freqTo, endT);
        }

        // Vibrato LFO
        if (spec.vibrato) {
          const lfo = ctx.createOscillator();
          const lfoGain = ctx.createGain();
          lfo.frequency.value = spec.vibratoRate || 6;
          lfoGain.gain.value = spec.vibrato;
          lfo.connect(lfoGain);
          lfoGain.connect(osc1.frequency);
          lfoGain.connect(osc2.frequency);
          lfo.start(startT);
          lfo.stop(endT + 0.05);
        }

        // Gain envelopes
        const g1 = ctx.createGain();
        g1.gain.setValueAtTime(0, startT);
        g1.gain.linearRampToValueAtTime(noteGain * 0.7, startT + 0.008);
        g1.gain.exponentialRampToValueAtTime(0.001, endT);

        const g2 = ctx.createGain();
        g2.gain.setValueAtTime(0, startT);
        g2.gain.linearRampToValueAtTime(noteGain * 0.3, startT + 0.008);
        g2.gain.exponentialRampToValueAtTime(0.001, endT);

        osc1.connect(g1);
        g1.connect(filter);
        osc2.connect(g2);
        g2.connect(filter);

        osc1.start(startT);
        osc1.stop(endT + 0.01);
        osc2.start(startT);
        osc2.stop(endT + 0.01);

        totalDuration = Math.max(totalDuration, (delay + dur) * 1000);
      }

      setTimeout(() => ctx.close(), totalDuration + 200);
    } catch (e) {
      console.warn('[OrbAudio] Tone playback error:', e);
    }
  }

  // --- Named tones (public API) ---

  /** Confirm / affirmative -- quick rising chirp */
  function playConfirm() {
    return _playOrbTone({
      tag: 'confirm',
      notes: [{ from: 262, to: 330, dur: 0.12 }],
    });
  }

  /** Ready chime -- two ascending chirps (mic is live) */
  function playReadyChime() {
    return _playOrbTone({
      tag: 'ready',
      notes: [
        { from: 330, to: 392, dur: 0.1, delay: 0 },
        { from: 392, to: 523, dur: 0.1, delay: 0.14 },
      ],
    });
  }

  /** Acknowledge -- single warm mid-tone tick (processing started) */
  function playAcknowledgeTone() {
    return _playOrbTone({
      tag: 'acknowledge',
      notes: [{ from: 330, to: 310, dur: 0.08 }],
      maxGain: 0.14,
    });
  }

  /** Completion -- descending two-note, task finished */
  function playCompletionTone() {
    return _playOrbTone({
      tag: 'completion',
      notes: [
        { from: 523, to: 440, dur: 0.1, delay: 0 },
        { from: 392, to: 330, dur: 0.12, delay: 0.14 },
      ],
    });
  }

  /** Error -- gentle falling warble */
  function playErrorTone() {
    return _playOrbTone({
      tag: 'error',
      notes: [{ from: 165, to: 131, dur: 0.25 }],
      vibrato: 4,
      vibratoRate: 5,
      maxGain: 0.16,
    });
  }

  /** Uncertain -- mid-pitch wobble, slight fade */
  function playUncertainTone() {
    return _playOrbTone({
      tag: 'uncertain',
      notes: [{ from: 440, to: 430, dur: 0.22 }],
      vibrato: 8,
      vibratoRate: 6,
      maxGain: 0.14,
    });
  }

  /** Attention -- soft ascending arpeggio (something wants you) */
  function playAttentionTone() {
    return _playOrbTone({
      tag: 'attention',
      notes: [
        { from: 262, to: 280, dur: 0.09, delay: 0 },
        { from: 330, to: 350, dur: 0.09, delay: 0.12 },
        { from: 392, to: 420, dur: 0.11, delay: 0.24 },
      ],
      maxGain: 0.15,
    });
  }

  /** Your turn -- two rising chirps, distinct from ready chime */
  function playYourTurnTone() {
    return _playOrbTone({
      tag: 'yourTurn',
      notes: [
        { from: 392, to: 494, dur: 0.1, delay: 0 },
        { from: 494, to: 587, dur: 0.12, delay: 0.16 },
      ],
      maxGain: 0.16,
    });
  }

  /** Cancelled -- quick falling minor second */
  function playCancelledTone() {
    return _playOrbTone({
      tag: 'cancelled',
      notes: [{ from: 466, to: 440, dur: 0.13 }],
      maxGain: 0.14,
    });
  }

  /** Info -- single warm neutral chirp */
  function playInfoTone() {
    return _playOrbTone({
      tag: 'info',
      notes: [{ from: 330, to: 340, dur: 0.1 }],
      maxGain: 0.13,
    });
  }

  /** Working -- soft rhythmic pulse (repeats 3 times then stops) */
  function playWorkingTone() {
    stopWorkingTone();
    if (_muted) return;
    let count = 0;
    const play = () => {
      _playOrbTone({
        tag: 'working',
        notes: [{ from: 131, to: 135, dur: 0.06 }],
        maxGain: 0.1,
        filterFreq: 2000,
      });
    };
    play();
    _workingInterval = setInterval(() => {
      count++;
      if (count >= 3) { stopWorkingTone(); return; }
      play();
    }, 800);
  }

  function stopWorkingTone() {
    if (_workingInterval) {
      clearInterval(_workingInterval);
      _workingInterval = null;
    }
  }

  /**
   * Add a PCM chunk to the buffer
   */
  function addChunk(float32Data) {
    ttsAudioChunks.push(float32Data);
  }

  /**
   * Clear all buffered chunks
   */
  function clearChunks() {
    ttsAudioChunks = [];
  }

  /**
   * Get current chunk count
   */
  function getChunkCount() {
    return ttsAudioChunks.length;
  }

  // Expose to window
  window.OrbAudio = {
    // TTS playback
    initTTSAudio,
    ensureTTSAudioReady,
    base64ToFloat32,
    playWAVAudio,
    playTTSAudio,
    addChunk,
    clearChunks,
    getChunkCount,
    setOnSpeakingEnd(fn) {
      _onSpeakingEnd = fn;
    },

    // Tonal vocabulary
    tone: _playOrbTone,
    playConfirm,
    playReadyChime,
    playAcknowledgeTone,
    playCompletionTone,
    playErrorTone,
    playUncertainTone,
    playAttentionTone,
    playYourTurnTone,
    playCancelledTone,
    playInfoTone,
    playWorkingTone,
    stopWorkingTone,

    // Kill switch + instrumentation (for debugging "noises from the orb")
    mute,
    unmute,
    isMuted: _isMuted,
    recordSound: _recordSound,  // exposed so orb-sound-engine / orb-ambient can log
    lastSounds(n = 20) {
      return _soundLog.slice(-n).map((e) => ({
        ...e,
        ago: Math.round((Date.now() - e.t) / 1000) + 's ago',
      }));
    },
    clearSoundLog() { _soundLog.length = 0; },
  };
})();
