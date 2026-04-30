/**
 * Affect Tracker (Phase 6)
 *
 * Lightweight in-memory store for the last detected non-neutral user
 * affect. Consumed by voice-speaker so outgoing TTS can match tone
 * without plumbing affect through every caller.
 *
 * API:
 *   const tracker = getSharedAffectTracker();
 *   tracker.record(affect);           // affect from classifyAffect()
 *   tracker.get();                    // current affect or null (TTL-filtered)
 *   tracker.clear();
 *
 * Storage rules:
 *   - Only non-neutral affects are recorded. Neutral classifications
 *     do not overwrite a recent stronger signal -- one calm follow-up
 *     turn shouldn't erase a detected frustration.
 *   - Recorded affects decay after TTL (default 60s). After decay,
 *     get() returns null.
 *   - Higher-priority affects replace lower-priority ones even if the
 *     lower-priority one is still within TTL (priority matches the
 *     classifier: frustrated > rushed > excited > hesitant > deliberate).
 *
 * Dependency-injectable for tests via `configureAffectTracker()`.
 */

'use strict';

const DEFAULT_TTL_MS = 60_000;

const PRIORITY = {
  frustrated: 10,
  rushed: 8,
  excited: 7,
  hesitant: 5,
  deliberate: 3,
  neutral: 0,
};

let _instance = null;
let _overrides = { now: null, ttlMs: null };

function configureAffectTracker(overrides = {}) {
  _overrides = { ..._overrides, ...overrides };
  _instance = null; // rebuild on next get with new overrides
}

function resetSharedAffectTracker() {
  _instance = null;
  _overrides = { now: null, ttlMs: null };
}

/**
 * @returns {{
 *   record: (affect: object) => void,
 *   get: () => object|null,
 *   clear: () => void,
 *   _peek: () => object|null,
 * }}
 */
function getSharedAffectTracker() {
  if (_instance) return _instance;

  const now = typeof _overrides.now === 'function' ? _overrides.now : () => Date.now();
  const ttlMs = Number.isFinite(_overrides.ttlMs) ? _overrides.ttlMs : DEFAULT_TTL_MS;

  let current = null; // { label, confidence, signals, recordedAt }

  function record(affect) {
    if (!affect || !affect.label) return;
    if (affect.label === 'neutral') return;
    if (!(affect.label in PRIORITY)) return;

    const recordedAt = now();
    const incoming = { ...affect, recordedAt };

    if (!current) {
      current = incoming;
      return;
    }
    // Decay check: if existing is past TTL, always replace.
    if (recordedAt - current.recordedAt > ttlMs) {
      current = incoming;
      return;
    }
    // In-TTL: replace only when incoming has >= priority.
    if (PRIORITY[incoming.label] >= PRIORITY[current.label]) {
      current = incoming;
    }
  }

  function get() {
    if (!current) return null;
    if (now() - current.recordedAt > ttlMs) {
      current = null;
      return null;
    }
    // Return a defensive copy minus internal recordedAt.
    const { recordedAt: _, ...out } = current;
    return out;
  }

  function clear() {
    current = null;
  }

  function _peek() {
    return current ? { ...current } : null;
  }

  _instance = { record, get, clear, _peek };
  return _instance;
}

module.exports = {
  getSharedAffectTracker,
  configureAffectTracker,
  resetSharedAffectTracker,
  DEFAULT_TTL_MS,
  PRIORITY,
};
