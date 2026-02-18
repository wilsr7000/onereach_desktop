/**
 * Shared Playbook + Sync preload module
 * Provides: playbook, sync
 *
 * Used by: preload.js, preload-spaces.js, preload-minimal.js
 * Pattern: Same as preload-hud-api.js and preload-orb-control.js
 */

const { ipcRenderer } = require('electron');

/**
 * Returns the playbook executor API methods
 * @param {string} [label='preload'] - Label for log messages
 */
function getPlaybookMethods(label = 'preload') {
  return {
    execute: (opts) => ipcRenderer.invoke('playbook:execute', opts),
    getStatus: (jobId) => ipcRenderer.invoke('playbook:status', jobId),
    respond: (jobId, questionId, answer) => ipcRenderer.invoke('playbook:respond', jobId, questionId, answer),
    cancel: (jobId) => ipcRenderer.invoke('playbook:cancel', jobId),
    findPlaybooks: (spaceId) => ipcRenderer.invoke('playbook:find', spaceId),
    listJobs: (filters) => ipcRenderer.invoke('playbook:jobs', filters),
    onProgress: (callback) => {
      const handler = (_event, data) => {
        try {
          callback(data);
        } catch (err) {
          console.warn(`[${label}] playbook:progress callback:`, err.message);
        }
      };
      ipcRenderer.on('playbook:progress', handler);
      return () => ipcRenderer.removeListener('playbook:progress', handler);
    },
  };
}

/**
 * Returns the sync layer API methods
 */
function getSyncMethods() {
  return {
    push: (spaceId, opts) => ipcRenderer.invoke('sync:push', spaceId, opts),
    pull: (spaceId) => ipcRenderer.invoke('sync:pull', spaceId),
    status: (spaceId) => ipcRenderer.invoke('sync:status', spaceId),
  };
}

module.exports = {
  getPlaybookMethods,
  getSyncMethods,
};
