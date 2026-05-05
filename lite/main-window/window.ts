/**
 * Main window factory + tab orchestration.
 *
 * Single `BrowserWindow` whose main webContents loads `chrome.html`
 * (the tab bar UI + home view). Below the 36px tab bar, each open
 * tab is a `WebContentsView` added as a child of the window's
 * `contentView`. The active tab's view fills the content area; all
 * others are hidden via `setVisible(false)` (warm render state, no
 * reload on switch).
 *
 * Per ADR-038:
 *  - Each tab gets a unique `persist:tab-<short-uuid>` partition.
 *  - Tab views have NO preload -- third-party agents cannot reach
 *    `window.lite.*`. The chrome (separate webContents) DOES use the
 *    standard kernel preload.
 *  - `setWindowOpenHandler` denies child Electron windows; external
 *    links route to the OS default browser via `shell.openExternal`.
 *
 * @internal -- consumers go through `getMainWindowApi()` for state
 *  ops; the factory itself is invoked by `lite/main-window/main.ts`
 *  during boot.
 */

import { BrowserWindow, WebContentsView, shell } from 'electron';
import type { Rectangle } from 'electron';
import { getLoggingApi } from '../logging/api.js';
import { getMainWindowApi } from './api.js';
import { getAuthApi, getEnvironmentForUrl } from '../auth/api.js';
import { startTotpAutofillForWebContents } from '../auth/totp-autofill.js';
import type { Tab } from './types.js';
import { CHROME_HEIGHT_PX } from './types.js';
import { MAIN_WINDOW_EVENTS } from './events.js';

interface CreateMainWindowConfig {
  /** Path to the chrome HTML file (built bundle). */
  chromeHtmlPath: string;
  /** Path to the kernel preload (the chrome uses this; tab views do NOT). */
  preloadPath: string;
}

interface AttachedTab {
  id: string;
  view: WebContentsView;
  /** Tracks the tab object we mounted; used to detect navigation churn. */
  lastUrl: string;
  /** Set on first navigation after creation -- guards against the load-time race. */
  initialLoadStarted: boolean;
  /** Detaches the main-process 2FA detector from this tab's webContents. */
  stopTotpAutofill: () => void;
}

const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 800;
const MIN_WIDTH = 720;
const MIN_HEIGHT = 480;
const BACKGROUND = '#0e0e10';

let mainWindow: BrowserWindow | null = null;
let unsubscribeStore: (() => void) | null = null;
const attachedTabs = new Map<string, AttachedTab>();
let activeAttachedTabId: string | null = null;

/**
 * Create (or focus) the main window. Idempotent: subsequent calls
 * focus the existing window. The window subscribes to the tab store
 * and reconciles its WebContentsViews with store state on every change.
 *
 * The store is read once on creation to rehydrate previously-open
 * tabs (per-tab partition strings make the agents log back in
 * automatically). After that, subscriptions drive the view set.
 */
export function createMainWindow(config: CreateMainWindowConfig): BrowserWindow {
  if (mainWindow !== null && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    return mainWindow;
  }

  const win = new BrowserWindow({
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    title: 'Onereach.ai Lite',
    backgroundColor: BACKGROUND,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: config.preloadPath,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });

  // The chrome (tab bar + home view) lives in the BrowserWindow's
  // main webContents. Tab views are added on TOP of it via
  // contentView.addChildView -- they cover the area below the tab bar.
  void win.loadFile(config.chromeHtmlPath);

  win.once('ready-to-show', () => {
    if (mainWindow === null || mainWindow.isDestroyed()) return;
    win.show();
    // Initial reconcile + rehydrate any persisted tabs.
    void rehydrateFromStore(win);
  });

  win.on('resize', () => {
    if (win.isDestroyed()) return;
    repositionActiveTab(win);
  });

  win.on('closed', () => {
    if (mainWindow === win) {
      mainWindow = null;
    }
    teardownStoreSubscription();
    stopAllAttachedTabWatchers();
    // WebContentsViews are owned by the BrowserWindow; closing the
    // window destroys them. Clear our refs.
    attachedTabs.clear();
    activeAttachedTabId = null;
  });

  // Subscribe to store changes -- mounts/unmounts tab views in
  // response to openTab/closeTab/activateTab.
  const api = getMainWindowApi();
  unsubscribeStore = api.onTabsChanged((tabs, activeId) => {
    if (mainWindow === null || mainWindow.isDestroyed()) return;
    reconcileViews(mainWindow, tabs, activeId);
  });

  mainWindow = win;
  return win;
}

