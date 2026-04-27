/**
 * Snapshots and retention compaction (v5 Section 4.3)
 *
 * Snapshots freeze the state of a space at a point in time. Their primary
 * purpose is point-in-time reconstruction (v5 invariant 8): for any
 * timestamp T and space S within retention horizon, materialise(S, T)
 * deterministically reproduces the state visible at T. Beyond retention,
 * only snapshot states remain queryable.
 *
 * Trigger (per v5 4.3, threshold-or-staleness):
 *   every 100 ops OR every 24h since last snapshot, per space, whichever
 *   first. Plus on-demand via writeSnapshot({entityId}).
 *
 * Compaction (sliding window, per v5 4.3):
 *   0-7 days     : keep all snapshots at native cadence
 *   7-30 days    : collapse to one per day
 *   30-365 days  : collapse to one per week
 *   1+ year      : collapse to one per month, retained to compliance horizon
 *
 * Compaction safety check: a snapshot most-recent-before a :Tombstone is
 * preserved through compaction regardless of age. Otherwise tombstone
 * reconstruction breaks at the compactor's discretion -- a silent
 * compliance violation.
 *
 * Operator forensic preservation: a snapshot with preserveUntil > now is
 * not collapsed by the compactor regardless of age. Operators set this
 * when investigating an incident.
 *
 * Op-log retention is tied to snapshot retention (v5 4.3 "OperationLog
 * retention"): the op log between snapshot N and N+1 is retained as long
 * as snapshot N is retained. When N is collapsed, the op log between N
 * and the next surviving snapshot is collapsed (truncated to cumulative
 * effect). State reconstruction is possible at any point within retention
 * horizon.
 *
 * Phase 4 ships:
 *   - the canonical Cypher constants for write + list + collapse
 *   - the trigger algorithm + writeSnapshot helper
 *   - the compaction policy + computeCollapseDecisions pure function
 *   - the op-log truncation helper (collapseOpLogBetween)
 *
 * Phase 4 does NOT ship the periodic compaction job loop -- that's a
 * cron-style scheduler and lives in main.js boot wiring (a follow-up).
 * The pure functions here are testable without the scheduler.
 */

'use strict';

const vc = require('./vector-clock');
const { newTraceId } = require('./trace-id');
const { getLogQueue } = require('../log-event-queue');
const log = getLogQueue();

const DEFAULT_TRIGGER_OPS = 100;
const DEFAULT_TRIGGER_INTERVAL_MS = 24 * 60 * 60 * 1000;

const RETENTION_BANDS = Object.freeze({
  NATIVE_DAYS: 7, // 0-7d: keep all
  DAILY_DAYS: 30, // 7-30d: one per day
  WEEKLY_DAYS: 365, // 30-365d: one per week
  // beyond 365d: one per month (until compliance horizon)
});

// ────────────────────────────────────────────────────────────────────────────
// Cypher constants
// ────────────────────────────────────────────────────────────────────────────

/**
 * Atomically write a :Snapshot node tied to a :Space. The snapshot's
 * `vc` is the merged vector-clock state of every active :Asset in the
 * space at the moment of write -- i.e. the high-water mark of causality
 * for the space.
 *
 * Param shape:
 *   $spaceId, $takenAt (ISO), $traceId, $vcJson, $reason ('threshold' |
 *   'staleness' | 'on-demand'), $preserveUntil (ISO|null)
 */
const CYPHER_WRITE_SNAPSHOT = `
  CREATE (s:Snapshot {
    spaceId: $spaceId,
    takenAt: datetime($takenAt),
    traceId: $traceId,
    vc: $vcJson,
    reason: $reason,
    preserveUntil: CASE WHEN $preserveUntil IS NULL THEN null ELSE datetime($preserveUntil) END
  })
  WITH s
  OPTIONAL MATCH (sp:Space {id: $spaceId})
  FOREACH (_ IN CASE WHEN sp IS NULL THEN [] ELSE [1] END |
    MERGE (s)-[:OF_SPACE]->(sp)
  )
  RETURN s.traceId AS traceId
`;

