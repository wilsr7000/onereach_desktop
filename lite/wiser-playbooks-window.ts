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

import { BrowserWindow, WebContentsView, screen, shell } from 'electron';
import { join } from 'node:path';
import { getLoggingApi } from './logging/api.js';
import { getAuthApi } from './auth/api.js';
import { readAttributionEmailSync } from './spaces/identity-store.js';

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

// The comp's header, for real: the window's own webContents loads the
// local `wiser-header.html` strip (paper, wordmark, mini cap-chew,
// full-width drag region) and the hosted app renders in a sandboxed
// WebContentsView laid out below it — the same chrome-page + view
// pattern the main window uses (ADR-038). No CSS is injected into the
// remote app; its viewport is simply shorter.
const HEADER_PX = 38;

let win: BrowserWindow | null = null;
let view: WebContentsView | null = null;

/**
 * The signed-in viewer's email for the ?riffUser hand-off — the session
 * email, same source as the Spaces identity gate. Null when unknown:
 * the hosted app then fails closed on its own rather than showing
 * someone else's spaces and playbooks.
 */
function wiserViewerIdentity(): string | null {
  try {
    const session = getAuthApi().getSession('edison');
    const email = typeof session?.email === 'string' ? session.email.trim().toLowerCase() : '';
    if (email.length > 0) return email;
  } catch {
    /* signed-out or auth not initialized — try the fallback below */
  }
  // Session carries no email — the SAME gap as the 2026-08-15 viewer
  // incident (14 spaces invisible): many GSX sign-ins never put an
  // email in the `or` cookie. Without a viewer the hosted app fails
  // closed — welcome screen, 0 playbooks, and any ?riff= deep link
  // dies with "Deep-linked playbook not found after timeout". Fall
  // back to the user-declared attribution email exactly like
  // `viewerId()` in spaces/main.ts does.
  return readAttributionEmailSync();
}

/** Keep the app view filling the window below the header strip. */
function layoutView(): void {
  if (win === null || view === null || win.isDestroyed()) return;
  const { width, height } = win.getContentBounds();
  view.setBounds({ x: 0, y: HEADER_PX, width, height: Math.max(0, height - HEADER_PX) });
}

/**
 * Open (or focus) the WISER Playbooks window. Idempotent: a second call
 * while the window is open focuses the existing one instead of creating
 * another.
 */
export function openWiserPlaybooksWindow(opts?: { riffId?: string }): void {
  // ADR-065 hand-off: pass the signed-in identity so the hosted app's
  // belonging-gated listings know who is looking. Without it the app
  // fails closed (shows nothing) rather than showing someone else's
  // spaces and playbooks.
  const params = new URLSearchParams();
  if (opts?.riffId !== undefined && opts.riffId.length > 0) {
    params.set('riff', opts.riffId);
  }
  const viewer = wiserViewerIdentity();
  if (viewer !== null) params.set('riffUser', viewer);
  const qs = params.toString();
  const target = qs.length > 0 ? `${WISER_PLAYBOOKS_URL}?${qs}` : WISER_PLAYBOOKS_URL;

  if (win !== null && !win.isDestroyed()) {
    // Deep link into the already-open window: point the app view at the
    // requested playbook (the hosted app consumes ?riff= on load).
    if (opts?.riffId !== undefined && view !== null) {
      void view.webContents.loadURL(target);
    }
    if (win.isMinimized()) win.restore();
    win.focus();
    getLoggingApi().event('wiser-playbooks.focus', {
      url: WISER_PLAYBOOKS_URL,
      deepLink: opts?.riffId !== undefined,
    });
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
    // Pre-paint shell matches the header strip (Cap Chew paper).
    backgroundColor: '#f1ede4',
    show: false,
    autoHideMenuBar: true,
    // macOS: no title bar — the traffic lights sit inset over the strip.
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' as const }
      : {}),
    webPreferences: {
      // The header page is local, static, and needs no bridge at all.
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  void win.loadFile(join(__dirname, 'wiser-header.html'));

  view = new WebContentsView({
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
  win.contentView.addChildView(view);
  layoutView();
  win.on('resize', layoutView);
  win.on('enter-full-screen', layoutView);
  win.on('leave-full-screen', layoutView);
  void view.webContents.loadURL(target);

  win.once('ready-to-show', () => {
    if (win !== null && !win.isDestroyed()) win.show();
  });
  win.on('closed', () => {
    win = null;
    view = null;
  });

  // Containment (0.0.46 review): the view carries the window.ai preload
  // (Claude on the app's keychain key), so TOP-LEVEL NAVIGATION stays
  // pinned to the Playbooks origin — a cross-origin destination would
  // inherit the preload. Anything else opens in the OS browser instead,
  // the same policy as window.open below.
  const wiserOrigin = new URL(WISER_PLAYBOOKS_URL).origin;
  view.webContents.on('will-navigate', (event, url) => {
    let dest: URL | null = null;
    try {
      dest = new URL(url);
    } catch {
      dest = null;
    }
    if (dest === null || dest.origin !== wiserOrigin) {
      event.preventDefault();
      if (dest !== null && /^https?:$/.test(dest.protocol)) {
        void shell.openExternal(url).catch(() => {
          // best-effort -- openExternal can reject on headless hosts
        });
      }
    }
  });

  // External links route to the OS default browser; deny in-app child
  // Electron windows. (Attached to the APP view -- the header page never
  // opens windows.)
  view.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      void shell.openExternal(url).catch(() => {
        // best-effort -- openExternal can reject on headless hosts
      });
    }
    return { action: 'deny' };
  });

  getLoggingApi().event('wiser-playbooks.opened', {
    url: WISER_PLAYBOOKS_URL,
    deepLink: opts?.riffId !== undefined,
  });
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
