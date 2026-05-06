/**
 * Shared placeholder browser window for IDW entries.
 *
 * One singleton BrowserWindow holds whichever agent the user most
 * recently clicked. Subsequent clicks focus + replace the URL. This
 * is the forerunner of the eventual tabbed IDW browser; the swap
 * point is the `loadURL` -> `createTabInBrowser` line, with the
 * window itself, partition, and security posture all stable.
 *
 * Security posture (deliberate):
 *  - NO preload -- third-party agent pages must not see
 *    `window.lite.*` or any other Lite IPC bridge.
 *  - Sandboxed + contextIsolated + no node integration + webSecurity.
 *  - Persistent partition (`persist:lite-idw-browser`) so cookies /
 *    localStorage / IndexedDB persist across closures within ONE
 *    shared session for all IDWs. Per-IDW partitions land later if
 *    a security review demands them.
 *  - Window-open handler denies child Electron windows; external
 *    links route to the OS default browser via `shell.openExternal`.
 *
 * Defensive URL handling (review fix #14): validate the URL before
 * any window work. If invalid (missing, malformed, wrong protocol),
 * show a friendly dialog and don't open / replace the window.
 *
 * @internal
 */

import { BrowserWindow, dialog } from 'electron';
import type { IdwEntry } from './types.js';
import { KIND_META } from './kind-metadata.js';
import { getLoggingApi } from '../logging/api.js';
import { IDW_EVENTS } from './events.js';
import { buildPopupHandler } from '../auth/oauth-popup.js';

const PARTITION = 'persist:lite-idw-browser';
const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 800;

let browserWindow: BrowserWindow | null = null;
let activeEntry: IdwEntry | null = null;
let loadStart: number = 0;

/**
 * Open the agent in the shared placeholder browser window. Creates
 * the window if absent, focuses + replaces the URL otherwise.
 *
 * Validates the URL before any window work. If invalid (missing,
 * malformed, wrong protocol), shows a friendly modal dialog and
 * leaves any existing window untouched.
 */
export function openAgentInBrowser(entry: IdwEntry): void {
  if (!isValidHttpUrl(entry.url)) {
    showInvalidUrlDialog(entry);
    return;
  }

  if (browserWindow !== null && !browserWindow.isDestroyed()) {
    activeEntry = entry;
    loadStart = Date.now();
    if (browserWindow.isMinimized()) browserWindow.restore();
    browserWindow.focus();
    void browserWindow.loadURL(entry.url);
    browserWindow.setTitle(formatTitle(entry));
    return;
  }

  activeEntry = entry;
  loadStart = Date.now();
  browserWindow = new BrowserWindow({
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
    title: formatTitle(entry),
    backgroundColor: '#0e0e10',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      // No preload -- third-party page must not see window.lite.*
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      partition: PARTITION,
    },
  });

  void browserWindow.loadURL(entry.url);
  browserWindow.once('ready-to-show', () => {
    if (browserWindow !== null && !browserWindow.isDestroyed()) {
      browserWindow.show();
    }
  });
  browserWindow.on('closed', () => {
    browserWindow = null;
    activeEntry = null;
  });

  // Polish: emit progress events so renderer-side UIs (e.g. a future
  // status banner) can reflect loading state.
  browserWindow.webContents.on('did-start-loading', () => {
    if (activeEntry !== null) {
      loadStart = Date.now();
      getLoggingApi().event(IDW_EVENTS.BROWSER_LOADING, { id: activeEntry.id });
    }
  });
  browserWindow.webContents.on('did-finish-load', () => {
    if (activeEntry !== null) {
      const durationMs = Date.now() - loadStart;
      getLoggingApi().event(IDW_EVENTS.BROWSER_LOADED, {
        id: activeEntry.id,
        durationMs,
      });
    }
  });

  // Popup handler: allow OAuth IdP popups (Google / Microsoft / Apple /
  // Auth0 / Okta / etc.) in the SAME `persist:lite-idw-browser`
  // partition so cookies land in this browser's jar. Anything else
  // routes to the OS default browser via `shell.openExternal`.
  //
  // Prior behavior denied every popup, which silently broke
  // "Sign in with Google" inside ChatGPT / Claude / Gemini / etc.
  // when the user opened them via the placeholder fallback path.
  browserWindow.webContents.setWindowOpenHandler(
    buildPopupHandler({
      partition: PARTITION,
      source: 'idw-placeholder-browser',
      logger: (level, message, data) => getLoggingApi()[level]('auth', message, data),
    })
  );
}

/** Close the shared placeholder window if open. Idempotent. */
export function closeAgentBrowser(): void {
  if (browserWindow !== null && !browserWindow.isDestroyed()) {
    browserWindow.close();
  }
  browserWindow = null;
  activeEntry = null;
}

/** @internal -- exposed for tests. */
export function _getBrowserWindowForTesting(): BrowserWindow | null {
  return browserWindow;
}

/** @internal -- exposed for tests. */
export function _resetBrowserWindowForTesting(): void {
  browserWindow = null;
  activeEntry = null;
}

// ─── helpers ──────────────────────────────────────────────────────────────

function isValidHttpUrl(url: unknown): boolean {
  if (typeof url !== 'string' || url.length === 0) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:';
}

function showInvalidUrlDialog(entry: IdwEntry): void {
  const meta = KIND_META[entry.kind];
  const message = `Cannot open ${entry.label}: the configured URL is not a valid web address.`;
  const detail = `URL: ${typeof entry.url === 'string' ? entry.url : '(missing)'}\n\nGo to Settings -> ${meta.pluralLabel} to fix or remove this entry.`;
  // Dialog runs synchronously; main process. Don't await.
  void dialog
    .showMessageBox({
      type: 'warning',
      title: `Invalid ${meta.label} URL`,
      message,
      detail,
      buttons: ['OK'],
      defaultId: 0,
      noLink: true,
    })
    .catch(() => {
      // Best-effort: dialog can fail in headless test envs.
    });
  getLoggingApi().warn('idw', 'browser-window: refused invalid URL', {
    id: entry.id,
    kind: entry.kind,
    url: entry.url,
  });
}

function formatTitle(entry: IdwEntry): string {
  const meta = KIND_META[entry.kind];
  return `${entry.label} - ${meta.label}`;
}