/**
 * Compute the high-water-mark vc across every active :Asset in a space.
 * Used to populate :Snapshot.vc.
 */
const CYPHER_COMPUTE_SPACE_VC = `
  MATCH (a:Asset)
  WHERE a.spaceId = $spaceId AND coalesce(a.active, true) = true AND a.vc IS NOT NULL
  RETURN a.vc AS vc
`;

/**
 * List all :Snapshot nodes for a space, oldest first.
 */
const CYPHER_LIST_SNAPSHOTS = `
  MATCH (s:Snapshot {spaceId: $spaceId})
  RETURN s.spaceId AS spaceId,
         s.takenAt AS takenAt,
         s.traceId AS traceId,
         s.vc AS vc,
         s.reason AS reason,
         s.preserveUntil AS preserveUntil
  ORDER BY s.takenAt ASC
`;

/**
 * Find the most recent :Snapshot for a space at or before a target instant.
 * Used by point-in-time materialisation: snapshot + replay-ops-since.
 */
const CYPHER_SNAPSHOT_BEFORE = `
  MATCH (s:Snapshot {spaceId: $spaceId})
  WHERE s.takenAt <= datetime($at)
  RETURN s.spaceId AS spaceId,
         s.takenAt AS takenAt,
         s.traceId AS traceId,
         s.vc AS vc,
         s.reason AS reason
  ORDER BY s.takenAt DESC
  LIMIT 1
`;

/**
 * Collapse (delete) a set of snapshots by traceId. Returns the count.
 * Used by the compactor.
 */
const CYPHER_COLLAPSE_SNAPSHOTS = `
  MATCH (s:Snapshot)
  WHERE s.traceId IN $traceIds
  WITH s, count(s) AS _
  DETACH DELETE s
  RETURN count(*) AS deleted
`;

/**
 * Find the most recent snapshot whose takenAt is before the most recent
 * Tombstone for any asset in a space. The compactor MUST preserve these
 * snapshots regardless of age -- they're the only way to reconstruct
 * pre-deletion state for compliance audits.
 *
 * Returns the set of snapshot traceIds that the compactor must spare.
 */
const CYPHER_PRE_TOMBSTONE_SNAPSHOTS = `
  MATCH (t:Tombstone)
  WHERE t.entityId IN $entityIds OR $entityIds IS NULL
  WITH t.deletedAt AS deletedAt, t.entityId AS entityId
  MATCH (s:Snapshot)
  WHERE s.takenAt < deletedAt
    AND s.spaceId = $spaceId
  WITH deletedAt, entityId, s
  ORDER BY s.takenAt DESC
  WITH deletedAt, entityId, head(collect(s)) AS preTombstone
  RETURN DISTINCT preTombstone.traceId AS traceId
`;

/**
 * Collapse :OperationLog rows between two snapshots into the cumulative
 * effect. Per v5 4.3, when snapshot N is collapsed, the op log between N
 * and the next surviving snapshot collapses too. Cumulative-effect means:
 * for each entityId touched, keep the LAST OperationLog row (the one
 * whose vcAfter is dominant) and delete the rest.
 *
 * Param shape:
 *   $spaceId, $fromAt (ISO|null), $toAt (ISO)
 *   When $fromAt is null, collapse all op-log entries up to $toAt.
 */
const CYPHER_COLLAPSE_OP_LOG = `
  MATCH (op:OperationLog)
  WHERE op.entityType IS NOT NULL
    AND op.at <= datetime($toAt)
    AND ($fromAt IS NULL OR op.at > datetime($fromAt))
    AND ( ($spaceId IS NULL) OR exists {
      MATCH (op)-[:APPLIED_TO]->(a:Asset {spaceId: $spaceId})
    } )
  WITH op.entityId AS entityId, collect(op) AS ops
  WITH entityId, ops,
       reduce(latest = null, o IN ops |
         CASE WHEN latest IS NULL OR o.at > latest.at THEN o ELSE latest END
       ) AS latest
  UNWIND ops AS op
  WITH op, latest
  WHERE op <> latest
  DETACH DELETE op
  RETURN count(*) AS deleted
`;

