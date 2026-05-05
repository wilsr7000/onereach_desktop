/**
 * API Reference window factory.
 *
 * Per ADR-035, a single-instance BrowserWindow modeled on
 * `lite/settings/window.ts` and `lite/bug-report/main.ts`'s modal
 * pattern. Larger than Settings (developer audience expects more
 * horizontal real estate to read code blocks).
 *
 * @internal -- consumers go through `getApiDocsApi()`.
 */

import { BrowserWindow, type Rectangle } from 'electron';

interface ApiDocsWindowConfig {
  parent: BrowserWindow | null;
  htmlPath: string;
  preloadPath: string;
}

let openWindow: BrowserWindow | null = null;

/**
 * Open (or focus) the API Reference window. Returns the BrowserWindow
 * reference. Idempotent: subsequent calls focus the existing window.
 */
export function openApiDocsWindow(config: ApiDocsWindowConfig): BrowserWindow {
  if (openWindow !== null && !openWindow.isDestroyed()) {
    if (openWindow.isMinimized()) openWindow.restore();
    openWindow.focus();
    return openWindow;
  }

  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    title: 'API Reference',
    backgroundColor: '#0e0e10',
    show: false,
    autoHideMenuBar: true,
    resizable: true,
    minimizable: true,
    maximizable: true,
    fullscreenable: true,
    minWidth: 900,
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

/** Close the API Reference window if it is open. Idempotent. */
export function closeApiDocsWindow(): void {
  if (openWindow !== null && !openWindow.isDestroyed()) {
    openWindow.close();
  }
  openWindow = null;
}

/** @internal -- testing helper */
export function _isApiDocsWindowOpenForTesting(): boolean {
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
