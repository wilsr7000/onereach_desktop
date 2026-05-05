/**
 * Main window main-process orchestration.
 *
 * Owns:
 *   - IPC handlers for `lite:main-window:open-tab/close-tab/activate-tab/list-tabs/get-active`
 *   - Broadcast of `lite:main-window:changed` to all windows on
 *     mutations so the chrome (tab bar) re-renders live
 *   - Wiring the window factory (`createMainWindow`)
 *
 * Per ADR-019 / Rule 11, this module is the boundary between Electron
 * IPC and the typed `MainWindowApi`. Renderers never see `TabStore`
 * directly.
 *
 * Per ADR-030, every handler emits an instant `main-window.ipc.<verb>`
 * event on entry so renderer-driven activity is observable in `/logs`.
 */

import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron';
import {
  getMainWindowApi,
  MainWindowError,
  _resetMainWindowApiForTesting,
  type Tab,
  type OpenTabInput,
  type OpenTabResult,
} from './api.js';
import { MAIN_WINDOW_EVENTS } from './events.js';
import {
  createMainWindow,
  closeMainWindow,
  getMainWindow,
  openActiveTabDevTools,
  _resetMainWindowForTesting,
} from './window.js';
import { getLoggingApi } from '../logging/api.js';

// ---------------------------------------------------------------------------
// IPC channel names. All prefixed `lite:main-window:` per Rule 3.
// ---------------------------------------------------------------------------

export const MAIN_WINDOW_IPC = {
  OPEN_TAB: 'lite:main-window:open-tab',
  CLOSE_TAB: 'lite:main-window:close-tab',
  ACTIVATE_TAB: 'lite:main-window:activate-tab',
  LIST_TABS: 'lite:main-window:list-tabs',
  GET_ACTIVE: 'lite:main-window:get-active',
  GO_HOME: 'lite:main-window:go-home',
  CHANGED: 'lite:main-window:changed',
} as const;

// ---------------------------------------------------------------------------
// Init / teardown
// ---------------------------------------------------------------------------

export interface InitMainWindowOptions {
  /** Path to the bundled chrome.html (tab bar + home view). */
  chromeHtmlPath: string;
  /** Path to the bundled preload-lite.js. The chrome uses this; tab views do NOT. */
  preloadPath: string;
  /** Optional logger -- routed through lite logging by default. */
  logger?: {
    info: (message: string, data?: unknown) => void;
    warn: (message: string, data?: unknown) => void;
    error: (message: string, data?: unknown) => void;
  };
}

export interface MainWindowHandle {
  /** The BrowserWindow used as the main window (chrome host). */
  window: BrowserWindow;
  /** Open DevTools for the active tab WebContentsView, if one is visible. */
  openActiveTabDevTools(): boolean;
  /** Tear down IPC handlers, close the window, drop subscriptions. Idempotent. */
  teardown(): void;
}

let registered = false;
let unsubscribeChange: (() => void) | null = null;

/**
 * Register IPC handlers, open the main window, and wire the broadcast
 * subscription. Safe to call multiple times -- subsequent calls focus
 * the existing window.
 */
