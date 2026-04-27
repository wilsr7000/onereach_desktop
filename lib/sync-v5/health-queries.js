/**
 * Graph-side health queries (v5 Section 5.4)
 *
 * Five canned Cypher queries that operators run against the tenant's graph
 * to answer the questions a multi-device causal-sync system actually
 * generates:
 *
 *   1. activeConflicts         -- entities with unresolved :CONFLICT edges
 *   2. opsLandedButNotAcked    -- :OperationLog rows older than 1h that no
 *                                 device has confirmed via heartbeat
 *   3. dlqAggregate            -- per-device DLQ depth, derived from latest
 *                                 heartbeat per device
 *   4. schemaVersionDistribution -- which schema versions are deployed across
 *                                   the fleet
 *   5. stuckDevices            -- devices whose latest heartbeat is past the
 *                                 class-aware staleness threshold
 *
 * Phase 1 ships the queries as constants and an executor helper. The
 * `:OperationLog`, `:Heartbeat`, and `:Asset.CONFLICT` shapes referenced here
 * land in Phase 2 and Phase 3 respectively. Until those phases ship, these
 * queries return empty result sets -- correctly, since there's no data yet.
 *
 * No data assumptions are baked in: the queries are written to handle empty
 * graphs gracefully so the diagnostics endpoints in 5.3 can be live in
 * Phase 1 without lying about state.
 */

'use strict';

const { getLogQueue } = require('../log-event-queue');
const log = getLogQueue();

// ────────────────────────────────────────────────────────────────────────────
// Cypher constants
// ────────────────────────────────────────────────────────────────────────────

const CYPHER_ACTIVE_CONFLICTS = `
  MATCH (a:Asset)-[r:CONFLICT]-(b:Asset)
  WHERE id(a) < id(b)
  RETURN a.id AS leftId,
         b.id AS rightId,
         a.title AS leftTitle,
         b.title AS rightTitle,
         r.detectedAt AS detectedAt
  ORDER BY r.detectedAt DESC
  LIMIT $limit
`;

const CYPHER_OPS_LANDED_NOT_ACKED = `
  MATCH (op:OperationLog)
  WHERE op.at < datetime() - duration('PT1H')
    AND coalesce(op.ackedByDevice, false) = false
  RETURN op.traceId AS traceId,
         op.deviceId AS deviceId,
         op.op AS opType,
         op.at AS at
  ORDER BY op.at DESC
  LIMIT $limit
`;

const CYPHER_DLQ_AGGREGATE = `
  MATCH (h:Heartbeat)
  WITH h.deviceId AS d, max(h.at) AS latest
  MATCH (h2:Heartbeat {deviceId: d, at: latest})
  WHERE h2.dlqCount > 0
  RETURN d AS deviceId,
         h2.deviceClass AS deviceClass,
         h2.dlqCount AS dlqCount,
         h2.oldestParkedAt AS oldestParkedAt,
         latest AS lastHeartbeatAt
  ORDER BY h2.dlqCount DESC
  LIMIT $limit
`;

const CYPHER_SCHEMA_VERSION_DISTRIBUTION = `
  MATCH (h:Heartbeat)
  WITH h.deviceId AS d, max(h.at) AS latest
  MATCH (h2:Heartbeat {deviceId: d, at: latest})
  RETURN h2.schemaVersion AS schemaVersion,
         count(*) AS deviceCount
  ORDER BY h2.schemaVersion
`;

/**
 * Stuck-devices query, class-aware (v5 5.4):
 *   - active devices: stale if past expectedNextHeartbeatBy + 1m
 *   - desktop sleeping: stale if at + 30m < now
 *   - mobile sleeping: stale if at + $mobileSleepDuration < now
 *
 * The mobile staleness window is parameterised so tenants with iOS-heavy
 * fleets can configure (default: 7 days).
 */
