/**
 * Meeting History page bridge. Read-only: fetch the merged meeting +
 * transcript timeline (lib/meetings/meeting-history.js via meetings:history).
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('meetingHistory', {
  get: (opts) => ipcRenderer.invoke('meetings:history', opts || {}),
});
