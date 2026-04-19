/**
 * Variant Selector -- Unit Tests
 *
 * Uses the injected classifier override so tests never hit the LLM.
 * Verifies:
 *   - Cache hit skips the classifier.
 *   - Invalid/unknown variants fall back to 'winner'.
 *   - Errors from the classifier fall back to 'winner'.
 *   - Empty content defaults to 'winner' without calling the classifier.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const {
  selectVariant,
  clearVariantCache,
  getVariantCacheSize,
  VALID_VARIANTS,
  DEFAULT_VARIANT,
} = require('../../lib/exchange/variant-selector');

beforeEach(() => {
  clearVariantCache();
});

describe('selectVariant -- basic routing', () => {
  it('returns winner for empty content', async () => {
    const classifier = vi.fn();
    const r = await selectVariant({ content: '' }, { classifier });
    expect(r).toBe('winner');
    expect(classifier).not.toHaveBeenCalled();
  });

  it('returns winner for whitespace-only content', async () => {
    const r = await selectVariant({ content: '   ' }, {
      classifier: async () => 'council',
    });
    expect(r).toBe('winner');
  });

  it('forwards content to the classifier', async () => {
    const classifier = vi.fn(async () => 'council');
    await selectVariant({ content: 'evaluate this plan' }, { classifier });
    expect(classifier).toHaveBeenCalledWith({ content: 'evaluate this plan' });
  });

  it('returns what the classifier returned when valid', async () => {
    for (const variant of VALID_VARIANTS) {
      clearVariantCache();
      const r = await selectVariant({ content: `test for ${variant}` }, {
        classifier: async () => variant,
      });
      expect(r).toBe(variant);
    }
  });

  it('falls back to DEFAULT_VARIANT when classifier returns invalid value', async () => {
    const r = await selectVariant({ content: 'unknown variant' }, {
      classifier: async () => 'not-a-variant',
    });
    expect(r).toBe(DEFAULT_VARIANT);
  });

  it('falls back to DEFAULT_VARIANT when classifier returns null/undefined', async () => {
    const r1 = await selectVariant({ content: 'a' }, { classifier: async () => null });
    expect(r1).toBe(DEFAULT_VARIANT);
    clearVariantCache();
    const r2 = await selectVariant({ content: 'b' }, { classifier: async () => undefined });
    expect(r2).toBe(DEFAULT_VARIANT);
  });

  it('falls back to DEFAULT_VARIANT when classifier throws', async () => {
    const r = await selectVariant({ content: 'oops' }, {
      classifier: async () => { throw new Error('LLM failure'); },
    });
    expect(r).toBe(DEFAULT_VARIANT);
  });
});

describe('selectVariant -- cache', () => {
  it('caches results keyed on normalized task content', async () => {
    let calls = 0;
    const classifier = async () => {
      calls += 1;
      return 'council';
    };
    const t = { content: 'Evaluate this plan' };
    const r1 = await selectVariant(t, { classifier });
    const r2 = await selectVariant({ content: 'evaluate this plan' }, { classifier });
    const r3 = await selectVariant({ content: '  Evaluate this plan  ' }, { classifier });
    expect(r1).toBe('council');
    expect(r2).toBe('council');
    expect(r3).toBe('council');
    expect(calls).toBe(1); // the three requests resolved to the same cache key
  });

  it('clearVariantCache empties the cache', async () => {
    await selectVariant({ content: 'cached' }, { classifier: async () => 'council' });
    expect(getVariantCacheSize()).toBeGreaterThan(0);
    clearVariantCache();
    expect(getVariantCacheSize()).toBe(0);
  });
});

describe('VALID_VARIANTS / DEFAULT_VARIANT', () => {
  it('DEFAULT_VARIANT is winner', () => {
    expect(DEFAULT_VARIANT).toBe('winner');
  });

  it('VALID_VARIANTS contains the three documented variants', () => {
    expect(VALID_VARIANTS.has('winner')).toBe(true);
    expect(VALID_VARIANTS.has('council')).toBe(true);
    expect(VALID_VARIANTS.has('lead_plus_probers')).toBe(true);
  });
});
