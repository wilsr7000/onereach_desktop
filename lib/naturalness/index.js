/**
 * @onereach/naturalness -- Public API
 *
 * Stable surface for the Phase 1-6 naturalness layer. Consumers
 * outside this app (WISER Playbooks, a GSX flow, a CLI tool, etc.)
 * should import ONLY from this module, never from the per-phase
 * files directly. That way internal file moves / refactors don't
 * break downstream integrations.
 *
 * Three layers of usage are supported, in rising order of coupling:
 *
 * 1. **Pure primitives** - every classifier, detector, and phrase
 *    pool exported directly. Useful for analytics, A/B experiments,
 *    or custom pipelines.
 *
 * 2. **Factories + singletons** - `createX()` / `getSharedX()` for
 *    stateful modules (pause-detector, barge-detector, repair-memory,
 *    affect-tracker). Callers can inject their own ports (`now`,
 *    `spaces`, `log`, etc.) via the `configure*()` helpers exported
 *    from each module.
 *
 * 3. **Facade** - `createNaturalness({ ports })` bundles everything
 *    into an object with five hook methods matching the integration
 *    touchpoints in a typical voice loop:
 *
 *      const nat = createNaturalness({ ports });
 *      nat.onConnect();                       // kick off Spaces load
 *      nat.onTranscriptFinal(text);           // repair-memory apply
 *      nat.onUserTask(text, { history });     // undo / learn / affect
 *      nat.onBeforeSpeak(text);               // affect-match outgoing
 *      nat.onTtsLifecycle(phase, text?);      // barge state machine
 *      nat.onUserPartial(text);               // barge evaluation
 *
 * See docs/naturalness/integration-guide.md for a runnable example.
 */

'use strict';

// ============================================================
// Section 1: Re-exports (raw primitives + factories + singletons)
// ============================================================

// ---- Phase 1: Calibrated confirmation ----
const confirmationPolicy = require('./confirmation-policy');
const stakesClassifier = require('./stakes-classifier');
const confirmationPhrases = require('./confirmation-phrases');
const confirmationGate = require('./confirmation-gate');

// ---- Phase 2: Voice personality + handoffs ----
const voiceResolver = require('./voice-resolver');
const handoffPhrases = require('./handoff-phrases');
const agentTransitionTracker = require('./agent-transition-tracker');

// ---- Phase 3: Pause detection ----
const turnTaking = require('./turn-taking');
const utteranceClassifier = require('./utterance-classifier');
const pauseDetector = require('./pause-detector');

// ---- Phase 4: Barge-in ----
const echoFilter = require('./echo-filter');
const bargeClassifier = require('./barge-classifier');
const bargeDetector = require('./barge-detector');
const bargeDetectorSingleton = require('./barge-detector-singleton');

// ---- Phase 5: Repair memory ----
const repairMemory = require('./repair-memory');
const correctionDetector = require('./correction-detector');
const repairMemorySingleton = require('./repair-memory-singleton');

// ---- Phase 6: Affect matching ----
const affectClassifier = require('./affect-classifier');
const responseModifier = require('./response-modifier');
const affectTracker = require('./affect-tracker');

// ---- Flags ----
const flags = require('../naturalness-flags');

// ============================================================
// Section 2: Facade
// ============================================================

/**
 * @typedef {object} NaturalnessPorts
 * @property {{ speak: Function, cancel: Function }} [speaker]
 *   Required for the barge detector to cancel in-flight TTS.
 * @property {{ call: Function }} [ai]
 *   Required for the utterance classifier LLM fallback path.
 *   Shape: `ai.call(prompt, opts) -> Promise<{ content: string }>`.
 * @property {{ files: { read, write, delete } }} [spaces]
 *   Required for repair-memory persistence.
 * @property {{ info: Function, warn: Function, error: Function }} [log]
 *   Optional. Defaults to a silent logger.
 * @property {() => number} [now]
 *   Optional clock. Defaults to `Date.now`. Tests override for determinism.
 * @property {{ get: Function, set: Function }} [settingsManager]
 *   Optional. When present, flag resolution consults it for user overrides.
 * @property {() => Array<{role:string,content:string}>} [getHistory]
 *   Optional. Provides conversation history for affect + repair context.
 *   Defaults to returning `[]`.
 * @property {(text: string, options?: object) => Promise} [submitTask]
 *   Required for the barge detector to re-submit the user's interrupt
 *   as a new task after cancelling the in-flight TTS.
 */

/**
 * @typedef {object} NaturalnessFacade
 * @property {() => Promise<boolean>} onConnect
 * @property {(text: string) => {text:string, appliedCount:number, applied: Array}} onTranscriptFinal
 * @property {(text: string, ctx?: {history?: Array}) => Promise<UserTaskOutcome>} onUserTask
 * @property {(text: string, options?: {skipAffectMatching?: boolean}) => {text:string, modified:boolean, transforms:string[]}} onBeforeSpeak
 * @property {('start'|'end'|'update', text?: string) => void} onTtsLifecycle
 * @property {(partialText: string) => void} onUserPartial
 * @property {{ repair: object, affect: object, barge: object|null }} stores
 *   Direct access to the singletons for advanced consumers (introspection,
 *   clearing state, etc.)
 */

