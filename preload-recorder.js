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
  saveTranscriptToSpace: (data) => ipcRenderer.invoke('recorder:save-transcript-to-space', data),

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
  // LIVEKIT SESSION (WISER Meeting via SFU)
  // ==========================================

  // Host: create a LiveKit room, get tokens for host + guest
  createRoom: (roomName) => ipcRenderer.invoke('recorder:livekit-create-room', roomName),

  // Either side: end session and resize window
  endSession: () => ipcRenderer.invoke('recorder:session-end'),

  // Guest page management (publish static page to GSX Files — only needed once)
  getGuestPageUrl: () => ipcRenderer.invoke('recorder:get-guest-page-url'),
  publishGuestPage: () => ipcRenderer.invoke('recorder:publish-guest-page'),

  // Meeting token management via GSX KeyValue
  storeMeetingTokens: (data) => ipcRenderer.invoke('recorder:store-meeting-tokens', data),
  clearMeetingTokens: (roomName) => ipcRenderer.invoke('recorder:clear-meeting-tokens', roomName),

  // ==========================================
  // PHASE 2: GUEST TRACK TRANSFER
  // ==========================================

  // Save guest's transferred recording to space
  saveGuestTrack: (data) => ipcRenderer.invoke('recorder:save-guest-track', data),

  // ==========================================
  // PHASE 3: POST-PROCESSING (MERGE)
  // ==========================================

  // Merge two tracks with layout options
  mergeTracks: (data) => ipcRenderer.invoke('recorder:merge-tracks', data),

  // Get video recordings in a space (for merge picker)
  getSpaceRecordings: (spaceId) => ipcRenderer.invoke('recorder:get-space-recordings', spaceId),

  // Event: merge progress updates
  onMergeProgress: (callback) => {
    ipcRenderer.removeAllListeners('recorder:merge-progress');
    ipcRenderer.on('recorder:merge-progress', (event, progress) => callback(progress));
  },
});

// Expose electron shell for external links
contextBridge.exposeInMainWorld('electron', {
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),
});

// Clipboard via IPC (navigator.clipboard doesn't work in Electron renderers)
contextBridge.exposeInMainWorld('electronClipboard', {
  writeText: (text) => ipcRenderer.invoke('clipboard:write-text', text),
});

// ==========================================
// CENTRALIZED HUD API (meeting-agents space)
// ==========================================
try {
  const { getHudApiMethods } = require('./preload-hud-api');
  contextBridge.exposeInMainWorld('agentHUD', getHudApiMethods());
  console.log('[Recorder Preload] APIs exposed (including agentHUD)');
} catch (e) {
  console.warn('[Recorder Preload] HUD API not available:', e.message);
  // Expose stub with no-op methods so recorder.html doesn't crash
  contextBridge.exposeInMainWorld('agentHUD', {
    getAgentsInSpace: async () => [],
    onResult: () => {},
    submitTask: async () => {},
    addItem: async () => {},
    removeItem: async () => {},
    setAgentEnabled: async () => {},
  });
  console.log('[Recorder Preload] APIs exposed (agentHUD stubbed)');
}
