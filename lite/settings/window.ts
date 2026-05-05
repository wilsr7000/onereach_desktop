/**
 * Settings window factory.
 *
 * Per ADR-031, single-instance BrowserWindow modeled on the deleted
 * `lite/totp/window.ts` and `lite/bug-report/main.ts`'s modal pattern:
 *   - parent: mainWindow (glued to the placeholder, not modal)
 *   - Uses the kernel's single preload (`preload-lite.js`) so renderer
 *     code can call `window.lite.totp.*` for the Two-Factor section
 *   - Loads `settings.html` from `dist-lite/build/`
 *
 * @internal -- consumers go through `getSettingsApi()`.
 */

import { BrowserWindow, type Rectangle } from 'electron';

interface SettingsWindowConfig {
  parent: BrowserWindow | null;
  htmlPath: string;
  preloadPath: string;
  /**
   * Optional section id to deep-link to (e.g. 'idws', 'oagi'). When
   * the window is already open, the existing window is focused AND
   * navigated to the requested section via a webContents-side hash
   * change (the renderer listens for hashchange events). When opened
   * fresh, the section id is appended as a query string and the
   * renderer reads it on bootstrap.
   */
  sectionId?: string;
}

let openWindow: BrowserWindow | null = null;

/**
 * Open (or focus) the Settings window. Returns the BrowserWindow
 * reference. Idempotent: subsequent calls focus the existing window.
 *
 * If `sectionId` is provided, the window opens (or navigates) to
 * that section. The renderer reads `?section=<id>` on bootstrap and
 * activates the matching section. When the window already exists,
 * `executeJavaScript` triggers an in-page activate call.
 */
export function openSettingsWindow(config: SettingsWindowConfig): BrowserWindow {
  if (openWindow !== null && !openWindow.isDestroyed()) {
    if (openWindow.isMinimized()) openWindow.restore();
    openWindow.focus();
    if (typeof config.sectionId === 'string' && config.sectionId.length > 0) {
      // Best-effort: tell the renderer to switch sections. The
      // renderer exposes `__liteActivateSection` on window when it
      // boots; if the bridge isn't installed, this no-ops silently.
      const safeId = JSON.stringify(config.sectionId);
      openWindow.webContents
        .executeJavaScript(
          `(function(){try{if(typeof window.__liteActivateSection==='function'){window.__liteActivateSection(${safeId});}}catch(e){}})()`
        )
        .catch(() => {
          // best-effort
        });
    }
    return openWindow;
  }

  const win = new BrowserWindow({
    width: 960,
    height: 680,
    title: 'Settings',
    backgroundColor: '#0e0e10',
    show: false,
    autoHideMenuBar: true,
    resizable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    minWidth: 760,
    minHeight: 560,
    ...(config.parent !== null ? { parent: config.parent } : {}),
    webPreferences: {
      preload: config.preloadPath,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });

  // file:// loadFile() doesn't accept a query natively, so use the
  // `query` option on loadFile() to append `?section=<id>` to the URL.
  // The renderer reads location.search on bootstrap.
  if (typeof config.sectionId === 'string' && config.sectionId.length > 0) {
    void win.loadFile(config.htmlPath, { query: { section: config.sectionId } });
  } else {
    void win.loadFile(config.htmlPath);
  }

  win.once('ready-to-show', () => {
    win.show();
    centerOnParent(win, config.parent);
  });

  win.on('closed', () => {
    if (openWindow === win) openWindow = null;
  });

  openWindow = win;
  return win;
}

/** Close the Settings window if it is open. Idempotent. */
export function closeSettingsWindow(): void {
  if (openWindow !== null && !openWindow.isDestroyed()) {
    openWindow.close();
  }
  openWindow = null;
}

/** @internal -- testing helper */
export function _isSettingsWindowOpenForTesting(): boolean {
  return openWindow !== null && !openWindow.isDestroyed();
}

function centerOnParent(win: BrowserWindow, parent: BrowserWindow | null): void {
  if (parent === null || parent.isDestroyed()) return;
  try {
    const p: Rectangle = parent.getBounds();
    const c: Rectangle = win.getBounds();
    const x = Math.round(p.x + (p.width - c.width) / 2);
    const y = Math.round(p.y + (p.height - c.height) / 2);
    win.setBounds({ x, y, width: c.width, height: c.height });
  } catch {
    // best-effort centering
  }
}
