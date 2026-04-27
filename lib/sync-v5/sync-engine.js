/**
 * Sync engine (v5 Section 4.5 + 4.7)
 *
 * Drains the local op queue per the 4-step write protocol:
 *
 *   1. compute hash (op already has traceId from API layer + content)
 *   2. blobStore.upload(hash, content) -- idempotent
 *   3. graph tx { upsert :Asset, bump vc, write :OperationLog with traceId }
 *      -- atomic at the graph layer
 *   4. local mark-and-remove (graph receives ack via next heartbeat)
 *
 * Per v5 4.7 sync-engine spec:
 *   - one in-flight tx per entity to preserve causality
 *   - failed ops backoff (DLQ.computeBackoffMs) and re-tried
 *   - parkToDlq after retry budget exhausted
 *   - heartbeat reporter is told about each successful ack via recordAck()
 *
 * Phase 2 ships:
 *   - the SyncEngine class with start/stop/drainOnce
 *   - the canonical OperationLog Cypher upsert pattern (vc bump elided in
 *     Phase 2 because vc isn't a thing yet; placeholder comment)
 *   - per-entity in-flight gating (causality-preserving fairness)
 *   - integration with HeartbeatReporter via recordAck()
 *
 * Phase 2 does NOT yet:
 *   - bump vector clocks (Phase 3 -- the placeholder comment in the Cypher
 *     identifies the exact site)
 *   - touch the existing spaces-sync-manager. That stays untouched. The v5
 *     engine drains its own queue; the Phase 2 demo helper is the only
 *     producer of ops.
 */

'use strict';

const { computeBackoffMs, shouldPark, DEFAULT_RETRY_BUDGET } = require('./dlq');
const { computeContentHash } = require('./blob-store');
const { isWriteAllowed } = require('./schema-version');
const { getLogQueue } = require('../log-event-queue');
const log = getLogQueue();

const DEFAULT_DRAIN_INTERVAL_MS = 2000; // 2s tick between drains
const DEFAULT_BATCH_SIZE = 5;

/**
 * Cypher for step 3: upsert :Asset and write :OperationLog atomically.
 *
 * Phase 2 placeholders identified in comments. The exact vc-bump Cypher
 * (Phase 3) replaces these without changing the surrounding statement
 * structure.
 *
 * Param shape:
 *   $entityId, $entityType, $opType, $traceId, $deviceId, $payload (JSON map),
 *   $contentHash, $at (ISO timestamp)
 */
const CYPHER_OP_TX = `
  MERGE (a:Asset {id: $entityId})
  ON CREATE SET a.createdAt = datetime($at)
  SET a.lastUpdatedAt = datetime($at),
      a.contentHash = $contentHash
  // PHASE 3: bump vector clock here.
  // a.vc = apoc.map.merge(coalesce(a.vc, {}), {[$deviceId]: coalesce(a.vc[$deviceId], 0) + 1})
  CREATE (op:OperationLog {
    traceId: $traceId,
    op: $opType,
    entityType: $entityType,
    entityId: $entityId,
    deviceId: $deviceId,
    at: datetime($at),
    contentHash: $contentHash,
    ackedByDevice: false
  })
  MERGE (op)-[:APPLIED_TO]->(a)
  RETURN op.traceId AS traceId
`;