// ────────────────────────────────────────────────────────────────────────────
// Pure trigger algorithm (testable without a graph)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Decide whether to take a snapshot now, based on threshold-or-staleness.
 *
 * @param {object} args
 * @param {number} args.opsSinceLastSnapshot
 * @param {string|null} args.lastSnapshotAt -- ISO timestamp, or null if none yet
 * @param {number} [args.now]               -- ms since epoch
 * @param {number} [args.opsThreshold=100]
 * @param {number} [args.intervalMs=24h]
 * @returns {{ shouldTake:boolean, reason:string|null }}
 */
function shouldSnapshot({
  opsSinceLastSnapshot,
  lastSnapshotAt,
  now = Date.now(),
  opsThreshold = DEFAULT_TRIGGER_OPS,
  intervalMs = DEFAULT_TRIGGER_INTERVAL_MS,
}) {
  if (typeof opsSinceLastSnapshot !== 'number' || opsSinceLastSnapshot < 0) {
    return { shouldTake: false, reason: 'invalid opsSinceLastSnapshot' };
  }
  if (opsSinceLastSnapshot >= opsThreshold) {
    return { shouldTake: true, reason: 'threshold' };
  }
  if (!lastSnapshotAt) {
    // No prior snapshot. Don't fire just because of that -- the first
    // snapshot fires when the threshold is hit, OR when the staleness
    // window passes since the SPACE was created (caller passes the space
    // creation timestamp as lastSnapshotAt).
    return { shouldTake: false, reason: 'no prior snapshot and threshold not reached' };
  }
  const lastMs = new Date(lastSnapshotAt).getTime();
  if (Number.isFinite(lastMs) && now - lastMs >= intervalMs) {
    return { shouldTake: true, reason: 'staleness' };
  }
  return { shouldTake: false, reason: null };
}

// ────────────────────────────────────────────────────────────────────────────
// Pure compaction policy (testable without a graph)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Decide which snapshots to collapse vs preserve, given a list of
 * candidates and the current time. Implements the sliding-window policy
 * from v5 4.3:
 *
 *   - 0-7 days       : keep all
 *   - 7-30 days      : keep one per day (latest of each day)
 *   - 30-365 days    : keep one per week (latest of each ISO week)
 *   - 1+ year        : keep one per month (latest of each calendar month)
 *
 * Plus: snapshots flagged preserveUntil > now are always kept.
 * Plus: snapshots in preTombstoneSet are always kept (compliance safety).
 *
 * Pure function -- accepts the inputs, returns the decisions. The graph
 * caller fetches the candidate list and the pre-tombstone set, calls
 * this, then issues the collapse Cypher with the resulting traceIds.
 *
 * @param {Array<{traceId:string, takenAt:string, preserveUntil:string|null}>} snapshots
 * @param {Object} [opts]
 * @param {number} [opts.now]                     -- ms since epoch
 * @param {Set<string>} [opts.preTombstoneTraceIds]
 * @returns {{ keep:string[], collapse:string[], reason: Object<string,string> }}
 */
