const path = require('path');
const fs = require('fs');
const os = require('os');
const ClipboardStorageV2 = require('./clipboard-storage-v2');
const AppContextCapture = require('./app-context-capture');
const getLogger = require('./event-logger');
const { getContentIngestionService, ValidationError, retryOperation } = require('./content-ingestion');

// Handle Electron imports gracefully
let BrowserWindow, ipcMain, globalShortcut, screen, app, clipboard, nativeImage;
try {
  const electron = require('electron');
  BrowserWindow = electron.BrowserWindow;
  ipcMain = electron.ipcMain;
  globalShortcut = electron.globalShortcut;
  screen = electron.screen;
  app = electron.app;
  clipboard = electron.clipboard;
  nativeImage = electron.nativeImage;
} catch (e) {
  // Not in Electron environment - for testing
  console.log('Running in non-Electron environment');
}

/**
 * Adapter class that provides the same API as the old ClipboardManager
 * but uses the new ClipboardStorageV2 underneath
 */
class ClipboardManagerV2 {
  constructor() {
    // Check if migration is needed
    this.checkAndMigrate();
    
    // Initialize new storage
    this.storage = new ClipboardStorageV2();
    
    // Initialize app context capture
    this.contextCapture = new AppContextCapture();
    
    // PERFORMANCE: Defer loading history until first access
    // This speeds up initial startup significantly
    this.history = null; // Will be loaded lazily
    this.spaces = null;  // Will be loaded lazily
    this._historyLoaded = false;
    
    // Compatibility properties
    this.maxHistorySize = 1000;
    this.pinnedItems = new Set();
    this.spacesEnabled = true;
    this.screenshotCaptureEnabled = true;
    this.currentSpace = 'unclassified';
    this.clipboardWindow = null;
    this.blackHoleWindow = null;
    this.screenshotWatcher = null;
    this.processedScreenshots = new Set();
    
    // Load preferences (lightweight, do immediately)
    this.loadPreferences();
    
    // Set up IPC handlers (needed immediately for IPC)
    this.setupIPC();
    
    // Log feature initialization
    const logger = getLogger();
    logger.logFeatureUsed('clipboard-manager', { 
      status: 'initialized',
      spacesEnabled: this.spacesEnabled,
      screenshotCaptureEnabled: this.screenshotCaptureEnabled
    });
    
    // PERFORMANCE: Defer heavy initialization to next tick
    setImmediate(() => {
      // Set up screenshot monitoring if enabled
      if (this.screenshotCaptureEnabled) {
        this.setupScreenshotWatcher();
      }
      
      // Set up website monitoring periodic checks
      this.startWebsiteMonitoring();
    });
  }
  
  // PERFORMANCE: Lazy load history on first access
  ensureHistoryLoaded() {
    if (!this._historyLoaded) {
      console.log('[Clipboard] Lazy loading history...');
      this.loadFromStorage();
      this._historyLoaded = true;
      console.log('[Clipboard] History loaded:', this.history.length, 'items');
    }
  }
  
  // NOTE: getHistory() is defined below with content loading logic
  
  // Getter for spaces that ensures lazy loading
  getSpaces() {
    this.ensureHistoryLoaded();
    return this.spaces;
  }
  
  loadFromStorage() {
    // Initialize arrays if null (for lazy loading support)
    if (this.history === null) {
      this.history = [];
    }
    if (this.spaces === null) {
      this.spaces = [];
    }
    
    // Load all items (without content for performance)
    const items = this.storage.getAllItems();
    
    // Convert to old format for compatibility
    this.history = items.map(item => {
      const historyItem = {
      id: item.id,
      type: item.type,
      content: null, // Will be loaded on demand
      thumbnail: null, // Will be loaded on demand
      preview: item.preview,
      timestamp: item.timestamp,
      pinned: item.pinned,
      spaceId: item.spaceId,
      // Store reference to load content later
      _needsContent: true
      };
      
      // Preserve file-specific properties
      if (item.type === 'file') {
        historyItem.fileName = item.fileName;
        historyItem.fileSize = item.fileSize;
        historyItem.fileType = item.fileType;
        historyItem.fileCategory = item.fileCategory;
        historyItem.fileExt = item.fileExt;
        historyItem.isScreenshot = item.isScreenshot;
        historyItem.filePath = item.filePath; // This will be updated when content is loaded
      }
      
      return historyItem;
    });
    
    // Load spaces - make a copy to avoid reference issues
    this.spaces = [...(this.storage.index.spaces || [])];
    
    // Track pinned items
    this.pinnedItems = new Set(
      items.filter(item => item.pinned).map(item => item.id)
    );
  }
  
  loadPreferences() {
    const prefs = this.storage.getPreferences();
    this.spacesEnabled = prefs.spacesEnabled !== undefined ? prefs.spacesEnabled : true;
    this.screenshotCaptureEnabled = prefs.screenshotCaptureEnabled !== undefined ? prefs.screenshotCaptureEnabled : true;
    this.currentSpace = prefs.currentSpace || 'unclassified';
  }
  
  savePreferences() {
    this.storage.updatePreferences({
      spacesEnabled: this.spacesEnabled,
      screenshotCaptureEnabled: this.screenshotCaptureEnabled,
      currentSpace: this.currentSpace
    });
  }
  
  // Main methods that need adaptation
  
  async addToHistory(item) {
    // Ensure history is loaded before adding
    this.ensureHistoryLoaded();
    
    const logger = getLogger();
    logger.logClipboardOperation('add', item.type, { 
      hasMetadata: !!item.metadata,
      spaceId: this.currentSpace
    });
    
    // Capture app context if not already provided
    let context = item.context;
    if (!context && !item.source) {
      try {
        context = await this.contextCapture.getFullContext();
        console.log('[V2] Captured context:', context);
      } catch (error) {
        const logger = getLogger();
        logger.warn('Clipboard context capture failed', {
          error: error.message,
          operation: 'addToHistory'
        });
      }
    }
    
    // Enhance source detection with context
    if (context && !item.source) {
      item.source = this.contextCapture.enhanceSourceDetection(
        item.content || item.preview || '',
        context
      );
    } else if (!item.source) {
      item.source = this.detectSource(item.content || item.preview || '');
    }
    
    // Add context to item metadata
    if (context) {
      item.metadata = {
        ...item.metadata,
        context: {
          app: context.app,
          window: context.window,
          contextDisplay: this.contextCapture.formatContextDisplay(context)
        }
      };
    }
    
    // Add to new storage
    const indexEntry = this.storage.addItem({
      ...item,
      spaceId: item.spaceId || this.currentSpace || 'unclassified'
    });
    
    // Update in-memory history for compatibility
    const historyItem = {
      ...item,
      id: indexEntry.id,
      spaceId: indexEntry.spaceId,
      _needsContent: false
    };
    
    this.history.unshift(historyItem);
    
    // Maintain max history size
    if (this.history.length > this.maxHistorySize) {
      const toRemove = this.history[this.history.length - 1];
      this.history.pop();
      this.storage.deleteItem(toRemove.id);
    }
    
    // Update pinned items set
    if (item.pinned) {
      this.pinnedItems.add(indexEntry.id);
    }
    
    // Update space counts
    this.updateSpaceCounts();
    
    // Update lastUsed timestamp for the space
    const targetSpaceId = indexEntry.spaceId;
    if (targetSpaceId && targetSpaceId !== 'unclassified') {
      this.updateSpaceLastUsed(targetSpaceId);
    }
    
    // Sync to unified space-metadata.json if item belongs to a space
    if (targetSpaceId) {
      try {
        const spaceMeta = this.storage.getSpaceMetadata(targetSpaceId);
        if (spaceMeta) {
          const fileKey = item.fileName || `item-${indexEntry.id}`;
          spaceMeta.files[fileKey] = {
            itemId: indexEntry.id,
            fileName: item.fileName,
            type: item.type,
            fileType: item.fileType,
            fileCategory: item.fileCategory,
            preview: item.preview,
            source: item.source,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          };
          this.storage.updateSpaceMetadata(targetSpaceId, { files: spaceMeta.files });
          console.log('[Clipboard] Synced new item to space-metadata.json:', fileKey);
        }
      } catch (syncError) {
        const logger = getLogger();
        logger.error('Clipboard space sync failed', {
          error: syncError.message,
          operation: 'syncNewItem',
          spaceId: this.currentSpace
        });
      }
    }
    
    // Notify renderer
    this.notifyHistoryUpdate();
    
    // Show notification if capturing to specific space
    if (this.currentSpace && this.currentSpace !== 'unclassified' && BrowserWindow) {
      const space = this.spaces.find(s => s.id === this.currentSpace);
      if (space) {
        BrowserWindow.getAllWindows().forEach(window => {
          window.webContents.send('show-notification', {
            title: `Captured to ${space.icon} ${space.name}`,
            body: this.getItemPreview(item)
          });
        });
      }
    }
    
    // Auto-generate AI metadata if enabled (run async, don't block)
    // Pass fileType for proper categorization of image files
    this.maybeAutoGenerateMetadata(indexEntry.id, item.type, item.isScreenshot, item.fileType);
  }
  
