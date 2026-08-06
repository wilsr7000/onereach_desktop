/**
 * Manual/on-focus refresh — the escape hatch for data created OUTSIDE
 * this app.
 *
 * A Space made in WISER Playbooks (or by an agent writing straight to
 * the graph) doesn't invalidate our read cache, so before this the only
 * path to seeing it was the background refresh timer, with no way to
 * force it. These tests pin the contract that makes it deterministic.
 */

import { describe, it, expect } from 'vitest';
import { SpacesCache, SPACES_CACHE_KEYS } from '../../spaces/cache.js';

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

describe('SpacesCache — refresh semantics behind spaces.refresh()', () => {
  it('invalidate(() => true) clears every entry so the next read refetches', async () => {
    const cache = new SpacesCache({ logger: silentLogger, refreshIntervalMs: 0 });
    let calls = 0;
    const fetcher = async (): Promise<string[]> => {
      calls += 1;
      return calls === 1 ? ['a'] : ['a', 'b']; // 'b' created elsewhere
    };

    expect(await cache.getOrFetch(SPACES_CACHE_KEYS.LIST_SPACES, fetcher)).toEqual(['a']);
    // Cached: no refetch, still the stale answer.
    expect(await cache.getOrFetch(SPACES_CACHE_KEYS.LIST_SPACES, fetcher)).toEqual(['a']);
    expect(calls).toBe(1);

    const removed = cache.invalidate(() => true);
    expect(removed).toBeGreaterThan(0);

    // Post-invalidation the read is a real fetch and sees the new Space.
    expect(await cache.getOrFetch(SPACES_CACHE_KEYS.LIST_SPACES, fetcher)).toEqual(['a', 'b']);
    expect(calls).toBe(2);
  });

  it('a refetch emits an update so an open window repaints', async () => {
    const cache = new SpacesCache({ logger: silentLogger, refreshIntervalMs: 0 });
    const seen: string[] = [];
    cache.onUpdate((u) => seen.push(u.key));

    await cache.getOrFetch(SPACES_CACHE_KEYS.LIST_SPACES, async () => ['a']);
    cache.invalidate(() => true);
    await cache.getOrFetch(SPACES_CACHE_KEYS.LIST_SPACES, async () => ['a', 'b']);

    expect(seen.filter((k) => k === SPACES_CACHE_KEYS.LIST_SPACES).length).toBe(2);
  });

  it('clears sibling read keys too, not just the space list', async () => {
    // A Space created elsewhere also changes the home rollups and the
    // uncategorized count -- a targeted invalidation would leave those
    // stale, which is why refresh() nukes everything.
    const cache = new SpacesCache({ logger: silentLogger, refreshIntervalMs: 0 });
    await cache.getOrFetch(SPACES_CACHE_KEYS.LIST_SPACES, async () => ['a']);
    await cache.getOrFetch(SPACES_CACHE_KEYS.UNCATEGORIZED_COUNT, async () => 1);
    await cache.getOrFetch(SPACES_CACHE_KEYS.HOME_ENTITY_COUNTS, async () => ({ n: 1 }));

    expect(cache.invalidate(() => true)).toBe(3);

    let refetched = 0;
    await cache.getOrFetch(SPACES_CACHE_KEYS.UNCATEGORIZED_COUNT, async () => {
      refetched += 1;
      return 2;
    });
    expect(refetched).toBe(1);
  });

  it('a failing refetch surfaces the error rather than silently keeping stale data', async () => {
    const cache = new SpacesCache({ logger: silentLogger, refreshIntervalMs: 0 });
    await cache.getOrFetch(SPACES_CACHE_KEYS.LIST_SPACES, async () => ['a']);
    cache.invalidate(() => true);
    await expect(
      cache.getOrFetch(SPACES_CACHE_KEYS.LIST_SPACES, async () => {
        throw new Error('graph unreachable');
      })
    ).rejects.toThrow('graph unreachable');
  });
});

describe('spaces.refresh() is on the platform contract', () => {
  it('the uninitialized API rejects refresh() with SPACES_NOT_INITIALIZED', async () => {
    const { getSpacesApi, _resetSpacesApiForTesting } = await import('../../spaces/api.js');
    _resetSpacesApiForTesting();
    await expect(getSpacesApi().refresh()).rejects.toMatchObject({
      code: 'SPACES_NOT_INITIALIZED',
    });
  });
});
