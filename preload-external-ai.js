// Preload script for external AI windows (ChatGPT, Claude, etc.)
// This script provides clipboard functionality and other necessary APIs
const { contextBridge, ipcRenderer } = require('electron');

// Expose a comprehensive API for external AI windows
contextBridge.exposeInMainWorld('electronAPI', {
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
  }
});

// Expose clipboard API for external AI windows
contextBridge.exposeInMainWorld('clipboard', {
  // Basic clipboard operations
  getHistory: () => ipcRenderer.invoke('clipboard:get-history'),
  addItem: (item) => ipcRenderer.invoke('clipboard:add-item', item),
  pasteItem: (id) => ipcRenderer.invoke('clipboard:paste-item', id),
  
  // Spaces functionality
  getSpaces: () => ipcRenderer.invoke('clipboard:get-spaces'),
  getSpacesEnabled: () => ipcRenderer.invoke('clipboard:get-spaces-enabled'),
  getCurrentSpace: () => ipcRenderer.invoke('clipboard:get-active-space'),
  
  // Text/content capture
  captureText: (text) => ipcRenderer.invoke('clipboard:capture-text', text),
  captureHTML: (html) => ipcRenderer.invoke('clipboard:capture-html', html),
  
  // Event listeners
  onHistoryUpdate: (callback) => {
    ipcRenderer.on('clipboard:history-updated', (event, history) => {
      callback(history);
    });
  }
});

// Also expose the standard API that the main app uses
contextBridge.exposeInMainWorld('api', {
  send: (channel, data) => {
    const validChannels = [
      'app-message',
      'show-notification',
      'open-clipboard-viewer',
      'open-black-hole-widget'
    ];
    if (validChannels.includes(channel)) {
      ipcRenderer.send(channel, data);
    }
  },
  
  // Show notifications
  showNotification: (options) => {
    ipcRenderer.send('show-notification', options);
  }
});

// Enhanced clipboard capture for AI chat interfaces
window.addEventListener('DOMContentLoaded', () => {
  console.log('[External AI Preload] Setting up clipboard capture enhancement');
  
  // Override the native copy event to capture content
  document.addEventListener('copy', async (event) => {
    console.log('[External AI] Copy event detected');
    
    const selection = window.getSelection();
    if (selection && selection.toString()) {
      const text = selection.toString();
      const html = getSelectionHTML();
      
      console.log('[External AI] Capturing copied content:', text.substring(0, 100) + '...');
      
      // Send to clipboard manager
      try {
        await window.clipboard.captureText(text);
        if (html && html !== text) {
          await window.clipboard.captureHTML(html);
        }
      } catch (error) {
        console.error('[External AI] Error capturing to clipboard:', error);
      }
    }
  });
  
  // Helper function to get HTML from selection
  function getSelectionHTML() {
    const selection = window.getSelection();
    if (selection.rangeCount > 0) {
      const container = document.createElement('div');
      for (let i = 0; i < selection.rangeCount; i++) {
        container.appendChild(selection.getRangeAt(i).cloneContents());
      }
      return container.innerHTML;
    }
    return '';
  }
  
  // Also monitor keyboard shortcuts
  document.addEventListener('keydown', async (event) => {
    // Detect Cmd+C or Ctrl+C
    if ((event.metaKey || event.ctrlKey) && event.key === 'c') {
      console.log('[External AI] Copy shortcut detected');
      // The copy event handler above will capture the content
    }
  });
});

// Listen for close events from the main process
ipcRenderer.on('close-window', () => {
  window.dispatchEvent(new Event('electron-window-closing'));
}); 