/**
 * Preload script for Command Palette
 * Exposes a thin IPC bridge at window.palette
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('palette', {
  getItems: () => ipcRenderer.invoke('palette:get-items'),

  execute: (item) => ipcRenderer.invoke('palette:execute', item),

  submitToAgent: (agentId, text) => ipcRenderer.invoke('palette:submit-to-agent', agentId, text),

  dismiss: () => ipcRenderer.invoke('palette:dismiss'),

  onShow: (callback) => ipcRenderer.on('palette:show', () => callback()),

  onHide: (callback) => ipcRenderer.on('palette:hide', () => callback()),
});
