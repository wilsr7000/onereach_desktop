/**
 * Dead-letter queue (v5 Section 4.7)
 *
 * Holds ops that exhausted retry budget. Decoupled from OpQueue so:
 *   - DLQ entries don't bloat the active queue
 *   - operators can inspect DLQ without scanning live ops
 *   - retry-now / drop actions don't race with the sync engine
 *   - heartbeat reports DLQ state to operators across the fleet
 *
 * Storage: separate JSON file at `userData/sync-v5/op-dlq.json` (atomic
 * writes via tmp + rename, same pattern as OpQueue).
 *
 * DLQ entry shape:
 *   {
 *     traceId,            // ULID, primary key
 *     opType, entityType, entityId, payload, // copied from the OpQueue op
 *     parkedAt,           // ISO timestamp of DLQ admission
 *     cause,              // human-readable reason ('corrupt blob', 'schema refusal', etc.)
 *     retryCount,         // total retries before parking
 *     lastError,          // most recent error message
 *     hasParkedPrecursor  // whether a later op on the same entity is now flagged
 *   }
 *
 * The `hasParkedPrecursor` flag on the OWNING entity (not the DLQ entry) is
 * tracked by the sync engine and projected onto the materialized replica in
 * Phase 3. This module just persists the DLQ.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const { isValidTraceId } = require('./trace-id');
const { getLogQueue } = require('../log-event-queue');
const log = getLogQueue();

const DEFAULT_RETRY_BUDGET = 8; // exponential backoff out to ~24h
const DEFAULT_MAX_BACKOFF_MS = 24 * 60 * 60 * 1000;

class DeadLetterQueue {
  /**
   * @param {object} [opts]
   * @param {string} [opts.dbPath]
   * @param {() => number} [opts.now]
   */
  constructor(opts = {}) {
    this._path = opts.dbPath || _defaultDbPath();
    this._now = opts.now || (() => Date.now());
    /** @type {Map<string, object>} */
    this._entries = new Map();
    this._loaded = false;
    this._loadFromDisk();
  }

  /**
   * Park an op into the DLQ. Returns the DLQ entry.
   *
   * @param {object} op   -- op shape from OpQueue (traceId, opType, etc.)
   * @param {string} cause
   * @returns {object} the parked DLQ entry
   */
  park(op, cause) {
    if (!op || !isValidTraceId(op.traceId)) {
      throw new Error('DLQ.park: op with valid traceId required');
    }
    const entry = {
      traceId: op.traceId,
      opType: op.opType,
      entityType: op.entityType,
      entityId: op.entityId,
      payload: op.payload,
      parkedAt: new Date(this._now()).toISOString(),
      cause: cause || op.lastError || 'unknown',
      retryCount: op.retryCount || 0,
      lastError: op.lastError || null,
    };
    this._entries.set(op.traceId, entry);
    this._flush();
    log.warn('sync-v5', 'Op parked to DLQ', {
      traceId: op.traceId,
      entityId: op.entityId,
      cause: entry.cause,
      retryCount: entry.retryCount,
    });
    return entry;
  }

  /**
   * Remove an entry from the DLQ. Returns the removed entry (so the caller
   * can re-enqueue it on retry-now).
   *
   * @param {string} traceId
   * @returns {object|null}
   */
  remove(traceId) {
    const e = this._entries.get(traceId);
    if (!e) return null;
    this._entries.delete(traceId);
    this._flush();
    return e;
  }

  /**
   * @returns {number}
   */
  count() {
    return this._entries.size;
  }

  /**
   * @returns {string|null} ISO timestamp of oldest parked entry
   */
  oldestParkedAt() {
    let oldest = null;
    for (const e of this._entries.values()) {
      if (!oldest || e.parkedAt < oldest) oldest = e.parkedAt;
    }
    return oldest;
  }

  /**
   * @param {object} [opts]
   * @param {number} [opts.limit=100]
   * @returns {object[]}
   */
  list({ limit = 100 } = {}) {
    return Array.from(this._entries.values())
      .sort((a, b) => a.parkedAt.localeCompare(b.parkedAt))
      .slice(0, limit);
  }

  /**
   * Look up an entry without removing.
   * @param {string} traceId
   * @returns {object|null}
   */
  get(traceId) {
    return this._entries.get(traceId) || null;
  }

  /**
   * Snapshot for the diagnostics provider (and the heartbeat report).
   * Mirrors the shape Phase 1 stubbed out: `{ count, oldestParkedAt, entries }`.
   */
  inspect() {
    return {
      count: this.count(),
      oldestParkedAt: this.oldestParkedAt(),
      entries: this.list({ limit: 100 }),
    };
  }

  /**
   * Snapshot for the heartbeat reporter's dlqStateProvider hook.
   * Returns just the two fields that go in the heartbeat shape.
   *
   * @returns {{dlqCount:number, oldestParkedAt:string|null}}
   */
  toHeartbeatState() {
    return {
      dlqCount: this.count(),
      oldestParkedAt: this.oldestParkedAt(),
    };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Persistence
  // ──────────────────────────────────────────────────────────────────────────

  _loadFromDisk() {
    if (this._loaded) return;
    try {
      if (fs.existsSync(this._path)) {
        const raw = fs.readFileSync(this._path, 'utf8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed.entries)) {
          for (const e of parsed.entries) {
            if (isValidTraceId(e.traceId)) this._entries.set(e.traceId, e);
          }
        }
      }
    } catch (err) {
      log.warn('sync-v5', 'DLQ load failed; starting empty', {
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
        { version: 1, entries: Array.from(this._entries.values()) },
        null,
        2
      );
      fs.writeFileSync(tmp, data, 'utf8');
      fs.renameSync(tmp, this._path);
    } catch (err) {
      log.warn('sync-v5', 'DLQ flush failed', { error: err.message, path: this._path });
    }
  }
}

/**
 * Compute the backoff delay for the Nth retry, in milliseconds.
 * Exponential with jitter, capped at MAX_BACKOFF_MS.
 *
 * @param {number} retryCount  0-indexed (first retry uses retryCount=0)
 * @param {number} [maxMs=DEFAULT_MAX_BACKOFF_MS]
 * @param {() => number} [randomFn]  test override
 * @returns {number}
 */
function computeBackoffMs(retryCount, maxMs = DEFAULT_MAX_BACKOFF_MS, randomFn = Math.random) {
  const base = Math.min(1000 * Math.pow(2, retryCount), maxMs);
  // ±20% jitter to avoid thundering herd of retries.
  const jitter = base * 0.2 * (randomFn() * 2 - 1);
  return Math.max(0, Math.round(base + jitter));
}

/**
 * Decide whether an op has exhausted retry budget and should be parked.
 *
 * @param {object} op
 * @param {number} [retryBudget=DEFAULT_RETRY_BUDGET]
 * @returns {boolean}
 */
function shouldPark(op, retryBudget = DEFAULT_RETRY_BUDGET) {
  return (op.retryCount || 0) >= retryBudget;
}

function _defaultDbPath() {
  try {
    const { app } = require('electron');
    if (app && typeof app.getPath === 'function') {
      return path.join(app.getPath('userData'), 'sync-v5', 'op-dlq.json');
    }
  } catch (_) {
    /* not in electron context */
  }
  return path.join(require('os').tmpdir(), 'sync-v5-test', 'op-dlq.json');
}

module.exports = {
  DeadLetterQueue,
  computeBackoffMs,
  shouldPark,
  DEFAULT_RETRY_BUDGET,
  DEFAULT_MAX_BACKOFF_MS,
};