  /**
   * Check settings and auto-generate AI metadata if enabled
   * This runs asynchronously so it doesn't block clipboard capture
   */
  async maybeAutoGenerateMetadata(itemId, itemType, isScreenshot, fileType = null) {
    // #region agent log
    try { require('fs').appendFileSync('/Users/richardwilson/Onereach_app/.cursor/debug.log', JSON.stringify({location:'clipboard-manager-v2-adapter.js:maybeAutoGenerateMetadata:entry',message:'maybeAutoGenerateMetadata called',data:{itemId,itemType,isScreenshot,fileType},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H-META'})+'\n'); } catch(e){}
    // #endregion
    try {
      const { getSettingsManager } = require('./settings-manager');
      const settingsManager = getSettingsManager();
      
      // Check if auto AI metadata is enabled
      const autoAIMetadata = settingsManager.get('autoAIMetadata');
      const autoAIMetadataTypes = settingsManager.get('autoAIMetadataTypes') || ['all'];
      const apiKey = settingsManager.get('llmApiKey');
      
      // Also check legacy screenshot setting for backward compatibility
      const autoGenerateScreenshotMetadata = settingsManager.get('autoGenerateScreenshotMetadata');
      
      // Check if this is an image file (type=file but fileType=image-file)
      const isImageFile = itemType === 'file' && fileType === 'image-file';
      
      // #region agent log
      try { require('fs').appendFileSync('/Users/richardwilson/Onereach_app/.cursor/debug.log', JSON.stringify({location:'clipboard-manager-v2-adapter.js:maybeAutoGenerateMetadata:settings',message:'Settings check',data:{itemId,itemType,fileType,isImageFile,autoAIMetadata,autoAIMetadataTypes,hasApiKey:!!apiKey,autoGenerateScreenshotMetadata},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H-META'})+'\n'); } catch(e){}
      // #endregion
      
      console.log(`[Auto AI] Settings check for item ${itemId}:`, {
        itemType,
        fileType,
        isScreenshot,
        isImageFile,
        autoAIMetadata,
        autoAIMetadataTypes,
        hasApiKey: !!apiKey,
        autoGenerateScreenshotMetadata
      });
      
      if (!apiKey) {
        console.log('[Auto AI] No API key configured, skipping metadata generation');
        // #region agent log
        try { require('fs').appendFileSync('/Users/richardwilson/Onereach_app/.cursor/debug.log', JSON.stringify({location:'clipboard-manager-v2-adapter.js:maybeAutoGenerateMetadata:noApiKey',message:'No API key - skipping',data:{itemId},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H-META'})+'\n'); } catch(e){}
        // #endregion
        return; // No API key configured
      }
      
      // Determine if we should generate metadata for this item
      let shouldGenerate = false;
      
      if (autoAIMetadata) {
        // New setting: check if this type is in the allowed list
        if (autoAIMetadataTypes.includes('all')) {
          shouldGenerate = true;
        } else if (isScreenshot && autoAIMetadataTypes.includes('screenshot')) {
          shouldGenerate = true;
        } else if ((itemType === 'image' || isImageFile) && autoAIMetadataTypes.includes('image')) {
          // Include image files (type=file, fileType=image-file) when 'image' is enabled
          shouldGenerate = true;
        } else if (itemType === 'text' && autoAIMetadataTypes.includes('text')) {
          shouldGenerate = true;
        } else if (itemType === 'html' && autoAIMetadataTypes.includes('html')) {
          shouldGenerate = true;
        } else if (itemType === 'file' && autoAIMetadataTypes.includes('file')) {
          shouldGenerate = true;
        } else if (itemType === 'code' && autoAIMetadataTypes.includes('code')) {
          shouldGenerate = true;
        } else if (autoAIMetadataTypes.includes(itemType)) {
          // Fallback: check if type directly matches any setting
          shouldGenerate = true;
        }
      } else if (autoGenerateScreenshotMetadata && isScreenshot) {
        // Legacy setting: only screenshots
        shouldGenerate = true;
      }
      
      if (!shouldGenerate) {
        console.log(`[Auto AI] Skipping metadata generation for ${itemType} (not in enabled types: ${autoAIMetadataTypes.join(', ')})`);
        // #region agent log
        try { require('fs').appendFileSync('/Users/richardwilson/Onereach_app/.cursor/debug.log', JSON.stringify({location:'clipboard-manager-v2-adapter.js:maybeAutoGenerateMetadata:skip',message:'Skipping - not in enabled types',data:{itemId,itemType,fileType,autoAIMetadataTypes},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H-META'})+'\n'); } catch(e){}
        // #endregion
        return;
      }
      
      console.log(`[Auto AI] Generating metadata for ${itemType} item: ${itemId}`);
      // #region agent log
      try { require('fs').appendFileSync('/Users/richardwilson/Onereach_app/.cursor/debug.log', JSON.stringify({location:'clipboard-manager-v2-adapter.js:maybeAutoGenerateMetadata:generate',message:'Will generate metadata',data:{itemId,itemType,fileType},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H-META'})+'\n'); } catch(e){}
      // #endregion
      
      // Generate metadata using NEW specialized system
      const MetadataGenerator = require('./metadata-generator');
      const metadataGen = new MetadataGenerator(this);
      
      // #region agent log
      try { require('fs').appendFileSync('/Users/richardwilson/Onereach_app/.cursor/debug.log', JSON.stringify({location:'clipboard-manager-v2-adapter.js:maybeAutoGenerateMetadata:beforeGenerate',message:'About to call generateMetadataForItem',data:{itemId},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H-META'})+'\n'); } catch(e){}
      // #endregion
      
      const result = await metadataGen.generateMetadataForItem(itemId, apiKey);
      
      // #region agent log
      try { require('fs').appendFileSync('/Users/richardwilson/Onereach_app/.cursor/debug.log', JSON.stringify({location:'clipboard-manager-v2-adapter.js:maybeAutoGenerateMetadata:afterGenerate',message:'generateMetadataForItem returned',data:{itemId,success:result?.success,error:result?.error,hasMetadata:!!result?.metadata},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H-META'})+'\n'); } catch(e){}
      // #endregion
      
      if (result.success) {
        console.log(`[Auto AI] Successfully generated specialized metadata for ${itemType}: ${itemId}`);
        
        // Notify UI to refresh this item
        this.notifyHistoryUpdate();
        
        // Send notification about AI analysis completion
        if (BrowserWindow) {
          BrowserWindow.getAllWindows().forEach(window => {
            window.webContents.send('show-notification', {
              title: '✨ AI Analysis Complete',
              body: result.metadata.description ? result.metadata.description.substring(0, 50) + '...' : 'Metadata generated'
            });
          });
        }
      } else {
        console.error(`[Auto AI] Failed to generate metadata for item ${itemId}:`, result.error);
        // #region agent log
        try { require('fs').appendFileSync('/Users/richardwilson/Onereach_app/.cursor/debug.log', JSON.stringify({location:'clipboard-manager-v2-adapter.js:maybeAutoGenerateMetadata:failed',message:'Metadata generation failed',data:{itemId,error:result?.error},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H-META'})+'\n'); } catch(e){}
        // #endregion
      }
    } catch (error) {
      // #region agent log
      try { require('fs').appendFileSync('/Users/richardwilson/Onereach_app/.cursor/debug.log', JSON.stringify({location:'clipboard-manager-v2-adapter.js:maybeAutoGenerateMetadata:exception',message:'Exception in metadata generation',data:{error:error.message,stack:error.stack?.substring(0,500)},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H-META'})+'\n'); } catch(e){}
      // #endregion
      const logger = getLogger();
      logger.error('Clipboard auto AI metadata generation failed', {
        error: error.message,
        stack: error.stack,
        operation: 'autoGenerateMetadata'
      });
    }
  }
  
  getHistory() {
    // Ensure history is loaded (lazy loading)
    this.ensureHistoryLoaded();
    
    // Load content and metadata on demand for items that need it
    return this.history.map(item => {
      if (item._needsContent || !item.metadata || Object.keys(item.metadata || {}).length < 3) {
        try {
          const fullItem = this.storage.loadItem(item.id);
          item.content = fullItem.content;
          item.thumbnail = fullItem.thumbnail;
          item._needsContent = false;
          
          // Merge metadata from storage
          if (fullItem.metadata) {
            item.metadata = { ...item.metadata, ...fullItem.metadata };
            
            // Update fileSize from metadata if not set
            if (!item.fileSize && fullItem.metadata.fileSize) {
              item.fileSize = fullItem.metadata.fileSize;
            }
          }
          
          // For files, update the filePath to the stored location
          if (item.type === 'file' && fullItem.content) {
            item.filePath = fullItem.content; // Storage returns the actual file path
            
            // Get file size if not set
            if (!item.fileSize && fullItem.content) {
              try {
                const fs = require('fs');
                const stats = fs.statSync(fullItem.content);
                item.fileSize = stats.size;
              } catch (e) {}
            }
          }
        } catch (error) {
          const logger = getLogger();
          logger.warn('Clipboard item content load failed', {
            error: error.message,
            itemId: item.id
          });
        }
      }
      return item;
    });
  }
  
  async deleteItem(id) {
    // Ensure history is loaded
    this.ensureHistoryLoaded();
    
    // If we have a manager instance, wait for any pending operations
    if (this.manager && this.manager.pendingOperations) {
      const pendingOps = this.manager.pendingOperations.get(id);
      if (pendingOps && pendingOps.size > 0) {
        console.log(`Waiting for ${pendingOps.size} pending operations to complete before deleting item ${id}`);
        try {
          await Promise.race([
            Promise.all(Array.from(pendingOps)),
            new Promise((resolve) => setTimeout(resolve, 5000)) // 5 second timeout
          ]);
        } catch (e) {
          console.error('Error waiting for pending operations:', e);
        }
      }
    }
    
    // Get item info before deletion for space metadata cleanup
    const item = this.history.find(h => h.id === id);
    const spaceId = item ? item.spaceId : null;
    const fileName = item ? item.fileName : null;
    
    const success = this.storage.deleteItem(id);
    if (success) {
      // Remove from unified space-metadata.json
      if (spaceId) {
        try {
          const spaceMeta = this.storage.getSpaceMetadata(spaceId);
          if (spaceMeta) {
            const fileKey = fileName || `item-${id}`;
            if (spaceMeta.files[fileKey]) {
              delete spaceMeta.files[fileKey];
              this.storage.updateSpaceMetadata(spaceId, { files: spaceMeta.files });
              console.log('[Clipboard] Removed from space-metadata.json:', fileKey);
            }
          }
        } catch (syncError) {
          const logger = getLogger();
          logger.error('Clipboard remove from space failed', {
            error: syncError.message,
            operation: 'removeFromSpace',
            itemId: id
          });
        }
      }
      
      this.history = this.history.filter(h => h.id !== id);
      this.pinnedItems.delete(id);
      if (this.manager && this.manager.pendingOperations) {
        this.manager.pendingOperations.delete(id); // Clean up pending operations
      }
      this.updateSpaceCounts();
      this.notifyHistoryUpdate();
    }
  }
  
  async clearHistory() {
    // Keep only pinned items
    const pinnedItems = this.history.filter(h => h.pinned);
    const unpinnedItems = this.history.filter(h => !h.pinned);
    
    // Delete unpinned items from storage in parallel
    await Promise.all(
      unpinnedItems.map(async (item) => {
        // Wait for any pending operations if we have a manager instance
        if (this.manager && this.manager.pendingOperations) {
          const pendingOps = this.manager.pendingOperations.get(item.id);
          if (pendingOps && pendingOps.size > 0) {
            try {
              await Promise.race([
                Promise.all(Array.from(pendingOps)),
                new Promise((resolve) => setTimeout(resolve, 5000))
              ]);
            } catch (e) {
              console.error('Error waiting for pending operations:', e);
            }
          }
        }
        this.storage.deleteItem(item.id);
        if (this.manager && this.manager.pendingOperations) {
          this.manager.pendingOperations.delete(item.id);
        }
      })
    );
    
    this.history = pinnedItems;
    this.updateSpaceCounts();
    this.notifyHistoryUpdate();
  }
  
  togglePin(id) {
    const pinned = this.storage.togglePin(id);
    
    // Update in-memory state
    const item = this.history.find(h => h.id === id);
    if (item) {
      item.pinned = pinned;
      if (pinned) {
        this.pinnedItems.add(id);
      } else {
        this.pinnedItems.delete(id);
      }
    }
    
    this.notifyHistoryUpdate();
    return { success: true, pinned };
  }
  
  searchHistory(query) {
    const results = this.storage.search(query);
    
    // Convert to old format
    return results.map(item => ({
      ...item,
      content: null,
      thumbnail: null,
      _needsContent: true
    }));
  }
  
  moveItemToSpace(itemId, spaceId) {
    // Get item before moving to know old space
    const item = this.history.find(h => h.id === itemId);
    const oldSpaceId = item ? item.spaceId : null;
    
    const success = this.storage.moveItem(itemId, spaceId);
    
    if (success) {
      // Update in-memory history
      if (item) {
        item.spaceId = spaceId;
      }
      
      // Sync with unified space-metadata.json
      try {
        const fullItem = this.storage.loadItem(itemId);
        const fileKey = fullItem.fileName || `item-${itemId}`;
        
        // Remove from old space's metadata
        if (oldSpaceId) {
          const oldMeta = this.storage.getSpaceMetadata(oldSpaceId);
          if (oldMeta && oldMeta.files[fileKey]) {
            delete oldMeta.files[fileKey];
            this.storage.updateSpaceMetadata(oldSpaceId, { files: oldMeta.files });
          }
        }
        
        // Add to new space's metadata
        if (spaceId) {
          const newMeta = this.storage.getSpaceMetadata(spaceId);
          if (newMeta) {
            newMeta.files[fileKey] = {
              itemId: itemId,
              fileName: fullItem.fileName,
              type: fullItem.type,
              fileType: fullItem.fileType,
              preview: fullItem.preview,
              movedAt: new Date().toISOString(),
              updatedAt: new Date().toISOString()
            };
            this.storage.updateSpaceMetadata(spaceId, { files: newMeta.files });
            console.log('[Clipboard] Synced move to space-metadata.json:', fileKey, '->', spaceId);
          }
        }
      } catch (syncError) {
        const logger = getLogger();
        logger.error('Clipboard move to space sync failed', {
          error: syncError.message,
          operation: 'moveToSpace',
          targetSpaceId: spaceId
        });
      }
      
      this.updateSpaceCounts();
      this.notifyHistoryUpdate();
    }
    
    return { success };
  }
  
  // Space management
  
  getSpaces() {
    // Ensure history/spaces are loaded before returning
    // This was causing null to be returned if Video Editor opened before Clipboard Viewer
    this.ensureHistoryLoaded();
    return this.spaces;
  }
  
  createSpace(space) {
    // #region agent log
    console.log('[GSX-DEBUG] H7: createSpace method called');
    console.log('[GSX-DEBUG] H7: this.storage exists:', !!this.storage);
    console.log('[GSX-DEBUG] H7: space param:', JSON.stringify(space));
    // #endregion
    
    // Add lastUsed timestamp when creating a space
    const spaceWithTimestamp = {
      ...space,
      lastUsed: Date.now(),
      createdAt: Date.now()
    };
    
    // #region agent log
    console.log('[GSX-DEBUG] H8: About to call this.storage.createSpace');
    // #endregion
    
    const newSpace = this.storage.createSpace(spaceWithTimestamp);
    
    // #region agent log
    console.log('[GSX-DEBUG] H8: storage.createSpace returned:', JSON.stringify(newSpace));
    // #endregion
    
    // Reload spaces from storage to stay in sync
    this.spaces = [...(this.storage.index.spaces || [])];
    this.notifySpacesUpdate();
    return { success: true, space: newSpace };
  }
  
  updateSpace(id, updates) {
    const success = this.storage.updateSpace(id, updates);
    
    if (success) {
      // Reload spaces from storage to stay in sync
      this.spaces = [...(this.storage.index.spaces || [])];
      this.notifySpacesUpdate();
    }
    
    return { success };
  }
  
  // Update lastUsed timestamp for a space (called when space is selected or item added)
  updateSpaceLastUsed(spaceId) {
    if (!spaceId) return;
    
    const spaceIndex = this.storage.index.spaces.findIndex(s => s.id === spaceId);
    if (spaceIndex !== -1) {
      this.storage.index.spaces[spaceIndex].lastUsed = Date.now();
      this.storage.saveIndex();
      
      // Reload in-memory spaces
      this.spaces = [...(this.storage.index.spaces || [])];
    }
  }
  
  deleteSpace(id) {
    try {
      this.storage.deleteSpace(id);
      // Reload spaces from storage to stay in sync
      this.spaces = [...(this.storage.index.spaces || [])];
      
      // Update in-memory history
      this.history.forEach(item => {
        if (item.spaceId === id) {
          item.spaceId = 'unclassified';
        }
      });
      
      if (this.currentSpace === id) {
        this.currentSpace = 'unclassified';
        this.savePreferences();
      }
      
      this.notifySpacesUpdate();
      this.notifyHistoryUpdate();
      
      return { success: true };
    } catch (error) {
      const logger = getLogger();
      logger.error('Space deletion failed', {
        error: error.message,
        stack: error.stack,
        operation: 'deleteSpace'
      });
      return { success: false };
    }
  }
  
  getSpaceItems(spaceId) {
    this.ensureHistoryLoaded(); // Ensure history is loaded before accessing
    
    // Filter items by space
    const items = this.history.filter(item => 
      spaceId === null ? true : item.spaceId === spaceId
    );
    
    // Load content and thumbnails on demand (same as getHistory does)
    return items.map(item => {
      if (item._needsContent || !item.thumbnail) {
        try {
          const fullItem = this.storage.loadItem(item.id);
          item.content = fullItem.content;
          item.thumbnail = fullItem.thumbnail;
          item._needsContent = false;
          
          // Merge metadata from storage
          if (fullItem.metadata) {
            item.metadata = { ...item.metadata, ...fullItem.metadata };
            
            // Update fileSize from metadata if not set
            if (!item.fileSize && fullItem.metadata.fileSize) {
              item.fileSize = fullItem.metadata.fileSize;
            }
          }
        } catch (error) {
          console.warn('[getSpaceItems] Failed to load content for item:', item.id, error.message);
        }
      }
      return item;
    });
  }
  
  updateSpaceCounts() {
    // Force recalculation of all space counts in storage
    this.storage.index.spaces.forEach(space => {
      this.storage.updateSpaceCount(space.id); // Pass no delta to force recalculation
    });
    this.storage.saveIndex(); // Save the updated counts
    // Reload spaces from storage to stay in sync
    this.spaces = [...(this.storage.index.spaces || [])];
  }
  
  // Preferences
  
  toggleSpaces(enabled) {
    this.spacesEnabled = enabled;
    this.savePreferences();
    
    if (BrowserWindow) {
      BrowserWindow.getAllWindows().forEach(window => {
        window.webContents.send('clipboard:spaces-toggled', this.spacesEnabled);
      });
    }
  }
  
  setActiveSpace(spaceId) {
    this.currentSpace = spaceId;
    this.savePreferences();
    
    // Update lastUsed timestamp for this space
    if (spaceId) {
      this.updateSpaceLastUsed(spaceId);
    }
    
    let spaceName = 'All Items';
    if (spaceId) {
      const space = this.spaces.find(s => s.id === spaceId);
      if (space) {
        spaceName = `${space.icon} ${space.name}`;
      }
    }
    
    if (BrowserWindow) {
      BrowserWindow.getAllWindows().forEach(window => {
        window.webContents.send('clipboard:active-space-changed', {
          spaceId: this.currentSpace,
          spaceName: spaceName
        });
      });
    }
  }
  
  // Helper methods
  
  generateId() {
    return this.storage.generateId();
  }
  
  truncateText(text, maxLength) {
    if (!text || text.length <= maxLength) return text;
    return text.substring(0, maxLength) + '...';
  }
  
  stripHtml(html) {
    if (!html) return '';
    
    // Remove script and style tags and their content
    let text = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
    text = text.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '');
    
    // Remove all HTML tags
    text = text.replace(/<[^>]*>/g, '');
    
    // Decode common HTML entities
    text = text
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
      .replace(/&mdash;/gi, '—')
      .replace(/&ndash;/gi, '–')
      .replace(/&hellip;/gi, '...')
      .replace(/&bull;/gi, '•')
      .replace(/&copy;/gi, '©')
      .replace(/&reg;/gi, '®')
      .replace(/&trade;/gi, '™')
      .replace(/&#(\d+);/gi, (match, dec) => String.fromCharCode(dec))
      .replace(/&#x([0-9a-f]+);/gi, (match, hex) => String.fromCharCode(parseInt(hex, 16)));
    
    // Clean up extra whitespace
    text = text
      .replace(/\t/g, ' ')  // Tabs to spaces
      .replace(/ +/g, ' ')  // Multiple spaces to single
      .replace(/\n +/g, '\n')  // Remove leading spaces on lines
      .replace(/ +\n/g, '\n')  // Remove trailing spaces on lines
      .replace(/\n\n+/g, '\n\n')  // Multiple newlines to double
      .trim();
    
    return text;
  }
  
  detectSource(text) {
    // Implementation from original
    if (text.includes('```') || /function|const|let|var|class/.test(text)) {
      return 'code';
    }
    if (/^https?:\/\//.test(text)) {
      return 'url';
    }
    if (text.includes('@') && text.includes('.')) {
      return 'email';
    }
    return 'text';
  }
  
  formatFileSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }
  
  getItemPreview(item) {
    if (item.type === 'text') {
      return item.preview || item.content.substring(0, 50) + '...';
    } else if (item.type === 'image') {
      return 'Image copied';
    } else if (item.type === 'file') {
      return `File: ${item.fileName}`;
    }
    return 'Item copied';
  }
  
  getTypeBreakdown() {
    const breakdown = {};
    this.history.forEach(item => {
      breakdown[item.type] = (breakdown[item.type] || 0) + 1;
    });
    return breakdown;
  }
  
  notifyHistoryUpdate() {
    if (BrowserWindow) {
      BrowserWindow.getAllWindows().forEach(window => {
        window.webContents.send('clipboard:history-updated', this.getHistory());
      });
    }
  }
  
  notifySpacesUpdate() {
    if (BrowserWindow) {
      BrowserWindow.getAllWindows().forEach(window => {
        window.webContents.send('clipboard:spaces-updated', this.spaces);
      });
    }
    
    try {
      const { refreshApplicationMenu } = require('./menu');
      refreshApplicationMenu();
    } catch (e) {
      // Menu module not available in non-Electron environment
    }
  }
  
  // Generate AI metadata for video content
  async generateVideoMetadata({ transcript, originalTitle, uploader, description, duration }) {
    console.log('[AI-Metadata] Generating video metadata...');
    
    const { getSettingsManager } = require('./settings-manager');
    const settingsManager = getSettingsManager();
    const apiKey = settingsManager.get('llmApiKey');
    
    if (!apiKey) {
      console.log('[AI-Metadata] No API key configured');
      return null;
    }
    
    // Truncate transcript for API (keep first 8000 chars)
    const truncatedTranscript = transcript.length > 8000 
      ? transcript.substring(0, 8000) + '...[truncated]'
      : transcript;
    
    const prompt = `Analyze this video transcript and extract the key information.

VIDEO INFO:
- Original Title: ${originalTitle || 'Unknown'}
- Creator/Channel: ${uploader || 'Unknown'}
- Duration: ${duration || 'Unknown'}

TRANSCRIPT:
${truncatedTranscript}

Generate a JSON response with these fields:
{
  "title": "A clear, descriptive title that captures the main topic (max 80 chars)",
  "shortDescription": "One sentence capturing the core topic/thesis (max 150 chars)",
  "longDescription": "A structured summary with the following format (plain text only, no markdown):\n\nOVERVIEW: One paragraph explaining what this content is about and why it matters.\n\nKEY POINTS:\n• Point 1 - explanation\n• Point 2 - explanation\n• Point 3 - explanation\n• Point 4 - explanation\n• Point 5 - explanation\n(Include 5-8 key points)\n\nMAIN TAKEAWAYS: One paragraph summarizing the most important insights or conclusions.",
  "topics": ["topic1", "topic2", "topic3", "topic4", "topic5"],
  "speakers": ["Full Name 1", "Full Name 2"] - identify speakers by name if mentioned, otherwise use descriptive labels like "Host", "Guest Expert", "Interviewer",
  "storyBeats": [
    "Key insight or argument 1",
    "Key insight or argument 2", 
    "Key insight or argument 3",
    "Key insight or argument 4",
    "Key insight or argument 5",
    "Key insight or argument 6",
    "Key insight or argument 7"
  ]
}

IMPORTANT RULES:
1. Focus ONLY on the actual content and ideas discussed - ignore any sponsor messages, ads, promotional content, or calls to action
2. Extract substantive points, arguments, and insights - not surface-level observations
3. The longDescription should be informative and useful - someone reading it should understand the key ideas without watching
4. Use bullet points (•) for the KEY POINTS section but no other markdown
5. Story beats should be the most important ideas, arguments, or insights - not timestamps or structural markers
6. Be specific and concrete in descriptions - avoid vague summaries

Respond ONLY with valid JSON, no other text.`;

    try {
      const isClaudeKey = apiKey.startsWith('sk-ant-');
      
      if (isClaudeKey) {
        // Use Claude API
        const https = require('https');
        
        const response = await new Promise((resolve, reject) => {
          const postData = JSON.stringify({
            model: 'claude-sonnet-4-5-20250929',
            max_tokens: 1500,
            messages: [{ role: 'user', content: prompt }]
          });
          
          const options = {
            hostname: 'api.anthropic.com',
            port: 443,
            path: '/v1/messages',
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': apiKey,
              'anthropic-version': '2023-06-01',
              'Content-Length': Buffer.byteLength(postData)
            },
            timeout: 60000
          };
          
          const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
              try {
                const parsed = JSON.parse(data);
                if (parsed.content && parsed.content[0] && parsed.content[0].text) {
                  resolve(parsed.content[0].text);
                } else if (parsed.error) {
                  reject(new Error(parsed.error.message));
                } else {
                  reject(new Error('Unexpected response format'));
                }
              } catch (e) {
                reject(e);
              }
            });
          });
          
          req.on('error', reject);
          req.on('timeout', () => reject(new Error('Request timeout')));
          req.write(postData);
          req.end();
        });
        
        // Parse JSON from response
        const jsonMatch = response.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          return JSON.parse(jsonMatch[0]);
        }
        
      } else {
        // Use OpenAI API
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
          },
          body: JSON.stringify({
            model: 'gpt-4o-mini',
            messages: [{ role: 'user', content: prompt }],
            max_tokens: 1500,
            temperature: 0.3
          })
        });
        
        const data = await response.json();
        if (data.choices && data.choices[0] && data.choices[0].message) {
          const content = data.choices[0].message.content;
          const jsonMatch = content.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            return JSON.parse(jsonMatch[0]);
          }
        }
      }
    } catch (err) {
      const logger = getLogger();
      logger.error('AI metadata generation failed', {
        error: err.message,
        operation: 'generateAIMetadata'
      });
    }
    
    return null;
  }
  
  // Background YouTube download - creates placeholder immediately, downloads in background
  async downloadYouTubeInBackground(url, spaceId, placeholderId, sender) {
    const { Notification } = require('electron');
    
    console.log('[YouTube-BG] Starting background download for:', url, 'placeholder:', placeholderId);
    
    try {
      // Get the downloader instance
      const { YouTubeDownloader } = require('./youtube-downloader');
      const dl = new YouTubeDownloader();
      
      // Set up progress callback - update UI on every progress report
      const progressCallback = (percent, status) => {
        console.log('[YouTube-BG] Progress:', percent, '%', status);
        
        // Update progress in memory
        const historyItem = this.history.find(h => h.id === placeholderId);
        if (historyItem && historyItem.metadata) {
          historyItem.metadata.downloadProgress = percent;
          historyItem.metadata.downloadStatusText = status;
        }
        
        // Notify UI on every progress update
        this.notifyHistoryUpdate();
        
        // Send to specific sender if still valid
        if (sender && !sender.isDestroyed()) {
          sender.send('youtube:download-progress', { percent, status, url, placeholderId });
        }
      };
      
      // Start a simulated progress indicator while downloading
      let simulatedProgress = 10;
      const progressInterval = setInterval(() => {
        if (simulatedProgress < 85) {
          simulatedProgress += Math.random() * 5 + 2; // Random increment 2-7%
          const historyItem = this.history.find(h => h.id === placeholderId);
          if (historyItem && historyItem.metadata && historyItem.metadata.downloadStatus === 'downloading') {
            historyItem.metadata.downloadProgress = Math.min(85, Math.round(simulatedProgress));
            this.notifyHistoryUpdate();
          }
        }
      }, 2000); // Update every 2 seconds
      
      // Download the file only (don't add to storage - we already have placeholder)
      const result = await dl.download(url, { quality: 'high' }, progressCallback);
      
      // Stop the simulated progress
      clearInterval(progressInterval);
      
      console.log('[YouTube-BG] Download completed:', JSON.stringify(result));
      
      // Try to fetch transcript
      let transcript = null;
      if (result.success) {
        try {
          console.log('[YouTube-BG] Fetching transcript...');
          const transcriptResult = await dl.getTranscript(url, 'en');
          if (transcriptResult.success) {
            transcript = {
              text: transcriptResult.transcript,
              segments: transcriptResult.segments,
              language: transcriptResult.language,
              isAutoGenerated: transcriptResult.isAutoGenerated,
            };
            console.log('[YouTube-BG] Transcript fetched:', transcript.language);
          }
        } catch (e) {
          console.log('[YouTube-BG] Could not fetch transcript:', e.message);
        }
      }
      
      if (result.success) {
        const fs = require('fs');
        const videoInfo = result.videoInfo || {};
        const title = videoInfo.title || 'YouTube Video';
        
        // Copy the downloaded file to the placeholder's storage directory
        const itemDir = path.join(this.storage.itemsDir, placeholderId);
        const destFilePath = path.join(itemDir, result.fileName);
        
        try {
          // Ensure directory exists
          if (!fs.existsSync(itemDir)) {
            fs.mkdirSync(itemDir, { recursive: true });
          }
          
          // Copy file
          fs.copyFileSync(result.filePath, destFilePath);
          console.log('[YouTube-BG] Copied video to:', destFilePath);
          
          // Clean up temp file
          try { fs.unlinkSync(result.filePath); } catch (e) {}
          
        } catch (copyErr) {
          console.error('[YouTube-BG] Error copying file:', copyErr);
        }
        
        // Update the placeholder with actual data
        const historyItem = this.history.find(h => h.id === placeholderId);
        if (historyItem) {
          historyItem.preview = title;
          historyItem.fileName = result.fileName;
          historyItem.content = destFilePath;
          historyItem.filePath = destFilePath;
          historyItem.fileSize = result.fileSize;
          historyItem.thumbnail = videoInfo.thumbnail;
          historyItem._needsContent = false;
          
          if (historyItem.metadata) {
            historyItem.metadata.downloadStatus = 'complete';
            historyItem.metadata.downloadProgress = 100;
            historyItem.metadata.filePath = destFilePath;
            historyItem.metadata.fileSize = result.fileSize;
            historyItem.metadata.title = title;
            historyItem.metadata.description = videoInfo.description;
            historyItem.metadata.uploader = videoInfo.uploader;
            historyItem.metadata.duration = videoInfo.duration;
            historyItem.metadata.thumbnail = videoInfo.thumbnail;
            if (transcript) {
              historyItem.metadata.transcript = transcript.text;
              historyItem.metadata.transcriptSegments = transcript.segments;
              historyItem.metadata.transcriptLanguage = transcript.language;
            }
          }
        }
        
        // Extract thumbnail from video
        let thumbnailPath = null;
        try {
          console.log('[YouTube-BG] Extracting thumbnail...');
          const ffmpeg = require('fluent-ffmpeg');
          const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
          ffmpeg.setFfmpegPath(ffmpegPath);
          
          thumbnailPath = path.join(itemDir, 'thumbnail.jpg');
          
          await new Promise((resolve, reject) => {
            ffmpeg(destFilePath)
              .screenshots({
                timestamps: ['10%'], // Take screenshot at 10% into the video
                filename: 'thumbnail.jpg',
                folder: itemDir,
                size: '480x270' // 16:9 aspect ratio thumbnail
              })
              .on('end', () => {
                console.log('[YouTube-BG] Thumbnail extracted to:', thumbnailPath);
                resolve();
              })
              .on('error', (err) => {
                console.error('[YouTube-BG] Thumbnail extraction error:', err);
                reject(err);
              });
          });
        } catch (thumbErr) {
          console.error('[YouTube-BG] Thumbnail extraction failed:', thumbErr.message);
          thumbnailPath = null;
        }
        
        // Extract audio file
        let audioPath = null;
        try {
          console.log('[YouTube-BG] Extracting audio...');
          const ffmpeg = require('fluent-ffmpeg');
          const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
          ffmpeg.setFfmpegPath(ffmpegPath);
          
          const audioFileName = path.parse(result.fileName).name + '.mp3';
          audioPath = path.join(itemDir, audioFileName);
          
          await new Promise((resolve, reject) => {
            ffmpeg(destFilePath)
              .noVideo()
              .audioCodec('libmp3lame')
              .audioBitrate('128k')
              .format('mp3')
              .output(audioPath)
              .on('end', () => {
                console.log('[YouTube-BG] Audio extracted to:', audioPath);
                resolve();
              })
              .on('error', (err) => {
                console.error('[YouTube-BG] Audio extraction error:', err);
                reject(err);
              })
              .run();
          });
        } catch (audioErr) {
          console.error('[YouTube-BG] Audio extraction failed:', audioErr.message);
          audioPath = null;
        }
        
        // Generate AI metadata if we have transcript
        let aiMetadata = null;
        if (transcript && transcript.text && transcript.text.length > 100) {
          try {
            console.log('[YouTube-BG] Generating AI metadata...');
            aiMetadata = await this.generateVideoMetadata({
              transcript: transcript.text,
              originalTitle: title,
              uploader: videoInfo.uploader,
              description: videoInfo.description,
              duration: videoInfo.duration
            });
            console.log('[YouTube-BG] AI metadata generated:', aiMetadata ? 'success' : 'failed');
          } catch (aiErr) {
            console.error('[YouTube-BG] AI metadata generation failed:', aiErr.message);
          }
        }
        
        // Update storage metadata file
        try {
          const metadataPath = path.join(itemDir, 'metadata.json');
          let metadata = {};
          if (fs.existsSync(metadataPath)) {
            metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
          }
          metadata.downloadStatus = 'complete';
          metadata.downloadProgress = 100;
          metadata.filePath = destFilePath;
          metadata.fileSize = result.fileSize;
          metadata.originalTitle = title;
          metadata.uploader = videoInfo.uploader;
          metadata.duration = videoInfo.duration;
          metadata.thumbnail = videoInfo.thumbnail;
          metadata.youtubeDescription = videoInfo.description;
          
          // Use AI-generated metadata if available, fallback to YouTube data
          if (aiMetadata) {
            metadata.title = aiMetadata.title || title;
            metadata.shortDescription = aiMetadata.shortDescription || '';
            metadata.longDescription = aiMetadata.longDescription || videoInfo.description || '';
            metadata.aiSummary = aiMetadata.longDescription || ''; // Use AI-generated summary for Overview tab
            metadata.topics = aiMetadata.topics || [];
            metadata.speakers = aiMetadata.speakers || [];
            metadata.storyBeats = aiMetadata.storyBeats || [];
          } else {
            metadata.title = title;
            metadata.shortDescription = videoInfo.description ? videoInfo.description.substring(0, 150) : '';
            metadata.longDescription = videoInfo.description || '';
            metadata.storyBeats = [];
          }
          
          if (transcript) {
            metadata.transcript = transcript.text;
            metadata.transcriptSegments = transcript.segments;
            metadata.transcriptLanguage = transcript.language;
          }
          
          if (audioPath) {
            metadata.audioPath = audioPath;
          }
          
          if (thumbnailPath && fs.existsSync(thumbnailPath)) {
            metadata.localThumbnail = thumbnailPath;
          }
          
          fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
          
          // Also save transcript as separate file for easy access
          if (transcript && transcript.text) {
            const transcriptPath = path.join(itemDir, 'transcript.txt');
            fs.writeFileSync(transcriptPath, transcript.text);
            console.log('[YouTube-BG] Transcript saved to:', transcriptPath);
          }
          
          // Update in-memory history with new metadata
          if (historyItem && historyItem.metadata) {
            historyItem.metadata.title = metadata.title;
            historyItem.metadata.shortDescription = metadata.shortDescription;
            historyItem.metadata.longDescription = metadata.longDescription;
            historyItem.metadata.audioPath = audioPath;
          }
          
        } catch (err) {
          console.error('[YouTube-BG] Error updating metadata:', err);
        }
        
        // Notify UI
        this.notifyHistoryUpdate();
        
        // Show system notification
        if (Notification.isSupported()) {
          const notification = new Notification({
            title: '✅ YouTube Download Complete',
            body: title,
            silent: false
          });
          notification.show();
        }
        
        // Send completion to renderer
        if (BrowserWindow) {
          BrowserWindow.getAllWindows().forEach(window => {
            window.webContents.send('youtube:download-complete', {
              success: true,
              placeholderId,
              title: title,
              filePath: destFilePath,
              fileSize: result.fileSize
            });
          });
        }
        
      } else {
        // Download failed - update placeholder to show error
        const historyItem = this.history.find(h => h.id === placeholderId);
        if (historyItem) {
          historyItem.preview = `❌ Download failed: ${historyItem.metadata?.title || 'Video'}`;
          if (historyItem.metadata) {
            historyItem.metadata.downloadStatus = 'error';
            historyItem.metadata.downloadError = result.error;
          }
        }
        
        this.notifyHistoryUpdate();
        
        // Show error notification
        if (Notification.isSupported()) {
          const notification = new Notification({
            title: '❌ YouTube Download Failed',
            body: result.error || 'Unknown error occurred',
            silent: false
          });
          notification.show();
        }
        
        // Send error to renderer
        if (BrowserWindow) {
          BrowserWindow.getAllWindows().forEach(window => {
            window.webContents.send('youtube:download-complete', {
              success: false,
              placeholderId,
              error: result.error
            });
          });
        }
      }
      
    } catch (error) {
      const logger = getLogger();
      logger.error('YouTube background download failed', {
        error: error.message,
        stack: error.stack,
        operation: 'backgroundDownload'
      });
      
      // Make sure to clear the progress interval
      if (typeof progressInterval !== 'undefined') {
        clearInterval(progressInterval);
      }
      
      // Update placeholder with error
      const historyItem = this.history.find(h => h.id === placeholderId);
      if (historyItem) {
        historyItem.preview = `❌ Download error: ${historyItem.metadata?.title || 'Video'}`;
        if (historyItem.metadata) {
          historyItem.metadata.downloadStatus = 'error';
          historyItem.metadata.downloadError = error.message;
        }
      }
      
      this.notifyHistoryUpdate();
      
      // Show error notification
      const { Notification } = require('electron');
      if (Notification.isSupported()) {
        const notification = new Notification({
          title: '❌ YouTube Download Failed',
          body: error.message,
          silent: false
        });
        notification.show();
      }
    }
  }
  
  // Window management (same as original)
  
  // CRITICAL: For clipboard viewer window (NOT black hole widget)
  createClipboardWindow() {
    if (this.clipboardWindow && !this.clipboardWindow.isDestroyed()) {
      this.clipboardWindow.focus();
      this.clipboardWindow.show();
      return;
    }
    
    // Use app.getAppPath() instead of __dirname for packaged apps
    const preloadPath = path.join(app.getAppPath(), 'preload.js');
    console.log('[ClipboardManager] Creating clipboard window with preload:', preloadPath);
    console.log('[ClipboardManager] App path:', app.getAppPath());
    console.log('[ClipboardManager] Preload exists?', require('fs').existsSync(preloadPath));
    
    // Check if preload script exists
    if (!require('fs').existsSync(preloadPath)) {
      console.error('[ClipboardManager] Preload script not found at:', preloadPath);
      const { dialog } = require('electron');
      dialog.showErrorBox('Error', 'Failed to load clipboard manager: Preload script not found.');
      return;
    }
    
    this.clipboardWindow = new BrowserWindow({
      width: 1400,
      height: 900,
      frame: false,
      transparent: true,
      alwaysOnTop: false,
      resizable: true,
      minWidth: 1200,
      minHeight: 700,
      skipTaskbar: false,
      show: false, // Don't show until ready
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: preloadPath,
        sandbox: false // Add this to ensure preload loads
      }
    });
    
    // Handle load errors
    this.clipboardWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
      console.error('[ClipboardManager] Failed to load:', errorCode, errorDescription);
      const { dialog } = require('electron');
      dialog.showErrorBox('Error', `Failed to load clipboard manager: ${errorDescription}`);
      if (this.clipboardWindow && !this.clipboardWindow.isDestroyed()) {
        this.clipboardWindow.close();
      }
    });
    
    // Show window when ready
    this.clipboardWindow.once('ready-to-show', () => {
      console.log('[ClipboardManager] Clipboard window ready to show');
      this.clipboardWindow.show();
    });
    
    this.clipboardWindow.loadFile('clipboard-viewer.html');
    
    // Add debug logging
    this.clipboardWindow.webContents.on('did-finish-load', () => {
      console.log('[ClipboardManager] Clipboard viewer finished loading');
    });
    
    this.clipboardWindow.webContents.on('preload-error', (event, preloadPath, error) => {
      console.error('[ClipboardManager] Preload error:', preloadPath, error);
    });
    
    this.clipboardWindow.on('closed', () => {
      this.clipboardWindow = null;
    });
  }
  
  // CRITICAL: Black hole widget window - DO NOT DUPLICATE THIS METHOD!
  // If broken, check TEST-BLACKHOLE.md for troubleshooting
  // Must use app.getAppPath() for preload, NOT __dirname
  createBlackHoleWindow(position, startExpanded = false, clipboardData = null) {
    // #region agent log
    try { require('fs').appendFileSync('/Users/richardwilson/Onereach_app/.cursor/debug.log', JSON.stringify({location:'clipboard-manager-v2-adapter.js:createBlackHoleWindow',message:'createBlackHoleWindow called',data:{hasPosition:!!position,startExpanded,hasClipboardData:!!clipboardData,windowExists:!!(this.blackHoleWindow&&!this.blackHoleWindow.isDestroyed())},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H7'})+'\n'); } catch(e){}
    // #endregion
    if (this.blackHoleWindow && !this.blackHoleWindow.isDestroyed()) {
      this.blackHoleWindow.focus();
      // If we have new clipboard data, send it
      if (clipboardData) {
        this.blackHoleWindow.webContents.send('paste-clipboard-data', clipboardData);
      }
      return;
    }
    
    // For paste operations, always start expanded with modal showing
    const width = (startExpanded || clipboardData) ? 600 : 150;
    const height = (startExpanded || clipboardData) ? 800 : 150;
    
    console.log('[BlackHole] Creating window:', { position, width, height, startExpanded });
    
    // Use app.getAppPath() for preload path in packaged apps
    const preloadPath = path.join(app.getAppPath(), 'preload.js');
    console.log('[BlackHole] Preload path:', preloadPath);
    
    const windowConfig = {
      width: width,
      height: height,
      transparent: true,
      frame: false,
      alwaysOnTop: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      hasShadow: false,
      backgroundColor: '#00000000',
      show: false,
      skipTaskbar: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: preloadPath,
        sandbox: false // Ensure preload can load
      }
    };
    
    // Add position to config if provided
    if (position && position.x !== undefined && position.y !== undefined) {
      windowConfig.x = Math.round(position.x);
      windowConfig.y = Math.round(position.y);
      console.log('[BlackHole] Setting initial position:', windowConfig.x, windowConfig.y);
    }
    
    this.blackHoleWindow = new BrowserWindow(windowConfig);
    
    // Pass startExpanded via query parameter so it's available immediately
    this.blackHoleWindow.loadFile('black-hole.html', {
      query: { startExpanded: startExpanded ? 'true' : 'false' }
    });
    
    // Check for preload errors
    this.blackHoleWindow.webContents.on('preload-error', (event, preloadPath, error) => {
      console.error('[BlackHole] Preload error:', preloadPath, error);
    });
    
    this.blackHoleWindow.once('ready-to-show', () => {
      // Position is already set in the config, just show the window
      this.blackHoleWindow.show();
      console.log('[BlackHole] Window shown at position:', this.blackHoleWindow.getBounds());
    });
    
    // Send startExpanded flag and clipboard data to the window after it loads
    this.blackHoleWindow.webContents.on('did-finish-load', () => {
      const hasClipboardData = !!clipboardData;
      console.log('[BlackHole] Window loaded, startExpanded:', startExpanded, 'hasClipboardData:', hasClipboardData);
      
      // Send init with clipboard data if available
      this.blackHoleWindow.webContents.send('black-hole:init', { 
        startExpanded: startExpanded || hasClipboardData,
        clipboardData: clipboardData 
      });
    });
    
    this.blackHoleWindow.on('closed', () => {
      this.blackHoleWindow = null;
      console.log('[BlackHole] Window closed');
    });
  }
  
  // Screenshot handling
  
  setupScreenshotWatcher() {
    if (!app || !app.getPath) {
      console.log('Screenshot watcher not available in non-Electron environment');
      return;
    }
    
    const desktopPath = app.getPath('desktop');
    
    if (fs.existsSync(desktopPath)) {
      console.log('Setting up screenshot watcher for:', desktopPath);
      
      // Track files being processed to prevent duplicates
      const processingFiles = new Set();
      
      this.screenshotWatcher = fs.watch(desktopPath, async (eventType, filename) => {
        if (eventType === 'rename' && filename) {
          if (this.isScreenshot(filename)) {
            const fullPath = path.join(desktopPath, filename);
            
            // Skip if already processed or currently processing
            if (this.processedScreenshots.has(fullPath) || processingFiles.has(fullPath)) {
              return;
            }
            
            // Mark as processing immediately
            processingFiles.add(fullPath);
            
            // Wait a bit longer for the file to be fully written
            await new Promise(resolve => setTimeout(resolve, 1500));
            
            try {
              if (fs.existsSync(fullPath)) {
                console.log('Screenshot file ready:', fullPath);
                await this.handleScreenshot(fullPath);
              } else {
                console.log('Screenshot file disappeared:', fullPath);
              }
            } finally {
              // Remove from processing set
              processingFiles.delete(fullPath);
            }
          }
        }
      });
      
      this.checkExistingScreenshots();
    }
  }
  
  isScreenshot(filename) {
    if (!filename) return false;
    
    const screenshotPatterns = [
      /^Screenshot\s+\d{4}-\d{2}-\d{2}\s+at\s+\d{1,2}\.\d{2}\.\d{2}\s+(AM|PM)\.png$/i,
      /^Screen\s*Shot\s+\d{4}-\d{2}-\d{2}\s+at\s+\d{1,2}\.\d{2}\.\d{2}\s+(AM|PM)\.png$/i,
      /^Screenshot_\d+\.png$/i,
      /^Screenshot\s+\d{4}-\d{2}-\d{2}\s+\d{6}\.png$/i,
      /^Capture\.PNG$/i,
      /^Screenshot\s*\(\d+\)\.png$/i,
      /^image\.png$/i,
      /^Screen\s*Recording\s+\d{4}-\d{2}-\d{2}\s+at\s+\d{1,2}\.\d{2}\.\d{2}\s+(AM|PM)\.(mov|mp4)$/i
    ];
    
    return screenshotPatterns.some(pattern => pattern.test(filename));
  }
  
  checkExistingScreenshots() {
    const desktopPath = app.getPath('desktop');
    
    try {
      const files = fs.readdirSync(desktopPath);
      const now = Date.now();
      
      files.forEach(filename => {
        if (this.isScreenshot(filename)) {
          const fullPath = path.join(desktopPath, filename);
          const stats = fs.statSync(fullPath);
          
          if (now - stats.mtimeMs < 5 * 60 * 1000) {
            if (!this.processedScreenshots.has(fullPath)) {
              console.log('Found recent screenshot:', filename);
              this.handleScreenshot(fullPath);
            }
          }
        }
      });
    } catch (error) {
      const logger = getLogger();
      logger.warn('Screenshot check failed', {
        error: error.message,
        operation: 'checkExistingScreenshots'
      });
    }
  }
  
  async handleScreenshot(screenshotPath) {
    console.log('Processing screenshot:', screenshotPath);
    
    try {
      this.processedScreenshots.add(screenshotPath);
      
      if (this.processedScreenshots.size > 100) {
        const entries = Array.from(this.processedScreenshots);
        entries.slice(0, entries.length - 100).forEach(path => {
          this.processedScreenshots.delete(path);
        });
      }
      
      if (!fs.existsSync(screenshotPath)) {
        console.log('Screenshot file not found:', screenshotPath);
        return;
      }
      
      const stats = fs.statSync(screenshotPath);
      const ext = path.extname(screenshotPath).toLowerCase();
      const fileName = path.basename(screenshotPath);
      
      const existingScreenshot = this.history.find(item => 
        item.type === 'file' && 
        item.fileName === fileName &&
        item.isScreenshot === true &&
        Date.now() - item.timestamp < 10000
      );
      
      if (existingScreenshot) {
        console.log('Screenshot already in history:', fileName);
        return;
      }
      
      if (!this.screenshotCaptureEnabled) {
        console.log('Screenshot capture is disabled');
        return;
      }
      
      if (!this.currentSpace || this.currentSpace === null) {
        console.log('No active space, prompting user to select space for screenshot');
        
        // Send event to renderer to show space selector modal
        if (this.clipboardWindow && !this.clipboardWindow.isDestroyed()) {
          this.clipboardWindow.webContents.send('clipboard:select-space-for-screenshot', {
            screenshotPath: screenshotPath,
            fileName: fileName,
            stats: stats,
            ext: ext
          });
          return; // The renderer will call back with the selected space
        } else {
          // If no clipboard window, put in unclassified
          this.currentSpace = 'unclassified';
        }
      }
      
      const isVideo = ['.mov', '.mp4', '.avi', '.mkv'].includes(ext);
      const fileType = isVideo ? 'video' : 'image-file';
      const fileCategory = 'media';
      
      let thumbnail = null;
      let fullImageData = null;
      if (!isVideo && stats.size < 50 * 1024 * 1024) {
        try {
          const imageData = fs.readFileSync(screenshotPath);
          fullImageData = `data:image/${ext.slice(1)};base64,${imageData.toString('base64')}`;
          // For screenshots, we want to keep a higher quality thumbnail for AI analysis
          // Only resize if the image is very large
          if (stats.size > 5 * 1024 * 1024) { // > 5MB
            thumbnail = this.generateImageThumbnail(fullImageData, 800, 800); // Larger thumbnail for better AI analysis
          } else {
            thumbnail = fullImageData; // Keep full quality for smaller screenshots
          }
          console.log(`Screenshot thumbnail size: ${thumbnail.length} bytes (original: ${stats.size} bytes)`);
        } catch (e) {
          console.error('Error creating screenshot thumbnail:', e);
        }
      }
      
      const item = {
        id: this.generateId(),
        type: 'file',
        fileType: fileType,
        fileCategory: fileCategory,
        filePath: screenshotPath,  // This is the source path that storage will copy from
        fileName: fileName,
        fileExt: ext,
        fileSize: stats.size,
        thumbnail: thumbnail,
        preview: `Screenshot: ${fileName}`,
        timestamp: Date.now(),
        pinned: false,
        spaceId: this.currentSpace,
        source: 'screenshot',
        isScreenshot: true
      };
      
      // Ensure the screenshot file exists before adding to history
      if (!fs.existsSync(screenshotPath)) {
        console.error('Screenshot file disappeared before storage:', screenshotPath);
        return;
      }
      
      await this.addToHistory(item);
      
      const space = this.spaces.find(s => s.id === this.currentSpace);
      if (space && BrowserWindow) {
        BrowserWindow.getAllWindows().forEach(window => {
          window.webContents.send('show-notification', {
            title: 'Screenshot Captured',
            body: `Added to ${space.icon} ${space.name}`
          });
        });
      }
      
      // Check if auto AI metadata generation is enabled for screenshots
      const settings = this.settingsManager?.getSettings();
      if (settings?.autoGenerateScreenshotMetadata && settings?.llmApiKey) {
        console.log('Auto-generating AI metadata for screenshot...');
        
        // Trigger AI metadata generation using specialized system
        setTimeout(async () => {
          try {
            const MetadataGenerator = require('./metadata-generator');
            const metadataGen = new MetadataGenerator(this);
            const result = await metadataGen.generateMetadataForItem(item.id, settings.llmApiKey);
            
            if (result.success) {
              console.log('AI metadata generated successfully for screenshot using specialized prompts');
              
              // Send notification about AI analysis completion
              if (BrowserWindow) {
                BrowserWindow.getAllWindows().forEach(window => {
                  window.webContents.send('show-notification', {
                    title: 'Screenshot Analyzed',
                    body: 'AI has analyzed your screenshot content'
                  });
                });
              }
            }
          } catch (error) {
            console.error('Error auto-generating AI metadata for screenshot:', error);
          }
        }, 1000); // Small delay to ensure item is fully saved
      }
    } catch (error) {
      const logger = getLogger();
      logger.error('Screenshot handling failed', {
        error: error.message,
        stack: error.stack,
        operation: 'handleScreenshot'
      });
    }
  }
  
  generateImageThumbnail(base64Data, maxWidth = 400, maxHeight = 400) {
    try {
      const image = nativeImage.createFromDataURL(base64Data);
      if (image.isEmpty()) {
        console.log('Failed to create image from base64 data');
        return base64Data;
      }
      
      const size = image.getSize();
      console.log(`Original image size: ${size.width}x${size.height}`);
      
      if (size.width <= maxWidth && size.height <= maxHeight) {
        return base64Data;
      }
      
      const aspectRatio = size.width / size.height;
      let newWidth = maxWidth;
      let newHeight = maxHeight;
      
      if (aspectRatio > 1) {
        newHeight = Math.round(maxWidth / aspectRatio);
      } else {
        newWidth = Math.round(maxHeight * aspectRatio);
      }
      
      const resized = image.resize({
        width: newWidth,
        height: newHeight,
        quality: 'good'
      });
      
      const thumbnail = resized.toDataURL();
      console.log(`Generated thumbnail: ${newWidth}x${newHeight}`);
      
      return thumbnail;
    } catch (error) {
      console.error('Error generating thumbnail:', error);
      return base64Data;
    }
  }
  
  // IPC Setup - Complete set of handlers for compatibility
  setupIPC() {
    // #region agent log
    console.log('[DEBUG-H2] setupIPC called:', { hasIpcMain: !!ipcMain, alreadyRegistered: !!ClipboardManagerV2._ipcRegistered });
    // #endregion
    if (!ipcMain) {
      console.log('IPC not available in non-Electron environment');
      return;
    }
    
    // Prevent duplicate IPC registration (memory leak prevention)
    if (ClipboardManagerV2._ipcRegistered) {
      console.warn('[ClipboardManager] IPC handlers already registered - skipping to prevent memory leak');
      // #region agent log
      console.log('[DEBUG-H2] setupIPC SKIPPED - _ipcRegistered flag was already true');
      // #endregion
      return;
    }
    ClipboardManagerV2._ipcRegistered = true;
    // #region agent log
    console.log('[DEBUG-H2] setupIPC proceeding - flag set to true, will register handlers');
    // #endregion
    
    // Helper to safely register IPC handlers - skips if handler already exists
    // This prevents "Attempted to register a second handler" errors when handlers
    // are registered elsewhere (e.g., main.js fallback handlers)
    const safeHandle = (channel, handler) => {
      try {
        ipcMain.handle(channel, handler);
      } catch (err) {
        if (err.message && err.message.includes('second handler')) {
          console.log(`[ClipboardManager] Handler for '${channel}' already exists, skipping`);
        } else {
          throw err; // Re-throw unexpected errors
        }
      }
    };
    
    // Store handler references for cleanup
    this._ipcOnHandlers = [];
    
    // Black hole window handlers
    ipcMain.on('black-hole:resize-window', (event, { width, height }) => {
      if (this.blackHoleWindow && !this.blackHoleWindow.isDestroyed()) {
        console.log('[BlackHole] Resizing window to:', width, 'x', height);
        const currentBounds = this.blackHoleWindow.getBounds();
        console.log('[BlackHole] Current bounds:', currentBounds);
        
        // Keep the window position relative to the button when expanding
        if (width > 150) {
          // When expanding for modal, adjust position to keep it visible
          // but still near the original position
          const newX = Math.max(10, currentBounds.x - (width - 150) / 2);
          const newY = Math.max(10, currentBounds.y - 50); // Move up slightly
          
          this.blackHoleWindow.setBounds({
            x: newX,
            y: newY,
            width: width,
            height: height
          }, true);
          console.log('[BlackHole] Expanded to modal size at:', newX, newY);
        } else {
          // Just resize without moving
          this.blackHoleWindow.setSize(width, height, true);
          console.log('[BlackHole] Restored to normal size');
        }
      }
    });
    
    ipcMain.on('black-hole:move-window', (event, { deltaX, deltaY }) => {
      if (this.blackHoleWindow && !this.blackHoleWindow.isDestroyed()) {
        const [currentX, currentY] = this.blackHoleWindow.getPosition();
        this.blackHoleWindow.setPosition(currentX + deltaX, currentY + deltaY, true);
      }
    });
    
    ipcMain.on('black-hole:get-position', (event) => {
      if (this.blackHoleWindow && !this.blackHoleWindow.isDestroyed()) {
        const [x, y] = this.blackHoleWindow.getPosition();
        event.reply('black-hole:position-response', { x, y });
      }
    });
    
    ipcMain.on('black-hole:restore-position', (event, position) => {
      if (this.blackHoleWindow && !this.blackHoleWindow.isDestroyed() && position) {
        this.blackHoleWindow.setPosition(position.x, position.y, true);
      }
    });
    
    ipcMain.on('black-hole:toggle-always-on-top', (event, enabled) => {
      if (this.blackHoleWindow && !this.blackHoleWindow.isDestroyed()) {
        this.blackHoleWindow.setAlwaysOnTop(enabled, 'floating');
      }
    });
    
    ipcMain.on('black-hole:active', () => {
      // Black hole is active (modal open)
      console.log('Black hole active');
    });
    
    ipcMain.on('black-hole:inactive', () => {
      // Black hole is inactive (modal closed)
      console.log('Black hole inactive');
    });
    
    // History management
    safeHandle('clipboard:get-history', () => {
      return this.getHistory();
    });
    
    safeHandle('clipboard:clear-history', async () => {
      await this.clearHistory();
      return { success: true };
    });
    
    safeHandle('clipboard:delete-item', async (event, id) => {
      await this.deleteItem(id);
      return { success: true };
    });
    
    safeHandle('clipboard:toggle-pin', (event, id) => {
      return this.togglePin(id);
    });
    
    safeHandle('clipboard:paste-item', (event, id) => {
      const item = this.history.find(h => h.id === id);
      if (!item) return { success: false };
      
      // Load full content if needed
      if (item._needsContent) {
        const fullItem = this.storage.loadItem(id);
        item.content = fullItem.content;
        item.thumbnail = fullItem.thumbnail;
        item._needsContent = false;
      }
      
      // Paste logic based on type
      if (item.type === 'text') {
        // For plain text, just write the text content
        clipboard.writeText(item.content);
      } else if (item.type === 'html') {
        // For HTML items, ONLY copy plain text - no HTML formatting
        const textContent = item.plainText || this.stripHtml(item.content);
        // Clean up any extra whitespace and formatting
        const cleanText = textContent
          .replace(/\s+/g, ' ')  // Replace multiple spaces/tabs with single space
          .replace(/\n\s*\n/g, '\n')  // Replace multiple newlines with single
          .trim();  // Remove leading/trailing whitespace
        
        // Only write plain text - NO HTML format to avoid formatting issues
        clipboard.writeText(cleanText);
      } else if (item.type === 'image' && item.content) {
        const image = nativeImage.createFromDataURL(item.content);
        clipboard.writeImage(image);
      } else if (item.type === 'file' && item.filePath) {
        clipboard.writeBuffer('public.file-url', Buffer.from(item.filePath));
      }
      
      return { success: true };
    });
    
    safeHandle('clipboard:search', (event, query) => {
      return this.searchHistory(query);
    });
    
    safeHandle('clipboard:get-stats', () => {
      return {
        totalItems: this.history.length,
        pinnedItems: this.pinnedItems.size,
        typeBreakdown: this.getTypeBreakdown(),
        storageSize: 0 // Would need to calculate
      };
    });
    
    // Space management
    safeHandle('clipboard:get-spaces', () => {
      return this.getSpaces();
    });
    
    safeHandle('clipboard:create-space', (event, space) => {
      // #region agent log
      console.log('[GSX-DEBUG] clipboard:create-space called with:', JSON.stringify(space));
      // #endregion
      try {
        const result = this.createSpace(space);
        // #region agent log
        console.log('[GSX-DEBUG] clipboard:create-space success:', JSON.stringify(result));
        // #endregion
        return result;
      } catch (error) {
        // #region agent log
        console.error('[GSX-DEBUG] clipboard:create-space error:', error.message, error.stack);
        // #endregion
        throw error;
      }
    });
    
    safeHandle('clipboard:update-space', (event, id, updates) => {
      return this.updateSpace(id, updates);
    });
    
    safeHandle('clipboard:delete-space', (event, id) => {
      return this.deleteSpace(id);
    });
    
    safeHandle('clipboard:set-current-space', (event, spaceId) => {
      this.setActiveSpace(spaceId);
      return { success: true };
    });
    
    safeHandle('clipboard:move-to-space', (event, itemId, spaceId) => {
      return this.moveItemToSpace(itemId, spaceId);
    });
    
    safeHandle('clipboard:get-space-items', (event, spaceId) => {
      const items = this.getSpaceItems(spaceId);
      return { success: true, items: items || [] };
    });
    
    safeHandle('clipboard:get-spaces-enabled', () => {
      return this.spacesEnabled;
    });
    
    safeHandle('clipboard:toggle-spaces', (event, enabled) => {
      this.toggleSpaces(enabled);
      return { success: true };
    });
    
    safeHandle('clipboard:get-active-space', () => {
      return {
        spaceId: this.currentSpace,
        spaceName: this.getSpaceName(this.currentSpace)
      };
    });
    
    // File system operations
    safeHandle('clipboard:open-storage-directory', () => {
      const { shell } = require('electron');
      shell.openPath(this.storage.storageRoot);
      return { success: true };
    });
    
    safeHandle('clipboard:open-space-directory', (event, spaceId) => {
      const { shell } = require('electron');
      const spaceDir = path.join(this.storage.spacesDir, spaceId);
      if (fs.existsSync(spaceDir)) {
        shell.openPath(spaceDir);
      }
      return { success: true };
    });
    
    // Native file drag for external apps/web pages
    safeHandle('clipboard:start-native-drag', (event, itemId) => {
      try {
        const item = this.storage.loadItem(itemId);
        if (!item || !item.contentPath) {
          console.error('[NativeDrag] Item not found or no content path:', itemId);
          return { success: false, error: 'Item not found' };
        }
        
        const filePath = path.join(this.storage.storageRoot, item.contentPath);
        console.log('[NativeDrag] Starting drag for:', filePath);
        
        if (!fs.existsSync(filePath)) {
          console.error('[NativeDrag] File not found:', filePath);
          return { success: false, error: 'File not found' };
        }
        
        // Get icon for drag (use thumbnail if available, otherwise generate one)
        let iconPath = null;
        if (item.thumbnailPath) {
          const thumbPath = path.join(this.storage.storageRoot, item.thumbnailPath);
          if (fs.existsSync(thumbPath)) {
            iconPath = thumbPath;
          }
        }
        
        // Start native drag operation
        event.sender.startDrag({
          file: filePath,
          icon: iconPath || undefined
        });
        
        return { success: true, filePath };
      } catch (error) {
        console.error('[NativeDrag] Error:', error);
        return { success: false, error: error.message };
      }
    });
    
    // Float card for dragging items to external apps
    safeHandle('clipboard:float-item', (event, itemId) => {
      try {
        const item = this.storage.loadItem(itemId);
        if (!item) {
          console.error('[FloatCard] Item not found:', itemId);
          return { success: false, error: 'Item not found' };
        }
        
        console.log('[FloatCard] Creating float card for:', itemId);
        
        // Close existing float card if any
        if (this.floatCardWindow && !this.floatCardWindow.isDestroyed()) {
          this.floatCardWindow.close();
        }
        
        // Get mouse position for placement
        const { screen } = require('electron');
        const mousePos = screen.getCursorScreenPoint();
        
        // Create float card window
        this.floatCardWindow = new BrowserWindow({
          width: 100,
          height: 110,
          x: mousePos.x - 50,
          y: mousePos.y - 55,
          transparent: true,
          frame: false,
          alwaysOnTop: true,
          resizable: false,
          minimizable: false,
          maximizable: false,
          hasShadow: true,
          skipTaskbar: true,
          webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js')
          }
        });
        
        this.floatCardWindow.loadFile('float-card.html');
        
        // Send item data when window is ready
        this.floatCardWindow.webContents.on('did-finish-load', () => {
          const itemData = {
            id: itemId,
            type: item.type,
            fileType: item.fileType,
            fileName: item.fileName,
            thumbnail: item.thumbnail,
            preview: item.preview
          };
          this.floatCardWindow.webContents.send('float-card:init', itemData);
        });
        
        // Handle close request from float card - store reference to this for callbacks
        const self = this;
        if (!this._floatCardCloseHandler) {
          this._floatCardCloseHandler = true;
          ipcMain.on('float-card:close', () => {
            console.log('[FloatCard] Close requested');
            if (self.floatCardWindow && !self.floatCardWindow.isDestroyed()) {
              self.floatCardWindow.close();
              self.floatCardWindow = null;
              console.log('[FloatCard] Window closed');
            }
          });
          
          ipcMain.on('float-card:ready', () => {
            console.log('[FloatCard] Window ready');
          });
          
          ipcMain.on('float-card:start-drag', (event, itemId) => {
            // Forward native drag request
            if (self.floatCardWindow && !self.floatCardWindow.isDestroyed()) {
              const item = self.storage.loadItem(itemId);
              if (item && item.contentPath) {
                const filePath = path.join(self.storage.storageRoot, item.contentPath);
                if (fs.existsSync(filePath)) {
                  event.sender.startDrag({
                    file: filePath,
                    icon: item.thumbnailPath ? path.join(self.storage.storageRoot, item.thumbnailPath) : undefined
                  });
                }
              }
            }
          });
        }
        
        // Store reference to this window for later closing
        this.floatCardWindow.on('closed', () => {
          this.floatCardWindow = null;
        });
        
        return { success: true };
      } catch (error) {
        console.error('[FloatCard] Error:', error);
        return { success: false, error: error.message };
      }
    });
    
    safeHandle('clipboard:close-float', () => {
      if (this.floatCardWindow && !this.floatCardWindow.isDestroyed()) {
        this.floatCardWindow.close();
        this.floatCardWindow = null;
      }
      return { success: true };
    });
    
    // Metadata operations
    safeHandle('clipboard:update-metadata', (event, itemId, updates) => {
      try {
        const item = this.storage.loadItem(itemId);
        if (!item) return { success: false };
        
        // Update item's individual metadata file
        const metadataPath = path.join(this.storage.storageRoot, item.metadataPath);
        const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
        
        Object.assign(metadata, updates);
        fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
        
        // Also sync to unified space-metadata.json if item belongs to a space
        if (item.spaceId) {
          try {
            const spaceMetadata = this.storage.getSpaceMetadata(item.spaceId);
            if (spaceMetadata) {
              // Create a file key based on item ID or filename
              const fileKey = item.fileName || `item-${itemId}`;
              spaceMetadata.files[fileKey] = {
                ...spaceMetadata.files[fileKey],
                itemId: itemId,
                type: item.type,
                fileType: item.fileType,
                description: updates.description || metadata.description,
                tags: updates.tags || metadata.tags,
                notes: updates.notes || metadata.notes,
                instructions: updates.instructions || metadata.instructions,
                source: updates.source || metadata.source,
                ai_generated: updates.ai_generated || metadata.ai_generated,
                ai_assisted: updates.ai_assisted || metadata.ai_assisted,
                ai_model: updates.ai_model || metadata.ai_model,
                ai_provider: updates.ai_provider || metadata.ai_provider,
                // Video scenes for agentic player
                scenes: updates.scenes || metadata.scenes || [],
                updatedAt: new Date().toISOString()
              };
              this.storage.updateSpaceMetadata(item.spaceId, { files: spaceMetadata.files });
              console.log('[Clipboard] Synced metadata to space-metadata.json for:', fileKey);
            }
          } catch (syncError) {
            console.error('[Clipboard] Error syncing to space metadata:', syncError);
            // Don't fail the operation if sync fails
          }
        }
        
        return { success: true };
      } catch (error) {
        const logger = getLogger();
        logger.error('Metadata update failed', {
          error: error.message,
          operation: 'updateMetadata'
        });
        return { success: false, error: error.message };
      }
    });
    
    // #region agent log
    console.log('[DEBUG-H3] About to register clipboard:get-metadata handler');
    // #endregion
    safeHandle('clipboard:get-metadata', (event, itemId) => {
      // #region agent log
      console.log('[DEBUG-H4] clipboard:get-metadata handler INVOKED with itemId:', itemId);
      // #endregion
      try {
        const item = this.storage.loadItem(itemId);
        if (!item) return { success: false, error: 'Item not found' };
        
        // Build complete metadata object with all properties
        const metadata = {
          // Existing metadata
          ...(item.metadata || {}),
          // Ensure basic fields exist
          description: item.metadata?.description || '',
          notes: item.metadata?.notes || '',
          instructions: item.metadata?.instructions || '',
          tags: item.metadata?.tags || [],
          source: item.metadata?.source || item.source || '',
          ai_generated: item.metadata?.ai_generated || false,
          ai_assisted: item.metadata?.ai_assisted || false,
          ai_model: item.metadata?.ai_model || '',
          ai_provider: item.metadata?.ai_provider || '',
          ai_prompt: item.metadata?.ai_prompt || '',
          ai_context: item.metadata?.ai_context || '',
          ai_used_vision: item.metadata?.ai_used_vision || false,
          dateCreated: item.timestamp || Date.now(),
          author: os.userInfo().username || 'Unknown',
          version: '1.0.0',
          id: itemId,
          // File-specific metadata
          fileName: item.fileName,
          fileSize: item.fileSize,
          fileType: item.fileType,
          fileCategory: item.fileCategory,
          fileExt: item.fileExt,
          isScreenshot: item.isScreenshot,
          // Type info
          type: item.type,
          preview: item.preview,
          // Video scenes for agentic player
          scenes: item.metadata?.scenes || []
        };
        
        return { success: true, metadata };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    // ==================== VIDEO SCENES FOR AGENTIC PLAYER ====================
    
    // Get scenes for a video item
    safeHandle('clipboard:get-video-scenes', (event, itemId) => {
      try {
        const item = this.storage.loadItem(itemId);
        if (!item) return { success: false, error: 'Item not found' };
        
        // Check if it's a video
        if (item.type !== 'file' || !item.fileType?.startsWith('video/')) {
          return { success: false, error: 'Item is not a video file' };
        }
        
        // Get scenes from metadata
        const metadataPath = path.join(this.storage.storageRoot, item.metadataPath);
        let metadata = {};
        if (fs.existsSync(metadataPath)) {
          metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
        }
        
        return { 
          success: true, 
          scenes: metadata.scenes || [],
          videoUrl: item.content, // Path to the video file
          fileName: item.fileName,
          fileType: item.fileType
        };
      } catch (error) {
        const logger = getLogger();
        logger.error('Get video scenes failed', {
          error: error.message,
          operation: 'getVideoScenes'
        });
        return { success: false, error: error.message };
      }
    });
    
    // Update scenes for a video item
    safeHandle('clipboard:update-video-scenes', (event, itemId, scenes) => {
      try {
        const item = this.storage.loadItem(itemId);
        if (!item) return { success: false, error: 'Item not found' };
        
        // Validate scenes array
        if (!Array.isArray(scenes)) {
          return { success: false, error: 'Scenes must be an array' };
        }
        
        // Validate each scene has required fields
        for (const scene of scenes) {
          if (scene.id === undefined || scene.inTime === undefined || scene.outTime === undefined) {
            return { success: false, error: 'Each scene must have id, inTime, and outTime' };
          }
        }
        
        // Update metadata file
        const metadataPath = path.join(this.storage.storageRoot, item.metadataPath);
        let metadata = {};
        if (fs.existsSync(metadataPath)) {
          metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
        }
        
        metadata.scenes = scenes;
        metadata.scenesUpdatedAt = new Date().toISOString();
        
        fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
        
        // Sync to space metadata if applicable
        if (item.spaceId) {
          try {
            const spaceMetadata = this.storage.getSpaceMetadata(item.spaceId);
            if (spaceMetadata) {
              const fileKey = item.fileName || `item-${itemId}`;
              spaceMetadata.files[fileKey] = {
                ...spaceMetadata.files[fileKey],
                scenes: scenes,
                scenesUpdatedAt: metadata.scenesUpdatedAt
              };
              this.storage.updateSpaceMetadata(item.spaceId, { files: spaceMetadata.files });
              console.log('[Clipboard] Synced video scenes to space-metadata.json:', fileKey);
            }
          } catch (syncError) {
            console.error('[Clipboard] Error syncing scenes to space metadata:', syncError);
          }
        }
        
        console.log(`[Clipboard] Updated ${scenes.length} scenes for video:`, item.fileName);
        return { success: true, scenesCount: scenes.length };
      } catch (error) {
        const logger = getLogger();
        logger.error('Update video scenes failed', {
          error: error.message,
          operation: 'updateVideoScenes'
        });
        return { success: false, error: error.message };
      }
    });
    
    // Add a single scene to a video
    safeHandle('clipboard:add-video-scene', (event, itemId, scene) => {
      try {
        const item = this.storage.loadItem(itemId);
        if (!item) return { success: false, error: 'Item not found' };
        
        // Read existing metadata
        const metadataPath = path.join(this.storage.storageRoot, item.metadataPath);
        let metadata = {};
        if (fs.existsSync(metadataPath)) {
          metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
        }
        
        // Ensure scenes array exists
        if (!metadata.scenes) metadata.scenes = [];
        
        // Generate ID if not provided
        if (scene.id === undefined) {
          scene.id = metadata.scenes.length > 0 
            ? Math.max(...metadata.scenes.map(s => s.id)) + 1 
            : 1;
        }
        
        // Add scene
        metadata.scenes.push(scene);
        metadata.scenesUpdatedAt = new Date().toISOString();
        
        fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
        
        console.log(`[Clipboard] Added scene "${scene.name}" to video:`, item.fileName);
        return { success: true, scene, totalScenes: metadata.scenes.length };
      } catch (error) {
        const logger = getLogger();
        logger.error('Add video scene failed', {
          error: error.message,
          operation: 'addVideoScene'
        });
        return { success: false, error: error.message };
      }
    });
    
    // Delete a scene from a video
    safeHandle('clipboard:delete-video-scene', (event, itemId, sceneId) => {
      try {
        const item = this.storage.loadItem(itemId);
        if (!item) return { success: false, error: 'Item not found' };
        
        const metadataPath = path.join(this.storage.storageRoot, item.metadataPath);
        let metadata = {};
        if (fs.existsSync(metadataPath)) {
          metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
        }
        
        if (!metadata.scenes) return { success: false, error: 'No scenes found' };
        
        const initialLength = metadata.scenes.length;
        metadata.scenes = metadata.scenes.filter(s => s.id !== sceneId);
        
        if (metadata.scenes.length === initialLength) {
          return { success: false, error: 'Scene not found' };
        }
        
        metadata.scenesUpdatedAt = new Date().toISOString();
        fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
        
        console.log(`[Clipboard] Deleted scene ${sceneId} from video:`, item.fileName);
        return { success: true, remainingScenes: metadata.scenes.length };
      } catch (error) {
        const logger = getLogger();
        logger.error('Delete video scene failed', {
          error: error.message,
          operation: 'deleteVideoScene'
        });
        return { success: false, error: error.message };
      }
    });
    
    // Get all videos with scenes (for agentic player)
    safeHandle('clipboard:get-videos-with-scenes', (event, spaceId = null) => {
      try {
        // Filter items to videos
        let items = this.storage.index.items.filter(item => 
          item.type === 'file' && item.fileType?.startsWith('video/')
        );
        
        // Filter by space if specified
        if (spaceId) {
          items = items.filter(item => item.spaceId === spaceId);
        }
        
        // Load scenes for each video
        const videosWithScenes = items.map(item => {
          let scenes = [];
          try {
            const metadataPath = path.join(this.storage.storageRoot, item.metadataPath);
            if (fs.existsSync(metadataPath)) {
              const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
              scenes = metadata.scenes || [];
            }
          } catch (e) {
            console.error('Error loading scenes for video:', item.fileName, e);
          }
          
          return {
            id: item.id,
            fileName: item.fileName,
            fileType: item.fileType,
            spaceId: item.spaceId,
            videoUrl: path.join(this.storage.storageRoot, item.contentPath),
            scenes: scenes,
            sceneCount: scenes.length
          };
        });
        
        return { 
          success: true, 
          videos: videosWithScenes,
          totalVideos: videosWithScenes.length,
          videosWithScenes: videosWithScenes.filter(v => v.sceneCount > 0).length
        };
      } catch (error) {
        console.error('Error getting videos with scenes:', error);
        return { success: false, error: error.message };
      }
    });

    // ==================== END VIDEO SCENES ====================
    
    // Get item content (for preview/edit)
    safeHandle('clipboard:get-item-content', (event, itemId) => {
      try {
        const item = this.storage.loadItem(itemId);
        if (!item) return { success: false, error: 'Item not found' };
        
        // Return the full content
        let content = item.content || '';
        
        // For HTML items, return HTML content
        if (item.type === 'html' || item.metadata?.type === 'generated-document') {
          content = item.html || item.content || '';
        }
        
        // For files, try to read content based on file type
        if (item.type === 'file' && item.content) {
          const textExtensions = ['.txt', '.md', '.log', '.csv', '.json', '.xml', '.yaml', '.yml', 
                                  '.js', '.ts', '.jsx', '.tsx', '.py', '.java', '.cpp', '.c', '.h', 
                                  '.css', '.scss', '.html', '.htm', '.rb', '.go', '.rs', '.php'];
          const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.svg', '.ico',
                                   '.tiff', '.tif', '.heic', '.heif', '.avif', '.jfif', '.apng'];
          
          if (item.fileExt && textExtensions.includes(item.fileExt.toLowerCase())) {
            try {
              // item.content should be the file path for files
              if (fs.existsSync(item.content)) {
                content = fs.readFileSync(item.content, 'utf8');
              }
            } catch (readError) {
              console.error('Error reading file content:', readError);
              content = item.preview || '';
            }
          } else if (item.fileType === 'image-file' || (item.fileExt && imageExtensions.includes(item.fileExt.toLowerCase()))) {
            // For image files, return full-resolution image as data URL
            try {
              const filePath = item.content;
              if (fs.existsSync(filePath)) {
                const buffer = fs.readFileSync(filePath);
                // Detect actual MIME type from magic bytes
                const mimeType = this.detectImageMimeType(buffer);
                content = `data:${mimeType};base64,${buffer.toString('base64')}`;
                console.log('[getItemContent] Loaded full-resolution image:', item.fileName, 'size:', buffer.length);
              }
            } catch (readError) {
              console.error('Error reading image file:', readError);
              content = item.thumbnail || '';
            }
          }
        }
        
        return { 
          success: true, 
          content,
          type: item.type,
          fileType: item.fileType,
          fileExt: item.fileExt
        };
      } catch (error) {
        console.error('Error getting item content:', error);
        return { success: false, error: error.message };
      }
    });
    
    // Update item content (for editing)
    safeHandle('clipboard:update-item-content', (event, itemId, newContent) => {
      try {
        // Get the index entry to find the original content path
        const indexEntry = this.storage.index.items.find(i => i.id === itemId);
        if (!indexEntry) return { success: false, error: 'Item not found in index' };
        
        const item = this.storage.loadItem(itemId);
        if (!item) return { success: false, error: 'Item not found' };
        
        // Helper to check if content is actual HTML
        const looksLikeHtml = (content) => {
          if (!content || typeof content !== 'string') return false;
          const htmlPattern = /<\s*(html|head|body|div|span|p|a|img|table|ul|ol|li|h[1-6]|script|style|link|meta|form|input|button|header|footer|nav|section|article)[^>]*>/i;
          return htmlPattern.test(content);
        };
        
        // Determine where to save - use the ORIGINAL content path
        let contentPath;
        
        if (item.type === 'file' && item.content && fs.existsSync(item.content)) {
          // For files, update the actual file
          const textExtensions = ['.txt', '.md', '.log', '.json', '.xml', '.yaml', '.yml', 
                                  '.js', '.ts', '.jsx', '.tsx', '.py', '.css', '.html', '.htm'];
          if (item.fileExt && textExtensions.includes(item.fileExt.toLowerCase())) {
            contentPath = item.content;
          } else {
            return { success: false, error: 'This file type cannot be edited' };
          }
        } else if (indexEntry.contentPath) {
          // Use the original content path from the index
          contentPath = path.join(this.storage.storageRoot, indexEntry.contentPath);
          
          // If it's a .txt file and content is plain text, convert to .md
          if (contentPath.endsWith('.txt') && !looksLikeHtml(newContent)) {
            const mdPath = contentPath.replace(/\.txt$/, '.md');
            // If we're converting, update the index contentPath
            if (fs.existsSync(contentPath)) {
              // Delete old .txt file after saving to .md
              fs.unlinkSync(contentPath);
            }
            contentPath = mdPath;
            // Update index with new path
            const relativePath = path.relative(this.storage.storageRoot, mdPath);
            indexEntry.contentPath = relativePath;
          }
        } else {
          // Fallback: construct path based on type
          const itemDir = path.join(this.storage.itemsDir, itemId);
          if (item.metadata?.type === 'generated-document' || looksLikeHtml(newContent)) {
            contentPath = path.join(itemDir, 'content.html');
          } else {
            // Use .md for plain text
            contentPath = path.join(itemDir, 'content.md');
          }
        }
        
        // Ensure directory exists
        const dir = path.dirname(contentPath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        
        // Write the content
        fs.writeFileSync(contentPath, newContent, 'utf8');
        console.log(`[Clipboard] Saved content to: ${contentPath}`);
        
        // Update preview in index (strip HTML tags if present)
        const preview = newContent.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').substring(0, 200).trim();
        this.storage.updateItemIndex(itemId, { preview });
        
        // Clear cache to force reload
        this.storage.cache.delete(itemId);
        
        // Update the in-memory history item
        const historyItem = this.history.find(h => h.id === itemId);
        if (historyItem) {
          historyItem.preview = preview;
          historyItem._needsContent = true; // Force reload on next access
        }
        
        // Notify UI of update
        this.notifyHistoryUpdate();
        
        console.log(`[Clipboard] Updated content for item: ${itemId}`);
        return { success: true };
      } catch (error) {
        console.error('Error updating item content:', error);
        return { success: false, error: error.message };
      }
    });
    
    // AI Image editing using OpenAI DALL-E
    safeHandle('clipboard:edit-image-ai', async (event, options) => {
      try {
        const { itemId, imageData, prompt } = options;
        
        // Get settings to check for OpenAI API key
        const { getSettingsManager } = require('./settings-manager');
        const settingsManager = getSettingsManager();
        const openaiKey = settingsManager.get('openaiApiKey');
        const anthropicKey = settingsManager.get('llmApiKey');
        
        if (!imageData) {
          return { success: false, error: 'No image data provided' };
        }
        
        console.log('[AI Image Edit] Processing edit request:', prompt);
        
        // Extract base64 data
        let base64Data = imageData;
        let mediaType = 'image/png';
        
        if (imageData.startsWith('data:')) {
          const matches = imageData.match(/^data:([^;]+);base64,(.+)$/);
          if (matches) {
            mediaType = matches[1];
            base64Data = matches[2];
          }
        }
        
        // Use OpenAI gpt-image-1 for true image editing
        if (openaiKey) {
          console.log('[AI Image Edit] Using OpenAI gpt-image-1 for image editing');
          const https = require('https');
          
          try {
            // Convert base64 to buffer for OpenAI
            const imageBuffer = Buffer.from(base64Data, 'base64');
            
            // Create multipart form data
            const boundary = '----FormBoundary' + Math.random().toString(36).substr(2);
            
            // Build multipart body parts
            const parts = [];
            
            // Add image file
            parts.push(Buffer.from(
              `--${boundary}\r\n` +
              `Content-Disposition: form-data; name="image"; filename="image.png"\r\n` +
              `Content-Type: image/png\r\n\r\n`, 'utf-8'
            ));
            parts.push(imageBuffer);
            parts.push(Buffer.from('\r\n', 'utf-8'));
            
            // Add prompt
            parts.push(Buffer.from(
              `--${boundary}\r\n` +
              `Content-Disposition: form-data; name="prompt"\r\n\r\n` +
              `${prompt}\r\n`, 'utf-8'
            ));
            
            // Add model - gpt-image-1
            parts.push(Buffer.from(
              `--${boundary}\r\n` +
              `Content-Disposition: form-data; name="model"\r\n\r\n` +
              `gpt-image-1\r\n`, 'utf-8'
            ));
            
            // Add closing boundary
            parts.push(Buffer.from(`--${boundary}--\r\n`, 'utf-8'));
            
            const fullBody = Buffer.concat(parts);
            
            console.log('[AI Image Edit] Sending image to gpt-image-1 edits endpoint...');
            
            const response = await new Promise((resolve, reject) => {
              const req = https.request({
                hostname: 'api.openai.com',
                path: '/v1/images/edits',
                method: 'POST',
                headers: {
                  'Content-Type': `multipart/form-data; boundary=${boundary}`,
                  'Content-Length': fullBody.length,
                  'Authorization': `Bearer ${openaiKey}`
                }
              }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                  try {
                    resolve(JSON.parse(data));
                  } catch (e) {
                    reject(new Error('Failed to parse response: ' + data));
                  }
                });
              });
              
              req.on('error', reject);
              req.write(fullBody);
              req.end();
            });
            
            if (response.error) {
              console.error('[AI Image Edit] gpt-image-1 API error:', response.error);
              throw new Error(response.error.message);
            }
            
            if (response.data && response.data[0]) {
              let editedImageData;
              
              if (response.data[0].b64_json) {
                editedImageData = `data:image/png;base64,${response.data[0].b64_json}`;
              } else if (response.data[0].url) {
                // Download the image from URL
                console.log('[AI Image Edit] Downloading edited image from URL...');
                const imageUrl = response.data[0].url;
                const imageResponse = await new Promise((resolve, reject) => {
                  https.get(imageUrl, (res) => {
                    const chunks = [];
                    res.on('data', chunk => chunks.push(chunk));
                    res.on('end', () => resolve(Buffer.concat(chunks)));
                    res.on('error', reject);
                  }).on('error', reject);
                });
                editedImageData = `data:image/png;base64,${imageResponse.toString('base64')}`;
              }
              
              if (editedImageData) {
                console.log('[AI Image Edit] Successfully edited image with gpt-image-1');
                return { 
                  success: true, 
                  editedImage: editedImageData
                };
              }
            }
            
            throw new Error('No image data in response');
            
          } catch (editError) {
            console.error('[AI Image Edit] gpt-image-1 error:', editError.message);
            // Fall through to Claude analysis
          }
        }
        
        // Fallback: Use Claude to analyze and describe the edits
        if (anthropicKey) {
          console.log('[AI Image Edit] Using Claude for image analysis (no OpenAI key or DALL-E failed)');
          
          const ClaudeAPI = require('./claude-api');
          const claudeAPI = new ClaudeAPI();
          
          const requestData = JSON.stringify({
            model: 'claude-sonnet-4-5-20250929',
            max_tokens: 1000,
            messages: [{
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: `I want to edit this image with the following changes: "${prompt}"

Please analyze the image and describe:
1. What you see in the current image
2. What specific changes would be made based on my request
3. How the final result would look

Respond in a helpful, conversational way.`
                },
                {
                  type: 'image',
                  source: {
                    type: 'base64',
                    media_type: mediaType,
                    data: base64Data
                  }
                }
              ]
            }]
          });
          
          const response = await claudeAPI.makeRequest('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-API-Key': anthropicKey,
              'anthropic-version': '2023-06-01'
            }
          }, requestData);
          
          const description = response.content[0].text;
          
          return { 
            success: false, 
            error: `To edit images, please add your OpenAI API key in Settings.\n\nAI Analysis of your request:\n${description}`,
            description: description,
            needsOpenAIKey: true
          };
        }
        
        return { 
          success: false, 
          error: 'No API key configured. Please add your OpenAI API key in Settings to enable image editing.' 
        };
        
      } catch (error) {
        console.error('[AI Image Edit] Error:', error);
        return { success: false, error: error.message };
      }
    });
    
    // Update item image (save edited image)
    safeHandle('clipboard:update-item-image', async (event, itemId, imageData) => {
      try {
        const item = this.storage.loadItem(itemId);
        if (!item) return { success: false, error: 'Item not found' };
        
        // Extract base64 data
        let base64Data = imageData;
        if (imageData.startsWith('data:')) {
          const matches = imageData.match(/^data:[^;]+;base64,(.+)$/);
          if (matches) {
            base64Data = matches[1];
          }
        }
        
        // Determine the content path
        const indexEntry = this.storage.index.items.find(i => i.id === itemId);
        if (!indexEntry) return { success: false, error: 'Item not found in index' };
        
        const contentPath = path.join(this.storage.storageRoot, indexEntry.contentPath);
        
        // Write the image data
        fs.writeFileSync(contentPath, Buffer.from(base64Data, 'base64'));
        
        // Also update thumbnail if it exists
        if (indexEntry.thumbnailPath) {
          const thumbnailPath = path.join(this.storage.storageRoot, indexEntry.thumbnailPath);
          // Generate a smaller thumbnail from the edited image
          // For simplicity, we'll use the same image as thumbnail
          fs.writeFileSync(thumbnailPath, Buffer.from(base64Data, 'base64'));
        }
        
        // Clear cache
        this.storage.cache.delete(itemId);
        
        // Update in-memory item
        const historyItem = this.history.find(h => h.id === itemId);
        if (historyItem) {
          historyItem._needsContent = true;
          historyItem.thumbnail = imageData; // Update thumbnail
        }
        
        // Notify UI
        this.notifyHistoryUpdate();
        
        console.log(`[Clipboard] Updated image for item: ${itemId}`);
        return { success: true };
      } catch (error) {
        console.error('Error updating item image:', error);
        return { success: false, error: error.message };
      }
    });
    
    // Save image as new clipboard item
    safeHandle('clipboard:save-image-as-new', async (event, imageData, options = {}) => {
      try {
        // Extract base64 data
        let base64Data = imageData;
        let mediaType = 'image/png';
        
        if (imageData.startsWith('data:')) {
          const matches = imageData.match(/^data:([^;]+);base64,(.+)$/);
          if (matches) {
            mediaType = matches[1];
            base64Data = matches[2];
          }
        }
        
        // Create image buffer
        const imageBuffer = Buffer.from(base64Data, 'base64');
        
        // Create a new clipboard item
        const newItem = {
          type: 'image',
          timestamp: Date.now(),
          image: imageBuffer,
          preview: options.description || 'AI-edited image',
          metadata: {
            source: 'ai-edit',
            sourceItemId: options.sourceItemId,
            description: options.description || 'AI-edited image'
          }
        };
        
        // Save using the storage system
        const savedItem = await this.storage.saveItem(newItem);
        
        // Add to history
        this.history.unshift({
          ...savedItem,
          thumbnail: imageData
        });
        
        // Notify UI
        this.notifyHistoryUpdate();
        
        console.log(`[Clipboard] Saved new image item: ${savedItem.id}`);
        return { success: true, itemId: savedItem.id };
      } catch (error) {
        console.error('Error saving image as new:', error);
        return { success: false, error: error.message };
      }
    });
    
    // Text-to-Speech using OpenAI TTS HD
    safeHandle('clipboard:generate-speech', async (event, options) => {
      try {
        const { text, voice = 'nova' } = options;
        
        if (!text || text.trim().length === 0) {
          return { success: false, error: 'No text provided' };
        }
        
        // Get OpenAI API key from settings
        const { getSettingsManager } = require('./settings-manager');
        const settingsManager = getSettingsManager();
        const openaiKey = settingsManager.get('openaiApiKey');
        
        if (!openaiKey) {
          return { success: false, error: 'OpenAI API key not configured. Please add it in Settings.' };
        }
        
        console.log(`[TTS] Generating speech with voice: ${voice}, text length: ${text.length}`);
        
        const https = require('https');
        
        // OpenAI TTS has a 4096 character limit - split long texts into chunks
        const MAX_CHUNK_SIZE = 4000; // Leave some margin
        const textChunks = [];
        
        if (text.length <= MAX_CHUNK_SIZE) {
          textChunks.push(text);
        } else {
          // Split at sentence boundaries to avoid cutting words
          let remaining = text;
          while (remaining.length > 0) {
            if (remaining.length <= MAX_CHUNK_SIZE) {
              textChunks.push(remaining);
              break;
            }
            
            // Find a good break point (sentence end) within the limit
            let breakPoint = MAX_CHUNK_SIZE;
            const lastPeriod = remaining.lastIndexOf('. ', MAX_CHUNK_SIZE);
            const lastQuestion = remaining.lastIndexOf('? ', MAX_CHUNK_SIZE);
            const lastExclaim = remaining.lastIndexOf('! ', MAX_CHUNK_SIZE);
            const bestBreak = Math.max(lastPeriod, lastQuestion, lastExclaim);
            
            if (bestBreak > MAX_CHUNK_SIZE * 0.5) {
              breakPoint = bestBreak + 1; // Include the punctuation
            }
            
            textChunks.push(remaining.substring(0, breakPoint).trim());
            remaining = remaining.substring(breakPoint).trim();
          }
          console.log(`[TTS] Split text into ${textChunks.length} chunks`);
        }
        
        // Generate audio for each chunk
        const audioBuffers = [];
        
        for (let i = 0; i < textChunks.length; i++) {
          const chunk = textChunks[i];
          console.log(`[TTS] Generating chunk ${i + 1}/${textChunks.length}, length: ${chunk.length}`);
          
          const requestBody = JSON.stringify({
            model: 'tts-1-hd',
            input: chunk,
            voice: voice,
            response_format: 'mp3'
          });
          
          const chunkAudio = await new Promise((resolve, reject) => {
            const req = https.request({
              hostname: 'api.openai.com',
              path: '/v1/audio/speech',
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${openaiKey}`
              }
            }, (res) => {
              const chunks = [];
              
              res.on('data', chunk => chunks.push(chunk));
              res.on('end', () => {
                if (res.statusCode !== 200) {
                  const errorText = Buffer.concat(chunks).toString();
                  try {
                    const errorJson = JSON.parse(errorText);
                    reject(new Error(errorJson.error?.message || `HTTP ${res.statusCode}`));
                  } catch {
                    reject(new Error(`HTTP ${res.statusCode}: ${errorText}`));
                  }
                  return;
                }
                
                resolve(Buffer.concat(chunks));
              });
            });
            
            req.on('error', reject);
            req.write(requestBody);
            req.end();
          });
          
          audioBuffers.push(chunkAudio);
        }
        
        // Combine all audio buffers
        const combinedBuffer = Buffer.concat(audioBuffers);
        const audioData = combinedBuffer.toString('base64');
        
        console.log(`[TTS] Successfully generated audio, ${textChunks.length} chunks, total size: ${combinedBuffer.length} bytes`);
        
        return { success: true, audioData };
        
      } catch (error) {
        console.error('[TTS] Error generating speech:', error);
        return { success: false, error: error.message };
      }
    });
    
    // Create audio script from article content using GPT
    safeHandle('clipboard:create-audio-script', async (event, options) => {
      try {
        const { title, content } = options;
        
        if (!content || content.trim().length === 0) {
          return { success: false, error: 'No content provided' };
        }
        
        // Get OpenAI API key from settings
        const { getSettingsManager } = require('./settings-manager');
        const settingsManager = getSettingsManager();
        const openaiKey = settingsManager.get('openaiApiKey');
        
        if (!openaiKey) {
          return { success: false, error: 'OpenAI API key not configured. Please add it in Settings.' };
        }
        
        console.log(`[AudioScript] Creating audio script for: ${title}, content length: ${content.length}`);
        
        const https = require('https');
        
        // Call OpenAI Chat Completions API with GPT-4o (gpt-5.1 doesn't exist yet, using gpt-4o)
        const requestBody = JSON.stringify({
          model: 'gpt-4o',
          messages: [
            {
              role: 'system',
              content: `You are an expert audio content producer. Your task is to transform written articles into engaging audio scripts optimized for text-to-speech narration.

Guidelines:
- Maintain ALL key points, insights, and important details from the original article
- Do NOT summarize or condense - the audio version should be comprehensive
- Write in a natural, conversational tone suitable for listening
- Remove visual references like "as shown above" or "see the image below"
- Convert bullet points and lists into flowing prose
- Add natural transitions between sections
- Remove URLs, citations in brackets, and author bylines
- Keep technical terms but explain them briefly if complex
- Start with the article title as an introduction
- Add brief pauses (indicated by "...") between major sections
- End with a brief conclusion or takeaway

Output ONLY the audio script text, nothing else.`
            },
            {
              role: 'user',
              content: `Please create an audio script for this article:

Title: ${title}

Content:
${content}`
            }
          ],
          temperature: 0.7,
          max_tokens: 8000
        });
        
        const scriptText = await new Promise((resolve, reject) => {
          const req = https.request({
            hostname: 'api.openai.com',
            path: '/v1/chat/completions',
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${openaiKey}`
            }
          }, (res) => {
            const chunks = [];
            
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
              const responseText = Buffer.concat(chunks).toString();
              
              if (res.statusCode !== 200) {
                try {
                  const errorJson = JSON.parse(responseText);
                  reject(new Error(errorJson.error?.message || `HTTP ${res.statusCode}`));
                } catch {
                  reject(new Error(`HTTP ${res.statusCode}: ${responseText}`));
                }
                return;
              }
              
              try {
                const response = JSON.parse(responseText);
                const script = response.choices?.[0]?.message?.content;
                if (script) {
                  resolve(script);
                } else {
                  reject(new Error('No script generated'));
                }
              } catch (e) {
                reject(new Error('Failed to parse response'));
              }
            });
          });
          
          req.on('error', reject);
          req.write(requestBody);
          req.end();
        });
        
        console.log(`[AudioScript] Successfully created script, length: ${scriptText.length}`);
        
        return { success: true, script: scriptText };
        
      } catch (error) {
        console.error('[AudioScript] Error creating audio script:', error);
        return { success: false, error: error.message };
      }
    });
    
    // Save TTS audio - attach to source item or create new
    safeHandle('clipboard:save-tts-audio', async (event, options) => {
      try {
        const { audioData, voice, sourceItemId, sourceText, attachToSource } = options;
        
        if (!audioData) {
          return { success: false, error: 'No audio data provided' };
        }
        
        // Create audio buffer
        const audioBuffer = Buffer.from(audioData, 'base64');
        const timestamp = Date.now();
        const filename = `tts-${voice}-${timestamp}.mp3`;
        
        // If attaching to source item
        if (attachToSource && sourceItemId) {
          console.log(`[TTS] Attaching audio to source item: ${sourceItemId}`);
          
          // Find the source item
          const sourceItem = this.history.find(h => h.id === sourceItemId);
          if (sourceItem) {
            // Get the item directory
            const itemDir = path.join(this.storage.itemsDir, sourceItemId);
            console.log(`[TTS] Item directory: ${itemDir}`);
            
            if (!fs.existsSync(itemDir)) {
              console.log(`[TTS] Creating directory: ${itemDir}`);
              fs.mkdirSync(itemDir, { recursive: true });
            }
            
            // Save audio in the item's directory
            const audioPath = path.join(itemDir, 'tts-audio.mp3');
            console.log(`[TTS] Writing ${audioBuffer.length} bytes to: ${audioPath}`);
            fs.writeFileSync(audioPath, audioBuffer);
            
            // Verify file was written
            if (fs.existsSync(audioPath)) {
              const stats = fs.statSync(audioPath);
              console.log(`[TTS] File verified, size: ${stats.size} bytes`);
            } else {
              console.error(`[TTS] ERROR: File was not written!`);
            }
            
            // Update item metadata to include TTS audio reference
            const metadataPath = path.join(itemDir, 'metadata.json');
            let metadata = {};
            if (fs.existsSync(metadataPath)) {
              metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
            }
            
            metadata.ttsAudio = {
              path: 'tts-audio.mp3',
              voice: voice,
              generatedAt: timestamp,
              fileSize: audioBuffer.length
            };
            
            fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
            console.log(`[TTS] Metadata updated with ttsAudio reference`);
            
            // Update the index entry
            this.storage.updateItemIndex(sourceItemId, {
              hasTTSAudio: true,
              ttsVoice: voice
            });
            
            console.log(`[TTS] Successfully attached audio to item ${sourceItemId}`);
            return { success: true, itemId: sourceItemId, attached: true };
          } else {
            console.error(`[TTS] Source item not found in history: ${sourceItemId}`);
          }
        }
        
        // Create as new item (fallback or explicit)
        const preview = sourceText 
          ? `🔊 TTS: "${sourceText.substring(0, 50)}${sourceText.length > 50 ? '...' : ''}"`
          : `🔊 TTS Audio (${voice})`;
        
        const newItem = {
          type: 'file',
          fileType: 'audio',
          fileCategory: 'audio',
          fileExt: '.mp3',
          fileName: filename,
          timestamp: timestamp,
          preview: preview,
          spaceId: this.currentSpace || 'unclassified',
          metadata: {
            source: 'tts-generation',
            voice: voice,
            sourceItemId: sourceItemId,
            sourceText: sourceText,
            generatedAt: timestamp
          }
        };
        
        const itemId = `item-${timestamp}-${Math.random().toString(36).substr(2, 9)}`;
        const audioDir = path.join(this.storage.storageRoot, 'files', itemId);
        
        if (!fs.existsSync(audioDir)) {
          fs.mkdirSync(audioDir, { recursive: true });
        }
        
        const audioPath = path.join(audioDir, filename);
        fs.writeFileSync(audioPath, audioBuffer);
        
        newItem.filePath = audioPath;
        newItem.fileSize = audioBuffer.length;
        
        const indexEntry = this.storage.addItem({
          ...newItem,
          id: itemId
        });
        
        this.history.unshift({
          ...newItem,
          id: indexEntry.id
        });
        
        this.updateSpaceCounts();
        this.notifyHistoryUpdate();
        
        console.log(`[TTS] Saved audio as new item: ${audioPath}`);
        return { success: true, itemId: indexEntry.id, attached: false };
        
      } catch (error) {
        console.error('[TTS] Error saving audio:', error);
        return { success: false, error: error.message };
      }
    });
    
    // Get TTS audio for an item (if attached)
    safeHandle('clipboard:get-tts-audio', async (event, itemId) => {
      try {
        console.log(`[TTS] Getting audio for item: ${itemId}`);
        const itemDir = path.join(this.storage.itemsDir, itemId);
        const audioPath = path.join(itemDir, 'tts-audio.mp3');
        
        console.log(`[TTS] Checking path: ${audioPath}`);
        console.log(`[TTS] File exists: ${fs.existsSync(audioPath)}`);
        
        if (fs.existsSync(audioPath)) {
          const stats = fs.statSync(audioPath);
          console.log(`[TTS] File size: ${stats.size} bytes`);
          
          const audioData = fs.readFileSync(audioPath);
          const base64 = audioData.toString('base64');
          console.log(`[TTS] Base64 length: ${base64.length}`);
          
          // Get voice from metadata
          const metadataPath = path.join(itemDir, 'metadata.json');
          let voice = 'nova';
          if (fs.existsSync(metadataPath)) {
            const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
            voice = metadata.ttsAudio?.voice || 'nova';
          }
          
          return { 
            success: true, 
            audioData: base64,
            voice: voice,
            hasAudio: true
          };
        }
        
        console.log(`[TTS] No audio file found for item: ${itemId}`);
        return { success: true, hasAudio: false };
      } catch (error) {
        console.error('[TTS] Error getting audio:', error);
        return { success: false, error: error.message };
      }
    });
    
    // Extract audio from video file
    safeHandle('clipboard:extract-audio', async (event, itemId) => {
      try {
        console.log('[AudioExtract] Extracting audio for item:', itemId);
        
        // Get item from storage
        const item = this.history.find(h => h.id === itemId);
        if (!item) {
          return { success: false, error: 'Item not found' };
        }
        
        // Get file path
        let videoPath = item.filePath || item.content;
        if (!videoPath) {
          const itemDir = path.join(this.storage.itemsDir, itemId);
          const files = fs.readdirSync(itemDir);
          const videoFile = files.find(f => /\.(mp4|mov|avi|mkv|webm)$/i.test(f));
          if (videoFile) {
            videoPath = path.join(itemDir, videoFile);
          }
        }
        
        if (!videoPath || !fs.existsSync(videoPath)) {
          return { success: false, error: 'Video file not found' };
        }
        
        // Extract audio using ffmpeg
        const ffmpeg = require('fluent-ffmpeg');
        const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
        ffmpeg.setFfmpegPath(ffmpegPath);
        
        const itemDir = path.join(this.storage.itemsDir, itemId);
        const audioFileName = path.basename(videoPath, path.extname(videoPath)) + '.mp3';
        const audioPath = path.join(itemDir, audioFileName);
        
        console.log('[AudioExtract] Starting ffmpeg extraction from:', videoPath);
        console.log('[AudioExtract] Output path:', audioPath);
        
        await new Promise((resolve, reject) => {
          ffmpeg(videoPath)
            .noVideo()
            .audioCodec('libmp3lame')
            .audioBitrate('192k')
            .format('mp3')
            .output(audioPath)
            .on('start', (cmd) => {
              console.log('[AudioExtract] FFmpeg command:', cmd);
              // Send initial progress
              if (event.sender && !event.sender.isDestroyed()) {
                event.sender.send('audio-extract-progress', { itemId, percent: 0, status: 'Starting...' });
              }
            })
            .on('progress', (progress) => {
              const percent = progress.percent ? Math.round(progress.percent) : 0;
              console.log('[AudioExtract] Progress:', percent + '%');
              // Send progress to renderer
              if (event.sender && !event.sender.isDestroyed()) {
                event.sender.send('audio-extract-progress', { itemId, percent, status: `Extracting: ${percent}%` });
              }
            })
            .on('end', () => {
              console.log('[AudioExtract] FFmpeg completed successfully');
              if (event.sender && !event.sender.isDestroyed()) {
                event.sender.send('audio-extract-progress', { itemId, percent: 100, status: 'Complete!' });
              }
              resolve();
            })
            .on('error', (err) => {
              console.error('[AudioExtract] FFmpeg error:', err.message);
              if (event.sender && !event.sender.isDestroyed()) {
                event.sender.send('audio-extract-progress', { itemId, percent: 0, status: 'Error: ' + err.message });
              }
              reject(err);
            })
            .run();
        });
        
        console.log('[AudioExtract] Audio extracted to:', audioPath);
        
        // Update metadata
        const metadataPath = path.join(itemDir, 'metadata.json');
        if (fs.existsSync(metadataPath)) {
          const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
          metadata.audioPath = audioPath;
          metadata.audioFileName = audioFileName;
          fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
        }
        
        return { 
          success: true, 
          audioPath, 
          audioFileName,
          audioSize: fs.statSync(audioPath).size
        };
      } catch (error) {
        console.error('[AudioExtract] Error:', error);
        return { success: false, error: error.message };
      }
    });
    
    // Audio/Video Transcription using unified TranscriptionService (ElevenLabs Scribe)
    safeHandle('clipboard:transcribe-audio', async (event, options) => {
      try {
        const { itemId, language, diarize = true } = options;
        
        // Load the audio item
        const item = this.storage.loadItem(itemId);
        if (!item) {
          return { success: false, error: 'Item not found' };
        }
        
        // Get the audio file path
        let audioPath = item.filePath;
        if (!audioPath || !fs.existsSync(audioPath)) {
          // Try to find it in the item's content path
          const indexEntry = this.storage.index.items.find(i => i.id === itemId);
          if (indexEntry?.contentPath) {
            audioPath = path.join(this.storage.storageRoot, indexEntry.contentPath);
          }
        }
        
        if (!audioPath || !fs.existsSync(audioPath)) {
          return { success: false, error: 'Audio file not found' };
        }
        
        console.log(`[Transcription] Transcribing file: ${audioPath}`);
        
        // Check if it's a video file - need to extract audio first
        const fileExt = path.extname(audioPath).toLowerCase().replace('.', '') || 'mp3';
        const videoFormats = ['mp4', 'mov', 'avi', 'mkv', 'webm', 'flv', 'wmv', 'm4v'];
        const isVideo = videoFormats.includes(fileExt) || 
                       (item.fileType && item.fileType.startsWith('video/')) ||
                       item.fileCategory === 'video';
        
        let transcribePath = audioPath;
        let tempAudioPath = null;
        
        if (isVideo) {
          console.log(`[Transcription] Video file detected, extracting audio...`);
          
          // Extract audio from video using ffmpeg
          try {
            const ffmpeg = require('fluent-ffmpeg');
            const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
            ffmpeg.setFfmpegPath(ffmpegPath);
            
            // Create temp file for extracted audio
            const { app } = require('electron');
            tempAudioPath = path.join(app.getPath('temp'), `transcribe_${Date.now()}.mp3`);
            
            await new Promise((resolve, reject) => {
              ffmpeg(audioPath)
                .noVideo()
                .audioCodec('libmp3lame')
                .audioBitrate('128k')
                .format('mp3')
                .output(tempAudioPath)
                .on('end', resolve)
                .on('error', reject)
                .run();
            });
            
            console.log(`[Transcription] Audio extracted to: ${tempAudioPath}`);
            transcribePath = tempAudioPath;
          } catch (ffmpegError) {
            console.error('[Transcription] FFmpeg error:', ffmpegError);
            return { success: false, error: 'Failed to extract audio from video. Make sure ffmpeg is installed.' };
          }
        }
        
        // Use unified TranscriptionService (ElevenLabs Scribe)
        const { getTranscriptionService } = await import('./src/transcription/index.js');
        const service = getTranscriptionService();
        
        // Check if service is available
        const isAvailable = await service.isAvailable();
        if (!isAvailable) {
          if (tempAudioPath && fs.existsSync(tempAudioPath)) {
            fs.unlinkSync(tempAudioPath);
          }
          return { success: false, error: 'ElevenLabs API key not configured. Please add it in Settings.' };
        }
        
        const result = await service.transcribe(transcribePath, {
          language: language || null,
          diarize  // Enable speaker identification
        });
        
        console.log(`[Transcription] Successfully transcribed: ${result.wordCount} words, ${result.speakerCount} speakers`);
        
        // Cleanup temp file if exists
        if (tempAudioPath && fs.existsSync(tempAudioPath)) {
          fs.unlinkSync(tempAudioPath);
        }
        
        // Return in compatible format
        return { 
          success: result.success, 
          transcription: result.text,
          text: result.text,
          words: result.words,
          speakers: result.speakers,
          speakerCount: result.speakerCount,
          language: result.language,
          source: result.source,
          error: result.error
        };
        
      } catch (error) {
        console.error('[Transcription] Error:', error);
        // Cleanup temp file on error too
        if (typeof tempAudioPath !== 'undefined' && tempAudioPath && fs.existsSync(tempAudioPath)) {
          try { fs.unlinkSync(tempAudioPath); } catch (e) {}
        }
        return { success: false, error: error.message };
      }
    });
    
    // Save transcription - attach to source item or create new
    safeHandle('clipboard:save-transcription', async (event, options) => {
      try {
        const { transcription, sourceItemId, sourceFileName, attachToSource } = options;
        
        if (!transcription) {
          return { success: false, error: 'No transcription provided' };
        }
        
        const timestamp = Date.now();
        
        // If attaching to source item
        if (attachToSource && sourceItemId) {
          const itemDir = path.join(this.storage.itemsDir, sourceItemId);
          
          if (!fs.existsSync(itemDir)) {
            fs.mkdirSync(itemDir, { recursive: true });
          }
          
          // Save transcription as text file
          const transcriptionPath = path.join(itemDir, 'transcription.txt');
          fs.writeFileSync(transcriptionPath, transcription, 'utf8');
          
          // Update metadata
          const metadataPath = path.join(itemDir, 'metadata.json');
          let metadata = {};
          if (fs.existsSync(metadataPath)) {
            metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
          }
          
          metadata.transcription = {
            path: 'transcription.txt',
            transcribedAt: timestamp,
            length: transcription.length
          };
          
          fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
          
          // Update index
          this.storage.updateItemIndex(sourceItemId, {
            hasTranscription: true
          });
          
          console.log(`[Transcription] Attached to item ${sourceItemId}`);
          return { success: true, itemId: sourceItemId, attached: true };
        }
        
        // Create as new item (fallback)
        const preview = `📝 Transcription: "${transcription.substring(0, 50)}${transcription.length > 50 ? '...' : ''}"`;
        
        const newItem = {
          type: 'text',
          content: transcription,
          preview: preview,
          timestamp: timestamp,
          spaceId: this.currentSpace || 'unclassified',
          metadata: {
            source: 'transcription',
            sourceItemId: sourceItemId,
            sourceFileName: sourceFileName,
            transcribedAt: timestamp
          }
        };
        
        const indexEntry = this.storage.addItem(newItem);
        
        this.history.unshift({
          ...newItem,
          id: indexEntry.id
        });
        
        this.updateSpaceCounts();
        this.notifyHistoryUpdate();
        
        console.log(`[Transcription] Saved as new item: ${indexEntry.id}`);
        return { success: true, itemId: indexEntry.id, attached: false };
        
      } catch (error) {
        console.error('[Transcription] Error saving:', error);
        return { success: false, error: error.message };
      }
    });
    
    // Helper: Convert HH:MM:SS to seconds
    const timeToSeconds = (timeStr) => {
      const parts = timeStr.split(':').map(Number);
      if (parts.length === 3) {
        return parts[0] * 3600 + parts[1] * 60 + parts[2];
      } else if (parts.length === 2) {
        return parts[0] * 60 + parts[1];
      }
      return parseFloat(timeStr) || 0;
    };
    
    // Helper: Parse speaker transcription format
    // Format: "Speaker A [00:00:00 - 00:00:05]: text"
    const parseSpeakerTranscription = (content) => {
      const lines = content.split('\n').filter(l => l.trim());
      const segments = [];
      
      // Regex to match: Speaker X [HH:MM:SS - HH:MM:SS]: text
      const regex = /^(Speaker \w+)\s*\[(\d{2}:\d{2}:\d{2})\s*-\s*(\d{2}:\d{2}:\d{2})\]:\s*(.+)$/;
      
      for (const line of lines) {
        const match = line.match(regex);
        if (match) {
          const [, speaker, startTime, endTime, text] = match;
          segments.push({
            speaker: speaker,
            start: timeToSeconds(startTime),
            end: timeToSeconds(endTime),
            text: text.trim()
          });
        }
      }
      
      return segments.length > 0 ? segments : null;
    };

    // Get transcription for an item (if attached)
    safeHandle('clipboard:get-transcription', async (event, itemId) => {
      try {
        const itemDir = path.join(this.storage.itemsDir, itemId);
        const metadataPath = path.join(itemDir, 'metadata.json');
        
        // PRIORITY 1: Check metadata FIRST for Whisper transcription (user-generated, most accurate)
        // This takes priority over YouTube/file transcripts because the user explicitly ran Whisper
        if (fs.existsSync(metadataPath)) {
          const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
          
          // If metadata has Whisper transcription, use it (highest priority)
          if (metadata.transcriptionSource === 'whisper' && metadata.transcriptSegments && metadata.transcriptSegments.length > 0) {
            const transcriptText = typeof metadata.transcript === 'string' 
              ? metadata.transcript 
              : metadata.transcriptSegments.map(s => s.text).join(' ');
            
            console.log('[Transcription] Using Whisper transcription from metadata:', metadata.transcriptSegments.length, 'segments');
            return {
              success: true,
              transcription: transcriptText,
              hasTranscription: true,
              source: 'whisper',
              language: metadata.transcriptLanguage,
              segments: metadata.transcriptSegments
            };
          }
        }

        // PRIORITY 2: Check for transcription-speakers.txt (has timed segments from AssemblyAI)
        const speakersPath = path.join(itemDir, 'transcription-speakers.txt');
        let segments = null;

        if (fs.existsSync(speakersPath)) {
          try {
            const speakersContent = fs.readFileSync(speakersPath, 'utf8');
            // Parse speaker transcription format: "Speaker A [00:00:00 - 00:00:05]: text"
            segments = parseSpeakerTranscription(speakersContent);
            console.log('[Transcription] Parsed', segments?.length || 0, 'segments from speakers file');
          } catch (e) {
            console.warn('[Transcription] Could not parse speakers file:', e.message);
          }
        }

        // PRIORITY 3: Check for plain text transcription files
        const transcriptionFiles = [
          { path: path.join(itemDir, 'transcription.txt'), source: 'whisper' },
          { path: path.join(itemDir, 'transcript.txt'), source: 'transcript' },
        ];

        for (const file of transcriptionFiles) {
          if (fs.existsSync(file.path)) {
            const transcription = fs.readFileSync(file.path, 'utf8');
            return {
              success: true,
              transcription: transcription,
              hasTranscription: true,
              source: file.source,
              segments: segments // Include parsed segments if available
            };
          }
        }

        // PRIORITY 4: Check metadata for YouTube/other transcript segments
        if (fs.existsSync(metadataPath)) {
          const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));

          // Check for transcript segments directly in metadata (YouTube downloads)
          if (metadata.transcriptSegments && metadata.transcriptSegments.length > 0) {
            const transcriptText = typeof metadata.transcript === 'string' 
              ? metadata.transcript 
              : metadata.transcriptSegments.map(s => s.text).join(' ');
            
            const source = metadata.transcriptionSource || 'youtube';
            console.log('[Transcription] Found', metadata.transcriptSegments.length, 'segments in metadata (source:', source + ')');
            return {
              success: true,
              transcription: transcriptText,
              hasTranscription: true,
              source: source,
              language: metadata.transcriptLanguage,
              segments: metadata.transcriptSegments
            };
          }

          // Check for YouTube transcript object format (legacy)
          if (metadata.transcript && typeof metadata.transcript === 'object' && metadata.transcript.text) {
            return {
              success: true,
              transcription: metadata.transcript.text,
              hasTranscription: true,
              source: 'youtube',
              language: metadata.transcript.language,
              isAutoGenerated: metadata.transcript.isAutoGenerated,
              segments: metadata.transcript.segments || segments
            };
          }
          
          // Check for plain string transcript (no segments)
          if (metadata.transcript && typeof metadata.transcript === 'string') {
            return {
              success: true,
              transcription: metadata.transcript,
              hasTranscription: true,
              source: 'metadata',
              segments: segments  // May be null if no speakers file
            };
          }
        }

        return { success: true, hasTranscription: false };
      } catch (error) {
        console.error('[Transcription] Error getting:', error);
        return { success: false, error: error.message };
      }
    });
    
    // AI Summary Generation - create a summary from transcript
    safeHandle('clipboard:generate-summary', async (event, options) => {
      console.log('[AISummary] ====== Handler called ======');
      try {
        const { itemId, transcript, title } = options;
        console.log('[AISummary] Starting summary generation for item:', itemId);
        console.log('[AISummary] Transcript length:', transcript?.length || 0);
        
        if (!transcript || transcript.length < 100) {
          return { success: false, error: 'Transcript is too short to summarize' };
        }
        
        // Get API key from settings
        const { getSettingsManager } = require('./settings-manager');
        const settingsManager = getSettingsManager();
        const apiKey = settingsManager.get('llmApiKey');
        
        if (!apiKey) {
          return { success: false, error: 'No LLM API key configured. Please set your API key in Settings.' };
        }
        
        // Truncate transcript if too long (use first 30000 chars for summary)
        const truncatedTranscript = transcript.length > 30000 
          ? transcript.substring(0, 30000) + '\n\n[Transcript truncated...]'
          : transcript;
        
        // Detect API type
        const isAnthropicKey = apiKey.startsWith('sk-ant-');
        
        console.log('[AISummary] Using API:', isAnthropicKey ? 'Claude' : 'OpenAI');
        
        let summary = '';
        
        if (isAnthropicKey) {
          // Use Claude API
          const https = require('https');
          
          const requestBody = JSON.stringify({
            model: 'claude-sonnet-4-5-20250929',
            max_tokens: 2000,
            messages: [{
              role: 'user',
              content: `You are a skilled content summarizer. Given the following transcript${title ? ` from "${title}"` : ''}, write a comprehensive but concise summary.

Create a structured summary with this format:

OVERVIEW: One paragraph explaining what this content is about and why it matters.

KEY POINTS:
• Point 1 - explanation
• Point 2 - explanation
• Point 3 - explanation
• Point 4 - explanation
• Point 5 - explanation
(Include 5-8 substantive key points)

MAIN TAKEAWAYS: One paragraph summarizing the most important insights or conclusions.

IMPORTANT RULES:
1. Focus ONLY on actual content - ignore sponsor messages, ads, and promotional content
2. Extract substantive arguments and insights, not surface-level observations
3. Be specific and concrete - someone reading should understand the key ideas
4. Use bullet points (•) for KEY POINTS only, no other formatting

TRANSCRIPT:
${truncatedTranscript}

Write the structured summary now:`
            }]
          });
          
          const response = await new Promise((resolve, reject) => {
            const req = https.request({
              hostname: 'api.anthropic.com',
              path: '/v1/messages',
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01'
              }
            }, (res) => {
              let data = '';
              res.on('data', chunk => data += chunk);
              res.on('end', () => {
                try {
                  resolve({ statusCode: res.statusCode, body: JSON.parse(data) });
                } catch (e) {
                  reject(new Error('Invalid JSON response'));
                }
              });
            });
            req.on('error', reject);
            req.write(requestBody);
            req.end();
          });
          
          if (response.statusCode !== 200) {
            throw new Error(`Claude API error: ${response.statusCode} - ${JSON.stringify(response.body)}`);
          }
          
          summary = response.body.content?.[0]?.text || '';
          
        } else {
          // Use OpenAI API
          const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
              model: 'gpt-4o-mini',
              messages: [{
                role: 'user',
                content: `You are a skilled content summarizer. Given the following transcript${title ? ` from "${title}"` : ''}, write a comprehensive but concise summary.

Create a structured summary with this format:

OVERVIEW: One paragraph explaining what this content is about and why it matters.

KEY POINTS:
• Point 1 - explanation
• Point 2 - explanation
• Point 3 - explanation
• Point 4 - explanation
• Point 5 - explanation
(Include 5-8 substantive key points)

MAIN TAKEAWAYS: One paragraph summarizing the most important insights or conclusions.

IMPORTANT RULES:
1. Focus ONLY on actual content - ignore sponsor messages, ads, and promotional content
2. Extract substantive arguments and insights, not surface-level observations
3. Be specific and concrete - someone reading should understand the key ideas
4. Use bullet points (•) for KEY POINTS only, no other formatting

TRANSCRIPT:
${truncatedTranscript}

Write the structured summary now:`
              }],
              max_tokens: 2000
            })
          });
          
          if (!response.ok) {
            const errorBody = await response.text();
            throw new Error(`OpenAI API error: ${response.status} - ${errorBody}`);
          }
          
          const result = await response.json();
          summary = result.choices?.[0]?.message?.content || '';
        }
        
        if (!summary) {
          return { success: false, error: 'Failed to generate summary' };
        }
        
        console.log('[AISummary] Generated summary length:', summary.length);
        
        // Save to metadata
        const itemDir = path.join(this.storage.itemsDir, itemId);
        const metadataPath = path.join(itemDir, 'metadata.json');
        if (fs.existsSync(metadataPath)) {
          const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
          metadata.aiSummary = summary;
          metadata.aiSummaryGeneratedAt = new Date().toISOString();
          fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
          
          // Update in-memory item
          const historyItem = this.history.find(h => h.id === itemId);
          if (historyItem && historyItem.metadata) {
            historyItem.metadata.aiSummary = summary;
            historyItem.metadata.aiSummaryGeneratedAt = metadata.aiSummaryGeneratedAt;
          }
        }
        
        return { success: true, summary };
        
      } catch (error) {
        console.error('[AISummary] Error:', error);
        return { success: false, error: error.message };
      }
    });
    
    // AI Speaker Identification - analyze transcript and assign speakers
    safeHandle('clipboard:identify-speakers', async (event, options) => {
      console.log('[SpeakerID] ====== Handler called ======');
      try {
        const { itemId, transcript, contextHint } = options;
        console.log('[SpeakerID] Starting speaker identification for item:', itemId);
        console.log('[SpeakerID] Transcript length:', transcript?.length || 0);
        
        // Get API key from settings
        const { getSettingsManager } = require('./settings-manager');
        const settingsManager = getSettingsManager();
        
        // Get API keys - try multiple field names
        const llmApiKey = settingsManager.get('llmApiKey') || '';
        const claudeApiKey = settingsManager.get('claudeApiKey') || '';
        const openaiApiKey = settingsManager.get('openaiApiKey') || '';
        
        console.log('[SpeakerID] Raw keys - llmApiKey:', !!llmApiKey, 'claudeApiKey:', !!claudeApiKey, 'openaiApiKey:', !!openaiApiKey);
        
        // Auto-detect key type by prefix (more reliable than provider setting)
        let claudeKey = null;
        let openaiKey = null;
        
        // Check llmApiKey first
        if (llmApiKey.startsWith('sk-ant-')) {
          claudeKey = llmApiKey;
        } else if (llmApiKey.startsWith('sk-')) {
          openaiKey = llmApiKey;
        }
        
        // Check dedicated claudeApiKey field
        if (!claudeKey && claudeApiKey && claudeApiKey.startsWith('sk-ant-')) {
          claudeKey = claudeApiKey;
        }
        
        // Also check dedicated openaiApiKey field
        if (!openaiKey && openaiApiKey && openaiApiKey.startsWith('sk-')) {
          openaiKey = openaiApiKey;
        }
        
        console.log('[SpeakerID] Key detection - Claude:', !!claudeKey, 'OpenAI:', !!openaiKey);
        if (claudeKey) console.log('[SpeakerID] Claude key prefix:', claudeKey.substring(0, 15) + '...');
        
        if (!claudeKey && !openaiKey) {
          return { success: false, error: 'No AI API key configured. Please add a Claude or OpenAI API key in Settings.' };
        }
        
        // Get model from settings (defaults to Claude Sonnet 4.5 or GPT-4o)
        const llmModel = settingsManager.get('llmModel') || (claudeKey ? 'claude-sonnet-4-5-20250929' : 'gpt-4o');
        console.log('[SpeakerID] Using model:', llmModel);
        
        // Try to get timecoded segments from metadata for better analysis
        let formattedTranscript = transcript;
        if (itemId) {
          try {
            const itemDir = path.join(this.storage.itemsDir, itemId);
            const metadataPath = path.join(itemDir, 'metadata.json');
            if (fs.existsSync(metadataPath)) {
              const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
              if (metadata.transcript?.segments?.length > 0) {
                // Format with timecodes for better speaker detection
                formattedTranscript = metadata.transcript.segments.map(seg => 
                  `[${seg.startFormatted || formatTime(seg.start)}] ${seg.text}`
                ).join('\n');
                console.log('[SpeakerID] Using timecoded segments:', metadata.transcript.segments.length, 'segments');
              }
            }
          } catch (e) {
            console.log('[SpeakerID] Could not load segments, using plain transcript');
          }
        }
        
        // Truncate transcript if too long (keep first 100k chars for context)
        const maxChars = 100000;
        const truncatedTranscript = formattedTranscript.length > maxChars 
          ? formattedTranscript.substring(0, maxChars) + '\n\n[... transcript truncated for processing ...]'
          : formattedTranscript;
        
        // Helper function to format seconds to timecode
        function formatTime(seconds) {
          const h = Math.floor(seconds / 3600);
          const m = Math.floor((seconds % 3600) / 60);
          const s = Math.floor(seconds % 60);
          const ms = Math.floor((seconds % 1) * 1000);
          return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}.${ms.toString().padStart(3, '0')}`;
        }
        
        const systemPrompt = `You are an expert at analyzing conversation transcripts and identifying different speakers.

Your task is to take a transcript (which may include timecodes) and add speaker labels to identify who is speaking.

IMPORTANT: You will receive CONTEXT INFORMATION about the video/audio that should help you identify the speakers by name. USE THIS CONTEXT to figure out:
- Who the host/interviewer is (often the channel owner/uploader)
- Who the guest(s) are (often mentioned in the title or description)
- The format of the conversation (interview, podcast, lecture, etc.)

Guidelines:
1. FIRST, analyze the context (title, description, uploader) to identify speaker names
2. The transcript may have timecodes in format [HH:MM:SS.mmm] - PRESERVE these
3. Use speaker patterns to assign dialogue:
   - Interviewers ask questions, guests give long answers
   - Hosts often introduce topics and guests
   - The channel owner is usually the host/interviewer
4. Look for first-person references that reveal identity:
   - "At my company SSI..." = the person who founded SSI
   - "When I interviewed..." = the interviewer
   - "My research shows..." = likely the expert guest
5. USE ACTUAL NAMES when you can identify them from context
6. Format as:

   **[Actual Name]:**
   [00:00:00.000] Their dialogue...
   
   **[Other Name]:**
   [00:00:10.000] Their response...

7. Group consecutive lines from the same speaker
8. Only use "Speaker 1/2" if names cannot be determined from context
9. Preserve ALL original text exactly - only add speaker labels`;

        const userPrompt = `Please analyze this transcript and identify the speakers by name.

${contextHint ? `=== VIDEO/AUDIO CONTEXT ===
${contextHint}
=== END CONTEXT ===

Use the above context to identify the actual names of the speakers. The channel/uploader is typically the host/interviewer.

` : ''}=== TRANSCRIPT TO ANALYZE ===
${truncatedTranscript}`;

        let result;
        
        // Process in chunks if transcript is very large (>10K chars)
        // Smaller chunks = faster API responses and incremental results
        const chunkSize = 10000;
        const needsChunking = truncatedTranscript.length > chunkSize;
        
        console.log('[SpeakerID] Transcript length:', truncatedTranscript.length, 'needsChunking:', needsChunking);
        
        async function callClaude(prompt, systemMsg) {
          console.log('[SpeakerID] Calling Claude API, prompt length:', prompt.length);
          console.log('[SpeakerID] Using model:', llmModel);
          console.log('[SpeakerID] Using key:', claudeKey ? claudeKey.substring(0, 15) + '...' : 'NONE');
          
          // Use Node's https module for more reliable requests in Electron
          const https = require('https');
          
          return new Promise((resolve, reject) => {
            const requestBody = JSON.stringify({
              model: llmModel,
              max_tokens: 8000,
              system: systemMsg,
              messages: [{ role: 'user', content: prompt }]
            });
            
            const options = {
              hostname: 'api.anthropic.com',
              port: 443,
              path: '/v1/messages',
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(requestBody),
                'x-api-key': claudeKey,
                'anthropic-version': '2023-06-01'
              },
              timeout: 120000
            };
            
            console.log('[SpeakerID] Sending https request...');
            
            const req = https.request(options, (res) => {
              console.log('[SpeakerID] ✅ Response received! Status:', res.statusCode);
              let data = '';
              let totalReceived = 0;
              
              res.on('data', (chunk) => {
                totalReceived += chunk.length;
                console.log('[SpeakerID] 📦 Received chunk, size:', chunk.length, 'Total so far:', totalReceived);
                data += chunk;
              });
              
              res.on('end', () => {
                console.log('[SpeakerID] Response complete, data length:', data.length);
                
                if (res.statusCode !== 200) {
                  console.error('[SpeakerID] ====== API ERROR ======');
                  console.error('[SpeakerID] Status:', res.statusCode);
                  console.error('[SpeakerID] Response:', data);
                  
                  // Try to parse error from response
                  let errorMsg = `Claude API returned status ${res.statusCode}`;
                  try {
                    const errorData = JSON.parse(data);
                    if (errorData.error?.message) {
                      errorMsg = errorData.error.message;
                    }
                  } catch (e) {
                    // Couldn't parse error, use raw data
                    errorMsg += `: ${data.substring(0, 200)}`;
                  }
                  
                  reject(new Error(errorMsg));
                  return;
                }
                
                try {
                  const parsed = JSON.parse(data);
                  const text = parsed.content?.[0]?.text || '';
                  console.log('[SpeakerID] ✅ Successfully parsed response, text length:', text.length);
                  resolve(text);
                } catch (e) {
                  console.error('[SpeakerID] Failed to parse response:', e.message);
                  reject(new Error('Failed to parse Claude response: ' + e.message));
                }
              });
            });
            
            req.on('error', (e) => {
              console.error('[SpeakerID] ====== REQUEST ERROR ======');
              console.error('[SpeakerID] Error:', e.message);
              console.error('[SpeakerID] Error code:', e.code);
              console.error('[SpeakerID] Stack:', e.stack);
              reject(new Error(`Network error: ${e.message} (${e.code || 'Unknown'})`));
            });
            
            req.on('timeout', () => {
              console.error('[SpeakerID] ====== REQUEST TIMEOUT ======');
              console.error('[SpeakerID] Request timed out after 2 minutes!');
              req.destroy();
              reject(new Error('Request timed out after 2 minutes. The transcript may be too long or Claude API is slow.'));
            });
            
            console.log('[SpeakerID] Writing request body, size:', Buffer.byteLength(requestBody));
            req.write(requestBody);
            console.log('[SpeakerID] Ending request...');
            req.end();
            console.log('[SpeakerID] Request sent, waiting for response...');
          });
        }
        
        async function callOpenAI(prompt, systemMsg) {
          console.log('[SpeakerID] Calling OpenAI API, prompt length:', prompt.length);
          console.log('[SpeakerID] Using model:', llmModel);
          
          const https = require('https');
          
          return new Promise((resolve, reject) => {
            const requestBody = JSON.stringify({
              model: llmModel,
              messages: [
                { role: 'system', content: systemMsg },
                { role: 'user', content: prompt }
              ],
              max_tokens: 8000
            });
            
            const options = {
              hostname: 'api.openai.com',
              port: 443,
              path: '/v1/chat/completions',
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(requestBody),
                'Authorization': `Bearer ${openaiKey}`
              },
              timeout: 120000
            };
            
            const req = https.request(options, (res) => {
              console.log('[SpeakerID] OpenAI response status:', res.statusCode);
              let data = '';
              
              res.on('data', (chunk) => {
                data += chunk;
              });
              
              res.on('end', () => {
                if (res.statusCode !== 200) {
                  reject(new Error(`OpenAI API error: ${res.statusCode} - ${data.substring(0, 500)}`));
                  return;
                }
                
                try {
                  const parsed = JSON.parse(data);
                  resolve(parsed.choices[0].message.content);
                } catch (e) {
                  reject(new Error('Failed to parse OpenAI response: ' + e.message));
                }
              });
            });
            
            req.on('error', (e) => reject(e));
            req.on('timeout', () => {
              req.destroy();
              reject(new Error('Request timed out after 2 minutes'));
            });
            
            req.write(requestBody);
            req.end();
          });
        }
        
        const callAI = claudeKey ? callClaude : callOpenAI;
        
        // Helper to send progress to renderer
        const sendProgress = (status, chunk = null, total = null, partialResult = null) => {
          if (event.sender && !event.sender.isDestroyed()) {
            event.sender.send('speaker-id:progress', { status, chunk, total, partialResult });
          }
        };
        
        if (needsChunking) {
          // Split transcript into chunks by character count (simpler and more reliable)
          const chunks = [];
          for (let i = 0; i < truncatedTranscript.length; i += chunkSize) {
            chunks.push(truncatedTranscript.substring(i, i + chunkSize));
          }
          
          console.log('[SpeakerID] Processing', chunks.length, 'chunks');
          sendProgress(`Starting analysis: ${chunks.length} chunks to process...`, 0, chunks.length);
          
          // Process each chunk
          const processedChunks = [];
          let speakerContext = '';
          
          for (let i = 0; i < chunks.length; i++) {
            console.log('[SpeakerID] Processing chunk', i + 1, 'of', chunks.length);
            sendProgress(`Processing chunk ${i + 1} of ${chunks.length}...`, i + 1, chunks.length);
            
            // Include context in first chunk, speaker names in subsequent chunks
            let chunkPrompt;
            if (i === 0 && contextHint) {
              chunkPrompt = `=== VIDEO/AUDIO CONTEXT ===
${contextHint}
=== END CONTEXT ===

Use the above context to identify speakers by their actual names.

This is part ${i + 1} of ${chunks.length} of the transcript.

=== TRANSCRIPT CHUNK ===
${chunks[i]}`;
            } else {
              chunkPrompt = `${speakerContext ? `Speakers identified so far: ${speakerContext}\n\n` : ''}This is part ${i + 1} of ${chunks.length} of the transcript. Continue using the same speaker names consistently.\n\n=== TRANSCRIPT CHUNK ===\n${chunks[i]}`;
            }
            
            const chunkResult = await callAI(chunkPrompt, systemPrompt);
            processedChunks.push(chunkResult);
            
            // Extract speaker names for context in next chunk
            const speakerMatches = chunkResult.match(/\*\*\[([^\]]+)\]\*\*/g) || [];
            const uniqueSpeakers = [...new Set(speakerMatches.map(m => m.replace(/\*\*\[|\]\*\*/g, '')))];
            speakerContext = uniqueSpeakers.join(', ');
            
            // Send partial results to frontend
            const partialResult = processedChunks.join('\n\n---\n\n');
            sendProgress(
              `Chunk ${i + 1}/${chunks.length} complete. Speakers found: ${uniqueSpeakers.join(', ') || 'analyzing...'}`,
              i + 1,
              chunks.length,
              partialResult
            );
          }
          
          result = processedChunks.join('\n\n---\n\n');
          sendProgress('Analysis complete!', chunks.length, chunks.length);
        } else {
          // Process in one go
          console.log('[SpeakerID] Processing in single request');
          result = await callAI(userPrompt, systemPrompt);
        }
        
        console.log('[SpeakerID] Successfully identified speakers, result length:', result.length);
        
        // Save the speaker-identified transcript
        if (itemId) {
          const itemDir = path.join(this.storage.itemsDir, itemId);
          const speakerTranscriptPath = path.join(itemDir, 'transcription-speakers.txt');
          fs.writeFileSync(speakerTranscriptPath, result, 'utf8');
          console.log('[SpeakerID] Saved speaker transcript to:', speakerTranscriptPath);
          
          // Update metadata - replace transcript with speaker-identified version
          const metadataPath = path.join(itemDir, 'metadata.json');
          if (fs.existsSync(metadataPath)) {
            const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
            
            // Backup original transcript if not already backed up
            if (!metadata.originalTranscript && metadata.transcript) {
              metadata.originalTranscript = metadata.transcript;
            }
            
            // Replace transcript with speaker-identified version
            metadata.transcript = result;
            metadata.speakersIdentified = true;
            metadata.speakersIdentifiedAt = new Date().toISOString();
            metadata.speakersIdentifiedModel = llmModel;
            
            fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
            console.log('[SpeakerID] Updated metadata.transcript with speaker-identified version');
            
            // Also update in-memory history item
            const historyItem = this.history.find(h => h.id === itemId);
            if (historyItem && historyItem.metadata) {
              if (!historyItem.metadata.originalTranscript) {
                historyItem.metadata.originalTranscript = historyItem.metadata.transcript;
              }
              historyItem.metadata.transcript = result;
              historyItem.metadata.speakersIdentified = true;
              historyItem.metadata.speakersIdentifiedAt = metadata.speakersIdentifiedAt;
              historyItem.metadata.speakersIdentifiedModel = llmModel;
            }
          }
        }
        
        return { 
          success: true, 
          transcript: result,
          model: llmModel
        };
      } catch (error) {
        console.error('[SpeakerID] ====== ERROR ======');
        console.error('[SpeakerID] Error message:', error.message);
        console.error('[SpeakerID] Error stack:', error.stack);
        return { 
          success: false, 
          error: error.message || 'Unknown error occurred during speaker identification'
        };
      }
    });
    
    // Advanced search
    safeHandle('clipboard:search-by-tags', (event, tags) => {
      const results = this.history.filter(item => {
        if (item._needsContent) {
          const fullItem = this.storage.loadItem(item.id);
          return fullItem.metadata?.tags?.some(tag => tags.includes(tag));
        }
        return false;
      });
      return results;
    });
    
    safeHandle('clipboard:search-ai-content', (event, options = {}) => {
      const results = this.history.filter(item => {
        if (item._needsContent) {
          const fullItem = this.storage.loadItem(item.id);
          const metadata = fullItem.metadata || {};
          
          if (options.aiGenerated && !metadata.ai_generated) return false;
          if (options.aiAssisted && !metadata.ai_assisted) return false;
          if (options.provider && metadata.ai_provider !== options.provider) return false;
          if (options.model && !metadata.ai_model?.includes(options.model)) return false;
          
          return metadata.ai_generated || metadata.ai_assisted;
        }
        return false;
      });
      return results;
    });
    
    // Utility operations
    safeHandle('clipboard:diagnose', () => {
      return {
        historyCount: this.history.length,
        spacesCount: this.spaces.length,
        storageVersion: 'v2',
        indexPath: this.storage.indexPath,
        cacheSize: this.storage.cache.size
      };
    });
    
    safeHandle('clipboard:force-resume', () => {
      // Not needed in V2
      return { success: true };
    });
    
    safeHandle('clipboard:manual-check', () => {
      // Not needed in V2
      return { success: true };
    });
    
    safeHandle('clipboard:show-item-in-finder', async (event, itemId) => {
      return this.showItemInFinder(itemId);
    });
    
    // Get video file path from item ID (with optional scenes from metadata)
    safeHandle('clipboard:get-video-path', async (event, itemId) => {
      try {
        console.log('[ClipboardManager] Getting video path for item:', itemId);
        
        // First check the index entry's contentPath (most reliable)
        const indexEntry = this.storage.index.items.find(i => i.id === itemId);
        console.log('[ClipboardManager] Index entry:', indexEntry ? { contentPath: indexEntry.contentPath, fileName: indexEntry.fileName } : 'null');
        
        // Helper to load scenes from metadata
        const loadScenes = (itemId) => {
          try {
            const metadataPath = path.join(this.storage.itemsDir, itemId, 'metadata.json');
            if (fs.existsSync(metadataPath)) {
              const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
              return metadata.scenes || [];
            }
          } catch (e) {
            console.error('[ClipboardManager] Error loading scenes:', e);
          }
          return [];
        };
        
        if (indexEntry?.contentPath) {
          const contentPath = path.join(this.storage.storageRoot, indexEntry.contentPath);
          console.log('[ClipboardManager] Checking contentPath:', contentPath);
          if (fs.existsSync(contentPath)) {
            console.log('[ClipboardManager] Found video at contentPath:', contentPath);
            const scenes = loadScenes(itemId);
            return { 
              success: true, 
              filePath: contentPath, 
              fileName: indexEntry.fileName,
              scenes: scenes
            };
          } else {
            console.log('[ClipboardManager] contentPath file does not exist');
          }
        }
        
        // Try to get from item directly
        const item = this.history.find(h => h.id === itemId);
        if (item?.filePath && fs.existsSync(item.filePath)) {
          console.log('[ClipboardManager] Found filePath on item:', item.filePath);
          const scenes = loadScenes(itemId);
          return { 
            success: true, 
            filePath: item.filePath, 
            fileName: item.fileName || path.basename(item.filePath),
            scenes: scenes
          };
        }
        
        // Try loading full item from storage
        const fullItem = this.storage.loadItem(itemId);
        if (fullItem?.filePath && fs.existsSync(fullItem.filePath)) {
          console.log('[ClipboardManager] Found filePath in full item:', fullItem.filePath);
          const scenes = loadScenes(itemId);
          return { 
            success: true, 
            filePath: fullItem.filePath,
            fileName: fullItem.fileName || path.basename(fullItem.filePath),
            scenes: scenes
          };
        }
        
        // Check the item directory for media files
        const itemDir = path.join(this.storage.itemsDir, itemId);
        console.log('[ClipboardManager] Checking item dir:', itemDir);
        if (fs.existsSync(itemDir)) {
          const files = fs.readdirSync(itemDir);
          console.log('[ClipboardManager] Files in item dir:', files);
          const videoExtensions = ['.mp4', '.avi', '.mov', '.wmv', '.flv', '.mkv', '.webm', '.m4v', '.mpg', '.mpeg'];
          const videoFile = files.find(f => videoExtensions.some(ext => f.toLowerCase().endsWith(ext)));
          if (videoFile) {
            const videoPath = path.join(itemDir, videoFile);
            console.log('[ClipboardManager] Found video file in item dir:', videoPath);
            const scenes = loadScenes(itemId);
            return { 
              success: true, 
              filePath: videoPath,
              fileName: videoFile,
              scenes: scenes
            };
          }
        }
        
        // File not found - provide helpful error
        const expectedPath = indexEntry?.contentPath 
          ? path.join(this.storage.storageRoot, indexEntry.contentPath)
          : 'unknown';
        console.error('[ClipboardManager] Video file not found. Expected at:', expectedPath);
        return { 
          success: false, 
          error: `Video file is missing from storage. The file may have been deleted or moved. Expected: ${indexEntry?.fileName || 'unknown'}`
        };
      } catch (error) {
        console.error('[ClipboardManager] Error getting video path:', error);
        return { success: false, error: error.message };
      }
    });
    
    // Open video in Video Editor
    safeHandle('clipboard:open-video-editor', async (event, filePath) => {
      try {
        const { BrowserWindow } = require('electron');
        const path = require('path');
        
        console.log('[ClipboardManager] Opening Video Editor with file:', filePath);
        
        if (!filePath || !fs.existsSync(filePath)) {
          console.error('[ClipboardManager] Video file not found:', filePath);
          return { success: false, error: 'Video file not found: ' + filePath };
        }
        
        const videoEditorWindow = new BrowserWindow({
          width: 1400,
          height: 900,
          title: 'Video Editor',
          webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            devTools: true,
            preload: path.join(__dirname, 'preload-video-editor.js')
          }
        });
        
        // Load the video editor HTML
        videoEditorWindow.loadFile('video-editor.html');

        // Enable dev tools keyboard shortcut (Cmd+Option+I / Ctrl+Shift+I)
        videoEditorWindow.webContents.on('before-input-event', (event, input) => {
          if ((input.meta && input.alt && input.key === 'i') || 
              (input.control && input.shift && input.key === 'I')) {
            videoEditorWindow.webContents.toggleDevTools();
          }
        });
        
        // Once loaded, send the file path to open
        videoEditorWindow.webContents.on('did-finish-load', () => {
          console.log('[ClipboardManager] Video Editor loaded, sending file path:', filePath);
          videoEditorWindow.webContents.send('video-editor:load-file', filePath);
        });
        
        // Setup video editor IPC for this window
        if (global.videoEditor) {
          global.videoEditor.setupIPC(videoEditorWindow);
        }
        
        return { success: true };
      } catch (error) {
        console.error('[ClipboardManager] Error opening Video Editor:', error);
        return { success: false, error: error.message };
      }
    });
    
    safeHandle('clipboard:get-current-user', () => {
      return os.userInfo().username || 'Unknown';
    });
    
    // AI metadata generation
    safeHandle('clipboard:generate-metadata-ai', async (event, { itemId, apiKey, customPrompt }) => {
      // Use the NEW specialized metadata generator
      const MetadataGenerator = require('./metadata-generator');
      const metadataGen = new MetadataGenerator(this);
      
      const result = await metadataGen.generateMetadataForItem(itemId, apiKey, customPrompt);

      if (result.success) {
        // Get the updated item to return full metadata
        const item = this.storage.loadItem(itemId);
          return {
            success: true,
          metadata: item.metadata,
            message: 'Metadata generated successfully'
          };
        } else {
        return result;
      }
    });
    
    // Handle capture methods for external AI windows
    safeHandle('clipboard:capture-text', async (event, text) => {
      console.log('[V2] Capturing text from external window:', text.substring(0, 100) + '...');
      
      const item = {
        type: 'text',
        content: text,
        preview: this.truncateText(text, 100),
        timestamp: Date.now(),
        pinned: false,
        spaceId: this.currentSpace || null
      };
      
      await this.addToHistory(item);
      
      return { success: true };
    });
    
    safeHandle('clipboard:capture-html', async (event, html) => {
      console.log('[V2] Capturing HTML from external window');
      
      const plainText = this.stripHtml(html);
      
      const item = {
        type: 'html',
        content: html,
        plainText: plainText,
        preview: this.truncateText(plainText, 100),
        timestamp: Date.now(),
        pinned: false,
        spaceId: this.currentSpace || null
      };
      
      await this.addToHistory(item);
      
      return { success: true };
    });
    
    // Get audio/video file - returns file path for videos, base64 for audio
    safeHandle('clipboard:get-audio-data', (event, itemId) => {
      console.log('[Media] get-audio-data called for:', itemId);
      
      const item = this.history.find(h => h.id === itemId);
      console.log('[Media] Found item:', item ? {
        type: item.type,
        fileType: item.fileType,
        fileCategory: item.fileCategory,
        filePath: item.filePath,
        _needsContent: item._needsContent
      } : 'null');
      
      const isAudioOrVideo = item && item.type === 'file' && 
        (item.fileType === 'audio' || item.fileType === 'video' || 
         item.fileCategory === 'audio' || item.fileCategory === 'video');
      
      if (!item || !isAudioOrVideo) {
        console.error('[Media] Not an audio/video file or not found');
        return { success: false, error: 'Audio/video file not found' };
      }
      
      try {
        let filePath = item.filePath;
        
        // Load full item if needed
        if (item._needsContent || !filePath) {
          console.log('[Media] Loading full item from storage...');
          const fullItem = this.storage.loadItem(itemId);
          console.log('[Media] Full item loaded:', fullItem ? { filePath: fullItem.filePath } : 'null');
          filePath = fullItem?.filePath;
        }
        
        if (filePath && fs.existsSync(filePath)) {
          const isVideo = item.fileCategory === 'video' || 
                         (item.fileType && item.fileType.startsWith('video/'));
          
          // For videos, return file path directly (don't load into memory)
          if (isVideo) {
            console.log('[Media] Video file - returning path:', filePath);
            const mimeType = this.getMediaMimeType(item.fileExt, item.fileType);
            return { 
              success: true, 
              filePath: filePath,
              mimeType: mimeType,
              isVideo: true
            };
          }
          
          // For audio files, load as base64 (they're typically small enough)
          console.log('[Media] Audio file - reading into memory:', filePath);
          const mediaData = fs.readFileSync(filePath);
          const base64 = mediaData.toString('base64');
          const mimeType = this.getMediaMimeType(item.fileExt, item.fileType);
          const dataUrl = `data:${mimeType};base64,${base64}`;
          console.log('[Media] Success - data length:', base64.length);
          return { success: true, dataUrl };
        }
        
        console.error('[Media] File not found at:', filePath);
        return { success: false, error: 'Media file no longer exists at: ' + filePath };
      } catch (error) {
        console.error('[Media] Error reading media file:', error);
        return { success: false, error: error.message };
      }
    });
    
    // Window operations
    safeHandle('clipboard:open-black-hole', () => {
      this.createBlackHoleWindow();
      return { success: true };
    });
    
    safeHandle('clipboard:open-space-notebook', (event, spaceId) => {
      const { shell } = require('electron');
      const notebookPath = path.join(this.storage.spacesDir, spaceId, 'README.ipynb');
      if (fs.existsSync(notebookPath)) {
        shell.openPath(notebookPath);
      }
      return { success: true };
    });
    
    // Screenshot capture
    safeHandle('clipboard:get-screenshot-capture-enabled', () => {
      return this.screenshotCaptureEnabled;
    });
    
    safeHandle('clipboard:toggle-screenshot-capture', (event, enabled) => {
      this.screenshotCaptureEnabled = enabled;
      this.savePreferences();
      
      if (enabled && !this.screenshotWatcher) {
        console.log('Re-enabling screenshot watcher...');
        this.setupScreenshotWatcher();
      } else if (!enabled && this.screenshotWatcher) {
        console.log('Disabling screenshot watcher...');
        this.screenshotWatcher.close();
        this.screenshotWatcher = null;
      }
      
      if (BrowserWindow) {
        BrowserWindow.getAllWindows().forEach(window => {
          window.webContents.send('clipboard:screenshot-capture-toggled', this.screenshotCaptureEnabled);
        });
      }
      
      return { success: true, enabled: this.screenshotCaptureEnabled };
    });
    
    // PDF page thumbnails
    safeHandle('clipboard:get-pdf-page-thumbnail', async (event, itemId, pageNumber) => {
      console.log('[V2-PDF] Requested thumbnail for item:', itemId, 'page:', pageNumber);
      
      const item = this.history.find(h => h.id === itemId);
      if (!item || item.type !== 'file' || item.fileType !== 'pdf') {
        return { success: false, error: 'Not a PDF file' };
      }
      
      // Get the file path
      let pdfPath = item.filePath;
      if (!pdfPath && item._needsContent) {
        // Load full item if needed
        const fullItem = this.storage.loadItem(itemId);
        pdfPath = fullItem.filePath;
      }
      
      if (!pdfPath || !fs.existsSync(pdfPath)) {
        return { success: false, error: 'PDF file not found' };
      }
      
      try {
        const thumbnail = await this.generatePDFPageThumbnail(pdfPath, pageNumber);
        return { success: true, thumbnail };
      } catch (error) {
        console.error('[V2-PDF] Error generating page thumbnail:', error);
        return { success: false, error: error.message };
      }
    });
    
    // Black hole handlers - using ContentIngestionService for validation
    ipcMain.handle('black-hole:add-text', async (event, data) => {
      const opId = `add-text-${Date.now()}`;
      console.log(`[ContentIngestion:${opId}] ═══════════════════════════════════════`);
      console.log(`[ContentIngestion:${opId}] ADD-TEXT HANDLER - Time: ${new Date().toISOString()}`);
      console.log(`[ContentIngestion:${opId}] Data:`, data ? { spaceId: data.spaceId, contentLength: data.content?.length || 0 } : 'NO DATA');
      
      // Get ingestion service for validation
      const ingestionService = getContentIngestionService(this);
      
      try {
        // Quick validation using ingestion service
        const validation = ingestionService.validateContent('text', data);
        if (!validation.valid) {
          console.error(`[ContentIngestion:${opId}] Validation failed:`, validation.errors);
          return { success: false, error: validation.errors.join('; '), code: 'VALIDATION_ERROR' };
        }
        
        // Check if content is a YouTube URL (special handling)
        let isYouTubeUrl;
        try {
          const ytModule = require('./youtube-downloader');
          isYouTubeUrl = ytModule.isYouTubeUrl;
        } catch (e) {
          console.warn(`[ContentIngestion:${opId}] YouTube module not available`);
          isYouTubeUrl = () => false;
        }
        
        const content = data.content?.trim();
        const isYT = isYouTubeUrl(content);
        
        if (isYT) {
          console.log(`[ContentIngestion:${opId}] YouTube URL detected - returning for download handling`);
          return { 
            success: true, 
            isYouTube: true, 
            youtubeUrl: content,
            spaceId: data.spaceId || this.currentSpace || 'unclassified',
            message: 'YouTube video detected'
          };
        }
        
        // Capture app context
        let context = null;
        try {
          context = await this.contextCapture.getFullContext();
        } catch (error) {
          console.warn(`[ContentIngestion:${opId}] Context capture failed:`, error.message);
        }
        
        // Enhance source detection
        const detectedSource = context 
          ? this.contextCapture.enhanceSourceDetection(data.content, context)
          : this.detectSource(data.content);
        
        // Build item
        const item = {
          type: 'text',
          content: data.content,
          preview: this.truncateText(data.content, 100),
          timestamp: Date.now(),
          pinned: false,
          spaceId: data.spaceId || this.currentSpace || 'unclassified',
          source: detectedSource
        };
        
        // Add context metadata
        if (context) {
          item.metadata = {
            context: {
              app: context.app,
              window: context.window,
              contextDisplay: this.contextCapture.formatContextDisplay(context)
            }
          };
        }
        
        // Save item
        console.log(`[ContentIngestion:${opId}] Saving text item to space: ${item.spaceId}`);
        await this.addToHistory(item);
        
        // Get the saved item ID
        const savedItem = this.history?.[0];
        console.log(`[ContentIngestion:${opId}] ✓ Text saved successfully, itemId: ${savedItem?.id}`);
        
        return { success: true, itemId: savedItem?.id };
        
      } catch (error) {
        console.error(`[ContentIngestion:${opId}] ERROR:`, error.message);
        console.error(`[ContentIngestion:${opId}] Stack:`, error.stack);
        return ingestionService.handleError(error, { opId, type: 'text', spaceId: data?.spaceId });
      }
    });
    
    ipcMain.handle('black-hole:add-html', async (event, data) => {
      const opId = `add-html-${Date.now()}`;
      console.log(`[ContentIngestion:${opId}] ADD-HTML HANDLER - spaceId: ${data?.spaceId}`);
      
      const ingestionService = getContentIngestionService(this);
      
      try {
        // Validate
        const validation = ingestionService.validateContent('html', data);
        if (!validation.valid) {
          console.error(`[ContentIngestion:${opId}] Validation failed:`, validation.errors);
          return { success: false, error: validation.errors.join('; '), code: 'VALIDATION_ERROR' };
        }
        
        // Capture app context
        let context = null;
        try {
          context = await this.contextCapture.getFullContext();
        } catch (error) {
          console.warn(`[ContentIngestion:${opId}] Context capture failed:`, error.message);
        }
        
        // Enhance source detection
        const detectedSource = context 
          ? this.contextCapture.enhanceSourceDetection(data.plainText || data.content, context)
          : 'black-hole';
        
        // Build item
        const item = {
          type: 'html',
          content: data.content,
          plainText: data.plainText,
          preview: this.truncateText(data.plainText || this.stripHtml(data.content), 100),
          timestamp: Date.now(),
          pinned: false,
          spaceId: data.spaceId || this.currentSpace || 'unclassified',
          source: detectedSource
        };
        
        // Add context metadata
        if (context) {
          item.metadata = {
            context: {
              app: context.app,
              window: context.window,
              contextDisplay: this.contextCapture.formatContextDisplay(context)
            }
          };
        }
        
        // Save item
        console.log(`[ContentIngestion:${opId}] Saving HTML item to space: ${item.spaceId}`);
        await this.addToHistory(item);
        
        const savedItem = this.history?.[0];
        console.log(`[ContentIngestion:${opId}] ✓ HTML saved successfully, itemId: ${savedItem?.id}`);
        
        return { success: true, itemId: savedItem?.id };
        
      } catch (error) {
        console.error(`[ContentIngestion:${opId}] ERROR:`, error.message);
        return ingestionService.handleError(error, { opId, type: 'html', spaceId: data?.spaceId });
      }
    });
    
    ipcMain.handle('black-hole:add-image', async (event, data) => {
      const opId = `add-image-${Date.now()}`;
      console.log(`[ContentIngestion:${opId}] ADD-IMAGE HANDLER - spaceId: ${data?.spaceId}`);
      
      const ingestionService = getContentIngestionService(this);
      
      try {
        // Validate
        const validation = ingestionService.validateContent('image', data);
        if (!validation.valid) {
          console.error(`[ContentIngestion:${opId}] Validation failed:`, validation.errors);
          return { success: false, error: validation.errors.join('; '), code: 'VALIDATION_ERROR' };
        }
        
        // Capture app context
        let context = null;
        try {
          context = await this.contextCapture.getFullContext();
        } catch (error) {
          console.warn(`[ContentIngestion:${opId}] Context capture failed:`, error.message);
        }
        
        // Generate thumbnail if needed
        let thumbnail = data.dataUrl;
        if (data.dataUrl && data.dataUrl.length > 100000) {
          thumbnail = this.generateImageThumbnail(data.dataUrl);
        }
        
        // Build item
        const item = {
          type: 'image',
          content: data.dataUrl,
          thumbnail: thumbnail,
          preview: `Image: ${data.fileName || 'Untitled'}`,
          timestamp: Date.now(),
          pinned: false,
          spaceId: data.spaceId || this.currentSpace || 'unclassified',
          source: context?.app?.name || 'black-hole',
          metadata: {
            fileName: data.fileName,
            fileSize: data.fileSize
          }
        };
        
        // Add context metadata
        if (context) {
          item.metadata = {
            ...item.metadata,
            context: {
              app: context.app,
              window: context.window,
              contextDisplay: this.contextCapture.formatContextDisplay(context)
            }
          };
        }
        
        // Save item with retry for transient disk errors
        console.log(`[ContentIngestion:${opId}] Saving image to space: ${item.spaceId}`);
        await retryOperation(
          () => this.addToHistory(item),
          { maxRetries: 3, baseDelay: 200 }
        );
        
        const savedItem = this.history?.[0];
        console.log(`[ContentIngestion:${opId}] ✓ Image saved successfully, itemId: ${savedItem?.id}`);
        
        return { success: true, itemId: savedItem?.id };
        
      } catch (error) {
        console.error(`[ContentIngestion:${opId}] ERROR:`, error.message);
        return ingestionService.handleError(error, { opId, type: 'image', spaceId: data?.spaceId });
      }
    });
    
    ipcMain.handle('black-hole:add-file', async (event, data) => {
      const opId = `add-file-${Date.now()}`;
      console.log(`[ContentIngestion:${opId}] ADD-FILE HANDLER - spaceId: ${data?.spaceId}, fileName: ${data?.fileName}`);
      
      const ingestionService = getContentIngestionService(this);
      
      try {
        // CRITICAL FIX: If filePath is provided (from paste), read the file
        if (data.filePath && !data.fileName) {
          try {
            if (!fs.existsSync(data.filePath)) {
              console.error(`[ContentIngestion:${opId}] File does not exist:`, data.filePath);
              return { success: false, error: 'File does not exist: ' + data.filePath, code: 'FILE_NOT_FOUND' };
            }
            
            const stats = fs.statSync(data.filePath);
            if (!stats.isFile()) {
              console.error(`[ContentIngestion:${opId}] Path is not a file:`, data.filePath);
              return { success: false, error: 'Path is not a file: ' + data.filePath, code: 'NOT_A_FILE' };
            }
            
            // Extract file info from path
            data.fileName = path.basename(data.filePath);
            data.fileSize = stats.size;
            
            // Read file data as base64
            const fileBuffer = fs.readFileSync(data.filePath);
            data.fileData = fileBuffer.toString('base64');
            
            console.log(`[ContentIngestion:${opId}] File read from path:`, {
              fileName: data.fileName,
              fileSize: data.fileSize,
              dataLength: data.fileData.length
            });
          } catch (readError) {
            console.error(`[ContentIngestion:${opId}] Error reading file:`, readError);
            return ingestionService.handleError(readError, { opId, type: 'file', spaceId: data?.spaceId });
          }
        }
        
        // Validate using ingestion service
        const validation = ingestionService.validateContent('file', data);
        if (!validation.valid) {
          console.error(`[ContentIngestion:${opId}] Validation failed:`, validation.errors);
          return { success: false, error: validation.errors.join('; '), code: 'VALIDATION_ERROR' };
        }
        
        // Capture app context
        let context = null;
        try {
          context = await this.contextCapture.getFullContext();
        } catch (error) {
          console.warn(`[ContentIngestion:${opId}] Context capture failed:`, error.message);
        }
      
      // Extract file extension and determine category
      const ext = path.extname(data.fileName).toLowerCase();
      let fileCategory = 'document';
      
      // Determine file category and type based on extension
      let fileType = data.fileType || 'unknown';
      
      if (['.mp4', '.avi', '.mov', '.wmv', '.flv', '.mkv', '.webm', '.m4v', '.mpg', '.mpeg'].includes(ext)) {
        fileType = 'video';
        fileCategory = 'media';
      } else if (['.mp3', '.wav', '.flac', '.aac', '.ogg', '.wma', '.m4a', '.opus', '.aiff', '.ape', '.amr', '.au'].includes(ext)) {
        fileType = 'audio';
        fileCategory = 'media';
      } else if (['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.svg', '.webp', '.ico', '.tiff', '.tif', '.heic', '.heif', '.avif', '.jfif', '.pjpeg', '.pjp', '.apng'].includes(ext)) {
        fileType = 'image-file';
        fileCategory = 'media';
      } else if (ext === '.pdf') {
        fileType = 'pdf';
        fileCategory = 'document';
      } else if (ext === '.ipynb') {
        fileType = 'notebook';
        fileCategory = 'notebook';
      } else if (['.doc', '.docx', '.txt', '.rtf', '.odt', '.md'].includes(ext)) {
        fileCategory = 'document';
      } else if (['.js', '.ts', '.jsx', '.tsx', '.py', '.java', '.cpp', '.c', '.h', '.cs', '.php', '.rb', '.go', '.rs', '.swift', '.kt', '.html', '.htm', '.css', '.scss', '.sass', '.less'].includes(ext)) {
        fileCategory = 'code';
      } else if (['.fig', '.sketch', '.xd', '.ai', '.psd', '.psb', '.indd', '.afdesign', '.afphoto'].includes(ext)) {
        fileCategory = 'design';
      } else if (['.zip', '.rar', '.7z', '.tar', '.gz', '.bz2'].includes(ext)) {
        fileCategory = 'archive';
      } else if (['.json', '.xml', '.csv', '.tsv', '.yaml', '.yml'].includes(ext)) {
        fileCategory = 'data';
      } else if (data.fileName && data.fileName.toLowerCase().startsWith('flowsource_')) {
        fileCategory = 'flow';
        fileType = 'flow';
      }
      
      // Generate thumbnail for PDF files and images
      let thumbnail = null;
      if (fileType === 'pdf') {
        thumbnail = this.generatePDFThumbnail(data.fileName, data.fileSize);
      } else if (['.html', '.htm'].includes(ext)) {
        thumbnail = this.generateHTMLThumbnail(data.fileName, data.fileSize);
      } else if (fileType === 'notebook') {
        thumbnail = this.generateNotebookThumbnail(data.fileName, data.fileSize);
      } else if (fileType === 'image-file' && data.fileData) {
        // For image files, create a data URL thumbnail from the base64 data
        const mimeType = data.mimeType || this.getMimeTypeFromExtension(ext);
        thumbnail = `data:${mimeType};base64,${data.fileData}`;
        console.log('[V2] Generated image thumbnail, mimeType:', mimeType, 'dataLength:', data.fileData.length);
        // #region agent log
        try { fs.appendFileSync('/Users/richardwilson/Onereach_app/.cursor/debug.log', JSON.stringify({location:'clipboard-manager-v2-adapter.js:add-file:imageThumbnail',message:'Generated image thumbnail',data:{fileName:data.fileName,mimeType,thumbnailLength:thumbnail.length,fileType},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H6'})+'\n'); } catch(e){}
        // #endregion
      }
      
      const itemId = this.generateId();
      const item = {
        id: itemId,
        type: 'file',
        fileName: data.fileName,
        fileSize: data.fileSize,
        fileType: fileType,
        fileCategory: fileCategory,
        fileExt: ext,
        preview: `File: ${data.fileName}`,
        thumbnail: thumbnail,
        timestamp: Date.now(),
        pinned: false,
        spaceId: data.spaceId || this.currentSpace || 'unclassified',
        source: context?.app?.name || 'black-hole',
        // Include file data if provided (for PDFs and other files)
        fileData: data.fileData || null
      };
      
      // Add context to metadata if available
      if (context) {
        item.metadata = {
          ...item.metadata,
          context: {
            app: context.app,
            window: context.window,
            contextDisplay: this.contextCapture.formatContextDisplay(context)
          }
        };
      }
      
      // If we have file data, prepare it for the storage system
      if (data.fileData) {
        console.log('[V2] Preparing file data for storage:', data.fileName);
        
        // Create a temporary file that the storage system will copy
        const tempDir = path.join(app.getPath('temp'), 'clipboard-temp-files');
        if (!fs.existsSync(tempDir)) {
          fs.mkdirSync(tempDir, { recursive: true });
        }
        
        const tempFilePath = path.join(tempDir, data.fileName);
        try {
          const buffer = Buffer.from(data.fileData, 'base64');
          fs.writeFileSync(tempFilePath, buffer);
          
          // Set filePath so storage system can copy it
          item.filePath = tempFilePath;
          item.fileName = data.fileName;
          console.log('[V2] Temp file created for storage system:', tempFilePath);
          
          // The actual file will be stored by storage.addItem in the correct location
          // We'll generate thumbnails after the item is properly stored
          
          // Set flags for post-processing
          if (fileType === 'pdf') {
            item.needsPDFThumbnail = true;
          }
          
          const textExtensions = ['.txt', '.md', '.log', '.csv', '.tsv'];
          const codeExtensions = ['.js', '.ts', '.jsx', '.tsx', '.json', '.html', '.htm', '.css', '.scss', '.sass', '.less', 
                                  '.py', '.java', '.cpp', '.c', '.h', '.rb', '.go', '.rs', '.swift', '.kt', '.php', '.sh', 
                                  '.yaml', '.yml', '.xml', '.sql', '.r', '.m', '.mm', '.lua', '.pl', '.ps1', '.bat'];
          
          if (textExtensions.includes(ext) || codeExtensions.includes(ext)) {
            item.needsTextPreview = true;
          }
        } catch (err) {
          console.error('[V2] Error creating temp file:', err);
        }
      }
      
      // If we have file data, prepare it for the storage system
      if (data.fileData) {
        console.log('[V2] Preparing file data for storage system:', data.fileName);
        // Create a temporary file that the storage system can copy from
        const tempDir = path.join(app.getPath('temp'), 'clipboard-files');
        if (!fs.existsSync(tempDir)) {
          fs.mkdirSync(tempDir, { recursive: true });
        }
        
        const tempFilePath = path.join(tempDir, `${item.id}_${data.fileName}`);
        try {
          const buffer = Buffer.from(data.fileData, 'base64');
          fs.writeFileSync(tempFilePath, buffer);
          item.fileDataPath = tempFilePath;
          console.log('[V2] Temporary file saved to:', tempFilePath);
        } catch (err) {
          console.error('[V2] Error saving temporary file:', err);
        }
      }
      
      // Add item to history with retry for transient disk errors
      console.log(`[ContentIngestion:${opId}] Saving file item to space: ${item.spaceId}`);
      await retryOperation(
        () => this.addToHistory(item),
        { maxRetries: 3, baseDelay: 200 }
      );
      
      // Now the file has been copied to items/[id]/fileName by the storage system
      // We need to find the actual stored file path for post-processing
      if (item.needsPDFThumbnail || item.needsTextPreview) {
        const storedFilePath = path.join(this.storage.storageRoot, 'items', item.id, item.fileName);
        
        if (fs.existsSync(storedFilePath)) {
          // Generate PDF thumbnail
          if (item.needsPDFThumbnail) {
            console.log('[V2] Generating real PDF thumbnail for stored file:', storedFilePath);
            await this.generateRealPDFThumbnail(storedFilePath, item);
          }
          
          // Generate text preview
          if (item.needsTextPreview) {
            try {
              console.log('[V2] Generating text preview for stored file:', storedFilePath);
              const preview = await this.generateTextPreview(storedFilePath, item);
              if (preview && !preview.includes('svg+xml')) {
                // Update item with real preview
                const historyItem = this.history.find(h => h.id === item.id);
                if (historyItem) {
                  historyItem.thumbnail = preview;
                  console.log('[V2-TEXT] Updated item with text preview');
                  this.notifyHistoryUpdate();
                }
              }
            } catch (error) {
              console.error('[V2-TEXT] Error generating text preview:', error);
            }
          }
        } else {
          console.error('[V2] Stored file not found at expected location:', storedFilePath);
        }
      }
      
      // Clean up temp file
      if (item.filePath && item.filePath.includes('clipboard-temp-files')) {
        try {
          fs.unlinkSync(item.filePath);
          console.log(`[ContentIngestion:${opId}] Cleaned up temp file:`, item.filePath);
        } catch (err) {
          // Ignore cleanup errors
        }
      }
      
      console.log(`[ContentIngestion:${opId}] ✓ File saved successfully, itemId: ${item.id}`);
      return { success: true, itemId: item.id };
      
      } catch (error) {
        console.error(`[ContentIngestion:${opId}] ERROR:`, error.message);
        return ingestionService.handleError(error, { opId, type: 'file', spaceId: data?.spaceId });
      }
    });
    
    // Screenshot completion handler
    safeHandle('clipboard:complete-screenshot', (event, { screenshotPath, spaceId, stats, ext }) => {
      if (fs.existsSync(screenshotPath)) {
        const previousSpace = this.currentSpace;
        this.currentSpace = spaceId;
        // Temporarily bypass the space check since we're now setting it
        this.handleScreenshot(screenshotPath);
        this.currentSpace = previousSpace; // Restore previous space
        return { success: true };
      }
      return { success: false, error: 'Screenshot file not found' };
    });
    
    // PDF generation handlers
    safeHandle('clipboard:generate-space-pdf', async (event, spaceId, options = {}) => {
      try {
        const PDFGenerator = require('./pdf-generator');
        const generator = new PDFGenerator();
        
        // Get space details
        const space = this.spaces.find(s => s.id === spaceId);
        if (!space) {
          return { success: false, error: 'Space not found' };
        }
        
        // Get all items in the space and load full content
        const items = this.getSpaceItems(spaceId).map(item => {
          // If item needs content, load it from storage
          if (item._needsContent) {
            const fullItem = this.storage.loadItem(item.id);
            return {
              ...item,
              content: fullItem.content,
              thumbnail: fullItem.thumbnail,
              dataUrl: fullItem.content, // Add dataUrl for compatibility
              metadata: fullItem.metadata,
              _needsContent: false
            };
          }
          // For items that already have content, ensure dataUrl is set for images
          if (item.type === 'image' && item.content && !item.dataUrl) {
            return {
              ...item,
              dataUrl: item.content
            };
          }
          return item;
        });
        
        // Generate output path
        const outputDir = path.join(app.getPath('downloads'), 'Onereach-Exports');
        if (!fs.existsSync(outputDir)) {
          fs.mkdirSync(outputDir, { recursive: true });
        }
        
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
        const sanitizedSpaceName = space.name.replace(/[^a-zA-Z0-9-_]/g, '_');
        const outputPath = path.join(outputDir, `${sanitizedSpaceName}_${timestamp}.pdf`);
        
        // Generate PDF
        const result = await generator.generateSpacePDF(space, items, {
          ...options,
          outputPath
        });
        
        // Cleanup
        await generator.cleanup();
        
        if (result.success) {
          // Open the file location
          const { shell } = require('electron');
          shell.showItemInFolder(outputPath);
        }
        
        return result;
      } catch (error) {
        console.error('Error generating PDF:', error);
        return { success: false, error: error.message };
      }
    });
    
    safeHandle('clipboard:export-space-pdf', async (event, spaceId, options = {}) => {
      try {
        // Show save dialog
        const { dialog } = require('electron');
        const space = this.spaces.find(s => s.id === spaceId);
        if (!space) {
          return { success: false, error: 'Space not found' };
        }
        
        const sanitizedSpaceName = space.name.replace(/[^a-zA-Z0-9-_]/g, '_');
        const result = await dialog.showSaveDialog({
          title: 'Export Space as PDF',
          defaultPath: `${sanitizedSpaceName}.pdf`,
          filters: [
            { name: 'PDF Files', extensions: ['pdf'] },
            { name: 'All Files', extensions: ['*'] }
          ]
        });
        
        if (result.canceled) {
          return { success: false, canceled: true };
        }
        
        const PDFGenerator = require('./pdf-generator');
        const generator = new PDFGenerator();
        
        // Get all items in the space and load full content
        const items = this.getSpaceItems(spaceId).map(item => {
          // If item needs content, load it from storage
          if (item._needsContent) {
            const fullItem = this.storage.loadItem(item.id);
            return {
              ...item,
              content: fullItem.content,
              thumbnail: fullItem.thumbnail,
              dataUrl: fullItem.content, // Add dataUrl for compatibility
              metadata: fullItem.metadata,
              _needsContent: false
            };
          }
          // For items that already have content, ensure dataUrl is set for images
          if (item.type === 'image' && item.content && !item.dataUrl) {
            return {
              ...item,
              dataUrl: item.content
            };
          }
          return item;
        });
        
        // Generate PDF
        const pdfResult = await generator.generateSpacePDF(space, items, {
          ...options,
          outputPath: result.filePath
        });
        
        // Cleanup
        await generator.cleanup();
        
        if (pdfResult.success) {
          // Show the file in folder
          const { shell } = require('electron');
          shell.showItemInFolder(result.filePath);
        }
        
        return pdfResult;
      } catch (error) {
        console.error('Error exporting PDF:', error);
        return { success: false, error: error.message };
      }
    });
    
    // Smart export handlers
    safeHandle('clipboard:smart-export-space', async (event, spaceId) => {
      console.log('[Clipboard] Opening smart export for space:', spaceId);
      
      try {
        const space = this.spaces.find(s => s.id === spaceId);
        if (!space) {
          throw new Error('Space not found');
        }
        
        const items = this.getSpaceItems(spaceId).map(item => {
          // Load full content if needed
          if (item._needsContent) {
            const fullItem = this.storage.loadItem(item.id);
            return {
              ...item,
              content: fullItem.content,
              thumbnail: fullItem.thumbnail,
              dataUrl: fullItem.content,
              metadata: fullItem.metadata,
              _needsContent: false
            };
          }
          return item;
        });
        
        // Open smart export preview window
        const { BrowserWindow } = require('electron');
        const path = require('path');
        
        const smartExportWindow = new BrowserWindow({
          width: 1200,
          height: 800,
          title: `Smart Export - ${space.name}`,
          webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js')
          }
        });
        
        // Store the export data globally so the window can access it
        global.smartExportData = {
          space,
          items,
          spaceId,
          useAI: true
        };
        
        smartExportWindow.loadFile('smart-export-preview.html');
        
        return true;
      } catch (error) {
        console.error('[Clipboard] Error opening smart export:', error);
        throw error;
      }
    });
    
    // Unified export preview handler
    safeHandle('clipboard:open-export-preview', async (event, spaceId, options = {}) => {
      console.log('[Clipboard] Opening export preview for space:', spaceId, 'Options:', options);
      
      try {
        const space = this.spaces.find(s => s.id === spaceId);
        if (!space) {
          throw new Error('Space not found');
        }
        
        const items = this.getSpaceItems(spaceId).map(item => {
          // Load full content if needed
          if (item._needsContent) {
            const fullItem = this.storage.loadItem(item.id);
            return {
              ...item,
              content: fullItem.content,
              thumbnail: fullItem.thumbnail,
              dataUrl: fullItem.content,
              metadata: fullItem.metadata,
              _needsContent: false
            };
          }
          return item;
        });
        
        // Open export preview window
        const { BrowserWindow } = require('electron');
        const path = require('path');
        
        const exportWindow = new BrowserWindow({
          width: 1200,
          height: 800,
          title: `Export Preview - ${space.name}`,
          webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js')
          }
        });
        
        // Store the export data globally so the window can access it
        global.smartExportData = {
          space,
          items,
          spaceId,
          useAI: options.useAI || false,
          options: options
        };
        
        exportWindow.loadFile('smart-export-preview.html');
        
        return true;
      } catch (error) {
        console.error('[Clipboard] Error opening export preview:', error);
        throw error;
      }
    });
    
    // Website monitoring handlers
    safeHandle('clipboard:add-website-monitor', async (event, config) => {
      try {
        const WebsiteMonitor = require('./website-monitor');
        if (!this.websiteMonitor) {
          this.websiteMonitor = new WebsiteMonitor();
          await this.websiteMonitor.initialize();
        }
        
        const monitor = await this.websiteMonitor.addMonitor(config);
        return { success: true, monitor };
      } catch (error) {
        console.error('Error adding website monitor:', error);
        return { success: false, error: error.message };
      }
    });
    
    safeHandle('clipboard:check-website', async (event, monitorId) => {
      try {
        if (!this.websiteMonitor) {
          const WebsiteMonitor = require('./website-monitor');
          this.websiteMonitor = new WebsiteMonitor();
          await this.websiteMonitor.initialize();
        }
        
        const result = await this.websiteMonitor.checkWebsite(monitorId);
        
        // If changed, add to clipboard history
        if (result.changed && result.monitor.spaceId) {
          const change = {
            type: 'text',
            content: `Website Changed: ${result.monitor.name}\n\nURL: ${result.monitor.url}\n\nLast Changed: ${new Date(result.monitor.lastChanged).toLocaleString()}\n\nView changes in the website monitor.`,
            preview: `Website Changed: ${result.monitor.name}`,
            source: 'website-monitor',
            spaceId: result.monitor.spaceId,
            metadata: {
              monitorId: result.monitor.id,
              url: result.monitor.url,
              screenshot: result.snapshot.screenshot
            }
          };
          
          this.addToHistory(change);
        }
        
        return result;
      } catch (error) {
        console.error('Error checking website:', error);
        return { success: false, error: error.message };
      }
    });
    
    safeHandle('clipboard:get-website-monitors', async () => {
      try {
        if (!this.websiteMonitor) {
          const WebsiteMonitor = require('./website-monitor');
          this.websiteMonitor = new WebsiteMonitor();
          await this.websiteMonitor.initialize();
        }
        
        return Array.from(this.websiteMonitor.monitors.values());
      } catch (error) {
        console.error('Error getting monitors:', error);
        return [];
      }
    });
    
    safeHandle('clipboard:get-monitor-history', async (event, monitorId) => {
      try {
        if (!this.websiteMonitor) {
          const WebsiteMonitor = require('./website-monitor');
          this.websiteMonitor = new WebsiteMonitor();
          await this.websiteMonitor.initialize();
        }
        
        const history = await this.websiteMonitor.getMonitorHistory(monitorId);
        return { success: true, history };
      } catch (error) {
        console.error('Error getting monitor history:', error);
        return { success: false, error: error.message };
      }
    });
    
    safeHandle('clipboard:remove-website-monitor', async (event, monitorId) => {
      try {
        if (!this.websiteMonitor) {
          const WebsiteMonitor = require('./website-monitor');
          this.websiteMonitor = new WebsiteMonitor();
          await this.websiteMonitor.initialize();
        }
        
        return await this.websiteMonitor.removeMonitor(monitorId);
      } catch (error) {
        console.error('Error removing monitor:', error);
        return { success: false, error: error.message };
      }
    });
    
    safeHandle('clipboard:pause-website-monitor', async (event, monitorId) => {
      try {
        if (!this.websiteMonitor) {
          const WebsiteMonitor = require('./website-monitor');
          this.websiteMonitor = new WebsiteMonitor();
          await this.websiteMonitor.initialize();
        }
        
        await this.websiteMonitor.pauseMonitor(monitorId);
        return { success: true };
      } catch (error) {
        console.error('Error pausing monitor:', error);
        return { success: false, error: error.message };
      }
    });
    
    safeHandle('clipboard:resume-website-monitor', async (event, monitorId) => {
      try {
        if (!this.websiteMonitor) {
          const WebsiteMonitor = require('./website-monitor');
          this.websiteMonitor = new WebsiteMonitor();
          await this.websiteMonitor.initialize();
        }
        
        await this.websiteMonitor.resumeMonitor(monitorId);
        return { success: true };
      } catch (error) {
        console.error('Error resuming monitor:', error);
        return { success: false, error: error.message };
      }
    });
    
    // YouTube download handlers
    this.setupYouTubeHandlers(safeHandle);
  }
  
  // Setup YouTube download IPC handlers
  setupYouTubeHandlers(safeHandle) {
    console.log('[ClipboardManager] Setting up YouTube handlers...');
    const { YouTubeDownloader, isYouTubeUrl, extractVideoId } = require('./youtube-downloader');
    console.log('[ClipboardManager] YouTube module loaded, isYouTubeUrl:', typeof isYouTubeUrl);
    
    // Lazy-init downloader
    let downloader = null;
    const getDownloader = () => {
      if (!downloader) {
        downloader = new YouTubeDownloader();
      }
      return downloader;
    };
    
    // Check if URL is a YouTube video
    ipcMain.handle('youtube:is-youtube-url', (event, url) => {
      return isYouTubeUrl(url);
    });
    
    // Extract video ID from URL
    ipcMain.handle('youtube:extract-video-id', (event, url) => {
      return extractVideoId(url);
    });
    
    // Get video info without downloading
    ipcMain.handle('youtube:get-info', async (event, url) => {
      try {
        const dl = getDownloader();
        return await dl.getVideoInfo(url);
      } catch (error) {
        return { success: false, error: error.message };
      }
    });
    
    // Verify an item exists with file and metadata, returns checksum
    safeHandle('clipboard:verify-item', async (event, itemId) => {
      try {
        console.log('[Verify] Verifying item:', itemId);
        const itemDir = path.join(this.storage.itemsDir, itemId);
        
        // Check directory exists
        if (!fs.existsSync(itemDir)) {
          return { success: false, error: 'Item directory not found' };
        }
        
        // Check for metadata
        const metadataPath = path.join(itemDir, 'metadata.json');
        if (!fs.existsSync(metadataPath)) {
          return { success: false, error: 'Metadata file not found' };
        }
        
        const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
        
        // Find the main file (video/audio/image)
        const files = fs.readdirSync(itemDir).filter(f => 
          !f.endsWith('.json') && !f.endsWith('.txt') && f !== '.DS_Store'
        );
        
        if (files.length === 0) {
          return { success: false, error: 'No media file found' };
        }
        
        const mainFile = files[0];
        const filePath = path.join(itemDir, mainFile);
        const fileStats = fs.statSync(filePath);
        
        // Calculate simple checksum (first + last 1MB + size)
        const crypto = require('crypto');
        const hash = crypto.createHash('md5');
        const fd = fs.openSync(filePath, 'r');
        const buffer = Buffer.alloc(Math.min(1024 * 1024, fileStats.size)); // 1MB max
        
        // Read first chunk
        fs.readSync(fd, buffer, 0, buffer.length, 0);
        hash.update(buffer);
        
        // Read last chunk if file is larger
        if (fileStats.size > buffer.length) {
          const lastBuffer = Buffer.alloc(Math.min(1024 * 1024, fileStats.size));
          fs.readSync(fd, lastBuffer, 0, lastBuffer.length, fileStats.size - lastBuffer.length);
          hash.update(lastBuffer);
        }
        
        fs.closeSync(fd);
        hash.update(fileStats.size.toString());
        const checksum = hash.digest('hex').substring(0, 8); // Short checksum
        
        console.log('[Verify] Item verified:', itemId, 'checksum:', checksum);
        
        return {
          success: true,
          itemId: itemId,
          fileName: mainFile,
          fileSize: fileStats.size,
          fileSizeFormatted: formatBytes(fileStats.size),
          hasMetadata: true,
          metadataKeys: Object.keys(metadata),
          title: metadata.title || mainFile,
          checksum: checksum,
          hasTranscript: !!(metadata.transcript?.text),
          source: metadata.source
        };
        
        function formatBytes(bytes) {
          if (bytes === 0) return '0 B';
          const k = 1024;
          const sizes = ['B', 'KB', 'MB', 'GB'];
          const i = Math.floor(Math.log(bytes) / Math.log(k));
          return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
        }
      } catch (error) {
        console.error('[Verify] Error:', error);
        return { success: false, error: error.message };
      }
    });
    
    // Download video to Space
    ipcMain.handle('youtube:download-to-space', async (event, url, spaceId) => {
      console.log('[YouTube] download-to-space called with URL:', url, 'spaceId:', spaceId);
      try {
        const dl = getDownloader();
        console.log('[YouTube] Starting download...');
        const result = await dl.downloadToSpace(url, this, spaceId || this.currentSpace, (percent, status) => {
          console.log('[YouTube] Progress:', percent, status);
          // Send progress updates to renderer
          if (event.sender && !event.sender.isDestroyed()) {
            event.sender.send('youtube:download-progress', { percent, status, url });
          }
        });
        console.log('[YouTube] Download result:', JSON.stringify(result));
        return result;
      } catch (error) {
        console.error('[YouTube] Download error:', error);
        return { success: false, error: error.message };
      }
    });
    
    // Start YouTube download in background - returns immediately with placeholder item
    ipcMain.handle('youtube:start-background-download', async (event, url, spaceId) => {
      console.log('[YouTube] *** start-background-download called ***');
      console.log('[YouTube] URL:', url);
      console.log('[YouTube] spaceId:', spaceId);
      
      try {
        const targetSpaceId = spaceId || this.currentSpace || 'unclassified';
        console.log('[YouTube] targetSpaceId:', targetSpaceId);
        
        // Extract video ID from URL for immediate feedback
        const { extractVideoId } = require('./youtube-downloader');
        const videoId = extractVideoId(url);
        console.log('[YouTube] Extracted videoId:', videoId);
        
        // Create placeholder immediately WITHOUT waiting for video info
        // This makes the UI feel responsive
        const placeholderItem = {
          type: 'file',
          fileType: 'video',
          fileName: `YouTube Video ${videoId || 'download'}.mp4`,
          preview: `🎬 Downloading YouTube video...`,
          timestamp: Date.now(),
          pinned: false,
          spaceId: targetSpaceId,
          source: 'youtube',
          metadata: {
            youtubeId: videoId,
            youtubeUrl: url,
            title: 'Loading...',
            downloadStatus: 'downloading',
            downloadProgress: 0
          }
        };
        
        // Add placeholder to storage
        const indexEntry = this.storage.addItem(placeholderItem);
        const placeholderId = indexEntry.id;
        console.log('[YouTube] Created placeholder item:', placeholderId);
        
        // Add to in-memory history
        this.history.unshift({
          ...placeholderItem,
          id: placeholderId,
          _needsContent: true
        });
        this.updateSpaceCounts();
        this.notifyHistoryUpdate();
        
        // Start download in background (don't await)
        this.downloadYouTubeInBackground(url, targetSpaceId, placeholderId, event.sender);
        
        // Return immediately with placeholder info
        return {
          success: true,
          placeholderId: placeholderId,
          title: 'YouTube Video',
          message: `Started downloading YouTube video`
        };
        
      } catch (error) {
        console.error('[YouTube] Error starting background download:', error);
        return { success: false, error: error.message };
      }
    });
    
    // Download video (returns file path, doesn't add to space)
    ipcMain.handle('youtube:download', async (event, url, options = {}) => {
      try {
        const dl = getDownloader();
        return await dl.download(url, options, (percent, status) => {
          if (event.sender && !event.sender.isDestroyed()) {
            event.sender.send('youtube:download-progress', { percent, status, url });
          }
        });
      } catch (error) {
        return { success: false, error: error.message };
      }
    });
    
    // Get transcript from YouTube video (using YouTube captions)
    ipcMain.handle('youtube:get-transcript', async (event, url, lang = 'en') => {
      console.log('[YouTube] get-transcript called for:', url, 'lang:', lang);
      try {
        const dl = getDownloader();
        const result = await dl.getTranscript(url, lang);
        console.log('[YouTube] Transcript result:', result.success ? 'success' : result.error);
        return result;
      } catch (error) {
        console.error('[YouTube] Transcript error:', error);
        return { success: false, error: error.message };
      }
    });
    
    // Fetch and save YouTube transcript for an existing item
    ipcMain.handle('youtube:fetch-transcript-for-item', async (event, itemId, lang = 'en') => {
      console.log('[YouTube] fetch-transcript-for-item called for:', itemId, 'lang:', lang);
      try {
        // Load item metadata
        const itemDir = path.join(this.storage.itemsDir, itemId);
        const metadataPath = path.join(itemDir, 'metadata.json');
        
        if (!fs.existsSync(metadataPath)) {
          return { success: false, error: 'Item not found' };
        }
        
        const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
        const youtubeUrl = metadata.youtubeUrl;
        
        if (!youtubeUrl) {
          return { success: false, error: 'Not a YouTube video' };
        }
        
        console.log('[YouTube] Fetching transcript for:', youtubeUrl);
        
        const dl = getDownloader();
        const result = await dl.getTranscript(youtubeUrl, lang);
        
        if (result.success && result.transcript) {
          // Update metadata with transcript
          metadata.transcript = {
            text: result.transcript,
            segments: result.segments,
            language: result.language,
            isAutoGenerated: result.isAutoGenerated,
            segmentCount: result.segmentCount,
            fetchedAt: new Date().toISOString()
          };
          
          fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
          
          // Also save as transcription.txt for compatibility
          const transcriptionPath = path.join(itemDir, 'transcription.txt');
          fs.writeFileSync(transcriptionPath, result.transcript, 'utf8');
          
          console.log('[YouTube] Transcript saved for item:', itemId, 'length:', result.transcript.length);
          
          return {
            success: true,
            transcription: result.transcript,
            language: result.language,
            isAutoGenerated: result.isAutoGenerated,
            segmentCount: result.segmentCount
          };
        } else {
          return { success: false, error: result.error || 'Failed to fetch transcript' };
        }
      } catch (error) {
        console.error('[YouTube] fetch-transcript-for-item error:', error);
        return { success: false, error: error.message };
      }
    });

    // Transcribe YouTube video using unified TranscriptionService (ElevenLabs Scribe)
    // Replaces legacy Whisper endpoint - now uses ElevenLabs with speaker diarization
    ipcMain.handle('youtube:get-transcript-whisper', async (event, url, lang = 'en') => {
      console.log('[YouTube] Transcription requested for:', url, 'lang:', lang);
      try {
        const dl = getDownloader();
        
        // Download audio first
        if (event.sender && !event.sender.isDestroyed()) {
          event.sender.send('youtube:transcribe-progress', { percent: 10, status: 'Downloading audio...', url });
        }
        const audioPath = await dl.downloadAudio(url);
        
        // Use unified TranscriptionService
        if (event.sender && !event.sender.isDestroyed()) {
          event.sender.send('youtube:transcribe-progress', { percent: 50, status: 'Transcribing with AI...', url });
        }
        
        const { getTranscriptionService } = await import('./src/transcription/index.js');
        const service = getTranscriptionService();
        const result = await service.transcribe(audioPath, {
          language: lang,
          diarize: true  // Enable speaker identification
        });
        
        // Clean up audio file
        const fs = require('fs');
        if (fs.existsSync(audioPath)) {
          fs.unlinkSync(audioPath);
        }
        
        if (event.sender && !event.sender.isDestroyed()) {
          event.sender.send('youtube:transcribe-progress', { percent: 100, status: 'Complete', url });
        }
        
        console.log('[YouTube] Transcription result:', result.success ? 
          `${result.wordCount} words, ${result.speakerCount} speakers` : result.error);
        return result;
      } catch (error) {
        console.error('[YouTube] Transcription error:', error);
        return { success: false, error: error.message };
      }
    });

    // Process speaker recognition - now uses unified TranscriptionService
    // ElevenLabs Scribe includes speaker diarization by default
    ipcMain.handle('youtube:process-speaker-recognition', async (event, url) => {
      console.log('[YouTube] Speaker recognition requested for:', url);
      try {
        const dl = getDownloader();
        
        // Download audio first
        if (event.sender && !event.sender.isDestroyed()) {
          event.sender.send('youtube:speaker-recognition-progress', { percent: 10, status: 'Downloading audio...', url });
        }
        const audioPath = await dl.downloadAudio(url);
        
        // Use unified TranscriptionService with diarization
        if (event.sender && !event.sender.isDestroyed()) {
          event.sender.send('youtube:speaker-recognition-progress', { percent: 50, status: 'Identifying speakers...', url });
        }
        
        const { getTranscriptionService } = await import('./src/transcription/index.js');
        const service = getTranscriptionService();
        const result = await service.transcribe(audioPath, {
          diarize: true  // Speaker diarization enabled
        });
        
        // Clean up audio file
        const fs = require('fs');
        if (fs.existsSync(audioPath)) {
          fs.unlinkSync(audioPath);
        }
        
        if (event.sender && !event.sender.isDestroyed()) {
          event.sender.send('youtube:speaker-recognition-progress', { percent: 100, status: 'Complete', url });
        }
        
        console.log('[YouTube] Speaker recognition result:', result.success ? 
          `${result.speakerCount} speakers, ${result.wordCount} words` : result.error);
        return result;
      } catch (error) {
        console.error('[YouTube] Speaker recognition error:', error);
        return { success: false, error: error.message };
      }
    });

    console.log('[ClipboardManager] YouTube download handlers registered');
  }
  
  // Helper method for space names
  getSpaceName(spaceId) {
    if (!spaceId || spaceId === null) {
      return 'All Items';
    }
    const space = this.spaces.find(s => s.id === spaceId);
    return space ? `${space.icon} ${space.name}` : 'Unknown Space';
  }
  
  // Helper method to update item metadata
  async updateItemMetadata(itemId, metadata) {
    try {
      const item = this.storage.loadItem(itemId);
      if (!item) return { success: false, error: 'Item not found' };
      
      // Update metadata
      item.metadata = metadata;
      
      // Save back to storage
      const metadataPath = path.join(this.storage.storageRoot, 'items', itemId, 'metadata.json');
      fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
      
      // Update in history array if present
      const historyItem = this.history.find(h => h.id === itemId);
      if (historyItem) {
        historyItem.metadata = metadata;
        this.notifyHistoryUpdate();
      }
      
      return { success: true };
    } catch (error) {
      console.error('Error updating metadata:', error);
      return { success: false, error: error.message };
    }
  }
  
  showItemInFinder(itemId) {
    const { shell } = require('electron');
    
    try {
      // Find the item
      const item = this.history.find(h => h.id === itemId);
      if (!item) {
        return { success: false, error: 'Item not found' };
      }
      
      // Determine the path to show
      let pathToShow = null;
      
      // For files, show the actual file
      if (item.type === 'file' || item.fileType) {
        const itemDir = path.join(this.storage.storageRoot, 'items', itemId);
        
        // Check if we have a fileName
        if (item.fileName) {
          const filePath = path.join(itemDir, item.fileName);
          if (fs.existsSync(filePath)) {
            pathToShow = filePath;
          }
        } else {
          // Look for any file in the item directory
          if (fs.existsSync(itemDir)) {
            const files = fs.readdirSync(itemDir);
            const fileToShow = files.find(f => !f.endsWith('.json')); // Exclude metadata files
            if (fileToShow) {
              pathToShow = path.join(itemDir, fileToShow);
            }
          }
        }
      }
      
      // For other types (text, code, etc.), show the item directory
      if (!pathToShow) {
        pathToShow = path.join(this.storage.storageRoot, 'items', itemId);
      }
      
      // Check if the path exists
      if (!fs.existsSync(pathToShow)) {
        // If item directory doesn't exist, show the storage root
        pathToShow = this.storage.storageRoot;
      }
      
      // Show in Finder
      shell.showItemInFolder(pathToShow);
      
      return { success: true };
    } catch (error) {
      console.error('Error showing item in Finder:', error);
      return { success: false, error: error.message };
    }
  }
  
  destroy() {
    // PERFORMANCE: Flush any pending async saves before cleanup
    if (this.storage && this.storage.flushPendingSaves) {
      this.storage.flushPendingSaves();
    }
    
    if (this.clipboardWindow && !this.clipboardWindow.isDestroyed()) {
      this.clipboardWindow.close();
    }
    if (this.blackHoleWindow && !this.blackHoleWindow.isDestroyed()) {
      this.blackHoleWindow.close();
    }
    if (this.screenshotWatcher) {
      this.screenshotWatcher.close();
      this.screenshotWatcher = null;
    }
    if (this.websiteMonitor) {
      this.websiteMonitor.cleanup();
      this.websiteMonitor = null;
    }
    if (this.websiteCheckInterval) {
      clearInterval(this.websiteCheckInterval);
      this.websiteCheckInterval = null;
    }
    // Stop context capture background tracking
    if (this.contextCapture) {
      this.contextCapture.stopBackgroundTracking();
    }
    if (globalShortcut) {
      globalShortcut.unregisterAll();
    }
    
    // Reset IPC registration flag to allow re-registration if manager is recreated
    ClipboardManagerV2._ipcRegistered = false;
    
    console.log('Clipboard manager cleaned up');
  }
  
  // Helper method to generate AI metadata
  async generateAIMetadata(itemId, apiKey, customPrompt) {
    try {
      const ClaudeAPI = require('./claude-api');
      const claudeAPI = new ClaudeAPI();
      
      // Get the full item with content loaded
      let item = this.storage.loadItem(itemId);
      if (!item) {
        return { success: false, error: 'Item not found' };
      }
      
      console.log('[AI Metadata] Processing item:', {
        id: item.id,
        type: item.type,
        fileType: item.fileType,
        fileCategory: item.fileCategory,
        fileExt: item.fileExt,
        fileName: item.fileName,
        isScreenshot: item.isScreenshot,
        hasThumbnail: !!item.thumbnail,
        thumbnailType: item.thumbnail ? item.thumbnail.substring(0, 50) : 'none',
        isGeneratedDocument: item.metadata?.type === 'generated-document',
        hasHtmlContent: !!item.html || !!item.content
      });
      
      // Prepare content for analysis
      let content = '';
      let contentType = item.type;
      let imageData = null;
      
      // Determine the best analysis method based on file type and content
      const fileExt = item.fileExt ? item.fileExt.toLowerCase() : '';
      
      // Image file types that should use vision
      const imageExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.svg', '.ico', '.tiff', '.tif', '.heic', '.heif', '.avif', '.raw', '.psd', '.ai', '.eps'];
      const documentExtensions = ['.pdf', '.doc', '.docx', '.odt', '.rtf', '.xls', '.xlsx', '.ppt', '.pptx', '.pages', '.numbers', '.key', '.epub', '.mobi'];
      const codeExtensions = ['.js', '.ts', '.py', '.java', '.cpp', '.c', '.h', '.css', '.html', '.jsx', '.tsx', '.vue', '.rb', '.go', '.rs', '.php', '.swift', '.kt', '.scala', '.r', '.m', '.mm', '.sh', '.bash', '.zsh', '.ps1', '.bat', '.cmd', '.sql', '.graphql', '.proto', '.asm', '.s', '.lua', '.perl', '.pl', '.dart', '.elm', '.ex', '.exs', '.clj', '.hs', '.fs', '.ml', '.nim', '.zig', '.v', '.sol'];
      const dataExtensions = ['.json', '.xml', '.csv', '.yaml', '.yml', '.toml', '.env', '.properties', '.plist', '.ndjson', '.jsonl', '.tsv', '.parquet', '.avro'];
      const textExtensions = ['.txt', '.md', '.log', '.ini', '.conf', '.config', '.cfg', '.rc', '.gitignore', '.dockerignore', '.editorconfig', '.htaccess', '.readme', '.license', '.changelog', '.todo', '.notes'];
      const audioExtensions = ['.mp3', '.wav', '.flac', '.aac', '.ogg', '.m4a', '.wma', '.aiff', '.opus'];
      const videoExtensions = ['.mp4', '.mov', '.avi', '.mkv', '.wmv', '.flv', '.webm', '.m4v', '.mpeg', '.mpg', '.3gp'];
      const archiveExtensions = ['.zip', '.tar', '.gz', '.rar', '.7z', '.bz2', '.xz', '.tgz', '.dmg', '.iso'];
      
      // Check if this is an image that should use vision
      if (item.isScreenshot || 
          imageExtensions.includes(fileExt) || 
          item.fileCategory === 'media' || 
          (item.type === 'image') ||
          (item.fileType === 'image-file')) {
        
        console.log('[AI Metadata] Processing as image/visual content');
        
        // For images, we need the actual image data
        if (item.thumbnail && !item.thumbnail.includes('svg+xml')) {
          imageData = item.thumbnail;
          contentType = 'image';
          content = `Filename: ${item.fileName || 'Screenshot'}`;
          console.log('[AI Metadata] Using thumbnail as image data');
        } 
        else if (item.filePath || item.content) {
          const filePath = item.filePath || item.content;
          if (typeof filePath === 'string' && fs.existsSync(filePath)) {
            try {
              const imageBuffer = fs.readFileSync(filePath);
              const ext = path.extname(filePath).toLowerCase().replace('.', '');
              imageData = `data:image/${ext};base64,${imageBuffer.toString('base64')}`;
              contentType = 'image';
              content = `Filename: ${item.fileName || 'Image'}`;
              console.log('[AI Metadata] Loaded image from file path');
            } catch (e) {
              console.error('[AI Metadata] Error loading image file:', e);
              // Fall back to text analysis of filename
              content = item.fileName || item.preview || 'Image file';
              contentType = 'file';
            }
          }
        }
      }
      // Check if this is a PDF that needs special handling
      else if (documentExtensions.includes(fileExt)) {
        console.log('[AI Metadata] Processing as document file');
        
        // For PDFs and documents, we can't easily extract text, so analyze based on filename and context
        content = `Document file: ${item.fileName || 'Document'}\nType: ${fileExt}\nSize: ${item.fileSize ? this.formatFileSize(item.fileSize) : 'Unknown'}`;
        contentType = 'document';
        
        // If we have a good thumbnail for PDF, we could analyze that
        if (item.thumbnail && !item.thumbnail.includes('svg+xml') && item.thumbnail.length > 1000) {
          imageData = item.thumbnail;
          content += '\n\nNote: Analyzing document preview/first page';
        }
      }
      // Check if this is HTML content or generated document
      else if (item.type === 'html' || item.metadata?.type === 'generated-document' || fileExt === '.html') {
        console.log('[AI Metadata] Processing as HTML/generated document');
        
        // Use the actual HTML content if available
        content = item.html || item.content || item.preview || 'No content available';
        contentType = 'html';
        
        // If it's a generated document, add context
        if (item.metadata?.type === 'generated-document') {
          const templateName = item.metadata?.templateName || 'Unknown';
          const generatedAt = item.metadata?.generatedAt ? new Date(item.metadata.generatedAt).toLocaleDateString() : 'Unknown date';
          content = `Generated Document (${templateName}) created on ${generatedAt}:\n\n${content}`;
        }
        
        console.log('[AI Metadata] Using HTML content, length:', content.length);
      }
      // Check if this is code
      else if (codeExtensions.includes(fileExt)) {
        console.log('[AI Metadata] Processing as code file');
        
        // Load code content if available
        if (item.content || item.text) {
          content = item.content || item.text;
          contentType = 'code';
        } else if (item.filePath && fs.existsSync(item.filePath)) {
          try {
            content = fs.readFileSync(item.filePath, 'utf8');
            contentType = 'code';
          } catch (e) {
            content = `Code file: ${item.fileName}`;
            contentType = 'file';
          }
        } else {
          content = item.preview || item.fileName || 'Code file';
          contentType = 'code';
        }
      }
      // Check if this is data file
      else if (dataExtensions.includes(fileExt)) {
        console.log('[AI Metadata] Processing as data file');
        
        // Load data content if available
        if (item.content || item.text) {
          content = item.content || item.text;
          contentType = 'data';
        } else if (item.filePath && fs.existsSync(item.filePath)) {
          try {
            content = fs.readFileSync(item.filePath, 'utf8');
            contentType = 'data';
          } catch (e) {
            content = `Data file: ${item.fileName}`;
            contentType = 'file';
          }
        } else {
          content = item.preview || item.fileName || 'Data file';
          contentType = 'data';
        }
      }
      // Plain text files
      else if (textExtensions.includes(fileExt) || item.type === 'text') {
        console.log('[AI Metadata] Processing as text content');
        
        content = item.content || item.text || item.preview || '';
        contentType = 'text';
        
        // Try to load from file if needed
        if (!content && item.filePath && fs.existsSync(item.filePath)) {
          try {
            content = fs.readFileSync(item.filePath, 'utf8');
          } catch (e) {
            content = item.fileName || 'Text file';
          }
        }
      }
      // Audio files
      else if (audioExtensions.includes(fileExt) || item.fileCategory === 'audio' || item.fileType === 'audio') {
        console.log('[AI Metadata] Processing as audio file');
        
        content = [
          `Audio file: ${item.fileName || 'Unknown'}`,
          `Format: ${fileExt || 'Unknown'}`,
          `Size: ${item.fileSize ? this.formatFileSize(item.fileSize) : 'Unknown'}`,
          item.metadata?.duration ? `Duration: ${item.metadata.duration}` : '',
          item.metadata?.artist ? `Artist: ${item.metadata.artist}` : '',
          item.metadata?.album ? `Album: ${item.metadata.album}` : '',
          item.metadata?.title ? `Title: ${item.metadata.title}` : ''
        ].filter(Boolean).join('\n');
        
        contentType = 'audio';
      }
      // Video files
      else if (videoExtensions.includes(fileExt) || item.fileCategory === 'video' || item.fileType === 'video') {
        console.log('[AI Metadata] Processing as video file');
        
        content = [
          `Video file: ${item.fileName || 'Unknown'}`,
          `Format: ${fileExt || 'Unknown'}`,
          `Size: ${item.fileSize ? this.formatFileSize(item.fileSize) : 'Unknown'}`,
          item.metadata?.duration ? `Duration: ${item.metadata.duration}` : '',
          item.metadata?.resolution ? `Resolution: ${item.metadata.resolution}` : ''
        ].filter(Boolean).join('\n');
        
        contentType = 'video';
        
        // If we have a thumbnail, use vision to analyze frame
        if (item.thumbnail && !item.thumbnail.includes('svg+xml') && item.thumbnail.length > 1000) {
          imageData = item.thumbnail;
          content += '\n\nAnalyzing video thumbnail/preview frame:';
        }
      }
      // Archive files
      else if (archiveExtensions.includes(fileExt) || item.fileCategory === 'archive') {
        console.log('[AI Metadata] Processing as archive file');
        
        content = [
          `Archive file: ${item.fileName || 'Unknown'}`,
          `Format: ${fileExt || 'Unknown'}`,
          `Size: ${item.fileSize ? this.formatFileSize(item.fileSize) : 'Unknown'}`,
          'Compressed archive - contents not directly accessible'
        ].join('\n');
        
        contentType = 'archive';
      }
      // Generic file handling
      else if (item.type === 'file') {
        console.log('[AI Metadata] Processing as generic file');
        
        const fileInfo = [
          `Filename: ${item.fileName || 'Unknown'}`,
          `Type: ${item.fileType || fileExt || 'Unknown'}`,
          `Category: ${item.fileCategory || 'Unknown'}`,
          `Size: ${item.fileSize ? this.formatFileSize(item.fileSize) : 'Unknown'}`
        ].join('\n');
        
        content = fileInfo;
        contentType = 'file';
      }
      // Default fallback
      else {
        console.log('[AI Metadata] Using default text analysis');
        content = item.content || item.text || item.preview || item.fileName || 'No content available';
        contentType = 'text';
      }
      
      // Ensure content is not empty
      if (!content && !imageData) {
        console.log('[AI Metadata] No content available, using fallback');
        content = item.preview || item.fileName || 'No content available';
      }
      
      console.log('[AI Metadata] Final analysis type:', contentType, 'Has image data:', !!imageData);
      
      // Generate metadata using Claude
      const generatedMetadata = await claudeAPI.generateMetadata(
        content,
        contentType,
        apiKey,
        customPrompt,
        imageData
      );
      
      // Merge with existing metadata and ensure all fields are populated
      const updatedMetadata = {
        ...item.metadata,
        ...generatedMetadata,
        // Ensure file-specific metadata is preserved
        fileName: item.fileName,
        fileSize: item.fileSize,
        fileType: item.fileType,
        fileCategory: item.fileCategory,
        fileExt: item.fileExt,
        isScreenshot: item.isScreenshot,
        // AI metadata fields
        ai_metadata_generated: true,
        ai_metadata_timestamp: Date.now(),
        ai_used_vision: !!imageData,
        ai_analyzed_content_type: contentType
      };
      
      console.log('[AI Metadata] Generated metadata for', contentType, 'with vision:', !!imageData);
      
      // Update the item's metadata
      const updateResult = await this.updateItemMetadata(itemId, updatedMetadata);
      
      return updateResult;
    } catch (error) {
      console.error('Error generating AI metadata:', error);
      return { 
        success: false, 
        error: error.message || 'Failed to generate metadata' 
      };
    }
  }
  
  // Migration check
  checkAndMigrate() {
    const statusPath = path.join(__dirname, '.storage-v2-status');
    
    try {
      if (fs.existsSync(statusPath)) {
        const status = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
        
        if (!status.migrated) {
          console.log('[V2] Migration needed, running migration...');
          
          // Run migration
          const StorageMigration = require('./migrate-to-v2-storage');
          const migration = new StorageMigration();
          const result = migration.migrate();
          
          if (result.success) {
            // Update status
            status.migrated = true;
            status.migratedAt = new Date().toISOString();
            status.itemsMigrated = result.itemsMigrated;
            fs.writeFileSync(statusPath, JSON.stringify(status, null, 2));
            
            console.log(`[V2] Migration complete! Migrated ${result.itemsMigrated} items`);
          } else {
            console.error('[V2] Migration failed:', result.error);
          }
        } else {
          console.log('[V2] Already migrated');
        }
      }
    } catch (error) {
      console.error('[V2] Error checking migration status:', error);
    }
  }
  
  // Generate real PDF thumbnail using qlmanage (like Finder)
  async generateRealPDFThumbnail(filePath, item) {
    // Windows compatibility: Return placeholder for now
    if (process.platform !== 'darwin') {
      console.log('[V2-PDF] Non-macOS platform detected, using placeholder');
      const fileName = path.basename(filePath);
      const fileSize = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
      return this.generatePDFThumbnail(fileName, fileSize);
    }
    
    const { exec } = require('child_process');
    const { promisify } = require('util');
    const execAsync = promisify(exec);
    
    console.log('[V2-PDF] Starting real thumbnail generation for:', filePath);
    
    // Add a small delay to ensure file is fully written
    await new Promise(resolve => setTimeout(resolve, 500));
    
    try {
      // Verify file exists and has content
      const stats = fs.statSync(filePath);
      console.log('[V2-PDF] PDF file size:', stats.size, 'bytes');
      
      // Create temp directory
      let tempDir = path.join(app.getPath('temp'), 'pdf-thumbnails-v2', Date.now().toString());
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }
      console.log('[V2-PDF] Temp directory:', tempDir);
      
      // Try qlmanage first
      try {
        const command = `/usr/bin/qlmanage -t -s 512 -o "${tempDir}" "${filePath}" 2>&1`;
        console.log('[V2-PDF] Running command:', command);
        
        const { stdout, stderr } = await execAsync(command, {
          timeout: 15000,
          maxBuffer: 1024 * 1024 * 10,
          env: { ...process.env, PATH: '/usr/bin:/bin:/usr/sbin:/sbin:' + process.env.PATH }
        });
        
        if (stdout) console.log('[V2-PDF] qlmanage stdout:', stdout);
        if (stderr) console.log('[V2-PDF] qlmanage stderr:', stderr);
        
        // Wait a bit for qlmanage to finish writing
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        // List all files in temp directory to see what was generated
        const generatedFiles = fs.readdirSync(tempDir);
        console.log('[V2-PDF] Generated files:', generatedFiles);
        
        // Find the thumbnail - qlmanage adds a suffix
        let thumbnailPath = null;
        for (const file of generatedFiles) {
          if (file.endsWith('.png')) {
            thumbnailPath = path.join(tempDir, file);
            const thumbStats = fs.statSync(thumbnailPath);
            console.log('[V2-PDF] Found thumbnail:', file, 'size:', thumbStats.size, 'bytes');
            
            // Check if thumbnail has reasonable size (not just placeholder)
            if (thumbStats.size > 5000) { // More than 5KB suggests real thumbnail
              break;
            } else {
              console.log('[V2-PDF] Thumbnail too small, might be placeholder');
              thumbnailPath = null;
            }
          }
        }
        
        if (thumbnailPath && fs.existsSync(thumbnailPath)) {
          console.log('[V2-PDF] Reading thumbnail from:', thumbnailPath);
          const thumbnailBuffer = fs.readFileSync(thumbnailPath);
          const base64 = thumbnailBuffer.toString('base64');
          const dataUrl = `data:image/png;base64,${base64}`;
          
          console.log('[V2-PDF] Thumbnail data URL length:', dataUrl.length);
          
          // Update the item thumbnail immediately
          item.thumbnail = dataUrl;
          
          // Find item in history and update thumbnail immediately
          const historyItem = this.history.find(h => h.id === item.id);
          if (historyItem) {
            historyItem.thumbnail = dataUrl;
            // Set default page count first
            historyItem.pageCount = 1;
            this.notifyHistoryUpdate();
            console.log('[V2-PDF] Updated item with real thumbnail immediately');
          }
          
          // Get page count asynchronously (don't block thumbnail display)
          this.getPDFPageCount(filePath).then(pageCount => {
            console.log('[V2-PDF] Async page count result:', pageCount);
            item.pageCount = pageCount;
            
            // Update history item with correct page count
            const historyItem = this.history.find(h => h.id === item.id);
            if (historyItem && historyItem.pageCount !== pageCount) {
              historyItem.pageCount = pageCount;
              this.notifyHistoryUpdate();
              console.log('[V2-PDF] Updated page count to:', pageCount);
            }
          }).catch(err => {
            console.error('[V2-PDF] Error getting page count:', err);
          });
          
          // Clean up temp directory
          try {
            fs.rmSync(tempDir, { recursive: true, force: true });
          } catch (e) {
            console.error('[V2-PDF] Error cleaning up temp dir:', e);
          }
          
          return dataUrl;
        } else {
          console.log('[V2-PDF] No valid thumbnail found');
        }
      } catch (qlError) {
        console.error('[V2-PDF] qlmanage error:', qlError.message);
        console.error('[V2-PDF] Full error:', qlError);
      }
      
      // Clean up temp directory if still exists
      try {
        if (fs.existsSync(tempDir)) {
          fs.rmSync(tempDir, { recursive: true, force: true });
        }
      } catch (e) {
        // Ignore
      }
      
    } catch (error) {
      console.error('[V2-PDF] Error generating real thumbnail:', error);
    }
    
    console.log('[V2-PDF] Using placeholder thumbnail');
  }
  
  // Get PDF page count with multiple fallback methods
  async getPDFPageCount(filePath) {
    const { exec } = require('child_process');
    const { promisify } = require('util');
    const execAsync = promisify(exec);
    
    // First attempt: Try using file command to get PDF info (fastest)
    try {
      const fileCommand = `/usr/bin/file -b "${filePath}"`;
      const { stdout } = await execAsync(fileCommand, { timeout: 2000 });
      console.log('[V2-PDF] file command output:', stdout);
      
      // Some PDFs might have page info in file output
      const pageMatch = stdout.match(/(\d+)\s*pages?/i);
      if (pageMatch) {
        const pageCount = parseInt(pageMatch[1]);
        if (!isNaN(pageCount) && pageCount > 0) {
          console.log('[V2-PDF] Page count from file command:', pageCount);
          return pageCount;
        }
      }
    } catch (error) {
      console.error('[V2-PDF] Error getting page count with file command:', error.message);
    }
    
    // Second attempt: Look for page count in PDF structure using strings
    try {
      // PDFs often contain /N entries indicating page count
      const stringsCommand = `/usr/bin/strings "${filePath}" | grep -E "^/N [0-9]+" | head -1`;
      const { stdout } = await execAsync(stringsCommand, { timeout: 3000 });
      
      if (stdout) {
        const match = stdout.match(/\/N\s+(\d+)/);
        if (match) {
          const pageCount = parseInt(match[1]);
          if (!isNaN(pageCount) && pageCount > 0) {
            console.log('[V2-PDF] Page count from PDF structure:', pageCount);
            return pageCount;
          }
        }
      }
    } catch (error) {
      console.error('[V2-PDF] Error parsing PDF structure:', error.message);
    }
    
    // Third attempt: Use mdls (only if file has been indexed)
    try {
      const command = `/usr/bin/mdls -name kMDItemNumberOfPages -raw "${filePath}"`;
      const { stdout } = await execAsync(command, { timeout: 2000 });
      
      // Clean up the output (remove % sign and whitespace)
      const cleanOutput = stdout.trim().replace('%', '');
      const pageCount = parseInt(cleanOutput);
      
      if (!isNaN(pageCount) && pageCount > 0) {
        console.log('[V2-PDF] Page count from mdls:', pageCount);
        return pageCount;
      }
    } catch (error) {
      console.error('[V2-PDF] Error getting page count with mdls:', error.message);
    }
    
    console.log('[V2-PDF] Could not determine page count, defaulting to 1');
    return 1; // Default to 1 page if we can't determine
  }
  
  // Generate PDF thumbnail for specific page
  async generatePDFPageThumbnail(filePath, pageNumber = 1) {
    const { exec } = require('child_process');
    const { promisify } = require('util');
    const execAsync = promisify(exec);
    
    // This method handles page-specific thumbnail requests
    console.log('[V2-PDF-PAGE] Generating thumbnail for page:', pageNumber);
    
    // Since macOS tools can only generate page 1 thumbnails,
    // we'll return the existing thumbnail from the history item
    // The UI will show an overlay for pages other than 1
    
    // Try to find the item by file path
    const item = this.history.find(h => h.filePath === filePath);
    if (item && item.thumbnail && !item.thumbnail.includes('svg+xml')) {
      console.log('[V2-PDF-PAGE] Returning existing thumbnail from history');
      return item.thumbnail;
    }
    
    // If no existing thumbnail, try to generate one
    try {
      // Create temp directory
      let tempDir = path.join(app.getPath('temp'), 'pdf-page-thumbnails', Date.now().toString());
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }
      
      const outputPath = path.join(tempDir, 'page.png');
      
      // Use qlmanage to extract page 1 thumbnail
      const command = `/usr/bin/qlmanage -t -s 512 -o "${tempDir}" "${filePath}" 2>&1`;
      console.log('[V2-PDF-PAGE] Using qlmanage to extract thumbnail');
      
      try {
        const { stdout, stderr } = await execAsync(command, {
          timeout: 15000,
          maxBuffer: 1024 * 1024 * 10
        });
        
        if (stdout) console.log('[V2-PDF-PAGE] qlmanage stdout:', stdout);
        if (stderr) console.log('[V2-PDF-PAGE] qlmanage stderr:', stderr);
        
        // Find the generated thumbnail
        const generatedFiles = fs.readdirSync(tempDir);
        let thumbnailPath = null;
        
        for (const file of generatedFiles) {
          if (file.endsWith('.png')) {
            thumbnailPath = path.join(tempDir, file);
            break;
          }
        }
        
        if (thumbnailPath && fs.existsSync(thumbnailPath)) {
          const thumbnailBuffer = fs.readFileSync(thumbnailPath);
          const base64 = thumbnailBuffer.toString('base64');
          let dataUrl = `data:image/png;base64,${base64}`;
          
          console.log('[V2-PDF-PAGE] Generated thumbnail for page 1 (all pages show page 1 preview)');
          
          // Clean up
          try {
            fs.rmSync(tempDir, { recursive: true, force: true });
          } catch (e) {
            // Ignore
          }
          
          return dataUrl;
        }
      } catch (error) {
        console.error('[V2-PDF-PAGE] qlmanage error:', error.message);
      }
      
      // Clean up temp directory if still exists
      try {
        if (fs.existsSync(tempDir)) {
          fs.rmSync(tempDir, { recursive: true, force: true });
        }
      } catch (e) {
        // Ignore
      }
      
    } catch (error) {
      console.error('[V2-PDF-PAGE] Error generating page thumbnail:', error);
    }
    
    // Return placeholder if all else fails
    return this.generatePDFThumbnail(path.basename(filePath), 0);
  }
  
  // Get MIME type from file extension
  getMimeTypeFromExtension(ext) {
    const mimeTypes = {
      // Common web image formats
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.jfif': 'image/jpeg',
      '.pjpeg': 'image/jpeg',
      '.pjp': 'image/jpeg',
      '.png': 'image/png',
      '.apng': 'image/apng',
      '.gif': 'image/gif',
      '.bmp': 'image/bmp',
      '.webp': 'image/webp',
      '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon',
      // Modern formats
      '.avif': 'image/avif',
      '.heic': 'image/heic',
      '.heif': 'image/heif',
      // TIFF
      '.tiff': 'image/tiff',
      '.tif': 'image/tiff'
    };
    return mimeTypes[ext.toLowerCase()] || 'application/octet-stream';
  }
  
  // Detect image MIME type from buffer using magic bytes
  detectImageMimeType(buffer) {
    if (!buffer || buffer.length < 4) {
      return 'image/png'; // Default fallback
    }
    
    // Check magic bytes
    // JPEG: FF D8 FF
    if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
      return 'image/jpeg';
    }
    // PNG: 89 50 4E 47
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
      return 'image/png';
    }
    // GIF: 47 49 46 38
    if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) {
      return 'image/gif';
    }
    // WebP: 52 49 46 46 ... 57 45 42 50
    if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
        buffer.length > 11 && buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) {
      return 'image/webp';
    }
    // BMP: 42 4D
    if (buffer[0] === 0x42 && buffer[1] === 0x4D) {
      return 'image/bmp';
    }
    
    // Default to PNG
    return 'image/png';
  }
  
  // Generate a placeholder thumbnail for PDF files
  generatePDFThumbnail(fileName, fileSize) {
    try {
      // Create a clean SVG thumbnail for PDF files
      const maxChars = 20;
      const displayName = fileName.length > maxChars ? 
        fileName.substring(0, maxChars - 3) + '...' : fileName;
      
      // Escape special characters for XML/SVG
      const escapedName = displayName
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
      
      const formattedSize = this.formatFileSize(fileSize)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
      
      // Create SVG that will render properly as an image
      const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="200" height="260" viewBox="0 0 200 260" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <filter id="shadow" x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur in="SourceAlpha" stdDeviation="2"/>
      <feOffset dx="2" dy="2" result="offsetblur"/>
      <feFlood flood-color="#000000" flood-opacity="0.1"/>
      <feComposite in2="offsetblur" operator="in"/>
      <feMerge>
        <feMergeNode/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>
  </defs>
  
  <!-- Background -->
  <rect width="200" height="260" fill="#f5f5f5"/>
  
  <!-- Document shape -->
  <g filter="url(#shadow)">
    <rect x="20" y="20" width="160" height="220" rx="2" fill="white" stroke="#ddd" stroke-width="1"/>
  </g>
  
  <!-- PDF icon background -->
  <rect x="60" y="40" width="80" height="50" rx="4" fill="#dc2626"/>
  
  <!-- PDF text -->
  <text x="100" y="72" text-anchor="middle" font-family="Arial, sans-serif" font-size="28" font-weight="bold" fill="white">PDF</text>
  
  <!-- File name -->
  <text x="100" y="120" text-anchor="middle" font-family="Arial, sans-serif" font-size="13" fill="#333">${escapedName}</text>
  
  <!-- File size -->
  <text x="100" y="140" text-anchor="middle" font-family="Arial, sans-serif" font-size="11" fill="#666">${formattedSize}</text>
  
  <!-- Document lines -->
  <g stroke="#e5e5e5" stroke-width="1">
    <line x1="30" y1="160" x2="170" y2="160"/>
    <line x1="30" y1="175" x2="170" y2="175"/>
    <line x1="30" y1="190" x2="170" y2="190"/>
    <line x1="30" y1="205" x2="170" y2="205"/>
    <line x1="30" y1="220" x2="140" y2="220"/>
  </g>
  
  <!-- Folded corner -->
  <path d="M 160 20 L 180 40 L 160 40 Z" fill="#f0f0f0" stroke="#ddd" stroke-width="1"/>
</svg>`;
      
      // Convert to base64 data URL
      const base64 = Buffer.from(svg, 'utf8').toString('base64');
      return `data:image/svg+xml;base64,${base64}`;
      
    } catch (error) {
      console.error('Error generating PDF thumbnail:', error);
      
      // Simple fallback SVG
      const fallbackSvg = `<svg width="200" height="260" xmlns="http://www.w3.org/2000/svg">
        <rect width="200" height="260" fill="#f5f5f5"/>
        <rect x="20" y="20" width="160" height="220" fill="white" stroke="#ddd"/>
        <rect x="60" y="60" width="80" height="40" fill="#dc2626"/>
        <text x="100" y="87" text-anchor="middle" font-size="24" font-weight="bold" fill="white">PDF</text>
      </svg>`;
      
      return `data:image/svg+xml;base64,${Buffer.from(fallbackSvg).toString('base64')}`;
    }
  }
  
  // Generate a preview thumbnail for HTML files
  generateHTMLThumbnail(fileName, fileSize) {
    try {
      // Create a clean SVG thumbnail for HTML files
      const maxChars = 20;
      const displayName = fileName.length > maxChars ? 
        fileName.substring(0, maxChars - 3) + '...' : fileName;
      
      // Escape special characters for XML/SVG
      const escapedName = displayName
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
      
      const formattedSize = this.formatFileSize(fileSize)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
      
      // Create SVG that will render properly as an image
      const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="200" height="260" viewBox="0 0 200 260" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <filter id="shadow" x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur in="SourceAlpha" stdDeviation="2"/>
      <feOffset dx="2" dy="2" result="offsetblur"/>
      <feFlood flood-color="#000000" flood-opacity="0.1"/>
      <feComposite in2="offsetblur" operator="in"/>
      <feMerge>
        <feMergeNode/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>
  </defs>
  
  <!-- Background -->
  <rect width="200" height="260" fill="#f8f8f8"/>
  
  <!-- Document shape -->
  <g filter="url(#shadow)">
    <rect x="20" y="20" width="160" height="220" rx="2" fill="white" stroke="#ddd" stroke-width="1"/>
  </g>
  
  <!-- HTML tags icon -->
  <text x="100" y="65" text-anchor="middle" font-family="monospace" font-size="24" font-weight="bold" fill="#e34c26">&lt;/&gt;</text>
  
  <!-- HTML label -->
  <rect x="70" y="80" width="60" height="20" rx="3" fill="#e34c26"/>
  <text x="100" y="95" text-anchor="middle" font-family="Arial, sans-serif" font-size="12" font-weight="bold" fill="white">HTML</text>
  
  <!-- File name -->
  <text x="100" y="125" text-anchor="middle" font-family="Arial, sans-serif" font-size="13" fill="#333">${escapedName}</text>
  
  <!-- File size -->
  <text x="100" y="145" text-anchor="middle" font-family="Arial, sans-serif" font-size="11" fill="#666">${formattedSize}</text>
  
  <!-- Code preview lines (HTML-like) -->
  <g font-family="monospace" font-size="9" fill="#666">
    <text x="30" y="170">&lt;div class="container"&gt;</text>
    <text x="40" y="182" fill="#e34c26">&lt;h1&gt;</text>
    <text x="62" y="182">Title</text>
    <text x="87" y="182" fill="#e34c26">&lt;/h1&gt;</text>
    <text x="40" y="194" fill="#e34c26">&lt;p&gt;</text>
    <text x="55" y="194">Content...</text>
    <text x="105" y="194" fill="#e34c26">&lt;/p&gt;</text>
    <text x="30" y="206">&lt;/div&gt;</text>
  </g>
  
  <!-- Folded corner -->
  <path d="M 160 20 L 180 40 L 160 40 Z" fill="#f0f0f0" stroke="#ddd" stroke-width="1"/>
</svg>`;
      
      // Convert to base64 data URL
      const base64 = Buffer.from(svg, 'utf8').toString('base64');
      return `data:image/svg+xml;base64,${base64}`;
      
    } catch (error) {
      console.error('Error generating HTML thumbnail:', error);
      
      // Simple fallback SVG
      const fallbackSvg = `<svg width="200" height="260" xmlns="http://www.w3.org/2000/svg">
        <rect width="200" height="260" fill="#f8f8f8"/>
        <rect x="20" y="20" width="160" height="220" fill="white" stroke="#ddd"/>
        <text x="100" y="70" text-anchor="middle" font-family="monospace" font-size="30" font-weight="bold" fill="#e34c26">&lt;/&gt;</text>
        <rect x="70" y="85" width="60" height="20" fill="#e34c26"/>
        <text x="100" y="99" text-anchor="middle" font-size="12" font-weight="bold" fill="white">HTML</text>
      </svg>`;
      
      return `data:image/svg+xml;base64,${Buffer.from(fallbackSvg).toString('base64')}`;
    }
  }
  
  // Generate a preview thumbnail for Jupyter notebook files
  generateNotebookThumbnail(fileName, fileSize) {
    try {
      // Create a clean SVG thumbnail for Jupyter notebooks
      const maxChars = 20;
      const displayName = fileName.length > maxChars ? 
        fileName.substring(0, maxChars - 3) + '...' : fileName;
      
      // Escape special characters for XML/SVG
      const escapedName = displayName
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
      
      const formattedSize = this.formatFileSize(fileSize)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
      
      // Create SVG that will render properly as an image
      const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="200" height="260" viewBox="0 0 200 260" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <filter id="shadow" x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur in="SourceAlpha" stdDeviation="2"/>
      <feOffset dx="2" dy="2" result="offsetblur"/>
      <feFlood flood-color="#000000" flood-opacity="0.1"/>
      <feComposite in2="offsetblur" operator="in"/>
      <feMerge>
        <feMergeNode/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>
  </defs>
  
  <!-- Background -->
  <rect width="200" height="260" fill="#f8f8f8"/>
  
  <!-- Document shape -->
  <g filter="url(#shadow)">
    <rect x="20" y="20" width="160" height="220" rx="2" fill="white" stroke="#ddd" stroke-width="1"/>
  </g>
  
  <!-- Jupyter notebook icon background -->
  <rect x="50" y="35" width="100" height="60" rx="4" fill="#f37626"/>
  
  <!-- Jupyter logo approximation -->
  <g transform="translate(100, 65)">
    <!-- Jupiter planet circle -->
    <circle cx="0" cy="0" r="18" fill="white"/>
    <circle cx="-3" cy="-2" r="12" fill="#f37626"/>
    <!-- Orbit lines -->
    <ellipse cx="0" cy="0" rx="25" ry="8" fill="none" stroke="white" stroke-width="2" opacity="0.8"/>
  </g>
  
  <!-- Jupyter text -->
  <text x="100" y="110" text-anchor="middle" font-family="Arial, sans-serif" font-size="12" font-weight="bold" fill="#333">JUPYTER</text>
  
  <!-- File name -->
  <text x="100" y="130" text-anchor="middle" font-family="Arial, sans-serif" font-size="13" fill="#333">${escapedName}</text>
  
  <!-- File size -->
  <text x="100" y="150" text-anchor="middle" font-family="Arial, sans-serif" font-size="11" fill="#666">${formattedSize}</text>
  
  <!-- Code cells representation -->
  <g stroke="#e5e5e5" stroke-width="1" fill="#f8f8f8">
    <!-- Cell 1 -->
    <rect x="30" y="170" width="140" height="20" rx="2" fill="#f8f8f8" stroke="#e5e5e5"/>
    <text x="35" y="183" font-family="monospace" font-size="8" fill="#666">In [1]: import pandas as pd</text>
    
    <!-- Cell 2 -->
    <rect x="30" y="195" width="140" height="20" rx="2" fill="#f8f8f8" stroke="#e5e5e5"/>
    <text x="35" y="208" font-family="monospace" font-size="8" fill="#666">In [2]: df.head()</text>
  </g>
  
  <!-- Folded corner -->
  <path d="M 160 20 L 180 40 L 160 40 Z" fill="#f0f0f0" stroke="#ddd" stroke-width="1"/>
</svg>`;
      
      // Convert to base64 data URL
      const base64 = Buffer.from(svg, 'utf8').toString('base64');
      return `data:image/svg+xml;base64,${base64}`;
      
    } catch (error) {
      console.error('Error generating notebook thumbnail:', error);
      
      // Simple fallback SVG
      const fallbackSvg = `<svg width="200" height="260" xmlns="http://www.w3.org/2000/svg">
        <rect width="200" height="260" fill="#f8f8f8"/>
        <rect x="20" y="20" width="160" height="220" fill="white" stroke="#ddd"/>
        <rect x="50" y="60" width="100" height="40" fill="#f37626"/>
        <text x="100" y="85" text-anchor="middle" font-size="20" font-weight="bold" fill="white">JUPYTER</text>
      </svg>`;
      
      return `data:image/svg+xml;base64,${Buffer.from(fallbackSvg).toString('base64')}`;
    }
  }
  
  // Generate text file preview using Quick Look
  async generateTextPreview(filePath, item) {
    const { exec } = require('child_process');
    const { promisify } = require('util');
    const execAsync = promisify(exec);
    
    console.log('[V2-TEXT] Starting text preview generation for:', filePath);
    
    try {
      // For text files, we'll use qlmanage to generate a preview
      let tempDir = path.join(app.getPath('temp'), 'text-previews-v2', Date.now().toString());
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }
      
      // Use qlmanage to generate preview
      const command = `/usr/bin/qlmanage -t -s 512 -o "${tempDir}" "${filePath}" 2>&1`;
      console.log('[V2-TEXT] Running command:', command);
      
      const { stdout, stderr } = await execAsync(command, { 
        timeout: 10000,
        env: { ...process.env, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }
      });
      
      console.log('[V2-TEXT] qlmanage stdout:', stdout);
      if (stderr) console.log('[V2-TEXT] qlmanage stderr:', stderr);
      
      // Check if thumbnail was generated
      const files = fs.readdirSync(tempDir);
      console.log('[V2-TEXT] Generated files:', files);
      
      const thumbnailFile = files.find(f => f.endsWith('.png'));
      if (thumbnailFile) {
        const thumbnailPath = path.join(tempDir, thumbnailFile);
        console.log('[V2-TEXT] Found thumbnail:', thumbnailFile, 'size:', fs.statSync(thumbnailPath).size, 'bytes');
        
        // Read the thumbnail
        const thumbnailBuffer = fs.readFileSync(thumbnailPath);
        const base64 = thumbnailBuffer.toString('base64');
        const dataUrl = `data:image/png;base64,${base64}`;
        
        // Clean up temp files
        try {
          fs.unlinkSync(thumbnailPath);
          fs.rmdirSync(tempDir, { recursive: true });
        } catch (e) {
          console.error('[V2-TEXT] Error cleaning up temp files:', e.message);
        }
        
        return dataUrl;
      } else {
        // If qlmanage didn't generate a preview, create a custom preview
        console.log('[V2-TEXT] No thumbnail generated by qlmanage, creating custom preview');
        return this.createCustomTextPreview(filePath, item);
      }
    } catch (error) {
      console.error('[V2-TEXT] Error generating text preview:', error.message);
      // Fallback to custom preview
      return this.createCustomTextPreview(filePath, item);
    }
  }
  
  // Create custom text preview when Quick Look fails
  createCustomTextPreview(filePath, item) {
    try {
      // Read first 500 characters of the file
      const content = fs.readFileSync(filePath, 'utf8');
      const preview = content.substring(0, 500);
      const lines = preview.split('\n').slice(0, 15); // First 15 lines
      
      // Determine if it's code based on extension
      const codeExtensions = ['.js', '.ts', '.jsx', '.tsx', '.json', '.html', '.css', '.py', '.java', '.cpp', '.c', '.h', '.rb', '.go', '.rs', '.swift', '.kt', '.php', '.sh', '.yaml', '.yml', '.xml'];
      const isCode = codeExtensions.includes(item.fileExt);
      
      // Create SVG preview
      const fontSize = 10;
      const lineHeight = 14;
      const padding = 20;
      const width = 400;
      const height = Math.min(300, lines.length * lineHeight + padding * 2);
      
      // Escape text for SVG
      const escapeXml = (text) => {
        return text
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&apos;');
      };
      
      const svg = `
        <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
          <rect width="${width}" height="${height}" fill="${isCode ? '#1e1e1e' : '#ffffff'}" rx="8"/>
          <g transform="translate(${padding}, ${padding})">
            ${lines.map((line, i) => 
              `<text x="0" y="${(i + 1) * lineHeight}" 
                     font-family="SF Mono, Monaco, monospace" 
                     font-size="${fontSize}" 
                     fill="${isCode ? '#d4d4d4' : '#333333'}">
                ${escapeXml(line)}
              </text>`
            ).join('')}
          </g>
          ${lines.length === 15 ? 
            `<text x="${width/2}" y="${height - 10}" 
                   text-anchor="middle" 
                   font-family="SF Pro Display, system-ui" 
                   font-size="10" 
                   fill="${isCode ? '#888888' : '#999999'}">
              ... ${content.split('\n').length} lines total ...
            </text>` : ''}
        </svg>
      `;
      
      // Convert SVG to data URL
      const svgBase64 = Buffer.from(svg).toString('base64');
      return `data:image/svg+xml;base64,${svgBase64}`;
      
    } catch (error) {
      console.error('[V2-TEXT] Error creating custom text preview:', error);
      // Return a generic text icon
      return this.createTextIcon(item);
    }
  }
  
  // Create a generic text icon
  createTextIcon(item) {
    const icon = item.fileCategory === 'code' ? '{ }' : '▬';
    const svg = `
      <svg width="200" height="200" xmlns="http://www.w3.org/2000/svg">
        <rect width="200" height="200" fill="#f5f5f5" rx="16"/>
        <text x="100" y="100" text-anchor="middle" font-size="64" fill="#666">${icon}</text>
        <text x="100" y="140" text-anchor="middle" font-size="14" fill="#666">${item.fileExt || 'TEXT'}</text>
      </svg>
    `;
    const svgBase64 = Buffer.from(svg).toString('base64');
    return `data:image/svg+xml;base64,${svgBase64}`;
  }
  
  // Generate audio preview
  async generateAudioPreview(filePath, item) {
    // Implementation needed
  }
  
  getAudioMimeType(ext) {
    const mimeTypes = {
      '.mp3': 'audio/mpeg',
      '.wav': 'audio/wav',
      '.flac': 'audio/flac',
      '.aac': 'audio/aac',
      '.ogg': 'audio/ogg',
      '.wma': 'audio/x-ms-wma',
      '.m4a': 'audio/mp4',
      '.opus': 'audio/opus',
      '.aiff': 'audio/aiff',
      '.ape': 'audio/ape',
      '.amr': 'audio/amr',
      '.au': 'audio/basic'
    };
    return mimeTypes[ext] || 'audio/mpeg';
  }
  
  getMediaMimeType(ext, fileType) {
    // Audio MIME types
    const audioMimeTypes = {
      '.mp3': 'audio/mpeg',
      '.wav': 'audio/wav',
      '.flac': 'audio/flac',
      '.aac': 'audio/aac',
      '.ogg': 'audio/ogg',
      '.wma': 'audio/x-ms-wma',
      '.m4a': 'audio/mp4',
      '.opus': 'audio/opus',
      '.aiff': 'audio/aiff',
      '.webm': 'audio/webm'
    };
    
    // Video MIME types
    const videoMimeTypes = {
      '.mp4': 'video/mp4',
      '.mov': 'video/quicktime',
      '.avi': 'video/x-msvideo',
      '.mkv': 'video/x-matroska',
      '.wmv': 'video/x-ms-wmv',
      '.flv': 'video/x-flv',
      '.webm': 'video/webm',
      '.m4v': 'video/mp4',
      '.mpeg': 'video/mpeg',
      '.mpg': 'video/mpeg',
      '.3gp': 'video/3gpp'
    };
    
    // Check audio first
    if (audioMimeTypes[ext]) return audioMimeTypes[ext];
    
    // Check video
    if (videoMimeTypes[ext]) return videoMimeTypes[ext];
    
    // Default based on fileType
    if (fileType === 'video') return 'video/mp4';
    return 'audio/mpeg';
  }
  
  // Add missing method from original
  registerShortcut() {
    if (!globalShortcut) {
      console.log('Global shortcuts not available in non-Electron environment');
      return;
    }
    
    // Register global shortcut for clipboard viewer
    const shortcut = process.platform === 'darwin' ? 'Cmd+Shift+V' : 'Ctrl+Shift+V';
    
    globalShortcut.register(shortcut, () => {
      console.log('Clipboard viewer shortcut triggered');
      this.createClipboardWindow();
    });
    
    console.log(`Registered global shortcut: ${shortcut}`);
  }
  
  
  startWebsiteMonitoring() {
    // Check websites every 30 minutes
    this.websiteCheckInterval = setInterval(async () => {
      try {
        if (!this.websiteMonitor) {
          const WebsiteMonitor = require('./website-monitor');
          this.websiteMonitor = new WebsiteMonitor();
          await this.websiteMonitor.initialize();
        }
        
        console.log('Running periodic website checks...');
        const results = await this.websiteMonitor.checkAllMonitors();
        
        // Process results and add changes to clipboard
        results.forEach(result => {
          if (result.changed && result.monitor && result.monitor.spaceId) {
            const change = {
              type: 'text',
              content: `Website Changed: ${result.monitor.name}\n\nURL: ${result.monitor.url}\n\nLast Changed: ${new Date(result.monitor.lastChanged).toLocaleString()}\n\nView changes in the website monitor.`,
              preview: `Website Changed: ${result.monitor.name}`,
              source: 'website-monitor',
              spaceId: result.monitor.spaceId,
              metadata: {
                monitorId: result.monitor.id,
                url: result.monitor.url,
                screenshot: result.snapshot.screenshot
              }
            };
            
            this.addToHistory(change);
          }
        });
        
        console.log(`Website monitoring check complete. ${results.filter(r => r.changed).length} changes detected.`);
      } catch (error) {
        console.error('Error in periodic website check:', error);
      }
    }, 30 * 60 * 1000); // 30 minutes
  }
}

module.exports = ClipboardManagerV2; 