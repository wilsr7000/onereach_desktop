/**
 * Exchange Manager — the moderator / traffic-cop agent.
 *
 * See docs/internal/ORB-EXCHANGE-AGENTS.md (UC6). The exchange was a persistent
 * ledger: tasks were marked SETTLED but never removed, so the task map grew
 * unbounded. This moderator keeps the exchange healthy and CLEAR:
 *
 *   - prunes terminal tasks (settled/cancelled/dead_letter/halted) past a TTL,
 *     so the exchange returns toward empty as the vision requires;
 *   - flags STUCK tasks (assigned-but-never-completed, or waiting-too-long) so a
 *     wedged auction is observable instead of silent;
 *   - reports a health summary each tick.
 *
 * Structured for testing: `planMaintenance` is pure (snapshot -> decisions) and
 * `createExchangeManager` runs it against an adapter, so both the policy and the
 * runtime are unit-testable without Electron or a live exchange.
 */

'use strict';

// Terminal statuses: the task has left the auction and is safe to prune.
const TERMINAL_STATUSES = ['settled', 'cancelled', 'dead_letter', 'halted'];

const DEFAULTS = {
  intervalMs: 60 * 1000, // moderator tick cadence
  settledTtlMs: 5 * 60 * 1000, // prune terminal tasks this long after completion
  stuckAssignedMs: 90 * 1000, // assigned but not completed past this = stuck
  stuckWaitingMs: 30 * 1000, // pending/open/matching past this = stuck
};

/**
 * Pure maintenance decision from a snapshot of tasks.
 *
 * @param {Array} tasks  Task[] snapshot (each { id, status, createdAt, assignedAt, completedAt })
 * @param {number} now   current epoch ms
 * @param {object} [config]  overrides for the DEFAULTS ttls
 * @returns {{ toPrune: string[], stuck: Array<{id,status,ageMs}>, health: object }}
 */
function planMaintenance(tasks, now, config) {
  const cfg = { ...DEFAULTS, ...(config || {}) };
  const toPrune = [];
  const stuck = [];
  const byStatus = {};
  let total = 0;
  let active = 0;
  let terminal = 0;

  for (const t of tasks || []) {
    if (!t || !t.id) continue;
    total++;
    byStatus[t.status] = (byStatus[t.status] || 0) + 1;

    if (TERMINAL_STATUSES.includes(t.status)) {
      terminal++;
      const doneAt = t.completedAt || t.createdAt || 0;
      if (now - doneAt >= cfg.settledTtlMs) toPrune.push(t.id);
      continue;
    }

    active++;
    if (t.status === 'assigned') {
      const since = t.assignedAt || t.createdAt || now;
      const ageMs = now - since;
      if (ageMs >= cfg.stuckAssignedMs) stuck.push({ id: t.id, status: t.status, ageMs });
    } else {
      // pending / open / matching / busted — waiting to be (re)assigned
      const since = t.createdAt || now;
      const ageMs = now - since;
      if (ageMs >= cfg.stuckWaitingMs) stuck.push({ id: t.id, status: t.status, ageMs });
    }
  }

  return {
    toPrune,
    stuck,
    health: {
      total,
      active,
      terminal,
      prunable: toPrune.length,
      stuck: stuck.length,
      byStatus,
      healthy: stuck.length === 0,
    },
  };
}

/**
 * Runtime moderator bound to an adapter.
 *
 * @param {object} adapter
 *   listTasks(): Task[]         REQUIRED — snapshot of exchange tasks
 *   removeTask(id): boolean     REQUIRED — prune a task, returns whether it existed
 *   now?(): number              optional clock (defaults to Date.now)
 *   onPrune?(ids: string[])     optional hook after a prune batch
 *   onStuck?(stuck[])           optional hook when stuck tasks are present
 *   onHealth?(health)           optional hook each tick
 *   log?(level, msg, data)      optional logger
 * @param {object} [config]  ttl/interval overrides
 */
function createExchangeManager(adapter, config) {
  const cfg = { ...DEFAULTS, ...(config || {}) };
  const now = () => (typeof adapter.now === 'function' ? adapter.now() : Date.now());
  const log = (level, msg, data) => {
    if (typeof adapter.log === 'function') adapter.log(level, msg, data);
  };
  let timer = null;

  function tick() {
    let tasks;
    try {
      tasks = adapter.listTasks() || [];
    } catch (e) {
      log('warn', 'exchange-manager: listTasks failed', { error: e && e.message });
      return { pruned: [], plan: null };
    }

    const plan = planMaintenance(tasks, now(), cfg);

    const pruned = [];
    for (const id of plan.toPrune) {
      try {
        if (adapter.removeTask(id)) pruned.push(id);
      } catch (_e) {
        // one bad removal must not abort the sweep
      }
    }

    if (pruned.length) {
      log('info', 'exchange-manager: pruned terminal tasks', { count: pruned.length });
      if (typeof adapter.onPrune === 'function') {
        try { adapter.onPrune(pruned); } catch (_e) { /* hook errors are non-fatal */ }
      }
    }
    if (plan.stuck.length && typeof adapter.onStuck === 'function') {
      try { adapter.onStuck(plan.stuck); } catch (_e) { /* non-fatal */ }
    }
    if (typeof adapter.onHealth === 'function') {
      try { adapter.onHealth(plan.health); } catch (_e) { /* non-fatal */ }
    }

    return { pruned, plan };
  }

  return {
    tick,
    start() {
      if (timer) return;
      timer = setInterval(() => {
        try { tick(); } catch (_e) { /* never let the moderator throw on its own timer */ }
      }, cfg.intervalMs);
      if (timer && typeof timer.unref === 'function') timer.unref();
      log('info', 'exchange-manager: started', { intervalMs: cfg.intervalMs });
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
    isRunning() {
      return !!timer;
    },
  };
}

/**
 * Build an adapter backed by a live Exchange instance (exposes listTasks /
 * removeTask). Extra hooks (now/log/onPrune/onStuck/onHealth) are merged in.
 */
function exchangeAdapter(exchange, hooks) {
  return {
    listTasks: () => exchange.listTasks(),
    removeTask: (id) => exchange.removeTask(id),
    ...(hooks || {}),
  };
}

module.exports = {
  planMaintenance,
  createExchangeManager,
  exchangeAdapter,
  TERMINAL_STATUSES,
  DEFAULTS,
};
