/**
 * Validation gate for the replica cutover (commit D).
 *
 * Per docs/sync-v5/replica-shape.md §6.6, before commit E flips the
 * read path to the replica we require:
 *   - Invocation thresholds: ≥100 items.list, ≥100 items.get,
 *     ≥50 search, ≥20 tag mutations, ≥10 smartFolders.getItems
 *     (collected from when shadow-read started).
 *   - AND ≥7 days of wall-clock elapsed since shadow-read started.
 *   - AND zero divergence logs in the same window.
 *
 * The gate is the operator-facing surface for "are we ready to flip
 * the read path?" Commit E reads `cutoverAllowed()` and refuses to
 * flip when false. Operators inspect via the
 * /sync/replica/validation HTTP endpoint to see exactly what's
 * blocking.
 *
 * Counters are persisted to `replica_meta` (debounced) so a restart
 * during the validation window doesn't reset progress. Single-tenant
 * deployments collapse to one row per key; multi-tenant deployments
 * track per-tenant gates (each tenant qualifies for cutover
 * independently).
 *
 * The categories tracked here mirror §6.6 exactly:
 *   - itemsList         (replica.listItemsBySpace shadow-read)
 *   - itemsGet          (replica.getItem shadow-read)
 *   - search            (count-only in commit D; comparison ships
 *                        with FTS5 in a follow-up commit. Counts
 *                        still tick so the gate threshold can be met)
 *   - tagMutations      (sourced from the shadow-WRITER's per-event
 *                        counters: item:tags:updated +
 *                        tags:renamed + tags:deleted)
 *   - smartFoldersList  (replica.listSmartFolders shadow-read)
 *
 * Configurable thresholds: defaults match §6.6 exactly. Tests pass
 * lower thresholds via constructor options.
 */

'use strict';

// ---------------------------------------------------------------------------
// Defaults (per §6.6)
// ---------------------------------------------------------------------------

const DEFAULT_THRESHOLDS = Object.freeze({
  itemsList: 100,
  itemsGet: 100,
  search: 50,
  tagMutations: 20,
  smartFoldersList: 10,
});

const DEFAULT_WALL_CLOCK_DAYS = 7;

const META_KEYS = Object.freeze({
  startedAt: 'validation.startedAt',
  // Per-method invocation count
  invocations: (m) => `validation.invocations.${m}`,
  // Per-method divergence count
  divergences: (m) => `validation.divergences.${m}`,
  // Total divergence count across all methods (cheap aggregate
  // for the cutoverAllowed boolean)
  totalDivergences: 'validation.divergences.total',
});

const METHOD_KEYS = Object.freeze([
  'itemsList',
  'itemsGet',
  'search',
  'tagMutations',
  'smartFoldersList',
]);

// ---------------------------------------------------------------------------
// ValidationGate class
// ---------------------------------------------------------------------------

