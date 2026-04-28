/**
 * Pull-engine adapter: localLookupFn + localApplyFn backed by the
 * materialised SQLite replica.
 *
 * Per docs/sync-v5/replica-shape.md commit F (final commit in the
 * A->F cutover ladder). The pull engine (lib/sync-v5/pull-engine.js)
 * polls the graph for remote ops and, for each APPLY verdict, calls
 * `localApplyFn(args)` to write the op to the local replica. Until
 * commit F, that callback was a no-op stub and applyMode was 'noop'.
 *
 * After commit F: when the replica is wired AND
 * syncV5.replica.cutoverEnabled is true (so the read path is also
 * coming from the replica), the pull engine flips to applyMode
 * 'sqlite' and remote ops produce visible changes in the local
 * replica.
 *
 * Design notes:
 *   - localLookupFn is read-only. The pull engine calls it to
 *     reconstruct the local "current version" of an entity for
 *     conflict detection. We map the replica row to the
 *     {vc, payload, authorDeviceId, authoredAt} shape the engine
 *     expects.
 *   - localApplyFn is write. It handles three op types today:
 *     asset.upsert / asset.update / asset.merge -> replica.upsertItem
 *     asset.delete -> replica.softDeleteItem
 *     Other op types are no-ops with a warn log -- the v5 op-type
 *     enum in sync-engine.js is the source of truth.
 *   - The adapter is intentionally idempotent: pull engine may
 *     re-deliver the same op (network retries, cursor replays);
 *     upsertItem + softDeleteItem are both idempotent.
 *   - VC conflicts: the pull engine has already decided APPLY
 *     before calling us. The remote op's vc is authoritative; we
 *     write it as-is. No vc bump (this device didn't author the
 *     write).
 *   - Tenant scoping: the replica passed in already has its
 *     tenantId locked. The remote op's tenantId is implicit (the
 *     graph-side query filters by tenant before reaching us).
 *
 * Counters (per inspect()):
 *   - applied: ops that wrote successfully via upsertItem
 *   - tombstoned: ops that wrote a soft-delete
 *   - skipped: unknown opTypes
 *   - errors: per-op write failures
 */

'use strict';

const { getLogQueue } = require('../../log-event-queue');
const _logQueueDefault = (() => {
  try { return getLogQueue(); } catch (_e) { return null; }
})();

// ---------------------------------------------------------------------------
// Op types this adapter recognises (mirrors lib/sync-v5/sync-engine.js
// OP_TYPE for asset writes; the pull engine only ever delivers ops that
// were originally enqueued via that same enum).
// ---------------------------------------------------------------------------

const ASSET_UPSERT_OPS = Object.freeze(['asset.upsert', 'asset.update', 'asset.merge']);
const ASSET_DELETE_OPS = Object.freeze(['asset.delete']);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build the pull-engine adapter for the given Replica.
 *
 * @param {object} args
 * @param {object} args.replica -- initialised Replica instance.
 * @param {object} [args.logger]
 * @returns {PullEngineAdapter}
 *
 * @typedef {object} PullEngineAdapter
 * @property {(entityId:string) => Promise<object|null>} localLookupFn
 *   -- the function to pass to PullEngine constructor's localLookupFn.
 * @property {(args:object) => Promise<void>} localApplyFn
 *   -- the function to pass to PullEngine constructor's localApplyFn.
 * @property {() => object} inspect
 *   -- diagnostics surface (per-opType counters, lastApplyAt, etc.)
 */
