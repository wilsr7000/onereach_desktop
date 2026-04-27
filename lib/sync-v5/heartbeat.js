/**
 * Device heartbeat protocol (v5 Section 5.2)
 *
 * The graph cannot directly observe device state. The heartbeat is the single
 * channel by which devices report state to the graph in batches, replacing
 * both per-op ACK edges and a separate DLQ heartbeat with one channel.
 *
 * Heartbeat shape (v5):
 *   {
 *     deviceId,                       // ULID
 *     deviceClass,                    // 'desktop' | 'mobile'
 *     at,                             // wall clock when heartbeat sent
 *     expectedNextHeartbeatBy,        // timestamp | null
 *     ackedTraceIds: [...],
 *     dlqCount,
 *     oldestParkedAt,                 // ISO 8601 | null
 *     schemaVersion,
 *     queueDepth,
 *     replicaSpaceCount,
 *     preserveUntil                   // operator forensic flag, null normally
 *   }
 *
 * Cadence:
 *   - active heartbeat: every 5 min OR after every 100 acked ops, with
 *     expectedNextHeartbeatBy = at + 6m
 *   - going-to-sleep: immediate; expectedNextHeartbeatBy = null
 *   - wake-up: immediate; resumes active cadence
 *
 * Phase 1 ships:
 *   - the HeartbeatReporter class and its lifecycle hooks (onActiveTick,
 *     onGoingToSleep, onWakeup)
 *   - the recordAck() and recordDlqUpdate() collectors
 *   - the flush() method that writes a :Heartbeat node via the OmniGraph client
 *   - the canonical Cypher for write + denormalisation of acked traceIds onto
 *     :OperationLog nodes
 *
 * Phase 1 does NOT ship:
 *   - auto-start of the timer in production. The reporter must be explicitly
 *     started by Phase 2 once write protocol exists. Calling .start() in tests
 *     is fine.
 *   - integration with electron-powermonitor for desktop sleep/wake. Wired
 *     in Phase 2 alongside the queue.
 *   - iOS lifecycle hooks. Mobile clients call onGoingToSleep / onWakeup
 *     themselves via the iOS bridge.
 */

'use strict';

const { newTraceId } = require('./trace-id');
const { DEVICE_CLASS, getDeviceId, getDeviceClass } = require('./device-identity');
const { getCompiledInVersion } = require('./schema-version');
const { getLogQueue } = require('../log-event-queue');
const log = getLogQueue();

const ACTIVE_TICK_INTERVAL_MS = 5 * 60 * 1000; // 5 min
const ACK_BURST_THRESHOLD = 100;
const ACTIVE_NEXT_GRACE_MS = 6 * 60 * 1000; // expectedNextHeartbeatBy = at + 6 min (5m + 1m grace)

// Staleness thresholds (used by health-queries.js, exported here for test parity)
const STALENESS_MS = Object.freeze({
  ACTIVE_GRACE: 60 * 1000, // 1 min after expectedNextHeartbeatBy
  DESKTOP_SLEEP: 30 * 60 * 1000, // 30 min if expectedNext is null
  MOBILE_SLEEP: 7 * 24 * 60 * 60 * 1000, // 7 days if expectedNext is null
});

// ────────────────────────────────────────────────────────────────────────────
// Cypher constants
// ────────────────────────────────────────────────────────────────────────────

/**
 * Write a :Heartbeat node. Also denormalises ackedTraceIds onto the
 * corresponding :OperationLog nodes by setting op.ackedByDevice = true,
 * which makes "ops landed but never acked" cheap to query in 5.4.
 *
 * Param shape:
 *   $deviceId, $deviceClass, $at (ISO 8601), $expectedNextHeartbeatBy (ISO|null),
 *   $ackedTraceIds [string], $dlqCount, $oldestParkedAt (ISO|null),
 *   $schemaVersion, $queueDepth, $replicaSpaceCount, $preserveUntil (ISO|null)
 *
 * Note: this single statement performs (a) the heartbeat write and (b) the
 * denormalisation pass, in one round trip. For very large ack batches the
 * denormalisation is the cost; consider chunking if ackedTraceIds exceeds
 * a few thousand entries (Phase 2 concern; Phase 1 cap is 100/heartbeat).
 */
