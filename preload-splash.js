/**
 * Preload script for Splash Screen
 * Minimal IPC bridge -- only needs to close the window
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('splash', {
  close: () => ipcRenderer.invoke('splash:close'),
});