class ValidationGate {
  /**
   * @param {object} args
   * @param {object} args.replica -- Replica instance for replica_meta
   *   read/write. Must expose getMeta(key) and setMeta(key, value).
   * @param {object} [args.thresholds] -- override §6.6 defaults
   *   (per-method counters; missing keys fall back to default).
   * @param {number} [args.wallClockDays=7] -- minimum elapsed days.
   * @param {function} [args.tagMutationsProvider] -- () => number,
   *   pulls live tag-mutation count from the shadow-writer counters.
   *   Optional: if not provided, the gate's internal tagMutations
   *   counter (incrementable via record('tagMutations', n)) is used.
   * @param {function} [args.now] -- testable Date.now-like clock.
   * @param {number} [args.persistDebounceMs=2000] -- batch persists
   *   so hot read paths don't slam replica_meta. The buffered values
   *   are flushed on close().
   * @param {object} [args.logger]
   */
  constructor({
    replica,
    thresholds = {},
    wallClockDays = DEFAULT_WALL_CLOCK_DAYS,
    tagMutationsProvider = null,
    now = Date.now,
    persistDebounceMs = 2000,
    logger,
  } = {}) {
    if (!replica) throw new Error('ValidationGate: replica is required');

    this.replica = replica;
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...thresholds };
    this.wallClockDays = wallClockDays;
    this.tagMutationsProvider = typeof tagMutationsProvider === 'function' ? tagMutationsProvider : null;
    this._now = now;
    this._persistDebounceMs = persistDebounceMs;
    this._log = logger || { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

    // In-memory mirror of the persisted counters. Loaded on init();
    // mutations buffer here and flush on the next debounce tick or
    // explicit flushNow().
    this._invocations = Object.create(null);
    this._divergences = Object.create(null);
    this._totalDivergences = 0;
    this._dirty = false;
    this._persistTimer = null;
    this._initialised = false;
    this._startedAt = null;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Load counters from replica_meta. Sets startedAt to now if this
   * is a fresh start. Idempotent.
   */
  init() {
    if (this._initialised) return this;

    let startedAt = this.replica.getMeta(META_KEYS.startedAt);
    if (!startedAt) {
      startedAt = new Date(this._now()).toISOString();
      this.replica.setMeta(META_KEYS.startedAt, startedAt);
      this._log.info('replica/validation-gate', 'Shadow-read window started', { startedAt });
    }
    this._startedAt = startedAt;

    for (const m of METHOD_KEYS) {
      const inv = parseInt(this.replica.getMeta(META_KEYS.invocations(m)) || '0', 10);
      const div = parseInt(this.replica.getMeta(META_KEYS.divergences(m)) || '0', 10);
      this._invocations[m] = isNaN(inv) ? 0 : inv;
      this._divergences[m] = isNaN(div) ? 0 : div;
    }
    const total = parseInt(this.replica.getMeta(META_KEYS.totalDivergences) || '0', 10);
    this._totalDivergences = isNaN(total) ? 0 : total;

    this._initialised = true;
    return this;
  }

  /**
   * Flush in-flight counters and stop the debounce timer. Safe to
   * call from app shutdown / SIGTERM.
   */
  close() {
    this.flushNow();
    if (this._persistTimer) {
      clearTimeout(this._persistTimer);
      this._persistTimer = null;
    }
    this._initialised = false;
  }

  // ---------------------------------------------------------------------------
  // Counter mutation
  // ---------------------------------------------------------------------------

  /**
   * Record `count` invocations of `method`. Synchronous +
   * non-blocking; persistence happens on the next debounce tick.
   */
  recordInvocation(method, count = 1) {
    this._assertInit();
    if (!this._invocations[method]) this._invocations[method] = 0;
    this._invocations[method] += count;
    this._scheduleFlush();
  }

  /**
   * Record `count` divergences of `method`. Bumps the per-method
   * counter AND the total. Both are persisted on the next tick.
   */
  recordDivergence(method, count = 1) {
    this._assertInit();
    if (!this._divergences[method]) this._divergences[method] = 0;
    this._divergences[method] += count;
    this._totalDivergences += count;
    this._dirty = true; // force flush even if not in METHOD_KEYS
    this._scheduleFlush();
    this._log.warn('replica/validation-gate', 'Divergence recorded', {
      method, count, totalNow: this._totalDivergences,
    });
  }

  // ---------------------------------------------------------------------------
  // Gate evaluation
  // ---------------------------------------------------------------------------

  /**
   * Returns the full gate evaluation -- the same shape the
   * /sync/replica/validation endpoint exposes. Computed from
   * in-memory counters (cheap; no DB read).
   */
  evaluate() {
    this._assertInit();
    const startedAtMs = Date.parse(this._startedAt);
    const elapsedMs = Math.max(0, this._now() - startedAtMs);
    const elapsedDays = elapsedMs / (24 * 60 * 60 * 1000);

    // Tag-mutation count is sourced from the shadow-writer when a
    // provider is wired; otherwise from internal counter.
    let tagMutationsActual = this._invocations.tagMutations || 0;
    if (this.tagMutationsProvider) {
      try {
        const live = this.tagMutationsProvider();
        if (typeof live === 'number' && live >= 0) tagMutationsActual = live;
      } catch (err) {
        this._log.warn('replica/validation-gate', 'tagMutationsProvider threw', { error: err.message });
      }
    }

    const invocationGates = {
      itemsList: this._gateRow('itemsList', this._invocations.itemsList || 0),
      itemsGet: this._gateRow('itemsGet', this._invocations.itemsGet || 0),
      search: this._gateRow('search', this._invocations.search || 0),
      tagMutations: this._gateRow('tagMutations', tagMutationsActual),
      smartFoldersList: this._gateRow('smartFoldersList', this._invocations.smartFoldersList || 0),
    };

    const wallClockGate = {
      required: this.wallClockDays,
      actual: round2(elapsedDays),
      met: elapsedDays >= this.wallClockDays,
    };

    const allInvocationsMet = Object.values(invocationGates).every((g) => g.met);
    const noDivergence = this._totalDivergences === 0;
    const cutoverAllowed = wallClockGate.met && allInvocationsMet && noDivergence;

    const blockers = [];
    if (!wallClockGate.met) {
      blockers.push(
        `wall-clock floor not met (${wallClockGate.actual}/${wallClockGate.required} days)`
      );
    }
    for (const [name, g] of Object.entries(invocationGates)) {
      if (!g.met) blockers.push(`${name} invocations below threshold (${g.actual}/${g.required})`);
    }
    if (!noDivergence) {
      blockers.push(`divergences detected (${this._totalDivergences} across all methods)`);
    }

    return {
      shadowReadEnabled: true,
      startedAt: this._startedAt,
      wallClockDaysElapsed: round2(elapsedDays),
      wallClockGate,
      invocationGates,
      divergences: {
        total: this._totalDivergences,
        byMethod: { ...this._divergences },
      },
      cutoverAllowed,
      blockers,
    };
  }

  /**
   * Cheap boolean for commit E's flag-flip check. Equivalent to
   * `evaluate().cutoverAllowed`.
   */
  cutoverAllowed() {
    return this.evaluate().cutoverAllowed;
  }

  /**
   * Reset counters back to zero and stamp a fresh startedAt. Used
   * when shadow-read is restarted after a divergence is fixed and
   * the operator wants to start a fresh validation window. NOT
   * called automatically; this is an explicit operator action.
   */
  reset() {
    this._assertInit();
    const nowIso = new Date(this._now()).toISOString();
    this.replica.setMeta(META_KEYS.startedAt, nowIso);
    for (const m of METHOD_KEYS) {
      this.replica.setMeta(META_KEYS.invocations(m), '0');
      this.replica.setMeta(META_KEYS.divergences(m), '0');
    }
    this.replica.setMeta(META_KEYS.totalDivergences, '0');
    this._startedAt = nowIso;
    this._invocations = Object.create(null);
    this._divergences = Object.create(null);
    this._totalDivergences = 0;
    this._dirty = false;
    this._log.info('replica/validation-gate', 'Counters reset; new shadow-read window', { startedAt: nowIso });
  }

  // ---------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------

  _scheduleFlush() {
    this._dirty = true;
    if (this._persistTimer) return;
    this._persistTimer = setTimeout(() => {
      this._persistTimer = null;
      try { this.flushNow(); } catch (err) {
        this._log.warn('replica/validation-gate', 'flush failed', { error: err.message });
      }
    }, this._persistDebounceMs);
    if (this._persistTimer && typeof this._persistTimer.unref === 'function') {
      this._persistTimer.unref();
    }
  }

  /**
   * Persist all in-memory counters to replica_meta. Synchronous;
   * called from the debounce timer or explicitly by close().
   * Idempotent if already clean.
   */
  flushNow() {
    if (!this._initialised || !this._dirty) return;
    for (const m of METHOD_KEYS) {
      this.replica.setMeta(META_KEYS.invocations(m), String(this._invocations[m] || 0));
      this.replica.setMeta(META_KEYS.divergences(m), String(this._divergences[m] || 0));
    }
    this.replica.setMeta(META_KEYS.totalDivergences, String(this._totalDivergences));
    this._dirty = false;
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  _assertInit() {
    if (!this._initialised) {
      throw new Error('ValidationGate: not initialised; call init() first');
    }
  }

  _gateRow(method, actual) {
    const required = this.thresholds[method];
    return {
      required,
      actual,
      met: actual >= required,
    };
  }
}

function round2(x) {
  return Math.round(x * 100) / 100;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  ValidationGate,
  DEFAULT_THRESHOLDS,
  DEFAULT_WALL_CLOCK_DAYS,
  META_KEYS,
  METHOD_KEYS,
};
