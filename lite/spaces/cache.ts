/**
 * Spaces in-process cache.
 *
 * Pre-warms expensive Cypher reads at app launch and serves them
 * instantly to renderer IPC calls so opening the Spaces window
 * doesn't make the user wait on a network round-trip. Entries refresh
 * on a background timer and broadcast updates so the renderer can
 * re-paint without polling.
 *
 * Lifecycle:
 *   - `warm(key, fetcher)`         -- fire-and-forget; primes the cache.
 *   - `getOrFetch(key, fetcher)`   -- returns cached if fresh, kicks
 *                                    background refresh if stale, OR
 *                                    awaits the in-flight fetch if no
 *                                    value is cached yet.
 *   - `invalidate(predicate)`      -- nuke matching entries (used
 *                                    after mutations so the next read
 *                                    re-fetches).
 *   - `onUpdate(handler)`          -- subscribe to refresh events;
 *                                    main-process callers re-broadcast
 *                                    these to all renderers as IPC.
 *   - `startRefreshTimer()`        -- periodic refresh of every entry
 *                                    that has a stored fetcher (keeps
 *                                    the cache hot without renderer
 *                                    activity).
 *
 * Cache keys are stable strings. For parameterized reads
 * (e.g. `items.list(scopeId)`), callers compose the key (`items.list:<scopeId>`).
 *
 * @internal -- consumers go through `getSpacesApi()`; this module is
 * the implementation detail behind the API singleton.
 */

import { EventEmitter } from 'node:events';

/** Single cache entry: a stored value + the fetcher used to refresh it. */
interface CacheEntry<T> {
  /** Most-recently resolved value, or null when nothing has settled. */
  value: T | null;
  /** Epoch ms of the last successful fetch (or 0). */
  fetchedAt: number;
  /** In-flight refresh promise, if any. */
  fetching: Promise<T> | null;
  /** Fetcher used by background refresh + on-demand revalidation. */
  fetcher: () => Promise<T>;
  /** True after a successful fetch; gates the staleness check. */
  hasValue: boolean;
  /**
   * Background refreshes that failed in a row. Silent-failure guard
   * (2026-08-16): a flaky graph endpoint made every 60s refresh fail
   * with NO signal anywhere — a member grant never surfaced in an open
   * window until reopen. Streaks now log, and callers can read them.
   */
  consecutiveFailures: number;
}

/** Update event payload broadcast on every successful refresh. */
export interface SpacesCacheUpdate {
  key: string;
  /** Epoch ms when the refresh landed. */
  at: number;
}

export interface SpacesCacheOptions {
  /**
   * How long a cached value stays "fresh" before `getOrFetch` returns
   * it stale-while-revalidate. Stale entries still return the cached
   * value immediately, but kick a background refresh.
   *
   * Default 30s. Mutations invalidate explicitly via `invalidate()`
   * so stale data after a write is corrected on the next read.
   */
  ttlMs?: number;
  /**
   * How often the background timer refreshes every entry. Set to 0
   * to disable; the cache then only refreshes on-demand via
   * `getOrFetch`. Default 60s.
   */
  refreshIntervalMs?: number;
  /** Optional logger; defaults to silent. */
  logger?: {
    info: (msg: string, data?: unknown) => void;
    warn: (msg: string, data?: unknown) => void;
    error: (msg: string, data?: unknown) => void;
  };
}

const DEFAULT_TTL_MS = 30_000;
const DEFAULT_REFRESH_INTERVAL_MS = 60_000;
const UPDATE_EVENT = 'spaces:cache:update';

