/**
 * Unit tests for lib/sync-v5/replica/schema.js
 *
 * Covers the DDL constants and seed-row builder. These tests do not
 * touch better-sqlite3; they're pure-data assertions on the schema
 * shape. Round-trip + native-binding tests live in
 * test/unit/sync-v5/replica-basic-crud.test.js.
 */

import { describe, it, expect } from 'vitest';

const {
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
} = require('../../../lib/sync-v5/replica/schema');

describe('replica/schema -- SCHEMA_VERSION', () => {
  it('is the integer 1 for the initial commit-A scaffold', () => {
    expect(SCHEMA_VERSION).toBe(1);
    expect(Number.isInteger(SCHEMA_VERSION)).toBe(true);
  });
});

describe('replica/schema -- DDL_SPACES', () => {
  it('declares tenant_id with default "default" (per §6B.2)', () => {
    expect(DDL_SPACES).toMatch(/tenant_id\s+TEXT\s+NOT NULL\s+DEFAULT\s+'default'/);
  });

  it('uses composite primary key (tenant_id, id) for multi-tenant safety', () => {
    expect(DDL_SPACES).toMatch(/PRIMARY KEY\s*\(\s*tenant_id\s*,\s*id\s*\)/);
  });

  it('declares vc and active columns required by v5 invariants', () => {
    expect(DDL_SPACES).toMatch(/vc\s+TEXT\s+NOT NULL\s+DEFAULT\s+'\{\}'/);
    expect(DDL_SPACES).toMatch(/active\s+INTEGER\s+NOT NULL\s+DEFAULT\s+1/);
  });

  it('uses CREATE TABLE IF NOT EXISTS for idempotent init', () => {
    expect(DDL_SPACES).toMatch(/CREATE TABLE IF NOT EXISTS\s+spaces/);
  });

  it('has indexes on (tenant_id, active) and (tenant_id, updated_at DESC)', () => {
    const joined = DDL_SPACES_INDEXES.join('\n');
    expect(joined).toMatch(/idx_spaces_active.*tenant_id.*active/);
    expect(joined).toMatch(/idx_spaces_updated_at.*tenant_id.*updated_at\s+DESC/);
  });
});

describe('replica/schema -- DDL_ITEMS', () => {
  it('declares tenant_id + composite primary key', () => {
    expect(DDL_ITEMS).toMatch(/tenant_id\s+TEXT\s+NOT NULL\s+DEFAULT\s+'default'/);
    expect(DDL_ITEMS).toMatch(/PRIMARY KEY\s*\(\s*tenant_id\s*,\s*id\s*\)/);
  });

  it('declares all v5-specific columns from the plan', () => {
    expect(DDL_ITEMS).toMatch(/content_hash\s+TEXT/);
    expect(DDL_ITEMS).toMatch(/vc\s+TEXT\s+NOT NULL\s+DEFAULT\s+'\{\}'/);
    expect(DDL_ITEMS).toMatch(/active\s+INTEGER\s+NOT NULL\s+DEFAULT\s+1/);
    expect(DDL_ITEMS).toMatch(/deleted_at\s+TEXT/);
    expect(DDL_ITEMS).toMatch(/deleted_by\s+TEXT/);
    expect(DDL_ITEMS).toMatch(/has_parked_precursor\s+INTEGER\s+NOT NULL\s+DEFAULT\s+0/);
  });

  it('mirrors clipboard-storage-v2 columns: file_*, source, metadata_source, etc.', () => {
    expect(DDL_ITEMS).toMatch(/file_name\s+TEXT/);
    expect(DDL_ITEMS).toMatch(/file_size\s+INTEGER/);
    expect(DDL_ITEMS).toMatch(/file_type\s+TEXT/);
    expect(DDL_ITEMS).toMatch(/source\s+TEXT/);
    expect(DDL_ITEMS).toMatch(/metadata_source\s+TEXT/);
    expect(DDL_ITEMS).toMatch(/is_screenshot\s+INTEGER/);
    expect(DDL_ITEMS).toMatch(/json_subtype\s+TEXT/);
  });

  it('has the hot-path indexes the query surface depends on', () => {
    const joined = DDL_ITEMS_INDEXES.join('\n');
    // (tenant_id, space_id, active): items.list(spaceId)
    expect(joined).toMatch(/idx_items_space.*tenant_id.*space_id.*active/);
    // (tenant_id, type): items.list({type: 'image'})
    expect(joined).toMatch(/idx_items_type.*tenant_id.*type/);
    // (tenant_id, timestamp DESC): default sort
    expect(joined).toMatch(/idx_items_timestamp.*tenant_id.*timestamp\s+DESC/);
    // (tenant_id, pinned, timestamp DESC): pinned-first sort
    expect(joined).toMatch(/idx_items_pinned.*tenant_id.*pinned.*timestamp\s+DESC/);
    // (content_hash) NOT scoped to tenant -- intentional: blob-store
    // dedup is content-addressed, not tenant-addressed
    expect(joined).toMatch(/idx_items_content_hash.*\(content_hash\)/);
    expect(joined).toMatch(/idx_items_active.*tenant_id.*active/);
  });
});

