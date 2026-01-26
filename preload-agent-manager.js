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
  
  // Get enabled states for all builtin agents
  getBuiltinAgentStates: () => ipcRenderer.invoke('agents:get-builtin-states'),
  
  // Set enabled state for a builtin agent
  setBuiltinAgentEnabled: (agentId, enabled) => ipcRenderer.invoke('agents:set-builtin-enabled', agentId, enabled),
});

console.log('[PreloadAgentManager] Agent Manager API exposed');