export function initMainWindow(opts: InitMainWindowOptions): MainWindowHandle {
  const log = opts.logger ?? {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };

  const win = createMainWindow({
    chromeHtmlPath: opts.chromeHtmlPath,
    preloadPath: opts.preloadPath,
  });

  if (registered) {
    return { window: win, openActiveTabDevTools, teardown: teardownInternal };
  }

  const api = getMainWindowApi();

  // ── IPC handlers ───────────────────────────────────────────────────────

  ipcMain.handle(MAIN_WINDOW_IPC.LIST_TABS, async (): Promise<Tab[]> => {
    getLoggingApi().event(MAIN_WINDOW_EVENTS.IPC_LIST_TABS);
    return api.listTabs();
  });

  ipcMain.handle(MAIN_WINDOW_IPC.GET_ACTIVE, async (): Promise<{ activeId: string | null }> => {
    return { activeId: await api.getActiveTabId() };
  });

  ipcMain.handle(
    MAIN_WINDOW_IPC.OPEN_TAB,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<OpenTabResult> => {
      getLoggingApi().event(MAIN_WINDOW_EVENTS.IPC_OPEN_TAB);
      const input = validateOpenTabPayload(payload);
      try {
        const result = await api.openTab(input);
        log.info('open-tab ok', { id: result.tab.id, wasFocus: result.wasFocus });
        return result;
      } catch (err) {
        if (err instanceof MainWindowError) {
          log.warn('open-tab rejected', { code: err.code, message: err.message });
          throw new Error(JSON.stringify({ __mainWindowError: err.toJSON() }));
        }
        log.error('open-tab unexpected error', { error: (err as Error).message });
        throw err;
      }
    }
  );

  ipcMain.handle(
    MAIN_WINDOW_IPC.CLOSE_TAB,
    async (_event: IpcMainInvokeEvent, payload: { id?: unknown }): Promise<{ ok: true }> => {
      getLoggingApi().event(MAIN_WINDOW_EVENTS.IPC_CLOSE_TAB);
      const id = validateNonEmptyString(payload?.id, 'id');
      try {
        await api.closeTab(id);
        log.info('close-tab ok', { id });
        return { ok: true };
      } catch (err) {
        if (err instanceof MainWindowError) {
          log.warn('close-tab rejected', { code: err.code, message: err.message });
          throw new Error(JSON.stringify({ __mainWindowError: err.toJSON() }));
        }
        log.error('close-tab unexpected error', { error: (err as Error).message });
        throw err;
      }
    }
  );

  ipcMain.handle(
    MAIN_WINDOW_IPC.ACTIVATE_TAB,
    async (_event: IpcMainInvokeEvent, payload: { id?: unknown }): Promise<{ ok: true }> => {
      getLoggingApi().event(MAIN_WINDOW_EVENTS.IPC_ACTIVATE_TAB);
      const id = validateNonEmptyString(payload?.id, 'id');
      try {
        await api.activateTab(id);
        log.info('activate-tab ok', { id });
        return { ok: true };
      } catch (err) {
        if (err instanceof MainWindowError) {
          log.warn('activate-tab rejected', { code: err.code, message: err.message });
          throw new Error(JSON.stringify({ __mainWindowError: err.toJSON() }));
        }
        log.error('activate-tab unexpected error', { error: (err as Error).message });
        throw err;
      }
    }
  );

  ipcMain.handle(MAIN_WINDOW_IPC.GO_HOME, async (): Promise<{ ok: true }> => {
    try {
      await api.goHome();
      return { ok: true };
    } catch (err) {
      if (err instanceof MainWindowError) {
        throw new Error(JSON.stringify({ __mainWindowError: err.toJSON() }));
      }
      throw err;
    }
  });

  // ── Live cross-window updates ──────────────────────────────────────────
  //
  // When the store changes, broadcast `lite:main-window:changed` to
  // every open BrowserWindow. The chrome subscribes and re-renders
  // the tab bar.
  unsubscribeChange = api.onTabsChanged((tabs, activeId) => {
    for (const w of BrowserWindow.getAllWindows()) {
      try {
        if (!w.isDestroyed()) {
          w.webContents.send(MAIN_WINDOW_IPC.CHANGED, { tabs, activeId });
        }
      } catch (err) {
        log.warn('broadcast changed failed', {
          windowId: w.id,
          error: (err as Error).message,
        });
      }
    }
  });

  registered = true;
  log.info('main-window initialized', {});
  return { window: win, openActiveTabDevTools, teardown: teardownInternal };
}

function teardownInternal(): void {
  if (!registered) return;
  try {
    ipcMain.removeHandler(MAIN_WINDOW_IPC.LIST_TABS);
    ipcMain.removeHandler(MAIN_WINDOW_IPC.GET_ACTIVE);
    ipcMain.removeHandler(MAIN_WINDOW_IPC.OPEN_TAB);
    ipcMain.removeHandler(MAIN_WINDOW_IPC.CLOSE_TAB);
    ipcMain.removeHandler(MAIN_WINDOW_IPC.ACTIVATE_TAB);
    ipcMain.removeHandler(MAIN_WINDOW_IPC.GO_HOME);
  } catch {
    // best-effort
  }
  if (unsubscribeChange !== null) {
    try {
      unsubscribeChange();
    } catch {
      // best-effort
    }
    unsubscribeChange = null;
  }
  try {
    closeMainWindow();
  } catch {
    // best-effort
  }
  registered = false;
}

/** @internal -- exposed for tests. */
export function _isMainWindowRegisteredForTesting(): boolean {
  return registered;
}

/** @internal -- exposed for tests so they can re-init cleanly. */
export function _resetMainWindowRegistrationForTesting(): void {
  teardownInternal();
  _resetMainWindowApiForTesting();
  _resetMainWindowForTesting();
}

/** Re-export the main window getter so other modules can resolve a parent. */
export { getMainWindow };

// ---------------------------------------------------------------------------
// Payload validation
// ---------------------------------------------------------------------------

function validateNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function validateOpenTabPayload(value: unknown): OpenTabInput {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('open-tab payload must be an object');
  }
  const v = value as Record<string, unknown>;
  const url = validateNonEmptyString(v['url'], 'url');
  const label = validateNonEmptyString(v['label'], 'label');
  const out: OpenTabInput = { url, label };
  if (typeof v['idwId'] === 'string' && v['idwId'].length > 0) {
    out.idwId = v['idwId'];
  }
  if (typeof v['iconName'] === 'string' && v['iconName'].length > 0) {
    out.iconName = v['iconName'];
  }
  return out;
}
