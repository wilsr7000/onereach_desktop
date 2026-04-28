/**
 * Pull engine (v5 Section 4.7)
 *
 * Subscribes to graph change events (Neo4j 5 CDC if available; else 5s
 * poll on `lastUpdatedAt > cursor`) and applies remote ops to the local
 * replica.
 *
 * Per-op flow (using the Phase 3 building blocks):
 *   1. Read remote `:OperationLog` rows since the last cursor.
 *   2. For each op, look up the local replica's current version of the
 *      entity (Phase 4 stub uses an injected lookup function; the
 *      materialised replica itself lives in Phase 5+ tooling).
 *   3. Call `tombstone.shouldAllowWrite(entityId, incomingVc)` to gate
 *      against pre-delete writes (no-resurrection invariant).
 *   4. Call `conflict.applyRemoteOp({localVersion, remoteVersion,
 *      conflictStore})` to detect APPLY / IGNORE / EQUAL / CONFLICT.
 *   5. APPLY -> caller's localApplyFn writes to the materialised replica.
 *      IGNORE / EQUAL -> noop. CONFLICT -> registered in ConflictStore;
 *      caller's UI surfaces a banner.
 *   6. Advance cursor to the latest applied op's at.
 *
 * Phase 4 ships:
 *   - the periodic poll loop (configurable cadence + backoff on errors)
 *   - cursor persistence (per-space, JSON-backed, atomic)
 *   - the per-op pipeline above
 *   - the diagnostics surface (inspect() for /sync/queue endpoint)
 *
 * Phase 4 does NOT ship:
 *   - Neo4j 5 CDC subscription (the API surface is reserved as
 *     `subscribeToChangeFeed`; default impl polls. CDC support lands
 *     when we confirm the Aura instance has it enabled.)
 *   - the materialised replica itself -- the engine takes localApplyFn /
 *     localLookupFn as injected callbacks. Phase 5+ tooling materialises
 *     the actual SQLite-backed replica.
 *
 * The pull engine is callable today against a stub localApplyFn; that
 * lets the demo helper validate the protocol end-to-end without
 * requiring the full materialised-replica module.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const vc = require('./vector-clock');
const conflict = require('./conflict');
const tombstone = require('./tombstone');
const { getLogQueue } = require('../log-event-queue');
const log = getLogQueue();

const DEFAULT_POLL_INTERVAL_MS = 5000; // 5s default per v5 4.7
const DEFAULT_BATCH_SIZE = 50;
const MAX_BACKOFF_MS = 5 * 60 * 1000;

/**
 * applyMode declares what `localApplyFn` actually does on APPLY verdicts.
 * Surfaced via inspect() and the diagnostics endpoint so operators don't
 * mistake a "pull is running" signal for "remote ops are landing in the
 * local replica."
 *
 *   'noop'   -- localApplyFn is a stub. APPLY verdicts are discarded.
 *               CONFLICT verdicts still register correctly in ConflictStore
 *               (vc-only, no replica needed). Heartbeat acks still fire.
 *               This is the Phase 2-4 boot-wiring state until the
 *               materialised replica lands.
 *   'sqlite' -- localApplyFn writes to the SQLite-backed materialised
 *               replica. APPLY verdicts produce visible changes. This is
 *               the production state once the replica ships.
 *   'custom' -- non-default applyFn (test, alternate replica backend, etc.).
 *               Caller asserts they know what they're doing.
 */
const APPLY_MODE = Object.freeze({
  NOOP: 'noop',
  SQLITE: 'sqlite',
  CUSTOM: 'custom',
});

// ────────────────────────────────────────────────────────────────────────────
// Cypher constants
// ────────────────────────────────────────────────────────────────────────────

/**
 * Read :OperationLog rows since a cursor (a wall-clock at). Includes the
 * vcAfter so the caller can detect dominance against local state.
 *
 * Param shape: $sinceAt (ISO|null), $limit
 */
const CYPHER_READ_OPLOG_SINCE = `
  MATCH (op:OperationLog)
  WHERE ($sinceAt IS NULL OR op.at > datetime($sinceAt))
  OPTIONAL MATCH (op)-[:APPLIED_TO]->(a:Asset)
  RETURN op.traceId AS traceId,
         op.deviceId AS deviceId,
         op.entityId AS entityId,
         op.entityType AS entityType,
         op.op AS opType,
         op.at AS at,
         op.contentHash AS contentHash,
         op.vcAfter AS vcAfter,
         coalesce(op.ackedByDevice, false) AS ackedByDevice,
         a.spaceId AS spaceId
  ORDER BY op.at ASC
  LIMIT $limit
`;

// ────────────────────────────────────────────────────────────────────────────
// PullEngine
// ────────────────────────────────────────────────────────────────────────────

