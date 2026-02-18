/**
 * Preload Script for App Health Dashboard
 *
 * Exposes secure IPC methods to the dashboard renderer process.
 */

const { contextBridge, ipcRenderer, _shell } = require('electron');

// Expose dashboard API to renderer
contextBridge.exposeInMainWorld('dashboard', {
  // Get full dashboard data
  getData: () => ipcRenderer.invoke('dashboard:get-data'),

  // Individual data getters
  getAppStatus: () => ipcRenderer.invoke('dashboard:get-app-status'),
  getTodaySummary: () => ipcRenderer.invoke('dashboard:get-today-summary'),
  getSpacesHealth: () => ipcRenderer.invoke('dashboard:get-spaces-health'),
  getLLMUsage: () => ipcRenderer.invoke('dashboard:get-llm-usage'),
  getPipelineHealth: () => ipcRenderer.invoke('dashboard:get-pipeline-health'),
  getHealthScore: () => ipcRenderer.invoke('dashboard:get-health-score'),
  getActivity: (options) => ipcRenderer.invoke('dashboard:get-activity', options),
  getLogs: (options) => ipcRenderer.invoke('dashboard:get-logs', options),
  getAgentStatus: () => ipcRenderer.invoke('dashboard:get-agent-status'),

  // Agent controls
  agentPause: () => ipcRenderer.invoke('dashboard:agent-pause'),
  agentResume: () => ipcRenderer.invoke('dashboard:agent-resume'),
  agentRunNow: () => ipcRenderer.invoke('dashboard:agent-run-now'),

  // External API configuration
  configureExternalAPI: (config) => ipcRenderer.invoke('dashboard:agent-configure-external-api', config),
  getExternalAPIConfig: () => ipcRenderer.invoke('dashboard:agent-get-external-api-config'),
  reportStatusNow: () => ipcRenderer.invoke('dashboard:agent-report-status-now'),

  // Broken Items Registry
  getBrokenItems: (options) => ipcRenderer.invoke('dashboard:get-broken-items', options),
  getArchivedBrokenItems: () => ipcRenderer.invoke('dashboard:get-archived-broken-items'),
  updateBrokenItemStatus: (itemId, status, details) =>
    ipcRenderer.invoke('dashboard:update-broken-item-status', itemId, status, details),
  clearBrokenItems: (archive) => ipcRenderer.invoke('dashboard:clear-broken-items', archive),

  // Issue management
  resolveIssue: (issueId) => ipcRenderer.invoke('dashboard:resolve-issue', issueId),
  ignoreIssue: (issueId) => ipcRenderer.invoke('dashboard:ignore-issue', issueId),

  // Pipeline controls
  runIntegrityCheck: () => ipcRenderer.invoke('dashboard:run-integrity-check'),

  // Export
  exportData: (format) => ipcRenderer.invoke('dashboard:export-data', format),

  // Utilities
  openLogFolder: () => {
    return ipcRenderer.invoke('dashboard:open-log-folder');
  },
});

// Also expose app info
contextBridge.exposeInMainWorld('appInfo', {
  getVersion: () => ipcRenderer.invoke('app:get-version'),
});

console.log('[Dashboard Preload] API exposed to renderer');
