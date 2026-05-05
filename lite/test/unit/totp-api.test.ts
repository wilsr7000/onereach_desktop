/**
 * TotpApi tests.
 *
 * Structured per Rule 12 / HARNESS.md:
 *   1. `runApiConformanceContract` -- the uniform contract every module
 *      passes (singleton, reset, set-for-testing, expected methods).
 *   2. Module-specific behavior tests -- only what's not already covered
 *      by the conformance contract or the meatier auth-store tests.
 *
 * Real keychain + screen-capture behavior is exercised in
 * `totp-store.test.ts` and the integration test against an injected
 * fake. This file just validates the API SHAPE.
 */

import { describe, it, expect, vi } from 'vitest';

// Mock electron + native deps so the static `import { ... } from 'electron'`
// in window.ts / qr-scanner.ts and the `require('keytar')` / `require('jsqr')`
// in store.ts / qr-scanner.ts resolve under vitest's Node runner.
vi.mock('electron', () => ({
  BrowserWindow: class {},
  ipcMain: { handle: () => undefined, removeHandler: () => undefined },
  shell: { openExternal: () => Promise.resolve() },
  clipboard: { readImage: () => ({ isEmpty: () => true, getSize: () => ({ width: 0, height: 0 }), toBitmap: () => Buffer.alloc(0) }) },
  desktopCapturer: { getSources: async () => [] },
  screen: {
    getPrimaryDisplay: () => ({ workAreaSize: { width: 1, height: 1 }, scaleFactor: 1, id: 0 }),
    getDisplayNearestPoint: () => ({ workAreaSize: { width: 1, height: 1 }, scaleFactor: 1, id: 0 }),
  },
}));
vi.mock('keytar', () => ({
  setPassword: async () => undefined,
  getPassword: async () => null,
  deletePassword: async () => false,
}));
vi.mock('jsqr', () => ({ default: () => null }));

import {
  getTotpApi,
  _buildTotpApiForTesting,
  _resetTotpApiForTesting,
  _setTotpApiForTesting,
  type TotpApi,
} from '../../totp/api.js';
import { runApiConformanceContract } from '../harness/api-conformance.js';
import type { KeychainBackend } from '../../totp/store.js';

// 1. Conformance contract.
runApiConformanceContract<TotpApi>({
  name: 'TotpApi',
  getInstance: getTotpApi,
  resetForTesting: _resetTotpApiForTesting,
  setForTesting: _setTotpApiForTesting,
  expectedMethods: [
    'hasSecret',
    'getMetadata',
    'saveSecret',
    'scanQrFromScreen',
    'scanQrFromClipboard',
    'getCurrentCode',
    'deleteSecret',
  ],
});

// 2. Module-specific shape tests.
describe('TotpApi (default singleton)', () => {
  class EmptyKeychain implements KeychainBackend {
    async setPassword(): Promise<void> {
      return undefined;
    }
    async getPassword(): Promise<string | null> {
      return null;
    }
    async deletePassword(): Promise<boolean> {
      return false;
    }
  }

  it('hasSecret resolves to false when keychain has no entry', async () => {
    const api = _buildTotpApiForTesting({ keychain: new EmptyKeychain() });
    await expect(api.hasSecret()).resolves.toBe(false);
  });

  it('getMetadata resolves to null when no secret stored', async () => {
    const api = _buildTotpApiForTesting({ keychain: new EmptyKeychain() });
    await expect(api.getMetadata()).resolves.toBeNull();
  });
});