/** @internal -- exposed for tests. */
export function _getMainWindowForTesting(): BrowserWindow | null {
  return mainWindow;
}

/** @internal -- exposed for tests. */
export function _resetMainWindowForTesting(): void {
  teardownStoreSubscription();
  stopAllAttachedTabWatchers();
  if (mainWindow !== null && !mainWindow.isDestroyed()) {
    mainWindow.close();
  }
  mainWindow = null;
  attachedTabs.clear();
  activeAttachedTabId = null;
}

/** Close the main window if open. Idempotent. */
export function closeMainWindow(): void {
  teardownStoreSubscription();
  if (mainWindow !== null && !mainWindow.isDestroyed()) {
    mainWindow.close();
  }
  stopAllAttachedTabWatchers();
  mainWindow = null;
  activeAttachedTabId = null;
}

/** Get the current main window (or null if not open). */
export function getMainWindow(): BrowserWindow | null {
  if (mainWindow === null || mainWindow.isDestroyed()) return null;
  return mainWindow;
}

/** Open DevTools for the currently-visible tab WebContentsView, if any. */
export function openActiveTabDevTools(): boolean {
  const active = getActiveAttachedTab();
  if (active === null) {
    getLoggingApi().warn('main-window', 'no active tab available for DevTools');
    return false;
  }

  try {
    active.view.webContents.openDevTools({ mode: 'detach' });
    getLoggingApi().event('main-window.devtools.open-active-tab', { id: active.id });
    return true;
  } catch (err) {
    getLoggingApi().warn('main-window', 'failed to open active tab DevTools', {
      id: active.id,
      error: (err as Error).message,
    });
    return false;
  }
}

function getActiveAttachedTab(): AttachedTab | null {
  if (activeAttachedTabId === null) return null;
  return attachedTabs.get(activeAttachedTabId) ?? null;
}

function stopAllAttachedTabWatchers(): void {
  for (const attached of attachedTabs.values()) {
    try {
      attached.stopTotpAutofill();
    } catch {
      /* best-effort */
    }
  }
}

// ─── store -> view reconciliation ─────────────────────────────────────────

async function rehydrateFromStore(win: BrowserWindow): Promise<void> {
  try {
    const api = getMainWindowApi();
    const tabs = await api.listTabs();
    const activeId = await api.getActiveTabId();
    reconcileViews(win, tabs, activeId);
  } catch (err) {
    getLoggingApi().warn('main-window', 'rehydrate failed', {
      error: (err as Error).message,
    });
  }
}

/**
 * Reconcile the set of attached WebContentsViews against the store's
 * tab list. Adds views for new tabs, removes views for tabs no longer
 * in the store, swaps which view is foregrounded based on activeId.
 */
function reconcileViews(win: BrowserWindow, tabs: Tab[], activeId: string | null): void {
  const tabIds = new Set(tabs.map((t) => t.id));

  // Remove views for tabs that no longer exist in the store.
  for (const [id, attached] of Array.from(attachedTabs.entries())) {
    if (!tabIds.has(id)) {
      try {
        attached.stopTotpAutofill();
      } catch {
        /* best-effort */
      }
      try {
        win.contentView.removeChildView(attached.view);
      } catch {
        /* best-effort */
      }
      // WebContentsView destruction: close webContents to release the
      // partition's renderer process. (Electron 30+ preferred path.)
      try {
        attached.view.webContents.close();
      } catch {
        /* best-effort -- some Electron versions throw if already destroyed */
      }
      attachedTabs.delete(id);
    }
  }

  // Add views for new tabs.
  for (const tab of tabs) {
    if (!attachedTabs.has(tab.id)) {
      attachTab(win, tab);
    }
  }

  // Foreground only the active tab; hide the rest.
  activeAttachedTabId = activeId;
  for (const [id, attached] of attachedTabs.entries()) {
    const isActive = id === activeId;
    attached.view.setVisible(isActive);
  }

  // Position the active tab to fill the content area below the tab bar.
  if (activeId !== null) {
    const active = attachedTabs.get(activeId);
    if (active !== undefined) {
      active.view.setBounds(computeContentBounds(win));
    }
  }
}

