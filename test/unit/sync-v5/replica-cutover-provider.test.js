/**
 * Unit tests for lib/sync-v5/replica/cutover-provider.js
 *
 * Covers the spaces-api-shaped read methods backed by the replica.
 * Strategy: real (in-memory) Replica + buildCutoverProvider; each
 * test populates the replica with known rows and asserts the
 * adapter returns spaces-api-shaped output.
 *
 * Translation contract tested:
 *   - snake_case columns -> camelCase fields (space_id -> spaceId,
 *     file_name -> fileName, is_screenshot -> isScreenshot, etc.)
 *   - Integer-coerced booleans (pinned=1) -> native booleans (true)
 *   - tags array passes through as-is from replica's hydration
 *   - Replica-internal fields (vc, content_hash, deleted_at,
 *     tenant_id, has_parked_precursor) NEVER appear in output
 *   - Soft-deleted (active=0) rows excluded from collection results
 *   - Sort order matches spaces-api (pinned-first then timestamp DESC)
 *
 * Edge cases:
 *   - Empty space / unknown id returns []
 *   - get() returns null for non-existent or cross-space mismatch
 *   - findItems with empty tags returns []
 *   - Errors propagate (caller -- spaces-api -- decides fail-open)
 *   - inspect() returns counters per method
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const { Replica } = require('../../../lib/sync-v5/replica/replica');
const {
  buildCutoverProvider,
  _replicaRowToSpacesItem,
} = require('../../../lib/sync-v5/replica/cutover-provider');

let r = null;
let provider = null;

beforeEach(() => {
  r = new Replica({ dbPath: ':memory:', tenantId: 'default', deviceId: 'd' }).init();
  provider = buildCutoverProvider({ replica: r });
});

afterEach(() => {
  if (r) try { r.close(); } catch (_e) { /* ok */ }
  r = null;
  provider = null;
});

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

