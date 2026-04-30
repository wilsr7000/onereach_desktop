/**
 * Phase 2 Pipeline Simulator
 *
 * Hook that composes the Phase 2 modules (voice-resolver,
 * agent-transition-tracker, handoff-phrases) into one agent-turn
 * simulation. Scenarios drive it by declaring what agent is about to
 * speak; the sim decides whether to emit a handoff bridge TTS, then
 * emits the main utterance TTS in the resolved voice.
 *
 * The sim is stateful across steps in a single scenario run: it
 * creates its own AgentTransitionTracker so one fixture can model
 * multiple consecutive turns.
 *
 * Registration (in a vitest file):
 *   import { makePhase2Sim } from '../harness/phase2-sim';
 *   runScenario(scenario, { hooks: { agentTurn: makePhase2Sim().agentTurn } });
 *
 * Fixture step:
 *   { "type": "hook", "name": "agentTurn", "args": {
 *       "agentId": "time-agent",
 *       "agentName": "Time Agent",
 *       "utterance": "it's three in the afternoon",
 *       "contextKey": "voice"
 *   }}
 */

'use strict';

const { resolveVoice } = require('../../lib/naturalness/voice-resolver');
const { buildHandoffPhrase } = require('../../lib/naturalness/handoff-phrases');
const {
  AgentTransitionTracker,
} = require('../../lib/naturalness/agent-transition-tracker');

const DEFAULT_AGENT_VOICES = {
  'dj-agent': 'ash',
  'smalltalk-agent': 'coral',
  'time-agent': 'sage',
  'weather-agent': 'verse',
  'calendar-query-agent': 'alloy',
  'calendar-mutate-agent': 'alloy',
  'help-agent': 'alloy',
  'search-agent': 'echo',
};

/**
 * Build a fresh Phase 2 sim harness. Each call produces an isolated
 * tracker so scenarios do not leak state into one another.
 *
 * @param {object} [options]
 * @param {number} [options.ttlMs]     - tracker TTL
 * @param {Object<string,string>} [options.defaultAgentVoices]
 *
 * @returns {{
 *   agentTurn: (args: object, ctx: object) => Promise<void>,
 *   tracker: AgentTransitionTracker
 * }}
 */
function makePhase2Sim(options = {}) {
  // Scenarios often advance ctx.tts's clock via "wait" steps, but the
  // tracker has its own notion of time. Use Date.now() by default;
  // fixtures can declare `trackerTtlMs` to tighten TTL for testing.
  const tracker = new AgentTransitionTracker({
    ttlMs: options.ttlMs,
  });

  const defaultAgentVoices = options.defaultAgentVoices || DEFAULT_AGENT_VOICES;

  async function agentTurn(args = {}, ctx) {
    if (!ctx || !ctx.tts || !ctx.meta) {
      throw new Error('phase2-sim: scenario-runner ctx is missing required fields');
    }

    const {
      agentId,
      agentName,
      agentVoice,
      utterance = '',
      contextKey = 'default',
      rngSeed = 0,
      // Allow fixture to advance the tracker's wall-clock view without
      // touching the tts clock (useful for TTL tests).
      trackerClockAdvanceMs = 0,
    } = args;

    if (!agentId) {
      throw new Error('phase2-sim: args.agentId is required');
    }

    // Resolve voice via the naturalness layer.
    const agentRecord = {
      id: agentId,
      name: agentName || agentId,
    };
    if (agentVoice) agentRecord.voice = agentVoice;
    const voiceResult = resolveVoice({
      agentId,
      agent: agentRecord,
      defaultAgentVoices,
    });

    // Check for a handoff (only meaningful in multi-voice mode).
    const lastAgent = tracker.getLastAgent(contextKey);
    const rng = _makeDeterministicRng(rngSeed);
    const handoffPhrase = buildHandoffPhrase({
      fromAgentId: lastAgent,
      toAgentId: agentId,
      fromAgent: lastAgent ? { id: lastAgent } : null,
      toAgent: agentRecord,
      rng,
    });

    let handoffSpoken = null;
    if (handoffPhrase) {
      // The bridge phrase is spoken in the OUTGOING agent's voice to
      // soften the handoff. We look up the outgoing voice through the
      // same resolver so flag-on cases never fire (resolver returns
      // cap-chew source -> buildHandoffPhrase already returns null).
      const outgoingVoice = resolveVoice({
        agentId: lastAgent,
        defaultAgentVoices,
      }).voice;
      await ctx.tts.speak(handoffPhrase, { voice: outgoingVoice });
      handoffSpoken = handoffPhrase;
      // Let the bridge finish before the incoming voice takes over.
      ctx.tts.playthrough();
    }

    // Main turn.
    if (utterance) {
      await ctx.tts.speak(utterance, { voice: voiceResult.voice });
      ctx.tts.playthrough();
    }

    // Record + diagnostics.
    tracker.recordAgent(contextKey, agentId);
    if (trackerClockAdvanceMs > 0) {
      // Simulate time passing for TTL testing by forcibly expiring
      // if the advance exceeds the TTL. (Cheap hack: re-instantiate
      // tracker is overkill; instead, call getLastAgent with a faux
      // future clock via the "forget if stale" path by directly
      // forgetting the entry when the advance exceeds ttlMs.)
      if (options.ttlMs && trackerClockAdvanceMs > options.ttlMs) {
        tracker.forget(contextKey);
      }
    }

    ctx.meta.voice = voiceResult.voice;
    ctx.meta.voiceSource = voiceResult.source;
    ctx.meta.handoff = Boolean(handoffSpoken);
    ctx.meta.handoffPhrase = handoffSpoken;
    ctx.meta.lastAgentBeforeTurn = lastAgent;
  }

  return { agentTurn, tracker };
}

function _makeDeterministicRng(seed) {
  let state = (typeof seed === 'number' ? seed : 0) >>> 0;
  return function rng() {
    state = (state * 48271) % 0x7fffffff;
    return state / 0x7fffffff;
  };
}

module.exports = { makePhase2Sim, DEFAULT_AGENT_VOICES };
