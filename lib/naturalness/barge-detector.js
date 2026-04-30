/**
 * Barge Detector (Phase 4 / bargeIn)
 *
 * Stateful orchestrator that watches TTS playback + incoming user
 * speech and fires `onBargeIn` when the user genuinely interrupts.
 *
 * Wires together:
 *   - echo-filter        -- rejects mic picking up its own TTS
 *   - barge-classifier   -- decides stop vs ack vs command
 *
 * Plus timing controls:
 *   - graceAfterTtsMs    -- user speech arriving within this window
 *                           after TTS ends still counts as during-TTS,
 *                           since mic buffers / echo tails overlap.
 *   - cooldownMs         -- after a barge fires, suppress further
 *                           barges for this long to avoid barge storms
 *                           when the user keeps speaking.
 *
 * Events the consumer feeds us:
 *   onTtsStart(text)       -- a TTS utterance began. `text` is the
 *                             full planned spoken text.
 *   onTtsUpdate(text)      -- the TTS text changed (unlikely but
 *                             supported for streaming TTS producers).
 *   onTtsEnd()             -- TTS completed naturally.
 *   onUserPartial(text)    -- user speech captured while listening.
 *   setNow(ms)             -- override clock (tests).
 *
 * Callbacks:
 *   onBargeIn(event)       -- fired exactly once per barge. The event
 *                             contains { kind, text, nonEchoContent,
 *                             classification, reason, ttsText }.
 *   onEchoSuppressed(text, reason)  -- optional; fired when user
 *                             speech was filtered as echo.
 *
 * Once a barge fires, subsequent user partials are ignored until the
 * cooldown expires OR the consumer calls reset().
 */

'use strict';

const { isLikelyEcho } = require('./echo-filter');
const { classifyBarge } = require('./barge-classifier');

const DEFAULT_OPTIONS = Object.freeze({
  graceAfterTtsMs: 300,
  cooldownMs: 500,
});

/**
 * @param {object} [options]
 * @param {number} [options.graceAfterTtsMs]
 * @param {number} [options.cooldownMs]
 * @param {(event:object) => void} [options.onBargeIn]
 * @param {(text:string, reason:string) => void} [options.onEchoSuppressed]
 * @param {(event:object) => void} [options.onIgnored]   - ack / cooldown / no-tts
 * @param {() => number} [options.now] - clock override for tests
 */
function createBargeDetector(options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const onBargeIn = typeof opts.onBargeIn === 'function' ? opts.onBargeIn : () => {};
  const onEchoSuppressed = typeof opts.onEchoSuppressed === 'function' ? opts.onEchoSuppressed : () => {};
  const onIgnored = typeof opts.onIgnored === 'function' ? opts.onIgnored : () => {};

  const state = {
    ttsPlaying: false,
    ttsText: '',
    ttsEndedAt: null,
    lastBargeAt: null,
    totalBarges: 0,
  };

  function onTtsStart(text) {
    state.ttsPlaying = true;
    state.ttsText = typeof text === 'string' ? text : '';
    state.ttsEndedAt = null;
  }

  function onTtsUpdate(text) {
    if (typeof text === 'string') state.ttsText = text;
  }

  function onTtsEnd() {
    state.ttsPlaying = false;
    state.ttsEndedAt = now();
  }

  function _inGraceWindow() {
    if (state.ttsPlaying) return true;
    // ttsEndedAt === null means we never had TTS; 0 is a valid clock
    // value so explicitly null-check instead of truthy-check.
    if (state.ttsEndedAt === null) return false;
    return now() - state.ttsEndedAt <= opts.graceAfterTtsMs;
  }

  function _inCooldown() {
    if (state.lastBargeAt === null) return false;
    return now() - state.lastBargeAt < opts.cooldownMs;
  }

  function onUserPartial(text) {
    const candidate = (text || '').toString().trim();
    if (!candidate) return;

    if (!_inGraceWindow()) {
      onIgnored({ kind: 'no-tts', text: candidate, reason: 'no TTS active' });
      return;
    }

    if (_inCooldown()) {
      onIgnored({ kind: 'cooldown', text: candidate, reason: 'within post-barge cooldown' });
      return;
    }

    const echo = isLikelyEcho({
      candidate,
      ttsText: state.ttsText,
    });
    if (echo.isEcho) {
      onEchoSuppressed(candidate, echo.reason);
      return;
    }

    const classification = classifyBarge(echo.nonEchoContent || candidate);

    if (classification.kind === 'ack') {
      onIgnored({
        kind: 'ack',
        text: candidate,
        classification,
        reason: classification.reason,
      });
      return;
    }

    // stop / command / unclear all fire a barge.
    const event = {
      kind: classification.kind,
      text: candidate,
      nonEchoContent: echo.nonEchoContent || candidate,
      classification,
      reason: classification.reason,
      ttsText: state.ttsText,
      at: now(),
    };
    state.lastBargeAt = now();
    state.totalBarges++;

    try {
      onBargeIn(event);
    } catch (_e) {
      // Callback errors must not corrupt detector state.
    }
  }

  function reset() {
    state.ttsPlaying = false;
    state.ttsText = '';
    state.ttsEndedAt = null;
    state.lastBargeAt = null;
    state.totalBarges = 0;
  }

  function getState() {
    return {
      ttsPlaying: state.ttsPlaying,
      ttsText: state.ttsText,
      ttsEndedAt: state.ttsEndedAt,
      lastBargeAt: state.lastBargeAt,
      totalBarges: state.totalBarges,
      inGraceWindow: _inGraceWindow(),
      inCooldown: _inCooldown(),
    };
  }

  return {
    onTtsStart,
    onTtsUpdate,
    onTtsEnd,
    onUserPartial,
    reset,
    getState,
  };
}

module.exports = {
  createBargeDetector,
  DEFAULT_OPTIONS,
};
