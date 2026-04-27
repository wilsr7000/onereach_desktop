/**
 * Conflict detection + N-way resolution (v5 Section 4.7)
 *
 * When applying a remote update to an entity that has a pending local op,
 * compare vector clocks. If neither dominates and they're not equal, the
 * entity has a conflict.
 *
 * The protocol does not prevent N>2 concurrent versions: three devices
 * each writing offline can produce three mutually-concurrent vcs. The UI
 * must handle this. Per v5 4.7:
 *
 *   - Banner "N versions exist" surfaces on the entity.
 *   - List view shows all N versions with author/device/timestamp.
 *   - User picks any two to compare side-by-side, OR picks one wholesale,
 *     OR merges manually.
 *   - Resolution emits a single `merge` op whose vc dominates all N
 *     (mergeMax + bump merger's slot).
 *   - Global menu-bar badge counts unresolved conflicts so they cannot hide.
 *
 * Phase 3 ships:
 *   - the `ConflictGroup` data model (N versions of an entity)
 *   - `detectConflict(localVc, incomingVc)` algorithm
 *   - `ConflictStore` -- in-memory store of unresolved conflicts, with a
 *     subscribe API that the renderer (eventually) listens to
 *   - the resolution API: `resolveByPick(traceId, versionId)`,
 *     `resolveByMerge(traceId, mergedPayload)`. Both produce a merge op
 *     that dominates all participants.
 *   - the canonical Cypher to detect cross-tenant active conflicts
 *     (called by the operator-side health query that's already in
 *     health-queries.js -- this module is the device-side counterpart).
 *
 * Phase 3 does NOT ship:
 *   - the actual conflict UI (renderer-side; downstream of this scaffold)
 *   - integration into sync-engine's pull path (the engine has no pull
 *     path yet; Phase 4 with snapshots will add it). Phase 3 exposes
 *     `applyRemoteOp()` for tests + future pull engine.
 */

'use strict';

const vc = require('./vector-clock');
const { newTraceId, isValidTraceId } = require('./trace-id');
const { getLogQueue } = require('../log-event-queue');
const log = getLogQueue();

const VERDICT = Object.freeze({
  APPLY: 'apply', // incoming vc strictly dominates local; replace local
  IGNORE: 'ignore', // local vc strictly dominates incoming; drop the incoming
  CONFLICT: 'conflict', // concurrent; surface for resolution
  EQUAL: 'equal', // same vc -- nothing to do
});

// ────────────────────────────────────────────────────────────────────────────
// Pure detection algebra
// ────────────────────────────────────────────────────────────────────────────

/**
 * Compare a local vc against an incoming vc and return what to do.
 *
 * @param {object} localVc
 * @param {object} incomingVc
 * @returns {string} VERDICT.APPLY | IGNORE | CONFLICT | EQUAL
 */
function detectConflict(localVc, incomingVc) {
  if (vc.equals(localVc, incomingVc)) return VERDICT.EQUAL;
  if (vc.dominates(incomingVc, localVc)) return VERDICT.APPLY;
  if (vc.dominates(localVc, incomingVc)) return VERDICT.IGNORE;
  return VERDICT.CONFLICT;
}

// ────────────────────────────────────────────────────────────────────────────
// ConflictVersion / ConflictGroup data shapes
// ────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} ConflictVersion
 * @property {string} versionId  -- ULID, unique within a group
 * @property {object} vc         -- the version's vector clock
 * @property {string} authorDeviceId
 * @property {string} authoredAt -- ISO timestamp
 * @property {object} payload    -- the entity's properties at this version
 */

/**
 * @typedef {Object} ConflictGroup
 * @property {string} entityId
 * @property {string} entityType
 * @property {string} createdAt    -- ISO timestamp the group was first detected
 * @property {ConflictVersion[]} versions
 */

function makeVersion({ vc: vcArg, authorDeviceId, authoredAt, payload }) {
  if (!vc.isValid(vcArg)) throw new Error('makeVersion: invalid vc');
  if (!authorDeviceId) throw new Error('makeVersion: authorDeviceId required');
  return {
    versionId: newTraceId(),
    vc: { ...vcArg },
    authorDeviceId,
    authoredAt: authoredAt || new Date().toISOString(),
    payload: payload || {},
  };
}

function makeGroup({ entityId, entityType, versions }) {
  if (!entityId) throw new Error('makeGroup: entityId required');
  if (!Array.isArray(versions) || versions.length < 2) {
    throw new Error('makeGroup: at least 2 versions required for a conflict');
  }
  return {
    entityId,
    entityType: entityType || 'asset',
    createdAt: new Date().toISOString(),
    versions: versions.map((v) => ({ ...v })),
  };
}