const CYPHER_WRITE_HEARTBEAT = `
  CREATE (h:Heartbeat {
    deviceId: $deviceId,
    deviceClass: $deviceClass,
    at: datetime($at),
    expectedNextHeartbeatBy: CASE WHEN $expectedNextHeartbeatBy IS NULL THEN null ELSE datetime($expectedNextHeartbeatBy) END,
    ackedTraceIds: $ackedTraceIds,
    dlqCount: $dlqCount,
    oldestParkedAt: CASE WHEN $oldestParkedAt IS NULL THEN null ELSE datetime($oldestParkedAt) END,
    schemaVersion: $schemaVersion,
    queueDepth: $queueDepth,
    replicaSpaceCount: $replicaSpaceCount,
    preserveUntil: CASE WHEN $preserveUntil IS NULL THEN null ELSE datetime($preserveUntil) END
  })
  WITH h
  UNWIND $ackedTraceIds AS tid
  OPTIONAL MATCH (op:OperationLog {traceId: tid})
  FOREACH (_ IN CASE WHEN op IS NULL THEN [] ELSE [1] END |
    SET op.ackedByDevice = true,
        op.ackedAt = h.at,
        op.ackedBy = h.deviceId
  )
  RETURN h.deviceId AS deviceId, h.at AS at
`;

// ────────────────────────────────────────────────────────────────────────────
// HeartbeatReporter
// ────────────────────────────────────────────────────────────────────────────

class HeartbeatReporter {
  /**
   * @param {object} [opts]
   * @param {string} [opts.deviceId]
   * @param {string} [opts.deviceClass]
   * @param {object} [opts.omniClient]      -- test override
   * @param {object} [opts.settingsManager] -- test override (for deviceId)
   * @param {() => {dlqCount:number, oldestParkedAt:string|null}} [opts.dlqStateProvider]
   * @param {() => number} [opts.queueDepthProvider]
   * @param {() => number} [opts.replicaSpaceCountProvider]
   * @param {() => string|null} [opts.preserveUntilProvider]
   * @param {() => number} [opts.now]       -- test clock
   * @param {number} [opts.activeTickIntervalMs=300000]
   * @param {number} [opts.ackBurstThreshold=100]
   * @param {number} [opts.activeNextGraceMs=360000]
   */
  constructor(opts = {}) {
    this._deviceId = opts.deviceId || getDeviceId({ settingsManager: opts.settingsManager });
    this._deviceClass = opts.deviceClass || getDeviceClass();
    this._omniClient = opts.omniClient || null; // resolve lazily on flush
    this._dlqStateProvider = opts.dlqStateProvider || (() => ({ dlqCount: 0, oldestParkedAt: null }));
    this._queueDepthProvider = opts.queueDepthProvider || (() => 0);
    this._replicaSpaceCountProvider = opts.replicaSpaceCountProvider || (() => 0);
    this._preserveUntilProvider = opts.preserveUntilProvider || (() => null);
    this._now = opts.now || (() => Date.now());

    this._activeTickIntervalMs = opts.activeTickIntervalMs || ACTIVE_TICK_INTERVAL_MS;
    this._ackBurstThreshold = opts.ackBurstThreshold || ACK_BURST_THRESHOLD;
    this._activeNextGraceMs = opts.activeNextGraceMs || ACTIVE_NEXT_GRACE_MS;

    // State accumulated between flushes:
    this._pendingAckedTraceIds = []; // accumulates across outage; never lost
    this._totalAckedSinceLastFlush = 0;

    // Last successful flush:
    this._lastFlushAt = null;
    this._lastFlushError = null;

    // Lifecycle:
    this._timer = null;
    this._isAsleep = false;
    this._started = false;
  }

  /**
   * Begin emitting active heartbeats. Idempotent. The first heartbeat fires
   * immediately and includes a non-null expectedNextHeartbeatBy.
   */
  start() {
    if (this._started) return;
    this._started = true;
    this._isAsleep = false;
    // Immediate first tick so the graph knows the device woke up.
    this._scheduleNextActiveTick(0);
  }

  /**
   * Stop emitting heartbeats. Does NOT send a going-to-sleep heartbeat;
   * call onGoingToSleep first if that's the intent.
   */
  stop() {
    this._started = false;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }

  /**
   * Record a successful ack for a traceId. Triggers a flush if the burst
   * threshold is crossed (default 100 acks). Safe to call even when stopped
   * -- the ack will accumulate and be sent on the next flush.
   *
   * @param {string} traceId
   */
  recordAck(traceId) {
    if (!traceId || typeof traceId !== 'string') return;
    this._pendingAckedTraceIds.push(traceId);
    this._totalAckedSinceLastFlush++;
    if (this._started && !this._isAsleep && this._totalAckedSinceLastFlush >= this._ackBurstThreshold) {
      // Burst reached -- fire immediately, then re-schedule the cadence tick.
      this._scheduleNextActiveTick(0);
    }
  }

