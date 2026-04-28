/**
 * Materialised SQLite replica -- schema DDL.
 *
 * Per docs/sync-v5/replica-shape.md §3 (schema), §6.1 (better-sqlite3),
 * §6B.2 (tenant_id locked-in). This module is intentionally pure data
 * (constants only); no better-sqlite3 import here so the schema can be
 * inspected by tests and tooling without requiring the native binding.
 *
 * Design choices preserved here for future readers:
 *
 *  - **tenant_id baked in from commit A.** Cost asymmetry is real:
 *    8 bytes/row today vs. a Phase-5 weekend migration if added later.
 *    Default value 'default' for single-tenant deployments. Composite
 *    primary keys (tenant_id, id) on items / spaces / smart_folders /
 *    item_tags so the schema is multi-tenant-ready out of the box.
 *
 *  - **FTS5 with porter+unicode61 tokenisation.** Replaces the ad-hoc
 *    fuzzy matcher in clipboard-storage-v2.search. Strict ranking
 *    improvement; cutover release notes will call out the score-shift
 *    explicitly per §6.4.
 *
 *  - **item_tags denormalised join table.** tags.list / listAll /
 *    findItems are common enough that scanning JSON arrays in the
 *    items table is wrong; a join table on (tenant_id, item_id, tag)
 *    is the cheap fix.
 *
 *  - **Soft-delete via active=0 + deleted_at + deleted_by.** Mirrors
 *    the v5 :Tombstone semantics. Tombstoned rows are permanent by
 *    default; a Phase-5 compactor can purge per
 *    syncV5.replica.tombstoneRetentionDays (§6.5).
 *
 *  - **replica_meta key/value table** for migration tooling, cursor
 *    persistence, and last-pull timestamps. Single-row constants
 *    seeded at init() time.
 *
 * The schema version constant SCHEMA_VERSION lives next to the SQL so
 * that any future migration can compare the on-disk replica's
 * replica_meta.schemaVersion against the compiled-in constant before
 * opening the DB for writes.
 */

'use strict';

// ---------------------------------------------------------------------------
// Schema version
// ---------------------------------------------------------------------------

/**
 * Compiled-in schema version. Bump when ANY DDL below changes in a
 * way that requires a migration (column added/removed/renamed,
 * primary key changed, FTS5 schema changed, tokeniser changed).
 *
 * The Replica class refuses to open a DB whose stored schemaVersion is
 * higher than this constant (forward-incompatible) and triggers
 * migration tooling for lower versions.
 */
const SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// DDL constants
// ---------------------------------------------------------------------------

/**
 * Spaces table: one row per :Space.
 *
 * tenant_id is part of the composite primary key. is_system,
 * active are integer flags (SQLite has no native BOOLEAN). vc is a
 * JSON-encoded VectorClock (e.g. '{"deviceA":3,"deviceB":1}').
 */
const DDL_SPACES = `
  CREATE TABLE IF NOT EXISTS spaces (
    tenant_id TEXT NOT NULL DEFAULT 'default',
    id TEXT NOT NULL,
    name TEXT NOT NULL,
    icon TEXT,
    color TEXT,
    is_system INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    vc TEXT NOT NULL DEFAULT '{}',
    active INTEGER NOT NULL DEFAULT 1,
    deleted_at TEXT,
    deleted_by TEXT,
    PRIMARY KEY (tenant_id, id)
  );
`;