// ────────────────────────────────────────────────────────────────────────────
// ConflictStore -- in-memory device-side conflict registry
// ────────────────────────────────────────────────────────────────────────────

class ConflictStore {
  constructor() {
    /** @type {Map<string, ConflictGroup>} entityId -> group */
    this._groups = new Map();
    /** @type {Set<(snapshot:object) => void>} subscribers */
    this._subs = new Set();
  }

  /**
   * Register a new conflict (or merge a new version into an existing group).
   * Returns the resulting group.
   */
  register(group) {
    if (!group || !group.entityId) throw new Error('ConflictStore.register: group with entityId required');
    const existing = this._groups.get(group.entityId);
    if (existing) {
      // Merge: append any versions whose vc isn't already represented.
      const present = new Set(existing.versions.map((v) => vc.toJSON(v.vc)));
      for (const v of group.versions) {
        const key = vc.toJSON(v.vc);
        if (!present.has(key)) {
          existing.versions.push({ ...v });
          present.add(key);
        }
      }
      this._groups.set(group.entityId, existing);
      this._notify();
      return existing;
    }
    this._groups.set(group.entityId, { ...group });
    this._notify();
    return group;
  }

  /**
   * Add a single new version to an existing entity's conflict (or create a
   * new group if none exists yet but two concurrent versions are present).
   *
   * @param {string} entityId
   * @param {ConflictVersion} version
   * @param {string} [entityType]
   */
  addVersion(entityId, version, entityType = 'asset') {
    const existing = this._groups.get(entityId);
    if (existing) {
      existing.versions.push({ ...version });
      this._notify();
      return existing;
    }
    // Single-version "groups" aren't stored -- a conflict requires >=2.
    // The caller decides when to materialise. This convenience just throws
    // to make the API obvious.
    throw new Error('ConflictStore.addVersion: no existing group; use register() for first conflict');
  }

  get(entityId) {
    return this._groups.get(entityId) || null;
  }

  list() {
    return Array.from(this._groups.values());
  }

  count() {
    return this._groups.size;
  }

  /**
   * Resolve by picking one version. Returns the chosen version + a merge
   * op spec that the engine can enqueue. The merge op's vc is computed
   * via mergeMax-and-bump; it strictly dominates every participant.
   *
   * @param {string} entityId
   * @param {string} versionId
   * @param {string} resolverDeviceId
   * @returns {{ resolved: object, mergeOp: object }}
   */
  resolveByPick(entityId, versionId, resolverDeviceId) {
    const group = this._requireGroup(entityId);
    const chosen = group.versions.find((v) => v.versionId === versionId);
    if (!chosen) {
      throw new Error(`resolveByPick: version ${versionId} not found in group ${entityId}`);
    }
    const allVcs = group.versions.map((v) => v.vc);
    const mergedVc = vc.mergeAndBump(allVcs, resolverDeviceId);
    const mergeOp = {
      opType: 'asset.merge',
      entityType: group.entityType,
      entityId,
      payload: {
        chosenVersionId: versionId,
        payload: chosen.payload,
        sourceVersions: group.versions.map((v) => ({
          versionId: v.versionId,
          vc: v.vc,
          authorDeviceId: v.authorDeviceId,
        })),
      },
      vcAfter: mergedVc,
    };
    this._groups.delete(entityId);
    this._notify();
    log.info('sync-v5', 'Conflict resolved by pick', {
      entityId,
      chosen: versionId,
      sourceCount: group.versions.length,
    });
    return { resolved: chosen, mergeOp };
  }

  /**
   * Resolve by hand-merging payloads. Caller supplies the manually-merged
   * payload. Same vc construction as resolveByPick.
   *
   * @param {string} entityId
   * @param {object} mergedPayload
   * @param {string} resolverDeviceId
   * @returns {{ mergeOp: object }}
   */
  resolveByMerge(entityId, mergedPayload, resolverDeviceId) {
    const group = this._requireGroup(entityId);
    const allVcs = group.versions.map((v) => v.vc);
    const mergedVc = vc.mergeAndBump(allVcs, resolverDeviceId);
    const mergeOp = {
      opType: 'asset.merge',
      entityType: group.entityType,
      entityId,
      payload: {
        chosenVersionId: null,
        payload: mergedPayload,
        sourceVersions: group.versions.map((v) => ({
          versionId: v.versionId,
          vc: v.vc,
          authorDeviceId: v.authorDeviceId,
        })),
      },
      vcAfter: mergedVc,
    };
    this._groups.delete(entityId);
    this._notify();
    log.info('sync-v5', 'Conflict resolved by manual merge', {
      entityId,
      sourceCount: group.versions.length,
    });
    return { mergeOp };
  }