function computeCollapseDecisions(snapshots, opts = {}) {
  const now = opts.now || Date.now();
  const preserveSet = opts.preTombstoneTraceIds || new Set();

  // Sort newest first.
  const sorted = [...(snapshots || [])]
    .filter((s) => s && s.traceId && s.takenAt)
    .sort((a, b) => new Date(b.takenAt).getTime() - new Date(a.takenAt).getTime());

  const keep = [];
  const collapse = [];
  const reason = {};

  // Track the bucket key already taken for each band.
  const dailySeen = new Set(); // YYYY-MM-DD
  const weeklySeen = new Set(); // YYYY-Www
  const monthlySeen = new Set(); // YYYY-MM

  for (const s of sorted) {
    const ageMs = now - new Date(s.takenAt).getTime();
    const ageDays = ageMs / 86400000;

    // Forensic preservation: operator-flagged.
    if (s.preserveUntil && new Date(s.preserveUntil).getTime() > now) {
      keep.push(s.traceId);
      reason[s.traceId] = 'preserveUntil';
      continue;
    }

    // Compliance safety: pre-tombstone snapshots.
    if (preserveSet.has(s.traceId)) {
      keep.push(s.traceId);
      reason[s.traceId] = 'pre-tombstone';
      continue;
    }

    // Native cadence band.
    if (ageDays < RETENTION_BANDS.NATIVE_DAYS) {
      keep.push(s.traceId);
      reason[s.traceId] = 'native';
      continue;
    }

    // Daily band.
    if (ageDays < RETENTION_BANDS.DAILY_DAYS) {
      const day = s.takenAt.slice(0, 10); // YYYY-MM-DD
      if (!dailySeen.has(day)) {
        dailySeen.add(day);
        keep.push(s.traceId);
        reason[s.traceId] = 'daily';
      } else {
        collapse.push(s.traceId);
        reason[s.traceId] = 'daily-collapsed';
      }
      continue;
    }

    // Weekly band.
    if (ageDays < RETENTION_BANDS.WEEKLY_DAYS) {
      const wk = _isoWeek(s.takenAt);
      if (!weeklySeen.has(wk)) {
        weeklySeen.add(wk);
        keep.push(s.traceId);
        reason[s.traceId] = 'weekly';
      } else {
        collapse.push(s.traceId);
        reason[s.traceId] = 'weekly-collapsed';
      }
      continue;
    }

    // Monthly band.
    const mo = s.takenAt.slice(0, 7); // YYYY-MM
    if (!monthlySeen.has(mo)) {
      monthlySeen.add(mo);
      keep.push(s.traceId);
      reason[s.traceId] = 'monthly';
    } else {
      collapse.push(s.traceId);
      reason[s.traceId] = 'monthly-collapsed';
    }
  }

  return { keep, collapse, reason };
}

// ────────────────────────────────────────────────────────────────────────────
// Public graph API
// ────────────────────────────────────────────────────────────────────────────

/**
 * Compute the high-water-mark vc across every active asset in a space.
 *
 * @param {string} spaceId
 * @param {object} [opts]
 * @returns {Promise<object>} VectorClock
 */
async function computeSpaceVc(spaceId, opts = {}) {
  const omniClient = _resolveOmniClient(opts.omniClient);
  if (!omniClient || (typeof omniClient.isReady === 'function' && !omniClient.isReady())) {
    return vc.empty();
  }
  try {
    const rows = await omniClient.executeQuery(CYPHER_COMPUTE_SPACE_VC, { spaceId });
    if (!Array.isArray(rows) || rows.length === 0) return vc.empty();
    const vcs = rows
      .map((r) => {
        if (typeof r.vc === 'string') return vc.fromJSON(r.vc);
        if (vc.isValid(r.vc)) return r.vc;
        return null;
      })
      .filter(Boolean);
    return vc.mergeMax(vcs);
  } catch (err) {
    log.warn('sync-v5', 'computeSpaceVc failed', { spaceId, error: err.message });
    return vc.empty();
  }
}

/**
 * Write a :Snapshot for a space.
 *
 * @param {object} args
 * @param {string} args.spaceId
 * @param {string} [args.reason='threshold']
 * @param {string} [args.preserveUntil] -- ISO; sets operator forensic flag
 * @param {object} [opts]
 * @returns {Promise<{traceId:string, vc:object, takenAt:string, error:string|null}>}
 */