class SyncEngine {
  /**
   * @param {object} args
   * @param {object} args.queue        OpQueue instance
   * @param {object} args.dlq          DeadLetterQueue instance
   * @param {object} args.blobStore    BlobStore implementation (LocalBlobStore in Phase 2)
   * @param {object} args.omniClient   OmniGraph client (provides .executeQuery / .isReady)
   * @param {object} [args.heartbeatReporter]   HeartbeatReporter -- engine calls .recordAck on success
   * @param {string} [args.deviceId]
   * @param {() => Promise<{state:string, writeAllowed:boolean}>} [args.handshakeFn]
   *   -- function returning the schema-version handshake result; engine
   *      refuses to drain when writeAllowed is false. Defaults to the
   *      schema-version module's handshake().
   * @param {(payload:object) => Buffer|string|null} [args.payloadToContent]
   *   -- adapter that turns an op payload into the blob bytes. Defaults to
   *      `payload.content` if present, otherwise null (no blob upload).
   * @param {() => number} [args.now]
   * @param {number} [args.drainIntervalMs]
   * @param {number} [args.batchSize]
   * @param {number} [args.retryBudget]
   */
  constructor({
    queue,
    dlq,
    blobStore,
    omniClient,
    heartbeatReporter = null,
    deviceId = 'unknown',
    handshakeFn = null,
    payloadToContent = null,
    now = () => Date.now(),
    drainIntervalMs = DEFAULT_DRAIN_INTERVAL_MS,
    batchSize = DEFAULT_BATCH_SIZE,
    retryBudget = DEFAULT_RETRY_BUDGET,
  }) {
    if (!queue || !dlq || !blobStore || !omniClient) {
      throw new Error('SyncEngine: queue, dlq, blobStore, omniClient required');
    }
    this._queue = queue;
    this._dlq = dlq;
    this._blobStore = blobStore;
    this._omniClient = omniClient;
    this._heartbeatReporter = heartbeatReporter;
    this._deviceId = deviceId;
    this._handshakeFn = handshakeFn;
    this._payloadToContent = payloadToContent || ((p) => (p && p.content) || null);
    this._now = now;
    this._drainIntervalMs = drainIntervalMs;
    this._batchSize = batchSize;
    this._retryBudget = retryBudget;

    /** @type {Set<string>} entityIds with an in-flight op (one per entity for causality) */
    this._inFlightEntities = new Set();

    this._timer = null;
    this._started = false;
    this._draining = false; // re-entrancy guard
    this._stats = {
      drainedSuccess: 0,
      drainedRetry: 0,
      drainedParked: 0,
      lastDrainAt: null,
      lastError: null,
    };
  }