const CYPHER_STUCK_DEVICES = `
  MATCH (h:Heartbeat)
  WITH h.deviceId AS d, max(h.at) AS latestAt
  MATCH (h2:Heartbeat {deviceId: d, at: latestAt})
  WHERE
    (h2.expectedNextHeartbeatBy IS NOT NULL
      AND h2.expectedNextHeartbeatBy + duration('PT1M') < datetime())
    OR (h2.expectedNextHeartbeatBy IS NULL
      AND h2.deviceClass = 'desktop'
      AND h2.at + duration('PT30M') < datetime())
    OR (h2.expectedNextHeartbeatBy IS NULL
      AND h2.deviceClass = 'mobile'
      AND h2.at + duration($mobileSleepDuration) < datetime())
  RETURN d AS deviceId,
         h2.deviceClass AS deviceClass,
         latestAt AS lastHeartbeatAt,
         h2.expectedNextHeartbeatBy AS expectedNextHeartbeatBy
  ORDER BY latestAt
  LIMIT $limit
`;

const QUERIES = Object.freeze({
  activeConflicts: { cypher: CYPHER_ACTIVE_CONFLICTS, defaults: { limit: 100 } },
  opsLandedNotAcked: { cypher: CYPHER_OPS_LANDED_NOT_ACKED, defaults: { limit: 100 } },
  dlqAggregate: { cypher: CYPHER_DLQ_AGGREGATE, defaults: { limit: 100 } },
  schemaVersionDistribution: { cypher: CYPHER_SCHEMA_VERSION_DISTRIBUTION, defaults: {} },
  stuckDevices: {
    cypher: CYPHER_STUCK_DEVICES,
    defaults: { limit: 100, mobileSleepDuration: 'P7D' },
  },
});

// ────────────────────────────────────────────────────────────────────────────
// Executor
// ────────────────────────────────────────────────────────────────────────────

/**
 * Run a named health query.
 *
 * @param {keyof QUERIES} queryName
 * @param {object} [params={}] -- merged on top of defaults
 * @param {object} [opts]
 * @param {object} [opts.omniClient] -- test override
 * @returns {Promise<{name:string, rows:object[], error:string|null}>}
 */
async function runHealthQuery(queryName, params = {}, opts = {}) {
  const def = QUERIES[queryName];
  if (!def) {
    return { name: queryName, rows: [], error: `Unknown query: ${queryName}` };
  }
  const omniClient = _resolveOmniClient(opts.omniClient);
  if (!omniClient) {
    return { name: queryName, rows: [], error: 'OmniGraph client unavailable' };
  }
  if (typeof omniClient.isReady === 'function' && !omniClient.isReady()) {
    return { name: queryName, rows: [], error: 'Graph not configured (Neo4j password unset?)' };
  }
  const merged = { ...def.defaults, ...params };
  try {
    const rows = await omniClient.executeQuery(def.cypher, merged);
    return { name: queryName, rows: Array.isArray(rows) ? rows : [], error: null };
  } catch (err) {
    log.warn('sync-v5', 'Health query failed', { queryName, error: err.message });
    return { name: queryName, rows: [], error: err.message };
  }
}

/**
 * Run all five canned queries in parallel for a "fleet snapshot."
 *
 * @param {object} [opts]
 * @param {object} [opts.omniClient]
 * @param {string} [opts.mobileSleepDuration='P7D'] -- ISO 8601 duration override
 * @returns {Promise<{[name:string]: {rows:object[], error:string|null}}>}
 */
async function runFleetHealthSnapshot(opts = {}) {
  const params = opts.mobileSleepDuration
    ? { mobileSleepDuration: opts.mobileSleepDuration }
    : {};
  const queryNames = Object.keys(QUERIES);
  const results = await Promise.all(
    queryNames.map((n) => runHealthQuery(n, params, { omniClient: opts.omniClient }))
  );
  const out = {};
  for (const r of results) {
    out[r.name] = { rows: r.rows, error: r.error };
  }
  return out;
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
  QUERIES,
  CYPHER_ACTIVE_CONFLICTS,
  CYPHER_OPS_LANDED_NOT_ACKED,
  CYPHER_DLQ_AGGREGATE,
  CYPHER_SCHEMA_VERSION_DISTRIBUTION,
  CYPHER_STUCK_DEVICES,
  runHealthQuery,
  runFleetHealthSnapshot,
};
