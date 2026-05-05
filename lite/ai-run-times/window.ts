/**
 * AI Run Times reader window factory.
 *
 * Single-instance BrowserWindow loading `ai-run-times.html` with
 * the lite preload so the renderer can call
 * `window.lite.aiRunTimes.*` and `window.lite.ai.tts(...)`.
 *
 * Larger default size than the IDW catalog (1400x900) since it
 * carries a tile grid + article overlay + playlist bar.
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
      sandbox: false, // need fetch + Audio API in renderer
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
