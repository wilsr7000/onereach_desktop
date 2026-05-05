/**
 * IDW Store catalog window factory.
 *
 * Single-instance BrowserWindow loading `idw-store.html` with the
 * lite preload so the renderer can call `window.lite.idw.add(...)`
 * + `window.lite.neon.query(...)` to fetch the OAGI catalog.
 *
 * Modeled on `lite/api-docs/window.ts` and `lite/settings/window.ts`.
 *
 * @internal -- consumers go through the IDW main module's
 * `lite:idw:open-store` IPC or the Settings -> IDWs section's
 * "Open Store" button.
 */

import { BrowserWindow, type Rectangle } from 'electron';

interface CatalogWindowConfig {
  parent: BrowserWindow | null;
  htmlPath: string;
  preloadPath: string;
}

let openWindow: BrowserWindow | null = null;

/**
 * Open (or focus) the IDW Store catalog window. Idempotent --
 * subsequent calls focus the existing window instead of opening a
 * second.
 */
export function openCatalogWindow(config: CatalogWindowConfig): BrowserWindow {
  if (openWindow !== null && !openWindow.isDestroyed()) {
    if (openWindow.isMinimized()) openWindow.restore();
    openWindow.focus();
    return openWindow;
  }

  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    title: 'OAGI Store',
    backgroundColor: '#0e0e10',
    show: false,
    autoHideMenuBar: true,
    resizable: true,
    minimizable: true,
    maximizable: true,
    fullscreenable: true,
    minWidth: 960,
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

/** Close the catalog window if open. Idempotent. */
export function closeCatalogWindow(): void {
  if (openWindow !== null && !openWindow.isDestroyed()) {
    openWindow.close();
  }
  openWindow = null;
}

/** @internal -- testing helper */
export function _isCatalogWindowOpenForTesting(): boolean {
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
