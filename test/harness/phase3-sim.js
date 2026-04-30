/**
 * Phase 3 Pipeline Simulator
 *
 * Drives a PauseDetector instance via scenario hooks, mirroring the
 * event shape a real voice-listener would emit:
 *
 *   voicePartial      -- new partial transcript from the server
 *   voiceSilence      -- silence duration since last speech burst
 *   voiceSpeechResume -- VAD says the user started talking again
 *   voiceEvaluate     -- run the detector's policy now
 *
 * When the detector commits, the simulator speaks a marker phrase
 * through ctx.tts so scenarios can assert on `ttsSpokenCount` and
 * `ttsContains`. It also stashes `meta.committed`, `meta.commitText`,
 * `meta.commitReason`, and `meta.lastDecision` for direct assertions.
 *
 * Scenarios can pre-script LLM classifier responses via scenario.llm
 * (array of { complete, confidence, reasoning } objects). Each
 * call_llm consumes the next entry.
 *
 * Build a fresh sim per scenario so detector + LLM state never leaks.
 */

'use strict';

const { createPauseDetector } = require('../../lib/naturalness/pause-detector');

function makePhase3Sim({ llmResponses = [], thresholds = {} } = {}) {
  let aiCallCount = 0;
  async function ai() {
    const entry = llmResponses[aiCallCount++];
    if (!entry) {
      throw new Error(`phase3-sim: no scripted LLM response for call #${aiCallCount}`);
    }
    if (entry instanceof Error) throw entry;
    return { content: JSON.stringify(entry) };
  }

  // Placeholder callbacks; wired per-scenario via closure.
  let detectorRef = null;

  function _detector(ctx) {
    if (detectorRef) return detectorRef;
    detectorRef = createPauseDetector({
      ai,
      thresholds,
      onCommitReady: async (text, meta) => {
        ctx.meta.committed = true;
        ctx.meta.commitText = text;
        ctx.meta.commitReason = meta.reason;
        ctx.meta.commitClassification = meta.classification;
        ctx.meta.commitHitMaxWait = Boolean(meta.hitMaxWait);
        ctx.meta.commitLlm = meta.llm || null;
        // Marker speak so existing tts assertions work too.
        await ctx.tts.speak(`[committed] ${text}`, { voice: 'alloy' });
      },
      onClassifyNeeded: () => {
        ctx.meta.llmConsulted = (ctx.meta.llmConsulted || 0) + 1;
      },
    });
    return detectorRef;
  }

  async function voicePartial(args, ctx) {
    _detector(ctx).onPartial(args.text || '');
  }

  async function voiceSilence(args, ctx) {
    _detector(ctx).setSilence(Number(args.ms) || 0);
  }

  async function voiceSpeechResume(_args, ctx) {
    _detector(ctx).resetOnSpeech();
  }

  async function voiceEvaluate(_args, ctx) {
    const decision = await _detector(ctx).evaluate();
    ctx.meta.lastDecision = decision.action;
    ctx.meta.lastClassification = decision.classification;
  }

  return {
    hooks: {
      voicePartial,
      voiceSilence,
      voiceSpeechResume,
      voiceEvaluate,
    },
    getAiCallCount: () => aiCallCount,
  };
}

module.exports = { makePhase3Sim };
