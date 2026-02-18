const { contextBridge, ipcRenderer } = require('electron');

/**
 * Spaces Picker Preload
 *
 * Exposes safe IPC methods to the picker renderer
 */

contextBridge.exposeInMainWorld('spacesPicker', {
  // Get all spaces
  getSpaces: () => ipcRenderer.invoke('spaces-picker:get-spaces'),

  // Get items in a space
  getItems: (spaceId) => ipcRenderer.invoke('spaces-picker:get-items', spaceId),

  // Send selected items back to main process
  selectItems: (items) => ipcRenderer.send('spaces-picker:select', items),

  // Cancel selection
  cancel: () => ipcRenderer.send('spaces-picker:cancel'),
});
