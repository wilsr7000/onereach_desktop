/**
 * Orb Sound Library -- Named registry of sound cues.
 *
 * Each entry is either:
 *   - A Web Audio synthesis recipe (free, instant, local)
 *   - A reference to a cached ElevenLabs-generated SFX file
 *
 * Synthesis recipes use the same _playOrbTone engine from orb-audio.js
 * for tonal sounds, and dedicated builders for texture-based SFX.
 *
 * ElevenLabs sounds are generated on first request, then cached by name
 * in localStorage (base64) for reuse. This keeps repeated requests free.
 *
 * Loaded as a <script> in orb.html after orb-sound-engine.js.
 * Exposes window.OrbSoundLibrary namespace.
 */

'use strict';

(function () {
  const CACHE_PREFIX = 'orb-sfx-cache:';

  function _engine() { return window.OrbSoundEngine; }
  function _audio() { return window.OrbAudio; }

  function _rand(base, pct) {
    return base * (1 + (Math.random() * 2 - 1) * pct);
  }

  // ── Synthesis Recipes ────────────────────────────────────────────────
  // Each recipe is a function(ctx, destination, volume) that creates and
  // starts audio nodes. Nodes auto-stop; no cleanup required.

  const RECIPES = {
    /**
     * Morning motif -- 3-note ascending warm arpeggio
     */
    'morning-motif': (ctx, dest, vol) => {
      const notes = [
        { from: 392, to: 415, dur: 0.12, delay: 0 },
        { from: 494, to: 523, dur: 0.12, delay: 0.16 },
        { from: 587, to: 659, dur: 0.15, delay: 0.32 },
      ];
      _synthTone(ctx, dest, notes, vol * 0.16, 5000);
    },

    /**
     * Meeting chime -- gentle 2-note descending bell
     */
    'meeting-chime': (ctx, dest, vol) => {
      const notes = [
        { from: 659, to: 640, dur: 0.2, delay: 0 },
        { from: 523, to: 510, dur: 0.25, delay: 0.24 },
      ];
      _synthTone(ctx, dest, notes, vol * 0.15, 4000);
    },

    /**
     * Streak ding -- ascending 4-note arpeggio (achievement feel)
     */
    'streak-ding': (ctx, dest, vol) => {
      const notes = [
        { from: 523, to: 540, dur: 0.08, delay: 0 },
        { from: 659, to: 680, dur: 0.08, delay: 0.1 },
        { from: 784, to: 800, dur: 0.08, delay: 0.2 },
        { from: 1047, to: 1060, dur: 0.12, delay: 0.3 },
      ];
      _synthTone(ctx, dest, notes, vol * 0.14, 6000);
    },

    /**
     * Whoosh -- bandpass noise sweep (fast transition feel)
     */
    'whoosh': (ctx, dest, vol) => {
      const dur = 0.35;
      const now = ctx.currentTime;

      const buf = ctx.createBuffer(1, ctx.sampleRate * 0.5, ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;

      const noise = ctx.createBufferSource();
      noise.buffer = buf;

      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.Q.value = 2;
      bp.frequency.setValueAtTime(200, now);
      bp.frequency.exponentialRampToValueAtTime(4000, now + dur * 0.6);
      bp.frequency.exponentialRampToValueAtTime(800, now + dur);

      const g = ctx.createGain();
      g.gain.setValueAtTime(0, now);
      g.gain.linearRampToValueAtTime(vol * 0.3, now + dur * 0.2);
      g.gain.exponentialRampToValueAtTime(0.001, now + dur);

      noise.connect(bp);
      bp.connect(g);
      g.connect(dest);
      noise.start(now);
      noise.stop(now + dur + 0.1);
    },

    /**
     * Weather rain texture -- short 5s rain burst
     */
    'rain-light': (ctx, dest, vol) => {
      _synthTexture(ctx, dest, vol, 'rain', 5000);
    },

    'rain-heavy': (ctx, dest, vol) => {
      _synthTexture(ctx, dest, vol, 'storm', 5000);
    },

    /**
     * Warm memory tone -- soft rising fifth with vibrato
     */
    'memory-warm': (ctx, dest, vol) => {
      const notes = [
        { from: 262, to: 295, dur: 0.2, delay: 0, gain: 0.8 },
        { from: 392, to: 400, dur: 0.3, delay: 0.15, gain: 0.6 },
      ];
      _synthTone(ctx, dest, notes, vol * 0.12, 3500, 3, 5);
    },

    /**
     * Transition sweep -- DJ-style quick filter sweep
     */
    'transition': (ctx, dest, vol) => {
      const now = ctx.currentTime;
      const dur = 0.5;

      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = 110;

      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.Q.value = 8;
      lp.frequency.setValueAtTime(200, now);
      lp.frequency.exponentialRampToValueAtTime(8000, now + dur * 0.4);
      lp.frequency.exponentialRampToValueAtTime(200, now + dur);

      const g = ctx.createGain();
      g.gain.setValueAtTime(0, now);
      g.gain.linearRampToValueAtTime(vol * 0.1, now + 0.05);
      g.gain.exponentialRampToValueAtTime(0.001, now + dur);

      osc.connect(lp);
      lp.connect(g);
      g.connect(dest);
      osc.start(now);
      osc.stop(now + dur + 0.1);
    },

    /**
     * Alert chime -- 3 quick ascending notes (calendar/timer)
     */
    'alert-chime': (ctx, dest, vol) => {
      const notes = [
        { from: 880, to: 900, dur: 0.06, delay: 0 },
        { from: 1047, to: 1060, dur: 0.06, delay: 0.1 },
        { from: 1319, to: 1330, dur: 0.08, delay: 0.2 },
      ];
      _synthTone(ctx, dest, notes, vol * 0.13, 8000);
    },

    /**
     * Focus start -- soft binaural pulse intro (2 seconds)
     */
    'focus-start': (ctx, dest, vol) => {
      const now = ctx.currentTime;
      const dur = 2.0;

      const left = ctx.createOscillator();
      left.type = 'sine';
      left.frequency.value = 200;
      const right = ctx.createOscillator();
      right.type = 'sine';
      right.frequency.value = 210;

      const g = ctx.createGain();
      g.gain.setValueAtTime(0, now);
      g.gain.linearRampToValueAtTime(vol * 0.06, now + 0.5);
      g.gain.setValueAtTime(vol * 0.06, now + dur - 0.5);
      g.gain.linearRampToValueAtTime(0, now + dur);

      left.connect(g);
      right.connect(g);
      g.connect(dest);
      left.start(now);
      right.start(now);
      left.stop(now + dur + 0.1);
      right.stop(now + dur + 0.1);
    },

    /**
     * Brief complete -- quick descending 2-note (task done)
     */
    'brief-complete': (ctx, dest, vol) => {
      const notes = [
        { from: 784, to: 740, dur: 0.08, delay: 0 },
        { from: 587, to: 560, dur: 0.1, delay: 0.1 },
      ];
      _synthTone(ctx, dest, notes, vol * 0.12, 4500);
    },
  };

  // ── Helpers ──────────────────────────────────────────────────────────

  /**
   * Play tonal notes through the OrbAudio-style engine.
   */
  function _synthTone(ctx, dest, notes, maxGain, filterFreq, vibrato, vibratoRate) {
    const now = ctx.currentTime;

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = filterFreq || 4000;
    filter.Q.value = 0.7;
    filter.connect(dest);

    for (const note of notes) {
      const delay = note.delay || 0;
      const dur = _rand(note.dur, 0.08);
      const freqFrom = _rand(note.from, 0.03);
      const freqTo = _rand(note.to, 0.03);
      const startT = now + delay;
      const endT = startT + dur;
      const noteGain = (note.gain !== undefined ? note.gain : 1) * maxGain;

      const osc1 = ctx.createOscillator();
      osc1.type = 'sine';
      osc1.frequency.setValueAtTime(freqFrom, startT);
      if (freqFrom !== freqTo) osc1.frequency.linearRampToValueAtTime(freqTo, endT);

      const osc2 = ctx.createOscillator();
      osc2.type = 'triangle';
      osc2.frequency.setValueAtTime(freqFrom, startT);
      if (freqFrom !== freqTo) osc2.frequency.linearRampToValueAtTime(freqTo, endT);

      if (vibrato) {
        const lfo = ctx.createOscillator();
        const lfoGain = ctx.createGain();
        lfo.frequency.value = vibratoRate || 6;
        lfoGain.gain.value = vibrato;
        lfo.connect(lfoGain);
        lfoGain.connect(osc1.frequency);
        lfoGain.connect(osc2.frequency);
        lfo.start(startT);
        lfo.stop(endT + 0.05);
      }

      const g1 = ctx.createGain();
      g1.gain.setValueAtTime(0, startT);
      g1.gain.linearRampToValueAtTime(noteGain * 0.7, startT + 0.008);
      g1.gain.exponentialRampToValueAtTime(0.001, endT);

      const g2 = ctx.createGain();
      g2.gain.setValueAtTime(0, startT);
      g2.gain.linearRampToValueAtTime(noteGain * 0.3, startT + 0.008);
      g2.gain.exponentialRampToValueAtTime(0.001, endT);

      osc1.connect(g1); g1.connect(filter);
      osc2.connect(g2); g2.connect(filter);
      osc1.start(startT); osc1.stop(endT + 0.01);
      osc2.start(startT); osc2.stop(endT + 0.01);
    }
  }

  /**
   * Short noise-based texture (rain burst, storm crack, etc.)
   */
  function _synthTexture(ctx, dest, vol, type, durationMs) {
    const now = ctx.currentTime;
    const dur = durationMs / 1000;
    const sampleRate = ctx.sampleRate;
    const length = sampleRate * 2;
    const buffer = ctx.createBuffer(1, length, sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;

    const noise = ctx.createBufferSource();
    noise.buffer = buffer;
    noise.loop = true;

    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = type === 'storm' ? 600 : 1000;
    bp.Q.value = type === 'storm' ? 0.3 : 0.5;

    const env = ctx.createGain();
    env.gain.setValueAtTime(0, now);
    env.gain.linearRampToValueAtTime(vol * 0.4, now + 1);
    env.gain.setValueAtTime(vol * 0.4, now + dur - 1.5);
    env.gain.linearRampToValueAtTime(0, now + dur);

    noise.connect(bp);
    bp.connect(env);
    env.connect(dest);
    noise.start(now);
    noise.stop(now + dur + 0.2);
  }

  // ── ElevenLabs Cache ─────────────────────────────────────────────────

  function _getCached(name) {
    try {
      return localStorage.getItem(CACHE_PREFIX + name);
    } catch (_) { return null; }
  }

  const MAX_SFX_CACHE = 50;

  function _evictOldestCache() {
    try {
      const keys = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith(CACHE_PREFIX)) {
          keys.push(key);
        }
      }
      if (keys.length > MAX_SFX_CACHE) {
        keys.slice(0, keys.length - MAX_SFX_CACHE).forEach((k) => localStorage.removeItem(k));
      }
    } catch (_) { /* noop */ }
  }

  function _setCache(name, base64) {
    try {
      localStorage.setItem(CACHE_PREFIX + name, base64);
      _evictOldestCache();
    } catch (_) { /* storage full, skip */ }
  }

  /**
   * Play a cached ElevenLabs SFX by decoding the base64 audio.
   */
  async function _playCachedAudio(base64, dest, vol) {
    const engine = _engine();
    if (!engine) return;

    const ctx = engine.getContext();
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

    const audioBuffer = await ctx.decodeAudioData(bytes.buffer.slice(0));
    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    const g = ctx.createGain();
    g.gain.value = vol;
    source.connect(g);
    g.connect(dest);
    source.start(0);
  }

  // ── Public API ───────────────────────────────────────────────────────

  /**
   * Play a named sound from the library.
   *
   * @param {string} name - Sound name from RECIPES or ElevenLabs cache
   * @param {Object} [opts]
   * @param {number} [opts.volume=0.5]
   */
  function play(name, opts = {}) {
    const vol = opts.volume !== undefined ? opts.volume : 0.5;
    const engine = _engine();
    if (!engine) return;

    const ctx = engine.getContext();
    if (!ctx) return;
    if (ctx.state === 'suspended') ctx.resume();

    const dest = ctx.destination;

    const recipe = RECIPES[name];
    if (recipe) {
      recipe(ctx, dest, vol);
      return;
    }

    const cached = _getCached(name);
    if (cached) {
      _playCachedAudio(cached, dest, vol).catch((e) => {
        console.warn('[SoundLibrary] Failed to play cached audio:', name, e);
      });
      return;
    }

    console.warn('[SoundLibrary] Unknown sound:', name);
  }

  /**
   * Store an ElevenLabs-generated SFX in the cache for future use.
   *
   * @param {string} name
   * @param {string} base64Audio - MP3 or WAV as base64
   */
  function cacheSound(name, base64Audio) {
    _setCache(name, base64Audio);
  }

  /**
   * Check if a sound exists (recipe or cached).
   */
  function has(name) {
    return !!RECIPES[name] || !!_getCached(name);
  }

  /**
   * List all available sound names.
   */
  function list() {
    const cached = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key.startsWith(CACHE_PREFIX)) {
          cached.push(key.slice(CACHE_PREFIX.length));
        }
      }
    } catch (_) { /* noop */ }
    return [...Object.keys(RECIPES), ...cached];
  }

  window.OrbSoundLibrary = {
    play,
    cacheSound,
    has,
    list,
  };
})();