class PullEngine {
  /**
   * @param {object} args
   * @param {object} args.omniClient
   * @param {string} args.deviceId          -- this device's ULID; used to
   *                                            skip ops we authored ourselves
   * @param {object} args.conflictStore     -- ConflictStore instance
   * @param {(entityId:string) => Promise<{vc:object, payload:object, authorDeviceId:string, authoredAt:string} | null>} args.localLookupFn
   *   -- given an entityId, return the current local replica version. Phase 5+
   *      backs this with the SQLite-materialized replica; Phase 4 callers
   *      pass a stub.
   * @param {(args:{ entityId:string, version:object, opType:string, contentHash:string }) => Promise<void>} args.localApplyFn
   *   -- called when an op should be applied to the local replica.
   *      Phase 5+ tooling writes to SQLite; Phase 4 callers may noop.
   * @param {string} [args.cursorPath]
   * @param {number} [args.pollIntervalMs=5000]
   * @param {number} [args.batchSize=50]
   * @param {() => number} [args.now]
   */
  constructor({
    omniClient,
    deviceId,
    conflictStore,
    localLookupFn,
    localApplyFn,
    applyMode = APPLY_MODE.CUSTOM,
    cursorPath,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    batchSize = DEFAULT_BATCH_SIZE,
    now = () => Date.now(),
  }) {
    if (!omniClient) throw new Error('PullEngine: omniClient required');
    if (!deviceId) throw new Error('PullEngine: deviceId required');
    if (!conflictStore) throw new Error('PullEngine: conflictStore required');
    if (typeof localLookupFn !== 'function') {
      throw new Error('PullEngine: localLookupFn required (Phase 5+ wires the replica)');
    }
    if (typeof localApplyFn !== 'function') {
      throw new Error('PullEngine: localApplyFn required (Phase 5+ wires the replica)');
    }
    if (!Object.values(APPLY_MODE).includes(applyMode)) {
      throw new Error(
        `PullEngine: applyMode must be one of ${Object.values(APPLY_MODE).join(' | ')}, got ${applyMode}`
      );
    }
    this._omniClient = omniClient;
    this._deviceId = deviceId;
    this._conflictStore = conflictStore;
    this._localLookupFn = localLookupFn;
    this._localApplyFn = localApplyFn;
    this._applyMode = applyMode;
    this._cursorPath = cursorPath || _defaultCursorPath();
    this._pollIntervalMs = pollIntervalMs;
    this._batchSize = batchSize;
    this._now = now;

    this._cursor = null;
    this._loadCursor();

    this._timer = null;
    this._started = false;
    this._polling = false; // re-entrancy guard
    this._consecutiveErrors = 0;
    this._stats = {
      lastPollAt: null,
      lastError: null,
      applied: 0,
      ignored: 0,
      conflicts: 0,
      tombstoneRefused: 0,
      ownOpsSkipped: 0,
    };
  }

  start() {
    if (this._started) return;
    this._started = true;
    this._scheduleNextPoll(0);
    log.info('sync-v5', 'PullEngine started', { pollIntervalMs: this._pollIntervalMs });
  }

  stop() {
    this._started = false;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }

  inspect() {
    return {
      started: this._started,
      cursor: this._cursor,
      pollIntervalMs: this._pollIntervalMs,
      consecutiveErrors: this._consecutiveErrors,
      applyMode: this._applyMode,
      applyModeNote:
        this._applyMode === APPLY_MODE.NOOP
          ? 'APPLY verdicts discarded (no materialised replica wired); CONFLICT verdicts and heartbeat acks still fire normally'
          : null,
      ...this._stats,
    };
  }

  /**
   * Run a single poll cycle. Public for tests + the demo helper.
   * Returns the count of ops processed (applied + ignored + conflicts).
   */
  async pollOnce() {
    if (this._polling) return 0;
    this._polling = true;
    let processed = 0;
    try {
      if (typeof this._omniClient.isReady === 'function' && !this._omniClient.isReady()) {
        return 0;
      }
      const rows = await this._omniClient.executeQuery(CYPHER_READ_OPLOG_SINCE, {
        sinceAt: this._cursor,
        limit: this._batchSize,
      });
      if (!Array.isArray(rows) || rows.length === 0) {
        this._stats.lastPollAt = new Date(this._now()).toISOString();
        return 0;
      }
      for (const r of rows) {
        await this._processRemoteOp(r);
        processed++;
        // Advance cursor incrementally so a partial-batch failure doesn't
        // re-process already-applied ops on the next tick.
        if (r.at && (!this._cursor || r.at > this._cursor)) {
          this._cursor = String(r.at);
        }
      }
      this._saveCursor();
      this._consecutiveErrors = 0;
      this._stats.lastPollAt = new Date(this._now()).toISOString();
      this._stats.lastError = null;
    } catch (err) {
      this._consecutiveErrors++;
      this._stats.lastError = err.message;
      log.warn('sync-v5', 'PullEngine poll failed', {
        error: err.message,
        consecutiveErrors: this._consecutiveErrors,
      });
    } finally {
      this._polling = false;
    }
    return processed;
  }

