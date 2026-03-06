/**
 * Orb Sound Engine -- Central mixer for the orb's three audio layers.
 *
 * Layers (from lowest to highest priority):
 *   1. Ambient  -- looping background textures (rain, cafe, focus, etc.)
 *   2. SFX      -- one-shot sound effects (fanfare, whoosh, chime)
 *   3. Tone     -- existing R2-D2 tonal vocabulary (delegates to OrbAudio)
 *
 * Features:
 *   - Master volume + per-layer volume
 *   - Automatic ducking: ambient dips when TTS/tone plays
 *   - Settings persistence via localStorage
 *   - Sound cue dispatcher for agent results
 *
 * Loaded as a <script> in orb.html after orb-audio.js.
 * Exposes window.OrbSoundEngine namespace.
 */

'use strict';

(function () {
  const STORAGE_KEY = 'orb-sound-settings';

  const DEFAULTS = {
    masterVolume: 0.7,
    ambientEnabled: false,
    ambientMode: 'off',       // 'off' | 'auto' | 'manual'
    agentCuesEnabled: true,
    cinematicEnabled: true,
    ambientVolume: 0.3,
    sfxVolume: 0.5,
    toneVolume: 0.7,
  };

  let _settings = { ...DEFAULTS };
  let _ctx = null;
  let _masterGain = null;
  let _ambientGain = null;
  let _sfxGain = null;
  let _toneGain = null;
  let _duckGain = null;        // applied to ambient layer for ducking
  let _isDucked = false;
  let _duckTimer = null;
  let _activeSfxSources = [];
  let _initialized = false;

  function _loadSettings() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const saved = JSON.parse(raw);
        _settings = { ...DEFAULTS, ...saved };
      }
    } catch (_) { /* use defaults */ }
  }

  function _saveSettings() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(_settings));
    } catch (_) { /* noop */ }
  }

  function _getContext() {
    if (_ctx && _ctx.state !== 'closed') return _ctx;
    _ctx = new AudioContext();
    return _ctx;
  }

  /**
   * Initialize the sound engine graph.
   * Safe to call multiple times; only builds the graph once.
   */
  function init() {
    if (_initialized) return;
    _loadSettings();

    const ctx = _getContext();

    _masterGain = ctx.createGain();
    _masterGain.gain.value = _settings.masterVolume;
    _masterGain.connect(ctx.destination);

    _duckGain = ctx.createGain();
    _duckGain.gain.value = 1.0;
    _duckGain.connect(_masterGain);

    _ambientGain = ctx.createGain();
    _ambientGain.gain.value = _settings.ambientVolume;
    _ambientGain.connect(_duckGain);

    _sfxGain = ctx.createGain();
    _sfxGain.gain.value = _settings.sfxVolume;
    _sfxGain.connect(_masterGain);

    _toneGain = ctx.createGain();
    _toneGain.gain.value = _settings.toneVolume;
    _toneGain.connect(_masterGain);

    _initialized = true;
    console.log('[SoundEngine] Initialized');
  }

  async function _ensureRunning() {
    const ctx = _getContext();
    if (ctx.state === 'suspended') {
      await ctx.resume();
    }
    if (!_initialized) init();
  }

  // ── Volume Controls ──────────────────────────────────────────────────

  function setMasterVolume(v) {
    _settings.masterVolume = Math.max(0, Math.min(1, v));
    if (_masterGain) _masterGain.gain.value = _settings.masterVolume;
    _saveSettings();
  }

  function setAmbientVolume(v) {
    _settings.ambientVolume = Math.max(0, Math.min(1, v));
    if (_ambientGain) _ambientGain.gain.value = _settings.ambientVolume;
    _saveSettings();
  }

  function setSfxVolume(v) {
    _settings.sfxVolume = Math.max(0, Math.min(1, v));
    if (_sfxGain) _sfxGain.gain.value = _settings.sfxVolume;
    _saveSettings();
  }

  function setToneVolume(v) {
    _settings.toneVolume = Math.max(0, Math.min(1, v));
    if (_toneGain) _toneGain.gain.value = _settings.toneVolume;
    _saveSettings();
  }

  // ── Ducking ──────────────────────────────────────────────────────────

  function duckAmbient(durationMs = 3000) {
    if (!_duckGain || _isDucked) return;
    _isDucked = true;
    const ctx = _getContext();
    const now = ctx.currentTime;
    _duckGain.gain.cancelScheduledValues(now);
    _duckGain.gain.setValueAtTime(_duckGain.gain.value, now);
    _duckGain.gain.linearRampToValueAtTime(0.15, now + 0.3);

    clearTimeout(_duckTimer);
    _duckTimer = setTimeout(() => unduckAmbient(), durationMs);
  }

  function unduckAmbient() {
    if (!_duckGain || !_isDucked) return;
    _isDucked = false;
    clearTimeout(_duckTimer);
    const ctx = _getContext();
    const now = ctx.currentTime;
    _duckGain.gain.cancelScheduledValues(now);
    _duckGain.gain.setValueAtTime(_duckGain.gain.value, now);
    _duckGain.gain.linearRampToValueAtTime(1.0, now + 0.8);
  }

  // ── Ambient Layer Access ─────────────────────────────────────────────

  function getAmbientNode() {
    _ensureRunning();
    return _ambientGain;
  }

  function getContext() {
    return _getContext();
  }

  // ── SFX Playback ─────────────────────────────────────────────────────

  /**
   * Play a one-shot sound effect buffer through the SFX layer.
   * @param {AudioBuffer} buffer
   * @param {Object} [opts]
   * @param {number} [opts.volume=1] - Relative volume (0-1)
   * @param {number} [opts.playbackRate=1]
   * @returns {AudioBufferSourceNode}
   */
  function playSfx(buffer, opts = {}) {
    _ensureRunning();
    const ctx = _getContext();
    const source = ctx.createBufferSource();
    source.buffer = buffer;

    if (opts.playbackRate) source.playbackRate.value = opts.playbackRate;

    const vol = ctx.createGain();
    vol.gain.value = opts.volume !== undefined ? opts.volume : 1;
    source.connect(vol);
    vol.connect(_sfxGain);

    source.start(0);
    _activeSfxSources.push(source);
    source.onended = () => {
      _activeSfxSources = _activeSfxSources.filter((s) => s !== source);
    };
    return source;
  }

  function stopAllSfx() {
    for (const src of _activeSfxSources) {
      try { src.stop(); } catch (_) { /* already stopped */ }
    }
    _activeSfxSources = [];
  }

  // ── Sound Cue Dispatcher ─────────────────────────────────────────────

  /**
   * Dispatch a soundCue from an agent result.
   *
   * @param {Object} cue
   * @param {string} cue.type - 'tone' | 'one-shot' | 'ambient-blend'
   * @param {string} cue.name - Sound library name
   * @param {number} [cue.duration] - Duration in ms for temporary sounds
   * @param {number} [cue.volume=0.5] - Relative volume
   */
  function dispatchCue(cue) {
    if (!cue || !cue.name) return;
    if (!_settings.agentCuesEnabled) return;

    const lib = window.OrbSoundLibrary;
    if (!lib) {
      console.warn('[SoundEngine] OrbSoundLibrary not loaded, cannot dispatch cue:', cue.name);
      return;
    }

    const vol = cue.volume !== undefined ? cue.volume : 0.5;

    switch (cue.type) {
      case 'tone':
        lib.play(cue.name, { volume: vol });
        break;

      case 'one-shot':
        lib.play(cue.name, { volume: vol });
        break;

      case 'ambient-blend': {
        const ambient = window.OrbAmbient;
        if (!ambient) break;
        if (cue.duration) {
          ambient.blendTemporary(cue.name, cue.duration, vol);
        } else {
          ambient.setScene(cue.name);
        }
        break;
      }

      default:
        lib.play(cue.name, { volume: vol });
    }
  }

  // ── Settings ─────────────────────────────────────────────────────────

  function getSettings() {
    return { ..._settings };
  }

  function updateSettings(patch) {
    Object.assign(_settings, patch);
    if (patch.masterVolume !== undefined) setMasterVolume(patch.masterVolume);
    if (patch.ambientVolume !== undefined) setAmbientVolume(patch.ambientVolume);
    if (patch.sfxVolume !== undefined) setSfxVolume(patch.sfxVolume);
    if (patch.toneVolume !== undefined) setToneVolume(patch.toneVolume);
    _saveSettings();

    if (patch.ambientMode !== undefined || patch.ambientEnabled !== undefined) {
      const ambient = window.OrbAmbient;
      if (ambient) {
        if (_settings.ambientMode === 'off') {
          ambient.stop();
        } else if (_settings.ambientMode === 'auto') {
          ambient.autoFromTimeOfDay();
        }
      }
    }
  }

  // ── Cleanup ──────────────────────────────────────────────────────────

  function destroy() {
    stopAllSfx();
    clearTimeout(_duckTimer);
    if (_ctx && _ctx.state !== 'closed') {
      _ctx.close().catch(() => {});
    }
    _initialized = false;
  }

  // ── Expose ───────────────────────────────────────────────────────────

  window.OrbSoundEngine = {
    init,
    getContext,
    getAmbientNode,
    playSfx,
    stopAllSfx,
    duckAmbient,
    unduckAmbient,
    dispatchCue,
    getSettings,
    updateSettings,
    setMasterVolume,
    setAmbientVolume,
    setSfxVolume,
    setToneVolume,
    destroy,
  };
})();
