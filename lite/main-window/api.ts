/**
 * Main window module -- PUBLIC API.
 *
 * The only file other lite modules should import from in this module.
 * Per ADR-019 / Rule 11 in `lite/LITE-RULES.md`, cross-module imports
 * go through `<module>/api.ts` -- never reach into `store.ts`,
 * `window.ts`, or any other internal file.
 *
 * The main-window module hosts lite's tabbed agent browser. Each tab
 * is a sandboxed `WebContentsView` running a third-party agent in its
 * own persistent partition. The chrome (tab bar) is a separate
 * webContents loaded from `lite/main-window/chrome.html`.
 *
 * See `./types.ts` for `Tab`, `OpenTabInput`, `TabsBlob`. See ADR-038
 * in `lite/DECISIONS.md` for the full architectural rationale.
 *
 * Tests: `_setMainWindowApiForTesting(stub)` to inject a custom
 * implementation, `_resetMainWindowApiForTesting()` to clear the singleton.
 */

import { TabStore } from './store.js';
import { MainWindowError, MAIN_WINDOW_ERROR_CODES } from './errors.js';
import { getLoggingApi } from '../logging/api.js';
import { getAuthApi } from '../auth/api.js';

// Re-export the public types consumers need to typecheck calls.
export type {
  Tab,
  TabsBlob,
  OpenTabInput,
  OpenTabResult,
} from './types.js';
export {
  MAIN_WINDOW_MODULE_VERSION,
  CHROME_HEIGHT_PX,
  PARTITION_PREFIX,
} from './types.js';

// Re-export the structured error class + code catalog.
export type { MainWindowErrorCode, MainWindowErrorOptions } from './errors.js';
export { MainWindowError, MAIN_WINDOW_ERROR_CODES };

// Re-export the typed event surface (ADR-032).
export type {
  MainWindowEvent,
  MainWindowEventName,
  MainWindowOpenTabStartEvent,
  MainWindowOpenTabFinishEvent,
  MainWindowOpenTabFailEvent,
  MainWindowCloseTabStartEvent,
  MainWindowCloseTabFinishEvent,
  MainWindowCloseTabFailEvent,
  MainWindowActivateTabStartEvent,
  MainWindowActivateTabFinishEvent,
  MainWindowActivateTabFailEvent,
  MainWindowChangedEvent,
  MainWindowTabNavigatedEvent,
  MainWindowTabLoadStartEvent,
  MainWindowTabLoadFinishEvent,
  MainWindowTabLoadFailEvent,
  MainWindowIpcOpenTabEvent,
  MainWindowIpcCloseTabEvent,
  MainWindowIpcActivateTabEvent,
  MainWindowIpcListTabsEvent,
} from './events.js';
export { MAIN_WINDOW_EVENTS, isMainWindowEvent } from './events.js';

// Generic base class -- consumers can also catch via `instanceof
// LiteError` if they want to handle errors uniformly across all lite
// modules.
export { LiteError, isLiteError } from '../errors.js';

import type { Tab, OpenTabInput, OpenTabResult } from './types.js';
import type { MainWindowEvent } from './events.js';

/**
 * The public surface of the main-window module.
 *
 * **Error contract**: `openTab` / `closeTab` / `activateTab` throw
 * `MainWindowError` (extends `LiteError`) on failure. Inspect `.code`
 * to branch on `MW_NOT_FOUND`, `MW_INVALID_INPUT`, `MW_INVALID_URL`,
 * `MW_DUPLICATE_PARTITION`, `MW_PERSISTENCE_FAILED`. `list` / `get` /
 * `getActiveTabId` do not throw; they return empty / null on failure.
 *
 * **Renderer surface**: `openTab`, `closeTab`, `activateTab`,
 * `listTabs`, `getActiveTabId`, `onTabsChanged`, `parseError` are
 * bridged via `window.lite.mainWindow.*` to the chrome (tab bar)
 * webContents only -- agent tabs themselves have no preload and
 * cannot reach this surface.
 */
