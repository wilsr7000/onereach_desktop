/**
 * Preload script for Standalone Recorder
 * Exposes safe IPC methods to the renderer process for video recording
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('recorder', {
  // Get recording instructions from editor (if launched with params)
  getInstructions: () => ipcRenderer.invoke('recorder:get-instructions'),
  
  // Get available media devices
  getDevices: () => ipcRenderer.invoke('recorder:get-devices'),
  
  // Request media permissions
  requestPermissions: (type) => ipcRenderer.invoke('recorder:request-permissions', type),
  
  // Save recording to space
  saveToSpace: (data) => ipcRenderer.invoke('recorder:save-to-space', data),
  
  // Get available spaces
  getSpaces: () => ipcRenderer.invoke('clipboard:get-spaces'),
  
  // Get project folder for a space
  getProjectFolder: (spaceId) => ipcRenderer.invoke('recorder:get-project-folder', spaceId),
  
  // Close recorder window
  close: () => ipcRenderer.invoke('recorder:close'),
  
  // Minimize window
  minimize: () => ipcRenderer.invoke('recorder:minimize'),
  
  // Get available screen sources for screen capture
  // (desktopCapturer is main-process only in Electron 25+, so we use IPC)
  getScreenSources: () => ipcRenderer.invoke('recorder:get-screen-sources'),
  
  // System audio loopback (macOS 12.3+, Windows, Linux — no drivers needed)
  enableLoopbackAudio: () => ipcRenderer.invoke('enable-loopback-audio'),
  disableLoopbackAudio: () => ipcRenderer.invoke('disable-loopback-audio'),

  // Live transcription support
  getOpenAIKey: () => ipcRenderer.invoke('recorder:get-openai-key'),
  transcribeItem: (itemId) => ipcRenderer.invoke('recorder:transcribe-item', itemId),
  writeLiveTranscript: (data) => ipcRenderer.invoke('recorder:write-live-transcript', data),

  // Start/stop the meeting monitor agent
  startMonitor: (spaceId) => ipcRenderer.invoke('recorder:start-monitor', spaceId),
  stopMonitor: () => ipcRenderer.invoke('recorder:stop-monitor'),

  // System diagnostics (CPU, memory, battery)
  getSystemDiagnostics: () => ipcRenderer.invoke('recorder:get-diagnostics'),

  // Events from main process
  onInstructionsReceived: (callback) => {
    ipcRenderer.on('recorder:instructions', (event, instructions) => callback(instructions));
  },

  // Meeting monitor alerts
  onMonitorAlert: (callback) => {
    ipcRenderer.on('recorder:monitor-alert', (event, alert) => callback(alert));
  },

  // ==========================================
  // P2P SESSION (Riverside-style dual recording)
  // ==========================================

  // Host: create a session, post SDP offer, get back code + host address
  createSession: (sdpOffer) => ipcRenderer.invoke('recorder:session-create', sdpOffer),

  // Host: start polling for the guest's SDP answer
  startPollingForAnswer: (code) => ipcRenderer.invoke('recorder:session-poll-start', code),

  // Host: stop polling
  stopPolling: () => ipcRenderer.invoke('recorder:session-poll-stop'),

  // Guest: find a session by code word on the host's address
  findSession: (code, hostAddress) => ipcRenderer.invoke('recorder:session-find', code, hostAddress),

  // Guest: post SDP answer for a session on the host's address
  postAnswer: (code, sdpAnswer, hostAddress) => ipcRenderer.invoke('recorder:session-answer', code, sdpAnswer, hostAddress),

  // Clean up signaling server and session data (no window resize, session stays live)
  cleanupSignaling: () => ipcRenderer.invoke('recorder:session-cleanup-signaling'),

  // Either side: fully end session, clean up, and resize window
  endSession: () => ipcRenderer.invoke('recorder:session-end'),

  // Event: session answer received (host gets this when guest's answer arrives)
  // Uses removeAllListeners to prevent duplicate listener registration on re-host
  onSessionAnswer: (callback) => {
    ipcRenderer.removeAllListeners('recorder:session-answer-received');
    ipcRenderer.on('recorder:session-answer-received', (event, answer) => callback(answer));
  },

  // Event: session timed out waiting for guest
  onSessionTimeout: (callback) => {
    ipcRenderer.removeAllListeners('recorder:session-timeout');
    ipcRenderer.on('recorder:session-timeout', () => callback());
  },

  // Event: session error
  onSessionError: (callback) => {
    ipcRenderer.removeAllListeners('recorder:session-error');
    ipcRenderer.on('recorder:session-error', (event, error) => callback(error));
  }
});

// Expose electron shell for external links
contextBridge.exposeInMainWorld('electron', {
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url)
});

// ==========================================
// CENTRALIZED HUD API (meeting-agents space)
// ==========================================
const { getHudApiMethods } = require('./preload-hud-api');
contextBridge.exposeInMainWorld('agentHUD', getHudApiMethods());

console.log('[Recorder Preload] APIs exposed (including agentHUD)');



































