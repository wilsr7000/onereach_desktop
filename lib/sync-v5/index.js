/**
 * Spaces + Neo4j (NEON) Source-of-Truth Architecture v5
 *
 * This barrel re-exports the foundational modules for the v5 architecture.
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
 * Phase 2 still excludes: vector clocks (Phase 3), conflict UI (Phase 3),
 * snapshots / audit-log retention (Phase 4), schema migration tooling (Phase 5).
 * The existing spaces-sync-manager is untouched in Phase 2.
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
};