async function writeSnapshot({ spaceId, reason = 'threshold', preserveUntil = null }, opts = {}) {
  if (!spaceId || typeof spaceId !== 'string') {
    return { traceId: null, vc: {}, takenAt: null, error: 'spaceId required' };
  }
  const omniClient = _resolveOmniClient(opts.omniClient);
  if (!omniClient) {
    return { traceId: null, vc: {}, takenAt: null, error: 'OmniGraph client unavailable' };
  }
  if (typeof omniClient.isReady === 'function' && !omniClient.isReady()) {
    return { traceId: null, vc: {}, takenAt: null, error: 'graph not ready' };
  }
  try {
    const spaceVc = await computeSpaceVc(spaceId, { omniClient });
    const traceId = newTraceId();
    const takenAt = new Date().toISOString();
    await omniClient.executeQuery(CYPHER_WRITE_SNAPSHOT, {
      spaceId,
      takenAt,
      traceId,
      vcJson: vc.toJSON(spaceVc),
      reason,
      preserveUntil: preserveUntil || null,
    });
    log.info('sync-v5', 'Snapshot written', { spaceId, traceId, reason });
    return { traceId, vc: spaceVc, takenAt, error: null };
  } catch (err) {
    log.warn('sync-v5', 'writeSnapshot failed', { spaceId, error: err.message });
    return { traceId: null, vc: {}, takenAt: null, error: err.message };
  }
}

/**
 * Run the compactor for a single space. Lists snapshots, fetches pre-
 * tombstone safety set, computes collapse decisions, issues the collapse
 * Cypher, then collapses the op-log between every collapsed snapshot and
 * the next surviving one.
 *
 * @param {string} spaceId
 * @param {object} [opts]
 * @param {number} [opts.now]
 * @returns {Promise<{kept:number, collapsed:number, opLogCollapsed:number, error:string|null}>}
 */
async function compactSpace(spaceId, opts = {}) {
  const omniClient = _resolveOmniClient(opts.omniClient);
  if (!omniClient) return { kept: 0, collapsed: 0, opLogCollapsed: 0, error: 'OmniGraph client unavailable' };
  if (typeof omniClient.isReady === 'function' && !omniClient.isReady()) {
    return { kept: 0, collapsed: 0, opLogCollapsed: 0, error: 'graph not ready' };
  }
  try {
    const snapshots = await omniClient.executeQuery(CYPHER_LIST_SNAPSHOTS, { spaceId });
    const preTombstoneRows = await omniClient.executeQuery(CYPHER_PRE_TOMBSTONE_SNAPSHOTS, {
      spaceId,
      entityIds: null,
    });
    const preTombstoneSet = new Set(preTombstoneRows.map((r) => r.traceId).filter(Boolean));
    const decisions = computeCollapseDecisions(snapshots, {
      now: opts.now,
      preTombstoneTraceIds: preTombstoneSet,
    });
    let opLogCollapsed = 0;
    if (decisions.collapse.length > 0) {
      // Compute the op-log collapse spans: for each collapsed snapshot,
      // truncate the op-log between its takenAt and the next surviving
      // snapshot's takenAt.
      const traceToTakenAt = new Map(snapshots.map((s) => [s.traceId, s.takenAt]));
      const survivingSorted = decisions.keep
        .map((tid) => ({ traceId: tid, takenAt: traceToTakenAt.get(tid) }))
        .filter((s) => s.takenAt)
        .sort((a, b) => new Date(a.takenAt).getTime() - new Date(b.takenAt).getTime());
      for (const collapsedTraceId of decisions.collapse) {
        const collapsedAt = traceToTakenAt.get(collapsedTraceId);
        if (!collapsedAt) continue;
        // Find the next surviving snapshot AFTER this collapsed one.
        const next = survivingSorted.find((s) => s.takenAt > collapsedAt);
        const fromAt = collapsedAt;
        const toAt = next ? next.takenAt : new Date(opts.now || Date.now()).toISOString();
        try {
          const r = await omniClient.executeQuery(CYPHER_COLLAPSE_OP_LOG, {
            spaceId,
            fromAt,
            toAt,
          });
          opLogCollapsed += _toInt(r?.[0]?.deleted) || 0;
        } catch (err) {
          log.warn('sync-v5', 'op-log collapse failed for snapshot span', {
            spaceId,
            collapsedTraceId,
            error: err.message,
          });
        }
      }
      // Now collapse the snapshots themselves.
      await omniClient.executeQuery(CYPHER_COLLAPSE_SNAPSHOTS, {
        traceIds: decisions.collapse,
      });
    }
    log.info('sync-v5', 'Space compaction done', {
      spaceId,
      kept: decisions.keep.length,
      collapsed: decisions.collapse.length,
      opLogCollapsed,
    });
    return {
      kept: decisions.keep.length,
      collapsed: decisions.collapse.length,
      opLogCollapsed,
      error: null,
    };
  } catch (err) {
    log.warn('sync-v5', 'compactSpace failed', { spaceId, error: err.message });
    return { kept: 0, collapsed: 0, opLogCollapsed: 0, error: err.message };
  }
}

