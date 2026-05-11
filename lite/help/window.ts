/**
 * Help window factory.
 *
 * Single-instance `BrowserWindow` that loads `help.html`. Mirrors the
 * Settings window pattern (`lite/settings/window.ts`):
 *   - Subsequent open() calls focus the existing window instead of
 *     spawning a duplicate.
 *   - Uses the kernel's single preload (`preload-lite.js`) so the
 *     renderer can read `window.lite.version` for the TOC header.
 *   - Loads `help.html` from `dist-lite/build/` via `loadFile()`.
 *
 * @internal -- consumers go through `getHelpApi()` / the menu callback.
 */

import { BrowserWindow, type Rectangle } from 'electron';

interface HelpWindowConfig {
  parent: BrowserWindow | null;
  htmlPath: string;
  preloadPath: string;
  /**
   * Optional anchor id to scroll to on open (e.g. 'two-factor',
   * 'auto-update'). Appended as `?section=<id>`; the renderer reads
   * `location.search` on bootstrap and scrolls. When the window is
   * already open, an `executeJavaScript` poke navigates without
   * a reload.
   */
  sectionId?: string;
}

let openWindow: BrowserWindow | null = null;

/**
 * Open (or focus) the Help window. Returns the BrowserWindow reference.
 * Idempotent: subsequent calls focus the existing window.
 */
export function openHelpWindow(config: HelpWindowConfig): BrowserWindow {
  if (openWindow !== null && !openWindow.isDestroyed()) {
    if (openWindow.isMinimized()) openWindow.restore();
    openWindow.focus();
    if (typeof config.sectionId === 'string' && config.sectionId.length > 0) {
      const safeId = JSON.stringify(config.sectionId);
      // Best-effort: ask the renderer to scroll to the section.
      // Ignored silently if the window hasn't finished loading or
      // the section id doesn't exist.
      openWindow.webContents
        .executeJavaScript(
          `(function(){try{var el=document.getElementById(${safeId});if(el)el.scrollIntoView({behavior:'smooth',block:'start'});}catch(e){}})()`
        )
        .catch(() => {
          /* best-effort */
        });
    }
    return openWindow;
  }

  const win = new BrowserWindow({
    width: 1000,
    height: 720,
    title: 'Onereach.ai Lite Help',
    backgroundColor: '#0e0e10',
    show: false,
    autoHideMenuBar: true,
    resizable: true,
    minimizable: true,
    maximizable: true,
    fullscreenable: true,
    minWidth: 480,
    minHeight: 480,
    ...(config.parent !== null ? { parent: config.parent } : {}),
    webPreferences: {
      preload: config.preloadPath,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });

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

/** Close the Help window if it is open. Idempotent. */
export function closeHelpWindow(): void {
  if (openWindow !== null && !openWindow.isDestroyed()) {
    openWindow.close();
  }
  openWindow = null;
}

/** @internal -- testing helper */
export function _isHelpWindowOpenForTesting(): boolean {
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
    /* best-effort centering */
  }
}
