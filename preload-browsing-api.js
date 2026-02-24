'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('browsingSession', {
  resume: (data) => ipcRenderer.invoke('browsing:resume-hitl', data),
  cancel: () => ipcRenderer.invoke('browsing:cancel-hitl'),
  getStatus: () => ipcRenderer.invoke('browsing:hitl-status'),

  onStatusUpdate: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('browsing:status-update', handler);
    return () => ipcRenderer.removeListener('browsing:status-update', handler);
  },
});
