// Minimal preload script for external content windows
// This script provides only the necessary APIs for external content
const { contextBridge, ipcRenderer } = require('electron');

// ========================================
// SSO: localStorage injection DISABLED
// The 'or' cookie/localStorage data is account-specific and doesn't help with SSO.
// The 'mult' cookie (injected via main process) is sufficient to enable SSO -
// it proves the user is authenticated to OneReach, so they only need to
// confirm/select their account instead of re-entering credentials.
// ========================================

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

// Expose drag and drop API for outbound drags (webview content to desktop)
contextBridge.exposeInMainWorld(
  'electronDrag', {
    // Start a native file drag from the webview to external apps/desktop
    startDrag: (filePath, iconPath) => {
      ipcRenderer.send('webview-start-native-drag', { filePath, iconPath });
    },
    // Check if we're in an Electron webview with drag support
    isSupported: () => true
  }
);

// Listen for close events from the main process
ipcRenderer.on('close-window', () => {
  // Notify the page that it's about to be closed
  window.dispatchEvent(new Event('electron-window-closing'));
});

// ========================================
// Drag and Drop Event Forwarding Support
// ========================================

// Listen for file drop messages from the parent window (via executeJavaScript)
// and create synthetic events that web apps can use
window.addEventListener('message', (event) => {
  // Only handle messages from the same origin (parent window injection)
  if (event.source !== window) return;
  
  if (event.data && event.data.type === 'electron-file-drop') {
    console.log('[Electron Preload] Received file drop message:', event.data.files?.length, 'files');
    
    // Create and dispatch a custom event with file data
    const dropEvent = new CustomEvent('electron-file-drop', {
      detail: {
        files: event.data.files,
        clientX: event.data.clientX,
        clientY: event.data.clientY
      },
      bubbles: true,
      cancelable: true
    });
    
    // Find the element at the drop coordinates and dispatch
    const targetElement = document.elementFromPoint(event.data.clientX, event.data.clientY);
    if (targetElement) {
      targetElement.dispatchEvent(dropEvent);
    } else {
      document.body.dispatchEvent(dropEvent);
    }
  }
  
  if (event.data && event.data.type === 'electron-url-drop') {
    console.log('[Electron Preload] Received URL drop message:', event.data.url);
    
    // Create and dispatch a custom event with URL data
    const dropEvent = new CustomEvent('electron-url-drop', {
      detail: {
        url: event.data.url,
        clientX: event.data.clientX,
        clientY: event.data.clientY
      },
      bubbles: true,
      cancelable: true
    });
    
    const targetElement = document.elementFromPoint(event.data.clientX, event.data.clientY);
    if (targetElement) {
      targetElement.dispatchEvent(dropEvent);
    } else {
      document.body.dispatchEvent(dropEvent);
    }
  }
});

// Expose helper to check for Electron drag/drop support
contextBridge.exposeInMainWorld(
  'electronDropSupport', {
    // Web apps can check this to know if Electron file drops are available
    isAvailable: true,
    // Event names that will be dispatched
    events: {
      fileDrop: 'electron-file-drop',
      urlDrop: 'electron-url-drop'
    }
  }
); 