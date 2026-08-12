/**
 * ADR-064 — Live Activity page bridge. Read-only surface: list the
 * account's presence beacons + the recent Commit rail, and fetch one
 * beacon's temporal trail from the KV log the graph points to.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('liveActivity', {
  list: () => ipcRenderer.invoke('activity:list'),
  trail: (personId, appId) => ipcRenderer.invoke('activity:trail', { personId, appId }),
});
