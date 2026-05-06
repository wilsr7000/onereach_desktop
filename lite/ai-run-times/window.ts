/**
 * AI Run Times reader window factory.
 *
 * Single-instance BrowserWindow loading `ai-run-times.html` with
 * the lite preload so the renderer can call
 * `window.lite.aiRunTimes.*`.
 *
 * Larger default size than the IDW catalog (1400x900) since it
 * carries a tile grid + article overlay reader.
 *
 * @internal
 */

import { BrowserWindow, type Rectangle } from 'electron';

interface AiRunTimesWindowConfig {
  parent: BrowserWindow | null;
  htmlPath: string;
  preloadPath: string;
}

let openWindow: BrowserWindow | null = null;

export function openAiRunTimesWindow(config: AiRunTimesWindowConfig): BrowserWindow {
  if (openWindow !== null && !openWindow.isDestroyed()) {
    if (openWindow.isMinimized()) openWindow.restore();
    openWindow.focus();
    // Force a fresh load on re-open. file:// loads don't cache the
    // way HTTP does, but reloadIgnoringCache() is the belt-and-
    // suspenders move that guarantees the latest bundled JS is
    // executed -- helpful during dev iteration and harmless in prod.
    try {
      openWindow.webContents.reloadIgnoringCache();
    } catch {
      /* best-effort */
    }
    return openWindow;
  }

  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    title: 'AI Run Times',
    backgroundColor: '#0e0e10',
    show: false,
    autoHideMenuBar: true,
    minWidth: 960,
    minHeight: 600,
    ...(config.parent !== null ? { parent: config.parent } : {}),
    webPreferences: {
      preload: config.preloadPath,
      contextIsolation: true,
      // Sandboxed: the renderer doesn't need fetch (all HTTP goes
      // through main-process IPC) or the Audio API (TTS pulled).
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

export function closeAiRunTimesWindow(): void {
  if (openWindow !== null && !openWindow.isDestroyed()) {
    openWindow.close();
  }
  openWindow = null;
}

/** @internal -- testing helper */
export function _isAiRunTimesWindowOpenForTesting(): boolean {
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
    // best-effort
  }
}
