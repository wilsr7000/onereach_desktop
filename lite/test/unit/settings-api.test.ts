/**
 * SettingsApi tests.
 *
 * Per Rule 12 / HARNESS.md, every module's `api.ts` runs through
 * `runApiConformanceContract`. Settings exposes a single method --
 * `open()` -- that opens or focuses the Settings window.
 *
 * The default `getSettingsApi()` returns a no-op until `initSettings()`
 * runs at boot (which swaps in the BrowserWindow-backed implementation
 * via `_setSettingsApiForTesting`). The conformance contract exercises
 * the singleton swap pattern and method presence; we don't need a
 * BrowserWindow to verify the API surface.
 */

import { describe, it, expect, vi } from 'vitest';

// Mock electron so the static `import { ... } from 'electron'` in
// settings/window.ts and settings/main.ts resolves under vitest's
// Node runner. We never actually construct a BrowserWindow in this
// test -- the conformance contract checks the surface only.
vi.mock('electron', () => ({
  BrowserWindow: class {},
  ipcMain: { handle: () => undefined, removeHandler: () => undefined },
}));

// Import directly from the conformance file -- the harness/index.js
// barrel pulls in @playwright/test (via launch.ts) which clashes
// with the vi.mock('electron') above.
import { runApiConformanceContract } from '../harness/api-conformance.js';
import {
  getSettingsApi,
  _resetSettingsApiForTesting,
  _setSettingsApiForTesting,
  type SettingsApi,
} from '../../settings/api.js';

// 1. Conformance contract.
runApiConformanceContract<SettingsApi>({
  name: 'SettingsApi',
  getInstance: getSettingsApi,
  resetForTesting: _resetSettingsApiForTesting,
  setForTesting: _setSettingsApiForTesting,
  expectedMethods: ['open'],
});

// 2. Module-specific shape tests.
describe('SettingsApi (default singleton)', () => {
  it('open() is a no-op before initSettings() runs', () => {
    _resetSettingsApiForTesting();
    const api = getSettingsApi();
    // Should not throw; just logs a warning via getLoggingApi().
    expect(() => api.open()).not.toThrow();
  });

  it('singleton swap installs the real implementation', () => {
    _resetSettingsApiForTesting();
    let openCallCount = 0;
    const stub: SettingsApi = {
      open: () => {
        openCallCount += 1;
      },
    };
    _setSettingsApiForTesting(stub);

    const api = getSettingsApi();
    expect(api).toBe(stub);
    api.open();
    expect(openCallCount).toBe(1);
  });
});
