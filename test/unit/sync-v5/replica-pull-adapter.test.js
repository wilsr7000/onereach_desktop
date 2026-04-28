/**
 * Unit tests for lib/sync-v5/replica/pull-adapter.js
 *
 * Covers the localLookupFn + localApplyFn that connect the v5 pull
 * engine to the materialised replica. Strategy: real (in-memory)
 * Replica + buildPullEngineAdapter; emit synthetic apply args at the
 * adapter and assert replica state.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const { Replica } = require('../../../lib/sync-v5/replica/replica');
const {
  buildPullEngineAdapter,
  _replicaItemToPullVersion,
  _replicaSpaceToPullVersion,
  _parseVc,
  _highestVcDevice,
  ASSET_UPSERT_OPS,
  ASSET_DELETE_OPS,
} = require('../../../lib/sync-v5/replica/pull-adapter');

let r = null;
let adapter = null;

beforeEach(() => {
  r = new Replica({ dbPath: ':memory:', tenantId: 'default', deviceId: 'local-dev' }).init();
  adapter = buildPullEngineAdapter({ replica: r });
});

afterEach(() => {
  if (r) try { r.close(); } catch (_e) { /* ok */ }
  r = null;
  adapter = null;
});

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

describe('buildPullEngineAdapter -- construction', () => {
  it('throws if replica is missing', () => {
    expect(() => buildPullEngineAdapter({})).toThrow(/replica is required/);
  });

  it('returns the documented surface (localLookupFn + localApplyFn + inspect)', () => {
    expect(typeof adapter.localLookupFn).toBe('function');
    expect(typeof adapter.localApplyFn).toBe('function');
    expect(typeof adapter.inspect).toBe('function');
  });

  it('exposes the op-type constants matching sync-engine.js', () => {
    expect(ASSET_UPSERT_OPS).toContain('asset.upsert');
    expect(ASSET_UPSERT_OPS).toContain('asset.update');
    expect(ASSET_UPSERT_OPS).toContain('asset.merge');
    expect(ASSET_DELETE_OPS).toContain('asset.delete');
  });
});

// ---------------------------------------------------------------------------
// localLookupFn
// ---------------------------------------------------------------------------

describe('localLookupFn -- read-side', () => {
  it('returns null for unknown entityId', async () => {
    expect(await adapter.localLookupFn('nonexistent')).toBeNull();
  });

  it('returns null for falsy entityId', async () => {
    expect(await adapter.localLookupFn(null)).toBeNull();
    expect(await adapter.localLookupFn('')).toBeNull();
  });

  it('returns the documented {vc, payload, authorDeviceId, authoredAt} shape for an item', async () => {
    r.upsertItem({
      id: 'i1', type: 'text', space_id: 's1',
      preview: 'hi', vc: { 'remote-dev': 3 },
      modified_at: '2026-04-27T00:00:00Z',
    });
    const v = await adapter.localLookupFn('i1');
    expect(v).toMatchObject({
      vc: { 'remote-dev': 3 },
      authorDeviceId: 'remote-dev',
      authoredAt: '2026-04-27T00:00:00Z',
    });
    expect(v.payload.type).toBe('text');
    expect(v.payload.space_id).toBe('s1');
    expect(v.payload.preview).toBe('hi');
  });

  it('returns spaces too (entityId may be a space)', async () => {
    r.upsertSpace({ id: 's1', name: 'Inbox', vc: { 'devA': 5 } });
    const v = await adapter.localLookupFn('s1');
    expect(v).toMatchObject({
      vc: { 'devA': 5 },
      authorDeviceId: 'devA',
    });
    expect(v.payload.name).toBe('Inbox');
  });

  it('returns null on replica throw (treat as miss; do not propagate)', async () => {
    r.close();
    expect(await adapter.localLookupFn('i1')).toBeNull();
    r._opened = false;
  });
});

// ---------------------------------------------------------------------------
// localApplyFn -- asset.upsert
// ---------------------------------------------------------------------------

