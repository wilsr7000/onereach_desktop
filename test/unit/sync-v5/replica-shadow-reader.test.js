/**
 * Unit tests for lib/sync-v5/replica/shadow-reader.js
 *
 * Strategy: real (in-memory) Replica + real ValidationGate + a fake
 * SpacesAPI that mirrors the .on() / _emit() contract. Each test
 * emits a read event and asserts:
 *   - Gate counter ticked correctly
 *   - Divergence detected (or not) per the set/field comparison
 *   - Counters in inspect() reflect the comparison
 *   - Failure isolation: comparison errors don't propagate
 *   - Hot-path sampling skips deep comparison while still ticking
 *     the gate
 *
 * Comparison happens on setImmediate after the event, so tests
 * await one microtask to let it run.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const { Replica } = require('../../../lib/sync-v5/replica/replica');
const { ValidationGate } = require('../../../lib/sync-v5/replica/validation-gate');
const {
  attachShadowReader,
  compareById,
  compareItemFields,
  ITEM_FIELD_WHITELIST,
} = require('../../../lib/sync-v5/replica/shadow-reader');

function fakeSpacesApi() {
  const listeners = new Map();
  return {
    on(event, cb) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(cb);
      return () => listeners.get(event)?.delete(cb);
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
  };
}

/**
 * Wait for setImmediate work to complete.
 */
async function tick() {
  return new Promise((res) => setImmediate(() => setImmediate(res)));
}

let r = null;
let api = null;
let gate = null;
let reader = null;

beforeEach(() => {
  r = new Replica({ dbPath: ':memory:', tenantId: 'default', deviceId: 'dev-A' }).init();
  api = fakeSpacesApi();
  gate = new ValidationGate({ replica: r, persistDebounceMs: 0 }).init();
  reader = attachShadowReader({
    spacesApi: api,
    replica: r,
    gate,
    hotPathSampleRate: 1, // sample every event by default in tests
  });
});

afterEach(() => {
  if (reader) try { reader.detach(); } catch (_e) { /* ok */ }
  if (gate) try { gate.close(); } catch (_e) { /* ok */ }
  if (r) try { r.close(); } catch (_e) { /* ok */ }
  r = null; api = null; gate = null; reader = null;
});

// ---------------------------------------------------------------------------
// Argument validation
// ---------------------------------------------------------------------------

describe('attachShadowReader -- argument validation', () => {
  it('throws if spacesApi is missing or has no .on()', () => {
    expect(() => attachShadowReader({ replica: r, gate })).toThrow(/spacesApi.*\.on/);
    expect(() => attachShadowReader({ spacesApi: {}, replica: r, gate })).toThrow(/spacesApi.*\.on/);
  });
  it('throws if replica is missing', () => {
    expect(() => attachShadowReader({ spacesApi: api, gate })).toThrow(/replica is required/);
  });
  it('throws if gate is missing', () => {
    expect(() => attachShadowReader({ spacesApi: api, replica: r })).toThrow(/gate is required/);
  });
});

// ---------------------------------------------------------------------------
// items:listed -- equivalent + divergent + counter ticking
// ---------------------------------------------------------------------------

