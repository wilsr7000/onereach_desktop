/**
 * Standalone Spaces API Preload
 *
 * A minimal preload script that provides access to the Spaces API.
 * Can be used by any window type, including external windows and AI tools.
 *
 * This exposes window.spaces with the full unified API for:
 * - Space management (list, create, update, delete)
 * - Item management (list, add, update, delete, move)
 * - Search and queries
 * - Metadata management
 * - File system access within spaces
 * - Real-time events
 *
 * Usage in BrowserWindow config:
 *   webPreferences: {
 *     preload: path.join(__dirname, 'preload-spaces.js'),
 *     contextIsolation: true,
 *     nodeIntegration: false
 *   }
 */

const { contextBridge, ipcRenderer } = require('electron');

// ============================================
// UNIFIED SPACES API
// ============================================

contextBridge.exposeInMainWorld('spaces', {
  // ---- SPACE MANAGEMENT ----

  /**
   * List all spaces with metadata
   * @returns {Promise<Array>} Array of space objects
   */
  list: () => ipcRenderer.invoke('spaces:list'),

  /**
   * Get a single space by ID
   * @param {string} id - Space ID
   * @returns {Promise<Object|null>} Space object or null
   */
  get: (id) => ipcRenderer.invoke('spaces:get', id),

  /**
   * Create a new space
   * @param {string} name - Space name
   * @param {Object} opts - Options (icon, color, notebook)
   * @returns {Promise<Object>} Created space
   */
  create: (name, opts) => ipcRenderer.invoke('spaces:create', name, opts),

  /**
   * Update a space
   * @param {string} id - Space ID
   * @param {Object} data - Updates (name, icon, color)
   * @returns {Promise<boolean>} Success status
   */
  update: (id, data) => ipcRenderer.invoke('spaces:update', id, data),

  /**
   * Delete a space (items move to Unclassified)
   * @param {string} id - Space ID
   * @returns {Promise<boolean>} Success status
   */
  delete: (id) => ipcRenderer.invoke('spaces:delete', id),

  // ---- DISCOVERY (remote graph -> local) ----

  /**
   * Discover remote spaces in the graph not yet imported locally.
   * @returns {Promise<Object>} { spaces: [...], email, lastChecked, error? }
   */
  discover: () => ipcRenderer.invoke('spaces:discover'),

  /**
   * Import remote spaces from the graph into local storage.
   * @param {Array<Object>} remoteSpaces - Array of remote space objects from discover()
   * @returns {Promise<Object>} { imported: [...], skipped: [...], failed: [...] }
   */
  importRemote: (remoteSpaces) => ipcRenderer.invoke('spaces:discover:import', remoteSpaces),

  /**
   * Listen for remote-discovered events (fired by discovery polling).
   * @param {Function} cb - Callback with { spaces, email, lastChecked }
   * @returns {Function} Unsubscribe function
   */
  onRemoteDiscovered: (cb) => {
    const handler = (event, data) => {
      if (data.type === 'spaces:remote-discovered') cb(data);
    };
    ipcRenderer.on('spaces:event', handler);
    return () => ipcRenderer.removeListener('spaces:event', handler);
  },

  // ---- ITEM MANAGEMENT ----
  items: {
    /**
     * List items in a space
     * @param {string} spaceId - Space ID
     * @param {Object} opts - Options (limit, offset, type, pinned, includeContent)
     * @returns {Promise<Array>} Array of items
     */
    list: (spaceId, opts) => ipcRenderer.invoke('spaces:items:list', spaceId, opts),

    /**
     * Get a single item with full content
     * @param {string} spaceId - Space ID
     * @param {string} itemId - Item ID
     * @returns {Promise<Object|null>} Item or null
     */
    get: (spaceId, itemId) => ipcRenderer.invoke('spaces:items:get', spaceId, itemId),

    /**
     * Add a new item to a space
     * @param {string} spaceId - Space ID
     * @param {Object} item - Item (type, content, metadata, source)
     * @returns {Promise<Object>} Created item
     */
    add: (spaceId, item) => ipcRenderer.invoke('spaces:items:add', spaceId, item),

    /**
     * Update an item's properties
     * @param {string} spaceId - Space ID
     * @param {string} itemId - Item ID
     * @param {Object} data - Updates
     * @returns {Promise<boolean>} Success status
     */
    update: (spaceId, itemId, data) => ipcRenderer.invoke('spaces:items:update', spaceId, itemId, data),

    /**
     * Delete an item
     * @param {string} spaceId - Space ID
     * @param {string} itemId - Item ID
     * @returns {Promise<boolean>} Success status
     */
    delete: (spaceId, itemId) => ipcRenderer.invoke('spaces:items:delete', spaceId, itemId),

    /**
     * Move an item to a different space
     * @param {string} itemId - Item ID
     * @param {string} from - Current space ID
     * @param {string} to - Target space ID
     * @returns {Promise<boolean>} Success status
     */
    move: (itemId, from, to) => ipcRenderer.invoke('spaces:items:move', itemId, from, to),

    /**
     * Toggle pin status
     * @param {string} spaceId - Space ID
     * @param {string} itemId - Item ID
     * @returns {Promise<boolean>} New pinned status
     */
    togglePin: (spaceId, itemId) => ipcRenderer.invoke('spaces:items:togglePin', spaceId, itemId),

    /**
     * Get tags for an item
     * @param {string} spaceId - Space ID
     * @param {string} itemId - Item ID
     * @returns {Promise<Array<string>>} Tags
     */
    getTags: (spaceId, itemId) => ipcRenderer.invoke('spaces:items:getTags', spaceId, itemId),

    /**
     * Set tags for an item (replaces existing)
     * @param {string} spaceId - Space ID
     * @param {string} itemId - Item ID
     * @param {Array<string>} tags - Tags to set
     * @returns {Promise<boolean>} Success
     */
    setTags: (spaceId, itemId, tags) => ipcRenderer.invoke('spaces:items:setTags', spaceId, itemId, tags),

    /**
     * Add a tag to an item
     * @param {string} spaceId - Space ID
     * @param {string} itemId - Item ID
     * @param {string} tag - Tag to add
     * @returns {Promise<Array<string>>} Updated tags
     */
    addTag: (spaceId, itemId, tag) => ipcRenderer.invoke('spaces:items:addTag', spaceId, itemId, tag),

    /**
     * Remove a tag from an item
     * @param {string} spaceId - Space ID
     * @param {string} itemId - Item ID
     * @param {string} tag - Tag to remove
     * @returns {Promise<Array<string>>} Updated tags
     */
    removeTag: (spaceId, itemId, tag) => ipcRenderer.invoke('spaces:items:removeTag', spaceId, itemId, tag),

    /**
     * Generate or regenerate AI metadata for an item
     * @param {string} spaceId - Space ID
     * @param {string} itemId - Item ID
     * @param {Object} opts - Options (apiKey, customPrompt)
     * @returns {Promise<Object>} { success, metadata } or { success: false, error }
     */
    generateMetadata: (spaceId, itemId, opts) =>
      ipcRenderer.invoke('spaces:items:generateMetadata', spaceId, itemId, opts),
  },

  // ---- TAGS ----
  tags: {
    /**
     * List all unique tags in a space
     * @param {string} spaceId - Space ID
     * @returns {Promise<Array<{tag: string, count: number}>>} Tags with counts
     */
    list: (spaceId) => ipcRenderer.invoke('spaces:tags:list', spaceId),

    /**
     * List all tags across all spaces
     * @returns {Promise<Array<{tag: string, count: number, spaces: Array}>>} Tags
     */
    listAll: () => ipcRenderer.invoke('spaces:tags:listAll'),

    /**
     * Find items by tags
     * @param {Array<string>} tags - Tags to search
     * @param {Object} opts - Options (spaceId, matchAll, limit)
     * @returns {Promise<Array>} Matching items
     */
    findItems: (tags, opts) => ipcRenderer.invoke('spaces:tags:findItems', tags, opts),

    /**
     * Rename a tag across all items in a space
     * @param {string} spaceId - Space ID
     * @param {string} oldTag - Tag to rename
     * @param {string} newTag - New name
     * @returns {Promise<number>} Items updated
     */
    rename: (spaceId, oldTag, newTag) => ipcRenderer.invoke('spaces:tags:rename', spaceId, oldTag, newTag),

    /**
     * Delete a tag from all items in a space
     * @param {string} spaceId - Space ID
     * @param {string} tag - Tag to delete
     * @returns {Promise<number>} Items updated
     */
    deleteFromSpace: (spaceId, tag) => ipcRenderer.invoke('spaces:tags:deleteFromSpace', spaceId, tag),
  },

  // ---- SMART FOLDERS ----
  smartFolders: {
    /**
     * List all smart folders
     * @returns {Promise<Array>} Smart folders
     */
    list: () => ipcRenderer.invoke('spaces:smartFolders:list'),

    /**
     * Get a single smart folder
     * @param {string} id - Folder ID
     * @returns {Promise<Object|null>} Smart folder
     */
    get: (id) => ipcRenderer.invoke('spaces:smartFolders:get', id),

    /**
     * Create a smart folder
     * @param {string} name - Folder name
     * @param {Object} criteria - Filter criteria (tags, anyTags, types, spaces)
     * @param {Object} opts - Options (icon, color)
     * @returns {Promise<Object>} Created folder
     */
    create: (name, criteria, opts) => ipcRenderer.invoke('spaces:smartFolders:create', name, criteria, opts),

    /**
     * Update a smart folder
     * @param {string} id - Folder ID
     * @param {Object} updates - Properties to update
     * @returns {Promise<Object|null>} Updated folder
     */
    update: (id, updates) => ipcRenderer.invoke('spaces:smartFolders:update', id, updates),

    /**
     * Delete a smart folder
     * @param {string} id - Folder ID
     * @returns {Promise<boolean>} Success
     */
    delete: (id) => ipcRenderer.invoke('spaces:smartFolders:delete', id),

    /**
     * Get items matching a smart folder's criteria
     * @param {string} id - Folder ID
     * @param {Object} opts - Options (limit, offset, includeContent)
     * @returns {Promise<Array>} Matching items
     */
    getItems: (id, opts) => ipcRenderer.invoke('spaces:smartFolders:getItems', id, opts),

    /**
     * Preview items for criteria without saving
     * @param {Object} criteria - Filter criteria
     * @param {Object} opts - Options
     * @returns {Promise<Array>} Matching items
     */
    preview: (criteria, opts) => ipcRenderer.invoke('spaces:smartFolders:preview', criteria, opts),
  },

  // ---- SEARCH ----

  /**
   * Search across all spaces
   * @param {string} query - Search query
   * @param {Object} opts - Options (spaceId, type, limit)
   * @returns {Promise<Array>} Matching items
   */
  search: (query, opts) => ipcRenderer.invoke('spaces:search', query, opts),

  // ---- METADATA ----
  metadata: {
    /**
     * Get space metadata
     * @param {string} spaceId - Space ID
     * @returns {Promise<Object|null>} Metadata
     */
    get: (spaceId) => ipcRenderer.invoke('spaces:metadata:get', spaceId),

    /**
     * Update space metadata
     * @param {string} spaceId - Space ID
     * @param {Object} data - Updates
     * @returns {Promise<Object|null>} Updated metadata
     */
    update: (spaceId, data) => ipcRenderer.invoke('spaces:metadata:update', spaceId, data),

    /**
     * Get file metadata
     * @param {string} spaceId - Space ID
     * @param {string} filePath - File path
     * @returns {Promise<Object|null>} File metadata
     */
    getFile: (spaceId, filePath) => ipcRenderer.invoke('spaces:metadata:getFile', spaceId, filePath),

    /**
     * Set file metadata
     * @param {string} spaceId - Space ID
     * @param {string} filePath - File path
     * @param {Object} data - Metadata
     * @returns {Promise<Object|null>} Updated space metadata
     */
    setFile: (spaceId, filePath, data) => ipcRenderer.invoke('spaces:metadata:setFile', spaceId, filePath, data),

    /**
     * Set asset metadata (journey map, style guide, etc.)
     * @param {string} spaceId - Space ID
     * @param {string} assetType - Asset type
     * @param {Object} data - Metadata
     * @returns {Promise<Object|null>} Updated space metadata
     */
    setAsset: (spaceId, assetType, data) => ipcRenderer.invoke('spaces:metadata:setAsset', spaceId, assetType, data),

    /**
     * Set approval status
     * @param {string} spaceId - Space ID
     * @param {string} itemType - Item type
     * @param {string} itemId - Item ID
     * @param {boolean} approved - Approval status
     * @returns {Promise<Object|null>} Updated space metadata
     */
    setApproval: (spaceId, itemType, itemId, approved) =>
      ipcRenderer.invoke('spaces:metadata:setApproval', spaceId, itemType, itemId, approved),

    /**
     * Add a version to history
     * @param {string} spaceId - Space ID
     * @param {Object} versionData - Version data
     * @returns {Promise<Object|null>} Updated space metadata
     */
    addVersion: (spaceId, versionData) => ipcRenderer.invoke('spaces:metadata:addVersion', spaceId, versionData),

    /**
     * Update project configuration
     * @param {string} spaceId - Space ID
     * @param {Object} config - Config updates
     * @returns {Promise<Object|null>} Updated space metadata
     */
    updateProjectConfig: (spaceId, config) =>
      ipcRenderer.invoke('spaces:metadata:updateProjectConfig', spaceId, config),
  },

  // ---- FILE SYSTEM ----
  files: {
    /**
     * Get path to space directory
     * @param {string} spaceId - Space ID
     * @returns {Promise<string>} Absolute path
     */
    getPath: (spaceId) => ipcRenderer.invoke('spaces:files:getPath', spaceId),

    /**
     * List files in space directory
     * @param {string} spaceId - Space ID
     * @param {string} subPath - Optional subdirectory
     * @returns {Promise<Array>} File info objects
     */
    list: (spaceId, subPath) => ipcRenderer.invoke('spaces:files:list', spaceId, subPath),

    /**
     * Read a file from space
     * @param {string} spaceId - Space ID
     * @param {string} filePath - Relative file path
     * @returns {Promise<string|null>} File contents
     */
    read: (spaceId, filePath) => ipcRenderer.invoke('spaces:files:read', spaceId, filePath),

    /**
     * Write a file to space
     * @param {string} spaceId - Space ID
     * @param {string} filePath - Relative file path
     * @param {string} content - File content
     * @returns {Promise<boolean>} Success status
     */
    write: (spaceId, filePath, content) => ipcRenderer.invoke('spaces:files:write', spaceId, filePath, content),

    /**
     * Delete a file from space
     * @param {string} spaceId - Space ID
     * @param {string} filePath - Relative file path
     * @returns {Promise<boolean>} Success status
     */
    delete: (spaceId, filePath) => ipcRenderer.invoke('spaces:files:delete', spaceId, filePath),
  },

  /**
   * Get storage root path
   * @returns {Promise<string>} Path to OR-Spaces directory
   */
  getStorageRoot: () => ipcRenderer.invoke('spaces:getStorageRoot'),

  // ---- EVENTS ----

  /**
   * Listen for space created events
   * @param {Function} cb - Callback (space)
   * @returns {Function} Unsubscribe function
   */
  onSpaceCreated: (cb) => {
    const handler = (event, data) => {
      if (data.type === 'space:created') cb(data.space);
    };
    ipcRenderer.on('spaces:event', handler);
    return () => ipcRenderer.removeListener('spaces:event', handler);
  },

  /**
   * Listen for space updated events
   * @param {Function} cb - Callback (spaceId, data)
   * @returns {Function} Unsubscribe function
   */
  onSpaceUpdated: (cb) => {
    const handler = (event, data) => {
      if (data.type === 'space:updated') cb(data.spaceId, data.data);
    };
    ipcRenderer.on('spaces:event', handler);
    return () => ipcRenderer.removeListener('spaces:event', handler);
  },

  /**
   * Listen for space deleted events
   * @param {Function} cb - Callback (spaceId)
   * @returns {Function} Unsubscribe function
   */
  onSpaceDeleted: (cb) => {
    const handler = (event, data) => {
      if (data.type === 'space:deleted') cb(data.spaceId);
    };
    ipcRenderer.on('spaces:event', handler);
    return () => ipcRenderer.removeListener('spaces:event', handler);
  },

  /**
   * Listen for item added events
   * @param {Function} cb - Callback (spaceId, item)
   * @returns {Function} Unsubscribe function
   */
  onItemAdded: (cb) => {
    const handler = (event, data) => {
      if (data.type === 'item:added') cb(data.spaceId, data.item);
    };
    ipcRenderer.on('spaces:event', handler);
    return () => ipcRenderer.removeListener('spaces:event', handler);
  },

  /**
   * Listen for item updated events
   * @param {Function} cb - Callback (spaceId, itemId, data)
   * @returns {Function} Unsubscribe function
   */
  onItemUpdated: (cb) => {
    const handler = (event, data) => {
      if (data.type === 'item:updated') cb(data.spaceId, data.itemId, data.data);
    };
    ipcRenderer.on('spaces:event', handler);
    return () => ipcRenderer.removeListener('spaces:event', handler);
  },

  /**
   * Listen for item deleted events
   * @param {Function} cb - Callback (spaceId, itemId)
   * @returns {Function} Unsubscribe function
   */
  onItemDeleted: (cb) => {
    const handler = (event, data) => {
      if (data.type === 'item:deleted') cb(data.spaceId, data.itemId);
    };
    ipcRenderer.on('spaces:event', handler);
    return () => ipcRenderer.removeListener('spaces:event', handler);
  },

  /**
   * Listen for item moved events
   * @param {Function} cb - Callback (itemId, fromSpaceId, toSpaceId)
   * @returns {Function} Unsubscribe function
   */
  onItemMoved: (cb) => {
    const handler = (event, data) => {
      if (data.type === 'item:moved') cb(data.itemId, data.fromSpaceId, data.toSpaceId);
    };
    ipcRenderer.on('spaces:event', handler);
    return () => ipcRenderer.removeListener('spaces:event', handler);
  },

  /**
   * Listen for any space event
   * @param {Function} cb - Callback ({ type, ...data })
   * @returns {Function} Unsubscribe function
   */
  onEvent: (cb) => {
    const handler = (event, data) => cb(data);
    ipcRenderer.on('spaces:event', handler);
    return () => ipcRenderer.removeListener('spaces:event', handler);
  },
});

