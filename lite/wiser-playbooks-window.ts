/**
 * WISER Playbooks launcher window.
 *
 * Opens the WISER Playbooks web app in a dedicated, singleton Lite
 * BrowserWindow. Subsequent launches focus the existing window rather
 * than spawning a second one.
 *
 * Security posture (borrowed from lite/idw/browser-window.ts):
 *  - MINIMAL preload (`preload-lite-wiser.js`) exposing ONLY `window.ai` --
 *    a Claude chat proxy backed by the app's OS-keychain key. The hosted
 *    page never sees `window.lite.*`, any other IPC channel, or the key
 *    itself (the Claude call happens in the main process). This lets the
 *    embedded Playbooks run on the Onereach app's token. WISER still talks
 *    to its own backend over HTTPS for everything else.
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
import { join } from 'node:path';
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

// Frameless header (macOS): the title bar is hidden and the hosted app's
// own background becomes the header, so the window chrome always matches
// the app — charcoal today, Cap Chew paper once the themed build deploys.
// The app's content is padded down by this many pixels and a transparent
// draggable strip covers the gap (drag-to-move + double-click-to-zoom).
const HEADER_PX = 38;
const HEADER_CSS = `
  #root { padding-top: ${HEADER_PX}px; box-sizing: border-box; }
  /* The app's shell sizes itself with h-screen (viewport units ignore
     the root padding) — shrink it by the header so nothing scrolls. */
  #root .h-screen { height: calc(100vh - ${HEADER_PX}px); }
  body::before {
    content: "";
    position: fixed;
    top: 0; left: 0; right: 0;
    height: ${HEADER_PX}px;
    -webkit-app-region: drag;
    z-index: 2147483646;
  }
`;

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
    // Pre-paint shell matches the Cap Chew paper build; the window only
    // shows on ready-to-show, so this is a fallback, not a flash.
    backgroundColor: '#f1ede4',
    show: false,
    autoHideMenuBar: true,
    // macOS: no title bar — the app itself is the header (see HEADER_CSS).
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' as const }
      : {}),
    webPreferences: {
      // Minimal preload: exposes ONLY `window.ai` (a Claude chat proxy
      // backed by the app's keychain key) -- never `window.lite.*` and
      // never the key itself. See preload-lite-wiser.ts for the rationale.
      // Sandbox-safe: the built bundle's only runtime require is `electron`
      // (contextBridge/ipcRenderer); everything else is inlined by esbuild.
      preload: join(__dirname, 'preload-lite-wiser.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      partition: PARTITION,
    },
  });

  void win.loadURL(WISER_PLAYBOOKS_URL);

  // Frameless-header support (macOS): pad the app below the traffic
  // lights and lay the transparent drag strip. Injected on every load so
  // in-app navigations keep a draggable window. body::before is free in
  // the hosted app (its grain overlay uses body::after).
  if (process.platform === 'darwin') {
    win.webContents.on('dom-ready', () => {
      void win?.webContents.insertCSS(HEADER_CSS).catch(() => {
        // best-effort — a failed injection leaves a working, undraggable-
        // at-top window rather than a broken one
      });
    });
  }

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
