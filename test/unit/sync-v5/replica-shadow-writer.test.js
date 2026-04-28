/**
 * Unit tests for lib/sync-v5/replica/shadow-writer.js
 *
 * Strategy: real (in-memory) Replica + a tiny event-emitter fake
 * that mirrors SpacesAPI's `.on(event, cb) -> unsubscribe` contract.
 * Each test exercises one event, asserts the replica reflects the
 * change, and verifies the per-event counters incremented.
 *
 * Coverage:
 *   - 15 events handled correctly (one happy-path test each)
 *   - VC bump on every write (vc[deviceId] increments by 1)
 *   - Counters: per-event writes, errors, lastWriteAt, lastWriteEvent
 *   - detach() unsubscribes (no further mirror after detach)
 *   - inspect() shape + replica reference
 *   - Failure isolation: a handler throw increments errors but does
 *     not propagate
 *   - Divergence handling: events for items the replica doesn't
 *     have synthesise minimal rows
 *   - Argument validation
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const { Replica, _bumpVcJson } = require('../../../lib/sync-v5/replica/replica');
const {
  attachShadowWriter,
  _parseTagsArray,
} = require('../../../lib/sync-v5/replica/shadow-writer');

// ---------------------------------------------------------------------------
// Fake SpacesAPI -- minimal event emitter matching the real .on()/_emit()
// contract.
// ---------------------------------------------------------------------------

function fakeSpacesApi() {
  const listeners = new Map();
  return {
    on(event, cb) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(cb);
      return () => {
        const set = listeners.get(event);
        if (set) set.delete(cb);
      };
    },
    _emit(event, payload) {
      const set = listeners.get(event);
      if (!set) return;
      for (const cb of set) {
        try { cb(payload); } catch (_e) { /* mirrors real swallow */ }
      }
    },
    _listenerCount(event) {
      return (listeners.get(event) || new Set()).size;
    },
    _listeners: listeners,
  };
}

let r = null;
let api = null;
let writer = null;

beforeEach(() => {
  r = new Replica({ dbPath: ':memory:', tenantId: 'default', deviceId: 'dev-A' }).init();
  api = fakeSpacesApi();
  writer = attachShadowWriter({ spacesApi: api, replica: r, deviceId: 'dev-A' });
});

afterEach(() => {
  if (writer) try { writer.detach(); } catch (_e) { /* ok */ }
  if (r) try { r.close(); } catch (_e) { /* ok */ }
  r = null;
  api = null;
  writer = null;
});

// ---------------------------------------------------------------------------
// Argument validation
// ---------------------------------------------------------------------------

describe('attachShadowWriter -- argument validation', () => {
  it('throws if spacesApi is missing or has no .on()', () => {
    expect(() => attachShadowWriter({ replica: r, deviceId: 'd' }))
      .toThrow(/spacesApi.*\.on/);
    expect(() => attachShadowWriter({ spacesApi: {}, replica: r, deviceId: 'd' }))
      .toThrow(/spacesApi.*\.on/);
  });

  it('throws if replica is missing', () => {
    expect(() => attachShadowWriter({ spacesApi: api, deviceId: 'd' }))
      .toThrow(/replica is required/);
  });

  it('throws if deviceId is missing', () => {
    expect(() => attachShadowWriter({ spacesApi: api, replica: r }))
      .toThrow(/deviceId is required/);
  });
});

// ---------------------------------------------------------------------------
// Spaces events
// ---------------------------------------------------------------------------

