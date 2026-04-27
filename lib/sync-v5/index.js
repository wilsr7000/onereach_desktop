/**
 * Spaces + Neo4j (NEON) Source-of-Truth Architecture v5 -- Phase 1 scaffold
 *
 * This barrel re-exports the foundational modules for the v5 architecture.
 * Phase 1 is observability + schema-versioning scaffolding only -- it does
 * NOT change behavior of today's spaces-sync-manager. Integration with the
 * write protocol happens in Phase 2.
 *
 * See: /Users/richardwilson/.cursor/plans/spaces_+_neo4j_(neon)_source-of-truth_architecture_review_(v5)_*.plan.md
 *
 * Modules:
 *   Phase 1 (observability + schema-versioning scaffold):
 *     trace-id          -- ULID generator + X-Trace-Id header helper
 *     schema-version    -- :SchemaVersion handshake + refuse-on-skew gate
 *     device-identity   -- deviceId persistence + deviceClass detection
 *     heartbeat         -- :Heartbeat shape + HeartbeatReporter (lifecycle-aware)
 *     health-queries    -- 5 canned Cypher health queries from v5 Section 5.4
 *     diagnostics-endpoints -- /sync/queue, /sync/dlq, /sync/trace/:id handlers
 *
 *   Phase 2 (write protocol scaffold, parallel to existing sync):
 *     op-queue          -- durable JSON-backed local op queue
 *     dlq               -- dead-letter queue with retry-budget logic
 *     blob-store        -- content-addressed blob interface (Local + Noop)
 *     sync-engine       -- 4-step write protocol drainer + heartbeat ack
 *
 *   Phase 3 (causality + conflicts + device rebind, still parallel):
 *     vector-clock      -- algebra: bump, dominates, concurrent, mergeMax
 *     tombstone         -- permanent :Tombstone + no-resurrection check
 *     device-rebind     -- Path A (signed handoff) + Path B (user-attested)
 *     conflict          -- detection + N-way ConflictGroup + ConflictStore
 *
 *   Phase 4 (snapshots + retention + pull engine, still parallel):
 *     snapshot          -- :Snapshot writer + sliding-window compaction +
 *                          op-log retention + materialise(spaceId, at)
 *     pull-engine       -- periodic graph poll + applyRemoteOp wiring +
 *                          tombstone gate + ConflictStore registration
 *
 * Phase 4 still excludes: schema migration tooling (Phase 5), the
 * materialised replica itself (Phase 5+ tooling -- the pull engine takes
 * localApplyFn + localLookupFn as injected callbacks). The existing
 * spaces-sync-manager is untouched.
 *
 * Note: vector-clock and conflict export some short names (e.g. `bump`,
 * `equals`, `concurrent`) that are too generic to spread into the barrel
 * directly. Phase 3+ exports the modules under namespaces (vc, conflict,
 * snapshot, pullEngine) to avoid collisions; Phase 1/2 exports stay flat
 * for backward compat with tests written against the original API.
 */

'use strict';

module.exports = {
  // Phase 1
  ...require('./trace-id'),
  ...require('./schema-version'),
  ...require('./device-identity'),
  ...require('./heartbeat'),
  ...require('./health-queries'),
  ...require('./diagnostics-endpoints'),
  // Phase 2
  ...require('./op-queue'),
  ...require('./dlq'),
  ...require('./blob-store'),
  ...require('./sync-engine'),
  // Phase 3+ (namespaced to avoid generic-name collisions)
  vc: require('./vector-clock'),
  tombstone: require('./tombstone'),
  deviceRebind: require('./device-rebind'),
  conflict: require('./conflict'),
  // Phase 4
  snapshot: require('./snapshot'),
  pullEngine: require('./pull-engine'),
};
