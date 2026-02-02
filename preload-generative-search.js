/**
 * Preload Script for Generative Search
 * 
 * Exposes IPC methods for the generative search feature.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('generativeSearch', {
  /**
   * Run a generative search
   * @param {Object} options - Search options
   * @returns {Promise<Array>} Search results
   */
  search: (options) => ipcRenderer.invoke('generative-search:search', options),
  
  /**
   * Estimate cost before running search
   * @param {Object} options - Options with filters, spaceId, mode
   * @returns {Promise<Object>} Cost estimate
   */
  estimateCost: (options) => ipcRenderer.invoke('generative-search:estimate-cost', options),
  
  /**
   * Cancel ongoing search
   * @returns {Promise<void>}
   */
  cancel: () => ipcRenderer.invoke('generative-search:cancel'),
  
  /**
   * Get available filter types
   * @returns {Promise<Object>} Filter definitions
   */
  getFilterTypes: () => ipcRenderer.invoke('generative-search:get-filter-types'),
  
  /**
   * Clear search cache
   * @returns {Promise<void>}
   */
  clearCache: () => ipcRenderer.invoke('generative-search:clear-cache'),
  
  /**
   * Listen for progress updates
   * @param {Function} callback - Progress callback
   * @returns {Function} Cleanup function
   */
  onProgress: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('generative-search:progress', handler);
    return () => ipcRenderer.removeListener('generative-search:progress', handler);
  }
});
