/**
 * Preload script for Command HUD
 * Exposes IPC methods for context menu, text input, and agent triggering
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hudAPI', {
  // ==================== EXISTING HUD METHODS ====================
  
  // Dismiss the HUD
  dismiss: () => ipcRenderer.send('hud:dismiss'),
  
  // Retry a task
  retry: (task) => ipcRenderer.send('hud:retry', task),
  
  // Get queue stats
  getQueueStats: (queueName) => ipcRenderer.invoke('voice-task-sdk:queue-stats', queueName),
  
  // Event listeners for HUD state
  onShow: (callback) => ipcRenderer.on('hud:show', () => callback()),
  onHide: (callback) => ipcRenderer.on('hud:hide', () => callback()),
  onTask: (callback) => ipcRenderer.on('hud:task', (_, task) => callback(task)),
  onResult: (callback) => ipcRenderer.on('hud:result', (_, result) => callback(result)),
  onReset: (callback) => ipcRenderer.on('hud:reset', () => callback()),
  onTaskLifecycle: (callback) => ipcRenderer.on('voice-task:lifecycle', (_, event) => callback(event)),
  
  // ==================== CONTEXT MENU ====================
  
  // Show context menu (triggered by right-click)
  showContextMenu: () => ipcRenderer.send('hud:show-context-menu'),
  
  // Listen for context menu actions
  onShowTextInput: (callback) => ipcRenderer.on('hud:action:text-input', () => callback()),
  onTriggerAgent: (callback) => ipcRenderer.on('hud:action:trigger-agent', (_, agent) => callback(agent)),
  
  // ==================== TEXT INPUT ====================
  
  // Submit a text command (instead of voice)
  submitTextCommand: (text) => ipcRenderer.invoke('voice-task-sdk:submit', text),
  
  // Trigger a specific agent with text
  triggerAgentWithTranscript: (agentId, transcript) => {
    return ipcRenderer.invoke('hud:trigger-agent', { agentId, transcript });
  },
  
  // ==================== AGENT MANAGEMENT ====================
  
  // Get list of available agents (local + GSX)
  getAgents: () => ipcRenderer.invoke('agents:list'),
  
  // Open agent manager window
  openAgentManager: () => ipcRenderer.send('agents:open-manager'),
  
  // Open settings window
  openSettings: () => ipcRenderer.send('open-settings'),
  
  // ==================== DISAMBIGUATION ====================
  
  // Select a disambiguation option by index
  selectDisambiguationOption: (stateId, optionIndex) => {
    return ipcRenderer.invoke('hud:disambiguation:select', { stateId, optionIndex });
  },
  
  // Resolve disambiguation with voice response
  resolveDisambiguationWithVoice: (stateId, voiceResponse) => {
    return ipcRenderer.invoke('hud:disambiguation:voice', { stateId, voiceResponse });
  },
  
  // Cancel disambiguation
  cancelDisambiguation: (stateId) => {
    return ipcRenderer.invoke('hud:disambiguation:cancel', { stateId });
  },
  
  // Listen for disambiguation state
  onDisambiguation: (callback) => {
    ipcRenderer.on('hud:disambiguation', (_, state) => callback(state));
  },
  
  // Listen for listening state during disambiguation
  onDisambiguationListening: (callback) => {
    ipcRenderer.on('hud:disambiguation:listening', (_, listening) => callback(listening));
  },
  
  // Listen for voice response during disambiguation
  onDisambiguationVoiceResponse: (callback) => {
    ipcRenderer.on('hud:disambiguation:voice-response', (_, response) => callback(response));
  },
});

console.log('[PreloadHUD] HUD API exposed with context menu and disambiguation support');
