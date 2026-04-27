/**
 * Local op queue (v5 Section 3 + 4.5)
 *
 * Append-only durable queue of operations awaiting cross-device sync. Each
 * op has a ULID `traceId` (set by the API layer; same ID flows through the
 * blob upload, the graph tx, and the heartbeat ack), a status, and a payload.
 *
 * Storage: JSON file at `userData/sync-v5/op-queue.json`. Atomic writes via
 * tmp-file + rename. Phase 2 deliberately uses a boring storage backend so
 * the protocol is the focus; Phase 3+ can swap to DuckDB / SQLite without
 * changing the public API.
 *
 * Phase 2 scope:
 *   - the OpQueue class with the canonical API
 *   - durable persistence + atomic writes
 *   - status transitions: pending -> in-flight -> {acked (removed) | failed}
 *     -> retry -> ... -> parkToDlq (handed to DLQ module)
 *   - depth + oldest-pending-at observability for the heartbeat protocol
 *
 * Phase 2 explicitly does NOT include:
 *   - integration into the existing spaces-sync-manager write path
 *   - per-item sync-state propagation to the existing UI (that wires when
 *     the materialized replica lands in Phase 3)
 *   - vector clocks (ops carry vcAfter as null in Phase 2; populated in Phase 3)
 *
 * Op shape:
 *   {
 *     traceId,        // ULID, primary key
 *     opType,         // string, e.g. 'asset.upsert', 'asset.delete', 'tag.add'
 *     entityType,     // string, e.g. 'asset', 'space'
 *     entityId,       // ULID for assets, slug for spaces
 *     payload,        // arbitrary JSON-serialisable
 *     status,         // 'pending' | 'in-flight' | 'failed'
 *     createdAt,      // ISO timestamp
 *     retryCount,     // number, for backoff and parkToDlq decision
 *     lastError,      // string | null
 *     lastRetryAt,    // ISO timestamp | null
 *     vcAfter         // null in Phase 2; populated by sync engine in Phase 3
 *   }
 */

'use strict';

const fs = require('fs');
const path = require('path');

const { newTraceId, isValidTraceId } = require('./trace-id');
const { getLogQueue } = require('../log-event-queue');
const log = getLogQueue();

const STATUSES = Object.freeze({
  PENDING: 'pending',
  IN_FLIGHT: 'in-flight',
  FAILED: 'failed',
});

class OpQueue {
  /**
   * @param {object} opts
   * @param {string} [opts.dbPath]   -- absolute path to JSON file. Defaults to
   *                                    userData/sync-v5/op-queue.json.
   * @param {() => number} [opts.now] -- test clock
   */
  constructor(opts = {}) {
    this._path = opts.dbPath || _defaultDbPath();
    this._now = opts.now || (() => Date.now());
    this._loaded = false;
    /** @type {Map<string, object>} */
    this._ops = new Map();
    this._loadFromDisk();
  }

  /**
   * Append a new op to the queue. Returns the assigned traceId.
   *
   * @param {object} args
   * @param {string} args.opType
   * @param {string} args.entityType
   * @param {string} args.entityId
   * @param {object} [args.payload]
   * @param {string} [args.traceId] -- override (test only or upstream ID)
   * @returns {string} traceId
   */
  enqueue({ opType, entityType, entityId, payload = {}, traceId }) {
    if (!opType || typeof opType !== 'string') throw new Error('enqueue: opType required');
    if (!entityType || typeof entityType !== 'string') throw new Error('enqueue: entityType required');
    if (!entityId || typeof entityId !== 'string') throw new Error('enqueue: entityId required');

    const id = traceId || newTraceId(this._now());
    if (!isValidTraceId(id)) throw new Error(`enqueue: invalid traceId ${id}`);
    if (this._ops.has(id)) throw new Error(`enqueue: duplicate traceId ${id}`);

    const op = {
      traceId: id,
      opType,
      entityType,
      entityId,
      payload,
      status: STATUSES.PENDING,
      createdAt: new Date(this._now()).toISOString(),
      retryCount: 0,
      lastError: null,
      lastRetryAt: null,
      vcAfter: null,
    };
    this._ops.set(id, op);
    this._flush();
    return id;
  }

  /**
   * Return up to `limit` pending ops in oldest-first order. Does NOT mutate
   * status; call markInFlight to claim.
   *
   * @param {object} [opts]
   * @param {number} [opts.limit=10]
   * @returns {object[]}
   */
  peek({ limit = 10 } = {}) {
    const out = [];
    for (const op of this._ops.values()) {
      if (op.status === STATUSES.PENDING) out.push(op);
      if (out.length >= limit) break;
    }
    out.sort((a, b) => a.traceId.localeCompare(b.traceId)); // ULID = lex-sortable by time
    return out.slice(0, limit);
  }

  /**
   * Atomically transition an op from pending -> in-flight. Returns true if
   * the transition succeeded (and the caller now "owns" the op), false if
   * the op was already in flight or no longer in the queue.
   *
   * @param {string} traceId
   * @returns {boolean}
   */
  markInFlight(traceId) {
    const op = this._ops.get(traceId);
    if (!op) return false;
    if (op.status !== STATUSES.PENDING) return false;
    op.status = STATUSES.IN_FLIGHT;
    this._flush();
    return true;
  }