/**
 * Materialise a space's state at a specific point in time.
 * Returns the snapshot at-or-before the requested instant + the op-log
 * to replay forward from there.
 *
 * Phase 4 returns the BUILDING BLOCKS for materialisation (snapshot vc
 * + op-log span); the caller (Phase 5+ tooling, or the renderer's
 * point-in-time view) does the replay against its local replica.
 *
 * @param {string} spaceId
 * @param {string} at   -- ISO timestamp
 * @param {object} [opts]
 * @returns {Promise<{snapshot:object|null, opLogSpan:{fromAt:string|null, toAt:string}}>}
 */
async function materialise(spaceId, at, opts = {}) {
  const omniClient = _resolveOmniClient(opts.omniClient);
  if (!omniClient) return { snapshot: null, opLogSpan: { fromAt: null, toAt: at } };
  if (typeof omniClient.isReady === 'function' && !omniClient.isReady()) {
    return { snapshot: null, opLogSpan: { fromAt: null, toAt: at } };
  }
  try {
    const rows = await omniClient.executeQuery(CYPHER_SNAPSHOT_BEFORE, { spaceId, at });
    if (!Array.isArray(rows) || rows.length === 0) {
      return { snapshot: null, opLogSpan: { fromAt: null, toAt: at } };
    }
    const r = rows[0];
    return {
      snapshot: {
        spaceId: r.spaceId,
        takenAt: r.takenAt,
        traceId: r.traceId,
        vc: typeof r.vc === 'string' ? vc.fromJSON(r.vc) : r.vc,
        reason: r.reason,
      },
      opLogSpan: { fromAt: r.takenAt, toAt: at },
    };
  } catch (err) {
    log.warn('sync-v5', 'materialise failed', { spaceId, at, error: err.message });
    return { snapshot: null, opLogSpan: { fromAt: null, toAt: at } };
  }
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

function _toInt(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  if (typeof v === 'object' && typeof v.low === 'number') return v.low;
  return null;
}

/**
 * Compute the ISO-week key (YYYY-Www) for a date. Used by the weekly
 * compaction band.
 */
function _isoWeek(iso) {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso.slice(0, 10);
  // ISO week algorithm: Thursday of the week is in the year of the week.
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (target.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((target - firstThursday) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${target.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

module.exports = {
  CYPHER_WRITE_SNAPSHOT,
  CYPHER_LIST_SNAPSHOTS,
  CYPHER_SNAPSHOT_BEFORE,
  CYPHER_COLLAPSE_SNAPSHOTS,
  CYPHER_COLLAPSE_OP_LOG,
  CYPHER_PRE_TOMBSTONE_SNAPSHOTS,
  CYPHER_COMPUTE_SPACE_VC,
  DEFAULT_TRIGGER_OPS,
  DEFAULT_TRIGGER_INTERVAL_MS,
  RETENTION_BANDS,
  shouldSnapshot,
  computeCollapseDecisions,
  computeSpaceVc,
  writeSnapshot,
  compactSpace,
  materialise,
  // Test-only:
  _isoWeek,
};