function attachTab(win: BrowserWindow, tab: Tab): void {
  const view = new WebContentsView({
    webPreferences: {
      // NO preload -- third-party agent pages must not see
      // window.lite.*. ADR-038.
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      partition: tab.partition,
    },
  });
  // Capture accountId from the IDW URL so the watcher can auto-select
  // it on the OneReach account-picker page (`/multi-user/list-users`).
  // OneReach drops the `?accountId=...` query when redirecting through
  // login + 2FA, so we keep the original IDW value as the authoritative
  // target. Picker auto-select is best-effort -- if the user reaches a
  // page without a captured target, they pick manually.
  const initialAccountId = extractAccountIdFromUrl(tab.url);
  const stopTotpAutofill = startTotpAutofillForWebContents(view.webContents, {
    source: `main-window-tab:${tab.id}`,
    logger: (level, message, data) => getLoggingApi()[level]('auth', message, data),
    onTwoFactorDetected: (payload) => {
      // Auto-fill is the primary path: lite/auth/totp-autofill.ts
      // generates the code from the keychain and submits it inside
      // the tab's webContents. We log the detection for diagnostics
      // but do NOT auto-open Settings -> Two-Factor anymore (that was
      // a fallback before auto-fill was reliable). Users can still
      // open Settings manually if they need to copy the code.
      getLoggingApi().event('main-window.tab.two-factor-detected', {
        id: tab.id,
        frameUrl: payload.frameUrl,
        source: payload.source,
        ...(payload.reason !== undefined ? { reason: payload.reason } : {}),
      });
    },
    getTargetAccountId: () => {
      // Prefer the live URL's accountId in case the user navigates to
      // a fresh IDW link, fall back to the IDW URL we opened with.
      const live = extractAccountIdFromUrl(safeWebContentsUrl(view.webContents));
      return live ?? initialAccountId;
    },
    onAccountPickerDetected: (payload) => {
      getLoggingApi().event('main-window.tab.account-picker-detected', {
        id: tab.id,
        frameUrl: payload.frameUrl,
        source: payload.source,
      });
    },
  });

  const attached: AttachedTab = {
    id: tab.id,
    view,
    lastUrl: tab.url,
    initialLoadStarted: false,
    stopTotpAutofill,
  };
  attachedTabs.set(tab.id, attached);

  // Initial bounds are zero; reconcileViews positions the active tab
  // immediately after attach.
  view.setBounds({ x: 0, y: CHROME_HEIGHT_PX, width: 0, height: 0 });
  view.setVisible(false);

  // Window-open handler: deny child Electron windows; route external
  // links to the OS default browser. Same posture as ADR-037's
  // placeholder browser, applied per-tab.
  view.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  // Persist navigation -- save the latest URL to the store so we can
  // restore the user's place across app restarts.
  view.webContents.on('did-navigate', (_e, url) => {
    void getMainWindowApi().setTabUrl(tab.id, url);
  });
  view.webContents.on('did-navigate-in-page', (_e, url) => {
    void getMainWindowApi().setTabUrl(tab.id, url);
  });

  // Update the tab label when the page title resolves -- gives users
  // a more informative tab pill than the static IDW label alone.
  view.webContents.on('page-title-updated', (_e, title) => {
    if (typeof title === 'string' && title.length > 0 && title.length <= 80) {
      void getMainWindowApi().setTabLabel(tab.id, title);
    }
  });

  // Load failure surface -- log it but don't bring down the tab.
  view.webContents.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL) => {
    if (errorCode === -3) return; // ABORTED -- user navigated away
    getLoggingApi().event(MAIN_WINDOW_EVENTS.TAB_LOAD_FAIL, {
      id: tab.id,
      errorCode,
      errorDescription,
    });
    getLoggingApi().warn('main-window', 'tab load failed', {
      id: tab.id,
      errorCode,
      errorDescription,
      validatedURL,
    });
  });

  view.webContents.on('did-start-loading', () => {
    if (!attached.initialLoadStarted) attached.initialLoadStarted = true;
    getLoggingApi().event(MAIN_WINDOW_EVENTS.TAB_LOAD_START, { id: tab.id });
  });

  let loadStart = Date.now();
  view.webContents.on('did-start-navigation', (_e, _url, _isInPlace, isMainFrame) => {
    if (isMainFrame) loadStart = Date.now();
  });
  view.webContents.on('did-finish-load', () => {
    getLoggingApi().event(MAIN_WINDOW_EVENTS.TAB_LOAD_FINISH, {
      id: tab.id,
      durationMs: Date.now() - loadStart,
    });
  });

  win.contentView.addChildView(view);

  // Kick off the initial navigation. URL was validated on store-side
  // openTab; we trust it here.
  //
  // Per ADR-042, if the tab points at a OneReach environment (Edison,
  // staging, etc.), inject the captured `mult` cookie into this tab's
  // partition BEFORE navigation. This is what makes the IDW agent
  // recognize the user immediately on first open -- skipping the
  // OneReach account picker. Soft-fails: when no token is available
  // (third-party agents, or user not yet signed in) we just navigate
  // and let the agent's own sign-in flow handle it.
  void prepareTabAndLoad(tab, view);
}