  /**
   * Subscribe to changes. The callback receives an object with {count,
   * groups: ConflictGroup[]} on every register/resolve. Unsubscribe by
   * calling the returned function.
   *
   * The conflict UI (renderer-side, future) listens to this.
   *
   * @param {(snapshot:{count:number, groups:object[]}) => void} fn
   * @returns {() => void} unsubscribe
   */
  subscribe(fn) {
    if (typeof fn !== 'function') throw new Error('subscribe: function required');
    this._subs.add(fn);
    // Initial push so the new subscriber sees current state.
    try {
      fn({ count: this.count(), groups: this.list() });
    } catch (_) {
      /* subscriber faults shouldn't break us */
    }
    return () => this._subs.delete(fn);
  }

  /**
   * Snapshot for the diagnostics-endpoints provider.
   */
  inspect() {
    return {
      count: this.count(),
      groups: this.list().map((g) => ({
        entityId: g.entityId,
        entityType: g.entityType,
        createdAt: g.createdAt,
        versionCount: g.versions.length,
      })),
    };
  }

  _requireGroup(entityId) {
    const g = this._groups.get(entityId);
    if (!g) throw new Error(`ConflictStore: no group for entityId ${entityId}`);
    return g;
  }

  _notify() {
    const snap = { count: this.count(), groups: this.list() };
    for (const fn of this._subs) {
      try {
        fn(snap);
      } catch (_) {
        /* subscriber faults shouldn't break us */
      }
    }
  }
}

// ────────────────────────────────────────────────────────────────────────────
// applyRemoteOp -- Phase 3 entry point that the (future) pull engine uses
// ────────────────────────────────────────────────────────────────────────────

/**
 * Apply a remote op to the local replica using the v5 conflict-resolution
 * rules. Returns the verdict + any generated ConflictGroup.
 *
 * Phase 3 exposes this for tests + the pull engine that lands in Phase 4.
 * The local replica isn't materialised yet; the function signature is
 * shaped so that wiring is a one-liner when the replica exists.
 *
 * @param {object} args
 * @param {string} args.entityId
 * @param {string} args.entityType
 * @param {object} args.localVersion  -- {vc, payload, authorDeviceId, authoredAt} or null
 * @param {object} args.remoteVersion -- same shape, from the graph pull
 * @param {ConflictStore} [args.conflictStore]
 * @returns {{ verdict:string, applied:boolean, conflict:object|null }}
 */
function applyRemoteOp({ entityId, entityType, localVersion, remoteVersion, conflictStore }) {
  if (!entityId) throw new Error('applyRemoteOp: entityId required');
  if (!remoteVersion || !vc.isValid(remoteVersion.vc)) {
    throw new Error('applyRemoteOp: remoteVersion with valid vc required');
  }
  const localVc = localVersion ? localVersion.vc : vc.empty();
  const verdict = detectConflict(localVc, remoteVersion.vc);

  if (verdict === VERDICT.EQUAL || verdict === VERDICT.IGNORE) {
    return { verdict, applied: false, conflict: null };
  }
  if (verdict === VERDICT.APPLY) {
    return { verdict, applied: true, conflict: null };
  }
  // CONFLICT
  if (!localVersion) {
    // No local version to conflict with -- shouldn't happen if vc said
    // CONFLICT, but be defensive.
    return { verdict, applied: true, conflict: null };
  }
  const group = makeGroup({
    entityId,
    entityType,
    versions: [
      makeVersion({
        vc: localVersion.vc,
        authorDeviceId: localVersion.authorDeviceId,
        authoredAt: localVersion.authoredAt,
        payload: localVersion.payload,
      }),
      makeVersion({
        vc: remoteVersion.vc,
        authorDeviceId: remoteVersion.authorDeviceId,
        authoredAt: remoteVersion.authoredAt,
        payload: remoteVersion.payload,
      }),
    ],
  });
  if (conflictStore && typeof conflictStore.register === 'function') {
    conflictStore.register(group);
  }
  return { verdict, applied: false, conflict: group };
}

module.exports = {
  VERDICT,
  detectConflict,
  makeVersion,
  makeGroup,
  ConflictStore,
  applyRemoteOp,
};
