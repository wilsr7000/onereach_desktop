/**
 * Exchange Manager (moderator) — pure maintenance policy + adapter runtime.
 * See docs/internal/ORB-EXCHANGE-AGENTS.md (UC6, self-clearing exchange).
 *
 * Run: npx vitest run test/unit/exchange-manager.test.js
 */

import { describe, it, expect, vi } from 'vitest';

const {
  planMaintenance,
  createExchangeManager,
  exchangeAdapter,
  DEFAULTS,
} = require('../../lib/exchange/exchange-manager');

const NOW = 1_000_000_000_000;

function task(overrides) {
  return {
    id: 'task_' + Math.random().toString(36).slice(2),
    status: 'settled',
    createdAt: NOW,
    assignedAt: null,
    completedAt: null,
    ...overrides,
  };
}

describe('planMaintenance (pure)', () => {
  it('prunes terminal tasks past the settled TTL, keeps recent ones', () => {
    const old = task({ id: 'old', status: 'settled', completedAt: NOW - DEFAULTS.settledTtlMs - 1 });
    const fresh = task({ id: 'fresh', status: 'settled', completedAt: NOW - 1000 });
    const plan = planMaintenance([old, fresh], NOW);
    expect(plan.toPrune).toEqual(['old']);
  });

  it('treats every terminal status as prunable', () => {
    const statuses = ['settled', 'cancelled', 'dead_letter', 'halted'];
    const tasks = statuses.map((s, i) =>
      task({ id: s, status: s, completedAt: NOW - DEFAULTS.settledTtlMs - i - 1 })
    );
    const plan = planMaintenance(tasks, NOW);
    expect(plan.toPrune.sort()).toEqual(statuses.sort());
  });

  it('NEVER prunes active (non-terminal) tasks, even very old ones', () => {
    const activeOld = task({ id: 'a', status: 'assigned', assignedAt: NOW - 3600_000, completedAt: null });
    const plan = planMaintenance([activeOld], NOW);
    expect(plan.toPrune).toEqual([]);
  });

  it('falls back to createdAt when a terminal task has no completedAt', () => {
    const t = task({ id: 't', status: 'cancelled', completedAt: null, createdAt: NOW - DEFAULTS.settledTtlMs - 1 });
    expect(planMaintenance([t], NOW).toPrune).toEqual(['t']);
  });

  it('flags an assigned task stuck past stuckAssignedMs', () => {
    const t = task({ id: 's', status: 'assigned', assignedAt: NOW - DEFAULTS.stuckAssignedMs - 1 });
    const plan = planMaintenance([t], NOW);
    expect(plan.stuck).toEqual([{ id: 's', status: 'assigned', ageMs: DEFAULTS.stuckAssignedMs + 1 }]);
    expect(plan.health.healthy).toBe(false);
  });

  it('flags a waiting task (pending/open) stuck past stuckWaitingMs', () => {
    const t = task({ id: 'w', status: 'open', createdAt: NOW - DEFAULTS.stuckWaitingMs - 1 });
    const plan = planMaintenance([t], NOW);
    expect(plan.stuck.map((s) => s.id)).toEqual(['w']);
  });

  it('a freshly assigned task is not stuck', () => {
    const t = task({ id: 'ok', status: 'assigned', assignedAt: NOW - 1000 });
    const plan = planMaintenance([t], NOW);
    expect(plan.stuck).toEqual([]);
    expect(plan.health.healthy).toBe(true);
  });

  it('produces a health summary with counts by status', () => {
    const tasks = [
      task({ status: 'settled', completedAt: NOW - 1000 }),
      task({ status: 'assigned', assignedAt: NOW - 1000 }),
      task({ status: 'open', createdAt: NOW - 1000 }),
    ];
    const h = planMaintenance(tasks, NOW).health;
    expect(h.total).toBe(3);
    expect(h.active).toBe(2);
    expect(h.terminal).toBe(1);
    expect(h.byStatus).toEqual({ settled: 1, assigned: 1, open: 1 });
  });

  it('is null/empty safe', () => {
    expect(planMaintenance(undefined, NOW)).toMatchObject({ toPrune: [], stuck: [] });
    expect(planMaintenance([null, {}], NOW).health.total).toBe(0);
  });
});

