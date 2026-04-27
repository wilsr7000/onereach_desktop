/**
 * Vector clocks (v5 Section 4.3)
 *
 * A vector clock is a per-entity map { deviceId -> counter }. Every write
 * increments the writer's slot. Two operations are causally ordered if one's
 * vc strictly dominates the other; concurrent if neither dominates.
 *
 * This module is the algebra. Storage is per-entity in :Asset.vc, written
 * by sync-engine.js as part of the canonical CYPHER_OP_TX. Conflict
 * detection lives in conflict.js and uses dominates() / concurrent().
 *
 * No external dependencies; the data type is plain JavaScript objects so
 * the graph can store them as map properties without intermediate
 * serialisation.
 *
 * Phase 3 ships the algebra + serialization helpers + a guard against
 * malformed inputs. Phase 5 will add a "compact slot for retired devices"
 * helper as part of the device-rebind cleanup pass; the data type stays
 * the same.
 */

'use strict';

const EMPTY = Object.freeze({});

/**
 * @typedef {Object<string, number>} VectorClock
 *   Map of deviceId (ULID) to counter (non-negative integer). Missing slots
 *   are equivalent to 0. Always immutable from the caller's perspective --
 *   every operation returns a new VectorClock.
 */

/**
 * Return an empty vector clock. Use this for new entities.
 *
 * @returns {VectorClock}
 */
function empty() {
  return {};
}

/**
 * Bump a deviceId's slot in a vc. Returns a new vc.
 *
 * @param {VectorClock} vc
 * @param {string} deviceId
 * @returns {VectorClock}
 */
function bump(vc, deviceId) {
  if (!deviceId || typeof deviceId !== 'string') {
    throw new Error(`vc.bump: deviceId must be a non-empty string, got ${typeof deviceId}`);
  }
  const safe = isValid(vc) ? vc : EMPTY;
  return { ...safe, [deviceId]: (safe[deviceId] || 0) + 1 };
}

/**
 * Look up a single slot. Missing slots are 0.
 *
 * @param {VectorClock} vc
 * @param {string} deviceId
 * @returns {number}
 */
function get(vc, deviceId) {
  if (!isValid(vc)) return 0;
  return vc[deviceId] || 0;
}

/**
 * Strict dominance: a >= b on every slot, AND a > b on at least one slot.
 * "a happened after b causally."
 *
 * Note: this is the "happens-before" relation. If a == b on every slot,
 * dominates returns false (use equals() for that case).
 *
 * @param {VectorClock} a
 * @param {VectorClock} b
 * @returns {boolean}
 */
function dominates(a, b) {
  if (!isValid(a) || !isValid(b)) return false;
  let strictlyGreaterSomewhere = false;
  const slots = _allSlots(a, b);
  for (const k of slots) {
    const av = a[k] || 0;
    const bv = b[k] || 0;
    if (av < bv) return false;
    if (av > bv) strictlyGreaterSomewhere = true;
  }
  return strictlyGreaterSomewhere;
}

/**
 * a == b on every slot.
 *
 * @param {VectorClock} a
 * @param {VectorClock} b
 * @returns {boolean}
 */
function equals(a, b) {
  if (!isValid(a) || !isValid(b)) return false;
  const slots = _allSlots(a, b);
  for (const k of slots) {
    if ((a[k] || 0) !== (b[k] || 0)) return false;
  }
  return true;
}

/**
 * Concurrent: neither dominates. Equal vcs are NOT concurrent (they're
 * the same point in causal history).
 *
 * Fails closed on invalid input: undefined causal relation is not
 * "concurrent", it's "unknown". Caller decides what to do with unknown.
 *
 * @param {VectorClock} a
 * @param {VectorClock} b
 * @returns {boolean}
 */
function concurrent(a, b) {
  if (!isValid(a) || !isValid(b)) return false;
  return !dominates(a, b) && !dominates(b, a) && !equals(a, b);
}

/**
 * Element-wise max of N vcs. Used to compute the vc of a merge op that
 * resolves conflicts: the merged result must dominate all participants.
 * Caller typically bumps the merger's slot AFTER mergeMax to ensure
 * strict dominance.
 *
 * @param {VectorClock[]} vcs
 * @returns {VectorClock}
 */
function mergeMax(vcs) {
  if (!Array.isArray(vcs) || vcs.length === 0) return empty();
  const out = {};
  for (const vc of vcs) {
    if (!isValid(vc)) continue;
    for (const [k, v] of Object.entries(vc)) {
      if (typeof v === 'number' && v > (out[k] || 0)) out[k] = v;
    }
  }
  return out;
}

/**
 * After mergeMax, bump the merger's slot so the merge is strictly newer
 * than any participant. This is the canonical "post-merge vc" computation.
 *
 * @param {VectorClock[]} vcs
 * @param {string} mergerDeviceId
 * @returns {VectorClock}
 */
function mergeAndBump(vcs, mergerDeviceId) {
  return bump(mergeMax(vcs), mergerDeviceId);
}

/**
 * Validate that a value is a vector clock (object with numeric values).
 * Used at the trust boundary -- when reading a vc back from the graph
 * or from a remote device.
 *
 * @param {*} v
 * @returns {boolean}
 */
function isValid(v) {
  if (v === null || v === undefined) return false;
  if (typeof v !== 'object' || Array.isArray(v)) return false;
  for (const [k, val] of Object.entries(v)) {
    if (typeof k !== 'string' || k.length === 0) return false;
    if (typeof val !== 'number' || !Number.isInteger(val) || val < 0) return false;
  }
  return true;
}

/**
 * Serialise to JSON for transport. Identity in this implementation
 * (a vc is already plain JSON), but kept as a hook for future encoding
 * changes.
 *
 * @param {VectorClock} vc
 * @returns {string}
 */
function toJSON(vc) {
  if (!isValid(vc)) throw new Error('vc.toJSON: invalid vc');
  return JSON.stringify(vc);
}

/**
 * Deserialise from JSON. Returns empty vc on invalid input rather than
 * throwing -- "unknown vc" should fail closed (refuse to apply rather
 * than crash the device).
 *
 * @param {string} json
 * @returns {VectorClock}
 */
function fromJSON(json) {
  try {
    const parsed = JSON.parse(json);
    return isValid(parsed) ? parsed : empty();
  } catch (_) {
    return empty();
  }
}

/**
 * Format a vc for log lines. Compact, deterministic ordering.
 *
 * @param {VectorClock} vc
 * @returns {string}
 */
function format(vc) {
  if (!isValid(vc)) return 'vc(invalid)';
  const slots = Object.keys(vc).sort();
  if (slots.length === 0) return 'vc{}';
  return 'vc{' + slots.map((k) => `${k.slice(0, 8)}=${vc[k]}`).join(',') + '}';
}

// ────────────────────────────────────────────────────────────────────────────
// Internal
// ────────────────────────────────────────────────────────────────────────────

function _allSlots(a, b) {
  const out = new Set();
  for (const k of Object.keys(a)) out.add(k);
  for (const k of Object.keys(b)) out.add(k);
  return out;
}

module.exports = {
  empty,
  bump,
  get,
  dominates,
  equals,
  concurrent,
  mergeMax,
  mergeAndBump,
  isValid,
  toJSON,
  fromJSON,
  format,
};
