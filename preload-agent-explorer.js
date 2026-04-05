/**
 * Preload script for Agent Explorer window.
 * Uses canonical menu-data:* IPC for IDW CRUD (MenuDataManager).
 * Reuses existing agent and module-manager IPC channels.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('agentExplorer', {
  close: () => ipcRenderer.send('agent-explorer:close'),

  // Built-in agents from registry (single source of truth)
  getBuiltinAgents: () => ipcRenderer.invoke('agents:get-builtin-list'),
  getBuiltinAgentStates: () => ipcRenderer.invoke('agents:get-builtin-states'),
  setBuiltinAgentEnabled: (agentId, enabled) =>
    ipcRenderer.invoke('agents:set-builtin-enabled', agentId, enabled),

  // Custom / local agents
  getLocalAgents: () => ipcRenderer.invoke('agents:get-local'),

  // Statistics
  getAllStats: () => ipcRenderer.invoke('agents:get-all-stats'),
  getBidHistory: (limit) => ipcRenderer.invoke('agents:get-bid-history', limit),

  // Actions
  enhanceAgent: (agentId) => ipcRenderer.invoke('agents:enhance', agentId),
  openAgentManager: () => ipcRenderer.send('agents:open-manager'),

  // Web tools (module-manager)
  getWebTools: () => ipcRenderer.invoke('module:get-web-tools'),
  openWebTool: (toolId, opts) => ipcRenderer.invoke('module:open-web-tool', toolId, opts),
  deleteWebTool: (toolId) => ipcRenderer.invoke('module:delete-web-tool', toolId),

  // Thumbnails
  getToolThumbnail: (toolId, url) => ipcRenderer.invoke('agent-explorer:get-tool-thumbnail', toolId, url),
  refreshToolThumbnail: (toolId, url) => ipcRenderer.invoke('agent-explorer:refresh-tool-thumbnail', toolId, url),

  // IDW CRUD via MenuDataManager (canonical API)
  getIDWEnvironments: () => ipcRenderer.invoke('menu-data:get-idw-environments'),
  addIDWEnvironment: (env) => ipcRenderer.invoke('menu-data:add-idw-environment', env),
  updateIDWEnvironment: (id, updates) => ipcRenderer.invoke('menu-data:update-idw-environment', id, updates),
  removeIDWEnvironment: (id) => ipcRenderer.invoke('menu-data:remove-idw-environment', id),

  // IDW Store (OmniGraph catalog install)
  fetchIDWDirectory: () => ipcRenderer.invoke('idw-store:fetch-directory'),
  addIDWToMenu: (idw) => ipcRenderer.invoke('idw-store:add-to-menu', idw),
});

console.log('[PreloadAgentExplorer] Agent Explorer API exposed');
