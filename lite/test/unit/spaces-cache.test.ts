/**
 * Spaces in-process cache -- pure tests.
 *
 * Exercises the SpacesCache class against an in-memory fake "fetcher"
 * so the contract is pinned without touching Neon. Covers:
 *   - getOrFetch first call (no value): awaits, stores, returns.
 *   - getOrFetch fresh hit: zero new fetcher calls.
 *   - getOrFetch stale hit: returns stale value AND kicks background refresh.
 *   - In-flight coalescing: two parallel callers share one fetch.
 *   - warm: fire-and-forget pre-warm.
 *   - invalidate: clears matching entries.
 *   - onUpdate: fires after a successful refresh.
 *   - Refresh timer: refreshAll re-runs every stored fetcher.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  SpacesCache,
  SPACES_CACHE_KEYS,
  itemsListKey,
  itemsGetKey,
} from '../../spaces/cache.js';

function later<T>(value: T, ms = 0): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

describe('SpacesCache.getOrFetch', () => {
  it('calls the fetcher exactly once on a cold cache and returns its value', async () => {
    let calls = 0;
    const cache = new SpacesCache();
    const result = await cache.getOrFetch('k', async () => {
      calls += 1;
      return 'first';
    });
    expect(result).toBe('first');
    expect(calls).toBe(1);
  });

  it('returns the cached value without calling the fetcher again while fresh', async () => {
    let calls = 0;
    const cache = new SpacesCache({ ttlMs: 60_000 });
    const fetcher = async (): Promise<string> => {
      calls += 1;
      return 'v' + String(calls);
    };
    expect(await cache.getOrFetch('k', fetcher)).toBe('v1');
    expect(await cache.getOrFetch('k', fetcher)).toBe('v1');
    expect(await cache.getOrFetch('k', fetcher)).toBe('v1');
    expect(calls).toBe(1);
  });

  it('returns the STALE value immediately AND triggers a background refresh', async () => {
    let calls = 0;
    const cache = new SpacesCache({ ttlMs: 0 }); // every read is stale
    const fetcher = async (): Promise<string> => {
      calls += 1;
      return 'v' + String(calls);
    };
    // First call: cold, awaits fetch.
    expect(await cache.getOrFetch('k', fetcher)).toBe('v1');
    expect(calls).toBe(1);
    // Second call: stale, returns v1 (the cached value) immediately.
    expect(await cache.getOrFetch('k', fetcher)).toBe('v1');
    // Background refresh has been kicked off (v2). Drain microtasks.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toBe(2);
    // Third call: now-fresh value is v2.
    expect(await cache.getOrFetch('k', fetcher)).toBe('v2');
  });

  it('coalesces parallel callers onto a single in-flight fetch', async () => {
    let calls = 0;
    const cache = new SpacesCache();
    const fetcher = async (): Promise<string> => {
      calls += 1;
      return later('coalesced', 5);
    };
    const [a, b, c] = await Promise.all([
      cache.getOrFetch('k', fetcher),
      cache.getOrFetch('k', fetcher),
      cache.getOrFetch('k', fetcher),
    ]);
    expect(a).toBe('coalesced');
    expect(b).toBe('coalesced');
    expect(c).toBe('coalesced');
    expect(calls).toBe(1);
  });

  it('propagates the error to the caller on a cold-cache fetch failure', async () => {
    const cache = new SpacesCache();
    await expect(
      cache.getOrFetch('k', async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
  });

  it('does NOT swallow a stale-refresh failure into the foreground caller', async () => {
    let calls = 0;
    const cache = new SpacesCache({ ttlMs: 0 });
    expect(
      await cache.getOrFetch('k', async () => {
        calls += 1;
        return 'good';
      })
    ).toBe('good');
    // Now the stored value is "good"; the next call returns it stale
    // and kicks a background refresh that throws. The foreground call
    // still returns the stale "good" -- the throw is observed only
    // via the (background) onUpdate path.
    const v = await cache.getOrFetch('k', async () => {
      throw new Error('background-boom');
    });
    expect(v).toBe('good');
  });
});

describe('SpacesCache.warm', () => {
  it('fires the fetcher and stores the result so the next getOrFetch hits cache', async () => {
    let calls = 0;
    const cache = new SpacesCache({ ttlMs: 60_000 });
    const fetcher = async (): Promise<string> => {
      calls += 1;
      return 'warm-' + String(calls);
    };
    await cache.warm('k', fetcher);
    expect(calls).toBe(1);
    expect(await cache.getOrFetch('k', fetcher)).toBe('warm-1');
    expect(calls).toBe(1); // still 1 -- cache hit
  });

  it('a second warm against the same key while in-flight is coalesced', async () => {
    let calls = 0;
    const cache = new SpacesCache();
    const fetcher = async (): Promise<string> => {
      calls += 1;
      return later('once', 5);
    };
    const [a, b] = await Promise.all([cache.warm('k', fetcher), cache.warm('k', fetcher)]);
    expect(a).toBe('once');
    expect(b).toBe('once');
    expect(calls).toBe(1);
  });
});

describe('SpacesCache.invalidate', () => {
  it('drops every entry that matches the predicate', async () => {
    const cache = new SpacesCache({ ttlMs: 60_000 });
    await cache.warm('a', async () => 'A');
    await cache.warm('b', async () => 'B');
    await cache.warm('c', async () => 'C');
    expect(cache._sizeForTesting()).toBe(3);
    const removed = cache.invalidate((k) => k === 'a' || k === 'c');
    expect(removed).toBe(2);
    expect(cache._sizeForTesting()).toBe(1);
    expect(cache._entryForTesting('a')).toBeNull();
    expect(cache._entryForTesting('b')).not.toBeNull();
    expect(cache._entryForTesting('c')).toBeNull();
  });

  it('predicate () => true wipes the whole cache', async () => {
    const cache = new SpacesCache();
    await cache.warm('a', async () => 'A');
    await cache.warm('b', async () => 'B');
    cache.invalidate(() => true);
    expect(cache._sizeForTesting()).toBe(0);
  });

  it('after invalidate, getOrFetch refetches from scratch', async () => {
    let calls = 0;
    const cache = new SpacesCache({ ttlMs: 60_000 });
    const fetcher = async (): Promise<string> => {
      calls += 1;
      return 'v' + String(calls);
    };
    await cache.getOrFetch('k', fetcher);
    expect(calls).toBe(1);
    cache.invalidate(() => true);
    await cache.getOrFetch('k', fetcher);
    expect(calls).toBe(2);
  });

  it('invalidateKey returns false when the key was absent', () => {
    const cache = new SpacesCache();
    expect(cache.invalidateKey('never-set')).toBe(false);
  });
});

describe('SpacesCache.onUpdate', () => {
  it('fires after a successful fetch with the key + timestamp', async () => {
    const cache = new SpacesCache();
    const events: Array<{ key: string; at: number }> = [];
    cache.onUpdate((update) => events.push(update));
    await cache.warm('k', async () => 'V');
    expect(events).toHaveLength(1);
    expect(events[0]?.key).toBe('k');
    expect(typeof events[0]?.at).toBe('number');
  });

  it('does NOT fire on a failed fetch', async () => {
    const cache = new SpacesCache();
    const events: Array<{ key: string }> = [];
    cache.onUpdate((update) => events.push(update));
    await expect(
      cache.getOrFetch('k', async () => {
        throw new Error('nope');
      })
    ).rejects.toThrow('nope');
    expect(events).toHaveLength(0);
  });

  it('unsubscribe stops the handler from receiving further updates', async () => {
    const cache = new SpacesCache();
    let count = 0;
    const unsub = cache.onUpdate(() => {
      count += 1;
    });
    await cache.warm('a', async () => 'A');
    expect(count).toBe(1);
    unsub();
    await cache.warm('b', async () => 'B');
    expect(count).toBe(1);
  });
});

describe('SpacesCache.refreshAll', () => {
  it('re-runs every stored fetcher in parallel', async () => {
    let aCalls = 0;
    let bCalls = 0;
    const cache = new SpacesCache({ ttlMs: 60_000 });
    await cache.warm('a', async () => {
      aCalls += 1;
      return 'A';
    });
    await cache.warm('b', async () => {
      bCalls += 1;
      return 'B';
    });
    expect(aCalls).toBe(1);
    expect(bCalls).toBe(1);
    await cache.refreshAll();
    expect(aCalls).toBe(2);
    expect(bCalls).toBe(2);
  });

  it('a single failing fetcher does not stall the others', async () => {
    const cache = new SpacesCache({ ttlMs: 60_000 });
    let bCalls = 0;
    await cache.warm('a', async () => 'A');
    await cache.warm('b', async () => {
      bCalls += 1;
      return 'B';
    });
    // Swap a's fetcher to a thrower by re-warming -- but warm coalesces
    // if in-flight; here it's settled so the new fetcher wins.
    cache.invalidateKey('a');
    cache
      .warm('a', async () => {
        throw new Error('a-boom');
      })
      .catch(() => undefined);
    await cache.refreshAll();
    // b kept refreshing despite a's failure.
    expect(bCalls).toBeGreaterThanOrEqual(2);
  });
});

describe('SPACES_CACHE_KEYS + helpers', () => {
  it('exposes stable string keys for every cached read', () => {
    expect(SPACES_CACHE_KEYS.LIST_SPACES).toBe('spaces.listSpaces');
    expect(SPACES_CACHE_KEYS.UNCATEGORIZED_COUNT).toBe('spaces.uncategorizedCount');
    expect(SPACES_CACHE_KEYS.HOME_RECENT_ITEMS).toBe('spaces.home.recentItems');
  });

  it('builds per-scope item-list keys', () => {
    expect(itemsListKey('space-uxmag-feb')).toBe('spaces.items.list:space-uxmag-feb');
    expect(itemsListKey('__uncategorized__')).toBe('spaces.items.list:__uncategorized__');
  });

  it('builds per-id item-get keys', () => {
    expect(itemsGetKey('asset-1')).toBe('spaces.items.get:asset-1');
  });
});

describe('background-failure streaks are tracked, logged, and reset (2026-08-16)', () => {
  it('counts consecutive failures per entry and resets on success', async () => {
    const warns: unknown[] = [];
    const cache = new SpacesCache({
      ttlMs: 0,
      refreshIntervalMs: 0,
      logger: { warn: (...a: unknown[]) => void warns.push(a), info: () => {}, error: () => {} },
    });
    let fail = true;
    const fetcher = async (): Promise<string> => {
      if (fail) throw new Error('graph 503');
      return 'ok';
    };
    await cache.getOrFetch('k', fetcher).catch(() => undefined);
    await cache.refreshAll();
    await cache.refreshAll();
    expect(cache.maxConsecutiveFailures()).toBeGreaterThanOrEqual(3);
    fail = false;
    await cache.refreshAll();
    expect(cache.maxConsecutiveFailures()).toBe(0);
    expect(warns.length).toBeGreaterThanOrEqual(3);
  });
});

describe('a hung fetch cannot freeze a cache key (2026-08-17)', () => {
  it('times out a never-settling fetcher, counts the failure, and allows the next refresh', async () => {
    vi.useFakeTimers();
    try {
      const cache = new SpacesCache({
        ttlMs: 0,
        refreshIntervalMs: 0,
        logger: { warn: () => {}, info: () => {}, error: () => {} },
      });
      let calls = 0;
      let hang = true;
      const fetcher = (): Promise<string> => {
        calls++;
        if (hang) return new Promise<string>(() => undefined); // never settles
        return Promise.resolve('recovered');
      };
      const first = cache.getOrFetch('k', fetcher).catch(() => 'timed-out');
      await vi.advanceTimersByTimeAsync(46_000);
      expect(await first).toBe('timed-out');
      expect(cache.maxConsecutiveFailures()).toBe(1);
      // The key is NOT frozen: refreshAll fetches it again (the old
      // behavior skipped it forever because fetching never cleared).
      hang = false;
      await cache.refreshAll();
      expect(calls).toBe(2);
      expect(cache.maxConsecutiveFailures()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});


describe('outage backoff — a failing backend is not refreshed at full cadence (2026-08-17)', () => {
  it('skips refresh ticks exponentially with the failure streak and recovers to full cadence', async () => {
    vi.useFakeTimers();
    try {
      const cache = new SpacesCache({
        ttlMs: 0,
        refreshIntervalMs: 1000,
        logger: { warn: () => {}, info: () => {}, error: () => {} },
      });
      let calls = 0;
      let failing = true;
      const fetcher = (): Promise<string> => {
        calls++;
        return failing ? Promise.reject(new Error('503')) : Promise.resolve('ok');
      };
      // Seed the entry (first call fails: streak = 1).
      await cache.getOrFetch('k', fetcher).catch(() => undefined);
      expect(calls).toBe(1);

      cache.startRefreshTimer();
      // Tick 1: streak 1 → full cadence, refresh runs (streak becomes 2).
      await vi.advanceTimersByTimeAsync(1000);
      expect(calls).toBe(2);
      // Streak now ≥2 → skipFactor 2: of the next 2 ticks only one refreshes.
      await vi.advanceTimersByTimeAsync(2000);
      expect(calls).toBe(3);
      // Streak grows → skipFactor rises; over the next 8 ticks at streak≥4
      // (factor 8) at most 2 more refreshes happen instead of 8.
      await vi.advanceTimersByTimeAsync(8000);
      expect(calls).toBeLessThanOrEqual(5);
      const callsDuringOutage = calls;

      // Recovery: one successful refresh resets the streak; cadence returns
      // to every-tick.
      failing = false;
      await vi.advanceTimersByTimeAsync(8000); // at most one skip cycle until a success lands
      const afterRecoveryBase = calls;
      expect(calls).toBeGreaterThan(callsDuringOutage);
      await vi.advanceTimersByTimeAsync(3000);
      expect(calls).toBe(afterRecoveryBase + 3);
      cache.stopRefreshTimer();
    } finally {
      vi.useRealTimers();
    }
  });
});
