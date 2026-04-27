/**
 * Permanent tombstones (v5 Section 4.3)
 *
 * Deletion writes a `:Tombstone { entityId, deletedAt, deletedBy, finalVc }`
 * node. The tombstone vc dominates any pre-delete write, so a long-offline
 * device's queued pre-delete write loses to the delete on reconnect (the
 * "no-resurrection invariant", v5 invariant 4).
 *
 * Tombstones are PERMANENT. Cost: ~120 bytes per deletion. At 1M deletions,
 * 120 MB in the graph -- Aura handles this trivially. Compliance regulators
 * also want "this was deleted on date X by user Y" to survive forever, so
 * permanent retention is the cheapest path to both correctness and audit.
 *
 * Phase 3 ships:
 *   - the canonical Cypher constants for write + lookup + revival-check
 *   - helper functions to write a tombstone in the same tx as the entity
 *     soft-delete (so the no-resurrection invariant holds atomically)
 *   - a `isTombstoned()` check the engine calls before applying remote writes
 *
 * Phase 3 does NOT ship:
 *   - tombstone GC (there is none -- they're permanent)
 *   - tombstone-aware pull engine (Phase 4 with snapshots)
 */

'use strict';

const vc = require('./vector-clock');
const { getLogQueue } = require('../log-event-queue');
const log = getLogQueue();

// ────────────────────────────────────────────────────────────────────────────
// Cypher constants
// ────────────────────────────────────────────────────────────────────────────

/**
 * Atomically write a tombstone AND mark the :Asset as inactive. The
 * tombstone holds the finalVc -- the vc the entity had at the moment of
 * delete -- which is what dominates any pre-delete write that arrives
 * later. The :Asset stays in the graph (we use soft delete) so existing
 * relationships don't break; queries filter by `active=false`.
 *
 * Param shape:
 *   $entityId, $deletedBy (deviceId), $finalVc (json string), $at (ISO)
 */
const CYPHER_WRITE_TOMBSTONE = `
  MATCH (a:Asset {id: $entityId})
  CREATE (t:Tombstone {
    entityId: $entityId,
    deletedAt: datetime($at),
    deletedBy: $deletedBy,
    finalVc: $finalVc
  })
  SET a.active = false,
      a.deletedAt = datetime($at),
      a.deletedBy = $deletedBy
  MERGE (t)-[:TOMBSTONES]->(a)
  RETURN t.entityId AS entityId
`;

/**
 * Look up whether an entity has been tombstoned. Returns null when no
 * tombstone exists.
 *
 * Param shape:
 *   $entityId
 */
const CYPHER_GET_TOMBSTONE = `
  MATCH (t:Tombstone {entityId: $entityId})
  RETURN t.entityId AS entityId,
         t.deletedAt AS deletedAt,
         t.deletedBy AS deletedBy,
         t.finalVc AS finalVc
  LIMIT 1
`;

// ────────────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────────────

/**
 * Write a tombstone for an entity. Atomic with the soft-delete of the
 * underlying :Asset.
 *
 * @param {object} args
 * @param {string} args.entityId
 * @param {string} args.deletedBy   -- deviceId
 * @param {object} args.finalVc     -- the vc the entity had at delete time
 * @param {string} [args.at]        -- ISO timestamp; defaults to now
 * @param {object} [opts]
 * @param {object} [opts.omniClient]
 * @returns {Promise<{entityId:string}>}
 */
