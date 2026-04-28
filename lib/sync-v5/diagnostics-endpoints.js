/**
 * Diagnostics endpoints for v5 sync observability (v5 Section 5.3 + 5.4)
 *
 * Three new HTTP routes exposed on the existing log server (port 47292):
 *
 *   GET /sync/queue      -- queue depth, oldest pending op, current in-flight,
 *                           heartbeat reporter snapshot, schema version state
 *   GET /sync/dlq        -- dead-letter queue contents and metadata
 *   GET /sync/trace/:id  -- timeline for a single trace ID:
 *                           queue insert -> blob upload -> graph tx -> heartbeat ack
 *   GET /sync/health     -- fleet health snapshot (runs all 5 canned queries)
 *
 * Phase 1 ships the route handlers as pure functions wired into log-server.js.
 * They report what's available today (handshake, heartbeat reporter inspect,
 * graph queries) and return empty/zero values for components that ship later
 * (queue, DLQ, traceId timeline). The endpoints don't lie -- they say
 * `phase: 'phase-1'` so callers know what's not yet wired.
 *
 * Phase 2 will replace the queue/DLQ stubs with real values from the local
 * SQLite op queue + DLQ tables. The endpoint surface stays identical so
 * tests written against Phase 1 keep passing.
 */

'use strict';

const { handshake } = require('./schema-version');
const { runHealthQuery, runFleetHealthSnapshot } = require('./health-queries');
const { getDeviceId, getDeviceClass, getDeviceCreatedAt } = require('./device-identity');
const { getLogQueue } = require('../log-event-queue');
const log = getLogQueue();

const PHASE = 'phase-1';

// ────────────────────────────────────────────────────────────────────────────
// Pluggable providers
// ────────────────────────────────────────────────────────────────────────────
// Phase 2 will register real providers here when the queue + DLQ exist.
// Phase 1 returns null/empty so endpoints don't fabricate data.

const providers = {
  /** @type {null | (() => {depth:number, oldest:object|null, inFlight:object|null})} */
  queueProvider: null,
  /** @type {null | (() => {count:number, entries:object[], oldestParkedAt:string|null})} */
  dlqProvider: null,
  /** @type {null | ((traceId:string) => Promise<object|null>)} */
  traceLookupProvider: null,
  /** @type {null | object} -- HeartbeatReporter instance with .inspect() */
  heartbeatReporter: null,
  /** @type {null | object} -- Phase 4 ConflictStore instance with .inspect() */
  conflictStore: null,
  /** @type {null | object} -- Phase 4 PullEngine instance with .inspect() */
  pullEngine: null,
};

/**
 * Phase 2 wiring point. Inject the queue / DLQ / trace lookup / heartbeat
 * reporter once they exist. Calling with a partial object overrides only
 * the named providers.
 */
function setProviders(partial) {
  if (!partial || typeof partial !== 'object') return;
  for (const k of Object.keys(providers)) {
    if (k in partial) providers[k] = partial[k];
  }
  log.info('sync-v5', 'diagnostics-endpoints providers updated', {
    queue: !!providers.queueProvider,
    dlq: !!providers.dlqProvider,
    trace: !!providers.traceLookupProvider,
    heartbeat: !!providers.heartbeatReporter,
    conflictStore: !!providers.conflictStore,
    pullEngine: !!providers.pullEngine,
  });
}

/**
 * Reset all providers. Test-only; not used in production.
 */
function _resetProviders() {
  for (const k of Object.keys(providers)) providers[k] = null;
}

// ────────────────────────────────────────────────────────────────────────────
// Route handlers
// Each returns { status, body } so the log-server wrapper can render them
// without coupling the handler to http.IncomingMessage / http.ServerResponse.
// ────────────────────────────────────────────────────────────────────────────

/**
 * GET /sync/queue
 *
 * Returns the local sync state for this device:
 *   - phase, deviceId, deviceClass, deviceCreatedAt
 *   - schema-version handshake result
 *   - heartbeat reporter snapshot (if registered)
 *   - queue state (Phase 2; null in Phase 1)
 */
async function handleSyncQueue() {
  const hs = await handshake();
  let queue = null;
  if (providers.queueProvider) {
    try {
      queue = providers.queueProvider();
    } catch (err) {
      queue = { error: err.message };
    }
  }
  let heartbeat = null;
  if (providers.heartbeatReporter && typeof providers.heartbeatReporter.inspect === 'function') {
    try {
      heartbeat = providers.heartbeatReporter.inspect();
    } catch (err) {
      heartbeat = { error: err.message };
    }
  }
  let conflicts = null;
  if (providers.conflictStore && typeof providers.conflictStore.inspect === 'function') {
    try {
      conflicts = providers.conflictStore.inspect();
    } catch (err) {
      conflicts = { error: err.message };
    }
  }
  let pullEngine = null;
  if (providers.pullEngine && typeof providers.pullEngine.inspect === 'function') {
    try {
      pullEngine = providers.pullEngine.inspect();
    } catch (err) {
      pullEngine = { error: err.message };
    }
  }
  return {
    status: 200,
    body: {
      phase: PHASE,
      device: {
        deviceId: getDeviceId(),
        deviceClass: getDeviceClass(),
        createdAt: getDeviceCreatedAt(),
      },
      schemaVersion: {
        device: hs.deviceVersion,
        graph: hs.graphVersion,
        state: hs.state,
        writeAllowed: hs.writeAllowed,
        apocAvailable: hs.apocAvailable,
        apocVersion: hs.apocVersion,
        banner: hs.banner,
      },
      queue: queue || {
        wired: false,
        note: 'Local op queue is Phase 2 -- no data in Phase 1.',
      },
      heartbeat: heartbeat || {
        wired: false,
        note: 'Heartbeat reporter not yet started (Phase 2 boot wiring).',
      },
      conflicts: conflicts || {
        wired: false,
        note: 'ConflictStore not yet wired (Phase 4 boot wiring).',
      },
      pullEngine: pullEngine || {
        wired: false,
        note: 'PullEngine not yet wired (Phase 4 boot wiring; opt-in via __syncV5.pullEngine.start()).',
      },
    },
  };
}