const DDL_SPACES_INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_spaces_active ON spaces(tenant_id, active);`,
  `CREATE INDEX IF NOT EXISTS idx_spaces_updated_at ON spaces(tenant_id, updated_at DESC);`,
];

/**
 * Items table: one row per :Asset.
 *
 * Mirrors clipboard-storage-v2.js DuckDB schema with v5 additions:
 *   - vc: JSON-encoded VectorClock (causality)
 *   - content_hash: SHA-256 reference into the blob store
 *   - active / deleted_at / deleted_by: soft-delete (tombstone) state
 *   - has_parked_precursor: DLQ flag from the sync engine
 *
 * tenant_id is part of the composite primary key.
 */
const DDL_ITEMS = `
  CREATE TABLE IF NOT EXISTS items (
    tenant_id TEXT NOT NULL DEFAULT 'default',
    id TEXT NOT NULL,
    type TEXT NOT NULL,
    space_id TEXT NOT NULL DEFAULT 'unclassified',
    timestamp INTEGER NOT NULL,
    preview TEXT,
    content_path TEXT,
    thumbnail_path TEXT,
    metadata_path TEXT,
    tags TEXT NOT NULL DEFAULT '[]',
    pinned INTEGER NOT NULL DEFAULT 0,
    file_name TEXT,
    file_size INTEGER,
    file_type TEXT,
    file_category TEXT,
    file_ext TEXT,
    is_screenshot INTEGER NOT NULL DEFAULT 0,
    json_subtype TEXT,
    source TEXT,
    metadata_source TEXT,
    content_hash TEXT,
    vc TEXT NOT NULL DEFAULT '{}',
    active INTEGER NOT NULL DEFAULT 1,
    deleted_at TEXT,
    deleted_by TEXT,
    created_at TEXT NOT NULL,
    modified_at TEXT NOT NULL,
    has_parked_precursor INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (tenant_id, id)
  );
`;

const DDL_ITEMS_INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_items_space ON items(tenant_id, space_id, active);`,
  `CREATE INDEX IF NOT EXISTS idx_items_type ON items(tenant_id, type);`,
  `CREATE INDEX IF NOT EXISTS idx_items_timestamp ON items(tenant_id, timestamp DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_items_pinned ON items(tenant_id, pinned, timestamp DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_items_content_hash ON items(content_hash);`,
  `CREATE INDEX IF NOT EXISTS idx_items_active ON items(tenant_id, active);`,
];

/**
 * Tags index: denormalised join table for tag-aggregate queries.
 *
 * Composite primary key (tenant_id, item_id, tag). Cascading delete
 * on the items FK guarantees the join stays clean when an item row
 * is purged (which is rare -- soft-delete via active=0 is the norm).
 */
const DDL_ITEM_TAGS = `
  CREATE TABLE IF NOT EXISTS item_tags (
    tenant_id TEXT NOT NULL DEFAULT 'default',
    item_id TEXT NOT NULL,
    tag TEXT NOT NULL,
    PRIMARY KEY (tenant_id, item_id, tag),
    FOREIGN KEY (tenant_id, item_id) REFERENCES items(tenant_id, id) ON DELETE CASCADE
  );
`;

const DDL_ITEM_TAGS_INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_item_tags_tag ON item_tags(tenant_id, tag);`,
];

/**
 * Smart folders: persisted alongside items for transactional consistency.
 *
 * criteria is JSON: { tags?, anyTags?, types?, spaces? }.
 */
const DDL_SMART_FOLDERS = `
  CREATE TABLE IF NOT EXISTS smart_folders (
    tenant_id TEXT NOT NULL DEFAULT 'default',
    id TEXT NOT NULL,
    name TEXT NOT NULL,
    icon TEXT,
    color TEXT,
    criteria TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (tenant_id, id)
  );
`;

/**
 * Replica metadata: key/value bag for migration tooling, pull cursor,
 * last-full-pull timestamp, etc. Single-row constants seeded by init().
 *
 * Known keys (Phase 5+ may add more):
 *   schemaVersion        -- compiled-in version on first init
 *   lastFullPullAt       -- ISO 8601, '' until first full pull completes
 *   cursor               -- pull-engine cursor for incremental sync
 *   tenantId             -- echo of the configured tenant for diagnostics
 *   deviceId             -- echo of the device identity for diagnostics
 *   replicaCreatedAt     -- ISO 8601 set on first init; never updated
 *
 * Composite key includes tenant_id so a multi-tenant database can
 * track per-tenant pull cursors.
 */
const DDL_REPLICA_META = `
  CREATE TABLE IF NOT EXISTS replica_meta (
    tenant_id TEXT NOT NULL DEFAULT 'default',
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (tenant_id, key)
  );
