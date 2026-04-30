/**
 * recorder.js -- account-id reconciliation between settings.gsxAccountId
 * and the account embedded in settings.gsxRefreshUrl.
 *
 * Regression guard for:
 *   "[Session] Guest page publish failed: Error: Cross account requests
 *    allowed to SUPER_ADMIN only"
 *
 * Root cause: settings.gsxAccountId drifted behind the account id
 * embedded in settings.gsxRefreshUrl, so the Edison Files SDK was
 * initialized against a stale account while the token it used was
 * issued for a different account.
 *
 * These are pure-function tests against the two helpers recorder.js
 * exports for that reconciliation. The broader IPC handler and the
 * Edison SDK integration are exercised by the E2E journey suite.
 *
 * Run:  npx vitest run test/unit/recorder-account-reconciliation.test.js
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// recorder.js does `const { ipcMain, ... } = require('electron')` at
// module load, but only uses those bindings inside methods we never
// call here. Stub the log-queue and event-logger so the module can
// load without touching the real logger.
vi.mock('../../lib/log-event-queue', () => ({
  getLogQueue: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../../event-logger', () => ({
  default: () => ({
    logWindowNavigation: vi.fn(),
    logFeatureUsed: vi.fn(),
  }),
}));

const { _accountIdFromRefreshUrl, _reconcileGsxAccount } = require('../../recorder.js');

describe('accountIdFromRefreshUrl', () => {
  it('extracts the account id from a canonical refresh URL', () => {
    expect(
      _accountIdFromRefreshUrl(
        'https://em.edison.api.onereach.ai/http/35254342-4a2e-475b-aec1-18547e517e29/refresh_token'
      )
    ).toBe('35254342-4a2e-475b-aec1-18547e517e29');
  });

  it('works for arbitrary UUIDs', () => {
    expect(
      _accountIdFromRefreshUrl(
        'https://em.edison.api.onereach.ai/http/05bd3c92-5d3c-4dc5-a95d-0c584695cea4/refresh_token'
      )
    ).toBe('05bd3c92-5d3c-4dc5-a95d-0c584695cea4');
  });

  it('returns empty string when the path has no account id', () => {
    expect(
      _accountIdFromRefreshUrl('https://em.edison.api.onereach.ai/http//refresh_token')
    ).toBe('');
  });

  it('returns empty string for non-refresh URLs', () => {
    expect(
      _accountIdFromRefreshUrl(
        'https://files.edison.api.onereach.ai/public/05bd3c92-5d3c-4dc5-a95d-0c584695cea4/other'
      )
    ).toBe('');
  });

  it('returns empty string for null / undefined / non-string', () => {
    expect(_accountIdFromRefreshUrl(null)).toBe('');
    expect(_accountIdFromRefreshUrl(undefined)).toBe('');
    expect(_accountIdFromRefreshUrl(12345)).toBe('');
    expect(_accountIdFromRefreshUrl('')).toBe('');
  });

  it('rejects URLs with a short / non-hex account segment', () => {
    expect(
      _accountIdFromRefreshUrl('https://em.edison.api.onereach.ai/http/abc/refresh_token')
    ).toBe('');
    expect(
      _accountIdFromRefreshUrl(
        'https://em.edison.api.onereach.ai/http/not-hex-xxxx/refresh_token'
      )
    ).toBe('');
  });
});

describe('reconcileGsxAccount', () => {
  const URL_ACCOUNT = '05bd3c92-5d3c-4dc5-a95d-0c584695cea4';
  const STALE_ACCOUNT = '35254342-4a2e-475b-aec1-18547e517e29';
  const REFRESH_URL = `https://em.edison.api.onereach.ai/http/${URL_ACCOUNT}/refresh_token`;

  let store;
  let settings;
  let fileSync;
  let warn;

  beforeEach(() => {
    store = new Map();
    settings = {
      get: (k) => store.get(k),
      set: (k, v) => store.set(k, v),
    };
    fileSync = { isInitialized: true, client: { pushLocalPathToFiles: vi.fn() } };
    warn = vi.fn();
  });

  it('refuses when gsxRefreshUrl is missing', () => {
    store.set('gsxAccountId', URL_ACCOUNT);
    const result = _reconcileGsxAccount({ settings, fileSync, warn });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('missing-refresh-url');
    expect(result.error).toMatch(/GSX account not configured/i);
    expect(warn).not.toHaveBeenCalled();
    // Side-effect-free on failure.
    expect(fileSync.isInitialized).toBe(true);
    expect(fileSync.client).not.toBeNull();
  });

  it('refuses when refresh URL is malformed (no account id in path)', () => {
    store.set('gsxRefreshUrl', 'https://em.edison.api.onereach.ai/http//refresh_token');
    store.set('gsxAccountId', URL_ACCOUNT);
    const result = _reconcileGsxAccount({ settings, fileSync, warn });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('malformed-refresh-url');
    expect(result.error).toMatch(/malformed/i);
    expect(warn).not.toHaveBeenCalled();
  });

  it('reconciles a stale gsxAccountId to the URL-derived id', () => {
    store.set('gsxRefreshUrl', REFRESH_URL);
    store.set('gsxAccountId', STALE_ACCOUNT);

    const result = _reconcileGsxAccount({ settings, fileSync, warn });

    expect(result.ok).toBe(true);
    expect(result.accountId).toBe(URL_ACCOUNT);
    expect(result.reconciled).toBe(true);
    expect(store.get('gsxAccountId')).toBe(URL_ACCOUNT);
    // Warn called once with the drift detail so it shows up in logs.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/Reconciling/i), {
      storedAccountId: STALE_ACCOUNT,
      urlAccountId: URL_ACCOUNT,
    });
    // Forces SDK re-init so it binds to the correct account before the
    // next pushLocalPathToFiles. This is the actual bug-fix invariant:
    // without this, the SDK keeps its stale accountId and the next
    // Edison write is rejected as cross-account.
    expect(fileSync.isInitialized).toBe(false);
    expect(fileSync.client).toBeNull();
  });

  it('backfills gsxAccountId from refresh URL when absent', () => {
    store.set('gsxRefreshUrl', REFRESH_URL);
    // No gsxAccountId at all.

    const result = _reconcileGsxAccount({ settings, fileSync, warn });

    expect(result.ok).toBe(true);
    expect(result.accountId).toBe(URL_ACCOUNT);
    expect(result.reconciled).toBe(false);
    expect(store.get('gsxAccountId')).toBe(URL_ACCOUNT);
    // Backfill is not a drift -- don't log a warning.
    expect(warn).not.toHaveBeenCalled();
    // SDK untouched because nothing is stale.
    expect(fileSync.isInitialized).toBe(true);
    expect(fileSync.client).not.toBeNull();
  });

  it('does not reset the SDK when ids already agree', () => {
    store.set('gsxRefreshUrl', REFRESH_URL);
    store.set('gsxAccountId', URL_ACCOUNT);

    const result = _reconcileGsxAccount({ settings, fileSync, warn });

    expect(result.ok).toBe(true);
    expect(result.accountId).toBe(URL_ACCOUNT);
    expect(result.reconciled).toBe(false);
    expect(warn).not.toHaveBeenCalled();
    expect(fileSync.isInitialized).toBe(true);
    expect(fileSync.client).not.toBeNull();
  });

  it('tolerates missing fileSync argument', () => {
    store.set('gsxRefreshUrl', REFRESH_URL);
    store.set('gsxAccountId', STALE_ACCOUNT);

    const result = _reconcileGsxAccount({ settings, warn });

    expect(result.ok).toBe(true);
    expect(result.reconciled).toBe(true);
    expect(store.get('gsxAccountId')).toBe(URL_ACCOUNT);
    // Should not throw when fileSync is undefined -- recorder.js's
    // global.gsxFileSync can legitimately be absent early in boot.
  });

  it('tolerates missing warn callback', () => {
    store.set('gsxRefreshUrl', REFRESH_URL);
    store.set('gsxAccountId', STALE_ACCOUNT);

    expect(() => _reconcileGsxAccount({ settings, fileSync })).not.toThrow();
    expect(store.get('gsxAccountId')).toBe(URL_ACCOUNT);
  });
});