async function prepareTabAndLoad(tab: Tab, view: WebContentsView): Promise<void> {
  try {
    const env = getEnvironmentForUrl(tab.url);
    if (env !== null) {
      const result = await getAuthApi().injectTokenIntoPartition(env, tab.partition);
      if (!result.injected && result.reason !== undefined) {
        // Reason is informational; agent will fall back to its own
        // picker when no token. Logged at debug-equivalent level.
        getLoggingApi().info('main-window', 'token injection skipped', {
          id: tab.id,
          env,
          reason: result.reason,
        });
      }
    }
  } catch (err) {
    getLoggingApi().warn('main-window', 'token injection threw (continuing to load)', {
      id: tab.id,
      error: (err as Error).message,
    });
  }
  try {
    await view.webContents.loadURL(tab.url);
  } catch (err) {
    getLoggingApi().warn('main-window', 'initial loadURL rejected', {
      id: tab.id,
      url: tab.url,
      error: (err as Error).message,
    });
  }
}

function extractAccountIdFromUrl(url: string): string | null {
  if (typeof url !== 'string' || url.length === 0) return null;
  try {
    const parsed = new URL(url);
    const value = parsed.searchParams.get('accountId');
    return value !== null && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

function safeWebContentsUrl(webContents: Electron.WebContents): string {
  try {
    if (webContents.isDestroyed()) return '';
    return webContents.getURL();
  } catch {
    return '';
  }
}

function repositionActiveTab(win: BrowserWindow): void {
  // On every resize, the active tab's bounds need to track the window.
  // Inactive tabs are hidden anyway; their bounds don't matter until
  // they're activated, at which point reconcileViews will reposition
  // them.
  for (const attached of attachedTabs.values()) {
    if (attached.view.getVisible()) {
      attached.view.setBounds(computeContentBounds(win));
    }
  }
}

function computeContentBounds(win: BrowserWindow): Rectangle {
  const bounds = win.getContentBounds();
  return {
    x: 0,
    y: CHROME_HEIGHT_PX,
    width: bounds.width,
    height: Math.max(0, bounds.height - CHROME_HEIGHT_PX),
  };
}

function teardownStoreSubscription(): void {
  if (unsubscribeStore !== null) {
    try {
      unsubscribeStore();
    } catch {
      /* best-effort */
    }
    unsubscribeStore = null;
  }
}
