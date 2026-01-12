/**
 * Electron Mocks
 * Part of the Governed Self-Improving Agent Runtime Testing Infrastructure
 */

import { vi } from 'vitest';

export const app = {
  getPath: vi.fn((name) => `/mock/path/${name}`),
  getName: vi.fn(() => 'GSX Create'),
  getVersion: vi.fn(() => '1.0.0'),
  isReady: vi.fn(() => true),
  whenReady: vi.fn(() => Promise.resolve()),
  on: vi.fn(),
  quit: vi.fn()
};

export const ipcMain = {
  handle: vi.fn(),
  on: vi.fn(),
  once: vi.fn(),
  removeHandler: vi.fn(),
  removeListener: vi.fn()
};

export const ipcRenderer = {
  invoke: vi.fn(() => Promise.resolve({})),
  on: vi.fn(),
  once: vi.fn(),
  send: vi.fn(),
  removeListener: vi.fn()
};

export const BrowserWindow = vi.fn().mockImplementation(() => ({
  loadFile: vi.fn(() => Promise.resolve()),
  loadURL: vi.fn(() => Promise.resolve()),
  show: vi.fn(),
  hide: vi.fn(),
  close: vi.fn(),
  destroy: vi.fn(),
  isDestroyed: vi.fn(() => false),
  webContents: {
    send: vi.fn(),
    on: vi.fn(),
    executeJavaScript: vi.fn(() => Promise.resolve())
  },
  on: vi.fn(),
  once: vi.fn()
}));

export const dialog = {
  showOpenDialog: vi.fn(() => Promise.resolve({ canceled: false, filePaths: ['/mock/file.txt'] })),
  showSaveDialog: vi.fn(() => Promise.resolve({ canceled: false, filePath: '/mock/save.txt' })),
  showMessageBox: vi.fn(() => Promise.resolve({ response: 0 })),
  showErrorBox: vi.fn()
};

export const shell = {
  openExternal: vi.fn(() => Promise.resolve()),
  openPath: vi.fn(() => Promise.resolve('')),
  showItemInFolder: vi.fn()
};

export const clipboard = {
  readText: vi.fn(() => 'mock clipboard content'),
  writeText: vi.fn(),
  readImage: vi.fn(() => ({ isEmpty: () => true })),
  writeImage: vi.fn(),
  readHTML: vi.fn(() => ''),
  writeHTML: vi.fn()
};

export default {
  app,
  ipcMain,
  ipcRenderer,
  BrowserWindow,
  dialog,
  shell,
  clipboard
};