  /**
   * Mark an op as successfully acked. Removes it from the queue. Idempotent
   * (calling with an already-removed traceId is a no-op).
   *
   * @param {string} traceId
   * @returns {boolean} true if removed, false if it wasn't there
   */
  markAcked(traceId) {
    const had = this._ops.delete(traceId);
    if (had) this._flush();
    return had;
  }

  /**
   * Mark an op as failed (back to pending for retry). Increments retryCount
   * and records the error. Caller decides whether to park to DLQ based on
   * retryCount.
   *
   * @param {string} traceId
   * @param {Error|string} error
   * @returns {boolean} true if updated, false if the op no longer exists
   */
  markFailed(traceId, error) {
    const op = this._ops.get(traceId);
    if (!op) return false;
    op.status = STATUSES.PENDING; // back to pending for retry by the engine
    op.retryCount = (op.retryCount || 0) + 1;
    op.lastError = typeof error === 'string' ? error : error?.message || 'unknown';
    op.lastRetryAt = new Date(this._now()).toISOString();
    this._flush();
    return true;
  }

  /**
   * Remove an op from the queue (used by the DLQ module after parking).
   * Caller is responsible for moving the op to the DLQ first.
   *
   * @param {string} traceId
   * @returns {object|null} the removed op (so DLQ can park it), or null
   */
  removeForDlq(traceId) {
    const op = this._ops.get(traceId);
    if (!op) return null;
    this._ops.delete(traceId);
    this._flush();
    return op;
  }

  /**
   * Look up a single op without mutation. Used by the diagnostics
   * `/sync/trace/:id` endpoint.
   *
   * @param {string} traceId
   * @returns {object|null}
   */
  get(traceId) {
    return this._ops.get(traceId) || null;
  }

  /**
   * @returns {number} number of pending + in-flight ops
   */
  getDepth() {
    return this._ops.size;
  }

  /**
   * @returns {string|null} ISO timestamp of the oldest pending op, or null if empty
   */
  getOldestPendingAt() {
    let oldest = null;
    for (const op of this._ops.values()) {
      if (op.status !== STATUSES.PENDING) continue;
      if (!oldest || op.createdAt < oldest) oldest = op.createdAt;
    }
    return oldest;
  }

  /**
   * Snapshot for diagnostics-endpoints provider. Mirrors the shape Phase 1
   * stubbed out:
   *   { depth, oldest: {traceId, createdAt, opType, entityId} | null,
   *     inFlight: same shape | null }
   */
  inspect() {
    let oldestPending = null;
    let inFlight = null;
    for (const op of this._ops.values()) {
      if (op.status === STATUSES.PENDING) {
        if (!oldestPending || op.createdAt < oldestPending.createdAt) {
          oldestPending = op;
        }
      } else if (op.status === STATUSES.IN_FLIGHT) {
        if (!inFlight || op.createdAt < inFlight.createdAt) {
          inFlight = op;
        }
      }
    }
    return {
      depth: this._ops.size,
      oldest: oldestPending
        ? {
            traceId: oldestPending.traceId,
            createdAt: oldestPending.createdAt,
            opType: oldestPending.opType,
            entityId: oldestPending.entityId,
          }
        : null,
      inFlight: inFlight
        ? {
            traceId: inFlight.traceId,
            createdAt: inFlight.createdAt,
            opType: inFlight.opType,
            entityId: inFlight.entityId,
          }
        : null,
    };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Persistence: simple atomic JSON writes via tmp + rename.
  //
  // For Phase 2 scope this is sufficient -- a few hundred ops/day on a
  // personal device. Phase 3+ may swap to DuckDB or SQLite for better
  // concurrent access patterns; the public API stays identical.
  // ──────────────────────────────────────────────────────────────────────────

  _loadFromDisk() {
    if (this._loaded) return;
    try {
      if (fs.existsSync(this._path)) {
        const raw = fs.readFileSync(this._path, 'utf8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed.ops)) {
          for (const op of parsed.ops) {
            if (isValidTraceId(op.traceId)) {
              // On reload, reset any in-flight ops to pending. The previous
              // run crashed mid-flight; the engine will retry with idempotent
              // semantics (graph upsert + traceId is idempotent in v5).
              if (op.status === STATUSES.IN_FLIGHT) {
                op.status = STATUSES.PENDING;
              }
              this._ops.set(op.traceId, op);
            }
          }
        }
      }
    } catch (err) {
      log.warn('sync-v5', 'OpQueue load failed; starting empty', {
        error: err.message,
        path: this._path,
      });
    }
    this._loaded = true;
  }

  _flush() {
    try {
      fs.mkdirSync(path.dirname(this._path), { recursive: true });
      const tmp = `${this._path}.tmp`;
      const data = JSON.stringify(
        { version: 1, ops: Array.from(this._ops.values()) },
        null,
        2
      );
      fs.writeFileSync(tmp, data, 'utf8');
      fs.renameSync(tmp, this._path);
    } catch (err) {
      log.warn('sync-v5', 'OpQueue flush failed', { error: err.message, path: this._path });
    }
  }
}

function _defaultDbPath() {
  try {
    const { app } = require('electron');
    if (app && typeof app.getPath === 'function') {
      return path.join(app.getPath('userData'), 'sync-v5', 'op-queue.json');
    }
  } catch (_) {
    /* not in electron context (tests) */
  }
  return path.join(require('os').tmpdir(), 'sync-v5-test', 'op-queue.json');
}

module.exports = {
  OpQueue,
  STATUSES,
};
