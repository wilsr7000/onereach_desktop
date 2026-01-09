/**
 * Preload Script for Tab Picker Window
 * 
 * Exposes secure IPC methods for tab picker functionality.
 */

const { contextBridge, ipcRenderer } = require('electron');

// Store callbacks for updates
let tabsUpdateCallback = null;
let statusUpdateCallback = null;

// Listen for updates from main process
ipcRenderer.on('tabs-update', (event, tabs) => {
  if (tabsUpdateCallback) {
    tabsUpdateCallback(tabs);
  }
});

ipcRenderer.on('status-update', (event, status) => {
  if (statusUpdateCallback) {
    statusUpdateCallback(status);
  }
});

contextBridge.exposeInMainWorld('tabPicker', {
  // Get API status (extension connected?)
  getStatus: () => ipcRenderer.invoke('tab-picker:get-status'),
  
  // Get list of open tabs from extension
  getTabs: () => ipcRenderer.invoke('tab-picker:get-tabs'),
  
  // Capture a specific tab
  captureTab: (tabId) => ipcRenderer.invoke('tab-picker:capture-tab', tabId),
  
  // Fetch URL as fallback
  fetchUrl: (url) => ipcRenderer.invoke('tab-picker:fetch-url', url),
  
  // Send result back to parent window
  sendResult: (result) => ipcRenderer.send('tab-picker:result', result),
  
  // Close the picker window
  close: () => ipcRenderer.send('tab-picker:close'),
  
  // Open setup guide
  openSetupGuide: () => ipcRenderer.send('tab-picker:open-setup'),
  
  // Register callback for tab updates
  onTabsUpdate: (callback) => {
    tabsUpdateCallback = callback;
  },
  
  // Register callback for status updates
  onStatusUpdate: (callback) => {
    statusUpdateCallback = callback;
  }
});