describe('shadow-reader -- items:listed', () => {
  it('ticks gate counter on every invocation (not only sampled)', async () => {
    api._emit('items:listed', { spaceId: 's1', options: {}, items: [] });
    api._emit('items:listed', { spaceId: 's1', options: {}, items: [] });
    api._emit('items:listed', { spaceId: 's1', options: {}, items: [] });
    await tick();
    expect(gate.evaluate().invocationGates.itemsList.actual).toBe(3);
  });

  it('records no divergence when primary and replica agree (set-by-id)', async () => {
    r.upsertSpace({ id: 's1', name: 'A' });
    r.upsertItem({ id: 'i1', type: 'text', space_id: 's1' });
    r.upsertItem({ id: 'i2', type: 'text', space_id: 's1' });
    api._emit('items:listed', {
      spaceId: 's1',
      options: {},
      items: [{ id: 'i1' }, { id: 'i2' }],
    });
    await tick();
    expect(gate.evaluate().divergences.total).toBe(0);
    expect(reader.inspect().perEvent['items:listed'].divergences).toBe(0);
  });

  it('records divergence when replica is missing an item', async () => {
    r.upsertSpace({ id: 's1', name: 'A' });
    r.upsertItem({ id: 'i1', type: 'text', space_id: 's1' });
    api._emit('items:listed', {
      spaceId: 's1',
      options: {},
      items: [{ id: 'i1' }, { id: 'i2-missing-in-replica' }],
    });
    await tick();
    const ev = gate.evaluate();
    expect(ev.divergences.total).toBeGreaterThan(0);
    expect(ev.divergences.byMethod.itemsList).toBeGreaterThan(0);
    const last = reader.inspect().lastDivergence;
    expect(last.event).toBe('items:listed');
    expect(last.onlyInPrimary).toContain('i2-missing-in-replica');
  });

  it('records divergence when replica has an extra item', async () => {
    r.upsertSpace({ id: 's1', name: 'A' });
    r.upsertItem({ id: 'i1', type: 'text', space_id: 's1' });
    r.upsertItem({ id: 'i-extra', type: 'text', space_id: 's1' });
    api._emit('items:listed', {
      spaceId: 's1',
      options: {},
      items: [{ id: 'i1' }],
    });
    await tick();
    expect(reader.inspect().lastDivergence.onlyInReplica).toContain('i-extra');
  });

  it('order differences alone do not register as divergence (set comparison)', async () => {
    r.upsertSpace({ id: 's1', name: 'A' });
    r.upsertItem({ id: 'i1', type: 'text', space_id: 's1', timestamp: 1 });
    r.upsertItem({ id: 'i2', type: 'text', space_id: 's1', timestamp: 2 });
    api._emit('items:listed', {
      spaceId: 's1',
      options: {},
      items: [{ id: 'i2' }, { id: 'i1' }], // reverse order from replica
    });
    await tick();
    expect(gate.evaluate().divergences.total).toBe(0);
  });

  it('ignores invocation when payload is malformed (no spaceId or items)', async () => {
    api._emit('items:listed', null);
    api._emit('items:listed', {});
    await tick();
    // Both bumped invocations counter (every call ticks), but comparison
    // didn't run because the deferred handler returned early.
    expect(reader.inspect().perEvent['items:listed'].invocations).toBe(2);
    expect(reader.inspect().perEvent['items:listed'].sampledComparisons).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// item:fetched
// ---------------------------------------------------------------------------

describe('shadow-reader -- item:fetched', () => {
  it('ticks gate counter on every invocation', async () => {
    api._emit('item:fetched', { itemId: 'i1', item: null });
    api._emit('item:fetched', { itemId: 'i2', item: null });
    await tick();
    expect(gate.evaluate().invocationGates.itemsGet.actual).toBe(2);
  });

  it('detects field-whitelist mismatch on a single item', async () => {
    r.upsertItem({ id: 'i1', type: 'text', preview: 'replica-has-this' });
    api._emit('item:fetched', {
      itemId: 'i1',
      item: { id: 'i1', type: 'text', preview: 'primary-has-different' },
    });
    await tick();
    const last = reader.inspect().lastDivergence;
    expect(last.event).toBe('item:fetched');
    expect(last.differences.find((d) => d.field === 'preview')).toBeTruthy();
  });

  it('matches snake_case (replica) to camelCase (primary) -- spaceId vs space_id', async () => {
    r.upsertItem({ id: 'i1', type: 'text', space_id: 's1' });
    // Primary uses camelCase (spacesApi convention).
    api._emit('item:fetched', {
      itemId: 'i1',
      item: { id: 'i1', type: 'text', spaceId: 's1' },
    });
    await tick();
    expect(gate.evaluate().divergences.total).toBe(0);
  });

  it('treats missing item on either side as divergence', async () => {
    api._emit('item:fetched', { itemId: 'i1', item: { id: 'i1', type: 'text' } });
    await tick();
    expect(reader.inspect().lastDivergence.reason).toBe('missing-in-replica');
  });

  it('tags-set comparison is case-insensitive and order-insensitive', async () => {
    r.upsertItem({ id: 'i1', type: 'text', tags: ['Alpha', 'Beta'] });
    api._emit('item:fetched', {
      itemId: 'i1',
      item: { id: 'i1', type: 'text', tags: ['BETA', 'alpha'] },
    });
    await tick();
    expect(gate.evaluate().divergences.total).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// items:findByTags + smartFolders:listed (cold path; always compare)
// ---------------------------------------------------------------------------

describe('shadow-reader -- cold-path events', () => {
  it('items:findByTags compares full set regardless of sample rate', async () => {
    // Use a high sampleRate that would skip hot-path comparison.
    reader.detach();
    reader = attachShadowReader({ spacesApi: api, replica: r, gate, hotPathSampleRate: 1000 });

    r.upsertItem({ id: 'i1', type: 'text', tags: ['x'] });
    r.upsertItem({ id: 'i2', type: 'text', tags: ['y'] });
    api._emit('items:findByTags', {
      tags: ['x'],
      options: {},
      items: [{ id: 'i1' }, { id: 'i-divergent' }],
    });
    await tick();
    // Cold path: comparison ran despite the high sample rate.
    expect(reader.inspect().perEvent['items:findByTags'].sampledComparisons).toBe(1);
  });

  it('smartFolders:listed compares set-by-id', async () => {
    r.upsertSmartFolder({ id: 'sf1', name: 'X', criteria: {} });
    r.upsertSmartFolder({ id: 'sf2', name: 'Y', criteria: {} });
    api._emit('smartFolders:listed', { folders: [{ id: 'sf1' }, { id: 'sf2' }] });
    await tick();
    expect(gate.evaluate().divergences.total).toBe(0);
    expect(gate.evaluate().invocationGates.smartFoldersList.actual).toBe(1);
  });

  it('smartFolders:listed records divergence on missing folder', async () => {
    r.upsertSmartFolder({ id: 'sf1', name: 'X', criteria: {} });
    api._emit('smartFolders:listed', { folders: [{ id: 'sf1' }, { id: 'sf-missing' }] });
    await tick();
    expect(reader.inspect().lastDivergence.event).toBe('smartFolders:listed');
  });
});

// ---------------------------------------------------------------------------
// search:completed -- count-only in commit D
// ---------------------------------------------------------------------------

describe('shadow-reader -- search:completed', () => {
  it('ticks search counter without running comparison', async () => {
    api._emit('search:completed', { query: 'hello', options: {}, results: [] });
    api._emit('search:completed', { query: 'world', options: {}, results: [] });
    await tick();
    expect(gate.evaluate().invocationGates.search.actual).toBe(2);
    expect(reader.inspect().perEvent['search:completed'].sampledComparisons).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Hot-path sampling
// ---------------------------------------------------------------------------

describe('shadow-reader -- hot-path sampling', () => {
  it('with sampleRate=10 skips most comparisons but ticks every gate counter', async () => {
    reader.detach();
    reader = attachShadowReader({ spacesApi: api, replica: r, gate, hotPathSampleRate: 10 });

    r.upsertSpace({ id: 's1', name: 'A' });
    // Emit 100 events with different args so the deterministic
    // hash distribution covers a range.
    for (let i = 0; i < 100; i++) {
      api._emit('items:listed', { spaceId: 's1', options: { offset: i }, items: [] });
    }
    await tick();
    const stats = reader.inspect().perEvent['items:listed'];
    expect(stats.invocations).toBe(100);
    // Sampled comparisons should land roughly 10% (give a wide
    // tolerance because hash distribution is uneven for small N).
    expect(stats.sampledComparisons).toBeGreaterThan(0);
    expect(stats.sampledComparisons).toBeLessThan(100);
    // Every invocation tickled the gate.
    expect(gate.evaluate().invocationGates.itemsList.actual).toBe(100);
  });

  it('sampling is deterministic -- same args sample to same decision', async () => {
    reader.detach();
    reader = attachShadowReader({ spacesApi: api, replica: r, gate, hotPathSampleRate: 10 });
    r.upsertSpace({ id: 's1', name: 'A' });

    for (let i = 0; i < 5; i++) {
      api._emit('items:listed', { spaceId: 's1', options: { offset: 7 }, items: [] });
    }
    await tick();
    const stats = reader.inspect().perEvent['items:listed'];
    // Either all 5 sampled or all 5 skipped (deterministic).
    expect([0, 5]).toContain(stats.sampledComparisons);
  });
});

// ---------------------------------------------------------------------------
// Failure isolation
// ---------------------------------------------------------------------------

describe('shadow-reader -- failure isolation', () => {
  it('replica throw during comparison increments errors counter, does not propagate', async () => {
    // Force replica throws by closing the DB.
    r.close();
    expect(() => api._emit('items:listed', {
      spaceId: 's1', options: {}, items: [{ id: 'i1' }],
    })).not.toThrow();
    await tick();
    expect(reader.inspect().perEvent['items:listed'].errors).toBeGreaterThan(0);
    // Avoid afterEach trying to close again.
    r._opened = false;
  });

  it('emit() does not throw even if reader is detached mid-flight', async () => {
    reader.detach();
    expect(() => api._emit('items:listed', { spaceId: 's1', options: {}, items: [] })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// detach()
// ---------------------------------------------------------------------------

describe('shadow-reader -- detach()', () => {
  it('detach() unsubscribes from every event', () => {
    expect(api._listenerCount('items:listed')).toBe(1);
    expect(api._listenerCount('search:completed')).toBe(1);
    reader.detach();
    expect(api._listenerCount('items:listed')).toBe(0);
    expect(api._listenerCount('search:completed')).toBe(0);
  });

  it('detach() is idempotent', () => {
    reader.detach();
    expect(() => reader.detach()).not.toThrow();
  });

  it('after detach() further events do not tick the gate', async () => {
    reader.detach();
    api._emit('items:listed', { spaceId: 's1', options: {}, items: [] });
    await tick();
    expect(gate.evaluate().invocationGates.itemsList.actual).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// inspect()
// ---------------------------------------------------------------------------

describe('shadow-reader -- inspect()', () => {
  it('returns expected shape with gate snapshot embedded', () => {
    const snap = reader.inspect();
    expect(snap).toMatchObject({
      sampleRate: 1,
      eventsHandled: 5,
      lastDivergence: null,
    });
    expect(snap.attachedAt).toMatch(/^\d{4}-\d{2}/);
    expect(snap.gate).toBeDefined();
    expect(snap.gate.cutoverAllowed).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('compareById -- pure helper', () => {
  it('equivalent for identical id-sets regardless of order', () => {
    const r1 = compareById([{ id: 'a' }, { id: 'b' }], [{ id: 'b' }, { id: 'a' }]);
    expect(r1.equivalent).toBe(true);
  });

  it('equivalent for empty arrays', () => {
    expect(compareById([], []).equivalent).toBe(true);
  });

  it('non-equivalent: only-in-primary populated', () => {
    const r1 = compareById([{ id: 'a' }], []);
    expect(r1.equivalent).toBe(false);
    expect(r1.onlyInPrimary).toEqual(['a']);
    expect(r1.onlyInReplica).toEqual([]);
  });

  it('non-equivalent: only-in-replica populated', () => {
    const r1 = compareById([], [{ id: 'a' }]);
    expect(r1.equivalent).toBe(false);
    expect(r1.onlyInReplica).toEqual(['a']);
  });

  it('skips items without ids defensively', () => {
    const r1 = compareById([{ id: 'a' }, { /* no id */ }], [{ id: 'a' }]);
    expect(r1.equivalent).toBe(true);
  });
});

describe('compareItemFields -- pure helper', () => {
  it('equivalent on matching whitelist fields', () => {
    const r1 = compareItemFields(
      { id: 'i1', type: 'text', preview: 'hi', pinned: true },
      { id: 'i1', type: 'text', preview: 'hi', pinned: 1 },
    );
    expect(r1.equivalent).toBe(true);
  });

  it('detects mismatch on a whitelist field', () => {
    const r1 = compareItemFields(
      { id: 'i1', type: 'text', preview: 'A' },
      { id: 'i1', type: 'text', preview: 'B' },
    );
    expect(r1.equivalent).toBe(false);
    expect(r1.differences.find((d) => d.field === 'preview')).toBeTruthy();
  });

  it('ignores fields outside the whitelist (timestamps, _search, etc.)', () => {
    const r1 = compareItemFields(
      { id: 'i1', type: 'text', timestamp: 1, _search: { score: 5 } },
      { id: 'i1', type: 'text', timestamp: 999 },
    );
    expect(r1.equivalent).toBe(true);
  });

  it('null primary vs valid replica = missing-in-primary', () => {
    expect(compareItemFields(null, { id: 'i1' }).reason).toBe('missing-in-primary');
  });

  it('valid primary vs null replica = missing-in-replica', () => {
    expect(compareItemFields({ id: 'i1' }, null).reason).toBe('missing-in-replica');
  });

  it('both null = equivalent (defensive)', () => {
    expect(compareItemFields(null, null).equivalent).toBe(true);
  });
});
