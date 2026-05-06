/**
 * Tools manager window factory.
 *
 * Single-instance BrowserWindow loading `tools-manager.html` with the
 * lite preload so the renderer can call `window.lite.tools.*`.
 *
 * Modeled on `lite/idw/catalog-window.ts`.
 *
 * @internal -- consumers go through the Tools main module's
 * `lite:tools:open-manager` IPC or the menu's "Manage Tools..." item.
 */

import { BrowserWindow, type Rectangle } from 'electron';

interface ManagerWindowConfig {
  parent: BrowserWindow | null;
  htmlPath: string;
  preloadPath: string;
}

let openWindow: BrowserWindow | null = null;

/**
 * Open (or focus) the Tools manager window. Idempotent --
 * subsequent calls focus the existing window instead of opening a
 * second.
 */
export function openManagerWindow(config: ManagerWindowConfig): BrowserWindow {
  if (openWindow !== null && !openWindow.isDestroyed()) {
    if (openWindow.isMinimized()) openWindow.restore();
    openWindow.focus();
    return openWindow;
  }

  const win = new BrowserWindow({
    width: 880,
    height: 620,
    title: 'Manage Tools',
    backgroundColor: '#0e0e10',
    show: false,
    autoHideMenuBar: true,
    resizable: true,
    minimizable: true,
    maximizable: true,
    fullscreenable: true,
    minWidth: 720,
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

/** Close the manager window if open. Idempotent. */
export function closeManagerWindow(): void {
  if (openWindow !== null && !openWindow.isDestroyed()) {
    openWindow.close();
  }
  openWindow = null;
}

/** @internal -- testing helper. */
export function _isManagerWindowOpenForTesting(): boolean {
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