function buildPullEngineAdapter({ replica, logger } = {}) {
  if (!replica) throw new Error('buildPullEngineAdapter: replica is required');
  const log = logger || _logQueueDefault || _silentLogger();

  const counters = {
    builtAt: new Date().toISOString(),
    applied: 0,
    tombstoned: 0,
    skipped: 0,
    errors: 0,
    lastApplyAt: null,
    lastOpType: null,
    perOpType: Object.create(null),
  };

  function bump(opType, field) {
    if (!counters.perOpType[opType]) {
      counters.perOpType[opType] = { applied: 0, tombstoned: 0, skipped: 0, errors: 0 };
    }
    counters.perOpType[opType][field]++;
  }

  // ---------------------------------------------------------------------------
  // localLookupFn -- read the replica's current view of an entity in the
  // shape the pull engine's conflict detector expects.
  // ---------------------------------------------------------------------------

  async function localLookupFn(entityId) {
    if (!entityId) return null;
    try {
      const item = replica.getItem(entityId);
      if (item) {
        return _replicaItemToPullVersion(item);
      }
      const space = replica.getSpace(entityId);
      if (space) {
        return _replicaSpaceToPullVersion(space);
      }
      return null;
    } catch (err) {
      log.warn('replica/pull-adapter', 'localLookupFn failed; treating as miss', {
        entityId, error: err.message,
      });
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // localApplyFn -- write an APPLY-verdict remote op to the replica.
  // ---------------------------------------------------------------------------

  async function localApplyFn(args) {
    const opType = args && args.opType;
    if (!opType) {
      bump('unknown', 'errors');
      counters.errors++;
      throw new Error('localApplyFn: opType is required');
    }

    counters.lastApplyAt = new Date().toISOString();
    counters.lastOpType = opType;

    try {
      if (ASSET_UPSERT_OPS.includes(opType)) {
        _applyAssetUpsert(replica, args);
        counters.applied++;
        bump(opType, 'applied');
        return;
      }
      if (ASSET_DELETE_OPS.includes(opType)) {
        _applyAssetDelete(replica, args);
        counters.tombstoned++;
        bump(opType, 'tombstoned');
        return;
      }
      // Unknown opType -- log + skip. The pull engine should not
      // deliver opTypes outside the enum, but defensive handling
      // keeps a forward-compat schema bump from crashing the
      // adapter on day 1 of a future-version graph.
      log.warn('replica/pull-adapter', 'Unknown opType; skipping', { opType, entityId: args && args.entityId });
      counters.skipped++;
      bump(opType, 'skipped');
    } catch (err) {
      counters.errors++;
      bump(opType, 'errors');
      // Re-throw so the pull engine logs + counts the failure (its
      // own warn path runs).
      throw err;
    }
  }

  function inspect() {
    return {
      builtAt: counters.builtAt,
      applied: counters.applied,
      tombstoned: counters.tombstoned,
      skipped: counters.skipped,
      errors: counters.errors,
      lastApplyAt: counters.lastApplyAt,
      lastOpType: counters.lastOpType,
      perOpType: _shallowCloneMap(counters.perOpType),
      replica: {
        dbPath: replica.dbPath,
        tenantId: replica.tenantId,
        deviceId: replica.deviceId,
      },
    };
  }

  return { localLookupFn, localApplyFn, inspect };
}

// ---------------------------------------------------------------------------
// Apply implementations (pure-ish; rely on Replica's already-tested
// upsertItem / softDeleteItem methods)
// ---------------------------------------------------------------------------

function _applyAssetUpsert(replica, args) {
  const { entityId, version, contentHash } = args;
  if (!entityId) throw new Error('_applyAssetUpsert: entityId required');
  const v = version || {};
  const payload = v.payload || {};

  // The pull engine has already decided APPLY -- write the remote
  // version's vc as-is (no local bump; this device didn't author).
  const vcJson = v.vc ? (typeof v.vc === 'string' ? v.vc : JSON.stringify(v.vc)) : '{}';

  replica.upsertItem({
    id: entityId,
    type: payload.type || 'unknown',
    space_id: payload.space_id || payload.spaceId || 'unclassified',
    timestamp: typeof payload.timestamp === 'number' ? payload.timestamp : Date.now(),
    preview: payload.preview || null,
    content_path: payload.content_path || payload.contentPath || null,
    thumbnail_path: payload.thumbnail_path || payload.thumbnailPath || null,
    metadata_path: payload.metadata_path || payload.metadataPath || null,
    tags: Array.isArray(payload.tags) ? payload.tags : [],
    pinned: !!payload.pinned,
    file_name: payload.file_name || payload.fileName || null,
    file_size: typeof payload.file_size === 'number' ? payload.file_size
              : typeof payload.fileSize === 'number' ? payload.fileSize : null,
    file_type: payload.file_type || payload.fileType || null,
    file_category: payload.file_category || payload.fileCategory || null,
    file_ext: payload.file_ext || payload.fileExt || null,
    is_screenshot: !!payload.is_screenshot,
    json_subtype: payload.json_subtype || payload.jsonSubtype || null,
    source: payload.source || null,
    metadata_source: payload.metadata_source || payload.metadataSource || null,
    content_hash: contentHash || payload.content_hash || payload.contentHash || null,
    vc: vcJson,
    active: payload.active === undefined ? true : !!payload.active,
    created_at: payload.created_at || payload.createdAt
                || (v.authoredAt) || new Date().toISOString(),
    modified_at: payload.modified_at || payload.modifiedAt
                || (v.authoredAt) || new Date().toISOString(),
  });
}

function _applyAssetDelete(replica, args) {
  const { entityId, version } = args;
  if (!entityId) throw new Error('_applyAssetDelete: entityId required');
  const v = version || {};
  const vcJson = v.vc ? (typeof v.vc === 'string' ? v.vc : JSON.stringify(v.vc)) : '{}';
  const deletedBy = v.authorDeviceId || (v.payload && v.payload.deletedBy) || 'unknown';
  const deletedAt = v.authoredAt || (v.payload && v.payload.deletedAt) || new Date().toISOString();
  replica.softDeleteItem({
    itemId: entityId,
    deletedBy,
    deletedAt,
    vc: vcJson,
  });
}

// ---------------------------------------------------------------------------
// Shape helpers: replica row -> pull-engine version shape
// ---------------------------------------------------------------------------

/**
 * Convert a replica items row to the {vc, payload, authorDeviceId,
 * authoredAt} shape the pull engine's conflict detector expects.
 *
 * vc parses the JSON-encoded column into an object.
 * authorDeviceId / authoredAt: best-effort -- the replica doesn't
 * track per-write authorship at this granularity, so we surface
 * the deviceId of the row's most recent slot bump (highest counter)
 * as authorDeviceId. Conflict detection only uses these for
 * heuristic tiebreak; it relies primarily on vc.
 */
function _replicaItemToPullVersion(item) {
  const vcObj = _parseVc(item.vc);
  const payload = {
    type: item.type,
    space_id: item.space_id,
    timestamp: item.timestamp,
    preview: item.preview,
    content_path: item.content_path,
    thumbnail_path: item.thumbnail_path,
    metadata_path: item.metadata_path,
    tags: Array.isArray(item.tags) ? item.tags : [],
    pinned: !!item.pinned,
    file_name: item.file_name,
    file_size: item.file_size,
    file_type: item.file_type,
    file_category: item.file_category,
    file_ext: item.file_ext,
    is_screenshot: !!item.is_screenshot,
    json_subtype: item.json_subtype,
    source: item.source,
    metadata_source: item.metadata_source,
    content_hash: item.content_hash,
    active: !!item.active,
    created_at: item.created_at,
    modified_at: item.modified_at,
  };
  return {
    vc: vcObj,
    payload,
    authorDeviceId: _highestVcDevice(vcObj),
    authoredAt: item.modified_at,
  };
}

function _replicaSpaceToPullVersion(space) {
  const vcObj = _parseVc(space.vc);
  const payload = {
    name: space.name,
    icon: space.icon,
    color: space.color,
    is_system: !!space.is_system,
    active: !!space.active,
    created_at: space.created_at,
    updated_at: space.updated_at,
  };
  return {
    vc: vcObj,
    payload,
    authorDeviceId: _highestVcDevice(vcObj),
    authoredAt: space.updated_at,
  };
}

function _parseVc(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string' || value.length === 0) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_err) {
    return {};
  }
}

function _highestVcDevice(vcObj) {
  let bestDevice = null;
  let bestCounter = -1;
  for (const [device, counter] of Object.entries(vcObj || {})) {
    if (typeof counter === 'number' && counter > bestCounter) {
      bestCounter = counter;
      bestDevice = device;
    }
  }
  return bestDevice;
}

function _shallowCloneMap(obj) {
  const out = Object.create(null);
  for (const k of Object.keys(obj)) out[k] = { ...obj[k] };
  return out;
}

function _silentLogger() {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  buildPullEngineAdapter,
  ASSET_UPSERT_OPS,
  ASSET_DELETE_OPS,
  // Pure helpers exported for testing
  _replicaItemToPullVersion,
  _replicaSpaceToPullVersion,
  _parseVc,
  _highestVcDevice,
  _applyAssetUpsert,
  _applyAssetDelete,
};
