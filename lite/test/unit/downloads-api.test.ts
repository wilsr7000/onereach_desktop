/**
 * DownloadsApi conformance contract + module-specific tests.
 *
 * Rule 12 (LITE-RULES.md) requires every module's public api.ts to
 * pass `runApiConformanceContract`. Adding this file also keeps the
 * module-conformance meta-test green.
 *
 * The uninitialized stub throws on every method (matches sibling
 * modules' uninit behaviour); the conformance contract is run with
 * an injected stub so the standard checks see a working surface.
 */

import { describe, it, expect, vi } from 'vitest';

// downloads/api.ts is electron-free (no top-level imports from
// 'electron'), so no mock is required to import it. Keeping the
// pattern explicit here in case a future addition pulls electron in.
vi.mock('electron', () => ({}));

import { runApiConformanceContract } from '../harness/api-conformance.js';
import {
  getDownloadsApi,
  _resetDownloadsApiForTesting,
  _setDownloadsApiForTesting,
  type DownloadsApi,
} from '../../downloads/api.js';

// The default uninitialized singleton exposes `attachToSession` as a
// function (one that throws synchronously on use). The conformance
// contract only checks the shape -- `typeof method === 'function'` --
// so the uninit stub passes without any setup.

runApiConformanceContract<DownloadsApi>({
  name: 'DownloadsApi',
  getInstance: getDownloadsApi,
  resetForTesting: _resetDownloadsApiForTesting,
  setForTesting: _setDownloadsApiForTesting,
  expectedMethods: ['attachToSession'],
});

describe('DownloadsApi (default singleton)', () => {
  it('attachToSession throws before initDownloads() has run', () => {
    _resetDownloadsApiForTesting();
    const api = getDownloadsApi();
    expect(() =>
      api.attachToSession({} as unknown as Electron.Session)
    ).toThrow(/before initDownloads/);
  });

  it('singleton swap installs the real implementation', () => {
    _resetDownloadsApiForTesting();
    let attachCount = 0;
    const stub: DownloadsApi = {
      attachToSession: () => {
        attachCount += 1;
        return () => undefined;
      },
    };
    _setDownloadsApiForTesting(stub);

    const api = getDownloadsApi();
    expect(api).toBe(stub);
    api.attachToSession({} as unknown as Electron.Session);
    expect(attachCount).toBe(1);
  });
});