export class SpacesCache {
  private readonly entries = new Map<string, CacheEntry<unknown>>();
  private readonly emitter = new EventEmitter();
  private readonly ttlMs: number;
  private readonly refreshIntervalMs: number;
  private readonly log: NonNullable<SpacesCacheOptions['logger']>;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: SpacesCacheOptions = {}) {
    this.ttlMs = typeof opts.ttlMs === 'number' && opts.ttlMs >= 0 ? opts.ttlMs : DEFAULT_TTL_MS;
    this.refreshIntervalMs =
      typeof opts.refreshIntervalMs === 'number' && opts.refreshIntervalMs >= 0
        ? opts.refreshIntervalMs
        : DEFAULT_REFRESH_INTERVAL_MS;
    this.log = opts.logger ?? {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    };
  }

  /**
   * Get cached value (fresh or stale) or fetch when nothing is cached.
   *
   * Behavior matrix:
   *   - No entry yet         -> await fresh fetch, store, return.
   *   - Entry exists, fresh  -> return cached value immediately, no IO.
   *   - Entry exists, stale  -> return cached value immediately AND
   *                             kick a background refresh (broadcasts
   *                             via `onUpdate` when it lands).
   *   - In-flight refresh    -> the second caller awaits the same
   *                             promise instead of double-fetching.
   */
  async getOrFetch<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
    const existing = this.entries.get(key) as CacheEntry<T> | undefined;

    if (existing !== undefined && existing.hasValue) {
      // We have a value; decide whether to revalidate in background.
      const age = Date.now() - existing.fetchedAt;
      existing.fetcher = fetcher; // refresh the bound fetcher (closures may change)
      if (age >= this.ttlMs && existing.fetching === null) {
        // Stale: trigger background refresh; do NOT await it. The
        // .catch silences unhandled-rejection warnings -- errors are
        // already logged inside `runFetch`. The foreground caller
        // returns the stale value below and never sees the failure.
        existing.fetching = this.runFetch(key, existing);
        existing.fetching.catch((): void => {
          /* logged inside runFetch */
        });
      }
      return existing.value as T;
    }

    // No value yet -- coalesce on in-flight fetch or kick a new one.
    if (existing !== undefined && existing.fetching !== null) {
      return existing.fetching;
    }
    const entry: CacheEntry<T> = existing ?? {
      value: null,
      fetchedAt: 0,
      fetching: null,
      fetcher,
      hasValue: false,
      consecutiveFailures: 0,
    };
    entry.fetcher = fetcher;
    this.entries.set(key, entry as CacheEntry<unknown>);
    entry.fetching = this.runFetch(key, entry);
    return entry.fetching;
  }

  /**
   * Fire-and-forget pre-warm. Stores the fetcher under the given key
   * and kicks an immediate fetch. The result is cached; the returned
   * promise is exposed only so tests can await the warm.
   */
  warm<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
    const existing = this.entries.get(key) as CacheEntry<T> | undefined;
    const entry: CacheEntry<T> = existing ?? {
      value: null,
      fetchedAt: 0,
      fetching: null,
      fetcher,
      hasValue: false,
      consecutiveFailures: 0,
    };
    entry.fetcher = fetcher;
    this.entries.set(key, entry as CacheEntry<unknown>);
    if (entry.fetching !== null) return entry.fetching;
    entry.fetching = this.runFetch(key, entry);
    return entry.fetching;
  }

  /**
   * Remove every entry whose key matches the predicate. Used after
   * mutations so the next read can't return a stale value.
   *
   * Pass `() => true` to nuke the whole cache (e.g. on sign-out).
   */
  invalidate(predicate: (key: string) => boolean): number {
    let removed = 0;
    for (const key of Array.from(this.entries.keys())) {
      if (predicate(key)) {
        this.entries.delete(key);
        removed += 1;
      }
    }
    if (removed > 0) {
      this.log.info('spaces-cache: invalidated entries', { removed });
    }
    return removed;
  }

  /** Convenience: invalidate by exact key. */
  invalidateKey(key: string): boolean {
    return this.entries.delete(key);
  }

  /** Subscribe to refresh events. Returns an unsubscribe function. */
  onUpdate(handler: (update: SpacesCacheUpdate) => void): () => void {
    this.emitter.on(UPDATE_EVENT, handler);
    return () => {
      this.emitter.off(UPDATE_EVENT, handler);
    };
  }

  /**
   * Start the periodic background refresh. Every `refreshIntervalMs`
   * the cache walks its entries and re-runs each fetcher; successful
   * refreshes broadcast via `onUpdate`. Idempotent: a second call is
   * a no-op while the timer is already running.
   *
   * Caller is responsible for invoking `stopRefreshTimer()` on
   * shutdown. The timer is unref'd on platforms that expose it (Node
   * + Electron main) so it doesn't keep the event loop alive.
   */
  startRefreshTimer(): void {
    if (this.refreshTimer !== null) return;
    if (this.refreshIntervalMs <= 0) return;
    this.refreshTimer = setInterval(() => {
      this.refreshAll();
    }, this.refreshIntervalMs);
    // Don't keep the process alive just for the cache timer.
    const unref = (this.refreshTimer as { unref?: () => void }).unref;
    if (typeof unref === 'function') unref.call(this.refreshTimer);
  }

  /** Stop the periodic refresh. Idempotent. */
  stopRefreshTimer(): void {
    if (this.refreshTimer !== null) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  /**
   * Refresh every entry whose stored fetcher is set, in parallel.
   * Soft-fails per entry so one broken fetcher doesn't stall the
   * others. Exposed for tests and for explicit "I want it fresh now"
   * callers; production usually relies on the background timer.
   */
  async refreshAll(): Promise<void> {
    const work: Array<Promise<unknown>> = [];
    for (const [key, entry] of this.entries.entries()) {
      if (entry.fetching !== null) continue; // skip in-flight
      entry.fetching = this.runFetch(key, entry);
      work.push(entry.fetching.catch(() => undefined));
    }
    await Promise.all(work);
  }

  /**
   * Highest consecutive-failure streak across entries. Zero when every
   * key's latest background refresh succeeded — the health signal the
   * staleness watchdog reads.
   */
  maxConsecutiveFailures(): number {
    let max = 0;
    for (const entry of this.entries.values()) {
      if (entry.consecutiveFailures > max) max = entry.consecutiveFailures;
    }
    return max;
  }

  /** @internal -- test introspection. */
  _sizeForTesting(): number {
    return this.entries.size;
  }

  /** @internal -- test introspection. */
  _entryForTesting(
    key: string
  ): { hasValue: boolean; value: unknown; fetchedAt: number; fetching: boolean } | null {
    const e = this.entries.get(key);
    if (e === undefined) return null;
    return {
      hasValue: e.hasValue,
      value: e.value,
      fetchedAt: e.fetchedAt,
      fetching: e.fetching !== null,
    };
  }

  // ─── Internal ──────────────────────────────────────────────────────────

  /**
   * Hard ceiling on a single fetch. Must stay BELOW the refresh
   * interval: refreshAll skips in-flight entries, so a fetch that
   * outlives the interval starves the key of every future refresh.
   */
  private static readonly FETCH_TIMEOUT_MS = 45_000;

  private async runFetch<T>(key: string, entry: CacheEntry<T>): Promise<T> {
    try {
      const value = await Promise.race([
        entry.fetcher(),
        new Promise<never>((_resolve, reject) => {
          const t = setTimeout(
            () => reject(new Error(`cache fetch timed out after ${SpacesCache.FETCH_TIMEOUT_MS}ms`)),
            SpacesCache.FETCH_TIMEOUT_MS
          );
          (t as { unref?: () => void }).unref?.();
        }),
      ]);
      entry.value = value;
      entry.fetchedAt = Date.now();
      entry.hasValue = true;
      entry.fetching = null;
      entry.consecutiveFailures = 0;
      try {
        const update: SpacesCacheUpdate = { key, at: entry.fetchedAt };
        this.emitter.emit(UPDATE_EVENT, update);
      } catch (err) {
        this.log.warn('spaces-cache: onUpdate handler threw', {
          key,
          error: (err as Error).message,
        });
      }
      return value;
    } catch (err) {
      entry.fetching = null;
      entry.consecutiveFailures += 1;
      this.log.warn('spaces-cache: fetcher failed', {
        key,
        error: (err as Error).message,
        consecutiveFailures: entry.consecutiveFailures,
      });
      throw err;
    }
  }
}

/**
 * Canonical cache keys for the read-side Spaces API. Centralized so
 * mutation handlers can invalidate by name without duplicating the
 * key strings.
 */
export const SPACES_CACHE_KEYS = {
  LIST_SPACES: 'spaces.listSpaces',
  UNCATEGORIZED_COUNT: 'spaces.uncategorizedCount',
  HOME_ENTITY_COUNTS: 'spaces.home.entityCounts',
  HOME_RECENT_ITEMS: 'spaces.home.recentItems',
  HOME_TOP_CONTRIBUTORS: 'spaces.home.topContributors',
  HOME_RECENT_EVENTS: 'spaces.home.recentEvents',
  HOME_AGENTS_SAMPLE: 'spaces.home.agentsSample',
  HOME_PERMISSION_SUMMARY: 'spaces.home.permissionSummary',
} as const;

/** Build a per-scope cache key for `items.list(scope, opts)`. */
export function itemsListKey(scopeId: string): string {
  return `spaces.items.list:${scopeId}`;
}

/** Build a per-id cache key for `items.get(id)`. */
export function itemsGetKey(id: string): string {
  return `spaces.items.get:${id}`;
}
