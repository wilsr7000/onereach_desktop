/** Calendar window (ADR-090). Same shape as the Agent Library window. */
import { BrowserWindow, type Rectangle } from 'electron';
import { windowBackgroundColor } from '../theme/main.js';

export interface CalendarWindowConfig {
  parent: BrowserWindow | null;
  htmlPath: string;
  preloadPath: string;
}

let openWindow: BrowserWindow | null = null;

export function openCalendarWindow(config: CalendarWindowConfig): BrowserWindow {
  if (openWindow !== null && !openWindow.isDestroyed()) {
    if (openWindow.isMinimized()) openWindow.restore();
    openWindow.focus();
    return openWindow;
  }
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: 'Calendar',
    backgroundColor: windowBackgroundColor(),
    show: false,
    autoHideMenuBar: true,
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

export function closeCalendarWindow(): void {
  if (openWindow !== null && !openWindow.isDestroyed()) openWindow.close();
  openWindow = null;
}

function centerOnParent(win: BrowserWindow, parent: BrowserWindow | null): void {
  if (parent === null || parent.isDestroyed()) return;
  const p: Rectangle = parent.getBounds();
  const b = win.getBounds();
  win.setPosition(Math.round(p.x + (p.width - b.width) / 2), Math.round(p.y + (p.height - b.height) / 2));
}
