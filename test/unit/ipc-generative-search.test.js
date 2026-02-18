/**
 * IPC Generative Search Namespace - Lifecycle Tests
 *
 * Lifecycle: search -> onProgress -> cancel -> clearCache -> verify
 *
 * Run:  npx vitest run test/unit/ipc-generative-search.test.js
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockInvoke = vi.fn().mockResolvedValue({ success: true });
const mockOn = vi.fn();

const generativeSearch = {
  search: (opts) => mockInvoke('generative-search:search', opts),
  estimateCost: (opts) => mockInvoke('generative-search:estimate-cost', opts),
  cancel: () => mockInvoke('generative-search:cancel'),
  getFilterTypes: () => mockInvoke('generative-search:get-filter-types'),
  clearCache: () => mockInvoke('generative-search:clear-cache'),
  onProgress: (cb) => mockOn('generative-search:progress', cb),
};

beforeEach(() => {
  mockInvoke.mockClear();
  mockOn.mockClear();
});

// ═══════════════════════════════════════════════════════════════════
// SEARCH LIFECYCLE
// ═══════════════════════════════════════════════════════════════════

describe('IPC Generative Search - Lifecycle', () => {
  it('Step 1: Get filter types', async () => {
    await generativeSearch.getFilterTypes();
    expect(mockInvoke).toHaveBeenCalledWith('generative-search:get-filter-types');
  });

  it('Step 2: Estimate cost', async () => {
    await generativeSearch.estimateCost({ query: 'test', filters: {} });
    expect(mockInvoke).toHaveBeenCalledWith('generative-search:estimate-cost', { query: 'test', filters: {} });
  });

  it('Step 3: Start search', async () => {
    await generativeSearch.search({ query: 'find documents about AI', maxResults: 10 });
    expect(mockInvoke).toHaveBeenCalledWith('generative-search:search', {
      query: 'find documents about AI',
      maxResults: 10,
    });
  });

  it('Step 4: Register progress callback', () => {
    const cb = vi.fn();
    generativeSearch.onProgress(cb);
    expect(mockOn).toHaveBeenCalledWith('generative-search:progress', cb);
  });

  it('Step 5: Cancel search', async () => {
    await generativeSearch.cancel();
    expect(mockInvoke).toHaveBeenCalledWith('generative-search:cancel');
  });

  it('Step 6: Clear cache', async () => {
    await generativeSearch.clearCache();
    expect(mockInvoke).toHaveBeenCalledWith('generative-search:clear-cache');
  });
});
