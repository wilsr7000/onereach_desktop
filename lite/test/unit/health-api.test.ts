/**
 * HealthApi tests (ADR-036).
 *
 * Standard conformance contract per Rule 12 + module-specific tests
 * that exercise the singleton-swap pattern. The store's behavior is
 * covered in `health-store.test.ts`; this file validates only the API
 * SHAPE.
 */

import { describe, it, expect, vi } from 'vitest';

// Mock electron so the static `import { BrowserWindow } from 'electron'`
// in store.ts resolves under vitest's Node runner. The conformance
// contract checks the surface only -- we never construct a window.
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: () => undefined, removeHandler: () => undefined },
}));

// Import directly from the conformance file (not the harness barrel)
// to avoid the @playwright/test dependency.
import { runApiConformanceContract } from '../harness/api-conformance.js';
import {
  getHealthApi,
  _resetHealthApiForTesting,
  _setHealthApiForTesting,
  HEALTH_SCHEMA_VERSION,
  type HealthApi,
  type AppHealthSnapshot,
} from '../../health/api.js';

// 1. Conformance contract.
runApiConformanceContract<HealthApi>({
  name: 'HealthApi',
  getInstance: getHealthApi,
  resetForTesting: _resetHealthApiForTesting,
  setForTesting: _setHealthApiForTesting,
  expectedMethods: ['snapshot'],
});

// 2. Module-specific tests.
describe('HealthApi (default singleton)', () => {
  it('snapshot() before initHealth() returns a well-shaped fallback', async () => {
    _resetHealthApiForTesting();
    const snap = await getHealthApi().snapshot();
    expect(snap.schemaVersion).toBe(HEALTH_SCHEMA_VERSION);
    expect(snap.auth.signedIn).toBe(false);
    expect(snap.auth.hasMultToken).toBe(false);
    expect(snap.auth.hasAccountToken).toBe(false);
    expect(snap.totp.configured).toBe(false);
    expect(snap.neon.configured).toBe(false);
    expect(snap.updater.failedAttempts).toBe(0);
    expect(snap.diagnostics.recentErrorCount).toBe(0);
    expect(Array.isArray(snap.windows)).toBe(true);
    expect(snap.windows).toHaveLength(0);
  });

  it('singleton swap installs a custom implementation', async () => {
    _resetHealthApiForTesting();
    const captured: Array<string> = [];
    const stubSnapshot = (): Promise<AppHealthSnapshot> => {
      captured.push('called');
      return getHealthApi.constructor === Function
        ? Promise.resolve({
            schemaVersion: HEALTH_SCHEMA_VERSION,
            capturedAt: new Date(0).toISOString(),
            app: {
              version: 'stub',
              platform: 'darwin',
              arch: 'arm64',
              uptimeMs: 0,
              userDataPath: '/stub',
              startedAt: 0,
            },
            windows: [],
            auth: {
              signedIn: false,
              environment: 'edison',
              hasMultToken: false,
              hasAccountToken: false,
            },
            totp: { configured: false, hasCurrentCode: false },
            neon: { configured: false, ready: false, hasPassword: false },
            updater: { failedAttempts: 0, lastAttemptVersion: null, lastAttemptTime: null },
            diagnostics: { recentErrorCount: 0, recentWarnCount: 0 },
          })
        : Promise.reject(new Error('unreachable'));
    };
    const stub: HealthApi = { snapshot: stubSnapshot };
    _setHealthApiForTesting(stub);

    expect(getHealthApi()).toBe(stub);
    const snap = await getHealthApi().snapshot();
    expect(snap.app.version).toBe('stub');
    expect(captured).toEqual(['called']);

    _resetHealthApiForTesting();
    // After reset, the default uninitialized impl returns again.
    const after = await getHealthApi().snapshot();
    expect(after.app.version).toBe('0.0.0');
  });
});