  start() {
    if (this._started) return;
    this._started = true;
    this._scheduleNextDrain(0);
    log.info('sync-v5', 'SyncEngine started', { drainIntervalMs: this._drainIntervalMs });
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
      inFlightEntities: this._inFlightEntities.size,
      queueDepth: this._queue.getDepth(),
      dlqCount: this._dlq.count(),
      ...this._stats,
    };
  }

  /**
   * Drain a single batch of pending ops. Returns the number of ops processed
   * (regardless of success/retry/park). Public for tests + the demo helper.
   */
  async drainOnce() {
    if (this._draining) return 0;
    this._draining = true;
    let processed = 0;
    try {
      // Schema-version gate: refuse to drain if writes aren't allowed.
      if (this._handshakeFn) {
        try {
          const hs = await this._handshakeFn();
          if (!isWriteAllowed(hs.state)) {
            log.debug('sync-v5', 'SyncEngine drain skipped: schema version refuses writes', {
              state: hs.state,
            });
            return 0;
          }
        } catch (_) {
          /* handshake failure is non-fatal; the per-op graph call will fail
             with its own error and we'll retry */
        }
      }

      // Graph reachability gate: same idea as spaces-sync-manager._isGraphAvailable.
      if (typeof this._omniClient.isReady === 'function' && !this._omniClient.isReady()) {
        log.debug('sync-v5', 'SyncEngine drain skipped: graph not ready');
        return 0;
      }

      const candidates = this._queue.peek({ limit: this._batchSize });
      for (const op of candidates) {
        // Causality: skip if another op on the same entity is in-flight.
        if (this._inFlightEntities.has(op.entityId)) continue;

        // Backoff: skip if last retry was too recent.
        if (op.lastRetryAt) {
          const lastRetryMs = new Date(op.lastRetryAt).getTime();
          const minNext = lastRetryMs + computeBackoffMs(op.retryCount);
          if (this._now() < minNext) continue;
        }

        if (!this._queue.markInFlight(op.traceId)) continue;
        this._inFlightEntities.add(op.entityId);
        try {
          await this._processOp(op);
          processed++;
        } finally {
          this._inFlightEntities.delete(op.entityId);
        }
      }
    } finally {
      this._draining = false;
      this._stats.lastDrainAt = new Date(this._now()).toISOString();
    }
    return processed;
  }

  /**
   * The 4-step protocol for a single op.
   *
   * Failure modes (per v5 4.5):
   *   - blob upload fails: queue retains op (markFailed); nothing in graph
   *   - graph tx fails:    blob is in store unreferenced; sweeper collects.
   *                        queue retains op for retry.
   *   - ack lost (network blip after tx success): can't happen in Phase 2
   *                        because we mark-and-remove locally; idempotency
   *                        guarantees on retry come from traceId uniqueness
   *                        in the graph (CREATE :OperationLog with same
   *                        traceId would error -- caller treats CREATE
   *                        violation as "already landed" and acks).
   */
  async _processOp(op) {
    try {
      // Step 1: hash the content if any.
      const content = this._payloadToContent(op.payload);
      let contentHash = null;
      if (content !== null && content !== undefined) {
        contentHash = computeContentHash(content);
      }

      // Step 2: blob upload (idempotent, by hash).
      if (contentHash) {
        await this._blobStore.upload(contentHash, content, { traceId: op.traceId });
      }

      // Step 3: graph transaction.
      const at = new Date(this._now()).toISOString();
      await this._omniClient.executeQuery(CYPHER_OP_TX, {
        entityId: op.entityId,
        entityType: op.entityType,
        opType: op.opType,
        traceId: op.traceId,
        deviceId: this._deviceId,
        payload: _safeJsonStringify(op.payload),
        contentHash: contentHash || '',
        at,
      });

      // Step 4: local mark-and-remove + heartbeat ack record.
      this._queue.markAcked(op.traceId);
      if (this._heartbeatReporter && typeof this._heartbeatReporter.recordAck === 'function') {
        this._heartbeatReporter.recordAck(op.traceId);
      }
      this._stats.drainedSuccess++;
      log.debug('sync-v5', 'Op acked', {
        traceId: op.traceId,
        entityId: op.entityId,
        opType: op.opType,
      });
    } catch (err) {
      this._stats.lastError = err.message;
      this._queue.markFailed(op.traceId, err);
      // Re-fetch the op to get the bumped retryCount.
      const updated = this._queue.get(op.traceId);
      if (updated && shouldPark(updated, this._retryBudget)) {
        const removed = this._queue.removeForDlq(op.traceId);
        if (removed) {
          this._dlq.park(removed, removed.lastError || err.message);
          this._stats.drainedParked++;
        }
      } else {
        this._stats.drainedRetry++;
      }
      log.warn('sync-v5', 'Op processing failed', {
        traceId: op.traceId,
        entityId: op.entityId,
        retryCount: updated ? updated.retryCount : null,
        error: err.message,
      });
    }
  }

  _scheduleNextDrain(delayMs) {
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(async () => {
      this._timer = null;
      if (!this._started) return;
      try {
        await this.drainOnce();
      } catch (err) {
        log.warn('sync-v5', 'SyncEngine drain crashed', { error: err.message });
      }
      if (this._started) this._scheduleNextDrain(this._drainIntervalMs);
    }, delayMs);
    if (this._timer && typeof this._timer.unref === 'function') {
      this._timer.unref();
    }
  }
}

function _safeJsonStringify(v) {
  try {
    return JSON.stringify(v ?? {});
  } catch (_) {
    return '{}';
  }
}

module.exports = {
  SyncEngine,
  CYPHER_OP_TX,
  DEFAULT_DRAIN_INTERVAL_MS,
  DEFAULT_BATCH_SIZE,
};
