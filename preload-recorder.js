/**
 * Preload script for Standalone Recorder
 * Exposes safe IPC methods to the renderer process for video recording
 */

const { contextBridge, ipcRenderer, desktopCapturer } = require('electron');

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
  getScreenSources: async () => {
    try {
      const sources = await desktopCapturer.getSources({ 
        types: ['screen', 'window'],
        thumbnailSize: { width: 150, height: 150 }
      });
      return sources.map(source => ({
        id: source.id,
        name: source.name,
        thumbnail: source.thumbnail.toDataURL()
      }));
    } catch (error) {
      console.error('[Recorder Preload] Error getting screen sources:', error);
      return [];
    }
  },
  
  // Events from main process
  onInstructionsReceived: (callback) => {
    ipcRenderer.on('recorder:instructions', (event, instructions) => callback(instructions));
  }
});

// Expose electron shell for external links
contextBridge.exposeInMainWorld('electron', {
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url)
});

console.log('[Recorder Preload] APIs exposed');



































