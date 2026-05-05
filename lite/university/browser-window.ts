/**
 * Shared "Learning Browser" window for Agentic University content.
 *
 * Mirrors `lite/idw/browser-window.ts` -- one singleton Electron
 * BrowserWindow that loads whatever URL the user most recently
 * clicked. Forerunner of an eventual unified tabbed browser; the
 * swap point is the `loadURL` call.
 *
 * Separate persistent partition from IDW (`persist:lite-university`)
 * so the user's LMS / course session cookies are isolated from
 * IDW agent sessions. They're different trust contexts -- a
 * compromised IDW page should not be able to ride a logged-in LMS
 * session.
 *
 * Security posture (deliberate):
 *  - NO preload -- third-party content (LMS, Wiser Method, UX Mag)
 *    must not see `window.lite.*`.
 *  - Sandboxed + contextIsolated + no node integration + webSecurity.
 *  - `setWindowOpenHandler` denies child Electron windows; routes
 *    target=_blank links to the OS default browser.
 *
 * Defensive URL handling: invalid URLs surface a friendly modal
 * dialog and leave any existing window untouched.
 *
 * @internal
 */

import { BrowserWindow, dialog, shell } from 'electron';
import type { LearningEntry } from './types.js';
import { KIND_UI } from './curated-content.js';
import { getLoggingApi } from '../logging/api.js';
import { UNIVERSITY_EVENTS } from './events.js';

const PARTITION = 'persist:lite-university';
const DEFAULT_WIDTH = 1400;
const DEFAULT_HEIGHT = 900;

let browserWindow: BrowserWindow | null = null;
let activeEntry: LearningEntry | null = null;
let loadStart: number = 0;

/**
 * Open the entry in the shared Learning Browser. Creates the
 * window if absent, focuses + replaces the URL otherwise.
 *
 * Validates the URL before any window work. Surfaces a friendly
 * dialog on invalid URLs.
 */
export function openLearningInBrowser(entry: LearningEntry): void {
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
      // Tutorials/LMS often have video; allow background throttling
      // to be off so videos keep playing when the window is in the
      // background. Matches the full app's `openLearningWindow`
      // behavior in `lib/gsx-autologin.js`.
      backgroundThrottling: false,
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

  browserWindow.webContents.on('did-start-loading', () => {
    if (activeEntry !== null) {
      loadStart = Date.now();
      getLoggingApi().event(UNIVERSITY_EVENTS.BROWSER_LOADING, { id: activeEntry.id });
    }
  });
  browserWindow.webContents.on('did-finish-load', () => {
    if (activeEntry !== null) {
      const durationMs = Date.now() - loadStart;
      getLoggingApi().event(UNIVERSITY_EVENTS.BROWSER_LOADED, {
        id: activeEntry.id,
        durationMs,
      });
    }
  });

  // External links + window.open() targets route to the OS default
  // browser; never spawn child Electron windows.
  browserWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
}

/** Close the shared Learning Browser if open. Idempotent. */
export function closeLearningBrowser(): void {
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

function showInvalidUrlDialog(entry: LearningEntry): void {
  const meta = KIND_UI[entry.kind];
  const message = `Cannot open ${entry.title}: the URL is not a valid web address.`;
  const detail = `URL: ${typeof entry.url === 'string' ? entry.url : '(missing)'}\n\nThis is a bug in the curated catalog. The ${meta.label} won't load until the URL is fixed.`;
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
  getLoggingApi().warn('university', 'browser-window: refused invalid URL', {
    id: entry.id,
    kind: entry.kind,
    url: entry.url,
  });
}

function formatTitle(entry: LearningEntry): string {
  return `Agentic University - ${entry.title}`;
}
