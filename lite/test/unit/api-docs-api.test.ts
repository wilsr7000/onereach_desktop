/**
 * ApiDocsApi tests (ADR-035).
 *
 * Standard conformance contract per Rule 12, plus module-specific
 * tests for the singleton-swap pattern.
 */

import { describe, it, expect, vi } from 'vitest';

// Mock electron so the static `import { ... } from 'electron'` in
// api-docs/main.ts and api-docs/window.ts resolves under vitest's
// Node runner. The conformance contract checks the surface only --
// we never actually construct a BrowserWindow.
vi.mock('electron', () => ({
  BrowserWindow: class {},
  ipcMain: { handle: () => undefined, removeHandler: () => undefined },
}));

// Import directly from the conformance file (not the harness barrel)
// to avoid the @playwright/test dependency.
import { runApiConformanceContract } from '../harness/api-conformance.js';
import {
  getApiDocsApi,
  _resetApiDocsApiForTesting,
  _setApiDocsApiForTesting,
  type ApiDocsApi,
} from '../../api-docs/api.js';

// 1. Conformance contract.
runApiConformanceContract<ApiDocsApi>({
  name: 'ApiDocsApi',
  getInstance: getApiDocsApi,
  resetForTesting: _resetApiDocsApiForTesting,
  setForTesting: _setApiDocsApiForTesting,
  expectedMethods: ['open'],
});

// 2. Module-specific shape tests.
describe('ApiDocsApi (default singleton)', () => {
  it('open() is a no-op before initApiDocs() runs', () => {
    _resetApiDocsApiForTesting();
    const api = getApiDocsApi();
    expect(() => api.open()).not.toThrow();
  });

  it('singleton swap installs the real implementation', () => {
    _resetApiDocsApiForTesting();
    let openCallCount = 0;
    const stub: ApiDocsApi = {
      open: () => {
        openCallCount += 1;
      },
    };
    _setApiDocsApiForTesting(stub);

    const api = getApiDocsApi();
    expect(api).toBe(stub);
    api.open();
    expect(openCallCount).toBe(1);
  });
});