  /**
   * Lifecycle: device entered background / OS suspend / graceful shutdown.
   * Sends an immediate going-to-sleep heartbeat and stops the active cadence.
   * On wake-up, call onWakeup() to restart.
   */
  async onGoingToSleep() {
    this._isAsleep = true;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    await this._flushOnce({ goingToSleep: true });
  }

  /**
   * Lifecycle: device woke up from background / suspend. Sends an immediate
   * active heartbeat and resumes the cadence.
   */
  async onWakeup() {
    this._isAsleep = false;
    if (!this._started) {
      this._started = true;
    }
    this._scheduleNextActiveTick(0);
  }

  /**
   * Manually trigger a flush. Useful for tests and for "write current state
   * before quit" hooks. Returns the heartbeat that was attempted (whether or
   * not it was successfully written).
   *
   * @param {object} [options]
   * @param {boolean} [options.goingToSleep=false]
   * @returns {Promise<{success:boolean, heartbeat:object, error:Error|null}>}
   */
  async flush(options = {}) {
    return this._flushOnce(options);
  }

  /**
   * Snapshot the current state for diagnostics surfaces (panel, log server).
   * Does not write anything to the graph.
   */
  inspect() {
    return {
      deviceId: this._deviceId,
      deviceClass: this._deviceClass,
      started: this._started,
      isAsleep: this._isAsleep,
      pendingAckCount: this._pendingAckedTraceIds.length,
      lastFlushAt: this._lastFlushAt,
      lastFlushError: this._lastFlushError ? this._lastFlushError.message : null,
      activeTickIntervalMs: this._activeTickIntervalMs,
      ackBurstThreshold: this._ackBurstThreshold,
    };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Internals
  // ──────────────────────────────────────────────────────────────────────────

  _scheduleNextActiveTick(delayMs) {
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(async () => {
      this._timer = null;
      if (!this._started || this._isAsleep) return;
      await this._flushOnce({ goingToSleep: false });
      if (this._started && !this._isAsleep) {
        this._scheduleNextActiveTick(this._activeTickIntervalMs);
      }
    }, delayMs);
    if (this._timer && typeof this._timer.unref === 'function') {
      // Don't keep the Node event loop alive just for the heartbeat.
      this._timer.unref();
    }
  }

  async _flushOnce({ goingToSleep = false } = {}) {
    const heartbeat = this._buildHeartbeat({ goingToSleep });
    let success = false;
    let error = null;
    try {
      const omniClient = this._resolveOmniClient();
      if (!omniClient) {
        throw new Error('OmniGraph client unavailable');
      }
      if (typeof omniClient.isReady === 'function' && !omniClient.isReady()) {
        throw new Error('OmniGraph client not ready (Neo4j unconfigured?)');
      }
      await omniClient.executeQuery(CYPHER_WRITE_HEARTBEAT, heartbeat);
      // ackedTraceIds successfully sent -- clear the local buffer so we don't
      // resend them. This is the "no acks lost across outage" guarantee:
      // we accumulate until written, then atomic-clear.
      this._pendingAckedTraceIds = [];
      this._totalAckedSinceLastFlush = 0;
      this._lastFlushAt = heartbeat.at;
      this._lastFlushError = null;
      success = true;
      log.debug('sync-v5', 'Heartbeat sent', {
        deviceId: heartbeat.deviceId,
        at: heartbeat.at,
        ackCount: heartbeat.ackedTraceIds.length,
        dlqCount: heartbeat.dlqCount,
        goingToSleep,
      });
    } catch (err) {
      error = err;
      this._lastFlushError = err;
      // Per failure-mode spec in 5.2: heartbeats failing to write queue
      // locally. State-fields will be replaced on next flush; ackedTraceIds
      // accumulate so no acks are lost.
      log.warn('sync-v5', 'Heartbeat send failed; will retry on next tick', {
        error: err.message,
        pendingAckCount: this._pendingAckedTraceIds.length,
      });
    }
    return { success, heartbeat, error };
  }

  _buildHeartbeat({ goingToSleep }) {
    const nowMs = this._now();
    const at = new Date(nowMs).toISOString();
    const expectedNext =
      goingToSleep || this._isAsleep ? null : new Date(nowMs + this._activeNextGraceMs).toISOString();

    let dlqCount = 0;
    let oldestParkedAt = null;
    try {
      const dlq = this._dlqStateProvider() || {};
      dlqCount = Number(dlq.dlqCount) || 0;
      oldestParkedAt = dlq.oldestParkedAt || null;
    } catch (_) {
      /* providers must not crash heartbeat */
    }

    let queueDepth = 0;
    try {
      queueDepth = Number(this._queueDepthProvider()) || 0;
    } catch (_) {
      /* same */
    }

    let replicaSpaceCount = 0;
    try {
      replicaSpaceCount = Number(this._replicaSpaceCountProvider()) || 0;
    } catch (_) {
      /* same */
    }

    let preserveUntil = null;
    try {
      preserveUntil = this._preserveUntilProvider() || null;
    } catch (_) {
      /* same */
    }

    return {
      deviceId: this._deviceId,
      deviceClass: this._deviceClass,
      at,
      expectedNextHeartbeatBy: expectedNext,
      ackedTraceIds: [...this._pendingAckedTraceIds],
      dlqCount,
      oldestParkedAt,
      schemaVersion: getCompiledInVersion(),
      queueDepth,
      replicaSpaceCount,
      preserveUntil,
    };
  }

  _resolveOmniClient() {
    if (this._omniClient) return this._omniClient;
    try {
      const { getOmniGraphClient } = require('../../omnigraph-client');
      return getOmniGraphClient();
    } catch (_) {
      return null;
    }
  }
}

/**
 * Factory: create a HeartbeatReporter wired to the standard providers.
 * Used by Phase 2 boot wiring; not auto-started in Phase 1.
 */
function createHeartbeatReporter(opts = {}) {
  return new HeartbeatReporter(opts);
}

/**
 * Compute the staleness state of a given heartbeat snapshot. Used by the
 * "stuck devices" health query to validate locally without a graph round
 * trip, and by tests to assert invariant 12.
 *
 * @param {{deviceClass:string, at:string, expectedNextHeartbeatBy:string|null}} hb
 * @param {number} [nowMs=Date.now()]
 * @param {number} [tenantMobileSleepMs=STALENESS_MS.MOBILE_SLEEP]
 * @returns {{ stale:boolean, reason:string|null }}
 */
function computeStaleness(hb, nowMs = Date.now(), tenantMobileSleepMs = STALENESS_MS.MOBILE_SLEEP) {
  if (!hb || typeof hb !== 'object') {
    return { stale: true, reason: 'no heartbeat' };
  }
  const atMs = new Date(hb.at).getTime();
  if (!Number.isFinite(atMs)) {
    return { stale: true, reason: 'invalid heartbeat.at' };
  }
  if (hb.expectedNextHeartbeatBy) {
    const expectedMs = new Date(hb.expectedNextHeartbeatBy).getTime();
    if (Number.isFinite(expectedMs) && nowMs > expectedMs + STALENESS_MS.ACTIVE_GRACE) {
      return { stale: true, reason: 'past expectedNextHeartbeatBy + 1m grace' };
    }
    return { stale: false, reason: null };
  }
  // expectedNextHeartbeatBy is null -- device is sleeping. Apply class default.
  if (hb.deviceClass === DEVICE_CLASS.DESKTOP) {
    if (nowMs > atMs + STALENESS_MS.DESKTOP_SLEEP) {
      return { stale: true, reason: 'desktop suspended for >30m' };
    }
    return { stale: false, reason: null };
  }
  if (hb.deviceClass === DEVICE_CLASS.MOBILE) {
    if (nowMs > atMs + tenantMobileSleepMs) {
      return { stale: true, reason: 'mobile background for >7d (or tenant override)' };
    }
    return { stale: false, reason: null };
  }
  // Unknown deviceClass: be conservative.
  return { stale: nowMs > atMs + STALENESS_MS.DESKTOP_SLEEP, reason: 'unknown deviceClass' };
}

module.exports = {
  HeartbeatReporter,
  createHeartbeatReporter,
  computeStaleness,
  CYPHER_WRITE_HEARTBEAT,
  ACTIVE_TICK_INTERVAL_MS,
  ACK_BURST_THRESHOLD,
  ACTIVE_NEXT_GRACE_MS,
  STALENESS_MS,
};
