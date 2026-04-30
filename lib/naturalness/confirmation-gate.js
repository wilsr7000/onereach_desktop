/**
 * Confirmation Gate (Phase 1 / calibratedConfirmation)
 *
 * Integration surface that production code calls with the auction
 * winner + task in hand. Combines:
 *   - stakes-classifier
 *   - confirmation-policy
 *   - confirmation-phrases
 *
 * into one function that returns what the pipeline should do:
 *
 *   { decision: 'dispatch' | 'ack-and-dispatch' | 'confirm-first',
 *     phrase:   string|null,        -- text to speak (null for dispatch)
 *     stakes:   'low'|'medium'|'high',
 *     reason:   string              -- policy trace
 *   }
 *
 * The gate is pure + synchronous. It does NOT speak, emit, or suspend
 * anything on its own -- that is the caller's responsibility. This
 * keeps the gate unit-testable without Electron, TTS, or IPC.
 *
 * Production usage, e.g. inside the `task:assigned` handler in
 * exchange-bridge.js:
 *
 *   const { evaluateConfirmationGate } = require('../../lib/naturalness/confirmation-gate');
 *   const { isFlagEnabled } = require('../../lib/naturalness-flags');
 *
 *   if (isFlagEnabled('calibratedConfirmation')) {
 *     const gate = evaluateConfirmationGate({
 *       task,
 *       agent: getAgent(winner.agentId),
 *       winnerConfidence: winner.confidence,
 *       intentConfidence: task.metadata?.intentConfidence ?? 1.0,
 *       hasPriorContext: getRecentHistory().length > 0,
 *     });
 *
 *     if (gate.phrase) {
 *       await voiceSpeaker.speak(gate.phrase, { voice: agentVoice });
 *     }
 *     if (gate.decision === 'confirm-first') {
 *       // Phase 1.5 will add real suspension here. Today, narrate the
 *       // confirmation and proceed; the user still hears the warning.
 *       log.warn('naturalness', 'confirm-first not yet suspending', { reason: gate.reason });
 *     }
 *   }
 */

'use strict';

const { decide, DECISIONS, EXEC_TYPES } = require('./confirmation-policy');
const { classifyStakes, STAKES } = require('./stakes-classifier');
const { phraseForDecision } = require('./confirmation-phrases');

/**
 * @param {object} input
 * @param {object} input.task             - normalized task { content, action?, params? }
 * @param {object} input.agent            - winning agent { id, executionType?, stakes?, voice? }
 * @param {number} [input.winnerConfidence=1.0]
 * @param {number} [input.intentConfidence=1.0]
 * @param {boolean} [input.hasPriorContext=true]
 * @param {string} [input.planSummary='']  - winner bid's plan text, used by some confirmation templates
 * @param {object} [input.thresholds]      - policy threshold overrides
 * @param {() => number} [input.rng=Math.random] - for deterministic ack picks in tests
 *
 * @returns {{decision:string, phrase:string|null, stakes:string, reason:string, agent:object}}
 */
function evaluateConfirmationGate(input = {}) {
  const {
    task = {},
    agent = null,
    winnerConfidence = 1.0,
    intentConfidence = 1.0,
    hasPriorContext = true,
    planSummary = '',
    thresholds,
    rng,
  } = input;

  // Agents declare their own executionType via agent.executionType.
  // Default is 'informational' -- matches unified-bidder conventions.
  const executionType =
    (agent && agent.executionType) || EXEC_TYPES.INFORMATIONAL;

  const stakes = classifyStakes({ task, agent });

  const policy = decide({
    intentConfidence,
    winnerConfidence,
    executionType,
    stakes,
    hasPriorContext,
    thresholds,
  });

  const phrase = phraseForDecision({
    policy,
    intent: task.content || '',
    content: task.content || '',
    planSummary,
    stakes,
    rng,
  });

  return {
    decision: policy.decision,
    phrase,
    stakes,
    reason: policy.reason,
    agent: agent || null,
  };
}

/**
 * Convenience wrapper that takes the gate result and a side-effect
 * invoker, producing the production effect. Kept separate so unit
 * tests can assert on the gate result without needing a mock speaker.
 *
 * @param {object} gate - result of evaluateConfirmationGate
 * @param {object} effects
 * @param {(text:string, opts?:object) => Promise<any>} effects.speak
 * @param {(msg:string, meta?:object) => void} [effects.logWarn]
 * @returns {Promise<void>}
 */
async function applyGateEffects(gate, effects) {
  if (!effects || typeof effects.speak !== 'function') {
    throw new TypeError('applyGateEffects: effects.speak is required');
  }
  if (gate.phrase) {
    const voice = (gate.agent && gate.agent.voice) || 'alloy';
    await effects.speak(gate.phrase, { voice });
  }
  if (gate.decision === DECISIONS.CONFIRM && typeof effects.logWarn === 'function') {
    // Phase 1 does not suspend execution on confirm-first; the
    // caller proceeds after the confirmation is spoken. Surface
    // this so the log is obvious and the gap is easy to track.
    effects.logWarn('confirm-first not yet suspending; task will proceed', {
      stakes: gate.stakes,
      reason: gate.reason,
    });
  }
}

module.exports = {
  evaluateConfirmationGate,
  applyGateEffects,
  // Re-exports for convenience
  DECISIONS,
  STAKES,
};