describe('replica/schema -- DDL_ITEM_TAGS', () => {
  it('uses composite primary key (tenant_id, item_id, tag) so each tag is unique per item', () => {
    expect(DDL_ITEM_TAGS).toMatch(/PRIMARY KEY\s*\(\s*tenant_id\s*,\s*item_id\s*,\s*tag\s*\)/);
  });

  it('cascades delete from items via composite foreign key', () => {
    expect(DDL_ITEM_TAGS).toMatch(/FOREIGN KEY\s*\(\s*tenant_id\s*,\s*item_id\s*\)\s+REFERENCES\s+items\s*\(\s*tenant_id\s*,\s*id\s*\)\s+ON DELETE CASCADE/);
  });

  it('has tag-aggregate index (tenant_id, tag) for tags.list / findItems', () => {
    expect(DDL_ITEM_TAGS_INDEXES.join('\n')).toMatch(/idx_item_tags_tag.*tenant_id.*tag/);
  });
});

describe('replica/schema -- DDL_SMART_FOLDERS', () => {
  it('declares tenant_id + composite primary key', () => {
    expect(DDL_SMART_FOLDERS).toMatch(/tenant_id\s+TEXT\s+NOT NULL\s+DEFAULT\s+'default'/);
    expect(DDL_SMART_FOLDERS).toMatch(/PRIMARY KEY\s*\(\s*tenant_id\s*,\s*id\s*\)/);
  });

  it('stores criteria as TEXT (JSON-encoded) per §3', () => {
    expect(DDL_SMART_FOLDERS).toMatch(/criteria\s+TEXT\s+NOT NULL/);
  });
});

describe('replica/schema -- DDL_REPLICA_META', () => {
  it('uses composite primary key (tenant_id, key) so each tenant has its own meta', () => {
    expect(DDL_REPLICA_META).toMatch(/PRIMARY KEY\s*\(\s*tenant_id\s*,\s*key\s*\)/);
  });
});

