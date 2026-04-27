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
 *   trace-id          -- ULID generator + X-Trace-Id header helper
 *   schema-version    -- :SchemaVersion handshake + refuse-on-skew gate
 *   device-identity   -- deviceId persistence + deviceClass detection
 *   heartbeat         -- :Heartbeat shape + HeartbeatReporter (lifecycle-aware)
 *   health-queries    -- 5 canned Cypher health queries from v5 Section 5.4
 *   diagnostics-endpoints -- /sync/queue, /sync/dlq, /sync/trace/:id route handlers
 *
 * Phase 1 explicitly excludes: write protocol changes, vector clocks, conflict UI,
 * snapshots, schema migration tooling. Those are Phase 2-5.
 */

'use strict';

module.exports = {
  ...require('./trace-id'),
  ...require('./schema-version'),
  ...require('./device-identity'),
  ...require('./heartbeat'),
  ...require('./health-queries'),
  ...require('./diagnostics-endpoints'),
};
