/**
 * Unit tests for lib/sync-v5/replica/validation-gate.js
 *
 * Covers the §6.6 cutover gate machinery:
 *   - Persistence to/from replica_meta (round-trip across init/reload)
 *   - Threshold defaults (per-method invocation gates)
 *   - Wall-clock floor (configurable; default 7d)
 *   - cutoverAllowed boolean correctness across all permutations
 *   - Divergence accumulation + total
 *   - Reset semantics (fresh window with new startedAt)
 *   - tagMutationsProvider hook
 *   - Debounced flush
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const { Replica } = require('../../../lib/sync-v5/replica/replica');
const {
  ValidationGate,
  DEFAULT_THRESHOLDS,
  DEFAULT_WALL_CLOCK_DAYS,
} = require('../../../lib/sync-v5/replica/validation-gate');

let r = null;

beforeEach(() => {
  r = new Replica({ dbPath: ':memory:', tenantId: 'default', deviceId: 'd' }).init();
});

afterEach(() => {
  if (r) try { r.close(); } catch (_e) { /* ok */ }
  r = null;
});

// ---------------------------------------------------------------------------
// Argument validation + defaults
// ---------------------------------------------------------------------------

describe('ValidationGate -- construction', () => {
  it('throws if replica is missing', () => {
    expect(() => new ValidationGate({})).toThrow(/replica is required/);
  });

  it('uses §6.6 default thresholds', () => {
    expect(DEFAULT_THRESHOLDS).toEqual({
      itemsList: 100, itemsGet: 100, search: 50,
      tagMutations: 20, smartFoldersList: 10,
    });
    expect(DEFAULT_WALL_CLOCK_DAYS).toBe(7);
  });

  it('init() stamps startedAt on first call and persists to replica_meta', () => {
    const g = new ValidationGate({ replica: r }).init();
    expect(r.getMeta('validation.startedAt')).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    g.close();
  });

  it('init() preserves startedAt on subsequent inits (reload semantics)', () => {
    const g1 = new ValidationGate({ replica: r }).init();
    const stamp = r.getMeta('validation.startedAt');
    g1.close();
    // Simulate restart: fresh gate, same replica.
    const g2 = new ValidationGate({ replica: r }).init();
    expect(r.getMeta('validation.startedAt')).toBe(stamp);
    g2.close();
  });

  it('init() is idempotent', () => {
    const g = new ValidationGate({ replica: r });
    g.init();
    expect(() => g.init()).not.toThrow();
    g.close();
  });
});

// ---------------------------------------------------------------------------
// Counter recording + persistence
// ---------------------------------------------------------------------------