  /**
   * Subscribe to a future Neo4j CDC change feed. Reserved API; default
   * implementation falls back to polling. Phase 4+ wires CDC if Aura
   * exposes it.
   *
   * @returns {Promise<() => void>} unsubscribe fn
   */
  async subscribeToChangeFeed() {
    log.info('sync-v5', 'PullEngine: CDC subscription not available; falling back to poll');
    this.start();
    return () => this.stop();
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Internals
  // ──────────────────────────────────────────────────────────────────────────

  async _processRemoteOp(r) {
    // Skip ops we authored ourselves -- they were already applied locally
    // by the SyncEngine when we wrote them.
    if (r.deviceId === this._deviceId) {
      this._stats.ownOpsSkipped++;
      return;
    }

    const remoteVc = typeof r.vcAfter === 'string' ? vc.fromJSON(r.vcAfter) : r.vcAfter;
    if (!vc.isValid(remoteVc)) {
      log.warn('sync-v5', 'PullEngine: remote op has invalid vc', {
        traceId: r.traceId,
        entityId: r.entityId,
      });
      return;
    }

    // Phase 3 gate: tombstone check (no-resurrection invariant).
    const allow = await tombstone.shouldAllowWrite(r.entityId, remoteVc, {
      omniClient: this._omniClient,
    });
    if (!allow.allowed) {
      this._stats.tombstoneRefused++;
      log.info('sync-v5', 'PullEngine: remote op refused by tombstone', {
        traceId: r.traceId,
        entityId: r.entityId,
        reason: allow.reason,
      });
      return;
    }

    // Look up the local version (Phase 5+ replica; Phase 4 stub).
    let localVersion = null;
    try {
      localVersion = await this._localLookupFn(r.entityId);
    } catch (err) {
      log.warn('sync-v5', 'localLookupFn threw', { entityId: r.entityId, error: err.message });
    }

    const remoteVersion = {
      vc: remoteVc,
      payload: { contentHash: r.contentHash || '', opType: r.opType },
      authorDeviceId: r.deviceId,
      authoredAt: String(r.at),
    };

    const result = conflict.applyRemoteOp({
      entityId: r.entityId,
      entityType: r.entityType || 'asset',
      localVersion,
      remoteVersion,
      conflictStore: this._conflictStore,
    });

    if (result.verdict === conflict.VERDICT.APPLY) {
      try {
        await this._localApplyFn({
          entityId: r.entityId,
          version: remoteVersion,
          opType: r.opType,
          contentHash: r.contentHash || '',
        });
        this._stats.applied++;
      } catch (err) {
        log.warn('sync-v5', 'localApplyFn threw', { entityId: r.entityId, error: err.message });
      }
    } else if (result.verdict === conflict.VERDICT.CONFLICT) {
      this._stats.conflicts++;
    } else {
      this._stats.ignored++;
    }
  }

  _scheduleNextPoll(delayMs) {
    if (this._timer) clearTimeout(this._timer);
    const backoffMs = this._consecutiveErrors > 0
      ? Math.min(this._pollIntervalMs * Math.pow(2, this._consecutiveErrors), MAX_BACKOFF_MS)
      : this._pollIntervalMs;
    const wait = Math.max(0, delayMs ?? backoffMs);
    this._timer = setTimeout(async () => {
      this._timer = null;
      if (!this._started) return;
      try {
        await this.pollOnce();
      } catch (err) {
        log.warn('sync-v5', 'PullEngine poll crashed', { error: err.message });
      }
      if (this._started) this._scheduleNextPoll();
    }, wait);
    if (this._timer && typeof this._timer.unref === 'function') {
      this._timer.unref();
    }
  }

  _loadCursor() {
    try {
      if (fs.existsSync(this._cursorPath)) {
        const raw = fs.readFileSync(this._cursorPath, 'utf8');
        const parsed = JSON.parse(raw);
        if (typeof parsed.cursor === 'string') this._cursor = parsed.cursor;
      }
    } catch (err) {
      log.warn('sync-v5', 'PullEngine cursor load failed', { error: err.message });
    }
  }

  _saveCursor() {
    try {
      fs.mkdirSync(path.dirname(this._cursorPath), { recursive: true });
      const tmp = `${this._cursorPath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ cursor: this._cursor }, null, 2), 'utf8');
      fs.renameSync(tmp, this._cursorPath);
    } catch (err) {
      log.warn('sync-v5', 'PullEngine cursor save failed', { error: err.message });
    }
  }
}

function _defaultCursorPath() {
  try {
    const { app } = require('electron');
    if (app && typeof app.getPath === 'function') {
      return path.join(app.getPath('userData'), 'sync-v5', 'pull-cursor.json');
    }
  } catch (_) {
    /* not in electron context */
  }
  return path.join(require('os').tmpdir(), 'sync-v5-test', 'pull-cursor.json');
}

module.exports = {
  PullEngine,
  APPLY_MODE,
  CYPHER_READ_OPLOG_SINCE,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_BATCH_SIZE,
  MAX_BACKOFF_MS,
};
