/**
 * WISER Playbooks launcher window.
 *
 * Opens the WISER Playbooks web app in a dedicated, singleton Lite
 * BrowserWindow. Subsequent launches focus the existing window rather
 * than spawning a second one.
 *
 * Security posture (borrowed from lite/idw/browser-window.ts):
 *  - NO preload -- the hosted web app must not see `window.lite.*` or any
 *    Lite IPC bridge. WISER talks to its own backend over HTTPS directly.
 *  - Sandboxed + contextIsolated + no node integration + webSecurity on.
 *  - Persistent partition (`persist:lite-wiser-playbooks`) so the app's
 *    cookies / localStorage / IndexedDB survive window closures.
 *  - Window-open handler denies child Electron windows; external links
 *    (target=_blank, window.open) route to the OS default browser via
 *    `shell.openExternal`.
 *
 * [lite] wiser-playbooks-window.ts: borrows the BrowserWindow security
 * posture + singleton/open-handler pattern from
 * lite/idw/browser-window.ts:51-130; rewrites it for a single fixed URL
 * (no per-entry catalog, no OAuth-popup handler) for lite scope.
 *
 * @internal
 */

import { BrowserWindow, screen, shell } from 'electron';
import { getLoggingApi } from './logging/api.js';

/**
 * The deployed WISER Playbooks build the launcher opens. This is the
 * edison public build URL confirmed by the product owner. Change this
 * single constant to repoint the launcher at a different deployment.
 */
export const WISER_PLAYBOOKS_URL =
  'https://files.edison.api.onereach.ai/public/35254342-4a2e-475b-aec1-18547e517e29/riff/index.html';

const PARTITION = 'persist:lite-wiser-playbooks';
// Target a comfortably large window for the full Playbooks UI. Clamped to
// the primary display's work area at open time so it never spawns
// off-screen / oversized on smaller laptops. (Was a fixed 1280x800, which
// felt cramped for the app.)
const TARGET_WIDTH = 1600;
const TARGET_HEIGHT = 1000;

let win: BrowserWindow | null = null;

/**
 * Open (or focus) the WISER Playbooks window. Idempotent: a second call
 * while the window is open focuses the existing one instead of creating
 * another.
 */
export function openWiserPlaybooksWindow(): void {
  if (win !== null && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.focus();
    getLoggingApi().event('wiser-playbooks.focus', { url: WISER_PLAYBOOKS_URL });
    return;
  }

  // Size to the target, clamped to the current display's work area so the
  // window always fits on screen, then center it.
  const { width: workW, height: workH } = screen.getPrimaryDisplay().workAreaSize;
  const width = Math.min(TARGET_WIDTH, workW);
  const height = Math.min(TARGET_HEIGHT, workH);

  win = new BrowserWindow({
    width,
    height,
    center: true,
    title: 'WISER Playbooks',
    backgroundColor: '#1a1a1a',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      // No preload -- the hosted page must not see window.lite.*
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      partition: PARTITION,
    },
  });

  void win.loadURL(WISER_PLAYBOOKS_URL);

  win.once('ready-to-show', () => {
    if (win !== null && !win.isDestroyed()) win.show();
  });
  win.on('closed', () => {
    win = null;
  });

  // External links route to the OS default browser; deny in-app child
  // Electron windows.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      void shell.openExternal(url).catch(() => {
        // best-effort -- openExternal can reject on headless hosts
      });
    }
    return { action: 'deny' };
  });

  getLoggingApi().event('wiser-playbooks.opened', { url: WISER_PLAYBOOKS_URL });
}

/** Close the WISER Playbooks window if open. Idempotent. */
export function closeWiserPlaybooksWindow(): void {
  if (win !== null && !win.isDestroyed()) {
    win.close();
  }
  win = null;
}

/** @internal -- exposed for tests. */
export function _getWiserPlaybooksWindowForTesting(): BrowserWindow | null {
  return win;
}

/** @internal -- exposed for tests. */
export function _resetWiserPlaybooksWindowForTesting(): void {
  win = null;
}
