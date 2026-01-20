// Minimal preload script for external content windows
// This script provides only the necessary APIs for external content
const { contextBridge, ipcRenderer } = require('electron');

// Expose a minimal API to the external content
contextBridge.exposeInMainWorld(
  'electronAPI', {
    // Method to close the window
    closeWindow: () => {
      ipcRenderer.send('close-content-window');
    },
    // Method to get window info
    getWindowInfo: () => {
      return {
        isElectron: true,
        platform: process.platform
      };
    },
    // Method to open Spaces picker for file uploads
    openSpacesPicker: () => {
      return ipcRenderer.invoke('open-spaces-picker');
    }
  }
);

// Listen for close events from the main process
ipcRenderer.on('close-window', () => {
  // Notify the page that it's about to be closed
  window.dispatchEvent(new Event('electron-window-closing'));
}); 