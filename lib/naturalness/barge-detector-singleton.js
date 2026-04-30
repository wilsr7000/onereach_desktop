/**
 * Shared Barge Detector Singleton (Phase 4.5)
 *
 * Holds a single BargeDetector instance for the running process so
 * voice-speaker (TTS events) and voice-listener (user partials) can
 * feed the same detector.
 *
 * When the detector fires `onBargeIn`, the preset callback:
 *   1. Cancels TTS via voice-speaker (loaded at call time to avoid
 *      import-order coupling).
 *   2. For `kind === 'command'` barges, submits the user text as a
 *      new task via hud-api.submitTask. `kind: 'stop'` and
 *      `kind: 'unclear'` just cancel the current TTS.
 *   3. Logs via the shared log queue.
 *
 * Dependency-injection is supported via `configureBargeDetector()` so
 * tests can swap out the speaker + submitter without monkey-patching.
 * In production no configuration is needed -- the singleton wires
 * itself to the real modules on first use.
 */

'use strict';

const { createBargeDetector } = require('./barge-detector');

let _instance = null;
let _overrides = {
  // If set, used instead of the real voice-speaker.
  speaker: null,
  // If set, used instead of hudApi.submitTask.
  submitTask: null,
  // If set, used instead of the shared log queue.
  log: null,
};

/**
 * Override detector dependencies for tests. Call before the first
 * getSharedBargeDetector() OR after resetSharedBargeDetector().
 *
 * @param {{ speaker?: object, submitTask?: Function, log?: object }} overrides
 */
function configureBargeDetector(overrides = {}) {
  _overrides = { ..._overrides, ...overrides };
}

/**
 * Drop the singleton + any overrides. Use in tests to start fresh.
 */
function resetSharedBargeDetector() {
  _instance = null;
  _overrides = { speaker: null, submitTask: null, log: null };
}

/**
 * Returns the shared BargeDetector. Creates + wires callbacks on first
 * call. Subsequent calls return the same instance.
 */
function getSharedBargeDetector() {
  if (_instance) return _instance;

  const logger = _overrides.log || _defaultLog();

  _instance = createBargeDetector({
    onBargeIn: async (event) => {
      logger.info('voice', '[BargeDetector] barge fired', {
        kind: event.kind,
        text: (event.text || '').slice(0, 60),
        reason: event.reason,
      });

      // 1. Cancel TTS immediately so the user hears silence.
      try {
        const speaker = _resolveSpeaker();
        if (speaker && typeof speaker.cancel === 'function') {
          await speaker.cancel();
        }
      } catch (err) {
        logger.warn('voice', '[BargeDetector] speaker cancel failed', {
          error: err.message,
        });
      }

      // 2. For commands, resubmit the user text as a fresh task.
      if (event.kind === 'command' && event.text && event.text.trim()) {
        try {
          const submit = _resolveSubmitTask();
          if (submit) {
            await submit(event.text, {
              toolId: 'voice',
              metadata: {
                barged: true,
                bargeReason: event.reason,
                bargeAt: event.at,
              },
            });
          }
        } catch (err) {
          logger.warn('voice', '[BargeDetector] submitTask failed', {
            error: err.message,
          });
        }
      }
    },
    onEchoSuppressed: (text, reason) => {
      logger.info('voice', '[BargeDetector] echo suppressed', {
        text: (text || '').slice(0, 30),
        reason,
      });
    },
    onIgnored: (info) => {
      logger.info('voice', '[BargeDetector] ignored', {
        kind: info.kind,
        text: (info.text || '').slice(0, 30),
      });
    },
  });

  return _instance;
}

// ==================== HELPERS ====================

function _resolveSpeaker() {
  if (_overrides.speaker) return _overrides.speaker;
  try {
    const { getVoiceSpeaker } = require('../../voice-speaker');
    return getVoiceSpeaker();
  } catch (_err) {
    return null;
  }
}

function _resolveSubmitTask() {
  if (_overrides.submitTask) return _overrides.submitTask;
  try {
    const hudApi = require('../hud-api');
    if (typeof hudApi.submitTask === 'function') {
      return (text, options) => hudApi.submitTask(text, options);
    }
  } catch (_err) {
    /* hud-api not loaded in this context */
  }
  return null;
}

function _defaultLog() {
  try {
    const { getLogQueue } = require('../log-event-queue');
    return getLogQueue();
  } catch (_err) {
    return { info: () => {}, warn: () => {}, error: () => {} };
  }
}

module.exports = {
  getSharedBargeDetector,
  configureBargeDetector,
  resetSharedBargeDetector,
};
