/**
 * Preload script for Agent Manager window
 * Exposes IPC methods for managing local agents and GSX connections
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('agentManagerAPI', {
  // Window control
  close: () => ipcRenderer.send('agent-manager:close'),
  
  // ==================== LOCAL AGENTS ====================
  
  // Get all local agents
  getAgents: () => ipcRenderer.invoke('agents:get-local'),
  
  // Create a new agent
  createAgent: (agentData) => ipcRenderer.invoke('agents:create', agentData),
  
  // Update an agent
  updateAgent: (id, updates) => ipcRenderer.invoke('agents:update', id, updates),
  
  // Delete an agent
  deleteAgent: (id) => ipcRenderer.invoke('agents:delete', id),
  
  // ==================== GSX CONNECTIONS ====================
  
  // Get all GSX connections
  getGSXConnections: () => ipcRenderer.invoke('gsx:get-connections'),
  
  // Add a new GSX connection
  addGSXConnection: (connData) => ipcRenderer.invoke('gsx:add-connection', connData),
  
  // Update a GSX connection
  updateGSXConnection: (id, updates) => ipcRenderer.invoke('gsx:update-connection', id, updates),
  
  // Delete a GSX connection
  deleteGSXConnection: (id) => ipcRenderer.invoke('gsx:delete-connection', id),
  
  // Test GSX connection
  testGSXConnection: (id) => ipcRenderer.invoke('gsx:test-connection', id),
  
  // Refresh agents from GSX server
  refreshGSXAgents: (id) => ipcRenderer.invoke('gsx:refresh-agents', id),
  
  // ==================== BUILTIN AGENTS ====================
  
  // Get all builtin agents from registry (single source of truth)
  getBuiltinAgents: () => ipcRenderer.invoke('agents:get-builtin-list'),
  
  // Get enabled states for all builtin agents
  getBuiltinAgentStates: () => ipcRenderer.invoke('agents:get-builtin-states'),
  
  // Set enabled state for a builtin agent
  setBuiltinAgentEnabled: (agentId, enabled) => ipcRenderer.invoke('agents:set-builtin-enabled', agentId, enabled),
  
  // ==================== TESTING ====================
  
  // Test a single agent with a phrase
  testPhrase: (agentId, phrase) => ipcRenderer.invoke('agents:test-phrase', agentId, phrase),
  
  // Test all enabled agents with a phrase
  testPhraseAllAgents: (phrase) => ipcRenderer.invoke('agents:test-phrase-all', phrase),
  
  // Execute an agent directly (bypasses Exchange for testing)
  executeAgent: (agentId, phrase) => ipcRenderer.invoke('agents:execute-direct', agentId, phrase),
  
  // Get API key for auto-test phrase generation
  getApiKey: () => ipcRenderer.invoke('agents:get-api-key'),
  
  // ==================== VERSION HISTORY ====================
  
  // Get version history for an agent
  getVersionHistory: (agentId) => ipcRenderer.invoke('agents:get-version-history', agentId),
  
  // Get a specific version
  getVersion: (agentId, versionNumber) => ipcRenderer.invoke('agents:get-version', agentId, versionNumber),
  
  // Revert to a specific version
  revertToVersion: (agentId, versionNumber) => ipcRenderer.invoke('agents:revert-to-version', agentId, versionNumber),
  
  // ==================== ENHANCE AGENT ====================
  
  // Open Agent Composer in enhance mode
  enhanceAgent: (agentId) => ipcRenderer.invoke('agents:enhance', agentId),
  
  // ==================== STATISTICS ====================
  
  // Get stats for a single agent
  getStats: (agentId) => ipcRenderer.invoke('agents:get-stats', agentId),
  
  // Get stats for all agents
  getAllStats: () => ipcRenderer.invoke('agents:get-all-stats'),
  
  // Get recent bid history
  getBidHistory: (limit) => ipcRenderer.invoke('agents:get-bid-history', limit),
  
  // Get bid history for a specific agent
  getAgentBidHistory: (agentId, limit) => ipcRenderer.invoke('agents:get-agent-bid-history', agentId, limit),
});

console.log('[PreloadAgentManager] Agent Manager API exposed');