describe('localApplyFn -- asset.upsert', () => {
  it('writes a new item with the remote vc verbatim (no local bump)', async () => {
    await adapter.localApplyFn({
      entityId: 'i1',
      opType: 'asset.upsert',
      version: {
        vc: { 'remote-dev': 7 },
        payload: { type: 'text', space_id: 's1', preview: 'hi', tags: ['t'] },
        authorDeviceId: 'remote-dev',
        authoredAt: '2026-04-27T12:00:00Z',
      },
      contentHash: 'a'.repeat(64),
    });
    const item = r.getItem('i1');
    expect(item).toMatchObject({ type: 'text', space_id: 's1', preview: 'hi' });
    expect(item.tags).toEqual(['t']);
    expect(item.content_hash).toBe('a'.repeat(64));
    expect(JSON.parse(r.getItemVc('i1'))).toEqual({ 'remote-dev': 7 });
  });

  it('asset.update + asset.merge are treated as upserts', async () => {
    await adapter.localApplyFn({
      entityId: 'i1', opType: 'asset.update',
      version: { vc: { d: 1 }, payload: { type: 'text' } },
    });
    await adapter.localApplyFn({
      entityId: 'i2', opType: 'asset.merge',
      version: { vc: { d: 2 }, payload: { type: 'text' } },
    });
    expect(r.getItem('i1')).not.toBeNull();
    expect(r.getItem('i2')).not.toBeNull();
  });

  it('idempotent: applying the same op twice produces the same row', async () => {
    const args = {
      entityId: 'i1', opType: 'asset.upsert',
      version: { vc: { d: 1 }, payload: { type: 'text', space_id: 's1' } },
    };
    await adapter.localApplyFn(args);
    await adapter.localApplyFn(args);
    expect(r.getItem('i1')).not.toBeNull();
    expect(JSON.parse(r.getItemVc('i1'))).toEqual({ d: 1 });
  });

  it('counters increment + perOpType breakdown', async () => {
    await adapter.localApplyFn({
      entityId: 'i1', opType: 'asset.upsert',
      version: { vc: { d: 1 }, payload: { type: 'text' } },
    });
    await adapter.localApplyFn({
      entityId: 'i2', opType: 'asset.update',
      version: { vc: { d: 1 }, payload: { type: 'text' } },
    });
    const snap = adapter.inspect();
    expect(snap.applied).toBe(2);
    expect(snap.perOpType['asset.upsert'].applied).toBe(1);
    expect(snap.perOpType['asset.update'].applied).toBe(1);
  });

  it('sets created_at/modified_at from version.authoredAt when payload omits them', async () => {
    await adapter.localApplyFn({
      entityId: 'i1', opType: 'asset.upsert',
      version: {
        vc: { d: 1 },
        payload: { type: 'text' },
        authoredAt: '2026-04-01T00:00:00Z',
      },
    });
    const item = r.getItem('i1');
    expect(item.created_at).toBe('2026-04-01T00:00:00Z');
    expect(item.modified_at).toBe('2026-04-01T00:00:00Z');
  });
});

// ---------------------------------------------------------------------------
// localApplyFn -- asset.delete
// ---------------------------------------------------------------------------

