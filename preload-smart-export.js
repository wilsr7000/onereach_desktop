/**
 * Preload script for Smart Export Format Modal
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Get space data for export
  getSpaceForExport: () => {
    return new Promise((resolve) => {
      // Wait for space data to be sent from main process
      ipcRenderer.once('space-data', (event, data) => {
        resolve(data);
      });
      // Also try to get it if already available
      setTimeout(() => resolve(null), 100);
    });
  },
  
  // Generate export in specified format
  generateExport: (params) => ipcRenderer.invoke('smart-export:generate', params),
  
  // Get available export formats
  getFormats: () => ipcRenderer.invoke('smart-export:get-formats'),
  
  // Close the modal
  closeModal: () => {
    console.log('[Smart Export Preload] closeModal called');
    // Use IPC to close - most reliable method
    ipcRenderer.send('smart-export:close-modal');
    // Also try window.close as fallback
    setTimeout(() => {
      try {
        window.close();
      } catch (e) {
        console.log('[Smart Export Preload] window.close failed:', e);
      }
    }, 100);
  },
  
  // Show success notification
  showExportSuccess: (result) => {
    ipcRenderer.send('show-notification', {
      title: 'Export Complete',
      body: `Document saved to ${result.path}`
    });
  },
  
  // Listen for space data
  onSpaceData: (callback) => {
    ipcRenderer.on('space-data', (event, data) => callback(data));
  }
});

// Also expose on window for direct access
window.addEventListener('DOMContentLoaded', () => {
  // Set up close button handler
  window.closeModal = () => {
    window.close();
  };
});




