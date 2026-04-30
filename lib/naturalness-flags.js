/**
 * Naturalness Feature Flags
 *
 * As of the always-on cutover, Phase 1-4 naturalness features run by
 * default with no flag gate. This module exists for phases that may
 * ship behind a flag in the future (experimental behaviors, A/B
 * toggles, etc.) and as a test-time override mechanism.
 *
 * Resolution order, first match wins:
 *   1. Environment variable  NATURAL_<UPPER_SNAKE>
 *      Used by tests and developer one-off overrides.
 *   2. global.settingsManager.get('naturalnessFlags')[name]
 *      Used by the running Electron app.
 *   3. DEFAULT_FLAGS[name]
 *      Hard-coded default (see below).
 *
 * USAGE:
 *   const { isFlagEnabled } = require('./naturalness-flags');
 *   if (isFlagEnabled('someFutureFlag')) { ... }
 */

'use strict';

/**
 * All known naturalness flags. Features are added here only when they
 * genuinely need a runtime toggle; mature features go flag-less.
 */
const DEFAULT_FLAGS = Object.freeze({
  // Phase 5 - Repair memory (phonetic fix learning). Always on as of
  // the safety cutover: cycle detection in learnFix plus a voice-
  // triggered undo ("forget that fix" / "never mind that correction")
  // make bad auto-learns recoverable.
  repairMemory: true,

  // Phase 6 - Affect matching. Conservative classifier (neutral by
  // default unless strong signals) + `skipAffectMatching` opt-out for
  // fixed system prompts makes this safe to ship on by default.
  affectMatching: true,

  // Phase 7 (likely skipped) - Backchanneling.
  backchanneling: false,
});

/**
 * camelCase -> UPPER_SNAKE.
 * @param {string} name
 * @returns {string}
 */
function _toEnvSuffix(name) {
  return name.replace(/([A-Z])/g, '_$1').toUpperCase();
}

/**
 * @param {string} name - A flag name from DEFAULT_FLAGS
 * @returns {boolean}
 */
function isFlagEnabled(name) {
  if (!(name in DEFAULT_FLAGS)) {
    return false;
  }

  const envValue = process.env[`NATURAL_${_toEnvSuffix(name)}`];
  if (envValue === '1' || envValue === 'true') return true;
  if (envValue === '0' || envValue === 'false') return false;

  try {
    if (global.settingsManager && typeof global.settingsManager.get === 'function') {
      const flags = global.settingsManager.get('naturalnessFlags') || {};
      if (Object.prototype.hasOwnProperty.call(flags, name)) {
        return Boolean(flags[name]);
      }
    }
  } catch (_err) { /* settings optional during boot */ }

  return DEFAULT_FLAGS[name];
}

/**
 * Persist a flag value via settingsManager.
 * @param {string} name
 * @param {boolean} value
 * @returns {boolean} true if persisted, false if no settingsManager
 */
function setFlag(name, value) {
  if (!(name in DEFAULT_FLAGS)) {
    throw new Error(`Unknown naturalness flag: ${name}`);
  }
  if (!global.settingsManager || typeof global.settingsManager.set !== 'function') {
    return false;
  }
  try {
    const flags = global.settingsManager.get('naturalnessFlags') || {};
    flags[name] = Boolean(value);
    global.settingsManager.set('naturalnessFlags', flags);
    return true;
  } catch (_err) {
    return false;
  }
}

/**
 * @returns {Record<string, boolean>}
 */
function getAllFlags() {
  const out = {};
  for (const name of Object.keys(DEFAULT_FLAGS)) {
    out[name] = isFlagEnabled(name);
  }
  return out;
}

/**
 * @returns {string[]}
 */
function getFlagNames() {
  return Object.keys(DEFAULT_FLAGS);
}

module.exports = {
  DEFAULT_FLAGS,
  isFlagEnabled,
  setFlag,
  getAllFlags,
  getFlagNames,
};
