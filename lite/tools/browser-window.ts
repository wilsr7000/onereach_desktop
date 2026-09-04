/**
 * Tool browser window (2026-09-02: "tools in the app opened the web
 * page in Chrome. Should have launched an electron window extra large
 * without security stuff so popups and google connect work").
 *
 * A tool is a web app the person works in — Notion, GitHub, a Google
 * console. Clicking it now opens ONE large in-app window per tool
 * (focused and reused on the next click) instead of handing the URL to
 * the OS browser. What makes sign-in work there:
 *
 *   - Chrome parity (ADR-063, shared with the tab browser): a Chrome
 *     user agent (Google refuses OAuth to an "embedded webview" UA),
 *     window.open() popups handled — OAuth providers open as in-app
 *     popups on the SAME partition so the opener/cookie handshake
 *     completes, featureless opens go to app tabs, mailto: etc. to the
 *     OS — plus the right-click menu and the downloads pipeline.
 *   - A persistent partition shared by every tool (`persist:lite-tools`)
 *     so "Connect with Google" done once carries across tools and
 *     restarts.
 *   - Sized to the screen: ~92% of the primary work area, capped at it,
 *     never smaller than 1280×800 unless the display is.
 *
 * "Without security stuff" means no popup blocking and no OAuth
 * dead-ends — NOT no sandbox: the page is still sandboxed, context-
 * isolated, without node integration, with webSecurity, and gets no
 * preload (ADR-038: third-party content never sees window.lite.*).
 *
 * @internal
 */

import { BrowserWindow, screen, type WebContents } from 'electron';
import type { ToolEntry } from './types.js';
import { getLoggingApi } from '../logging/api.js';
import { TOOLS_EVENTS } from './events.js';
import { windowBackgroundColor } from '../theme/main.js';
import { attachChromeParity } from '../main-window/browser-parity.js';

/** One persistent session for every tool — sign in once. */
export const TOOLS_PARTITION = 'persist:lite-tools';
/** Floor for the window size; the screen's work area is the ceiling. */
const MIN_WIDTH = 1280;
const MIN_HEIGHT = 800;
/** Fraction of the primary work area a tool window takes by default. */
const WORK_AREA_FRACTION = 0.92;

const windows = new Map<string, BrowserWindow>();

/** ~92% of the primary display, floored at 1280×800, capped at the work area. */
export function toolWindowSize(workArea: { width: number; height: number }): { width: number; height: number } {
  const width = Math.min(workArea.width, Math.max(MIN_WIDTH, Math.round(workArea.width * WORK_AREA_FRACTION)));
  const height = Math.min(workArea.height, Math.max(MIN_HEIGHT, Math.round(workArea.height * WORK_AREA_FRACTION)));
  return { width, height };
}

/**
 * Open (or focus) the tool's window. Invalid URLs are refused with a
 * warning — the store only admits http/https, so this is belt-and-braces.
 */
export function openToolInBrowser(entry: ToolEntry): void {
  const log = getLoggingApi();
  if (!isValidHttpUrl(entry.url)) {
    log.warn('tools', 'browser-window: refused invalid URL', { id: entry.id, url: String(entry.url).slice(0, 120) });
    return;
  }

  const existing = windows.get(entry.id);
  if (existing !== undefined && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore();
    existing.focus();
    log.event(TOOLS_EVENTS.BROWSER_OPENED, { id: entry.id, reused: true });
    return;
  }

  const { width, height } = toolWindowSize(screen.getPrimaryDisplay().workAreaSize);
  const win = new BrowserWindow({
    width,
    height,
    minWidth: 720,
    minHeight: 480,
    title: entry.label,
    backgroundColor: windowBackgroundColor(),
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      // No preload — third-party page must not see window.lite.*
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      partition: TOOLS_PARTITION,
      // Web apps keep working (timers, media) while another window is in front.
      backgroundThrottling: false,
    },
  });
  windows.set(entry.id, win);

  // Chrome parity: UA, OAuth-aware popup routing (recursively for the
  // popups themselves), context menu, downloads. This is what makes
  // "Connect with Google" complete instead of dead-ending.
  attachChromeParity(win.webContents, { partition: TOOLS_PARTITION });
  keepTitle(win.webContents, entry);

  const loadStart = Date.now();
  win.webContents.on('did-finish-load', () => {
    log.event(TOOLS_EVENTS.BROWSER_LOADED, { id: entry.id, durationMs: Date.now() - loadStart });
  });
  win.webContents.on('did-fail-load', (_e, errorCode, errorDescription, _url, isMainFrame) => {
    if (errorCode === -3 || !isMainFrame) return; // ABORTED / a subframe
    log.warn('tools', 'browser-window: load failed', { id: entry.id, errorCode, errorDescription });
  });
  win.once('ready-to-show', () => {
    if (!win.isDestroyed()) win.show();
  });
  win.on('closed', () => {
    if (windows.get(entry.id) === win) windows.delete(entry.id);
  });

  void win.loadURL(entry.url).catch((err: unknown) => {
    log.warn('tools', 'browser-window: loadURL rejected', {
      id: entry.id,
      error: err instanceof Error ? err.message : String(err),
    });
  });
  log.event(TOOLS_EVENTS.BROWSER_OPENED, { id: entry.id, reused: false, width, height });
}

/** Close every tool window. Idempotent; used by teardown. */
export function closeAllToolBrowsers(): void {
  for (const [id, win] of windows.entries()) {
    try {
      if (!win.isDestroyed()) win.close();
    } catch {
      /* best-effort */
    }
    windows.delete(id);
  }
}

/** @internal — exposed for tests. */
export function _getToolWindowsForTesting(): Map<string, BrowserWindow> {
  return windows;
}

// ─── helpers ──────────────────────────────────────────────────────────

/** The window title is the tool's label, never the page's `<title>`. */
function keepTitle(contents: WebContents, entry: ToolEntry): void {
  contents.on('page-title-updated', (event) => {
    event.preventDefault();
  });
  const win = BrowserWindow.fromWebContents(contents);
  win?.setTitle(entry.label);
}

function isValidHttpUrl(url: unknown): boolean {
  if (typeof url !== 'string' || url.length === 0) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}
