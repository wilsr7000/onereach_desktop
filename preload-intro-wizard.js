/**
 * Preload script for Mode Card welcome experience
 * Provides IPC bridge for card rotation and dismissal
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('modeCard', {
  getCardIndex: () => ipcRenderer.invoke('mode-card:get-index'),
  dismiss: () => ipcRenderer.invoke('mode-card:dismiss'),
});