describe('ValidationGate -- counters', () => {
  let g;
  beforeEach(() => {
    g = new ValidationGate({ replica: r, persistDebounceMs: 0 }).init();
  });
  afterEach(() => g && g.close());

  it('recordInvocation increments the per-method counter', () => {
    g.recordInvocation('itemsList', 5);
    g.recordInvocation('itemsList', 3);
    g.flushNow();
    expect(parseInt(r.getMeta('validation.invocations.itemsList'), 10)).toBe(8);
  });

  it('recordDivergence increments per-method AND total', () => {
    g.recordDivergence('itemsList');
    g.recordDivergence('itemsGet', 2);
    g.flushNow();
    expect(parseInt(r.getMeta('validation.divergences.itemsList'), 10)).toBe(1);
    expect(parseInt(r.getMeta('validation.divergences.itemsGet'), 10)).toBe(2);
    expect(parseInt(r.getMeta('validation.divergences.total'), 10)).toBe(3);
  });

  it('counters survive a close/reload cycle', () => {
    g.recordInvocation('itemsList', 50);
    g.recordDivergence('itemsGet', 1);
    g.close();
    const g2 = new ValidationGate({ replica: r, persistDebounceMs: 0 }).init();
    const eval2 = g2.evaluate();
    expect(eval2.invocationGates.itemsList.actual).toBe(50);
    expect(eval2.invocationGates.itemsGet.actual).toBe(0);
    expect(eval2.divergences.total).toBe(1);
    g2.close();
  });

  it('throws if recordInvocation is called before init()', () => {
    const ng = new ValidationGate({ replica: r });
    expect(() => ng.recordInvocation('itemsList')).toThrow(/not initialised/);
  });

  it('debounced flush coalesces multiple rapid increments into one persist', async () => {
    g.close();
    g = new ValidationGate({ replica: r, persistDebounceMs: 25 }).init();
    g.recordInvocation('itemsList');
    g.recordInvocation('itemsList');
    g.recordInvocation('itemsList');
    // Counters in memory; replica_meta still 0 until flush.
    expect(parseInt(r.getMeta('validation.invocations.itemsList') || '0', 10)).toBe(0);
    await new Promise((res) => setTimeout(res, 60));
    expect(parseInt(r.getMeta('validation.invocations.itemsList'), 10)).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Gate evaluation
// ---------------------------------------------------------------------------

describe('ValidationGate -- evaluate()', () => {
  it('cutoverAllowed=false on a fresh gate (no invocations, no time elapsed)', () => {
    const g = new ValidationGate({ replica: r }).init();
    const ev = g.evaluate();
    expect(ev.cutoverAllowed).toBe(false);
    expect(ev.blockers.length).toBeGreaterThan(0);
    expect(ev.wallClockGate.met).toBe(false);
    g.close();
  });

  it('reports blockers for each unmet criterion', () => {
    const g = new ValidationGate({ replica: r }).init();
    const ev = g.evaluate();
    // Unmet: wall-clock + every method invocation threshold.
    expect(ev.blockers.some((b) => /wall-clock/.test(b))).toBe(true);
    expect(ev.blockers.some((b) => /itemsList/.test(b))).toBe(true);
    g.close();
  });

  it('cutoverAllowed=true when ALL gates pass + zero divergences', () => {
    const fakeNow = (() => {
      const start = Date.now();
      // Step 1: gate.init() at start time
      // Step 2: evaluate() at start + 8 days
      let calls = 0;
      return () => {
        calls++;
        return calls === 1 ? start : start + 8 * 24 * 60 * 60 * 1000;
      };
    })();

    const g = new ValidationGate({
      replica: r, now: fakeNow, persistDebounceMs: 0,
      thresholds: { itemsList: 1, itemsGet: 1, search: 1, tagMutations: 1, smartFoldersList: 1 },
    }).init();

    g.recordInvocation('itemsList');
    g.recordInvocation('itemsGet');
    g.recordInvocation('search');
    g.recordInvocation('tagMutations');
    g.recordInvocation('smartFoldersList');

    const ev = g.evaluate();
    expect(ev.cutoverAllowed).toBe(true);
    expect(ev.blockers).toEqual([]);
    g.close();
  });

  it('cutoverAllowed=false if ANY divergence is recorded (zero-divergence is non-negotiable)', () => {
    const fakeNow = (() => {
      const t = Date.now();
      let n = 0;
      return () => (n++ === 0 ? t : t + 8 * 24 * 60 * 60 * 1000);
    })();
    const g = new ValidationGate({
      replica: r, now: fakeNow, persistDebounceMs: 0,
      thresholds: { itemsList: 1, itemsGet: 1, search: 1, tagMutations: 1, smartFoldersList: 1 },
    }).init();
    for (const m of ['itemsList', 'itemsGet', 'search', 'tagMutations', 'smartFoldersList']) {
      g.recordInvocation(m);
    }
    g.recordDivergence('itemsList');
    expect(g.evaluate().cutoverAllowed).toBe(false);
    expect(g.evaluate().blockers.some((b) => /divergences detected/.test(b))).toBe(true);
    g.close();
  });

  it('cutoverAllowed=false when wall-clock floor not met even if invocations are over threshold', () => {
    const g = new ValidationGate({
      replica: r,
      thresholds: { itemsList: 1, itemsGet: 1, search: 1, tagMutations: 1, smartFoldersList: 1 },
      wallClockDays: 365, // fail wall-clock
      persistDebounceMs: 0,
    }).init();
    for (const m of ['itemsList', 'itemsGet', 'search', 'tagMutations', 'smartFoldersList']) {
      g.recordInvocation(m, 100);
    }
    expect(g.evaluate().cutoverAllowed).toBe(false);
    g.close();
  });

  it('returns the documented endpoint shape', () => {
    const g = new ValidationGate({ replica: r, persistDebounceMs: 0 }).init();
    const ev = g.evaluate();
    expect(ev).toHaveProperty('shadowReadEnabled', true);
    expect(ev).toHaveProperty('startedAt');
    expect(ev).toHaveProperty('wallClockDaysElapsed');
    expect(ev).toHaveProperty('wallClockGate.required', 7);
    expect(ev).toHaveProperty('wallClockGate.actual');
    expect(ev).toHaveProperty('wallClockGate.met');
    expect(ev).toHaveProperty('invocationGates.itemsList.required', 100);
    expect(ev).toHaveProperty('invocationGates.search.required', 50);
    expect(ev).toHaveProperty('divergences.total', 0);
    expect(ev).toHaveProperty('cutoverAllowed');
    expect(ev).toHaveProperty('blockers');
    g.close();
  });

  it('cutoverAllowed() shorthand matches evaluate().cutoverAllowed', () => {
    const g = new ValidationGate({ replica: r, persistDebounceMs: 0 }).init();
    expect(g.cutoverAllowed()).toBe(g.evaluate().cutoverAllowed);
    g.close();
  });
});

// ---------------------------------------------------------------------------
// tagMutationsProvider hook
// ---------------------------------------------------------------------------

describe('ValidationGate -- tagMutationsProvider', () => {
  it('overrides internal tagMutations counter when provided', () => {
    let liveCount = 7;
    const g = new ValidationGate({
      replica: r, persistDebounceMs: 0,
      tagMutationsProvider: () => liveCount,
    }).init();
    expect(g.evaluate().invocationGates.tagMutations.actual).toBe(7);
    liveCount = 25;
    expect(g.evaluate().invocationGates.tagMutations.actual).toBe(25);
    g.close();
  });

  it('falls back to internal counter when provider throws', () => {
    const g = new ValidationGate({
      replica: r, persistDebounceMs: 0,
      tagMutationsProvider: () => { throw new Error('boom'); },
    }).init();
    g.recordInvocation('tagMutations', 5);
    expect(g.evaluate().invocationGates.tagMutations.actual).toBe(5);
    g.close();
  });

  it('rejects negative or non-numeric provider returns (falls back to internal)', () => {
    const g = new ValidationGate({
      replica: r, persistDebounceMs: 0,
      tagMutationsProvider: () => -5,
    }).init();
    g.recordInvocation('tagMutations', 3);
    expect(g.evaluate().invocationGates.tagMutations.actual).toBe(3);
    g.close();
  });
});

// ---------------------------------------------------------------------------
// reset()
// ---------------------------------------------------------------------------

describe('ValidationGate -- reset()', () => {
  it('reset() zeroes all counters and stamps a fresh startedAt', async () => {
    const g = new ValidationGate({ replica: r, persistDebounceMs: 0 }).init();
    const before = r.getMeta('validation.startedAt');
    g.recordInvocation('itemsList', 50);
    g.recordDivergence('itemsList', 3);
    g.flushNow();
    // Tiny sleep to ensure the new timestamp is strictly later.
    await new Promise((res) => setTimeout(res, 5));
    g.reset();
    expect(g.evaluate().invocationGates.itemsList.actual).toBe(0);
    expect(g.evaluate().divergences.total).toBe(0);
    expect(r.getMeta('validation.startedAt')).not.toBe(before);
    g.close();
  });
});
