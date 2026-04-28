/**
 * Unit tests for lib/sync-v5/replica/replica.js -- basic CRUD round-trip.
 *
 * These tests exercise the native better-sqlite3 binding against an
 * in-memory database. They cover:
 *   - init() lifecycle (schema applied, replica_meta seeded,
 *     schemaVersion handshake)
 *   - Spaces upsert + get + list
 *   - Items upsert + get; tag denorm round-trip
 *   - Tenant isolation (rows under tenantId='t1' don't leak into 't2')
 *   - getMeta / setMeta key/value round-trip
 *   - inspect() diagnostics shape
 *   - shouldShadow() filesystem fall-through gate (§6.3)
 *   - Pure-helper edge cases (_normaliseSpaceRow, _normaliseItemRow,
 *     _parseTagsField, _matchGlob)
 *
 * Strategy: each test gets its own :memory: replica via beforeEach;
 * no shared state, no fixture files. Closing happens in afterEach
 * defensively.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const {
  Replica,
  _normaliseSpaceRow,
  _normaliseItemRow,
  _parseTagsField,
  _matchGlob,
} = require('../../../lib/sync-v5/replica/replica');
const { SCHEMA_VERSION } = require('../../../lib/sync-v5/replica/schema');

let r = null;

beforeEach(() => {
  r = new Replica({ dbPath: ':memory:', tenantId: 'default', deviceId: 'dev-1' });
  r.init();
});

afterEach(() => {
  if (r) {
    try { r.close(); } catch (_e) { /* close-noise OK in teardown */ }
    r = null;
  }
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe('Replica -- lifecycle', () => {
  it('init() seeds replica_meta with schemaVersion = SCHEMA_VERSION', () => {
    expect(r.getMeta('schemaVersion')).toBe(String(SCHEMA_VERSION));
  });

  it('init() seeds tenantId, deviceId, replicaCreatedAt', () => {
    expect(r.getMeta('tenantId')).toBe('default');
    expect(r.getMeta('deviceId')).toBe('dev-1');
    const created = r.getMeta('replicaCreatedAt');
    expect(created).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('lastFullPullAt + cursor seeded as empty strings (not null)', () => {
    expect(r.getMeta('lastFullPullAt')).toBe('');
    expect(r.getMeta('cursor')).toBe('');
  });

  it('init() is idempotent (calling again is a no-op)', () => {
    const before = r.getMeta('replicaCreatedAt');
    r.init();
    expect(r.getMeta('replicaCreatedAt')).toBe(before);
  });

  it('close() is idempotent and safe', () => {
    r.close();
    expect(() => r.close()).not.toThrow();
  });

  it('throws if dbPath is omitted', () => {
    expect(() => new Replica({})).toThrow(/dbPath is required/);
  });

  it('throws REPLICA_SCHEMA_VERSION_NEWER if the on-disk version is higher than compiled-in', () => {
    // Manually set the stored schemaVersion to a future value, close,
    // then re-open and expect the gate to refuse.
    r.setMeta('schemaVersion', '999');
    r.close();

    const r2 = new Replica({ dbPath: ':memory:', tenantId: 'default' });
    // Fresh :memory: -- the 999 from r doesn't carry over (memory DBs
    // are per-connection). Simulate by writing 999 directly post-init
    // and re-reading via _verifySchemaVersion.
    r2.init();
    r2.setMeta('schemaVersion', '999');
    expect(() => r2._verifySchemaVersion()).toThrow(/newer than this build's/);
    r2.close();
  });
});

// ---------------------------------------------------------------------------
// Spaces CRUD
// ---------------------------------------------------------------------------

describe('Replica -- spaces CRUD', () => {
  it('upsertSpace round-trip', () => {
    r.upsertSpace({
      id: 's1',
      name: 'Inbox',
      icon: 'inbox',
      color: '#cccccc',
      created_at: '2026-04-27T00:00:00.000Z',
      updated_at: '2026-04-27T00:00:00.000Z',
    });
    const got = r.getSpace('s1');
    expect(got).toMatchObject({
      tenant_id: 'default',
      id: 's1',
      name: 'Inbox',
      icon: 'inbox',
      color: '#cccccc',
      active: 1,
    });
  });

  it('getSpace returns null for unknown id (not undefined)', () => {
    expect(r.getSpace('nonexistent')).toBeNull();
  });

  it('upsertSpace updates existing row in place (no duplicate)', () => {
    r.upsertSpace({ id: 's1', name: 'First' });
    r.upsertSpace({ id: 's1', name: 'Second' });
    expect(r.getSpace('s1').name).toBe('Second');
    expect(r.listSpaces()).toHaveLength(1);
  });

  it('listSpaces returns active rows newest-first', () => {
    r.upsertSpace({ id: 's1', name: 'A', updated_at: '2026-04-01T00:00:00.000Z' });
    r.upsertSpace({ id: 's2', name: 'B', updated_at: '2026-04-02T00:00:00.000Z' });
    r.upsertSpace({ id: 's3', name: 'C', updated_at: '2026-04-03T00:00:00.000Z' });
    const ids = r.listSpaces().map((s) => s.id);
    expect(ids).toEqual(['s3', 's2', 's1']);
  });

  it('listSpaces excludes inactive (soft-deleted) rows', () => {
    r.upsertSpace({ id: 's1', name: 'A' });
    r.upsertSpace({ id: 's2', name: 'B', active: false });
    const ids = r.listSpaces().map((s) => s.id);
    expect(ids).toEqual(['s1']);
  });

  it('upsertSpace requires id', () => {
    expect(() => r.upsertSpace({})).toThrow(/space\.id is required/);
  });
});

// ---------------------------------------------------------------------------
// Items CRUD + tag denorm
// ---------------------------------------------------------------------------

describe('Replica -- items CRUD', () => {
  it('upsertItem round-trip with tag denorm', () => {
    r.upsertItem({
      id: 'i1',
      type: 'text',
      space_id: 's1',
      timestamp: 1700000000000,
      preview: 'hello world',
      tags: ['greeting', 'demo'],
    });
    const got = r.getItem('i1');
    expect(got).toMatchObject({
      id: 'i1',
      type: 'text',
      space_id: 's1',
      preview: 'hello world',
      pinned: false,
      active: true,
    });
    expect(got.tags.sort()).toEqual(['demo', 'greeting']);
  });

  it('upsertItem replaces tags wholesale (delete + insert in one tx)', () => {
    r.upsertItem({ id: 'i1', type: 'text', tags: ['a', 'b', 'c'] });
    expect(r.listItemTags('i1').sort()).toEqual(['a', 'b', 'c']);
    r.upsertItem({ id: 'i1', type: 'text', tags: ['c', 'd'] });
    expect(r.listItemTags('i1').sort()).toEqual(['c', 'd']);
  });

  it('upsertItem with empty tags clears the join table', () => {
    r.upsertItem({ id: 'i1', type: 'text', tags: ['a', 'b'] });
    expect(r.listItemTags('i1')).toHaveLength(2);
    r.upsertItem({ id: 'i1', type: 'text', tags: [] });
    expect(r.listItemTags('i1')).toHaveLength(0);
  });

  it('upsertItem accepts tags as a JSON string and round-trips', () => {
    r.upsertItem({ id: 'i1', type: 'text', tags: '["x","y"]' });
    expect(r.listItemTags('i1').sort()).toEqual(['x', 'y']);
  });

  it('getItem returns null for unknown id', () => {
    expect(r.getItem('nonexistent')).toBeNull();
  });

  it('upsertItem requires id and type', () => {
    expect(() => r.upsertItem({})).toThrow(/item\.id is required/);
    expect(() => r.upsertItem({ id: 'i1' })).toThrow(/item\.type is required/);
  });

  it('upsertItem coerces booleans to integers (pinned, is_screenshot, has_parked_precursor)', () => {
    r.upsertItem({ id: 'i1', type: 'text', pinned: true, isScreenshot: true });
    const got = r.getItem('i1');
    expect(got.pinned).toBe(true); // hydrated to bool on read
    expect(got.is_screenshot).toBe(true);
  });

  it('soft-delete: active=false round-trips', () => {
    r.upsertItem({
      id: 'i1',
      type: 'text',
      active: false,
      deleted_at: '2026-04-27T00:00:00.000Z',
      deleted_by: 'dev-1',
    });
    const got = r.getItem('i1');
    expect(got.active).toBe(false);
    expect(got.deleted_at).toBe('2026-04-27T00:00:00.000Z');
    expect(got.deleted_by).toBe('dev-1');
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation
// ---------------------------------------------------------------------------

describe('Replica -- tenant isolation (§6B.2)', () => {
  it('rows written under tenant t1 are invisible to tenant t2 via the public API', () => {
    const r1 = new Replica({ dbPath: ':memory:', tenantId: 't1' }).init();
    r1.upsertSpace({ id: 's1', name: 'T1 Inbox' });
    r1.upsertItem({ id: 'i1', type: 'text', space_id: 's1', preview: 'private to t1' });

    // Same physical DB cannot be queried from a different connection
    // when using :memory:. Validate cross-tenant isolation by writing
    // both tenants on ONE connection (which is the production case
    // anyway: one DB file, multiple tenant_id values inside).
    r1.tenantId = 't2'; // hot-swap; this is what tests do, not prod
    expect(r1.getSpace('s1')).toBeNull();
    expect(r1.getItem('i1')).toBeNull();
    expect(r1.listSpaces()).toEqual([]);

    r1.tenantId = 't1';
    expect(r1.getSpace('s1')).not.toBeNull();

    r1.close();
  });

  it('inspect() reports the configured tenant', () => {
    const r1 = new Replica({ dbPath: ':memory:', tenantId: 'multi-1' }).init();
    expect(r1.inspect().tenantId).toBe('multi-1');
    r1.close();
  });
});

// ---------------------------------------------------------------------------
// inspect()
// ---------------------------------------------------------------------------

describe('Replica -- inspect()', () => {
  it('returns counts + meta + schema info shape', () => {
    r.upsertSpace({ id: 's1', name: 'A' });
    r.upsertItem({ id: 'i1', type: 'text', space_id: 's1' });
    r.upsertItem({ id: 'i2', type: 'image', space_id: 's1' });

    const snap = r.inspect();
    expect(snap).toMatchObject({
      dbPath: ':memory:',
      tenantId: 'default',
      deviceId: 'dev-1',
      schemaVersion: SCHEMA_VERSION,
      compiledInSchemaVersion: SCHEMA_VERSION,
      readonly: false,
      counts: { spaces: 1, items: 2 },
    });
    expect(typeof snap.fts5Available).toBe('boolean');
    expect(snap.noShadowPaths).toEqual(['gsx-agent/*.md']);
    expect(snap.meta.cursor).toBe('');
  });

  it('cursor + lastFullPullAt update via setMeta and reflect in inspect()', () => {
    r.setMeta('cursor', 'op-12345');
    r.setMeta('lastFullPullAt', '2026-04-27T12:00:00.000Z');
    const snap = r.inspect();
    expect(snap.meta.cursor).toBe('op-12345');
    expect(snap.meta.lastFullPullAt).toBe('2026-04-27T12:00:00.000Z');
  });
});

// ---------------------------------------------------------------------------
// shouldShadow (no-shadow gate, §6.3)
// ---------------------------------------------------------------------------

describe('Replica -- shouldShadow() filesystem fall-through gate', () => {
  it('shadows ordinary item paths', () => {
    expect(r.shouldShadow('items/i1/body.md')).toBe(true);
    expect(r.shouldShadow('spaces/inbox/note.md')).toBe(true);
  });

  it('does NOT shadow gsx-agent/*.md (matches default no-shadow pattern)', () => {
    expect(r.shouldShadow('gsx-agent/conversation-history.md')).toBe(false);
    expect(r.shouldShadow('gsx-agent/session-summaries.md')).toBe(false);
    expect(r.shouldShadow('gsx-agent/main.md')).toBe(false);
  });

  it('default config does NOT match unrelated paths', () => {
    expect(r.shouldShadow('gsx-agent/sub/deep.md')).toBe(true); // not matched by gsx-agent/*.md (single *)
    expect(r.shouldShadow('other/conversation-history.md')).toBe(true);
  });

  it('honours additional patterns when configured', () => {
    const r2 = new Replica({
      dbPath: ':memory:',
      noShadowPaths: ['secrets/**', '*.tmp'],
    }).init();
    expect(r2.shouldShadow('secrets/key.txt')).toBe(false);
    expect(r2.shouldShadow('secrets/nested/key.txt')).toBe(false);
    expect(r2.shouldShadow('foo.tmp')).toBe(false);
    expect(r2.shouldShadow('foo.md')).toBe(true);
    r2.close();
  });

  it('handles backslashes (Windows-style) by normalising', () => {
    expect(r.shouldShadow('gsx-agent\\session-summaries.md')).toBe(false);
  });

  it('empty/null path defaults to shadowing (no fall-through trigger)', () => {
    expect(r.shouldShadow('')).toBe(true);
    expect(r.shouldShadow(null)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('Replica -- pure helpers', () => {
  it('_normaliseSpaceRow defaults vc to "{}"', () => {
    const row = _normaliseSpaceRow('default', { id: 's1', name: 'A' });
    expect(row.vc).toBe('{}');
  });

  it('_normaliseSpaceRow JSON-stringifies object vc', () => {
    const row = _normaliseSpaceRow('default', { id: 's1', vc: { devA: 1 } });
    expect(row.vc).toBe('{"devA":1}');
  });

  it('_normaliseItemRow defaults timestamp to Date.now()', () => {
    const before = Date.now() - 1;
    const row = _normaliseItemRow('default', { id: 'i1', type: 'text' });
    const after = Date.now() + 1;
    expect(row.timestamp).toBeGreaterThanOrEqual(before);
    expect(row.timestamp).toBeLessThanOrEqual(after);
  });

  it('_normaliseItemRow accepts both camelCase and snake_case', () => {
    const row = _normaliseItemRow('default', {
      id: 'i1',
      type: 'text',
      contentHash: 'abc123',
      hasParkedPrecursor: true,
      isScreenshot: false,
    });
    expect(row.content_hash).toBe('abc123');
    expect(row.has_parked_precursor).toBe(1);
    expect(row.is_screenshot).toBe(0);
  });

  it('_parseTagsField returns [] for malformed input (does not throw)', () => {
    expect(_parseTagsField('not-json')).toEqual([]);
    expect(_parseTagsField('{}')).toEqual([]);
    expect(_parseTagsField(null)).toEqual([]);
    expect(_parseTagsField(undefined)).toEqual([]);
  });

  it('_parseTagsField round-trips a JSON array', () => {
    expect(_parseTagsField('["a","b"]')).toEqual(['a', 'b']);
  });

  it('_matchGlob single-* does not cross slashes', () => {
    expect(_matchGlob('gsx-agent/*.md', 'gsx-agent/foo.md')).toBe(true);
    expect(_matchGlob('gsx-agent/*.md', 'gsx-agent/sub/foo.md')).toBe(false);
  });

  it('_matchGlob double-** crosses slashes', () => {
    expect(_matchGlob('gsx-agent/**/*.md', 'gsx-agent/sub/deep/x.md')).toBe(true);
    expect(_matchGlob('secrets/**', 'secrets/a/b/c')).toBe(true);
  });

  it('_matchGlob anchors to whole-string', () => {
    expect(_matchGlob('*.md', 'foo.md')).toBe(true);
    expect(_matchGlob('*.md', 'foo.md.bak')).toBe(false);
  });

  it('_matchGlob escapes regex metacharacters', () => {
    expect(_matchGlob('a.b', 'a.b')).toBe(true);
    expect(_matchGlob('a.b', 'aXb')).toBe(false);
  });
});