// Also expose a minimal electronAPI for window management
contextBridge.exposeInMainWorld('electronAPI', {
  /**
   * Close the current window
   */
  closeWindow: () => {
    ipcRenderer.send('close-content-window');
  },

  /**
   * Get basic window info
   * @returns {Object} Window info
   */
  getWindowInfo: () => ({
    isElectron: true,
    platform: process.platform,
    hasSpacesAPI: true,
  }),
});

// Listen for close events from the main process
ipcRenderer.on('close-window', () => {
  window.dispatchEvent(new Event('electron-window-closing'));
});

// ============================================
// SPEECH RECOGNITION APIS
// (Web Speech API doesn't work in Electron - use these instead)
// ============================================

// Expose Speech Recognition Bridge (ElevenLabs Scribe API)
// Use this instead of webkitSpeechRecognition which doesn't work in Electron
// Speech/Voice APIs (shared module)
const {
  getSpeechBridgeMethods,
  getRealtimeSpeechMethods,
  getMicManagerMethods,
  getVoiceTTSMethods,
} = require('./preload-speech');
contextBridge.exposeInMainWorld('speechBridge', getSpeechBridgeMethods());

contextBridge.exposeInMainWorld('realtimeSpeech', getRealtimeSpeechMethods());

contextBridge.exposeInMainWorld('micManager', getMicManagerMethods());
contextBridge.exposeInMainWorld('voiceTTS', getVoiceTTSMethods());

// ============================================
// CLIPBOARD API
// (For windows where Edit menu paste may not work)
// ============================================

// Clipboard API (shared module)
const { getClipboardMethods } = require('./preload-clipboard-shared');
contextBridge.exposeInMainWorld('clipboardAPI', getClipboardMethods({ includeHTML: true, includeHasText: true }));

// ============================================
// ORB CONTROL API
// Uses the shared module from preload-orb-control.js.
// ============================================
const { getOrbControlMethods } = require('./preload-orb-control');
contextBridge.exposeInMainWorld('orbControl', getOrbControlMethods());
console.log('[preload-spaces] orbControl API exposed (shared module)');

// Playbook + Sync APIs (shared module)
const { getPlaybookMethods, getSyncMethods } = require('./preload-playbook-sync');
contextBridge.exposeInMainWorld('playbook', getPlaybookMethods('preload-spaces'));
contextBridge.exposeInMainWorld('sync', getSyncMethods());

// Debug flag to verify preload loaded (check with window.__preloadSpacesLoaded)
contextBridge.exposeInMainWorld('__preloadSpacesLoaded', true);

console.log('[preload-spaces] Spaces API loaded (with speech, clipboard, orb control, playbook, and sync support)');
