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
          ttsAudioInitialized = false;
          const newCtx = initTTSAudio();
          await newCtx.resume();
        }
      }

      const currentCtx = ttsAudioContext;
      if (!currentCtx || currentCtx.state !== 'running') {
        console.error('[OrbAudio] AudioContext not running, state:', currentCtx?.state);
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
    }
  }

  /**
   * Play a pleasant ready chime (two-tone ascending)
   */
  async function playReadyChime() {
    try {
      const ctx = new AudioContext();
      if (ctx.state === 'suspended') await ctx.resume();

      const now = ctx.currentTime;
      const frequencies = [523.25, 659.25]; // C5 and E5
      const duration = 0.12;
      const gap = 0.08;

      frequencies.forEach((freq, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();

        osc.type = 'sine';
        osc.frequency.value = freq;

        const startTime = now + i * (duration + gap);
        gain.gain.setValueAtTime(0, startTime);
        gain.gain.linearRampToValueAtTime(0.3, startTime + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.01, startTime + duration);

        osc.connect(gain);
        gain.connect(ctx.destination);

        osc.start(startTime);
        osc.stop(startTime + duration);
      });

      setTimeout(() => ctx.close(), 500);
      console.log('[OrbAudio] Ready chime played');
    } catch (e) {
      console.warn('[OrbAudio] Could not play ready chime:', e);
    }
  }

  /**
   * Play a short acknowledge tone (single low tick when processing starts)
   */
  async function playAcknowledgeTone() {
    try {
      const ctx = new AudioContext();
      if (ctx.state === 'suspended') await ctx.resume();

      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'sine';
      osc.frequency.value = 440; // A4

      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(0.2, now + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.01, now + 0.08);

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.08);

      setTimeout(() => ctx.close(), 200);
    } catch (e) {
      console.warn('[OrbAudio] Could not play acknowledge tone:', e);
    }
  }

  /**
   * Play a completion tone (descending two-note, signals task done)
   */
  async function playCompletionTone() {
    try {
      const ctx = new AudioContext();
      if (ctx.state === 'suspended') await ctx.resume();

      const now = ctx.currentTime;
      const frequencies = [659.25, 523.25]; // E5 then C5 (descending)
      const duration = 0.1;
      const gap = 0.06;

      frequencies.forEach((freq, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();

        osc.type = 'sine';
        osc.frequency.value = freq;

        const startTime = now + i * (duration + gap);
        gain.gain.setValueAtTime(0, startTime);
        gain.gain.linearRampToValueAtTime(0.25, startTime + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.01, startTime + duration);

        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(startTime);
        osc.stop(startTime + duration);
      });

      setTimeout(() => ctx.close(), 500);
    } catch (e) {
      console.warn('[OrbAudio] Could not play completion tone:', e);
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
    initTTSAudio,
    ensureTTSAudioReady,
    base64ToFloat32,
    playWAVAudio,
    playTTSAudio,
    playReadyChime,
    playAcknowledgeTone,
    playCompletionTone,
    addChunk,
    clearChunks,
    getChunkCount,
    setOnSpeakingEnd(fn) {
      _onSpeakingEnd = fn;
    },
  };
})();
