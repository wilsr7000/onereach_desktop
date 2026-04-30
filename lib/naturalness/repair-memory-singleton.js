/**
 * Shared Repair Memory Singleton (Phase 5)
 *
 * One repair-memory instance per process, lazy-loaded from Spaces on
 * first use. Saves (write-through to Spaces) whenever the instance
 * learns a new fix so the map survives restarts without callers
 * needing to remember to call save().
 *
 * Flag: requires `repairMemory` to be enabled. When off, getters
 * return an inert instance that applies no fixes and learns nothing.
 *
 * Dependency-injectable for tests via `configureRepairMemory()`.
 */

'use strict';

const { createRepairMemory } = require('./repair-memory');
const { isFlagEnabled } = require('../naturalness-flags');

let _instance = null;
let _loaded = false;
let _loading = null;
let _overrides = {
  spaces: null,
  log: null,
  now: null,
};
let _inertInstance = null;

function configureRepairMemory(overrides = {}) {
  _overrides = { ..._overrides, ...overrides };
}

function resetSharedRepairMemory() {
  _instance = null;
  _loaded = false;
  _loading = null;
  _inertInstance = null;
  _overrides = { spaces: null, log: null, now: null };
}

/**
 * Get the shared repair memory. Returns an inert instance when the
 * repairMemory flag is off -- that way callers can invoke
 * .applyFixes / .learnFix unconditionally.
 * @returns {object}
 */
function getSharedRepairMemory() {
  if (!isFlagEnabled('repairMemory')) {
    return _ensureInert();
  }
  if (_instance) return _instance;

  _instance = createRepairMemory({
    spaces: _resolveSpaces(),
    log: _resolveLog(),
    now: _overrides.now || undefined,
  });
  // Kick off a background load; callers that need it synchronous can
  // await ensureLoaded().
  _startLoad();
  return _wrapWithAutoSave(_instance);
}

async function ensureLoaded() {
  getSharedRepairMemory();
  if (!isFlagEnabled('repairMemory')) return false;
  if (_loaded) return true;
  if (!_loading) _startLoad();
  try {
    return await _loading;
  } catch (_e) {
    return false;
  }
}

function _startLoad() {
  if (!_instance) return;
  _loading = _instance
    .load()
    .then((ok) => {
      _loaded = true;
      return ok;
    })
    .catch(() => {
      _loaded = true;
      return false;
    });
}

/**
 * Wrap learn / unlearn so every mutation auto-saves to Spaces.
 * Saves are fire-and-forget (don't block callers).
 */
function _wrapWithAutoSave(instance) {
  const fireSave = () => {
    Promise.resolve().then(() => instance.save()).catch(() => {});
  };

  const originalLearn = instance.learnFix.bind(instance);
  instance.learnFix = function learnFixWithSave(heard, meant) {
    const result = originalLearn(heard, meant);
    if (result.added || result.updated || result.unlearned) fireSave();
    return result;
  };

  const originalUnlearn = instance.unlearnFix.bind(instance);
  instance.unlearnFix = function unlearnFixWithSave(heard) {
    const result = originalUnlearn(heard);
    if (result.removed) fireSave();
    return result;
  };

  const originalUnlearnLast = instance.unlearnLast.bind(instance);
  instance.unlearnLast = function unlearnLastWithSave() {
    const result = originalUnlearnLast();
    if (result.removed) fireSave();
    return result;
  };

  const originalClear = instance.clear.bind(instance);
  instance.clear = function clearWithSave() {
    originalClear();
    fireSave();
  };

  return instance;
}

function _resolveSpaces() {
  if (_overrides.spaces) return _overrides.spaces;
  try {
    const { getSpacesAPI } = require('../../spaces-api');
    return getSpacesAPI();
  } catch (_err) {
    return null;
  }
}

function _resolveLog() {
  if (_overrides.log) return _overrides.log;
  try {
    const { getLogQueue } = require('../log-event-queue');
    return getLogQueue();
  } catch (_err) {
    return { info: () => {}, warn: () => {}, error: () => {} };
  }
}

function _ensureInert() {
  if (_inertInstance) return _inertInstance;
  _inertInstance = {
    applyFixes: (text) => ({ text: text || '', appliedCount: 0, applied: [] }),
    learnFix: () => ({ added: false, updated: false, reason: 'flag-off' }),
    unlearnFix: () => ({ removed: false, reason: 'flag-off' }),
    unlearnLast: () => ({ removed: false, reason: 'flag-off' }),
    getLastLearned: () => null,
    getFixes: () => [],
    size: () => 0,
    clear: () => {},
    load: async () => false,
    save: async () => false,
  };
  return _inertInstance;
}

module.exports = {
  getSharedRepairMemory,
  configureRepairMemory,
  resetSharedRepairMemory,
  ensureLoaded,
};