`;

/**
 * FTS5 virtual table for the search() path. Lazy-populated via
 * triggers on the items table. tokenize='porter unicode61' gives
 * stemmed Latin-script + Unicode-aware tokenisation; BM25 ranking
 * is FTS5's default scorer.
 *
 * IMPORTANT: FTS5 virtual tables don't support CREATE TABLE IF NOT
 * EXISTS in all SQLite builds, so the Replica class checks
 * sqlite_master before issuing this DDL.
 *
 * tenant_id is included as an UNINDEXED column so search results can
 * be filtered post-hoc on tenant. (FTS5 does not natively support
 * composite primary keys; tenant filtering is a WHERE clause on the
 * outer query.)
 */
const DDL_ITEMS_FTS = `
  CREATE VIRTUAL TABLE items_fts USING fts5(
    id UNINDEXED,
    tenant_id UNINDEXED,
    preview,
    content,
    metadata_text,
    tags_text,
    tokenize = 'porter unicode61'
  );
`;

// ---------------------------------------------------------------------------
// Seed rows for replica_meta on first init
// ---------------------------------------------------------------------------

/**
 * Seed values inserted into replica_meta on first init. Caller passes
 * tenantId, deviceId, and the current ISO timestamp; this function
 * returns the rows ready to .run() against an INSERT prepared
 * statement.
 *
 * Keep schemaVersion as a STRING in the row (the column type is TEXT);
 * compare via parseInt when reading.
 */
function buildReplicaMetaSeed({ tenantId = 'default', deviceId = '', nowIso = new Date().toISOString() } = {}) {
  return [
    { tenant_id: tenantId, key: 'schemaVersion', value: String(SCHEMA_VERSION) },
    { tenant_id: tenantId, key: 'lastFullPullAt', value: '' },
    { tenant_id: tenantId, key: 'cursor', value: '' },
    { tenant_id: tenantId, key: 'tenantId', value: tenantId },
    { tenant_id: tenantId, key: 'deviceId', value: String(deviceId) },
    { tenant_id: tenantId, key: 'replicaCreatedAt', value: nowIso },
  ];
}

// ---------------------------------------------------------------------------
// Aggregated DDL for one-shot init
// ---------------------------------------------------------------------------

/**
 * Returns the ordered list of DDL statements for a fresh DB. Replica
 * runs them in a transaction; FTS5 virtual table is conditionally
 * issued (CREATE VIRTUAL TABLE doesn't support IF NOT EXISTS).
 *
 * Order matters:
 *   1. Tables with PKs first.
 *   2. Indexes after their tables.
 *   3. FTS5 virtual table last (the items_fts triggers, when added in
 *      a follow-up commit, depend on items existing).
 */
function getInitDDL() {
  return [
    DDL_SPACES,
    ...DDL_SPACES_INDEXES,
    DDL_ITEMS,
    ...DDL_ITEMS_INDEXES,
    DDL_ITEM_TAGS,
    ...DDL_ITEM_TAGS_INDEXES,
    DDL_SMART_FOLDERS,
    DDL_REPLICA_META,
    // DDL_ITEMS_FTS is issued separately by Replica.init() because
    // CREATE VIRTUAL TABLE does not honour IF NOT EXISTS.
  ];
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  SCHEMA_VERSION,
  DDL_SPACES,
  DDL_SPACES_INDEXES,
  DDL_ITEMS,
  DDL_ITEMS_INDEXES,
  DDL_ITEM_TAGS,
  DDL_ITEM_TAGS_INDEXES,
  DDL_SMART_FOLDERS,
  DDL_REPLICA_META,
  DDL_ITEMS_FTS,
  buildReplicaMetaSeed,
  getInitDDL,
};
