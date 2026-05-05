/**
 * Onereach Lite Auto-Updater -- pre-quit state save.
 *
 * Bounded save: each registered hook gets a per-call budget; the total
 * budget is also capped so we never block ShipIt for more than 1.5s.
 *
 * Borrowed pattern: main.js _saveStateBeforeUpdate (lines 17158-17223),
 * stripped to lite's much smaller surface area. Lite kernel currently has:
 *   - The bug-report modal (close it cleanly)
 *   - Future ports register additional hooks via registerSaveHook()
 */

const TOTAL_BUDGET_MS = 1_500;
const PER_HOOK_BUDGET_MS = 500;

export interface SaveHook {
  /** Stable id for diagnostics. */
  id: string;
  /** Async work; resolves when complete. Should respect the budgetMs hint. */
  run: (budgetMs: number) => Promise<void>;
  /** Optional override for this hook's budget. Defaults to PER_HOOK_BUDGET_MS. */
  budgetMs?: number;
}

export interface SaveStateResult {
  /** Total elapsed time in ms. */
  elapsedMs: number;
  /** Per-hook outcomes -- ordered by registration. */
  hooks: Array<{ id: string; outcome: 'completed' | 'timed-out' | 'errored'; elapsedMs: number; error?: string }>;
}

const _hooks: SaveHook[] = [];

/**
 * Register a hook to run before quit-and-install. Idempotent by id.
 */
export function registerSaveHook(hook: SaveHook): void {
  const existing = _hooks.findIndex((h) => h.id === hook.id);
  if (existing >= 0) {
    _hooks[existing] = hook;
  } else {
    _hooks.push(hook);
  }
}

export function unregisterSaveHook(id: string): void {
  const idx = _hooks.findIndex((h) => h.id === id);
  if (idx >= 0) _hooks.splice(idx, 1);
}

export function clearSaveHooks(): void {
  _hooks.length = 0;
}

/** For tests. */
export function _getSaveHooksForTesting(): SaveHook[] {
  return [..._hooks];
}

/**
 * Run all registered hooks within the total budget. Each hook is also
 * capped at its individual budget. Never throws -- all per-hook errors
 * are captured into the result.
 */
export async function saveStateBeforeUpdate(opts: {
  totalBudgetMs?: number;
  logger?: { info: (msg: string, data?: unknown) => void; warn: (msg: string, data?: unknown) => void };
} = {}): Promise<SaveStateResult> {
  const totalBudget = opts.totalBudgetMs ?? TOTAL_BUDGET_MS;
  const log = opts.logger;
  const start = Date.now();
  const results: SaveStateResult['hooks'] = [];

  for (const hook of _hooks) {
    const remaining = Math.max(0, totalBudget - (Date.now() - start));
    if (remaining === 0) {
      results.push({ id: hook.id, outcome: 'timed-out', elapsedMs: 0, error: 'total budget exhausted' });
      continue;
    }
    const hookBudget = Math.min(hook.budgetMs ?? PER_HOOK_BUDGET_MS, remaining);
    const hookStart = Date.now();
    try {
      const timeoutPromise = new Promise<'__timeout__'>((resolve) =>
        setTimeout(() => resolve('__timeout__'), hookBudget)
      );
      const outcome = await Promise.race([hook.run(hookBudget).then(() => '__ok__' as const), timeoutPromise]);
      const elapsedMs = Date.now() - hookStart;
      if (outcome === '__timeout__') {
        results.push({ id: hook.id, outcome: 'timed-out', elapsedMs });
        log?.warn('updater: save hook timed out', { id: hook.id, budgetMs: hookBudget });
      } else {
        results.push({ id: hook.id, outcome: 'completed', elapsedMs });
        log?.info('updater: save hook completed', { id: hook.id, elapsedMs });
      }
    } catch (err) {
      results.push({
        id: hook.id,
        outcome: 'errored',
        elapsedMs: Date.now() - hookStart,
        error: (err as Error).message,
      });
      log?.warn('updater: save hook errored', { id: hook.id, error: (err as Error).message });
    }
  }

  const elapsedMs = Date.now() - start;
  log?.info('updater: saveStateBeforeUpdate complete', { elapsedMs, hookCount: _hooks.length });
  return { elapsedMs, hooks: results };
}
