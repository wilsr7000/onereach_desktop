/**
 * Phase 4 Pipeline Simulator
 *
 * Wraps a barge detector and exposes scenario hooks so fixtures can
 * script TTS playback + user interruption patterns. The detector's
 * clock is bound to ctx.tts so scenario `wait` steps advance it too.
 *
 * Build a fresh sim per scenario so the detector, clock, and counters
 * never leak across fixtures.
 *
 * Fixture usage:
 *   { "type": "hook", "name": "ttsStart",  "args": { "text": "..." } }
 *   { "type": "hook", "name": "ttsEnd" }
 *   { "type": "hook", "name": "userSay",   "args": { "text": "stop" } }
 *   { "type": "wait", "ms": 300 }
 *
 * Meta fields populated (for assertions):
 *   bargeCount         -- total barges fired
 *   lastBargeKind      -- 'stop' | 'command' | 'unclear'
 *   lastBargeText      -- the user text that triggered the barge
 *   echoSuppressCount  -- times an echo was rejected
 *   ignoreCount        -- times a partial was ignored (ack / cooldown / no-tts)
 *   lastIgnoreKind     -- 'ack' | 'cooldown' | 'no-tts'
 */

'use strict';

const { createBargeDetector } = require('../../lib/naturalness/barge-detector');

function makePhase4Sim(options = {}) {
  let detector = null;
  let ttsStartedAt = null;

  function _ensureDetector(ctx) {
    if (detector) return detector;
    ctx.meta.bargeCount = 0;
    ctx.meta.echoSuppressCount = 0;
    ctx.meta.ignoreCount = 0;

    detector = createBargeDetector({
      ...options,
      // Bind the detector's clock to ctx.tts so `wait` ms in scenarios
      // correctly advance the grace window and cooldown.
      now: () => ctx.tts.now(),
      onBargeIn: (event) => {
        // Note: deliberately NOT calling ctx.tts.speak here. Speaking
        // would advance the simulated TTS clock, which breaks cooldown
        // timing in scenarios. Fixtures assert via meta.bargeCount.
        ctx.meta.bargeCount = (ctx.meta.bargeCount || 0) + 1;
        ctx.meta.lastBargeKind = event.kind;
        ctx.meta.lastBargeText = event.text;
        ctx.meta.lastBargeClassification = event.classification
          ? event.classification.kind
          : null;
      },
      onEchoSuppressed: (text, reason) => {
        ctx.meta.echoSuppressCount = (ctx.meta.echoSuppressCount || 0) + 1;
        ctx.meta.lastEchoReason = reason;
      },
      onIgnored: (info) => {
        ctx.meta.ignoreCount = (ctx.meta.ignoreCount || 0) + 1;
        ctx.meta.lastIgnoreKind = info.kind;
      },
    });
    return detector;
  }

  async function ttsStart(args, ctx) {
    const d = _ensureDetector(ctx);
    ttsStartedAt = ctx.tts.now();
    d.onTtsStart(args.text || '');
  }

  async function ttsEnd(_args, ctx) {
    const d = _ensureDetector(ctx);
    d.onTtsEnd();
  }

  async function ttsUpdate(args, ctx) {
    const d = _ensureDetector(ctx);
    d.onTtsUpdate(args.text || '');
  }

  async function userSay(args, ctx) {
    const d = _ensureDetector(ctx);
    d.onUserPartial(args.text || '');
  }

  function getStateAt() {
    return ttsStartedAt;
  }

  return {
    hooks: { ttsStart, ttsEnd, ttsUpdate, userSay },
    getStateAt,
  };
}

module.exports = { makePhase4Sim };
