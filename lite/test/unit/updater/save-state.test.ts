/**
 * Unit tests for lite/updater/save-state.ts -- bounded save hooks.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  registerSaveHook,
  clearSaveHooks,
  saveStateBeforeUpdate,
  _getSaveHooksForTesting,
  unregisterSaveHook,
} from '../../../updater/save-state.js';

beforeEach(() => {
  clearSaveHooks();
});

describe('registerSaveHook', () => {
  it('registers a hook by id', () => {
    registerSaveHook({ id: 'foo', run: async () => {} });
    expect(_getSaveHooksForTesting().map((h) => h.id)).toEqual(['foo']);
  });

  it('is idempotent by id (replaces existing)', () => {
    const first = vi.fn();
    const second = vi.fn();
    registerSaveHook({ id: 'foo', run: first });
    registerSaveHook({ id: 'foo', run: second });
    expect(_getSaveHooksForTesting().length).toBe(1);
    expect(_getSaveHooksForTesting()[0]!.run).toBe(second);
  });

  it('preserves registration order across distinct ids', () => {
    registerSaveHook({ id: 'a', run: async () => {} });
    registerSaveHook({ id: 'b', run: async () => {} });
    registerSaveHook({ id: 'c', run: async () => {} });
    expect(_getSaveHooksForTesting().map((h) => h.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('unregisterSaveHook', () => {
  it('removes a hook by id', () => {
    registerSaveHook({ id: 'foo', run: async () => {} });
    unregisterSaveHook('foo');
    expect(_getSaveHooksForTesting()).toEqual([]);
  });

  it('is a no-op for unknown ids', () => {
    expect(() => unregisterSaveHook('does-not-exist')).not.toThrow();
  });
});

describe('saveStateBeforeUpdate', () => {
  it('runs all hooks and reports completed', async () => {
    const a = vi.fn().mockResolvedValue(undefined);
    const b = vi.fn().mockResolvedValue(undefined);
    registerSaveHook({ id: 'a', run: a });
    registerSaveHook({ id: 'b', run: b });
    const result = await saveStateBeforeUpdate();
    expect(a).toHaveBeenCalled();
    expect(b).toHaveBeenCalled();
    expect(result.hooks.map((h) => h.outcome)).toEqual(['completed', 'completed']);
  });

  it('captures hook errors as outcome=errored without throwing', async () => {
    registerSaveHook({
      id: 'broken',
      run: async () => {
        throw new Error('boom');
      },
    });
    const result = await saveStateBeforeUpdate();
    expect(result.hooks[0]!.outcome).toBe('errored');
    expect(result.hooks[0]!.error).toBe('boom');
  });

  it('enforces per-hook budget (timed-out)', async () => {
    registerSaveHook({
      id: 'slow',
      budgetMs: 50,
      run: async () => {
        await new Promise((r) => setTimeout(r, 200));
      },
    });
    const result = await saveStateBeforeUpdate();
    expect(result.hooks[0]!.outcome).toBe('timed-out');
    // The hook ran for at least its budget
    expect(result.hooks[0]!.elapsedMs).toBeGreaterThanOrEqual(40);
  });

  it('enforces total budget by skipping later hooks once exhausted', async () => {
    registerSaveHook({
      id: 'first',
      budgetMs: 200,
      run: async () => {
        await new Promise((r) => setTimeout(r, 200));
      },
    });
    registerSaveHook({
      id: 'second',
      run: async () => {
        // Should never be called -- total budget exhausted by first.
      },
    });
    const result = await saveStateBeforeUpdate({ totalBudgetMs: 100 });
    expect(result.hooks[0]!.outcome).toBe('timed-out');
    expect(result.hooks[1]!.outcome).toBe('timed-out');
    expect(result.hooks[1]!.error).toBe('total budget exhausted');
  });

  it('returns elapsedMs reflecting wall-clock', async () => {
    registerSaveHook({
      id: 'tick',
      run: async () => {
        await new Promise((r) => setTimeout(r, 50));
      },
    });
    const result = await saveStateBeforeUpdate();
    expect(result.elapsedMs).toBeGreaterThanOrEqual(40);
  });
});
