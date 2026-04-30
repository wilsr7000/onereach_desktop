/**
 * Orb Ambient Synthesizer -- Web Audio background texture generator.
 *
 * All sounds are synthesized locally using noise generators, oscillators,
 * and filters. Zero API calls, zero cost.
 *
 * Scenes:
 *   rain-light     Gentle rain (filtered white noise, slow modulation)
 *   rain-heavy     Storm (noise + low rumble + irregular crack bursts)
 *   cafe           Coffee shop hum (brownian noise + occasional clinks)
 *   focus          Binaural-inspired low-frequency pulse
 *   nature         Wind through trees (layered bandpass noise)
 *   night          Very low sine drones with slow pitch wandering
 *   morning        Bright filtered noise with occasional bird-like chirps
 *
 * Depends on OrbSoundEngine for the audio graph destination.
 * Loaded as a <script> in orb.html after orb-sound-engine.js.
 * Exposes window.OrbAmbient namespace.
 */

'use strict';

(function () {
  let _activeScene = null;
  let _nodes = [];          // all active audio nodes for current scene
  let _crossfadeTimer = null;
  let _tempTimer = null;
  let _sceneGain = null;    // per-scene envelope for crossfade

  function _engine() { return window.OrbSoundEngine; }

  function _ctx() {
    const engine = _engine();
    return engine ? engine.getContext() : null;
  }

  function _destination() {
    const engine = _engine();
    return engine ? engine.getAmbientNode() : null;
  }

  function _cleanup() {
    for (const n of _nodes) {
      try {
        if (typeof n.stop === 'function') n.stop();
        if (typeof n.disconnect === 'function') n.disconnect();
      } catch (_) { /* already stopped */ }
    }
    _nodes = [];
    _sceneGain = null;
  }

  /**
   * Create a noise source (white/pink/brown).
   * Returns a buffer source node that loops indefinitely.
   */
  function _makeNoise(ctx, type, durationSec = 4) {
    const sampleRate = ctx.sampleRate;
    const length = sampleRate * durationSec;
    const buffer = ctx.createBuffer(1, length, sampleRate);
    const data = buffer.getChannelData(0);

    if (type === 'white') {
      for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    } else if (type === 'brown') {
      let last = 0;
      for (let i = 0; i < length; i++) {
        const w = Math.random() * 2 - 1;
        data[i] = (last + 0.02 * w) / 1.02;
        last = data[i];
        data[i] *= 3.5;
      }
    } else if (type === 'pink') {
      let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
      for (let i = 0; i < length; i++) {
        const w = Math.random() * 2 - 1;
        b0 = 0.99886 * b0 + w * 0.0555179;
        b1 = 0.99332 * b1 + w * 0.0750759;
        b2 = 0.96900 * b2 + w * 0.1538520;
        b3 = 0.86650 * b3 + w * 0.3104856;
        b4 = 0.55000 * b4 + w * 0.5329522;
        b5 = -0.7616 * b5 - w * 0.0168980;
        data[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
        data[i] *= 0.11;
        b6 = w * 0.115926;
      }
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    return source;
  }

  function _track(node) {
    _nodes.push(node);
    return node;
  }

  // ── Scene Builders ───────────────────────────────────────────────────
  // Each returns nothing; they wire nodes into _sceneGain.

  function _buildRainLight(ctx) {
    const noise = _track(_makeNoise(ctx, 'white'));
    const bp = _track(ctx.createBiquadFilter());
    bp.type = 'bandpass';
    bp.frequency.value = 800;
    bp.Q.value = 0.4;

    const lfo = _track(ctx.createOscillator());
    lfo.type = 'sine';
    lfo.frequency.value = 0.15;
    const lfoGain = _track(ctx.createGain());
    lfoGain.gain.value = 200;
    lfo.connect(lfoGain);
    lfoGain.connect(bp.frequency);
    lfo.start();

    const vol = _track(ctx.createGain());
    vol.gain.value = 0.6;

    noise.connect(bp);
    bp.connect(vol);
    vol.connect(_sceneGain);
    noise.start();
  }

  function _buildRainHeavy(ctx) {
    _buildRainLight(ctx);

    const rumble = _track(ctx.createOscillator());
    rumble.type = 'sine';
    rumble.frequency.value = 55;
    const rumbleGain = _track(ctx.createGain());
    rumbleGain.gain.value = 0.12;

    const rumbleLfo = _track(ctx.createOscillator());
    rumbleLfo.type = 'sine';
    rumbleLfo.frequency.value = 0.08;
    const rumbleLfoG = _track(ctx.createGain());
    rumbleLfoG.gain.value = 0.06;
    rumbleLfo.connect(rumbleLfoG);
    rumbleLfoG.connect(rumbleGain.gain);
    rumbleLfo.start();

    rumble.connect(rumbleGain);
    rumbleGain.connect(_sceneGain);
    rumble.start();
  }

  function _buildCafe(ctx) {
    const brown = _track(_makeNoise(ctx, 'brown'));
    const lp = _track(ctx.createBiquadFilter());
    lp.type = 'lowpass';
    lp.frequency.value = 600;
    lp.Q.value = 0.5;

    const vol = _track(ctx.createGain());
    vol.gain.value = 0.4;

    brown.connect(lp);
    lp.connect(vol);
    vol.connect(_sceneGain);
    brown.start();

    const hum = _track(ctx.createOscillator());
    hum.type = 'sine';
    hum.frequency.value = 120;
    const humGain = _track(ctx.createGain());
    humGain.gain.value = 0.03;
    hum.connect(humGain);
    humGain.connect(_sceneGain);
    hum.start();
  }

  function _buildFocus(ctx) {
    const left = _track(ctx.createOscillator());
    left.type = 'sine';
    left.frequency.value = 200;

    const right = _track(ctx.createOscillator());
    right.type = 'sine';
    right.frequency.value = 210;

    const merger = _track(ctx.createChannelMerger(2));
    const leftGain = _track(ctx.createGain());
    leftGain.gain.value = 0.08;
    const rightGain = _track(ctx.createGain());
    rightGain.gain.value = 0.08;

    left.connect(leftGain);
    leftGain.connect(merger, 0, 0);
    right.connect(rightGain);
    rightGain.connect(merger, 0, 1);
    merger.connect(_sceneGain);

    left.start();
    right.start();

    const pink = _track(_makeNoise(ctx, 'pink'));
    const pinkLp = _track(ctx.createBiquadFilter());
    pinkLp.type = 'lowpass';
    pinkLp.frequency.value = 300;
    const pinkVol = _track(ctx.createGain());
    pinkVol.gain.value = 0.15;
    pink.connect(pinkLp);
    pinkLp.connect(pinkVol);
    pinkVol.connect(_sceneGain);
    pink.start();
  }

  function _buildNature(ctx) {
    const noise = _track(_makeNoise(ctx, 'pink'));

    const bp1 = _track(ctx.createBiquadFilter());
    bp1.type = 'bandpass';
    bp1.frequency.value = 400;
    bp1.Q.value = 0.3;

    const bp2 = _track(ctx.createBiquadFilter());
    bp2.type = 'bandpass';
    bp2.frequency.value = 1200;
    bp2.Q.value = 0.5;

    const lfo = _track(ctx.createOscillator());
    lfo.type = 'sine';
    lfo.frequency.value = 0.2;
    const lfoG = _track(ctx.createGain());
    lfoG.gain.value = 150;
    lfo.connect(lfoG);
    lfoG.connect(bp1.frequency);
    lfo.start();

    const vol1 = _track(ctx.createGain());
    vol1.gain.value = 0.5;
    const vol2 = _track(ctx.createGain());
    vol2.gain.value = 0.2;

    noise.connect(bp1);
    noise.connect(bp2);
    bp1.connect(vol1);
    bp2.connect(vol2);
    vol1.connect(_sceneGain);
    vol2.connect(_sceneGain);
    noise.start();
  }

  function _buildNight(ctx) {
    const drone1 = _track(ctx.createOscillator());
    drone1.type = 'sine';
    drone1.frequency.value = 82;
    const drone2 = _track(ctx.createOscillator());
    drone2.type = 'sine';
    drone2.frequency.value = 110;

    const lfo1 = _track(ctx.createOscillator());
    lfo1.type = 'sine';
    lfo1.frequency.value = 0.05;
    const lfoG1 = _track(ctx.createGain());
    lfoG1.gain.value = 3;
    lfo1.connect(lfoG1);
    lfoG1.connect(drone1.frequency);
    lfo1.start();

    const lfo2 = _track(ctx.createOscillator());
    lfo2.type = 'sine';
    lfo2.frequency.value = 0.07;
    const lfoG2 = _track(ctx.createGain());
    lfoG2.gain.value = 4;
    lfo2.connect(lfoG2);
    lfoG2.connect(drone2.frequency);
    lfo2.start();

    const g1 = _track(ctx.createGain());
    g1.gain.value = 0.08;
    const g2 = _track(ctx.createGain());
    g2.gain.value = 0.06;

    drone1.connect(g1);
    g1.connect(_sceneGain);
    drone2.connect(g2);
    g2.connect(_sceneGain);
    drone1.start();
    drone2.start();
  }

  function _buildMorning(ctx) {
    const noise = _track(_makeNoise(ctx, 'pink'));
    const hp = _track(ctx.createBiquadFilter());
    hp.type = 'highpass';
    hp.frequency.value = 2000;
    const lp = _track(ctx.createBiquadFilter());
    lp.type = 'lowpass';
    lp.frequency.value = 6000;
    const vol = _track(ctx.createGain());
    vol.gain.value = 0.15;
    noise.connect(hp);
    hp.connect(lp);
    lp.connect(vol);
    vol.connect(_sceneGain);
    noise.start();

    const chirpGain = _track(ctx.createGain());
    chirpGain.gain.value = 0;
    chirpGain.connect(_sceneGain);

    let chirpInterval = setInterval(() => {
      if (!_sceneGain) { clearInterval(chirpInterval); return; }
      if (Math.random() > 0.3) return;
      try {
        const now = ctx.currentTime;
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        const freq = 1800 + Math.random() * 1400;
        osc.frequency.setValueAtTime(freq, now);
        osc.frequency.linearRampToValueAtTime(freq * 1.15, now + 0.08);
        osc.frequency.linearRampToValueAtTime(freq * 0.9, now + 0.15);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0, now);
        g.gain.linearRampToValueAtTime(0.06, now + 0.02);
        g.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
        osc.connect(g);
        g.connect(_sceneGain);
        osc.start(now);
        osc.stop(now + 0.2);
      } catch (_) { /* context closed */ }
    }, 2500);
    _nodes.push({ stop: () => clearInterval(chirpInterval), disconnect: () => {} });
  }

  const SCENE_BUILDERS = {
    'rain-light': _buildRainLight,
    'rain-heavy': _buildRainHeavy,
    'cafe': _buildCafe,
    'focus': _buildFocus,
    'nature': _buildNature,
    'night': _buildNight,
    'morning': _buildMorning,
  };

  // ── Public API ───────────────────────────────────────────────────────

  /**
   * Start or crossfade to a named ambient scene.
   */
  function setScene(name) {
    const builder = SCENE_BUILDERS[name];
    if (!builder) {
      console.warn('[OrbAmbient] Unknown scene:', name);
      return;
    }

    // Instrument + respect the OrbAudio mute kill-switch. Ambient scenes
    // are the #1 suspect for "orb making noises while idle" because they
    // loop indefinitely; routing through OrbAudio.isMuted() lets one
    // toggle silence all three layers (tones / TTS / ambient).
    try {
      window.OrbAudio?.recordSound?.('ambient.setScene', { scene: name });
      if (window.OrbAudio?.isMuted?.()) {
        console.log('[OrbAmbient] Muted via OrbAudio -- not starting scene:', name);
        return;
      }
    } catch (_e) { /* instrumentation must not block */ }

    const ctx = _ctx();
    const dest = _destination();
    if (!ctx || !dest) return;

    if (ctx.state === 'suspended') ctx.resume();

    const now = ctx.currentTime;

    if (_sceneGain) {
      const oldGain = _sceneGain;
      oldGain.gain.setValueAtTime(oldGain.gain.value, now);
      oldGain.gain.linearRampToValueAtTime(0, now + 1.5);
      const oldNodes = [..._nodes];
      clearTimeout(_crossfadeTimer);
      _crossfadeTimer = setTimeout(() => {
        for (const n of oldNodes) {
          try {
            if (typeof n.stop === 'function') n.stop();
            if (typeof n.disconnect === 'function') n.disconnect();
          } catch (_) { /* ok */ }
        }
      }, 2000);
      _nodes = [];
    }

    _sceneGain = ctx.createGain();
    _sceneGain.gain.setValueAtTime(0, now);
    _sceneGain.gain.linearRampToValueAtTime(1, now + 2);
    _sceneGain.connect(dest);
    _track(_sceneGain);

    builder(ctx);
    _activeScene = name;
    console.log('[OrbAmbient] Scene:', name);
  }

  /**
   * Temporarily blend a scene over the current one, then fade out.
   */
  function blendTemporary(name, durationMs, volume = 0.3) {
    const builder = SCENE_BUILDERS[name];
    if (!builder) return;

    const ctx = _ctx();
    const dest = _destination();
    if (!ctx || !dest) return;

    if (ctx.state === 'suspended') ctx.resume();

    const tempNodes = [];
    const tempGain = ctx.createGain();
    const now = ctx.currentTime;
    const fadeIn = 1.0;
    const fadeOut = 1.5;
    const holdSec = (durationMs - fadeIn * 1000 - fadeOut * 1000) / 1000;
    const hold = Math.max(0.5, holdSec);

    tempGain.gain.setValueAtTime(0, now);
    tempGain.gain.linearRampToValueAtTime(volume, now + fadeIn);
    tempGain.gain.setValueAtTime(volume, now + fadeIn + hold);
    tempGain.gain.linearRampToValueAtTime(0, now + fadeIn + hold + fadeOut);
    tempGain.connect(dest);

    const savedSceneGain = _sceneGain;
    const savedNodes = _nodes;
    _sceneGain = tempGain;
    _nodes = tempNodes;

    builder(ctx);

    const allTemp = [...tempNodes, tempGain];
    _sceneGain = savedSceneGain;
    _nodes = savedNodes;

    const cleanupMs = (fadeIn + hold + fadeOut) * 1000 + 500;
    clearTimeout(_tempTimer);
    _tempTimer = setTimeout(() => {
      for (const n of allTemp) {
        try {
          if (typeof n.stop === 'function') n.stop();
          if (typeof n.disconnect === 'function') n.disconnect();
        } catch (_) { /* ok */ }
      }
    }, cleanupMs);
  }

  function stop() {
    _cleanup();
    _activeScene = null;
    clearTimeout(_crossfadeTimer);
    clearTimeout(_tempTimer);
    console.log('[OrbAmbient] Stopped');
  }

  function getActiveScene() {
    return _activeScene;
  }

  function getAvailableScenes() {
    return Object.keys(SCENE_BUILDERS);
  }

  /**
   * Pick an ambient scene based on time of day and start it.
   */
  function autoFromTimeOfDay() {
    const hour = new Date().getHours();
    let scene;
    if (hour >= 6 && hour < 10) scene = 'morning';
    else if (hour >= 10 && hour < 17) scene = 'nature';
    else if (hour >= 17 && hour < 21) scene = 'cafe';
    else scene = 'night';

    if (scene !== _activeScene) {
      setScene(scene);
    }
  }

  window.OrbAmbient = {
    setScene,
    blendTemporary,
    stop,
    getActiveScene,
    getAvailableScenes,
    autoFromTimeOfDay,
  };
})();
