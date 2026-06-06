/**
 * MainWindowApi tests.
 *
 * Mirrors the structure of `idw-api.test.ts`:
 *   1. `runApiConformanceContract` -- the uniform contract every module
 *      passes (singleton, reset, set-for-testing, expected methods).
 *   2. `runErrorConformanceContract` -- the MainWindowError class
 *      threads code/message/context/remediation through `LiteError`
 *      correctly and codes are namespaced `MW_`.
 *   3. Module-specific behavior tests using injected stubs.
 *
 * Detailed transport behavior lives in `main-window-store.test.ts`
 * and `main-window-integration.test.ts`. This file focuses on the
 * shape of the public surface so a regression in api.ts shows up here.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  getMainWindowApi,
  _resetMainWindowApiForTesting,
  _setMainWindowApiForTesting,
  MainWindowError,
  MAIN_WINDOW_ERROR_CODES,
  MAIN_WINDOW_EVENTS,
  isMainWindowEvent,
  type MainWindowApi,
  type MainWindowErrorCode,
} from '../../main-window/api.js';
import { runApiConformanceContract } from '../harness/api-conformance.js';
import { runErrorConformanceContract } from '../harness/error-conformance.js';

// 1. Public-surface conformance contract.
runApiConformanceContract<MainWindowApi>({
  name: 'MainWindowApi',
  getInstance: getMainWindowApi,
  resetForTesting: _resetMainWindowApiForTesting,
  setForTesting: _setMainWindowApiForTesting,
  expectedMethods: [
    'listTabs',
    'get',
    'getActiveTabId',
    'openTab',
    'closeTab',
    'activateTab',
    'goHome',
    'setTabUrl',
    'setTabLabel',
    'onTabsChanged',
    'onEvent',
  ],
});

// 2. Error class conformance contract.
runErrorConformanceContract<MainWindowError>({
  name: 'MainWindowError',
  ErrorClass: MainWindowError,
  codeEnum: MAIN_WINDOW_ERROR_CODES,
  modulePrefix: 'MW_',
  constructErrorWithCode: (code) =>
    new MainWindowError({
      code: code as MainWindowErrorCode,
      message: 'sample',
      context: { op: 'sample' },
    }),
});

// 3. Module-specific behavior tests.

describe('MainWindowApi event surface', () => {
  beforeEach(() => {
    _resetMainWindowApiForTesting();
  });

  it('isMainWindowEvent narrows arbitrary EventRecord by name', () => {
    const goodNames = Object.values(MAIN_WINDOW_EVENTS);
    for (const name of goodNames) {
      expect(
        isMainWindowEvent({
          id: '1',
          timestamp: 't',
          name,
          level: 'info',
          category: 'main-window',
        })
      ).toBe(true);
    }
    expect(
      isMainWindowEvent({
        id: '1',
        timestamp: 't',
        name: 'kv.set.start',
        level: 'info',
        category: 'kv',
      })
    ).toBe(false);
  });

  it('MAIN_WINDOW_EVENTS contains start/finish/fail for every CRUD op', () => {
    const names = Object.values(MAIN_WINDOW_EVENTS);
    for (const op of [
      'main-window.open-tab',
      'main-window.close-tab',
      'main-window.activate-tab',
    ]) {
      expect(names).toContain(`${op}.start`);
      expect(names).toContain(`${op}.finish`);
      expect(names).toContain(`${op}.fail`);
    }
  });

  it('MAIN_WINDOW_EVENTS contains the expected activity events', () => {
    const names = Object.values(MAIN_WINDOW_EVENTS);
    expect(names).toContain('main-window.changed');
    expect(names).toContain('main-window.tab.navigated');
    expect(names).toContain('main-window.tab.load-start');
    expect(names).toContain('main-window.tab.load-finish');
    expect(names).toContain('main-window.tab.load-fail');
  });

  it('MAIN_WINDOW_EVENTS contains all expected IPC entry events', () => {
    const names = Object.values(MAIN_WINDOW_EVENTS);
    expect(names).toContain('main-window.ipc.open-tab');
    expect(names).toContain('main-window.ipc.close-tab');
    expect(names).toContain('main-window.ipc.activate-tab');
    expect(names).toContain('main-window.ipc.list-tabs');
  });
});

describe('_setMainWindowApiForTesting overrides the singleton', () => {
  beforeEach(() => {
    _resetMainWindowApiForTesting();
  });

  it('returned instance is returned by subsequent getMainWindowApi calls', () => {
    const stub: MainWindowApi = {
      listTabs: vi.fn().mockResolvedValue([]),
      get: vi.fn().mockResolvedValue(null),
      getActiveTabId: vi.fn().mockResolvedValue(null),
      openTab: vi.fn().mockResolvedValue({
        tab: {
          id: 'tab-x',
          label: 'x',
          url: 'https://x',
          partition: 'persist:tab-x',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
        wasFocus: false,
      }),
      closeTab: vi.fn().mockResolvedValue(undefined),
      activateTab: vi.fn().mockResolvedValue(undefined),
      goHome: vi.fn().mockResolvedValue(undefined),
      setTabUrl: vi.fn().mockResolvedValue(undefined),
      setTabLabel: vi.fn().mockResolvedValue(undefined),
      onTabsChanged: vi.fn().mockReturnValue(() => undefined),
      onEvent: vi.fn().mockReturnValue(() => undefined),
    };
    _setMainWindowApiForTesting(stub);
    expect(getMainWindowApi()).toBe(stub);
  });
});

// Regression: the default buildDefaultApi() must wait for the auth
// store's KV-backed hydration BEFORE reading the TabStore, otherwise
// a freshly-launched window sees "signed-out" during the read and
// returns an empty tab list — dropping the user's persisted tabs.
// Reproduces the chat-in-chrome refactor bug where ready-to-show
// fired before auth had a chance to await hydrate via IPC.
describe('listTabs/getActiveTabId await auth hydration before reading', () => {
  it('returns the persisted tabs when auth.hydrate() resolves after the first read starts', async () => {
    // Lazy imports so this test stays scoped to the auth+kv test seam
    // without polluting the global import order.
    const { _resetAuthApiForTesting, _setAuthApiForTesting } = await import(
      '../../auth/api.js'
    );
    const { _setKVApiForTesting, _resetKVApiForTesting } = await import(
      '../../kv/api.js'
    );
    const { FakeKV } = await import('../harness/index.js');
    const { KV_COLLECTION, KV_KEY } = await import('../../main-window/types.js');

    // Seed a tab blob under the eventual accountId.
    const kv = new FakeKV();
    await kv.set(KV_COLLECTION, KV_KEY, {
      schemaVersion: 1,
      tabs: [
        {
          id: 'tab-restored',
          label: 'ChatGPT',
          url: 'https://chat.openai.com/',
          partition: 'persist:tab-restored',
          createdAt: '2026-05-18T10:00:00.000Z',
          updatedAt: '2026-05-18T10:00:00.000Z',
        },
      ],
      activeId: 'tab-restored',
    });
    _setKVApiForTesting(kv);

    // Auth stub: getSession returns null until hydrate() resolves,
    // then returns a session with a real accountId — mirrors the live
    // store's "pre-hydration is signed-out" behavior.
    let hydrated = false;
    let resolveHydrate!: () => void;
    const hydratePromise = new Promise<void>((res) => {
      resolveHydrate = res;
    });
    const authStub = {
      getSession: () =>
        hydrated
          ? { accountId: 'acc-1', capturedAt: 0 }
          : null,
      hydrate: async () => {
        await hydratePromise;
        hydrated = true;
      },
      // Unused by the TabStore but required to satisfy the AuthApi
      // shape downstream callers see — return safe no-ops / nulls.
      signIn: async () => ({ accountId: 'acc-1', capturedAt: 0 }),
      signOut: async () => undefined,
      hasValidSession: () => hydrated,
      getToken: () => null,
      getTokenBundle: () => null,
      injectTokenIntoPartition: async () => ({ injected: false }),
      setSession: () => undefined,
      onEvent: () => () => undefined,
      onSessionChanged: () => () => undefined,
    };
    _setAuthApiForTesting(authStub as unknown as Parameters<typeof _setAuthApiForTesting>[0]);

    _resetMainWindowApiForTesting();
    const api = getMainWindowApi();

    // Kick off the read; resolve hydrate AFTER the read has started.
    const tabsPromise = api.listTabs();
    const activeIdPromise = api.getActiveTabId();

    // Read should still be pending — hydrate hasn't resolved yet.
    resolveHydrate();

    const tabs = await tabsPromise;
    const activeId = await activeIdPromise;

    expect(tabs.map((t) => t.id)).toEqual(['tab-restored']);
    expect(activeId).toBe('tab-restored');

    // Clean up the singletons we touched.
    _resetMainWindowApiForTesting();
    _resetAuthApiForTesting();
    _resetKVApiForTesting();
  });
});