async function writeTombstone({ entityId, deletedBy, finalVc, at }, opts = {}) {
  if (!entityId || typeof entityId !== 'string') {
    throw new Error('writeTombstone: entityId required');
  }
  if (!deletedBy || typeof deletedBy !== 'string') {
    throw new Error('writeTombstone: deletedBy required');
  }
  if (!vc.isValid(finalVc)) {
    throw new Error('writeTombstone: finalVc must be a valid VectorClock');
  }
  const omniClient = _resolveOmniClient(opts.omniClient);
  if (!omniClient) throw new Error('writeTombstone: OmniGraph client unavailable');
  if (typeof omniClient.isReady === 'function' && !omniClient.isReady()) {
    throw new Error('writeTombstone: graph not ready');
  }
  const result = await omniClient.executeQuery(CYPHER_WRITE_TOMBSTONE, {
    entityId,
    deletedBy,
    finalVc: vc.toJSON(finalVc),
    at: at || new Date().toISOString(),
  });
  log.info('sync-v5', 'Tombstone written', { entityId, deletedBy, finalVc: vc.format(finalVc) });
  return { entityId: result?.[0]?.entityId || entityId };
}

/**
 * Look up the tombstone for an entity, if any. Returns the parsed finalVc
 * as a VectorClock for direct comparison against an incoming write.
 *
 * @param {string} entityId
 * @param {object} [opts]
 * @returns {Promise<{entityId:string, deletedAt:string, deletedBy:string, finalVc:object}|null>}
 */
async function getTombstone(entityId, opts = {}) {
  if (!entityId) return null;
  const omniClient = _resolveOmniClient(opts.omniClient);
  if (!omniClient) return null;
  if (typeof omniClient.isReady === 'function' && !omniClient.isReady()) return null;
  try {
    const rows = await omniClient.executeQuery(CYPHER_GET_TOMBSTONE, { entityId });
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const row = rows[0];
    return {
      entityId: row.entityId,
      deletedAt: row.deletedAt,
      deletedBy: row.deletedBy,
      finalVc: vc.fromJSON(row.finalVc || '{}'),
    };
  } catch (err) {
    log.warn('sync-v5', 'getTombstone failed', { entityId, error: err.message });
    return null;
  }
}

/**
 * No-resurrection check: should an incoming write with vc `incomingVc` be
 * applied to entity `entityId`?
 *
 * Logic:
 *   - if no tombstone: yes, apply normally
 *   - if tombstone exists AND tombstone.finalVc dominates or equals incomingVc:
 *     refuse. The tombstone is causally newer; the incoming op is a stale
 *     pre-delete write from a long-offline device.
 *   - if tombstone exists BUT incomingVc dominates tombstone.finalVc:
 *     allow. The incoming op happened AFTER the delete on some device
 *     (e.g. a "resurrect" op). This is rare and the engine's higher-level
 *     conflict policy decides what to do; this function only enforces the
 *     no-resurrection invariant.
 *   - if both are concurrent: refuse. A delete vs a concurrent write is a
 *     conflict, and v5 deletes win (resurrection is much worse than losing
 *     a concurrent edit; user can always re-create).
 *
 * @param {string} entityId
 * @param {object} incomingVc
 * @param {object} [opts]
 * @returns {Promise<{ allowed:boolean, reason:string }>}
 */
async function shouldAllowWrite(entityId, incomingVc, opts = {}) {
  const t = await getTombstone(entityId, opts);
  if (!t) return { allowed: true, reason: 'no tombstone' };
  if (vc.dominates(t.finalVc, incomingVc) || vc.equals(t.finalVc, incomingVc)) {
    return { allowed: false, reason: 'pre-delete write meets tombstone (no-resurrection invariant)' };
  }
  if (vc.dominates(incomingVc, t.finalVc)) {
    return { allowed: true, reason: 'incoming write strictly newer than tombstone (resurrect)' };
  }
  // Concurrent: deletes win.
  return { allowed: false, reason: 'concurrent write vs delete; delete wins' };
}

// ────────────────────────────────────────────────────────────────────────────
// Internal
// ────────────────────────────────────────────────────────────────────────────

function _resolveOmniClient(injected) {
  if (injected) return injected;
  try {
    const { getOmniGraphClient } = require('../../omnigraph-client');
    return getOmniGraphClient();
  } catch (_) {
    return null;
  }
}

module.exports = {
  CYPHER_WRITE_TOMBSTONE,
  CYPHER_GET_TOMBSTONE,
  writeTombstone,
  getTombstone,
  shouldAllowWrite,
};
