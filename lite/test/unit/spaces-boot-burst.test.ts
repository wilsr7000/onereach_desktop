/**
 * Boot-burst consolidation ("why 30 requests", 2026-08-17).
 *
 * Launch fires ONE graph query (listSpaces — keeps the cache-update
 * stream alive for the ADR-062 ring); the remaining pre-warm runs once
 * on first window open with bounded concurrency; tree children hydrate
 * only when visible. These tests pin the three mechanisms.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { runBounded, ensureFullPrewarm, _resetPrewarmForTesting } from '../../spaces/main.js';
import { whenTreeVisible } from '../../spaces/spaces.js';

describe('runBounded', () => {
  it('runs every task but never more than `limit` at once', async () => {
    let active = 0;
    let peak = 0;
    let done = 0;
    const task = () => async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      done++;
    };
    await runBounded(Array.from({ length: 8 }, task), 2);
    expect(done).toBe(8);
    expect(peak).toBeLessThanOrEqual(2);
  });

  it('swallows task rejections and keeps draining', async () => {
    let done = 0;
    await runBounded(
      [
        async () => { throw new Error('boom'); },
        async () => { done++; },
        async () => { throw new Error('boom2'); },
        async () => { done++; },
      ],
      1
    );
    expect(done).toBe(2);
  });
});

describe('ensureFullPrewarm', () => {
  const stubApi = () => {
    const calls: string[] = [];
    const method = (name: string) => async () => { calls.push(name); return undefined; };
    return {
      calls,
      api: {
        listSpaces: method('listSpaces'),
        getUncategorizedCount: method('getUncategorizedCount'),
        getEntityCounts: method('getEntityCounts'),
        listRecentItems: method('listRecentItems'),
        topContributors: method('topContributors'),
        listRecentEvents: method('listRecentEvents'),
        listAgentsSample: method('listAgentsSample'),
        getPermissionSummary: method('getPermissionSummary'),
      } as never,
    };
  };
  const log = { info: () => undefined, warn: () => undefined, error: () => undefined };

  it('warms all eight reads exactly once across repeated opens', async () => {
    _resetPrewarmForTesting();
    const { calls, api } = stubApi();
    ensureFullPrewarm(api, log);
    ensureFullPrewarm(api, log); // second window open — no double warm
    await vi.waitFor(() => expect(calls.length).toBe(8));
    expect(new Set(calls).size).toBe(8);
    ensureFullPrewarm(api, log);
    await new Promise((r) => setTimeout(r, 10));
    expect(calls.length).toBe(8);
    _resetPrewarmForTesting();
  });
});

describe('whenTreeVisible', () => {
  it('hydrates immediately when IntersectionObserver is unavailable', () => {
    const w = window as { IntersectionObserver?: unknown };
    const saved = w.IntersectionObserver;
    delete w.IntersectionObserver;
    try {
      let hydrated = 0;
      whenTreeVisible(document.createElement('li'), () => { hydrated++; });
      expect(hydrated).toBe(1);
    } finally {
      if (saved !== undefined) w.IntersectionObserver = saved;
    }
  });

  it('defers hydration until the element intersects, then disconnects', () => {
    const instances: Array<{
      cb: (entries: Array<{ isIntersecting: boolean }>) => void;
      observed: Element[];
      disconnected: boolean;
    }> = [];
    class FakeIO {
      cb: (entries: Array<{ isIntersecting: boolean }>) => void;
      observed: Element[] = [];
      disconnected = false;
      constructor(cb: (entries: Array<{ isIntersecting: boolean }>) => void) {
        this.cb = cb;
        instances.push(this);
      }
      observe(el: Element): void { this.observed.push(el); }
      disconnect(): void { this.disconnected = true; }
    }
    const w = window as { IntersectionObserver?: unknown };
    const saved = w.IntersectionObserver;
    w.IntersectionObserver = FakeIO as never;
    try {
      let hydrated = 0;
      const el = document.createElement('li');
      whenTreeVisible(el, () => { hydrated++; });
      expect(hydrated).toBe(0); // constructed, NOT fetched
      const io = instances[0];
      if (io === undefined) throw new Error('observer never constructed');
      expect(io.observed).toContain(el);
      // Off-screen notification: still no hydration.
      io.cb([{ isIntersecting: false }]);
      expect(hydrated).toBe(0);
      // Scrolled into view: hydrate exactly once, observer released.
      io.cb([{ isIntersecting: true }]);
      expect(hydrated).toBe(1);
      expect(io.disconnected).toBe(true);
      io.cb([{ isIntersecting: true }]);
      expect(hydrated).toBe(1);
    } finally {
      if (saved !== undefined) w.IntersectionObserver = saved;
      else delete w.IntersectionObserver;
    }
  });
});