describe('createExchangeManager (runtime)', () => {
  function fakeAdapter(tasks, extra) {
    const store = new Map(tasks.map((t) => [t.id, t]));
    return {
      store,
      listTasks: () => Array.from(store.values()),
      removeTask: vi.fn((id) => store.delete(id)),
      now: () => NOW,
      ...extra,
    };
  }

  it('tick prunes terminal tasks via removeTask and reports pruned ids', () => {
    const adapter = fakeAdapter([
      task({ id: 'old', status: 'settled', completedAt: NOW - DEFAULTS.settledTtlMs - 1 }),
      task({ id: 'keep', status: 'assigned', assignedAt: NOW - 1000 }),
    ]);
    const mgr = createExchangeManager(adapter);
    const { pruned } = mgr.tick();
    expect(pruned).toEqual(['old']);
    expect(adapter.removeTask).toHaveBeenCalledWith('old');
    expect(adapter.store.has('keep')).toBe(true);
  });

  it('invokes onPrune / onStuck / onHealth hooks', () => {
    const onPrune = vi.fn();
    const onStuck = vi.fn();
    const onHealth = vi.fn();
    const adapter = fakeAdapter(
      [
        task({ id: 'old', status: 'settled', completedAt: NOW - DEFAULTS.settledTtlMs - 1 }),
        task({ id: 'stuck', status: 'assigned', assignedAt: NOW - DEFAULTS.stuckAssignedMs - 1 }),
      ],
      { onPrune, onStuck, onHealth }
    );
    createExchangeManager(adapter).tick();
    expect(onPrune).toHaveBeenCalledWith(['old']);
    expect(onStuck).toHaveBeenCalledWith([expect.objectContaining({ id: 'stuck' })]);
    expect(onHealth).toHaveBeenCalledWith(expect.objectContaining({ prunable: 1, stuck: 1 }));
  });

  it('survives a listTasks that throws (returns empty, no crash)', () => {
    const mgr = createExchangeManager({
      listTasks: () => { throw new Error('boom'); },
      removeTask: vi.fn(),
      now: () => NOW,
    });
    expect(() => mgr.tick()).not.toThrow();
    expect(mgr.tick().pruned).toEqual([]);
  });

  it('a throwing hook does not abort the tick', () => {
    const adapter = fakeAdapter(
      [task({ id: 'old', status: 'settled', completedAt: NOW - DEFAULTS.settledTtlMs - 1 })],
      { onHealth: () => { throw new Error('hook boom'); } }
    );
    const mgr = createExchangeManager(adapter);
    expect(() => mgr.tick()).not.toThrow();
    expect(adapter.store.has('old')).toBe(false); // prune still happened
  });

  it('start()/stop() toggles isRunning and does not double-arm', () => {
    const adapter = fakeAdapter([]);
    const mgr = createExchangeManager(adapter, { intervalMs: 10_000 });
    expect(mgr.isRunning()).toBe(false);
    mgr.start();
    expect(mgr.isRunning()).toBe(true);
    mgr.start(); // idempotent
    mgr.stop();
    expect(mgr.isRunning()).toBe(false);
  });
});

describe('exchangeAdapter', () => {
  it('binds listTasks/removeTask to a live-shaped exchange and merges hooks', () => {
    const exchange = {
      listTasks: () => [task({ id: 'x' })],
      removeTask: vi.fn(() => true),
    };
    const onPrune = vi.fn();
    const adapter = exchangeAdapter(exchange, { onPrune, now: () => NOW });
    expect(adapter.listTasks().map((t) => t.id)).toEqual(['x']);
    expect(adapter.removeTask('x')).toBe(true);
    expect(adapter.onPrune).toBe(onPrune);
  });
});
