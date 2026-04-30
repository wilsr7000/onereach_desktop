/**
 * Phase 1 Pipeline Simulator
 *
 * A thin hook that lets naturalness scenario fixtures drive the
 * calibratedConfirmation logic end-to-end without booting the real
 * Electron pipeline. It wires together the three Phase 1 modules:
 *
 *   stakes-classifier  ->  confirmation-policy  ->  confirmation-phrases
 *
 * and then does exactly one user-observable thing: emits a TTS event
 * (or not) that matches the policy's decision. Scenarios can assert
 * against TTS events (user-observable) and against the `meta` scratch
 * bag the hook fills in (decision / stakes / reason -- useful for
 * diagnosing why a scenario went the way it did).
 *
 * The hook is registered on the scenario runner like this:
 *
 *   import { pipelineSim } from '../harness/phase1-sim';
 *   runScenario(scenario, { hooks: { pipelineSim } });
 *
 * And invoked from fixtures via:
 *
 *   { "type": "hook", "name": "pipelineSim", "args": {
 *       "intent": "delete all my emails",
 *       "executionType": "action",
 *       "intentConfidence": 1.0,
 *       "winnerConfidence": 0.95,
 *       "planSummary": "empty the inbox folder",
 *       "agent": { "id": "email-agent" }
 *   }}
 *
 * Stakes are classified from (args.content || args.intent) unless the
 * fixture overrides `stakes` directly.
 */

'use strict';

const { decide } = require('../../lib/naturalness/confirmation-policy');
const { classifyStakes } = require('../../lib/naturalness/stakes-classifier');
const { phraseForDecision } = require('../../lib/naturalness/confirmation-phrases');

/**
 * Hook function. Signature matches scenario-runner's contract:
 *   (args, ctx) => void
 * where ctx contains { tts, mic, meta, hooks }.
 */
async function pipelineSim(args, ctx) {
  if (!ctx || !ctx.tts || !ctx.meta) {
    throw new Error('pipelineSim: scenario-runner ctx is missing required fields');
  }

  const {
    intent = '',
    content = intent,
    executionType = 'informational',
    intentConfidence = 1.0,
    winnerConfidence = 1.0,
    planSummary = '',
    agent = null,
    hasPriorContext = true,
    stakes: stakesOverride = null,
    rngSeed = 0,
  } = args;

  // Confirmation gate is always on. Classify stakes (or use override).
  const stakes =
    stakesOverride ||
    classifyStakes({
      task: { content, action: args.action, params: args.params },
      agent,
    });

  // Run the policy decision.
  const policy = decide({
    intentConfidence,
    winnerConfidence,
    executionType,
    stakes,
    hasPriorContext,
  });

  // Pick the phrase for the decision.
  const rng = _makeDeterministicRng(rngSeed);
  const phrase = phraseForDecision({
    policy,
    intent,
    content,
    planSummary,
    stakes,
    rng,
  });

  // Emit observable TTS event if the decision produces a phrase.
  if (phrase) {
    await ctx.tts.speak(phrase, { voice: (agent && agent.voice) || 'alloy' });
  }

  // Stash diagnostics on meta so fixtures can assert against the
  // decision and stakes directly -- not just observed TTS.
  ctx.meta.decision = policy.decision;
  ctx.meta.reason = policy.reason;
  ctx.meta.stakes = stakes;
  ctx.meta.phrase = phrase;
}

/**
 * Deterministic LCG based on a seed so scenarios that specify
 * rngSeed always produce the same ack phrase. Keeps fixtures stable
 * across runs and machines.
 */
function _makeDeterministicRng(seed) {
  let state = (typeof seed === 'number' ? seed : 0) >>> 0;
  return function rng() {
    // Park-Miller LCG -- cheap, sufficient for pool selection.
    state = (state * 48271) % 0x7fffffff;
    return state / 0x7fffffff;
  };
}

module.exports = { pipelineSim };
