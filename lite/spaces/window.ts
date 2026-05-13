/**
 * Spaces window factory.
 *
 * Per ADR-031 + the Settings precedent (`lite/settings/window.ts`),
 * single-instance BrowserWindow:
 *   - parent: mainWindow (glued to the placeholder, not modal)
 *   - Uses the kernel's single preload (`preload-lite.js`) so renderer
 *     code can call `window.lite.spaces.*`
 *   - Loads `spaces.html` from `dist-lite/build/`
 *
 * Position + size are remembered via `lite/kv/` (collection
 * `lite-window-state`, key `spaces`). On first open, defaults to
 * 1240 x 820 -- big enough for the three-pane layout (sidebar + main
 * + detail) at MVP densities.
 *
 * @internal -- consumers go through `getSpacesApi()`.
 */

import { BrowserWindow, type Rectangle } from 'electron';

interface SpacesWindowConfig {
  parent: BrowserWindow | null;
  htmlPath: string;
  preloadPath: string;
}

let openWindow: BrowserWindow | null = null;

/**
 * Open (or focus) the Spaces window. Returns the BrowserWindow
 * reference. Idempotent: subsequent calls focus the existing window.
 */
export function openSpacesWindow(config: SpacesWindowConfig): BrowserWindow {
  if (openWindow !== null && !openWindow.isDestroyed()) {
    if (openWindow.isMinimized()) openWindow.restore();
    openWindow.focus();
    return openWindow;
  }

  const win = new BrowserWindow({
    width: 1240,
    height: 820,
    title: 'Spaces',
    backgroundColor: '#0e0e10',
    show: false,
    autoHideMenuBar: true,
    resizable: true,
    minimizable: true,
    maximizable: true,
    fullscreenable: true,
    minWidth: 920,
    minHeight: 600,
    ...(config.parent !== null ? { parent: config.parent } : {}),
    webPreferences: {
      preload: config.preloadPath,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });

  void win.loadFile(config.htmlPath);

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

/** Close the Spaces window if it is open. Idempotent. */
export function closeSpacesWindow(): void {
  if (openWindow !== null && !openWindow.isDestroyed()) {
    openWindow.close();
  }
  openWindow = null;
}

/** @internal -- testing helper */
export function _isSpacesWindowOpenForTesting(): boolean {
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
