/**
 * KVApi tests.
 *
 * Structured per Rule 12 / HARNESS.md:
 *   1. `runApiConformanceContract` -- the uniform contract every module
 *      passes (singleton, reset, set-for-testing, expected methods).
 *   2. Module-specific behavior tests -- collection isolation,
 *      CRUD round-trip semantics that the contract doesn't cover.
 */

import { describe, it, expect } from 'vitest';
import {
  getKVApi,
  _resetKVApiForTesting,
  _setKVApiForTesting,
  type KVApi,
} from '../../kv/api.js';
import { runApiConformanceContract } from '../harness/conformance.js';
import { FakeKV } from '../harness/index.js';

// 1. Conformance contract -- runs the uniform suite.
runApiConformanceContract<KVApi>({
  name: 'KVApi',
  getInstance: getKVApi,
  resetForTesting: _resetKVApiForTesting,
  setForTesting: _setKVApiForTesting,
  expectedMethods: ['set', 'get', 'listKeys', 'list', 'delete', 'onEvent'],
});

// 2. Module-specific tests.

describe('KVApi (via FakeKV) routes calls correctly', () => {
  it('set -> get -> listKeys -> list -> delete round-trip', async () => {
    _resetKVApiForTesting();
    const stub = new FakeKV();
    _setKVApiForTesting(stub);
    const api = getKVApi();

    await api.set('lite-bugs', 'rec-1', { foo: 'bar' });
    await api.set('lite-bugs', 'rec-2', { foo: 'baz' });
    await api.set('other-collection', 'rec-x', { qux: 1 });

    expect(await api.get('lite-bugs', 'rec-1')).toEqual({ foo: 'bar' });
    expect(await api.get('lite-bugs', 'missing')).toBeNull();

    const keys = await api.listKeys('lite-bugs');
    expect(keys.sort()).toEqual(['rec-1', 'rec-2']);

    const records = await api.list('lite-bugs');
    expect(records).toHaveLength(2);
    expect(records.map((r) => r.key).sort()).toEqual(['rec-1', 'rec-2']);

    await api.delete('lite-bugs', 'rec-1');
    expect(await api.get('lite-bugs', 'rec-1')).toBeNull();
    expect((await api.listKeys('lite-bugs')).sort()).toEqual(['rec-2']);
  });

  it('isolates collections (set in one collection does not appear in another)', async () => {
    _resetKVApiForTesting();
    const stub = new FakeKV();
    _setKVApiForTesting(stub);
    const api = getKVApi();

    await api.set('coll-a', 'shared-key', 'value-a');
    await api.set('coll-b', 'shared-key', 'value-b');

    expect(await api.get('coll-a', 'shared-key')).toBe('value-a');
    expect(await api.get('coll-b', 'shared-key')).toBe('value-b');
    expect(await api.listKeys('coll-a')).toEqual(['shared-key']);
    expect(await api.listKeys('coll-b')).toEqual(['shared-key']);
  });

  it('FakeKV failure flags surface as KVErrors', async () => {
    _resetKVApiForTesting();
    const stub = new FakeKV();
    _setKVApiForTesting(stub);
    const api = getKVApi();

    stub.failSet = true;
    await expect(api.set('coll', 'key', 'value')).rejects.toThrow(/mock set failure/);
  });
});
