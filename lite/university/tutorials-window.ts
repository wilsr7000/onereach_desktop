/**
 * Agentic University tutorials catalog window factory.
 *
 * Single-instance BrowserWindow loading `university-tutorials.html`
 * with the lite preload so the renderer can call
 * `window.lite.university.list()` (curated catalog) and
 * `window.lite.university.openCourse(id)` (route to Learning Browser).
 *
 * Modeled on `lite/idw/catalog-window.ts` and `lite/api-docs/window.ts`.
 *
 * @internal -- consumers go through the IDW main module's IPC,
 * the menu's "View All Tutorials" item, or
 * `window.lite.university.openTutorials()`.
 */

import { BrowserWindow, type Rectangle } from 'electron';

interface TutorialsWindowConfig {
  parent: BrowserWindow | null;
  htmlPath: string;
  preloadPath: string;
}

let openWindow: BrowserWindow | null = null;

/**
 * Open (or focus) the tutorials catalog window. Idempotent --
 * subsequent calls focus the existing window instead of opening a
 * second.
 */
export function openTutorialsWindow(config: TutorialsWindowConfig): BrowserWindow {
  if (openWindow !== null && !openWindow.isDestroyed()) {
    if (openWindow.isMinimized()) openWindow.restore();
    openWindow.focus();
    return openWindow;
  }

  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    title: 'Agentic University -- Quick Starts',
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

/** Close the tutorials catalog window if open. Idempotent. */
export function closeTutorialsWindow(): void {
  if (openWindow !== null && !openWindow.isDestroyed()) {
    openWindow.close();
  }
  openWindow = null;
}

/** @internal -- testing helper */
export function _isTutorialsWindowOpenForTesting(): boolean {
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