/**
 * GET /sync/dlq
 *
 * Returns the dead-letter queue contents. Phase 2 will populate; Phase 1
 * reports an empty queue with a `wired: false` flag.
 */
async function handleSyncDlq() {
  if (!providers.dlqProvider) {
    return {
      status: 200,
      body: {
        phase: PHASE,
        wired: false,
        note: 'DLQ is Phase 2 -- no data in Phase 1.',
        count: 0,
        entries: [],
      },
    };
  }
  try {
    const r = providers.dlqProvider();
    return {
      status: 200,
      body: {
        phase: PHASE,
        wired: true,
        count: Number(r?.count) || 0,
        oldestParkedAt: r?.oldestParkedAt || null,
        entries: Array.isArray(r?.entries) ? r.entries : [],
      },
    };
  } catch (err) {
    return { status: 500, body: { error: err.message } };
  }
}

/**
 * GET /sync/trace/:id
 *
 * Looks up a single trace ID across (a) the local op queue, (b) the DLQ,
 * (c) the graph's :OperationLog, and (d) the latest :Heartbeat.ackedTraceIds
 * to construct an end-to-end timeline.
 *
 * Phase 1: only the graph-side lookup is wired. Local-side timeline is
 * empty until the queue exists in Phase 2.
 */
async function handleSyncTrace(traceId) {
  if (!traceId || typeof traceId !== 'string' || traceId.length < 10) {
    return {
      status: 400,
      body: { error: 'Invalid trace ID', traceId },
    };
  }

  // Local timeline (Phase 2 will wire this).
  let local = null;
  if (providers.traceLookupProvider) {
    try {
      local = await providers.traceLookupProvider(traceId);
    } catch (err) {
      local = { error: err.message };
    }
  }

  // Graph-side lookup.
  let graph = { found: false, op: null, ackedByDevice: false, ackedAt: null, ackedBy: null };
  try {
    const { runHealthQuery: _runHealthQuery } = require('./health-queries');
    // Inline query rather than adding a 6th canned health query for a single
    // lookup. Same Cypher pattern style.
    const { getOmniGraphClient } = require('../../omnigraph-client');
    const omniClient = getOmniGraphClient();
    if (omniClient && (typeof omniClient.isReady !== 'function' || omniClient.isReady())) {
      const rows = await omniClient.executeQuery(
        `MATCH (op:OperationLog {traceId: $traceId})
         RETURN op.traceId AS traceId,
                op.deviceId AS deviceId,
                op.op AS opType,
                op.at AS at,
                coalesce(op.ackedByDevice, false) AS ackedByDevice,
                op.ackedAt AS ackedAt,
                op.ackedBy AS ackedBy
         LIMIT 1`,
        { traceId }
      );
      if (Array.isArray(rows) && rows.length > 0) {
        const r = rows[0];
        graph = {
          found: true,
          op: { traceId: r.traceId, deviceId: r.deviceId, opType: r.opType, at: r.at },
          ackedByDevice: !!r.ackedByDevice,
          ackedAt: r.ackedAt || null,
          ackedBy: r.ackedBy || null,
        };
      }
    }
    // Acknowledge that runHealthQuery is unused here; left in place to
    // signal the same import path is correct.
    void _runHealthQuery;
  } catch (err) {
    graph = { found: false, error: err.message };
  }

  return {
    status: 200,
    body: {
      phase: PHASE,
      traceId,
      local: local || { wired: false, note: 'Local trace lookup is Phase 2.' },
      graph,
    },
  };
}

/**
 * GET /sync/health
 *
 * Fleet snapshot: runs all 5 canned health queries against the graph and
 * returns combined results. Suitable for an operator dashboard or a CI
 * canary check.
 *
 * @param {URL} url
 */
async function handleSyncHealth(url) {
  const mobileSleepDuration =
    (url && url.searchParams && url.searchParams.get('mobileSleepDuration')) || undefined;
  try {
    const snapshot = await runFleetHealthSnapshot({ mobileSleepDuration });
    return {
      status: 200,
      body: {
        phase: PHASE,
        at: new Date().toISOString(),
        ...snapshot,
      },
    };
  } catch (err) {
    return { status: 500, body: { error: err.message } };
  }
}

/**
 * GET /sync/health/:queryName -- run a single named query.
 */
async function handleSyncHealthOne(queryName, url) {
  const params = {};
  if (url && url.searchParams) {
    for (const [k, v] of url.searchParams) params[k] = v;
  }
  const r = await runHealthQuery(queryName, params);
  if (r.error && /Unknown query/.test(r.error)) {
    return { status: 404, body: { error: r.error, queryName } };
  }
  return {
    status: r.error ? 500 : 200,
    body: { phase: PHASE, name: r.name, count: r.rows.length, rows: r.rows, error: r.error },
  };
}

module.exports = {
  PHASE,
  handleSyncQueue,
  handleSyncDlq,
  handleSyncTrace,
  handleSyncHealth,
  handleSyncHealthOne,
  setProviders,
  _resetProviders,
};