describe('replica/schema -- DDL_ITEMS_FTS', () => {
  it('uses FTS5 with porter+unicode61 tokenisation', () => {
    expect(DDL_ITEMS_FTS).toMatch(/USING fts5\(/);
    expect(DDL_ITEMS_FTS).toMatch(/tokenize\s*=\s*'porter\s+unicode61'/);
  });

  it('exposes id and tenant_id as UNINDEXED columns (filtered post-hoc, not FTS-tokenised)', () => {
    expect(DDL_ITEMS_FTS).toMatch(/id\s+UNINDEXED/);
    expect(DDL_ITEMS_FTS).toMatch(/tenant_id\s+UNINDEXED/);
  });

  it('indexes the search-relevant text columns (preview, content, metadata_text, tags_text)', () => {
    expect(DDL_ITEMS_FTS).toMatch(/preview/);
    expect(DDL_ITEMS_FTS).toMatch(/content/);
    expect(DDL_ITEMS_FTS).toMatch(/metadata_text/);
    expect(DDL_ITEMS_FTS).toMatch(/tags_text/);
  });
});

describe('replica/schema -- buildReplicaMetaSeed', () => {
  it('returns the full set of seed rows: schemaVersion, lastFullPullAt, cursor, tenantId, deviceId, replicaCreatedAt', () => {
    const seed = buildReplicaMetaSeed({ tenantId: 't1', deviceId: 'd1', nowIso: '2026-04-27T00:00:00.000Z' });
    const keys = seed.map((r) => r.key).sort();
    expect(keys).toEqual([
      'cursor',
      'deviceId',
      'lastFullPullAt',
      'replicaCreatedAt',
      'schemaVersion',
      'tenantId',
    ]);
  });

  it('schemaVersion is the string form of SCHEMA_VERSION (column type is TEXT)', () => {
    const seed = buildReplicaMetaSeed({ tenantId: 't1' });
    const sv = seed.find((r) => r.key === 'schemaVersion');
    expect(sv.value).toBe(String(SCHEMA_VERSION));
    expect(typeof sv.value).toBe('string');
  });

  it('every row carries the requested tenant_id', () => {
    const seed = buildReplicaMetaSeed({ tenantId: 'multi-tenant-test' });
    for (const row of seed) {
      expect(row.tenant_id).toBe('multi-tenant-test');
    }
  });

  it('defaults to tenant "default" and empty deviceId / nowIso when omitted', () => {
    const seed = buildReplicaMetaSeed();
    expect(seed[0].tenant_id).toBe('default');
    const dev = seed.find((r) => r.key === 'deviceId');
    expect(dev.value).toBe('');
    const created = seed.find((r) => r.key === 'replicaCreatedAt');
    // Default nowIso is whatever new Date().toISOString() returns at
    // call time; just assert it's an ISO string.
    expect(created.value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('lastFullPullAt and cursor seeded as empty strings (not NULL)', () => {
    const seed = buildReplicaMetaSeed({ tenantId: 't1' });
    const lfp = seed.find((r) => r.key === 'lastFullPullAt');
    const cursor = seed.find((r) => r.key === 'cursor');
    expect(lfp.value).toBe('');
    expect(cursor.value).toBe('');
  });
});

describe('replica/schema -- getInitDDL', () => {
  it('returns DDL in dependency order: tables before their indexes; FTS5 NOT included', () => {
    const ddls = getInitDDL();
    expect(ddls.length).toBeGreaterThan(5);
    // The FTS5 virtual table must NOT be in this list because
    // CREATE VIRTUAL TABLE doesn't honour IF NOT EXISTS in all
    // SQLite builds. Replica.init() issues it conditionally after
    // checking sqlite_master.
    for (const stmt of ddls) {
      expect(stmt).not.toMatch(/CREATE VIRTUAL TABLE/);
    }
  });

  it('every CREATE TABLE in the list uses IF NOT EXISTS', () => {
    const ddls = getInitDDL();
    const tableStmts = ddls.filter((s) => /CREATE TABLE/.test(s));
    for (const stmt of tableStmts) {
      expect(stmt).toMatch(/CREATE TABLE IF NOT EXISTS/);
    }
  });

  it('every CREATE INDEX uses IF NOT EXISTS', () => {
    const ddls = getInitDDL();
    const indexStmts = ddls.filter((s) => /CREATE INDEX/.test(s));
    for (const stmt of indexStmts) {
      expect(stmt).toMatch(/CREATE INDEX IF NOT EXISTS/);
    }
  });
});
