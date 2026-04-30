/**
 * Pause Detector (Phase 3 / pauseDetection)
 *
 * Stateful orchestrator on top of turn-taking + utterance-classifier.
 * Fed events from the voice pipeline and fires onCommitReady exactly
 * once when the policy decides the turn is over.
 *
 * Event API:
 *   det.onPartial(text)         -- server sent a new partial transcript
 *   det.setSilence(ms)          -- update silence duration after last speech
 *   det.resetOnSpeech()         -- VAD resumed, clear silence + commit flag
 *   det.evaluate()              -- run policy now (async if LLM consulted)
 *   det.reset()                 -- wipe state
 *   det.getState()              -- diagnostics snapshot
 *
 * Callbacks (set via options):
 *   onCommitReady(text, meta)   -- fires once per committed turn
 *   onClassifyNeeded(partial)   -- optional; fires when the policy
 *                                  decides to consult the LLM
 *
 * IDEMPOTENCY:
 *   Once the detector fires onCommitReady, subsequent evaluate()
 *   calls are no-ops until resetOnSpeech() or reset() is called.
 *   This mirrors how a voice turn works: one commit, then the next
 *   speech burst starts a fresh turn.
 */

'use strict';

const turnTaking = require('./turn-taking');
const { createUtteranceClassifier } = require('./utterance-classifier');

/**
 * @param {object} [options]
 * @param {object} [options.thresholds]
 * @param {object} [options.classifier]  - a pre-built classifier (or create one from options.ai)
 * @param {(args:object)=>Promise<{content:string}>} [options.ai] - LLM fn
 * @param {(text:string, meta:object) => void} [options.onCommitReady]
 * @param {(partial:string) => void} [options.onClassifyNeeded]
 * @param {(args:object) => void} [options.onDecision]
 *        Called after every evaluate() with the raw policy decision.
 */
function createPauseDetector(options = {}) {
  const thresholds = options.thresholds || {};
  const onCommitReady = typeof options.onCommitReady === 'function'
    ? options.onCommitReady
    : () => {};
  const onClassifyNeeded = typeof options.onClassifyNeeded === 'function'
    ? options.onClassifyNeeded
    : () => {};
  const onDecision = typeof options.onDecision === 'function'
    ? options.onDecision
    : () => {};

  // Use injected classifier or spin up our own with injected ai.
  const classifier = options.classifier || createUtteranceClassifier({
    ai: options.ai,
    log: options.log,
    now: options.now,
  });

  // ---- state ----
  const state = {
    partial: '',
    silenceMs: 0,
    committed: false,
    commitCount: 0,
    lastDecision: null,
  };

  function onPartial(text) {
    if (typeof text !== 'string') return;
    state.partial = text;
    // A fresh partial means the user is still speaking -- reset any
    // accumulated silence.
    state.silenceMs = 0;
  }

  function setSilence(ms) {
    if (!Number.isFinite(ms) || ms < 0) return;
    state.silenceMs = ms;
  }

  function resetOnSpeech() {
    state.silenceMs = 0;
    state.committed = false;
  }

  async function evaluate() {
    if (state.committed) {
      return {
        action: 'already-committed',
        reason: 'turn already committed; waiting for next speech burst',
        classification: state.lastDecision?.classification || 'n/a',
        hitMaxWait: false,
      };
    }

    // Primary heuristic-only decision.
    const initial = turnTaking.decide({
      partial: state.partial,
      silenceMs: state.silenceMs,
      thresholds,
    });
    state.lastDecision = initial;
    onDecision(initial);

    if (initial.action === 'commit-now') {
      return _doCommit(initial);
    }

    if (initial.action === 'keep-waiting') {
      return initial;
    }

    // check-llm -- ask the classifier.
    onClassifyNeeded(state.partial);
    const verdict = await classifier.classify(state.partial);

    // If LLM thinks we're complete with confidence -- commit.
    if (verdict.complete === true && verdict.confidence >= 0.6) {
      const resolved = {
        action: 'commit-now',
        reason: `llm classifier: complete (${verdict.source}, confidence ${verdict.confidence.toFixed(2)})`,
        classification: 'complete',
        hitMaxWait: false,
        llm: verdict,
      };
      state.lastDecision = resolved;
      onDecision(resolved);
      return _doCommit(resolved);
    }

    // If LLM thinks we're NOT complete, treat as keep-waiting until
    // maxWait. The turn-taking policy already enforces maxWait when
    // called again, so we just hand back 'keep-waiting' here.
    const resolved = {
      action: 'keep-waiting',
      reason: `llm classifier: not complete (${verdict.source})`,
      classification: verdict.complete === false ? 'incomplete' : 'ambiguous',
      hitMaxWait: false,
      llm: verdict,
    };
    state.lastDecision = resolved;
    onDecision(resolved);
    return resolved;
  }

  function _doCommit(decision) {
    state.committed = true;
    state.commitCount++;
    const meta = {
      reason: decision.reason,
      classification: decision.classification,
      hitMaxWait: decision.hitMaxWait,
      silenceMs: state.silenceMs,
      llm: decision.llm || null,
    };
    try {
      onCommitReady(state.partial, meta);
    } catch (_err) {
      // Callback errors must not corrupt detector state.
    }
    return decision;
  }

  function reset() {
    state.partial = '';
    state.silenceMs = 0;
    state.committed = false;
    state.commitCount = 0;
    state.lastDecision = null;
  }

  function getState() {
    return {
      partial: state.partial,
      silenceMs: state.silenceMs,
      committed: state.committed,
      commitCount: state.commitCount,
      lastDecision: state.lastDecision
        ? { ...state.lastDecision }
        : null,
    };
  }

  return {
    onPartial,
    setSilence,
    resetOnSpeech,
    evaluate,
    reset,
    getState,
    // Expose classifier for tests / diagnostics
    _classifier: classifier,
  };
}

module.exports = {
  createPauseDetector,
};