describe('localApplyFn -- asset.delete', () => {
  it('soft-deletes an existing item', async () => {
    r.upsertItem({ id: 'i1', type: 'text' });
    await adapter.localApplyFn({
      entityId: 'i1', opType: 'asset.delete',
      version: {
        vc: { 'remote-dev': 8 },
        payload: {},
        authorDeviceId: 'remote-dev',
        authoredAt: '2026-04-27T13:00:00Z',
      },
    });
    const raw = r.db.prepare('SELECT active, deleted_by, deleted_at, vc FROM items WHERE id = ?').get('i1');
    expect(raw.active).toBe(0);
    expect(raw.deleted_by).toBe('remote-dev');
    expect(raw.deleted_at).toBe('2026-04-27T13:00:00Z');
    expect(JSON.parse(raw.vc)).toEqual({ 'remote-dev': 8 });
  });

  it('idempotent: delete on already-tombstoned row is a no-op', async () => {
    r.upsertItem({ id: 'i1', type: 'text', active: false, deleted_at: '2026-01-01', deleted_by: 'a' });
    await adapter.localApplyFn({
      entityId: 'i1', opType: 'asset.delete',
      version: { vc: { d: 1 }, payload: {}, authorDeviceId: 'b' },
    });
    // softDeleteItem returns false when the row was already inactive,
    // but the adapter treats that as success (no throw).
    expect(adapter.inspect().tombstoned).toBe(1);
  });

  it('counter increments tombstoned counter', async () => {
    r.upsertItem({ id: 'i1', type: 'text' });
    await adapter.localApplyFn({
      entityId: 'i1', opType: 'asset.delete',
      version: { vc: { d: 1 }, payload: {}, authorDeviceId: 'd' },
    });
    expect(adapter.inspect().tombstoned).toBe(1);
    expect(adapter.inspect().applied).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Unknown opType + errors
// ---------------------------------------------------------------------------

describe('localApplyFn -- unknown opType', () => {
  it('skips with a warn (does not throw) and counters increment skipped', async () => {
    await adapter.localApplyFn({
      entityId: 'i1', opType: 'foo.bar.qux',
      version: { vc: {}, payload: {} },
    });
    expect(adapter.inspect().skipped).toBe(1);
    expect(adapter.inspect().applied).toBe(0);
    expect(adapter.inspect().tombstoned).toBe(0);
  });

  it('throws when opType is missing', async () => {
    await expect(adapter.localApplyFn({ entityId: 'i1', version: {} }))
      .rejects.toThrow(/opType is required/);
    expect(adapter.inspect().errors).toBe(1);
  });

  it('rethrows on replica write failure (so pull engine logs/counts)', async () => {
    r.close();
    let threw = false;
    try {
      await adapter.localApplyFn({
        entityId: 'i1', opType: 'asset.upsert',
        version: { vc: {}, payload: { type: 'text' } },
      });
    } catch (_e) { threw = true; }
    expect(threw).toBe(true);
    expect(adapter.inspect().errors).toBe(1);
    r._opened = false;
  });
});

// ---------------------------------------------------------------------------
// inspect()
// ---------------------------------------------------------------------------

describe('buildPullEngineAdapter -- inspect()', () => {
  it('returns expected shape with replica reference + perOpType counters', () => {
    const snap = adapter.inspect();
    expect(snap).toMatchObject({
      applied: 0, tombstoned: 0, skipped: 0, errors: 0,
      lastApplyAt: null, lastOpType: null,
    });
    expect(snap.builtAt).toMatch(/^\d{4}-\d{2}/);
    expect(snap.replica).toMatchObject({ dbPath: ':memory:', tenantId: 'default' });
  });

  it('lastApplyAt + lastOpType update on every successful apply', async () => {
    await adapter.localApplyFn({
      entityId: 'i1', opType: 'asset.upsert',
      version: { vc: { d: 1 }, payload: { type: 'text' } },
    });
    const snap = adapter.inspect();
    expect(snap.lastOpType).toBe('asset.upsert');
    expect(snap.lastApplyAt).toMatch(/^\d{4}-\d{2}/);
  });
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('_replicaItemToPullVersion', () => {
  it('produces the documented shape', () => {
    const v = _replicaItemToPullVersion({
      id: 'i1', type: 'text', space_id: 's1', timestamp: 100,
      preview: 'hi', tags: ['x'], pinned: 1, is_screenshot: 0,
      vc: '{"d":3}', modified_at: '2026-04-01',
      created_at: '2026-01-01',
    });
    expect(v.vc).toEqual({ d: 3 });
    expect(v.authoredAt).toBe('2026-04-01');
    expect(v.authorDeviceId).toBe('d');
    expect(v.payload).toMatchObject({
      type: 'text', space_id: 's1', preview: 'hi', pinned: true,
      is_screenshot: false,
    });
  });
});

describe('_replicaSpaceToPullVersion', () => {
  it('produces the documented shape', () => {
    const v = _replicaSpaceToPullVersion({
      id: 's1', name: 'Inbox', is_system: 1, vc: '{"d":2}',
      updated_at: '2026-04-01',
    });
    expect(v.vc).toEqual({ d: 2 });
    expect(v.payload.name).toBe('Inbox');
    expect(v.payload.is_system).toBe(true);
  });
});

describe('_parseVc', () => {
  it('parses JSON', () => {
    expect(_parseVc('{"a":1}')).toEqual({ a: 1 });
  });
  it('returns object input unchanged', () => {
    expect(_parseVc({ a: 1 })).toEqual({ a: 1 });
  });
  it('returns {} for null / empty / invalid', () => {
    expect(_parseVc(null)).toEqual({});
    expect(_parseVc('')).toEqual({});
    expect(_parseVc('not-json')).toEqual({});
  });
});

describe('_highestVcDevice', () => {
  it('returns the device with the highest counter', () => {
    expect(_highestVcDevice({ a: 1, b: 5, c: 3 })).toBe('b');
  });
  it('returns null for empty clock', () => {
    expect(_highestVcDevice({})).toBeNull();
    expect(_highestVcDevice(null)).toBeNull();
  });
  it('ignores non-numeric counters defensively', () => {
    expect(_highestVcDevice({ a: 'oops', b: 2 })).toBe('b');
  });
});