describe('shadow-writer -- space events', () => {
  it('space:created mirrors to replica with vc bumped', () => {
    api._emit('space:created', { space: { id: 's1', name: 'Inbox' } });
    expect(r.getSpace('s1')).toMatchObject({ id: 's1', name: 'Inbox', active: 1 });
    const vc = JSON.parse(r.getSpaceVc('s1'));
    expect(vc).toEqual({ 'dev-A': 1 });
  });

  it('space:updated merges data + bumps vc', () => {
    api._emit('space:created', { space: { id: 's1', name: 'Old' } });
    api._emit('space:updated', { spaceId: 's1', data: { name: 'New', icon: 'x' } });
    const sp = r.getSpace('s1');
    expect(sp.name).toBe('New');
    expect(sp.icon).toBe('x');
    expect(JSON.parse(sp.vc)).toEqual({ 'dev-A': 2 });
  });

  it('space:updated synthesises a row when replica is missing the space (divergence)', () => {
    api._emit('space:updated', { spaceId: 's-new', data: { name: 'Hello' } });
    const sp = r.getSpace('s-new');
    expect(sp).not.toBeNull();
    expect(sp.name).toBe('Hello');
    expect(JSON.parse(sp.vc)).toEqual({ 'dev-A': 1 });
  });

  it('space:deleted soft-deletes (active=0, deleted_at + deleted_by set)', () => {
    api._emit('space:created', { space: { id: 's1', name: 'X' } });
    api._emit('space:deleted', { spaceId: 's1' });
    const sp = r.getSpace('s1');
    expect(sp.active).toBe(0);
    expect(sp.deleted_by).toBe('dev-A');
    expect(sp.deleted_at).toMatch(/^\d{4}-\d{2}/);
    expect(JSON.parse(sp.vc)).toEqual({ 'dev-A': 2 });
  });

  it('space:deleted is a no-op when the space is missing', () => {
    api._emit('space:deleted', { spaceId: 's-nonexistent' });
    expect(r.getSpace('s-nonexistent')).toBeNull();
    // No error counter increment -- soft-delete returning false is normal.
    expect(writer.inspect().errors).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Item events
// ---------------------------------------------------------------------------

describe('shadow-writer -- item events', () => {
  it('item:added mirrors to replica with vc bumped', () => {
    api._emit('item:added', {
      spaceId: 's1', item: { id: 'i1', type: 'text', preview: 'hello', tags: ['a'] },
    });
    const it = r.getItem('i1');
    expect(it).toMatchObject({ type: 'text', preview: 'hello', space_id: 's1' });
    expect(it.tags).toEqual(['a']);
    expect(JSON.parse(r.getItemVc('i1'))).toEqual({ 'dev-A': 1 });
  });

  it('item:updated merges patch + bumps vc + preserves space_id', () => {
    api._emit('item:added', { spaceId: 's1', item: { id: 'i1', type: 'text', preview: 'old' } });
    api._emit('item:updated', { spaceId: 's1', itemId: 'i1', data: { preview: 'new', pinned: true } });
    const it = r.getItem('i1');
    expect(it.preview).toBe('new');
    expect(it.pinned).toBe(true);
    expect(it.space_id).toBe('s1');
    expect(JSON.parse(r.getItemVc('i1'))).toEqual({ 'dev-A': 2 });
  });

  it('item:updated synthesises minimal row on divergence', () => {
    api._emit('item:updated', { spaceId: 's1', itemId: 'i-new', data: { type: 'image' } });
    const it = r.getItem('i-new');
    expect(it).not.toBeNull();
    expect(it.type).toBe('image');
    expect(it.space_id).toBe('s1');
  });

  it('item:deleted soft-deletes and bumps vc', () => {
    api._emit('item:added', { spaceId: 's1', item: { id: 'i1', type: 'text' } });
    api._emit('item:deleted', { spaceId: 's1', itemId: 'i1' });
    const raw = r.db.prepare('SELECT active, deleted_by, vc FROM items WHERE id = ?').get('i1');
    expect(raw.active).toBe(0);
    expect(raw.deleted_by).toBe('dev-A');
    expect(JSON.parse(raw.vc)).toEqual({ 'dev-A': 2 });
  });

  it('item:deleted on missing item is a no-op (no error)', () => {
    api._emit('item:deleted', { itemId: 'i-nonexistent' });
    expect(writer.inspect().errors).toBe(0);
  });

  it('items:bulk-deleted soft-deletes each item', () => {
    api._emit('item:added', { spaceId: 's1', item: { id: 'a', type: 'text' } });
    api._emit('item:added', { spaceId: 's1', item: { id: 'b', type: 'text' } });
    api._emit('item:added', { spaceId: 's1', item: { id: 'c', type: 'text' } });
    api._emit('items:bulk-deleted', { spaceId: 's1', itemIds: ['a', 'b'], count: 2 });
    expect(r.db.prepare('SELECT active FROM items WHERE id = ?').get('a').active).toBe(0);
    expect(r.db.prepare('SELECT active FROM items WHERE id = ?').get('b').active).toBe(0);
    expect(r.db.prepare('SELECT active FROM items WHERE id = ?').get('c').active).toBe(1);
  });

  it('items:bulk-deleted handles empty / malformed itemIds gracefully', () => {
    api._emit('items:bulk-deleted', { spaceId: 's1', itemIds: null });
    api._emit('items:bulk-deleted', { spaceId: 's1', itemIds: [] });
    expect(writer.inspect().errors).toBe(0);
  });

  it('item:moved updates space_id + bumps vc', () => {
    api._emit('item:added', { spaceId: 's1', item: { id: 'i1', type: 'text' } });
    api._emit('item:moved', { itemId: 'i1', fromSpaceId: 's1', toSpaceId: 's2' });
    expect(r.getItem('i1').space_id).toBe('s2');
    expect(JSON.parse(r.getItemVc('i1'))).toEqual({ 'dev-A': 2 });
  });

  it('item:moved synthesises a minimal row when missing (divergence)', () => {
    api._emit('item:moved', { itemId: 'i-orphan', fromSpaceId: 's1', toSpaceId: 's2' });
    expect(r.getItem('i-orphan').space_id).toBe('s2');
  });

  it('items:bulk-moved updates space_id for each item', () => {
    api._emit('item:added', { spaceId: 's1', item: { id: 'a', type: 'text' } });
    api._emit('item:added', { spaceId: 's1', item: { id: 'b', type: 'text' } });
    api._emit('items:bulk-moved', { itemIds: ['a', 'b'], fromSpaceId: 's1', toSpaceId: 's2', count: 2 });
    expect(r.getItem('a').space_id).toBe('s2');
    expect(r.getItem('b').space_id).toBe('s2');
  });
});

// ---------------------------------------------------------------------------
// Tag events
// ---------------------------------------------------------------------------

describe('shadow-writer -- tag events', () => {
  it('item:tags:updated replaces tags + bumps vc', () => {
    api._emit('item:added', { spaceId: 's1', item: { id: 'i1', type: 'text', tags: ['old'] } });
    api._emit('item:tags:updated', { spaceId: 's1', itemId: 'i1', tags: ['new1', 'new2'] });
    expect(r.listItemTags('i1').sort()).toEqual(['new1', 'new2']);
    expect(JSON.parse(r.getItemVc('i1'))).toEqual({ 'dev-A': 2 });
  });

  it('tags:renamed sweeps items in the space', () => {
    api._emit('item:added', { spaceId: 's1', item: { id: 'a', type: 'text', tags: ['old', 'keep'] } });
    api._emit('item:added', { spaceId: 's1', item: { id: 'b', type: 'text', tags: ['old'] } });
    api._emit('item:added', { spaceId: 's1', item: { id: 'c', type: 'text', tags: ['unrelated'] } });
    api._emit('tags:renamed', { spaceId: 's1', oldTag: 'old', newTag: 'fresh', count: 2 });
    expect(r.listItemTags('a').sort()).toEqual(['fresh', 'keep']);
    expect(r.listItemTags('b')).toEqual(['fresh']);
    expect(r.listItemTags('c')).toEqual(['unrelated']);
  });

  it('tags:renamed dedupes when the new tag was already present', () => {
    api._emit('item:added', { spaceId: 's1', item: { id: 'a', type: 'text', tags: ['old', 'fresh'] } });
    api._emit('tags:renamed', { spaceId: 's1', oldTag: 'old', newTag: 'fresh', count: 1 });
    expect(r.listItemTags('a')).toEqual(['fresh']);
  });

  it('tags:deleted strips the tag from items in the space', () => {
    api._emit('item:added', { spaceId: 's1', item: { id: 'a', type: 'text', tags: ['drop', 'keep'] } });
    api._emit('item:added', { spaceId: 's1', item: { id: 'b', type: 'text', tags: ['drop'] } });
    api._emit('tags:deleted', { spaceId: 's1', tag: 'drop', count: 2 });
    expect(r.listItemTags('a')).toEqual(['keep']);
    expect(r.listItemTags('b')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Smart folders
// ---------------------------------------------------------------------------

describe('shadow-writer -- smart folder events', () => {
  it('smartFolder:created upserts the folder', () => {
    api._emit('smartFolder:created', {
      folder: { id: 'sf1', name: 'My Smart Folder', criteria: { tags: ['x'] } },
    });
    const sf = r.getSmartFolder('sf1');
    expect(sf).toMatchObject({ id: 'sf1', name: 'My Smart Folder' });
    expect(sf.criteria).toEqual({ tags: ['x'] });
  });

  it('smartFolder:updated merges updates onto existing', () => {
    api._emit('smartFolder:created', { folder: { id: 'sf1', name: 'A', criteria: {} } });
    api._emit('smartFolder:updated', { folderId: 'sf1', updates: { name: 'B', icon: 'star' } });
    expect(r.getSmartFolder('sf1')).toMatchObject({ id: 'sf1', name: 'B', icon: 'star' });
  });

  it('smartFolder:updated synthesises when folder is missing', () => {
    api._emit('smartFolder:updated', { folderId: 'sf-new', updates: { name: 'Hello' } });
    expect(r.getSmartFolder('sf-new')).toMatchObject({ id: 'sf-new', name: 'Hello' });
  });

  it('smartFolder:deleted hard-deletes', () => {
    api._emit('smartFolder:created', { folder: { id: 'sf1', name: 'X', criteria: {} } });
    api._emit('smartFolder:deleted', { folderId: 'sf1' });
    expect(r.getSmartFolder('sf1')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Counters + inspect()
// ---------------------------------------------------------------------------

describe('shadow-writer -- counters + inspect()', () => {
  it('writes counter increments on every successful event', () => {
    api._emit('item:added', { spaceId: 's1', item: { id: 'i1', type: 'text' } });
    api._emit('item:added', { spaceId: 's1', item: { id: 'i2', type: 'text' } });
    expect(writer.inspect().writes).toBe(2);
  });

  it('per-event counters separate writes by event name', () => {
    api._emit('space:created', { space: { id: 's1', name: 'A' } });
    api._emit('item:added', { spaceId: 's1', item: { id: 'i1', type: 'text' } });
    api._emit('item:added', { spaceId: 's1', item: { id: 'i2', type: 'text' } });
    const snap = writer.inspect();
    expect(snap.perEvent['space:created'].writes).toBe(1);
    expect(snap.perEvent['item:added'].writes).toBe(2);
  });

  it('lastWriteEvent + lastWriteAt update on every successful event', () => {
    expect(writer.inspect().lastWriteEvent).toBeNull();
    api._emit('space:created', { space: { id: 's1', name: 'A' } });
    const snap = writer.inspect();
    expect(snap.lastWriteEvent).toBe('space:created');
    expect(snap.lastWriteAt).toMatch(/^\d{4}-\d{2}/);
  });

  it('errors counter increments on handler throw; error does NOT propagate', () => {
    // Emit a payload that triggers a throw: replica will reject id-less item.
    expect(() => api._emit('item:added', { spaceId: 's1', item: { type: 'text' /* no id */ } })).not.toThrow();
    // Whoops -- shadow-writer's onItemAdded silently returns when item.id is
    // missing (defensive). Use a different path: smartFolder:created with no id
    // also returns silently. To force an actual error, close the replica
    // mid-flight and emit.
    r.close();
    expect(() => api._emit('item:added', { spaceId: 's1', item: { id: 'i9', type: 'text' } })).not.toThrow();
    const snap = writer.inspect();
    expect(snap.errors).toBeGreaterThan(0);
    expect(snap.lastError).toBeTruthy();
    expect(snap.lastError.event).toBe('item:added');
    // Re-init for afterEach.
    r._opened = false;
  });

  it('inspect() returns shape with replica reference + eventsHandled', () => {
    const snap = writer.inspect();
    expect(snap).toMatchObject({
      writes: 0,
      errors: 0,
      eventsHandled: 15,
      replica: { dbPath: ':memory:', tenantId: 'default', deviceId: 'dev-A' },
    });
    expect(snap.attachedAt).toMatch(/^\d{4}-\d{2}/);
    expect(snap.detachedAt).toBeNull();
  });

  it('inspect() returns a snapshot, not a live reference (mutating it does not affect counters)', () => {
    const snap = writer.inspect();
    snap.writes = 9999;
    expect(writer.inspect().writes).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// detach()
// ---------------------------------------------------------------------------

describe('shadow-writer -- detach()', () => {
  it('detach() unsubscribes every listener', () => {
    expect(api._listenerCount('item:added')).toBe(1);
    expect(api._listenerCount('space:created')).toBe(1);
    writer.detach();
    expect(api._listenerCount('item:added')).toBe(0);
    expect(api._listenerCount('space:created')).toBe(0);
  });

  it('after detach() further events are not mirrored', () => {
    api._emit('item:added', { spaceId: 's1', item: { id: 'before', type: 'text' } });
    writer.detach();
    api._emit('item:added', { spaceId: 's1', item: { id: 'after', type: 'text' } });
    expect(r.getItem('before')).not.toBeNull();
    expect(r.getItem('after')).toBeNull();
  });

  it('detach() is idempotent', () => {
    writer.detach();
    expect(() => writer.detach()).not.toThrow();
  });

  it('detach() sets detachedAt in inspect()', () => {
    writer.detach();
    expect(writer.inspect().detachedAt).toMatch(/^\d{4}-\d{2}/);
  });
});

// ---------------------------------------------------------------------------
// Multi-write VC progression
// ---------------------------------------------------------------------------

describe('shadow-writer -- VC progression', () => {
  it('vc[deviceId] increments by exactly 1 per write event', () => {
    api._emit('item:added', { spaceId: 's1', item: { id: 'i1', type: 'text' } });
    expect(JSON.parse(r.getItemVc('i1'))).toEqual({ 'dev-A': 1 });
    api._emit('item:updated', { spaceId: 's1', itemId: 'i1', data: { preview: 'x' } });
    expect(JSON.parse(r.getItemVc('i1'))).toEqual({ 'dev-A': 2 });
    api._emit('item:tags:updated', { spaceId: 's1', itemId: 'i1', tags: ['t'] });
    expect(JSON.parse(r.getItemVc('i1'))).toEqual({ 'dev-A': 3 });
    api._emit('item:moved', { itemId: 'i1', fromSpaceId: 's1', toSpaceId: 's2' });
    expect(JSON.parse(r.getItemVc('i1'))).toEqual({ 'dev-A': 4 });
    api._emit('item:deleted', { itemId: 'i1' });
    expect(JSON.parse(r.getItemVc('i1'))).toEqual({ 'dev-A': 5 });
  });

  it('vc preserves other devices\' slots when this device writes', () => {
    // Simulate an item that already has a remote-device VC slot.
    r.upsertItem({ id: 'i1', type: 'text', vc: { 'dev-B': 7 } });
    api._emit('item:updated', { spaceId: 's1', itemId: 'i1', data: { preview: 'mine' } });
    expect(JSON.parse(r.getItemVc('i1'))).toEqual({ 'dev-B': 7, 'dev-A': 1 });
  });
});

// ---------------------------------------------------------------------------
// _bumpVcJson + _parseTagsArray pure helpers
// ---------------------------------------------------------------------------

describe('_bumpVcJson -- pure helper', () => {
  it('starts a fresh slot at 1', () => {
    expect(_bumpVcJson('{}', 'devA')).toBe('{"devA":1}');
  });

  it('increments existing slot by 1', () => {
    expect(_bumpVcJson('{"devA":3}', 'devA')).toBe('{"devA":4}');
  });

  it('preserves other devices\' slots', () => {
    expect(_bumpVcJson('{"devA":3}', 'devB')).toBe('{"devA":3,"devB":1}');
  });

  it('treats null / empty / malformed as empty clock', () => {
    expect(_bumpVcJson(null, 'd')).toBe('{"d":1}');
    expect(_bumpVcJson('', 'd')).toBe('{"d":1}');
    expect(_bumpVcJson('not-json', 'd')).toBe('{"d":1}');
  });

  it('accepts an object directly (not just JSON string)', () => {
    expect(_bumpVcJson({ devA: 2 }, 'devA')).toBe('{"devA":3}');
  });

  it('throws when deviceId is missing', () => {
    expect(() => _bumpVcJson('{}', '')).toThrow(/deviceId is required/);
    expect(() => _bumpVcJson('{}', null)).toThrow(/deviceId is required/);
  });
});

describe('_parseTagsArray -- pure helper', () => {
  it('returns input array unchanged', () => {
    expect(_parseTagsArray(['a', 'b'])).toEqual(['a', 'b']);
  });

  it('parses a JSON string', () => {
    expect(_parseTagsArray('["a","b"]')).toEqual(['a', 'b']);
  });

  it('returns [] for null / empty / malformed', () => {
    expect(_parseTagsArray(null)).toEqual([]);
    expect(_parseTagsArray('')).toEqual([]);
    expect(_parseTagsArray('not-json')).toEqual([]);
    expect(_parseTagsArray('{"not":"array"}')).toEqual([]);
  });
});