describe('buildCutoverProvider -- construction', () => {
  it('throws if replica is missing', () => {
    expect(() => buildCutoverProvider({})).toThrow(/replica is required/);
  });

  it('returns the documented surface (list / get / findItems / listSmartFolders / inspect)', () => {
    expect(typeof provider.list).toBe('function');
    expect(typeof provider.get).toBe('function');
    expect(typeof provider.findItems).toBe('function');
    expect(typeof provider.listSmartFolders).toBe('function');
    expect(typeof provider.inspect).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

describe('cutover-provider -- list()', () => {
  it('returns spaces-api-shaped items (camelCase + native booleans)', async () => {
    r.upsertItem({
      id: 'i1',
      type: 'image',
      space_id: 's1',
      preview: 'photo',
      timestamp: 1700000000000,
      file_name: 'photo.png',
      file_size: 4096,
      file_type: 'image/png',
      is_screenshot: true,
      pinned: true,
    });
    const result = await provider.list('s1', {});
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: 'i1',
      type: 'image',
      spaceId: 's1',          // camelCase, not space_id
      preview: 'photo',
      fileName: 'photo.png',
      fileSize: 4096,
      fileType: 'image/png',
      isScreenshot: true,     // native boolean, not 1
      pinned: true,
    });
  });

  it('does NOT expose replica-internal fields (vc, content_hash, tenant_id, etc.)', async () => {
    r.upsertItem({
      id: 'i1', type: 'text', space_id: 's1',
      content_hash: 'a'.repeat(64),
      vc: { 'd': 1 },
    });
    const [item] = await provider.list('s1', {});
    expect(item).not.toHaveProperty('vc');
    expect(item).not.toHaveProperty('content_hash');
    expect(item).not.toHaveProperty('tenant_id');
    expect(item).not.toHaveProperty('has_parked_precursor');
    expect(item).not.toHaveProperty('deleted_at');
    expect(item).not.toHaveProperty('deleted_by');
  });

  it('excludes soft-deleted (active=0) items', async () => {
    r.upsertItem({ id: 'i1', type: 'text', space_id: 's1' });
    r.upsertItem({ id: 'i2', type: 'text', space_id: 's1', active: false });
    const items = await provider.list('s1', {});
    expect(items.map((i) => i.id)).toEqual(['i1']);
  });

  it('sort order: pinned first then timestamp DESC (matches spaces-api)', async () => {
    r.upsertItem({ id: 'a', type: 'text', space_id: 's1', timestamp: 100, pinned: false });
    r.upsertItem({ id: 'b', type: 'text', space_id: 's1', timestamp: 200, pinned: true });
    r.upsertItem({ id: 'c', type: 'text', space_id: 's1', timestamp: 50, pinned: true });
    r.upsertItem({ id: 'd', type: 'text', space_id: 's1', timestamp: 300, pinned: false });
    const result = await provider.list('s1', {});
    expect(result.map((i) => i.id)).toEqual(['b', 'c', 'd', 'a']);
  });

  it('forwards type/pinned/tags/anyTags/limit/offset filter options', async () => {
    r.upsertItem({ id: 'i1', type: 'text', space_id: 's1', tags: ['x', 'y'] });
    r.upsertItem({ id: 'i2', type: 'image', space_id: 's1', tags: ['x'] });
    r.upsertItem({ id: 'i3', type: 'text', space_id: 's1', tags: ['z'] });

    expect((await provider.list('s1', { type: 'text' })).map((i) => i.id).sort())
      .toEqual(['i1', 'i3']);
    expect((await provider.list('s1', { tags: ['x', 'y'] })).map((i) => i.id))
      .toEqual(['i1']);
    expect((await provider.list('s1', { anyTags: ['z'] })).map((i) => i.id))
      .toEqual(['i3']);
    expect((await provider.list('s1', { limit: 1 }))).toHaveLength(1);
  });

  it('returns [] for unknown / empty space', async () => {
    expect(await provider.list('nonexistent', {})).toEqual([]);
    expect(await provider.list('', {})).toEqual([]);
  });

  it('hydrates tags as array (from item_tags join, not items.tags JSON column)', async () => {
    r.upsertItem({ id: 'i1', type: 'text', space_id: 's1', tags: ['alpha', 'beta'] });
    const [item] = await provider.list('s1', {});
    expect(item.tags.sort()).toEqual(['alpha', 'beta']);
  });
});

// ---------------------------------------------------------------------------
// get
// ---------------------------------------------------------------------------

describe('cutover-provider -- get()', () => {
  it('returns the spaces-api-shaped item', async () => {
    r.upsertItem({ id: 'i1', type: 'text', space_id: 's1', preview: 'hi' });
    const item = await provider.get('s1', 'i1');
    expect(item).toMatchObject({ id: 'i1', spaceId: 's1', preview: 'hi' });
  });

  it('returns null for unknown itemId', async () => {
    expect(await provider.get('s1', 'nonexistent')).toBeNull();
  });

  it('returns null when the item exists in a different space (cross-space miss)', async () => {
    r.upsertItem({ id: 'i1', type: 'text', space_id: 's1' });
    expect(await provider.get('s2', 'i1')).toBeNull();
    // Same id with the correct space resolves.
    expect(await provider.get('s1', 'i1')).not.toBeNull();
  });

  it('falsy spaceId still returns the item (no cross-space gate)', async () => {
    r.upsertItem({ id: 'i1', type: 'text', space_id: 's1' });
    expect((await provider.get(null, 'i1')).id).toBe('i1');
  });
});

// ---------------------------------------------------------------------------
// findItems
// ---------------------------------------------------------------------------

describe('cutover-provider -- findItems()', () => {
  it('union (any-tag match) by default', async () => {
    r.upsertItem({ id: 'a', type: 'text', tags: ['x'] });
    r.upsertItem({ id: 'b', type: 'text', tags: ['y'] });
    r.upsertItem({ id: 'c', type: 'text', tags: ['z'] });
    const items = await provider.findItems(['x', 'y'], {});
    expect(items.map((i) => i.id).sort()).toEqual(['a', 'b']);
  });

  it('matchAll requires every tag', async () => {
    r.upsertItem({ id: 'a', type: 'text', tags: ['x', 'y'] });
    r.upsertItem({ id: 'b', type: 'text', tags: ['x'] });
    r.upsertItem({ id: 'c', type: 'text', tags: ['x', 'y', 'z'] });
    const items = await provider.findItems(['x', 'y'], { matchAll: true });
    expect(items.map((i) => i.id).sort()).toEqual(['a', 'c']);
  });

  it('forwards spaceId + limit options', async () => {
    r.upsertItem({ id: 'a', type: 'text', space_id: 's1', tags: ['t'] });
    r.upsertItem({ id: 'b', type: 'text', space_id: 's2', tags: ['t'] });
    const items = await provider.findItems(['t'], { spaceId: 's1' });
    expect(items.map((i) => i.id)).toEqual(['a']);
  });

  it('returns [] for empty / null tags', async () => {
    expect(await provider.findItems([], {})).toEqual([]);
    expect(await provider.findItems(null, {})).toEqual([]);
  });

  it('returns spaces-api-shaped items', async () => {
    r.upsertItem({ id: 'a', type: 'image', tags: ['t'], file_name: 'pic.jpg' });
    const [item] = await provider.findItems(['t'], {});
    expect(item.fileName).toBe('pic.jpg'); // camelCase
    expect(item).not.toHaveProperty('vc');
  });
});

// ---------------------------------------------------------------------------
// listSmartFolders
// ---------------------------------------------------------------------------

describe('cutover-provider -- listSmartFolders()', () => {
  it('returns folders in spaces-api shape (camelCase timestamps + criteria parsed)', async () => {
    r.upsertSmartFolder({
      id: 'sf1', name: 'My Folder', icon: 'star', color: '#ff0',
      criteria: { tags: ['important'] },
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-04-01T00:00:00Z',
    });
    const result = await provider.listSmartFolders();
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: 'sf1', name: 'My Folder', icon: 'star', color: '#ff0',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-04-01T00:00:00Z',
    });
    expect(result[0].criteria).toEqual({ tags: ['important'] });
  });

  it('returns [] when no folders exist', async () => {
    expect(await provider.listSmartFolders()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Counters + inspect()
// ---------------------------------------------------------------------------

describe('cutover-provider -- counters + inspect()', () => {
  it('per-method counters tick on every call', async () => {
    r.upsertItem({ id: 'i1', type: 'text', space_id: 's1' });
    await provider.list('s1', {});
    await provider.list('s1', {});
    await provider.get('s1', 'i1');
    const snap = provider.inspect();
    expect(snap.perMethod.list.calls).toBe(2);
    expect(snap.perMethod.get.calls).toBe(1);
  });

  it('errors counter ticks when the underlying replica throws', async () => {
    // Force a throw by closing the DB.
    r.close();
    let threw = false;
    try { await provider.list('s1', {}); } catch (_e) { threw = true; }
    expect(threw).toBe(true);
    expect(provider.inspect().perMethod.list.errors).toBe(1);
    // Avoid afterEach trying to close again.
    r._opened = false;
  });

  it('inspect() returns a snapshot with replica reference', () => {
    const snap = provider.inspect();
    expect(snap.replica).toMatchObject({
      dbPath: ':memory:', tenantId: 'default', deviceId: 'd',
    });
    expect(snap.builtAt).toMatch(/^\d{4}-\d{2}/);
  });
});

// ---------------------------------------------------------------------------
// Pure helper
// ---------------------------------------------------------------------------

describe('_replicaRowToSpacesItem -- pure helper', () => {
  it('translates snake_case columns to camelCase + native booleans', () => {
    const row = {
      id: 'i1', type: 'text', space_id: 's1', timestamp: 100,
      preview: 'p', file_name: 'f.txt', file_size: 10,
      is_screenshot: 1, pinned: 0,
      content_path: '/a', thumbnail_path: '/t', metadata_path: '/m',
      tags: ['x', 'y'],
      json_subtype: null, source: 'clip', metadata_source: 'auto',
      created_at: '2026-01-01', modified_at: '2026-04-01',
    };
    const out = _replicaRowToSpacesItem(row);
    expect(out).toMatchObject({
      id: 'i1', spaceId: 's1', isScreenshot: true, pinned: false,
      fileName: 'f.txt', fileSize: 10,
      contentPath: '/a', thumbnailPath: '/t', metadataPath: '/m',
      createdAt: '2026-01-01', modifiedAt: '2026-04-01',
      metadataSource: 'auto', jsonSubtype: null,
    });
  });

  it('parses a tags JSON-string column when array hydration missed it', () => {
    const row = { id: 'i1', type: 'text', tags: '["a","b"]' };
    expect(_replicaRowToSpacesItem(row).tags).toEqual(['a', 'b']);
  });

  it('returns null/undefined unchanged', () => {
    expect(_replicaRowToSpacesItem(null)).toBeNull();
    expect(_replicaRowToSpacesItem(undefined)).toBeUndefined();
  });

  it('omits replica-internal fields', () => {
    const row = {
      id: 'i1', type: 'text',
      vc: '{}', content_hash: 'h', deleted_at: null, deleted_by: null,
      has_parked_precursor: 0, tenant_id: 'default', active: 1,
    };
    const out = _replicaRowToSpacesItem(row);
    expect(out).not.toHaveProperty('vc');
    expect(out).not.toHaveProperty('content_hash');
    expect(out).not.toHaveProperty('deleted_at');
    expect(out).not.toHaveProperty('tenant_id');
    expect(out).not.toHaveProperty('has_parked_precursor');
    expect(out).not.toHaveProperty('active');
  });
});