/**
 * @typedef {object} UserTaskOutcome
 * @property {boolean} handled       -- true if the facade short-circuited the task (e.g. undo ack)
 * @property {string}  [shortcut]    -- 'undo' when the task was a repair-memory undo
 * @property {string}  [ackText]     -- spoken ack text if a shortcut fired
 * @property {object}  [affect]      -- recorded affect (when non-neutral)
 * @property {object}  [correction]  -- recorded correction (when a learn pattern matched)
 */

/**
 * Build a naturalness facade wired to the given host ports.
 *
 * Ports are OPTIONAL. A port that isn't provided is substituted with
 * a no-op or a sensible default, so integrators can bring naturalness
 * online one capability at a time (e.g. add barge-in later by
 * providing `speaker` and `submitTask` in a second pass).
 *
 * The facade methods are all synchronous or fire-and-forget except
 * where noted. None throw on bad input -- they return no-op results
 * and log a warning via the provided `log` port.
 *
 * @param {{ ports?: NaturalnessPorts }} [options]
 * @returns {NaturalnessFacade}
 */
function createNaturalness(options = {}) {
  const ports = (options && options.ports) || {};
  const log = ports.log || _silentLog();
  const now = typeof ports.now === 'function' ? ports.now : () => Date.now();
  const getHistory =
    typeof ports.getHistory === 'function' ? ports.getHistory : () => [];

  // Wire each singleton with whatever ports we were given. Singletons
  // tolerate missing ports (they degrade to inert or best-effort).
  affectTracker.configureAffectTracker({ now });
  repairMemorySingleton.configureRepairMemory({
    spaces: ports.spaces || null,
    log,
    now,
  });
  if (ports.speaker || ports.submitTask) {
    bargeDetectorSingleton.configureBargeDetector({
      speaker: ports.speaker || null,
      submitTask: ports.submitTask || null,
      log,
    });
  }

  // Phase 3 pause detector needs an `ai` port. Created lazily on
  // first onUserPartial so integrators without voice STT don't pay
  // the cost.
  let _pauseInstance = null;
  function _ensurePauseDetector() {
    if (_pauseInstance) return _pauseInstance;
    if (!ports.ai) return null;
    _pauseInstance = pauseDetector.createPauseDetector({
      ai: ports.ai,
      now,
      onCommitReady: () => {
        // Intentionally left to the host. Consumers who want early
        // commit should instantiate createPauseDetector directly.
      },
    });
    return _pauseInstance;
  }

  // ------ Facade methods ------

  async function onConnect() {
    return repairMemorySingleton.ensureLoaded();
  }

  function onTranscriptFinal(text) {
    try {
      const rm = repairMemorySingleton.getSharedRepairMemory();
      const out = rm.applyFixes(text || '');
      if (out.appliedCount > 0) {
        log.info('naturalness', '[RepairMemory] applied', out.applied);
      }
      return out;
    } catch (err) {
      log.warn('naturalness', '[RepairMemory] apply error', {
        error: err.message,
      });
      return { text: text || '', appliedCount: 0, applied: [] };
    }
  }

  async function onUserTask(text, ctx = {}) {
    const input = (text || '').toString();
    const outcome = { handled: false };
    if (!input.trim()) return outcome;

    // -- Shortcut 1: repair-memory undo --
    try {
      const undo = correctionDetector.detectUndoCorrection(input);
      if (undo && flags.isFlagEnabled('repairMemory')) {
        const rm = repairMemorySingleton.getSharedRepairMemory();
        const result = rm.unlearnLast();
        const ackText = result.removed
          ? `OK, I'll forget that "${result.entry.heard}" meant "${result.entry.meant}".`
          : "I don't have a recent fix to forget.";
        if (ports.speaker && typeof ports.speaker.speak === 'function') {
          try {
            await ports.speaker.speak(ackText, { skipAffectMatching: true });
          } catch (_e) { /* speech optional */ }
        }
        log.info('naturalness', '[RepairMemory] undo', { pattern: undo.pattern, result });
        return { handled: true, shortcut: 'undo', ackText };
      }
    } catch (err) {
      log.warn('naturalness', '[RepairMemory] undo error', { error: err.message });
    }

    const history = (ctx && ctx.history) || getHistory() || [];

    // -- Shortcut 2: repair-memory learn (non-blocking) --
    try {
      if (flags.isFlagEnabled('repairMemory')) {
        const priorUserTurns = history.filter((t) => t && t.role === 'user');
        const priorUser = priorUserTurns.length
          ? priorUserTurns[priorUserTurns.length - 1].content || ''
          : '';
        const correction = correctionDetector.detectCorrection(input, priorUser);
        if (correction) {
          const rm = repairMemorySingleton.getSharedRepairMemory();
          const learn = rm.learnFix(correction.heard, correction.meant);
          log.info('naturalness', '[RepairMemory] learn', {
            pattern: correction.pattern,
            heard: correction.heard,
            meant: correction.meant,
            learn,
          });
          outcome.correction = { ...correction, learn };
        }
      }
    } catch (err) {
      log.warn('naturalness', '[RepairMemory] learn error', { error: err.message });
    }

    // -- Affect classification (non-blocking) --
    try {
      if (flags.isFlagEnabled('affectMatching')) {
        const priorUserTurns = history.filter((t) => t && t.role === 'user');
        const lastUser = priorUserTurns.length
          ? priorUserTurns[priorUserTurns.length - 1].content || ''
          : '';
        const recentRepeat =
          lastUser && _normalizeText(lastUser) === _normalizeText(input);
        const recentErrors = history.filter(
          (t) =>
            t &&
            t.role !== 'user' &&
            typeof t.content === 'string' &&
            /\b(error|failed|couldn't|can't complete|problem)\b/i.test(t.content)
        ).length;
        const affect = affectClassifier.classifyAffect({
          text: input,
          recentRepeat,
          recentErrors,
        });
        if (affect.label !== 'neutral') {
          affectTracker.getSharedAffectTracker().record(affect);
          outcome.affect = affect;
        }
      }
    } catch (err) {
      log.warn('naturalness', '[Affect] classify error', { error: err.message });
    }

    return outcome;
  }

  function onBeforeSpeak(text, opts = {}) {
    const input = (text || '').toString();
    if (!input || opts.skipAffectMatching) {
      return { text: input, modified: false, transforms: [] };
    }
    if (!flags.isFlagEnabled('affectMatching')) {
      return { text: input, modified: false, transforms: [] };
    }
    try {
      const affect = affectTracker.getSharedAffectTracker().get();
      if (!affect) return { text: input, modified: false, transforms: [] };
      const adjusted = responseModifier.adjustResponse({ text: input, affect });
      if (adjusted.modified) {
        log.info('naturalness', '[Affect] adjust', {
          label: affect.label,
          transforms: adjusted.transforms,
        });
      }
      return adjusted;
    } catch (err) {
      log.warn('naturalness', '[Affect] adjust error', { error: err.message });
      return { text: input, modified: false, transforms: [] };
    }
  }

  function onTtsLifecycle(phase, text) {
    try {
      const detector = bargeDetectorSingleton.getSharedBargeDetector();
      if (!detector) return;
      switch (phase) {
        case 'start':
          if (typeof detector.onTtsStart === 'function') detector.onTtsStart(text || '');
          break;
        case 'update':
          if (typeof detector.onTtsUpdate === 'function') detector.onTtsUpdate(text || '');
          break;
        case 'end':
          if (typeof detector.onTtsEnd === 'function') detector.onTtsEnd();
          break;
        default:
          log.warn('naturalness', '[Barge] unknown phase', { phase });
      }
    } catch (err) {
      log.warn('naturalness', '[Barge] lifecycle error', { error: err.message });
    }
  }

  function onUserPartial(partialText) {
    try {
      const detector = bargeDetectorSingleton.getSharedBargeDetector();
      if (detector && typeof detector.onUserPartial === 'function') {
        detector.onUserPartial(partialText || '');
      }
      const pause = _ensurePauseDetector();
      if (pause) pause.onPartial(partialText || '');
    } catch (err) {
      log.warn('naturalness', '[Barge] partial error', { error: err.message });
    }
  }

  return {
    onConnect,
    onTranscriptFinal,
    onUserTask,
    onBeforeSpeak,
    onTtsLifecycle,
    onUserPartial,
    stores: {
      repair: repairMemorySingleton,
      affect: affectTracker,
      barge: bargeDetectorSingleton,
    },
  };
}

// ============================================================
// Helpers
// ============================================================

function _silentLog() {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

function _normalizeText(s) {
  return (s || '')
    .toString()
    .toLowerCase()
    .replace(/[.,!?;:'"()\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ============================================================
// Exports
// ============================================================

module.exports = {
  // Facade (high-level integration)
  createNaturalness,

  // Flags
  flags,

  // Phase 1
  confirmationPolicy,
  stakesClassifier,
  confirmationPhrases,
  confirmationGate,

  // Phase 2
  voiceResolver,
  handoffPhrases,
  agentTransitionTracker,

  // Phase 3
  turnTaking,
  utteranceClassifier,
  pauseDetector,

  // Phase 4
  echoFilter,
  bargeClassifier,
  bargeDetector,
  bargeDetectorSingleton,

  // Phase 5
  repairMemory,
  correctionDetector,
  repairMemorySingleton,

  // Phase 6
  affectClassifier,
  responseModifier,
  affectTracker,
};