export interface MainWindowApi {
  /** All open tabs, in display order. */
  listTabs(): Promise<Tab[]>;
  /** Single tab by id, or null if absent. */
  get(id: string): Promise<Tab | null>;
  /** Active tab id, or null if no tabs are open. */
  getActiveTabId(): Promise<string | null>;
  /**
   * Open a new tab, OR (when `idwId` matches an existing tab) focus
   * the existing one. Returns `{ tab, wasFocus }` so callers can choose
   * "Opened" vs "Focused" toast copy.
   *
   * @throws {MainWindowError} `MW_INVALID_INPUT` for missing / wrong-type fields.
   * @throws {MainWindowError} `MW_INVALID_URL` for non-http/https URLs.
   * @throws {MainWindowError} `MW_DUPLICATE_PARTITION` if the generated partition collides.
   * @throws {MainWindowError} `MW_PERSISTENCE_FAILED` if KV write rejects.
   */
  openTab(input: OpenTabInput): Promise<OpenTabResult>;
  /**
   * Close a tab. If the closed tab was active, picks the next sibling
   * (or the previous one if the closed tab was the last). When no tabs
   * remain, sets `activeId` to null.
   *
   * @throws {MainWindowError} `MW_NOT_FOUND` if no tab with `id`.
   * @throws {MainWindowError} `MW_PERSISTENCE_FAILED` if KV write rejects.
   */
  closeTab(id: string): Promise<void>;
  /**
   * Set the active tab. The chrome (tab bar) and the window factory
   * subscribe via `onTabsChanged`; activating triggers a view swap.
   *
   * @throws {MainWindowError} `MW_NOT_FOUND` if no tab with `id`.
   * @throws {MainWindowError} `MW_PERSISTENCE_FAILED` if KV write rejects.
   */
  activateTab(id: string): Promise<void>;
  /**
   * Clear the active tab id without closing any tab -- the chrome's
   * "Home" pill calls this when the user wants to see the welcome
   * view. The window factory hides every tab view when activeId is
   * null, so the chrome's home content shows through. Idempotent.
   */
  goHome(): Promise<void>;
  /**
   * Update a tab's last-known URL. Called from the window factory on
   * `did-navigate-in-page` / `did-navigate` events. Soft-fails on
   * unknown ids (race-safe).
   */
  setTabUrl(id: string, url: string): Promise<void>;
  /**
   * Update a tab's display label. Called when a tab's `<title>`
   * resolves. Soft-fails on unknown ids.
   */
  setTabLabel(id: string, label: string): Promise<void>;
  /**
   * Subscribe to mutations. Handler receives the latest tab list +
   * activeId each time the store mutates. Returns an unsubscribe.
   */
  onTabsChanged(handler: (tabs: Tab[], activeId: string | null) => void): () => void;
  /**
   * Subscribe to typed main-window events (ADR-032). Returns an unsubscribe.
   */
  onEvent(handler: (event: MainWindowEvent) => void): () => void;
}

let _instance: MainWindowApi | null = null;

/**
 * Get the singleton main-window API. Lazily instantiates on first
 * call with the default `TabStore` (KV-backed).
 */
export function getMainWindowApi(): MainWindowApi {
  if (_instance === null) {
    _instance = buildDefaultApi();
  }
  return _instance;
}

/** Reset the singleton (for tests). */
export function _resetMainWindowApiForTesting(): void {
  _instance = null;
}

/** Override the singleton with a custom implementation (for tests). */
export function _setMainWindowApiForTesting(api: MainWindowApi): void {
  _instance = api;
}

// ─── default implementation ──────────────────────────────────────────────

function buildDefaultApi(): MainWindowApi {
  const store = new TabStore({
    logger: (level, message, data) => {
      const log = getLoggingApi();
      log[level]('main-window', message, data);
    },
    spanEmitter: (name, data) => getLoggingApi().start(name, data),
    // Multi-user isolation: scope tab persistence by signed-in
    // OneReach accountId. The KV endpoint is anonymous and globally
    // shared, so a single 'default' key meant every install saw every
    // other user's tabs. Returns null when signed-out, which the
    // store treats as empty + refuse-to-write.
    getActiveAccountId: () => getAuthApi().getSession('edison')?.accountId ?? null,
  });
  return {
    listTabs: () => store.list(),
    get: (id) => store.get(id),
    getActiveTabId: () => store.getActiveId(),
    openTab: (input) => store.openTab(input),
    closeTab: (id) => store.closeTab(id),
    activateTab: (id) => store.activateTab(id),
    goHome: () => store.goHome(),
    setTabUrl: (id, url) => store.setUrl(id, url),
    setTabLabel: (id, label) => store.setLabel(id, label),
    onTabsChanged: (handler) => store.onChange(handler),
    onEvent: (handler) => store.onEvent(handler),
  };
}
