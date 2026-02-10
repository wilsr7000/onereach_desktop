const path = require('path');
const fs = require('fs');
const os = require('os');
const ClipboardStorageV2 = require('./clipboard-storage-v2');
const { getSharedStorage } = require('./clipboard-storage-v2');
const AppContextCapture = require('./app-context-capture');
const getLogger = require('./event-logger');
const { getContentIngestionService, ValidationError, retryOperation } = require('./content-ingestion');
const { getSpacesAPI } = require('./spaces-api');
const ai = require('./lib/ai-service');

// Structured logging
const { getLogQueue } = require('./lib/log-event-queue');
const log = getLogQueue();

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
  log.info('clipboard', 'Running in non-Electron environment')
}

/**
 * Adapter class that provides the same API as the old ClipboardManager
 * but uses the new ClipboardStorageV2 underneath
 */
class ClipboardManagerV2 {
  constructor() {
    log.info('clipboard', 'ClipboardManagerV2 constructor started');
    
    // Check if migration is needed
    try {
      this.checkAndMigrate();
    } catch (migrationErr) {
      log.error('clipboard', 'v2 migration check failed', { error: migrationErr.message });
    }
    
    // Use shared storage singleton to ensure consistency with SpacesAPI
    this.storage = getSharedStorage();
    log.info('clipboard', 'Shared storage loaded', { hasStorage: !!this.storage });
    
    // Initialize app context capture
    try {
      this.contextCapture = new AppContextCapture();
    } catch (ctxErr) {
      log.warn('clipboard', 'AppContextCapture init failed', { error: ctxErr.message });
      this.contextCapture = null;
    }
    
    // Track active YouTube downloads for cancellation
    this.activeDownloads = new Map();
    
    // PERFORMANCE: Defer loading history until first access
    this.history = null;
    this.spaces = null;
    this._historyLoaded = false;
    
    // Compatibility properties
    this.maxHistorySize = 1000;
    this.pinnedItems = new Set();
    this.spacesEnabled = true;
    this.screenshotCaptureEnabled = false;
    this.currentSpace = 'unclassified';
    this.clipboardWindow = null;
    this.blackHoleWindow = null;
    this.screenshotWatcher = null;
    this.processedScreenshots = new Set();
    
    // Load preferences (lightweight, do immediately)
    try {
      this.loadPreferences();
      log.info('clipboard', 'Preferences loaded', { spacesEnabled: this.spacesEnabled, screenshotCapture: this.screenshotCaptureEnabled });
    } catch (prefErr) {
      log.error('clipboard', 'loadPreferences failed', { error: prefErr.message });
    }
    
    // Migrate existing web monitor items BEFORE IPC handlers (so clients get correct data)
    try {
      this.migrateWebMonitorItems();
    } catch (migrateErr) {
      log.error('clipboard', 'migrateWebMonitorItems failed', { error: migrateErr.message });
    }
    
    // Set up IPC handlers (needed immediately for IPC) - MUST succeed for viewer to work
    try {
      this.setupIPC();
      log.info('clipboard', 'IPC handlers registered successfully');
    } catch (ipcErr) {
      log.error('clipboard', 'setupIPC FAILED - viewer will not work', { error: ipcErr.message, stack: ipcErr.stack?.substring(0, 300) });
    }
    
    // Log feature initialization
    log.info('clipboard', 'ClipboardManagerV2 constructor completed', {
      storageReady: !!this.storage,
      ipcRegistered: !!ClipboardManagerV2._ipcRegistered,
      spacesEnabled: this.spacesEnabled,
      screenshotCapture: this.screenshotCaptureEnabled
    });
    const logger = getLogger();
    logger.logFeatureUsed('clipboard-manager', { 
      status: 'initialized',
      spacesEnabled: this.spacesEnabled,
      screenshotCaptureEnabled: this.screenshotCaptureEnabled
    });
    
    // PERFORMANCE: Defer heavy initialization to next tick
    setImmediate(() => {
      // Clean up orphaned downloading items from crashes
      this.cleanupOrphanedDownloads();
      
      // Set up screenshot monitoring if enabled
      if (this.screenshotCaptureEnabled) {
        this.setupScreenshotWatcher();
      }
      
      // Set up website monitoring periodic checks
      this.startWebsiteMonitoring();
      
      // Subscribe to SpacesAPI events to keep in-memory history in sync
      // This ensures Spaces Manager UI stays updated when changes happen via API
      this._subscribeToSpacesAPIEvents();
    });
  }
  
  /**
   * Subscribe to SpacesAPI events to keep in-memory history synchronized
   * This fixes sync issues where API changes weren't reflected in UI until reboot
   */
  _subscribeToSpacesAPIEvents() {
    try {
      const spacesAPI = getSpacesAPI();
      
      // When an item is deleted via API, remove from our in-memory history
      spacesAPI.on('item:deleted', ({ spaceId, itemId }) => {
        log.info('clipboard', 'SpacesAPI item:deleted event received', { itemId })
        const beforeCount = this.history?.length || 0;
        if (this.history) {
          this.history = this.history.filter(h => h.id !== itemId);
        }
        this.pinnedItems.delete(itemId);
        const afterCount = this.history?.length || 0;
        
        if (beforeCount !== afterCount) {
          log.info('clipboard', 'Removed item from history, notifying UI')
          this.updateSpaceCounts();
          this.notifyHistoryUpdate();
        }
      });
      
      // When an item is added via API, add to our in-memory history
      spacesAPI.on('item:added', ({ spaceId, item }) => {
        log.info('clipboard', 'SpacesAPI item:added event received', { detail: item?.id })
        this.ensureHistoryLoaded();
        
        // Only add if not already in history (avoid duplicates)
        if (item && !this.history.find(h => h.id === item.id)) {
          // Format item for history array
          const historyItem = {
            id: item.id,
            type: item.type,
            content: item.content || '',
            preview: item.preview || '',
            timestamp: item.timestamp || Date.now(),
            spaceId: item.spaceId || 'unclassified',
            pinned: item.pinned || false,
            thumbnail: item.thumbnail,
            metadata: item.metadata || {},
            fileName: item.fileName,
            fileSize: item.fileSize,
            _needsContent: true
          };
          
          this.history.unshift(historyItem);
          if (item.pinned) {
            this.pinnedItems.add(item.id);
          }
          
          log.info('clipboard', 'Added item to history, notifying UI')
          this.updateSpaceCounts();
          this.notifyHistoryUpdate();
        }
      });
      
      // When an item is updated via API, update our in-memory history
      spacesAPI.on('item:updated', ({ spaceId, itemId, data }) => {
        log.info('clipboard', 'SpacesAPI item:updated event received', { arg1: itemId, arg2: Object.keys(data || {}) })
        this.ensureHistoryLoaded();
        
        const item = this.history.find(h => h.id === itemId);
        if (item && data) {
          Object.assign(item, data);
          
          // Handle pinned state changes
          if (data.pinned !== undefined) {
            if (data.pinned) {
              this.pinnedItems.add(itemId);
            } else {
              this.pinnedItems.delete(itemId);
            }
          }
          
          log.info('clipboard', 'Updated item in history, notifying UI')
          this.notifyHistoryUpdate();
        }
      });
      
      // When an item is moved between spaces via API
      spacesAPI.on('item:moved', ({ itemId, fromSpaceId, toSpaceId }) => {
        log.info('clipboard', 'SpacesAPI item:moved event received', { itemId, fromSpaceId, arg3: '->', toSpaceId })
        this.ensureHistoryLoaded();
        
        const item = this.history.find(h => h.id === itemId);
        if (item) {
          item.spaceId = toSpaceId;
          log.info('clipboard', 'Updated item space, notifying UI')
          this.updateSpaceCounts();
          this.notifyHistoryUpdate();
        }
      });
      
      log.info('clipboard', 'Subscribed to SpacesAPI events for sync')
    } catch (error) {
      log.error('clipboard', 'Failed to subscribe to SpacesAPI events', { error: error.message })
      // Non-fatal - app will still work, just without real-time sync
    }
  }
  
  // PERFORMANCE: Lazy load history on first access
  ensureHistoryLoaded() {
    if (!this._historyLoaded) {
      log.info('clipboard', 'Lazy loading history...')
      this.loadFromStorage();
      this._historyLoaded = true;
      log.info('clipboard', 'History loaded', { arg1: this.history.length, arg2: 'items' })
    }
  }
  
  /**
   * Detect JSON subtype from content
   * Returns: 'style-guide', 'journey-map', or null for generic JSON
   * @param {string|object} jsonContent - JSON string or parsed object
   * @returns {string|null} - Detected subtype or null
   */
  detectJsonSubtype(jsonContent) {
    try {
      const data = typeof jsonContent === 'string' ? JSON.parse(jsonContent) : jsonContent;
      
      // Journey Map detection (check first - more specific structure)
      // Matches exported journey maps from Journey Editor
      if (data.journeyData && data.metadata?.exportVersion) {
        log.info('clipboard', 'Detected journey-map (export format)')
        return 'journey-map';
      }
      if (data.journeyData?.persona?.journeys?.[0]?.stages) {
        log.info('clipboard', 'Detected journey-map (stages format)')
        return 'journey-map';
      }
      // Journey map template format (from templates/export/)
      if (data.prompt && data.systemPrompt && data.htmlTemplate && data.styling) {
        log.info('clipboard', 'Detected journey-map (template format)')
        return 'journey-map';
      }
      
      // Style Guide / Design System detection
      // Matches style guides with colors + typography + design tokens
      if (data.colors && data.typography) {
        const hasColorTokens = data.colors.primary || data.colors.secondary || 
                               data.colors.accent || data.colors.neutral ||
                               data.colors.text || data.colors.backgrounds;
        const hasTypographyTokens = data.typography.fontFamilies || data.typography.scale ||
                                    data.typography.fonts || data.typography.headings || 
                                    data.typography.body;
        const hasDesignTokens = data.spacing || data.borderRadius || data.shadows ||
                                data.borders || data.animations;
        
        if (hasColorTokens && hasTypographyTokens) {
          log.info('clipboard', 'Detected style-guide')
          return 'style-guide';
        }
      }
      
      // Chatbot Conversation detection
      // Matches AI conversations with messages array + AI service metadata
      if (data.messages && Array.isArray(data.messages)) {
        const hasAIMetadata = data.aiService || data.conversationId;
        const hasMessageStructure = data.messages.some(m => 
          m.role && m.content && (m.role === 'user' || m.role === 'assistant')
        );
        
        if (hasAIMetadata && hasMessageStructure) {
          log.info('clipboard', 'Detected chatbot-conversation')
          return 'chatbot-conversation';
        }
      }
      
      // No specific subtype detected
      return null;
    } catch (e) {
      log.warn('clipboard', 'Error parsing JSON for subtype detection', { error: e.message })
      return null;
    }
  }
  
  /**
   * Read JSON file content and detect subtype
   * @param {string} filePath - Path to JSON file
   * @returns {string|null} - Detected subtype or null
   */
  detectJsonSubtypeFromFile(filePath) {
    try {
      if (!filePath || !fs.existsSync(filePath)) {
        return null;
      }
      const content = fs.readFileSync(filePath, 'utf8');
      return this.detectJsonSubtype(content);
    } catch (e) {
      log.warn('clipboard', 'Error reading file for subtype detection', { error: e.message })
      return null;
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
      
      // Preserve jsonSubtype for ALL item types (style-guide, journey-map)
      // This is needed for both file and text items
      if (item.jsonSubtype) {
        historyItem.jsonSubtype = item.jsonSubtype;
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
    this.screenshotCaptureEnabled = prefs.screenshotCaptureEnabled !== undefined ? prefs.screenshotCaptureEnabled : false;
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
    
    // ========================================
    // INPUT VALIDATION
    // ========================================
    
    // Validate item exists
    if (!item) {
      logger.error('addToHistory called with null/undefined item');
      throw new Error('Item is required');
    }
    
    // Validate type
    const validTypes = ['text', 'html', 'image', 'file', 'code'];
    const type = item.type || 'text';
    if (!validTypes.includes(type)) {
      logger.warn('Invalid item type, defaulting to text', { providedType: item.type });
      item.type = 'text';
    }
    
    // Validate content exists for content-based types
    if (['text', 'code'].includes(type)) {
      if (!item.content && item.content !== '') {
        logger.error('Content is required for text/code items');
        throw new Error('Content is required for text/code items');
      }
      if (typeof item.content === 'string' && item.content.trim().length === 0) {
        logger.error('Content cannot be empty for text/code items');
        throw new Error('Content cannot be empty');
      }
    }
    
    // Validate file items
    if (type === 'file') {
      if (!item.filePath && !item.fileData && !item.content) {
        logger.error('File path, file data, or content is required for file items');
        throw new Error('File path, file data, or content is required for file items');
      }
    }
    
    // Validate spaceId exists (if specified and not 'unclassified')
    const requestedSpaceId = item.spaceId || this.currentSpace || 'unclassified';
    if (requestedSpaceId && requestedSpaceId !== 'unclassified') {
      const spaceExists = this.storage.index?.spaces?.some(s => s.id === requestedSpaceId);
      if (!spaceExists) {
        log.error('clipboard', 'CRITICAL: Space "..." does not exist! Item will be saved to "unclassified" instead.', { requestedSpaceId })
        log.error('clipboard', `[addToHistory] Available spaces:`)
        logger.warn('Space not found, defaulting to unclassified', { spaceId: requestedSpaceId });
        item.spaceId = 'unclassified';
      } else {
        log.info('clipboard', 'Space "..." exists, proceeding with save', { requestedSpaceId })
      }
    }
    
    // ========================================
    // END VALIDATION
    // ========================================
    
    // ========================================
    // WEB MONITORS: URL DETECTION & MONITORING
    // ========================================
    const targetSpaceId = item.spaceId || this.currentSpace || 'unclassified';
    if (targetSpaceId === 'web-monitors') {
      const content = item.content || item.preview || '';
      
      // Skip SVG-only content (likely UI elements, not user content)
      const trimmedContent = content.trim();
      if (trimmedContent.startsWith('<svg') && trimmedContent.endsWith('</svg>')) {
        log.info('clipboard', 'Skipping SVG-only content (likely UI element)')
        return null;
      }
      
      // Check if content contains a URL
      const url = this.extractURL(content);
      log.info('clipboard', 'Content received', { detail: content.substring(0, 100) })
      log.info('clipboard', 'Extracted URL', { url })
      
      if (url) {
        log.info('clipboard', 'URL detected, creating website monitor...')
        
        try {
          // Try to create a full website monitor with scanning
          const result = await this.createWebsiteMonitorFromURL(url);
          if (result) {
            log.info('clipboard', 'Monitor created successfully', { resultId: result.id })
            return result;
          }
        } catch (error) {
          log.error('clipboard', 'Failed to create monitor', { error: error.message })
          log.info('clipboard', 'Falling back to simple URL item')
          
          // Notify user of the failure
          const { BrowserWindow } = require('electron');
          BrowserWindow.getAllWindows().forEach(window => {
            window.webContents.send('show-notification', {
              title: 'Web Monitor Partial Setup',
              body: `Saved URL, but monitoring disabled: ${error.message}`,
              type: 'warning'
            });
          });
          
          // Fall back to simple URL item
          item.type = 'url';
          item.url = url;
          item.content = url;
          try {
            const hostname = new URL(url).hostname;
            item.preview = `URL (not monitored): ${hostname}`;
          } catch (e) {
            item.preview = `URL: ${url}`;
          }
        }
      } else {
        log.info('clipboard', 'No URL found in content, adding as regular item')
      }
    }
    // ========================================
    // END WEB MONITORS
    // ========================================
    
    logger.logClipboardOperation('add', item.type, { 
      hasMetadata: !!item.metadata,
      spaceId: this.currentSpace
    });
    
    // Capture app context if not already provided
    let context = item.context;
    if (!context && !item.source) {
      try {
        context = await this.contextCapture.getFullContext();
        log.info('clipboard', 'Captured context', { context })
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
    
    // Generate thumbnail for image items if not already provided
    // This ensures images added via SpacesAPI get thumbnails
    if (item.type === 'image' && !item.thumbnail) {
      const imageData = item.content || item.dataUrl;
      if (imageData && typeof imageData === 'string' && imageData.startsWith('data:image/')) {
        try {
          // For smaller images, use the full image as thumbnail
          // For larger images (>100KB), generate a smaller thumbnail
          if (imageData.length > 100000) {
            item.thumbnail = this.generateImageThumbnail(imageData);
            log.info('clipboard', 'Generated thumbnail for large image')
          } else {
            item.thumbnail = imageData;
            log.info('clipboard', 'Using full image as thumbnail (small image)')
          }
        } catch (thumbError) {
      log.error('clipboard', 'Error generating image thumbnail', { thumbError })
          // Fallback: use the content as thumbnail
          item.thumbnail = imageData;
        }
      }
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
    const itemSpaceId = indexEntry.spaceId;
    if (itemSpaceId && itemSpaceId !== 'unclassified') {
      this.updateSpaceLastUsed(itemSpaceId);
    }
    
    // Sync to unified space-metadata.json if item belongs to a space
    if (itemSpaceId) {
      try {
        const spaceMeta = this.storage.getSpaceMetadata(itemSpaceId);
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
          this.storage.updateSpaceMetadata(itemSpaceId, { files: spaceMeta.files });
          log.info('clipboard', 'Synced new item to space-metadata.json', { fileKey })
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
    try {
      const { getSettingsManager } = require('./settings-manager');
      const settingsManager = getSettingsManager();
      
      // Check if auto AI metadata is enabled
      const autoAIMetadata = settingsManager.get('autoAIMetadata');
      const autoAIMetadataTypes = settingsManager.get('autoAIMetadataTypes') || ['all'];
      // Always use anthropicApiKey for metadata generation since it uses Claude API
      // The llmApiKey depends on llmProvider which may be set to 'openai'
      const apiKey = settingsManager.get('anthropicApiKey') || settingsManager.get('llmApiKey');
      
      // Also check legacy screenshot setting for backward compatibility
      const autoGenerateScreenshotMetadata = settingsManager.get('autoGenerateScreenshotMetadata');
      
      // Check if this is an image file (type=file but fileType=image-file)
      const isImageFile = itemType === 'file' && fileType === 'image-file';
      
      
      log.info('clipboard', 'Settings check for item ...', { itemId })
      
      if (!apiKey) {
        log.info('clipboard', 'No API key configured, skipping metadata generation')
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
        log.info('clipboard', 'Skipping metadata generation for ... (not in enabled types: ...)', { itemType, detail: autoAIMetadataTypes.join(', ') })
        return;
      }
      
      log.info('clipboard', 'Generating metadata for ... item: ...', { itemType, itemId })
      
      // Generate metadata using NEW specialized system
      const MetadataGenerator = require('./metadata-generator');
      const metadataGen = new MetadataGenerator(this);
      
      
      const result = await metadataGen.generateMetadataForItem(itemId, apiKey);
      
      
      if (result.success) {
        log.info('clipboard', 'Successfully generated specialized metadata for ...: ...', { itemType, itemId })
        
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
        log.warn('clipboard', 'Auto-metadata generation failed (non-critical)', { itemId })
      }
    } catch (error) {
      const logger = getLogger();
      logger.warn('Clipboard auto AI metadata generation failed (non-critical)', {
        error: error.message,
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
      
      // Detect jsonSubtype SEPARATELY for items that don't have it yet
      // This runs even for items with metadata already loaded
      if (!item.jsonSubtype && (item.type === 'text' || (item.type === 'file' && item.fileExt === '.json'))) {
        try {
          let detectedSubtype = null;
          
          // For text items, check if content is JSON
          if (item.type === 'text') {
            // Load content if not already loaded
            if (!item.content) {
              const fullItem = this.storage.loadItem(item.id);
              item.content = fullItem.content;
            }
            const content = typeof item.content === 'string' ? item.content : null;
            if (content && (content.trim().startsWith('{') || content.trim().startsWith('['))) {
              detectedSubtype = this.detectJsonSubtype(content);
            }
          }
          
          // For file items with .json extension
          if (item.type === 'file' && item.fileExt === '.json') {
            // Load content (file path) if not already loaded
            if (!item.content) {
              const fullItem = this.storage.loadItem(item.id);
              item.content = fullItem.content;
            }
            if (item.content) {
              detectedSubtype = this.detectJsonSubtypeFromFile(item.content);
            }
          }
          
          if (detectedSubtype) {
            item.jsonSubtype = detectedSubtype;
            // Update the storage index for future loads
            const indexEntry = this.storage.index.items.find(i => i.id === item.id);
            if (indexEntry && !indexEntry.jsonSubtype) {
              indexEntry.jsonSubtype = detectedSubtype;
              this.storage.saveIndex();
              log.info('clipboard', 'Detected and saved jsonSubtype: ... for item ...', { detectedSubtype, itemId: item.id })
            }
          }
        } catch (e) {
          // Ignore detection errors
        }
      }
      
      return item;
    });
  }
  
  async deleteItem(id) {
    log.info('clipboard', 'deleteItem called for', { id })
    
    // Ensure history is loaded
    this.ensureHistoryLoaded();
    
    // If we have a manager instance, wait for any pending operations
    if (this.manager && this.manager.pendingOperations) {
      const pendingOps = this.manager.pendingOperations.get(id);
      if (pendingOps && pendingOps.size > 0) {
        log.info('clipboard', 'Waiting for ... pending operations to complete before deleting item ...', { size: pendingOps.size, id })
        try {
          await Promise.race([
            Promise.all(Array.from(pendingOps)),
            new Promise((resolve) => setTimeout(resolve, 5000)) // 5 second timeout
          ]);
        } catch (e) {
          log.error('clipboard', 'Error waiting for pending operations', { error: e.message || e })
        }
      }
    }
    
    // Get item info before deletion for space metadata cleanup
    const item = this.history.find(h => h.id === id);
    const spaceId = item ? item.spaceId : null;
    const fileName = item ? item.fileName : null;
    
    log.info('clipboard', 'Attempting storage delete for', { id, arg2: 'spaceId:', spaceId })
    const success = this.storage.deleteItem(id);
    log.info('clipboard', 'Storage delete result', { success })
    
    if (!success) {
      // Item might still be in history but not in storage index - clean up history anyway
      const historyIndex = this.history.findIndex(h => h.id === id);
      if (historyIndex !== -1) {
        log.info('clipboard', 'Item not in storage index but found in history, removing from history')
        this.history.splice(historyIndex, 1);
        this.pinnedItems.delete(id);
        this.updateSpaceCounts();
        this.notifyHistoryUpdate();
        return; // Consider this a success - item is gone from UI
      }
      throw new Error(`Item ${id} not found in storage or history`);
    }
    
    // Remove from unified space-metadata.json
    if (spaceId) {
      try {
        const spaceMeta = this.storage.getSpaceMetadata(spaceId);
        if (spaceMeta) {
          const fileKey = fileName || `item-${id}`;
          if (spaceMeta.files && spaceMeta.files[fileKey]) {
            delete spaceMeta.files[fileKey];
            this.storage.updateSpaceMetadata(spaceId, { files: spaceMeta.files });
            log.info('clipboard', 'Removed from space-metadata.json', { fileKey })
          }
        }
      } catch (syncError) {
        const logger = getLogger();
        logger.error('Clipboard remove from space failed', {
          error: syncError.message,
          operation: 'removeFromSpace',
          itemId: id
        });
        // Don't throw - the main delete succeeded, this is just metadata cleanup
      }
    }
    
    this.history = this.history.filter(h => h.id !== id);
    this.pinnedItems.delete(id);
    if (this.manager && this.manager.pendingOperations) {
      this.manager.pendingOperations.delete(id); // Clean up pending operations
    }
    this.updateSpaceCounts();
    this.notifyHistoryUpdate();
    log.info('clipboard', 'Delete completed successfully for', { id })
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
              log.error('clipboard', 'Error waiting for pending operations', { error: e.message || e })
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
            log.info('clipboard', 'Synced move to space-metadata.json', { fileKey, arg2: '->', spaceId })
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
    
    // Add lastUsed timestamp when creating a space
    const spaceWithTimestamp = {
      ...space,
      lastUsed: Date.now(),
      createdAt: Date.now()
    };
    
    
    const newSpace = this.storage.createSpace(spaceWithTimestamp);
    
    
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
    // Query directly from storage index (source of truth) instead of potentially stale history
    const indexItems = this.storage.index.items || [];
    
    log.info('clipboard', 'Querying spaceId: "...", index items: ...', { spaceId, indexItemsCount: indexItems.length })
    
    // Debug: show all unique spaceIds in index
    const uniqueSpaceIds = [...new Set(indexItems.map(item => item.spaceId))];
    log.info('clipboard', `[getSpaceItems] Unique spaceIds in index:`)
    
    // Filter items by space from the storage index
    const filteredItems = indexItems.filter(item => 
      spaceId === null ? true : item.spaceId === spaceId
    );
    
    log.info('clipboard', 'Found ... items for spaceId "..."', { filteredItemsCount: filteredItems.length, spaceId })
    
    // Load content and thumbnails on demand
    return filteredItems.map(item => {
      const historyItem = {
        id: item.id,
        type: item.type,
        content: null,
        thumbnail: null,
        preview: item.preview,
        timestamp: item.timestamp,
        pinned: item.pinned,
        spaceId: item.spaceId,
        fileName: item.fileName,
        fileSize: item.fileSize,
        fileType: item.fileType,
        fileCategory: item.fileCategory,
        fileExt: item.fileExt,
        isScreenshot: item.isScreenshot,
        filePath: item.filePath,
        jsonSubtype: item.jsonSubtype,
        // Web monitor fields (from index)
        url: item.url,
        name: item.name,
        monitorId: item.monitorId,
        lastChecked: item.lastChecked,
        status: item.status,
        changeCount: item.changeCount,
        timeline: item.timeline,
        settings: item.settings,
        _needsContent: true
      };
      
      // Load full content
      try {
        const fullItem = this.storage.loadItem(item.id);
        historyItem.content = fullItem.content;
        historyItem.thumbnail = fullItem.thumbnail;
        historyItem._needsContent = false;
        
        // Merge metadata from storage
        if (fullItem.metadata) {
          historyItem.metadata = { ...historyItem.metadata, ...fullItem.metadata };
          
          // Update fileSize from metadata if not set
          if (!historyItem.fileSize && fullItem.metadata.fileSize) {
            historyItem.fileSize = fullItem.metadata.fileSize;
          }
          
          // For web-monitor items, also check metadata for updated values
          if (item.type === 'web-monitor') {
            if (fullItem.metadata.lastChecked) historyItem.lastChecked = fullItem.metadata.lastChecked;
            if (fullItem.metadata.status) historyItem.status = fullItem.metadata.status;
            if (fullItem.metadata.changeCount !== undefined) historyItem.changeCount = fullItem.metadata.changeCount;
            if (fullItem.metadata.timeline) historyItem.timeline = fullItem.metadata.timeline;
          }
        }
      } catch (error) {
        log.warn('clipboard', 'Failed to load content for item', { itemId: item.id, error: error.message })
      }
      
      return historyItem;
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
      if (global.menuDataManager) {
        global.menuDataManager.refresh();
      } else {
        const { refreshApplicationMenu } = require('./menu');
        refreshApplicationMenu();
      }
    } catch (e) {
      // Menu module not available in non-Electron environment
    }
  }
  
  // Generate AI metadata for video content
  async generateVideoMetadata({ transcript, originalTitle, uploader, description, duration }) {
    log.info('clipboard', 'Generating video metadata...')
    
    const { getSettingsManager } = require('./settings-manager');
    const settingsManager = getSettingsManager();
    const apiKey = settingsManager.get('llmApiKey');
    
    if (!apiKey) {
      log.info('clipboard', 'No API key configured')
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
      
      // Use centralized AI service
      const result = await ai.chat({
        profile: isClaudeKey ? 'standard' : 'fast',
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 1500,
        temperature: isClaudeKey ? undefined : 0.3,
        feature: 'clipboard-manager',
      });
      
      // Parse JSON from response
      const jsonMatch = result.content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
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
  
  /**
   * Clean up orphaned downloading items on startup
   * Handles items stuck in "downloading" state from app crashes
   */
  cleanupOrphanedDownloads() {
    try {
      log.info('clipboard', 'Checking for orphaned downloads...')
      
      const allItems = this.storage.getAllItems();
      let cleaned = 0;
      
      for (const item of allItems) {
        // Load full metadata to check download status
        try {
          const metaPath = path.join(this.storage.itemsDir, item.id, 'metadata.json');
          if (!fs.existsSync(metaPath)) continue;
          
          const metadata = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
          
          // Check if stuck in downloading state
          if (metadata.downloadStatus === 'downloading') {
            log.info('clipboard', 'Found orphaned download', { arg1: item.id, arg2: metadata.title || 'Unknown' })
            
            // Check if video file actually exists (download completed but state not updated)
            const itemDir = path.join(this.storage.itemsDir, item.id);
            const files = fs.readdirSync(itemDir);
            const videoFile = files.find(f => f.endsWith('.mp4') && !f.startsWith('.'));
            
            if (videoFile) {
              // Download completed but state wasn't updated - fix it
              log.info('clipboard', 'Found completed video file, updating state...')
              const stats = fs.statSync(path.join(itemDir, videoFile));
              const title = videoFile.replace(/-[a-zA-Z0-9_-]{11}\.mp4$/, '');
              
              // Update metadata
              metadata.downloadStatus = 'complete';
              metadata.downloadProgress = 100;
              metadata.title = title;
              fs.writeFileSync(metaPath, JSON.stringify(metadata, null, 2));
              
              // Update index
              this.storage.updateItemIndex(item.id, {
                preview: title,
                fileName: videoFile,
                fileSize: stats.size,
                metadata: {
                  title: title,
                  downloadStatus: 'complete',
                  downloadProgress: 100
                }
              });
              
              log.info('clipboard', '✅ Fixed completed download', { title })
              cleaned++;
            } else {
              // Download never completed - mark as failed
              log.info('clipboard', 'No video file found, marking as failed...')
              
              metadata.downloadStatus = 'error';
              metadata.downloadError = 'Download interrupted (app crash or restart)';
              fs.writeFileSync(metaPath, JSON.stringify(metadata, null, 2));
              
              this.storage.updateItemIndex(item.id, {
                preview: `❌ Download interrupted: ${metadata.title || 'Video'}`,
                metadata: {
                  downloadStatus: 'error',
                  downloadError: 'Download interrupted'
                }
              });
              
              log.info('clipboard', '❌ Marked as failed', { detail: metadata.title || item.id })
              cleaned++;
            }
          }
        } catch (err) {
          log.error('clipboard', 'Error processing item', { itemId: item.id, error: err.message })
        }
      }
      
      if (cleaned > 0) {
        log.info('clipboard', 'Cleaned up ... orphaned downloads', { cleaned })
        // Reload history to reflect changes
        if (this._historyLoaded) {
          this._ensureHistoryLoaded();
          this.notifyHistoryUpdate();
        }
      } else {
        log.info('clipboard', 'No orphaned downloads found')
      }
    } catch (error) {
      log.error('clipboard', 'Error cleaning orphaned downloads', { error: error.message || error })
    }
  }
  
  /**
   * Cancel an active YouTube download
   * @param {string} placeholderId - ID of the item being downloaded
   * @returns {boolean} Success status
   */
  cancelDownload(placeholderId) {
    const download = this.activeDownloads.get(placeholderId);
    
    if (!download) {
      log.info('clipboard', 'No active download found for', { placeholderId })
      return false;
    }
    
    try {
      // Abort the download
      if (download.controller) {
        download.controller.abort();
      }
      
      // Clear from active downloads
      this.activeDownloads.delete(placeholderId);
      
      // Update the item to show cancellation
      const historyItem = this.history?.find(h => h.id === placeholderId);
      if (historyItem) {
        historyItem.preview = '🚫 Download cancelled';
        if (historyItem.metadata) {
          historyItem.metadata.downloadStatus = 'cancelled';
          historyItem.metadata.downloadError = 'Cancelled by user';
        }
      }
      
      // Update metadata file
      try {
        const metaPath = path.join(this.storage.itemsDir, placeholderId, 'metadata.json');
        if (fs.existsSync(metaPath)) {
          const metadata = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
          metadata.downloadStatus = 'cancelled';
          metadata.downloadError = 'Cancelled by user';
          fs.writeFileSync(metaPath, JSON.stringify(metadata, null, 2));
        }
      } catch (err) {
        log.error('clipboard', 'Error updating metadata', { error: err.message || err })
      }
      
      // Update index
      this.storage.updateItemIndex(placeholderId, {
        preview: '🚫 Download cancelled',
        metadata: {
          downloadStatus: 'cancelled'
        }
      });
      
      this.notifyHistoryUpdate();
      
      log.info('clipboard', '✅ Download cancelled', { placeholderId })
      return true;
      
    } catch (error) {
      log.error('clipboard', 'Error cancelling download', { error: error.message || error })
      return false;
    }
  }
  
  // Background YouTube download - creates placeholder immediately, downloads in background
  async downloadYouTubeInBackground(url, spaceId, placeholderId, sender) {
    const { Notification } = require('electron');
    
    log.info('clipboard', 'Starting background download for', { url, arg2: 'placeholder:', placeholderId })
    
    // Create abort controller for cancellation
    const abortController = new AbortController();
    
    // Track this download
    this.activeDownloads.set(placeholderId, {
      controller: abortController,
      progress: 0,
      url: url,
      startTime: Date.now()
    });
    
    let progressInterval;
    
    try {
      // Get the downloader instance
      const { YouTubeDownloader } = require('./youtube-downloader');
      const dl = new YouTubeDownloader();
      
      // Set up progress callback - update UI on every progress report
      const progressCallback = (percent, status) => {
        // Check if cancelled
        if (abortController.signal.aborted) {
          throw new Error('Download cancelled by user');
        }
        
        log.info('clipboard', 'Progress', { percent, arg2: '%', status })
        
        // Update progress tracking
        const download = this.activeDownloads.get(placeholderId);
        if (download) {
          download.progress = percent;
        }
        
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
      progressInterval = setInterval(() => {
        // Check if cancelled
        if (abortController.signal.aborted) {
          clearInterval(progressInterval);
          return;
        }
        
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
      
      // Check if cancelled during download
      if (abortController.signal.aborted) {
        throw new Error('Download cancelled by user');
      }
      
      log.info('clipboard', 'Download completed', { detail: JSON.stringify(result) })
      
      // Try to fetch transcript
      let transcript = null;
      if (result.success) {
        try {
          log.info('clipboard', 'Fetching transcript...')
          const transcriptResult = await dl.getTranscript(url, 'en');
          if (transcriptResult.success) {
            transcript = {
              text: transcriptResult.transcript,
              segments: transcriptResult.segments,
              language: transcriptResult.language,
              isAutoGenerated: transcriptResult.isAutoGenerated,
            };
            log.info('clipboard', 'Transcript fetched', { language: transcript.language })
          }
        } catch (e) {
          log.info('clipboard', 'Could not fetch transcript', { error: e.message })
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
          log.info('clipboard', 'Copied video to', { destFilePath })
          
          // Clean up temp file
          try { fs.unlinkSync(result.filePath); } catch (e) {}
          
        } catch (copyErr) {
          log.error('clipboard', 'Error copying file', { copyErr })
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
          log.info('clipboard', 'Extracting thumbnail...')
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
                log.info('clipboard', 'Thumbnail extracted to', { thumbnailPath })
                resolve();
              })
              .on('error', (err) => {
                log.error('clipboard', 'Thumbnail extraction error', { error: err.message || err })
                reject(err);
              });
          });
        } catch (thumbErr) {
          log.error('clipboard', 'Thumbnail extraction failed', { error: thumbErr.message })
          thumbnailPath = null;
        }
        
        // Extract audio file
        let audioPath = null;
        try {
          log.info('clipboard', 'Extracting audio...')
          const ffmpeg = require('fluent-ffmpeg');
          const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
          ffmpeg.setFfmpegPath(ffmpegPath);
          
          const audioFileName = path.parse(result.fileName).name + '.mp3';
          audioPath = path.join(itemDir, audioFileName);
          
          await new Promise((resolve, reject) => { detail: ffmpeg(destFilePath)
              .noVideo()
              .audioCodec('libmp3lame')
              .audioBitrate('128k')
              .format('mp3')
              .output(audioPath)
              .on('end', () => {
                log.info('clipboard', 'Audio extracted to', { audioPath })
                resolve();
              })
              .on('error', (err) => {
                log.error('clipboard', 'Audio extraction error', { error: err.message || err })
                reject(err);
              })
              .run();
          });
        } catch (audioErr) {
          log.error('clipboard', 'Audio extraction failed', { error: audioErr.message })
          audioPath = null;
        }
        
        // Generate AI metadata if we have transcript
        let aiMetadata = null;
        if (transcript && transcript.text && transcript.text.length > 100) {
          try {
            log.info('clipboard', 'Generating AI metadata...')
            aiMetadata = await this.generateVideoMetadata({
              transcript: transcript.text,
              originalTitle: title,
              uploader: videoInfo.uploader,
              description: videoInfo.description,
              duration: videoInfo.duration
            });
            log.info('clipboard', 'AI metadata generated', { detail: aiMetadata ? 'success' : 'failed' })
          } catch (aiErr) {
            log.error('clipboard', 'AI metadata generation failed', { error: aiErr.message })
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
            log.info('clipboard', 'Transcript saved to', { transcriptPath })
          }
          
          // Update in-memory history with new metadata
          if (historyItem && historyItem.metadata) {
            historyItem.metadata.downloadStatus = 'complete';
            historyItem.metadata.downloadProgress = 100;
            historyItem.metadata.downloadStatusText = 'Complete!';
            historyItem.metadata.title = metadata.title;
            historyItem.metadata.shortDescription = metadata.shortDescription;
            historyItem.metadata.longDescription = metadata.longDescription;
            historyItem.metadata.audioPath = audioPath;
            
            // Update the main item preview with the final title
            historyItem.preview = metadata.title;
          }
          
          // CRITICAL FIX: Update the storage index entry with the completed metadata
          // This ensures the item shows correctly in Spaces menu after app restart
          this.storage.updateItemIndex(placeholderId, {
            preview: metadata.title,  // Change from "🎬 Downloading..." to actual title
            fileName: result.fileName,
            fileSize: result.fileSize,
            metadata: {
              title: metadata.title,
              downloadStatus: 'complete',
              downloadProgress: 100
            }
          });
          
        } catch (err) {
          log.error('clipboard', 'Error updating metadata', { error: err.message || err })
        }
        
        // Remove from active downloads
        this.activeDownloads.delete(placeholderId);
        
        // Save the updated index to persist changes
        this.storage.saveIndexSync();  // Use sync save to ensure persistence
        log.info('clipboard', 'Index saved with updated metadata')
        
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
        
        // Remove from active downloads
        this.activeDownloads.delete(placeholderId);
        
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
      if (progressInterval) {
        clearInterval(progressInterval);
      }
      
      // Remove from active downloads
      this.activeDownloads.delete(placeholderId);
      
      // Update placeholder with error
      const historyItem = this.history.find(h => h.id === placeholderId);
      if (historyItem) {
        const isCancelled = error.message && error.message.includes('cancelled');
        historyItem.preview = isCancelled 
          ? '🚫 Download cancelled' 
          : `❌ Download error: ${historyItem.metadata?.title || 'Video'}`;
        if (historyItem.metadata) {
          historyItem.metadata.downloadStatus = isCancelled ? 'cancelled' : 'error';
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
    log.info('clipboard', 'createClipboardWindow called', { hasExistingWindow: !!(this.clipboardWindow && !this.clipboardWindow.isDestroyed()) });
    if (this.clipboardWindow && !this.clipboardWindow.isDestroyed()) {
      this.clipboardWindow.focus();
      this.clipboardWindow.show();
      return;
    }
    
    // Use app.getAppPath() instead of __dirname for packaged apps
    const preloadPath = path.join(app.getAppPath(), 'preload.js');
    log.info('clipboard', 'Creating clipboard window with preload', { preloadPath })
    log.info('clipboard', 'App path', { detail: app.getAppPath() })
    log.info('clipboard', 'Preload exists?', { detail: require('fs').existsSync(preloadPath) })
    
    // Check if preload script exists
    if (!require('fs').existsSync(preloadPath)) {
      log.error('clipboard', 'Preload script not found at', { preloadPath })
      const { dialog } = require('electron');
      dialog.showErrorBox('Error', 'Failed to load clipboard manager: Preload script not found.');
      return;
    }
    
    this.clipboardWindow = new BrowserWindow({
      width: 1400,
      height: 900,
      frame: false,
      transparent: false,
      backgroundColor: '#1a1a1a',
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
    
    // Handle load errors - only close for critical main frame failures
    this.clipboardWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      log.warn('clipboard', 'Load failed', { detail: { errorCode, errorDescription, validatedURL, isMainFrame } })
      
      // Only show error and close for main frame failures with real errors
      // Error codes: -3 = ABORTED (user action), -6 = CONNECTION_FAILED, etc.
      // See: https://source.chromium.org/chromium/chromium/src/+/main:net/base/net_error_list.h
      if (isMainFrame && errorCode !== -3) {
        // Main frame failed to load (not just aborted)
        log.error('clipboard', 'Critical load failure - main frame failed')
        const { dialog } = require('electron');
        dialog.showErrorBox('Error', `Failed to load clipboard manager: ${errorDescription || 'Unknown error'}`);
        if (this.clipboardWindow && !this.clipboardWindow.isDestroyed()) {
          this.clipboardWindow.close();
        }
      }
      // For sub-frame/sub-resource failures, just log - don't close the window
    });
    
    // Show window when ready
    this.clipboardWindow.once('ready-to-show', () => {
      log.info('clipboard', 'Clipboard window ready-to-show');
      this.clipboardWindow.show();
    });
    
    // Add cache-busting query string to force fresh load
    log.info('clipboard', 'Loading clipboard-viewer.html');
    this.clipboardWindow.loadFile('clipboard-viewer.html', {
      query: { t: Date.now() }
    });
    
    // Clear cache to ensure fresh HTML loads
    this.clipboardWindow.webContents.session.clearCache();
    
    // Attach structured log forwarding (console-message, render-process-gone, preload-error, did-fail-load)
    try {
      const { attachLogForwarder } = require('./browserWindow');
      attachLogForwarder(this.clipboardWindow, 'clipboard');
    } catch (e) {
      log.warn('clipboard', 'Could not attach log forwarder', { error: e.message });
    }
    
    // Additional lifecycle logging specific to clipboard viewer
    this.clipboardWindow.webContents.on('did-finish-load', () => {
      log.info('clipboard', 'Clipboard viewer HTML loaded');
    });

    this.clipboardWindow.on('closed', () => {
      this.clipboardWindow = null;
    });

  }
  
  // CRITICAL: Black hole widget window - DO NOT DUPLICATE THIS METHOD!
  // If broken, check TEST-BLACKHOLE.md for troubleshooting
  // Must use app.getAppPath() for preload, NOT __dirname
  createBlackHoleWindow(position, startExpanded = false, clipboardData = null) {
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
    
    log.info('clipboard', 'Creating window', { detail: { position, width, height, startExpanded } })
    
    // Use app.getAppPath() for preload path in packaged apps
    const preloadPath = path.join(app.getAppPath(), 'preload.js');
    log.info('clipboard', 'Preload path', { preloadPath })
    
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
      log.info('clipboard', 'Setting initial position', { x: windowConfig.x, y: windowConfig.y })
    }
    
    this.blackHoleWindow = new BrowserWindow(windowConfig);
    
    // Pass startExpanded via query parameter so it's available immediately
    this.blackHoleWindow.loadFile('black-hole.html', {
      query: { startExpanded: startExpanded ? 'true' : 'false' }
    });
    
    // Check for preload errors
    this.blackHoleWindow.webContents.on('preload-error', (event, preloadPath, error) => {
      log.error('clipboard', 'Preload error', { preloadPath, error })
    });
    
    this.blackHoleWindow.once('ready-to-show', () => {
      // Position is already set in the config, just show the window
      this.blackHoleWindow.show();
      log.info('clipboard', 'Window shown at position', { detail: this.blackHoleWindow.getBounds() })
    });
    
    // Send startExpanded flag and clipboard data to the window after it loads
    this.blackHoleWindow.webContents.on('did-finish-load', () => {
      const hasClipboardData = !!clipboardData;
      log.info('clipboard', 'Window loaded, startExpanded', { startExpanded, arg2: 'hasClipboardData:', hasClipboardData })
      
      // Send init with clipboard data if available
      this.blackHoleWindow.webContents.send('black-hole:init', { 
        startExpanded: startExpanded || hasClipboardData,
        clipboardData: clipboardData 
      });
    });
    
    this.blackHoleWindow.on('closed', () => {
      this.blackHoleWindow = null;
      log.info('clipboard', 'Window closed')
    });
  }
  
  // Screenshot handling
  
  setupScreenshotWatcher() {
    if (!app || !app.getPath) {
      log.info('clipboard', 'Screenshot watcher not available in non-Electron environment')
      return;
    }
    
    const desktopPath = app.getPath('desktop');
    
    if (fs.existsSync(desktopPath)) { info: log.info('clipboard', 'Setting up screenshot watcher for', { desktopPath })
      
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
                log.info('clipboard', 'Screenshot file ready', { fullPath })
                await this.handleScreenshot(fullPath);
              } else {
                log.info('clipboard', 'Screenshot file disappeared', { fullPath })
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
              log.info('clipboard', 'Found recent screenshot', { filename })
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
    log.info('clipboard', 'Processing screenshot', { screenshotPath })
    
    try {
      this.processedScreenshots.add(screenshotPath);
      
      if (this.processedScreenshots.size > 100) {
        const entries = Array.from(this.processedScreenshots);
        entries.slice(0, entries.length - 100).forEach(path => {
          this.processedScreenshots.delete(path);
        });
      }
      
      if (!fs.existsSync(screenshotPath)) {
        log.info('clipboard', 'Screenshot file not found', { screenshotPath })
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
        log.info('clipboard', 'Screenshot already in history', { fileName })
        return;
      }
      
      if (!this.screenshotCaptureEnabled) {
        log.info('clipboard', 'Screenshot capture is disabled')
        return;
      }
      
      if (!this.currentSpace || this.currentSpace === null) { send: log.info('clipboard', 'No active space, prompting user to select space for screenshot')
        
        // Send event to renderer to show space selector modal
        if (this.clipboardWindow && !this.clipboardWindow.isDestroyed()) {
          this.clipboardWindow.webContents.send('clipboard:select-space-for-screenshot', {
            screenshotPath: screenshotPath,
            fileName: fileName,
            stats: stats,
            ext: ext });
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
          log.info('clipboard', 'Screenshot thumbnail size: ... bytes (original: ... bytes)', { thumbnailCount: thumbnail.length, statsSize: stats.size })
        } catch (e) {
          log.error('clipboard', 'Error creating screenshot thumbnail', { error: e.message || e })
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
        log.error('clipboard', 'Screenshot file disappeared before storage', { screenshotPath })
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
        log.info('clipboard', 'Auto-generating AI metadata for screenshot...')
        
        // Trigger AI metadata generation using specialized system
        setTimeout(async () => {
          try {
            const MetadataGenerator = require('./metadata-generator');
            const metadataGen = new MetadataGenerator(this);
            // Use anthropicApiKey for metadata generation (Claude API)
            const apiKey = settings.anthropicApiKey || settings.llmApiKey;
            const result = await metadataGen.generateMetadataForItem(item.id, apiKey);
            
            if (result.success) {
              log.info('clipboard', 'AI metadata generated successfully for screenshot using specialized prompts')
              
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
            log.error('clipboard', 'Error auto-generating AI metadata for screenshot', { error: error.message || error })
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
        log.info('clipboard', 'Failed to create image from base64 data')
        return base64Data;
      }
      
      const size = image.getSize();
      log.info('clipboard', 'Original image size: ...x...', { width: size.width, height: size.height })
      
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
      log.info('clipboard', 'Generated thumbnail: ...x...', { newWidth, newHeight })
      
      return thumbnail;
    } catch (error) {
      log.error('clipboard', 'Error generating thumbnail', { error: error.message || error })
      return base64Data;
    }
  }
  
  // IPC Setup - Complete set of handlers for compatibility
  setupIPC() {
    if (!ipcMain) {
      log.info('clipboard', 'IPC not available in non-Electron environment')
      return;
    }
    
    // Prevent duplicate IPC registration (memory leak prevention)
    if (ClipboardManagerV2._ipcRegistered) {
      log.warn('clipboard', 'IPC handlers already registered - skipping to prevent memory leak')
      return;
    }
    ClipboardManagerV2._ipcRegistered = true;
    
    // Helper to safely register IPC handlers with structured logging.
    // Wraps every handler so that failures are logged to the log queue.
    const safeHandle = (channel, handler) => {
      const wrappedHandler = async (...args) => {
        try {
          const result = await handler(...args);
          return result;
        } catch (err) {
          log.error('ipc', `IPC handler threw: ${channel}`, { error: err.message, stack: err.stack?.substring(0, 300) });
          throw err; // Re-throw so the renderer sees the rejection
        }
      };
      try {
        ipcMain.handle(channel, wrappedHandler);
      } catch (err) {
        if (err.message && err.message.includes('second handler')) {
          log.info('clipboard', `IPC handler already registered, skipping: ${channel}`)
        } else {
          log.error('ipc', `Failed to register IPC handler: ${channel}`, { error: err.message });
          throw err;
        }
      }
    };
    
    // Store handler references for cleanup
    this._ipcOnHandlers = [];
    
    // Black hole window handlers
    ipcMain.on('black-hole:resize-window', (event, { width, height }) => {
      if (this.blackHoleWindow && !this.blackHoleWindow.isDestroyed()) {
        log.info('clipboard', 'Resizing window to', { width, arg2: 'x', height })
        const currentBounds = this.blackHoleWindow.getBounds();
        log.info('clipboard', 'Current bounds', { currentBounds })
        
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
          log.info('clipboard', 'Expanded to modal size at', { newX, newY })
        } else {
          // Just resize without moving
          this.blackHoleWindow.setSize(width, height, true);
          log.info('clipboard', 'Restored to normal size')
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
      log.info('clipboard', 'Black hole active')
    });
    
    ipcMain.on('black-hole:inactive', () => { detail: // Black hole is inactive (modal closed)
      log.info('clipboard', 'Black hole inactive') });
    
    // History management
    safeHandle('clipboard:get-history', () => {
      return this.getHistory();
    });
    
    safeHandle('clipboard:clear-history', async () => {
      await this.clearHistory();
      return { success: true };
    });
    
    safeHandle('clipboard:delete-item', async (event, id) => {
      try {
        await this.deleteItem(id);
        log.info('clipboard', 'Deleted item', { id })
        return { success: true };
      } catch (error) {
        log.error('clipboard', 'Failed to delete item', { id, error })
        return { success: false, error: error.message };
      }
    });

    safeHandle('clipboard:delete-items', async (event, itemIds) => {
      try {
        if (!Array.isArray(itemIds) || itemIds.length === 0) {
          return { success: false, error: 'No items provided' };
        }
        
        const results = {
          success: true,
          deleted: 0,
          failed: 0,
          errors: []
        };
        
        for (const id of itemIds) {
          try {
            await this.deleteItem(id);
            results.deleted++;
            log.info('clipboard', 'Deleted item', { id })
          } catch (error) {
            results.failed++;
            results.errors.push(`Failed to delete ${id}: ${error.message}`);
            log.error('clipboard', 'Failed to delete item', { id, error })
          }
        }
        
        results.success = results.deleted > 0;
        log.info('clipboard', 'Bulk delete completed', { results })
        
        return results;
      } catch (error) {
        log.error('clipboard', 'Failed to delete items', { error: error.message || error })
        return { success: false, error: error.message, deleted: 0, failed: itemIds.length };
      }
    });

    safeHandle('clipboard:move-items', async (event, itemIds, toSpaceId) => {
      try {
        if (!Array.isArray(itemIds) || itemIds.length === 0) {
          return { success: false, error: 'No items provided' };
        }
        
        if (!toSpaceId) {
          return { success: false, error: 'No target space provided' };
        }
        
        const results = {
          success: true,
          moved: 0,
          failed: 0,
          errors: []
        };
        
        for (const id of itemIds) {
          try {
            const success = this.storage.moveItem(id, toSpaceId);
            if (success) {
              results.moved++;
              log.info('clipboard', 'Moved item', { id, arg2: 'to space:', toSpaceId })
            } else {
              results.failed++;
              results.errors.push(`Failed to move ${id}`);
            }
          } catch (error) {
            results.failed++;
            results.errors.push(`Failed to move ${id}: ${error.message}`);
            log.error('clipboard', 'Failed to move item', { id, error })
          }
        }
        
        results.success = results.moved > 0;
        log.info('clipboard', 'Bulk move completed', { results })
        
        return results;
      } catch (error) {
        log.error('clipboard', 'Failed to move items', { error: error.message || error })
        return { success: false, error: error.message, moved: 0, failed: itemIds.length };
      }
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
      
      // DEBUG: Log item details
      log.info('clipboard', '📋 Pasting item', { detail: {
        id: item.id,
        type: item.type,
        fileName: item.fileName,
        hasContent: !!item.content,
        contentLength: item.content ? item.content.length : 0,
        contentPreview: item.content ? item.content.substring(0, 100) : 'none',
        filePath: item.filePath
      } })
      
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
        // Check if this is actually a text file stored as 'image' type (from drag-and-drop)
        const isTextFile = item.fileName && /\.(md|txt|json|js|ts|tsx|jsx|html|css|py|java|cpp|c|h|cs|php|rb|go|rs|swift|kt|xml|yaml|yml|csv|log|sh|bash)$/i.test(item.fileName);
        
        if (isTextFile && item.content.startsWith('data:')) {
          // Decode text file content from base64
          const base64Data = item.content.split(',')[1];
          if (base64Data) {
            const textContent = Buffer.from(base64Data, 'base64').toString('utf-8');
            clipboard.writeText(textContent);
          }
        } else {
          // Regular image - write as image
          const image = nativeImage.createFromDataURL(item.content);
          clipboard.writeImage(image);
        }
      } else if (item.type === 'file') {
        // For files, copy the actual content, not the file path
        if (item.fileType === 'image-file' && item.content) {
          // For image files, write as image
          const image = nativeImage.createFromDataURL(item.content);
          clipboard.writeImage(image);
        } else if (item.content) {
          // For text-based files (markdown, code, etc), copy the text content
          // Remove data URL prefix if present
          let textContent = item.content;
          if (textContent.startsWith('data:')) {
            // Extract base64 content and decode it
            const base64Data = textContent.split(',')[1];
            if (base64Data) {
              textContent = Buffer.from(base64Data, 'base64').toString('utf-8');
            }
          }
          clipboard.writeText(textContent);
        } else if (item.filePath) {
          // Fallback: if no content, copy file path
          clipboard.writeText(item.filePath);
        }
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
      try {
        const result = this.createSpace(space);
        return result;
      } catch (error) {
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
          log.error('clipboard', 'Item not found or no content path', { itemId })
          return { success: false, error: 'Item not found' };
        }
        
        const filePath = path.join(this.storage.storageRoot, item.contentPath);
        log.info('clipboard', 'Starting drag for', { filePath })
        
        if (!fs.existsSync(filePath)) {
          log.error('clipboard', 'File not found', { filePath })
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
        log.error('clipboard', 'Error', { error: error.message || error })
        return { success: false, error: error.message };
      }
    });
    
    // Float card for dragging items to external apps
    safeHandle('clipboard:float-item', (event, itemId) => {
      try {
        const item = this.storage.loadItem(itemId);
        if (!item) {
          log.error('clipboard', 'Item not found', { itemId })
          return { success: false, error: 'Item not found' };
        }
        
        log.info('clipboard', 'Creating float card for', { itemId })
        
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
            log.info('clipboard', 'Close requested')
            if (self.floatCardWindow && !self.floatCardWindow.isDestroyed()) {
              self.floatCardWindow.close();
              self.floatCardWindow = null;
              log.info('clipboard', 'Window closed')
            }
          });
          
          ipcMain.on('float-card:ready', () => { info: log.info('clipboard', 'Window ready') });
          
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
        log.error('clipboard', 'Error', { error: error.message || error })
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
              log.info('clipboard', 'Synced metadata to space-metadata.json for', { fileKey })
            }
          } catch (syncError) {
            log.error('clipboard', 'Error syncing to space metadata', { syncError })
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
    
    safeHandle('clipboard:get-metadata', (event, itemId) => {
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
              log.info('clipboard', 'Synced video scenes to space-metadata.json', { fileKey })
            }
          } catch (syncError) {
            log.error('clipboard', 'Error syncing scenes to space metadata', { syncError })
          }
        }
        
        log.info('clipboard', 'Updated ... scenes for video', { scenesCount: scenes.length })
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
        
        log.info('clipboard', 'Added scene "..." to video', { sceneName: scene.name })
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
        
        log.info('clipboard', 'Deleted scene ... from video', { sceneId })
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
            log.error('clipboard', 'Error loading scenes for video', { fileName: item.fileName, e })
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
        log.error('clipboard', 'Error getting videos with scenes', { error: error.message || error })
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
              log.error('clipboard', 'Error reading file content', { readError })
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
                log.info('clipboard', 'Loaded full-resolution image', { fileName: item.fileName, arg2: 'size:', bufferCount: buffer.length })
              }
            } catch (readError) {
              log.error('clipboard', 'Error reading image file', { readError })
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
        log.error('clipboard', 'Error getting item content', { error: error.message || error })
        return { success: false, error: error.message };
      }
    });
    
    // Get PDF data for PDF.js viewer
    safeHandle('clipboard:get-pdf-data', (event, itemId) => {
      try {
        const item = this.storage.loadItem(itemId);
        if (!item) return { success: false, error: 'Item not found' };
        
        if (item.fileType !== 'pdf' && item.fileExt !== '.pdf') {
          return { success: false, error: 'Item is not a PDF' };
        }
        
        // Get the PDF file path
        let pdfPath = item.content;
        if (!pdfPath || !fs.existsSync(pdfPath)) {
          // Try items directory
          const itemDir = path.join(this.storage.storageRoot, 'items', itemId);
          if (fs.existsSync(itemDir)) {
            const files = fs.readdirSync(itemDir).filter(f => f.toLowerCase().endsWith('.pdf'));
            if (files.length > 0) {
              pdfPath = path.join(itemDir, files[0]);
            }
          }
        }
        
        if (!pdfPath || !fs.existsSync(pdfPath)) {
          return { success: false, error: 'PDF file not found' };
        }
        
        // Read and return as base64
        const pdfBuffer = fs.readFileSync(pdfPath);
        const base64Data = pdfBuffer.toString('base64');
        
        log.info('clipboard', 'Loaded PDF', { fileName: item.fileName, arg2: 'size:', pdfBufferCount: pdfBuffer.length })
        
        return {
          success: true,
          data: base64Data,
          fileName: item.fileName,
          fileSize: pdfBuffer.length
        };
      } catch (error) {
        log.error('clipboard', 'Error getting PDF data', { error: error.message || error })
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
        log.info('clipboard', 'Saved content to: ...', { contentPath })
        
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
        
        log.info('clipboard', 'Updated content for item: ...', { itemId })
        return { success: true };
      } catch (error) {
        log.error('clipboard', 'Error updating item content', { error: error.message || error })
        return { success: false, error: error.message };
      }
    });
    
    // Convert DOCX to HTML for preview/editing
    safeHandle('clipboard:convert-docx-to-html', async (event, filePath) => {
      try {
        if (!filePath) {
          return { success: false, error: 'No file path provided' };
        }
        
        // Verify file exists
        if (!fs.existsSync(filePath)) {
          return { success: false, error: 'File not found: ' + filePath };
        }
        
        // Check if it's a docx file
        const ext = path.extname(filePath).toLowerCase();
        if (ext !== '.docx') {
          return { success: false, error: 'Only .docx files are supported' };
        }
        
        // Use mammoth to convert
        const mammoth = require('mammoth');
        const result = await mammoth.convertToHtml({ path: filePath });
        
        log.info('clipboard', 'Converted DOCX to HTML: ...', { filePath })
        if (result.messages && result.messages.length > 0) {
          log.info('clipboard', 'Mammoth messages', { messages: result.messages })
        }
        
        return { 
          success: true, 
          html: result.value,
          messages: result.messages || []
        };
      } catch (error) {
        log.error('clipboard', 'Error converting DOCX to HTML', { error: error.message || error })
        return { success: false, error: error.message };
      }
    });
    
    // Open file in system default application
    safeHandle('clipboard:open-in-system', async (event, filePath) => {
      try {
        if (!filePath) {
          return { success: false, error: 'No file path provided' };
        }
        
        // Verify file exists
        if (!fs.existsSync(filePath)) {
          return { success: false, error: 'File not found: ' + filePath };
        }
        
        // Use Electron shell to open file in default app
        const { shell } = require('electron');
        const result = await shell.openPath(filePath);
        
        // shell.openPath returns empty string on success, error message on failure
        if (result === '') {
          log.info('clipboard', 'Opened file: ...', { filePath })
          return { success: true };
        } else {
          log.error('clipboard', 'Failed to open file: ...', { result })
          return { success: false, error: result };
        }
      } catch (error) {
        log.error('clipboard', 'Error opening file in system', { error: error.message || error })
        return { success: false, error: error.message };
      }
    });
    
    // AI Image editing using OpenAI DALL-E
    safeHandle('clipboard:edit-image-ai', async (event, options) => {
      try {
        const { itemId, imageData, prompt } = options;
        
        // Get settings to check for API keys
        const { getSettingsManager } = require('./settings-manager');
        const settingsManager = getSettingsManager();
        const openaiKey = settingsManager.get('openaiApiKey');
        // Always use anthropicApiKey for Claude API calls (not llmApiKey which depends on provider)
        const anthropicKey = settingsManager.get('anthropicApiKey');
        
        if (!imageData) {
          return { success: false, error: 'No image data provided' };
        }
        
        log.info('clipboard', 'Processing edit request', { prompt })
        
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
        
        // Use centralized ai-service for true image editing (gpt-image-1)
        if (openaiKey) {
          log.info('clipboard', 'Using ai-service gpt-image-1 for image editing')
          
          try {
            const ai = require('./lib/ai-service');
            const imageBuffer = Buffer.from(base64Data, 'base64');
            
            log.info('clipboard', 'Sending image to gpt-image-1 edits endpoint...')
            
            const response = await ai.imageEdit(imageBuffer, prompt, {
              model: 'gpt-image-1',
              feature: 'clipboard-image-edit',
            });
            
            if (response.images && response.images[0]) {
              let editedImageData;
              
              if (response.images[0].b64_json) {
                editedImageData = `data:image/png;base64,${response.images[0].b64_json}`;
              } else if (response.images[0].url) {
                // Download the image from URL
                log.info('clipboard', 'Downloading edited image from URL...')
                const https = require('https');
                const imageUrl = response.images[0].url;
                const imageResponse = await new Promise((resolve, reject) => { on: https.get(imageUrl, (res) => {
                    const chunks = [];
                    res.on('data', chunk => chunks.push(chunk));
                    res.on('end', () => resolve(Buffer.concat(chunks)));
                    res.on('error', reject); }).on('error', reject);
                });
                editedImageData = `data:image/png;base64,${imageResponse.toString('base64')}`;
              }
              
              if (editedImageData) {
                log.info('clipboard', 'Successfully edited image with gpt-image-1')
                return { 
                  success: true, 
                  editedImage: editedImageData
                };
              }
            }
            
            throw new Error('No image data in response');
            
          } catch (editError) {
            log.error('clipboard', 'gpt-image-1 error', { error: editError.message })
            // Fall through to Claude analysis
          }
        }
        
        // Fallback: Use Claude to analyze and describe the edits
        if (anthropicKey) {
          log.info('clipboard', 'Using Claude for image analysis (no OpenAI key or DALL-E failed)')
          
          const visionPrompt = `I want to edit this image with the following changes: "${prompt}"

Please analyze the image and describe:
1. What you see in the current image
2. What specific changes would be made based on my request
3. How the final result would look

Respond in a helpful, conversational way.`;
          
          // Convert base64 data to data URI format for ai.vision()
          const imageDataUri = `data:${mediaType};base64,${base64Data}`;
          
          const result = await ai.vision(imageDataUri, visionPrompt, {
            profile: 'standard',
            maxTokens: 1000,
            feature: 'clipboard-manager',
          });
          
          const description = result.content;
          
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
        log.error('clipboard', 'Error', { error: error.message || error })
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
        
        log.info('clipboard', 'Updated image for item: ...', { itemId })
        return { success: true };
      } catch (error) {
        log.error('clipboard', 'Error updating item image', { error: error.message || error })
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
        
        // Determine target space: use provided spaceId, or get from source item, or use current space
        let targetSpaceId = options.spaceId;
        if (!targetSpaceId && options.sourceItemId) {
          // Try to get space from source item
          const sourceItem = this.history.find(h => h.id === options.sourceItemId);
          if (sourceItem && sourceItem.spaceId) {
            targetSpaceId = sourceItem.spaceId;
          }
        }
        if (!targetSpaceId) {
          targetSpaceId = this.currentSpace || 'unclassified';
        }
        
        // Create a new clipboard item
        const newItem = {
          type: 'image',
          timestamp: Date.now(),
          image: imageBuffer,
          preview: options.description || 'AI-edited image',
          spaceId: targetSpaceId,  // Use target space (from source item or current)
          metadata: {
            source: options.sourceItemId ? 'pdf-extraction' : 'ai-edit',
            sourceItemId: options.sourceItemId,
            description: options.description || 'AI-edited image'
          }
        };
        
        // Save using the storage system (addItem is the correct method)
        const savedItem = this.storage.addItem(newItem);
        
        // Add to history
        this.history.unshift({
          ...savedItem,
          thumbnail: imageData
        });
        
        // Notify UI
        this.notifyHistoryUpdate();
        
        log.info('clipboard', 'Saved new image item: ...', { savedItemId: savedItem.id })
        return { success: true, itemId: savedItem.id };
      } catch (error) {
        log.error('clipboard', 'Error saving image as new', { error: error.message || error })
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
        
        const textLength = text.length;
        const estimatedChunks = Math.ceil(textLength / 4000);
        const estimatedMinutes = Math.round(textLength / 150 / 60);
        log.info('clipboard', 'Generating speech with voice: ...', { voice })
        log.info('clipboard', 'Text length: ... chars, estimated ... chunks, ~... min audio', { textLength, estimatedChunks, estimatedMinutes })
        
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
          log.info('clipboard', 'Split text into ... chunks', { textChunksCount: textChunks.length })
        }
        
        // Generate audio for each chunk
        const audioBuffers = [];
        const totalChunks = textChunks.length;
        
        // Send progress to renderer
        const sendProgress = (current, total, status) => {
          if (BrowserWindow) {
            BrowserWindow.getAllWindows().forEach(window => {
              window.webContents.send('tts-progress', { current, total, status });
            });
          }
        };
        
        for (let i = 0; i < textChunks.length; i++) {
          const chunk = textChunks[i];
          log.info('clipboard', 'Generating chunk .../..., length: ...', { detail: i + 1, totalChunks, chunkCount: chunk.length })
          sendProgress(i + 1, totalChunks, `Generating audio chunk ${i + 1} of ${totalChunks}...`);
          
          const result = await ai.tts(chunk, {
            voice: voice,
            model: 'tts-1-hd',
            responseFormat: 'mp3',
            feature: 'clipboard-manager',
            timeout: 120000
          });
          
          const chunkAudio = result.audioBuffer;
          
          audioBuffers.push(chunkAudio);
          const chunkSizeKB = Math.round(chunkAudio.length / 1024);
          log.info('clipboard', 'Chunk .../... complete (... KB)', { detail: i + 1, totalChunks, chunkSizeKB })
        }
        
        // Combine all audio buffers
        sendProgress(totalChunks, totalChunks, 'Combining audio chunks...');
        const combinedBuffer = Buffer.concat(audioBuffers);
        const audioData = combinedBuffer.toString('base64');
        
        const totalSizeKB = Math.round(combinedBuffer.length / 1024);
        const totalSizeMB = (combinedBuffer.length / (1024 * 1024)).toFixed(2);
        log.info('clipboard', 'Successfully generated audio: ... chunks, ... KB (... MB)', { totalChunks, totalSizeKB, totalSizeMB })
        log.info('clipboard', 'Base64 encoded size: ... KB', { detail: Math.round(audioData.length / 1024) })
        sendProgress(totalChunks, totalChunks, 'Complete!');
        
        return { success: true, audioData, totalChunks, totalSizeBytes: combinedBuffer.length };
        
      } catch (error) {
        log.error('clipboard', 'Error generating speech', { error: error.message || error })
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
        
        log.info('clipboard', 'Creating audio script for: ..., content length: ...', { title, contentCount: content.length })
        
        // Use centralized AI service with gpt-4o override
        const result = await ai.chat({
          provider: 'openai',
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
          maxTokens: 8000,
          feature: 'clipboard-manager',
        });
        
        const scriptText = result.content;
        
        log.info('clipboard', 'Successfully created script, length: ...', { scriptTextCount: scriptText.length })
        
        return { success: true, script: scriptText };
        
      } catch (error) {
        log.error('clipboard', 'Error creating audio script', { error: error.message || error })
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
          log.info('clipboard', 'Attaching audio to source item: ...', { sourceItemId })
          
          // Find the source item
          const sourceItem = this.history.find(h => h.id === sourceItemId);
          if (sourceItem) {
            // Get the item directory
            const itemDir = path.join(this.storage.itemsDir, sourceItemId);
            log.info('clipboard', 'Item directory: ...', { itemDir })
            
            if (!fs.existsSync(itemDir)) {
              log.info('clipboard', 'Creating directory: ...', { itemDir })
              fs.mkdirSync(itemDir, { recursive: true });
            }
            
            // Save audio in the item's directory
            const audioPath = path.join(itemDir, 'tts-audio.mp3');
            log.info('clipboard', 'Writing ... bytes to: ...', { audioBufferCount: audioBuffer.length, audioPath })
            fs.writeFileSync(audioPath, audioBuffer);
            
            // Verify file was written
            if (fs.existsSync(audioPath)) {
              const stats = fs.statSync(audioPath);
              log.info('clipboard', 'File verified, size: ... bytes', { size: stats.size })
            } else {
              log.error('clipboard', `[TTS] ERROR: File was not written!`)
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
            log.info('clipboard', `[TTS] Metadata updated with ttsAudio reference`)
            
            // Update the index entry
            this.storage.updateItemIndex(sourceItemId, {
              hasTTSAudio: true,
              ttsVoice: voice
            });
            
            log.info('clipboard', 'Successfully attached audio to item ...', { sourceItemId })
            return { success: true, itemId: sourceItemId, attached: true };
          } else {
            log.error('clipboard', 'Source item not found in history: ...', { sourceItemId })
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
        
        log.info('clipboard', 'Saved audio as new item: ...', { audioPath })
        return { success: true, itemId: indexEntry.id, attached: false };
        
      } catch (error) {
        log.error('clipboard', 'Error saving audio', { error: error.message || error })
        return { success: false, error: error.message };
      }
    });
    
    // Get TTS audio for an item (if attached)
    safeHandle('clipboard:get-tts-audio', async (event, itemId) => {
      try {
        log.info('clipboard', 'Getting audio for item: ...', { itemId })
        const itemDir = path.join(this.storage.itemsDir, itemId);
        const audioPath = path.join(itemDir, 'tts-audio.mp3');
        
        log.info('clipboard', 'Checking path: ...', { audioPath })
        log.info('clipboard', 'File exists: ...', { detail: fs.existsSync(audioPath) })
        
        if (fs.existsSync(audioPath)) {
          const stats = fs.statSync(audioPath);
          log.info('clipboard', 'File size: ... bytes', { size: stats.size })
          
          const audioData = fs.readFileSync(audioPath);
          const base64 = audioData.toString('base64');
          log.info('clipboard', 'Base64 length: ...', { base64Count: base64.length })
          
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
        
        log.info('clipboard', 'No audio file found for item: ...', { itemId })
        return { success: true, hasAudio: false };
      } catch (error) {
        log.error('clipboard', 'Error getting audio', { error: error.message || error })
        return { success: false, error: error.message };
      }
    });
    
    // Extract audio from video file
    safeHandle('clipboard:extract-audio', async (event, itemId) => {
      try {
        log.info('clipboard', 'Extracting audio for item', { itemId })
        
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
        
        log.info('clipboard', 'Starting ffmpeg extraction from', { videoPath })
        log.info('clipboard', 'Output path', { audioPath })
        
        await new Promise((resolve, reject) => {
          ffmpeg(videoPath)
            .noVideo()
            .audioCodec('libmp3lame')
            .audioBitrate('192k')
            .format('mp3')
            .output(audioPath)
            .on('start', (cmd) => {
              log.info('clipboard', 'FFmpeg command', { cmd })
              // Send initial progress
              if (event.sender && !event.sender.isDestroyed()) {
                event.sender.send('audio-extract-progress', { itemId, percent: 0, status: 'Starting...' });
              }
            })
            .on('progress', (progress) => {
              const percent = progress.percent ? Math.round(progress.percent) : 0;
              log.info('clipboard', 'Progress', { detail: percent + '%' })
              // Send progress to renderer
              if (event.sender && !event.sender.isDestroyed()) {
                event.sender.send('audio-extract-progress', { itemId, percent, status: `Extracting: ${percent}%` });
              }
            })
            .on('end', () => {
              log.info('clipboard', 'FFmpeg completed successfully')
              if (event.sender && !event.sender.isDestroyed()) { send: event.sender.send('audio-extract-progress', { itemId, percent: 100, status: 'Complete!' });
              }
              resolve();
            })
            .on('error', (err) => {
              log.error('clipboard', 'FFmpeg error', { error: err.message })
              if (event.sender && !event.sender.isDestroyed()) {
                event.sender.send('audio-extract-progress', { itemId, percent: 0, status: 'Error: ' + err.message });
              }
              reject(err);
            })
            .run();
        });
        
        log.info('clipboard', 'Audio extracted to', { audioPath })
        
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
        log.error('clipboard', 'Error', { error: error.message || error })
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
        
        log.info('clipboard', 'Transcribing file: ...', { audioPath })
        
        // Check if it's a video file - need to extract audio first
        const fileExt = path.extname(audioPath).toLowerCase().replace('.', '') || 'mp3';
        const videoFormats = ['mp4', 'mov', 'avi', 'mkv', 'webm', 'flv', 'wmv', 'm4v'];
        const isVideo = videoFormats.includes(fileExt) || 
                       (item.fileType && item.fileType.startsWith('video/')) ||
                       item.fileCategory === 'video';
        
        let transcribePath = audioPath;
        let tempAudioPath = null;
        
        if (isVideo) {
          log.info('clipboard', `[Transcription] Video file detected, extracting audio...`)
          
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
            
            log.info('clipboard', 'Audio extracted to: ...', { tempAudioPath })
            transcribePath = tempAudioPath;
          } catch (ffmpegError) {
            log.error('clipboard', 'FFmpeg error', { ffmpegError })
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
        
        log.info('clipboard', 'Successfully transcribed: ... words, ... speakers', { wordCount: result.wordCount, speakerCount: result.speakerCount })
        
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
        log.error('clipboard', 'Error', { error: error.message || error })
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
        const { transcription, sourceItemId, sourceFileName, attachToSource, spaceId } = options;
        
        if (!transcription) {
          return { success: false, error: 'No transcription provided' };
        }
        
        const timestamp = Date.now();
        
        // Determine target space: use provided spaceId, or get from source item, or use current space
        let targetSpaceId = spaceId;
        if (!targetSpaceId && sourceItemId) {
          // Try to get space from source item
          const sourceItem = this.history.find(h => h.id === sourceItemId);
          if (sourceItem && sourceItem.spaceId) {
            targetSpaceId = sourceItem.spaceId;
          }
        }
        if (!targetSpaceId) {
          targetSpaceId = this.currentSpace || 'unclassified';
        }
        
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
          
          log.info('clipboard', 'Attached to item ...', { sourceItemId })
          return { success: true, itemId: sourceItemId, attached: true };
        }
        
        // Create as new item (fallback)
        const preview = `📝 Transcription: "${transcription.substring(0, 50)}${transcription.length > 50 ? '...' : ''}"`;
        
        const newItem = {
          type: 'text',
          content: transcription,
          preview: preview,
          timestamp: timestamp,
          spaceId: targetSpaceId,  // Use target space (from source item or current)
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
        
        log.info('clipboard', 'Saved as new item: ...', { indexEntryId: indexEntry.id })
        return { success: true, itemId: indexEntry.id, attached: false };
        
      } catch (error) {
        log.error('clipboard', 'Error saving', { error: error.message || error })
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
            
            log.info('clipboard', 'Using Whisper transcription from metadata', { arg1: metadata.transcriptSegments.length, arg2: 'segments' })
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
            log.info('clipboard', 'Parsed', { arg1: segments?.length || 0, arg2: 'segments from speakers file' })
          } catch (e) {
            log.warn('clipboard', 'Could not parse speakers file', { error: e.message })
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
            log.info('clipboard', 'Found', { metadataCount: metadata.transcriptSegments.length, arg2: 'segments in metadata (source:', arg3: source + ')' })
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
        log.error('clipboard', 'Error getting', { error: error.message || error })
        return { success: false, error: error.message };
      }
    });
    
    // AI Summary Generation - create a summary from transcript
    safeHandle('clipboard:generate-summary', async (event, options) => {
      log.info('clipboard', '====== Handler called ======')
      try {
        const { itemId, transcript, title } = options;
        log.info('clipboard', 'Starting summary generation for item', { itemId })
        log.info('clipboard', 'Transcript length', { detail: transcript?.length || 0 })
        
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
        
        log.info('clipboard', 'Using API', { detail: isAnthropicKey ? 'Claude' : 'OpenAI' })
        
        let summary = '';
        
        // Use centralized AI service
        const summaryPrompt = `You are a skilled content summarizer. Given the following transcript${title ? ` from "${title}"` : ''}, write a comprehensive but concise summary.

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

Write the structured summary now:`;

        const result = await ai.chat({
          profile: isAnthropicKey ? 'standard' : 'fast',
          messages: [{ role: 'user', content: summaryPrompt }],
          maxTokens: 2000,
          feature: 'clipboard-manager',
        });
        
        summary = result.content;
        
        if (!summary) {
          return { success: false, error: 'Failed to generate summary' };
        }
        
        log.info('clipboard', 'Generated summary length', { summaryCount: summary.length })
        
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
        log.error('clipboard', 'Error', { error: error.message || error })
        return { success: false, error: error.message };
      }
    });
    
    // AI Speaker Identification - analyze transcript and assign speakers
    safeHandle('clipboard:identify-speakers', async (event, options) => {
      log.info('clipboard', '====== Handler called ======')
      try {
        const { itemId, transcript, contextHint } = options;
        log.info('clipboard', 'Starting speaker identification for item', { itemId })
        log.info('clipboard', 'Transcript length', { detail: transcript?.length || 0 })
        
        // Get API key from settings
        const { getSettingsManager } = require('./settings-manager');
        const settingsManager = getSettingsManager();
        
        // Get API keys - use dedicated key fields (anthropicApiKey, openaiApiKey)
        const anthropicApiKey = settingsManager.get('anthropicApiKey') || '';
        const openaiApiKey = settingsManager.get('openaiApiKey') || '';
        
        log.info('clipboard', 'Raw keys - anthropicApiKey', { arg1: !!anthropicApiKey, arg2: 'openaiApiKey:', arg3: !!openaiApiKey })
        
        // Use dedicated API key fields (no longer rely on llmApiKey which depends on provider)
        let claudeKey = anthropicApiKey && anthropicApiKey.startsWith('sk-ant-') ? anthropicApiKey : null;
        let openaiKey = openaiApiKey && openaiApiKey.startsWith('sk-') ? openaiApiKey : null;
        
        log.info('clipboard', 'Key detection - Claude', { arg1: !!claudeKey, arg2: 'OpenAI:', arg3: !!openaiKey })
        if (claudeKey) log.info('clipboard', 'Claude key prefix', { detail: claudeKey.substring(0, 15) + '...' })
        
        if (!claudeKey && !openaiKey) {
          return { success: false, error: 'No AI API key configured. Please add a Claude or OpenAI API key in Settings.' };
        }
        
        // Get model from settings (defaults to Claude Sonnet 4.5 or GPT-4o)
        const llmModel = settingsManager.get('llmModel') || (claudeKey ? 'claude-sonnet-4-5-20250929' : 'gpt-4o');
        log.info('clipboard', 'Using model', { llmModel })
        
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
                log.info('clipboard', 'Using timecoded segments', { arg1: metadata.transcript.segments.length, arg2: 'segments' })
              }
            }
          } catch (e) {
            log.info('clipboard', 'Could not load segments, using plain transcript')
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
        
        log.info('clipboard', 'Transcript length', { truncatedTranscriptCount: truncatedTranscript.length, arg2: 'needsChunking:', needsChunking })
        
        async function callClaude(prompt, systemMsg) {
          log.info('clipboard', 'Calling Claude API, prompt length', { promptCount: prompt.length })
          log.info('clipboard', 'Using model', { llmModel })
          log.info('clipboard', 'Using key', { detail: claudeKey ? claudeKey.substring(0, 15) + '...' : 'NONE' })
          
          const result = await ai.chat({
            profile: 'standard',
            messages: [
              { role: 'system', content: systemMsg },
              { role: 'user', content: prompt }
            ],
            maxTokens: 8000,
            feature: 'clipboard-manager',
            timeout: 120000,
          });
          
          log.info('clipboard', '✅ Successfully received response, text length', { contentCount: result.content.length })
          return result.content;
        }
        
        async function callOpenAI(prompt, systemMsg) {
          log.info('clipboard', 'Calling OpenAI API, prompt length', { promptCount: prompt.length })
          log.info('clipboard', 'Using model', { llmModel })
          
          const result = await ai.chat({
            provider: 'openai',
            model: llmModel,
            messages: [
              { role: 'system', content: systemMsg },
              { role: 'user', content: prompt }
            ],
            maxTokens: 8000,
            feature: 'clipboard-manager',
            timeout: 120000,
          });
          
          return result.content;
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
          
          log.info('clipboard', 'Processing', { arg1: chunks.length, arg2: 'chunks' })
          sendProgress(`Starting analysis: ${chunks.length} chunks to process...`, 0, chunks.length);
          
          // Process each chunk
          const processedChunks = [];
          let speakerContext = '';
          
          for (let i = 0; i < chunks.length; i++) {
            log.info('clipboard', 'Processing chunk', { arg1: i + 1, arg2: 'of', chunksCount: chunks.length })
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
          log.info('clipboard', 'Processing in single request')
          result = await callAI(userPrompt, systemPrompt);
        }
        
        log.info('clipboard', 'Successfully identified speakers, result length', { resultCount: result.length })
        
        // Save the speaker-identified transcript
        if (itemId) {
          const itemDir = path.join(this.storage.itemsDir, itemId);
          const speakerTranscriptPath = path.join(itemDir, 'transcription-speakers.txt');
          fs.writeFileSync(speakerTranscriptPath, result, 'utf8');
          log.info('clipboard', 'Saved speaker transcript to', { speakerTranscriptPath })
          
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
            log.info('clipboard', 'Updated metadata.transcript with speaker-identified version')
            
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
        log.error('clipboard', '====== ERROR ======')
        log.error('clipboard', 'Error message', { error: error.message })
        log.error('clipboard', 'Error stack', { stack: error.stack })
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
    
    // ========================================
    // WEB MONITOR IPC HANDLERS
    // ========================================
    
    safeHandle('clipboard:check-monitor-now', async (event, itemId) => {
      log.info('clipboard', 'Check now requested for', { itemId })
      try {
        // Find the monitor item - check both history and storage
        let item = this.history.find(h => h.id === itemId);
        if (!item) {
          // Try loading from storage
          const storageItem = this.storage.index.items.find(i => i.id === itemId);
          if (storageItem) {
            try {
              item = this.storage.loadItem(itemId);
            } catch (e) {
              log.error('clipboard', 'Failed to load item from storage', { error: e.message || e })
            }
          }
        }
        
        if (!item || item.type !== 'web-monitor') {
          return { success: false, error: 'Item not found or not a monitor' };
        }
        
        // Initialize website monitor if needed
        if (!this.websiteMonitor) {
          const WebsiteMonitor = require('./website-monitor');
          this.websiteMonitor = new WebsiteMonitor();
          await this.websiteMonitor.initialize();
        }
        
        // Get the actual monitor ID (without 'monitor-' prefix if present)
        let monitorId = item.monitorId;
        if (!monitorId && item.id.startsWith('monitor-')) {
          monitorId = item.id.replace('monitor-', '');
        }
        log.info('clipboard', 'Using monitorId', { monitorId })
        
        // Ensure the monitor is registered in WebsiteMonitor
        // (monitors are lost when app restarts since they're in-memory)
        if (!this.websiteMonitor.monitors.has(monitorId)) {
          log.info('clipboard', 'Re-registering monitor from item data...')
          // Re-add the monitor to WebsiteMonitor's in-memory list
          this.websiteMonitor.monitors.set(monitorId, {
            id: monitorId,
            url: item.url,
            name: item.name,
            selector: item.selector || 'body',
            includeScreenshot: true,
            lastChecked: item.lastChecked,
            lastContentHash: null,
            spaceId: 'web-monitors'
          });
        }
        
        // Run the check
        const result = await this.websiteMonitor.checkWebsite(monitorId);
        
        // Get current timeline
        const currentTimeline = item.timeline || [];
        const now = new Date().toISOString();
        
        // If timeline is empty, create a baseline entry
        if (currentTimeline.length === 0 && result && result.snapshot) {
          log.info('clipboard', 'Creating baseline entry for existing monitor...')
          
          const baselineEntry = {
            id: `baseline-${Date.now()}`,
            timestamp: now,
            type: 'baseline',
            summary: 'Initial baseline captured',
            screenshotPath: result.snapshot.screenshot || null,
            textLength: result.snapshot.textContent?.length || 0
          };
          
          // Update item with baseline
          item.timeline = [baselineEntry];
          item.lastChecked = now;
          
          // Update in history array
          const historyIndex = this.history.findIndex(h => h.id === itemId);
          if (historyIndex >= 0) {
            this.history[historyIndex].timeline = [baselineEntry];
            this.history[historyIndex].lastChecked = now;
          }
          
          // Update in storage
          await this.updateItemMetadata(itemId, { 
            timeline: [baselineEntry],
            lastChecked: now 
          });
          
          // Notify UI to refresh
          this.notifyHistoryUpdate();
          
          return { success: true, changed: false, baseline: true };
        }
        
        // Update item if changed
        if (result && result.changed) {
          await this.handleWebsiteChange(result);
        }
        
        // Update last checked time on the item
        item.lastChecked = now;
        
        // Update in history array
        const historyIndex = this.history.findIndex(h => h.id === itemId);
        if (historyIndex >= 0) {
          this.history[historyIndex].lastChecked = now;
        }
        
        // Update in storage
        await this.updateItemMetadata(itemId, { lastChecked: now });
        
        // Notify UI to refresh
        this.notifyHistoryUpdate();
        
        return { success: true, changed: result?.changed || false };
      } catch (error) {
        log.error('clipboard', 'Check now failed', { error: error.message || error })
        return { success: false, error: error.message };
      }
    });
    
    safeHandle('clipboard:set-monitor-status', async (event, itemId, status) => {
      log.info('clipboard', 'Set status', { itemId, status })
      try {
        const item = this.history.find(h => h.id === itemId);
        if (!item || item.type !== 'web-monitor') {
          return { success: false, error: 'Item not found or not a monitor' };
        }
        
        item.status = status;
        item.pauseReason = status === 'paused' ? 'user' : null;
        
        // Update in WebsiteMonitor too
        if (this.websiteMonitor && item.monitorId) {
          if (status === 'paused') {
            await this.websiteMonitor.pauseMonitor(item.monitorId);
          } else {
            await this.websiteMonitor.resumeMonitor(item.monitorId);
          }
        }
        
        await this.updateItemMetadata(itemId, { status, pauseReason: item.pauseReason });
        this.notifyHistoryUpdate();
        
        return { success: true };
      } catch (error) {
        log.error('clipboard', 'Set status failed', { error: error.message || error })
        return { success: false, error: error.message };
      }
    });
    
    safeHandle('clipboard:set-monitor-ai-enabled', async (event, itemId, enabled) => {
      log.info('clipboard', 'Set AI enabled', { itemId, enabled })
      try {
        const item = this.history.find(h => h.id === itemId);
        if (!item || item.type !== 'web-monitor') {
          return { success: false, error: 'Item not found or not a monitor' };
        }
        
        if (!item.settings) item.settings = {};
        item.settings.aiDescriptions = enabled;
        
        await this.updateItemMetadata(itemId, { settings: item.settings });
        
        return { success: true };
      } catch (error) {
        log.error('clipboard', 'Set AI enabled failed', { error: error.message || error })
        return { success: false, error: error.message };
      }
    });
    
    safeHandle('clipboard:set-monitor-check-interval', async (event, itemId, minutes) => {
      log.info('clipboard', 'Set check interval', { itemId, minutes, arg3: 'minutes' })
      try {
        const item = this.history.find(h => h.id === itemId);
        if (!item || item.type !== 'web-monitor') {
          return { success: false, error: 'Item not found or not a monitor' };
        }
        
        if (!item.settings) item.settings = {};
        item.settings.checkInterval = minutes;
        
        // Update in WebsiteMonitor too if it's running
        if (this.websiteMonitor && item.monitorId) {
          const monitor = this.websiteMonitor.monitors.get(item.monitorId);
          if (monitor) {
            monitor.checkInterval = minutes;
          }
        }
        
        await this.updateItemMetadata(itemId, { settings: item.settings });
        
        return { success: true };
      } catch (error) {
        log.error('clipboard', 'Set check interval failed', { error: error.message || error })
        return { success: false, error: error.message };
      }
    });
    
    // ========================================
    // END WEB MONITOR IPC HANDLERS
    // ========================================
    
    // ========================================
    // DATA SOURCE IPC HANDLERS
    // ========================================
    
    safeHandle('clipboard:add-data-source', async (event, data) => {
      log.info('clipboard', 'Adding data source', { name: data.name, sourceType: data.dataSource?.sourceType });
      try {
        const ds = data.dataSource || {};
        const itemId = `ds-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
        
        const item = {
          id: itemId,
          type: 'data-source',
          content: JSON.stringify(ds, null, 2),
          spaceId: data.spaceId || 'unclassified',
          name: data.name || '',
          dataSource: ds,
          sourceType: ds.sourceType || 'api',
          timestamp: Date.now()
        };
        
        const result = await this.storage.addItem(item);
        this.notifyHistoryUpdate();
        
        return { success: true, itemId: result?.id || itemId };
      } catch (error) {
        log.error('clipboard', 'Add data source failed', { error: error.message });
        return { success: false, error: error.message };
      }
    });
    
    safeHandle('clipboard:test-data-source', async (event, itemId, credential) => {
      log.info('clipboard', 'Testing data source connection', { itemId });
      try {
        // Load item
        const item = this.history.find(h => h.id === itemId) || this.storage.index.items.find(i => i.id === itemId);
        if (!item || item.type !== 'data-source') {
          return { success: false, error: 'Item not found or not a data source' };
        }
        
        const ds = item.dataSource || {};
        const conn = ds.connection || {};
        const url = conn.url;
        
        if (!url) {
          return { success: false, error: 'No URL configured' };
        }
        
        // Test connectivity with a simple fetch
        const startTime = Date.now();
        const headers = { ...(conn.headers || {}) };
        
        // Apply credential if provided
        if (credential && ds.auth) {
          if (ds.auth.type === 'bearer') {
            headers['Authorization'] = `Bearer ${credential}`;
          } else if (ds.auth.type === 'api-key' && ds.auth.headerName) {
            headers[ds.auth.headerName] = credential;
          } else if (ds.auth.type === 'basic') {
            headers['Authorization'] = `Basic ${Buffer.from(credential).toString('base64')}`;
          }
        }
        
        const https = require('https');
        const http = require('http');
        const urlObj = new URL(url);
        const transport = urlObj.protocol === 'https:' ? https : http;
        
        const testResult = await new Promise((resolve) => {
          const req = transport.request(url, {
            method: conn.method || 'GET',
            headers,
            timeout: Math.min(conn.timeout || 10000, 15000)
          }, (res) => {
            const elapsed = Date.now() - startTime;
            resolve({ success: res.statusCode < 400, statusCode: res.statusCode, responseTime: elapsed });
            res.destroy();
          });
          req.on('error', (err) => {
            resolve({ success: false, error: err.message, responseTime: Date.now() - startTime });
          });
          req.on('timeout', () => {
            req.destroy();
            resolve({ success: false, error: 'Connection timed out', responseTime: Date.now() - startTime });
          });
          req.end();
        });
        
        // Update status
        const newStatus = testResult.success ? 'active' : 'error';
        const updates = {
          dataSource: {
            ...ds,
            status: newStatus,
            lastTestedAt: new Date().toISOString(),
            lastError: testResult.success ? null : (testResult.error || `HTTP ${testResult.statusCode}`)
          }
        };
        
        // Update in-memory and storage
        if (item.dataSource) {
          item.dataSource.status = newStatus;
          item.dataSource.lastTestedAt = updates.dataSource.lastTestedAt;
          item.dataSource.lastError = updates.dataSource.lastError;
        }
        item.dataSourceStatus = newStatus;
        item.lastTestedAt = updates.dataSource.lastTestedAt;
        
        await this.updateItemMetadata(itemId, updates);
        this.notifyHistoryUpdate();
        
        return testResult;
      } catch (error) {
        log.error('clipboard', 'Test data source failed', { error: error.message });
        return { success: false, error: error.message };
      }
    });
    
    safeHandle('clipboard:update-data-source-document', async (event, itemId, content, visibility) => {
      log.info('clipboard', 'Updating data source document', { itemId, visibility });
      try {
        const item = this.history.find(h => h.id === itemId) || this.storage.index.items.find(i => i.id === itemId);
        if (!item || item.type !== 'data-source') {
          return { success: false, error: 'Item not found or not a data source' };
        }
        
        const ds = item.dataSource || {};
        ds.document = {
          content: content || '',
          visibility: visibility || 'private',
          lastUpdated: new Date().toISOString()
        };
        
        await this.updateItemMetadata(itemId, { dataSource: ds });
        this.notifyHistoryUpdate();
        
        return { success: true };
      } catch (error) {
        log.error('clipboard', 'Update data source document failed', { error: error.message });
        return { success: false, error: error.message };
      }
    });
    
    // ========================================
    // END DATA SOURCE IPC HANDLERS
    // ========================================
    
    // Get video file path from item ID (with optional scenes from metadata)
    safeHandle('clipboard:get-video-path', async (event, itemId) => {
      try {
        log.info('clipboard', 'Getting video path for item', { itemId })
        
        // First check the index entry's contentPath (most reliable)
        const indexEntry = this.storage.index.items.find(i => i.id === itemId);
        log.info('clipboard', 'Index entry', { detail: indexEntry ? { contentPath: indexEntry.contentPath, fileName: indexEntry.fileName } : 'null' })
        
        // Helper to load scenes from metadata
        const loadScenes = (itemId) => {
          try {
            const metadataPath = path.join(this.storage.itemsDir, itemId, 'metadata.json');
            if (fs.existsSync(metadataPath)) {
              const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
              return metadata.scenes || [];
            }
          } catch (e) {
            log.error('clipboard', 'Error loading scenes', { error: e.message || e })
          }
          return [];
        };
        
        if (indexEntry?.contentPath) {
          const contentPath = path.join(this.storage.storageRoot, indexEntry.contentPath);
          log.info('clipboard', 'Checking contentPath', { contentPath })
          if (fs.existsSync(contentPath)) {
            log.info('clipboard', 'Found video at contentPath', { contentPath })
            const scenes = loadScenes(itemId);
            return { 
              success: true, 
              filePath: contentPath, 
              fileName: indexEntry.fileName,
              scenes: scenes
            };
          } else {
            log.info('clipboard', 'contentPath file does not exist')
          }
        }
        
        // Try to get from item directly
        const item = this.history.find(h => h.id === itemId);
        if (item?.filePath && fs.existsSync(item.filePath)) { filePath: log.info('clipboard', 'Found filePath on item', { filePath: item.filePath })
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
          log.info('clipboard', 'Found filePath in full item', { filePath: fullItem.filePath })
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
        log.info('clipboard', 'Checking item dir', { itemDir })
        if (fs.existsSync(itemDir)) {
          const files = fs.readdirSync(itemDir);
          log.info('clipboard', 'Files in item dir', { files })
          const videoExtensions = ['.mp4', '.avi', '.mov', '.wmv', '.flv', '.mkv', '.webm', '.m4v', '.mpg', '.mpeg'];
          const videoFile = files.find(f => videoExtensions.some(ext => f.toLowerCase().endsWith(ext)));
          if (videoFile) {
            const videoPath = path.join(itemDir, videoFile);
            log.info('clipboard', 'Found video file in item dir', { videoPath })
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
        log.error('clipboard', 'Video file not found. Expected at', { expectedPath })
        return { 
          success: false, 
          error: `Video file is missing from storage. The file may have been deleted or moved. Expected: ${indexEntry?.fileName || 'unknown'}`
        };
      } catch (error) {
        log.error('clipboard', 'Error getting video path', { error: error.message || error })
        return { success: false, error: error.message };
      }
    });
    
    // Open video in Video Editor
    safeHandle('clipboard:open-video-editor', async (event, filePath) => {
      try {
        const { BrowserWindow } = require('electron');
        const path = require('path');
        
        log.info('clipboard', 'Opening Video Editor with file', { filePath })
        
        if (!filePath || !fs.existsSync(filePath)) {
          log.error('clipboard', 'Video file not found', { filePath })
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
          log.info('clipboard', 'Video Editor loaded, sending file path', { filePath })
          videoEditorWindow.webContents.send('video-editor:load-file', filePath);
        });
        
        // Setup video editor IPC for this window
        if (global.videoEditor) {
          global.videoEditor.setupIPC(videoEditorWindow);
        }
        
        return { success: true };
      } catch (error) {
        log.error('clipboard', 'Error opening Video Editor', { error: error.message || error })
        return { success: false, error: error.message };
      }
    });
    
    safeHandle('clipboard:get-current-user', () => {
      // Try to get user email from multi-tenant store (from 'or' cookie user data)
      try {
        const multiTenantStore = require('./multi-tenant-store');
        
        // Check edison first (most common), then other environments
        const environments = ['edison', 'staging', 'production'];
        for (const env of environments) {
          const userData = multiTenantStore.getOrTokenUserData(env);
          if (userData && userData.username) {
            // Username from 'or' cookie is typically an email
            return userData.username;
          }
        }
      } catch (e) {
        // Multi-tenant store not available, fall back to system username
      }
      
      // Fall back to system username (won't create Person node without @)
      return os.userInfo().username || 'Unknown';
    });
    
    // AI metadata generation
    safeHandle('clipboard:generate-metadata-ai', async (event, { itemId, apiKey, customPrompt }) => {
      log.info('clipboard', 'Generate metadata request received', { detail: { itemId, hasApiKey: !!apiKey, hasCustomPrompt: !!customPrompt } })
      
      try {
        // Use the NEW specialized metadata generator
        const MetadataGenerator = require('./metadata-generator');
        const metadataGen = new MetadataGenerator(this);
        
        // Fallback to anthropicApiKey if no key provided (for Claude API)
        let effectiveApiKey = apiKey;
        if (!effectiveApiKey) {
          const { getSettingsManager } = require('./settings-manager');
          const settingsManager = getSettingsManager();
          effectiveApiKey = settingsManager.get('anthropicApiKey') || settingsManager.get('llmApiKey');
        }
        
        log.info('clipboard', 'Calling generateMetadataForItem...')
        const result = await metadataGen.generateMetadataForItem(itemId, effectiveApiKey, customPrompt);
        log.info('clipboard', 'Result', { detail: { success: result.success, error: result.error } })

        if (result.success) {
          // Get the updated item to return full metadata
          const item = this.storage.loadItem(itemId);
          log.info('clipboard', 'Returning success with metadata')
          return {
            success: true,
            metadata: item.metadata,
            message: 'Metadata generated successfully'
          };
        } else {
          log.info('clipboard', 'Returning failure', { error: result.error })
          return result;
        }
      } catch (err) {
        log.error('clipboard', 'Exception', { error: err.message })
        return { success: false, error: err.message };
      }
    });
    
    // Handle capture methods for external AI windows
    safeHandle('clipboard:capture-text', async (event, text) => {
      log.info('clipboard', 'Capturing text from external window', { detail: text.substring(0, 100) + '...' })
      
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
      log.info('clipboard', 'Capturing HTML from external window')
      
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
      log.info('clipboard', 'get-audio-data called for', { itemId })
      
      const item = this.history.find(h => h.id === itemId);
      log.info('clipboard', 'Found item', { detail: item ? { type: item.type,
        fileType: item.fileType,
        fileCategory: item.fileCategory,
        filePath: item.filePath,
        _needsContent: item._needsContent
      } : 'null' })
      
      const isAudioOrVideo = item && item.type === 'file' && 
        (item.fileType === 'audio' || item.fileType === 'video' || 
         item.fileCategory === 'audio' || item.fileCategory === 'video');
      
      if (!item || !isAudioOrVideo) {
        log.error('clipboard', 'Not an audio/video file or not found')
        return { success: false, error: 'Audio/video file not found' };
      }
      
      try {
        let filePath = item.filePath;
        
        // Load full item if needed
        if (item._needsContent || !filePath) {
          log.info('clipboard', 'Loading full item from storage...')
          const fullItem = this.storage.loadItem(itemId);
          log.info('clipboard', 'Full item loaded', { detail: fullItem ? { filePath: fullItem.filePath } : 'null' })
          filePath = fullItem?.filePath;
        }
        
        if (filePath && fs.existsSync(filePath)) {
          const isVideo = item.fileCategory === 'video' || 
                         (item.fileType && item.fileType.startsWith('video/'));
          
          // For videos, return file path directly (don't load into memory)
          if (isVideo) {
            log.info('clipboard', 'Video file - returning path', { filePath })
            const mimeType = this.getMediaMimeType(item.fileExt, item.fileType);
            return { 
              success: true, 
              filePath: filePath,
              mimeType: mimeType,
              isVideo: true
            };
          }
          
          // For audio files, load as base64 (they're typically small enough)
          log.info('clipboard', 'Audio file - reading into memory', { filePath })
          const mediaData = fs.readFileSync(filePath);
          const base64 = mediaData.toString('base64');
          const mimeType = this.getMediaMimeType(item.fileExt, item.fileType);
          const dataUrl = `data:${mimeType};base64,${base64}`;
          log.info('clipboard', 'Success - data length', { base64Count: base64.length })
          return { success: true, dataUrl };
        }
        
        log.error('clipboard', 'File not found at', { filePath })
        return { success: false, error: 'Media file no longer exists at: ' + filePath };
      } catch (error) {
        log.error('clipboard', 'Error reading media file', { error: error.message || error })
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
    
    // Get JSON asset file path
    safeHandle('clipboard:get-json-asset-path', async (event, itemId) => {
      try {
        const item = this.storage.loadItem(itemId);
        if (!item) {
          return { success: false, error: 'Item not found' };
        }
        
        const indexEntry = this.storage.index.items.find(i => i.id === itemId);
        if (!indexEntry?.contentPath) {
          return { success: false, error: 'Content path not found' };
        }
        
        const filePath = path.join(this.storage.storageRoot, indexEntry.contentPath);
        if (!fs.existsSync(filePath)) {
          return { success: false, error: 'File not found: ' + filePath };
        }
        
        return { success: true, filePath, jsonSubtype: indexEntry.jsonSubtype };
      } catch (error) {
        log.error('clipboard', 'Error getting JSON asset path', { error: error.message || error })
        return { success: false, error: error.message };
      }
    });
    
    // Open Style Guide Editor
    safeHandle('clipboard:open-style-guide-editor', async (event, itemId) => {
      try {
        const { BrowserWindow, shell } = require('electron');
        
        // Get the file path for this item
        const pathResult = await ipcMain.emit('clipboard:get-json-asset-path', event, itemId);
        const indexEntry = this.storage.index.items.find(i => i.id === itemId);
        
        if (!indexEntry?.contentPath) {
          return { success: false, error: 'Item not found or missing content path' };
        }
        
        const filePath = path.join(this.storage.storageRoot, indexEntry.contentPath);
        
        if (!fs.existsSync(filePath)) {
          return { success: false, error: 'Style guide file not found' };
        }
        
        log.info('clipboard', 'Opening Style Guide Editor with file', { filePath })
        
        // Open the style guide preview with the file data
        const styleGuideWindow = new BrowserWindow({
          width: 1200,
          height: 900,
          title: 'Style Guide Editor',
          webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload-smart-export.js')
          }
        });
        
        // Load the style guide HTML file
        styleGuideWindow.loadFile('smart-export-style-guide.html');
        
        // Pass the file path to the window when it's ready
        styleGuideWindow.webContents.once('did-finish-load', () => {
          styleGuideWindow.webContents.send('load-style-guide-file', filePath);
        });
        
        return { success: true };
      } catch (error) {
        log.error('clipboard', 'Error opening Style Guide Editor', { error: error.message || error })
        return { success: false, error: error.message };
      }
    });
    
    // Open Journey Map Editor
    safeHandle('clipboard:open-journey-map-editor', async (event, itemId) => {
      try {
        const { BrowserWindow, shell } = require('electron');
        
        const indexEntry = this.storage.index.items.find(i => i.id === itemId);
        
        if (!indexEntry?.contentPath) {
          return { success: false, error: 'Item not found or missing content path' };
        }
        
        const filePath = path.join(this.storage.storageRoot, indexEntry.contentPath);
        
        if (!fs.existsSync(filePath)) {
          return { success: false, error: 'Journey map file not found' };
        }
        
        log.info('clipboard', 'Opening Journey Map Editor with file', { filePath })
        
        // For now, show the file in Finder as there may not be a dedicated journey editor
        // In the future, this could open a dedicated journey map editor window
        shell.showItemInFolder(filePath);
        
        // Also try to open the smart export preview which can display journey maps
        const journeyWindow = new BrowserWindow({
          width: 1400,
          height: 900,
          title: 'Journey Map Viewer',
          webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload-smart-export.js')
          }
        });
        
        journeyWindow.loadFile('smart-export-preview.html');
        
        // Pass the file path to the window when it's ready
        journeyWindow.webContents.once('did-finish-load', () => {
          journeyWindow.webContents.send('load-journey-map-file', filePath);
        });
        
        return { success: true };
      } catch (error) {
        log.error('clipboard', 'Error opening Journey Map Editor', { error: error.message || error })
        return { success: false, error: error.message };
      }
    });
    
    // Screenshot capture
    safeHandle('clipboard:get-screenshot-capture-enabled', () => {
      return this.screenshotCaptureEnabled;
    });
    
    safeHandle('clipboard:toggle-screenshot-capture', (event, enabled) => {
      this.screenshotCaptureEnabled = enabled;
      this.savePreferences();
      
      if (enabled && !this.screenshotWatcher) {
        log.info('clipboard', 'Re-enabling screenshot watcher...')
        this.setupScreenshotWatcher();
      } else if (!enabled && this.screenshotWatcher) {
        log.info('clipboard', 'Disabling screenshot watcher...')
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
      log.info('clipboard', 'Requested thumbnail for item', { itemId, arg2: 'page:', pageNumber })
      
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
        log.error('clipboard', 'Error generating page thumbnail', { error: error.message || error })
        return { success: false, error: error.message };
      }
    });
    
    // Black hole handlers - using ContentIngestionService for validation
    ipcMain.handle('black-hole:add-text', async (event, data) => {
      const opId = `add-text-${Date.now()}`;
      log.info('clipboard', '═══════════════════════════════════════', { opId })
      log.info('clipboard', 'ADD-TEXT HANDLER - Time: ...', { opId, detail: new Date().toISOString() })
      log.info('clipboard', 'Data', { opId })
      
      // Get ingestion service for validation
      const ingestionService = getContentIngestionService(this);
      
      try {
        // Quick validation using ingestion service
        const validation = ingestionService.validateContent('text', data);
        if (!validation.valid) {
          log.error('clipboard', 'Validation failed', { opId })
          return { success: false, error: validation.errors.join('; '), code: 'VALIDATION_ERROR' };
        }
        
        // Check if content is a YouTube URL (special handling)
        let isYouTubeUrl;
        try {
          const ytModule = require('./youtube-downloader');
          isYouTubeUrl = ytModule.isYouTubeUrl;
        } catch (e) {
          log.warn('clipboard', 'YouTube module not available', { opId })
          isYouTubeUrl = () => false;
        }
        
        const content = data.content?.trim();
        const isYT = isYouTubeUrl(content);
        
        if (isYT) {
          log.info('clipboard', 'YouTube URL detected - returning for download handling', { opId })
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
          log.warn('clipboard', 'Context capture failed', { opId })
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
        log.info('clipboard', 'Saving text item to space: ...', { opId, spaceId: item.spaceId })
        await this.addToHistory(item);
        
        // Get the saved item ID
        const savedItem = this.history?.[0];
        log.info('clipboard', '✓ Text saved successfully, itemId: ...', { opId, detail: savedItem?.id })
        
        return { success: true, itemId: savedItem?.id };
        
      } catch (error) {
        log.error('clipboard', 'ERROR', { opId })
        log.error('clipboard', 'Stack', { opId })
        return ingestionService.handleError(error, { opId, type: 'text', spaceId: data?.spaceId });
      }
    });
    
    ipcMain.handle('black-hole:add-html', async (event, data) => {
      const opId = `add-html-${Date.now()}`;
      log.info('clipboard', 'ADD-HTML HANDLER - spaceId: ...', { opId, detail: data?.spaceId })
      
      const ingestionService = getContentIngestionService(this);
      
      try {
        // Validate
        const validation = ingestionService.validateContent('html', data);
        if (!validation.valid) {
          log.error('clipboard', 'Validation failed', { opId })
          return { success: false, error: validation.errors.join('; '), code: 'VALIDATION_ERROR' };
        }
        
        // Capture app context
        let context = null;
        try {
          context = await this.contextCapture.getFullContext();
        } catch (error) {
          log.warn('clipboard', 'Context capture failed', { opId })
        }
        
        // Enhance source detection
        const detectedSource = context 
          ? this.contextCapture.enhanceSourceDetection(data.plainText || data.content, context)
          : 'black-hole';
        
        // Build item - handle both "html" and "content" keys (black hole uses "html")
        const htmlContent = data.html || data.content || '';
        const item = {
          type: 'html',
          content: htmlContent,
          plainText: data.plainText || data.text || '',
          preview: this.truncateText(data.plainText || data.text || this.stripHtml(htmlContent), 100),
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
        log.info('clipboard', 'Saving HTML item to space: ...', { opId, spaceId: item.spaceId })
        await this.addToHistory(item);
        
        const savedItem = this.history?.[0];
        log.info('clipboard', '✓ HTML saved successfully, itemId: ...', { opId, detail: savedItem?.id })
        
        return { success: true, itemId: savedItem?.id };
        
      } catch (error) {
        log.error('clipboard', 'ERROR', { opId })
        return ingestionService.handleError(error, { opId, type: 'html', spaceId: data?.spaceId });
      }
    });
    
    ipcMain.handle('black-hole:add-image', async (event, data) => {
      const opId = `add-image-${Date.now()}`;
      log.info('clipboard', 'ADD-IMAGE HANDLER - spaceId: ...', { opId, detail: data?.spaceId })
      
      const ingestionService = getContentIngestionService(this);
      
      try {
        // Validate
        const validation = ingestionService.validateContent('image', data);
        if (!validation.valid) {
          log.error('clipboard', 'Validation failed', { opId })
          return { success: false, error: validation.errors.join('; '), code: 'VALIDATION_ERROR' };
        }
        
        // Capture app context
        let context = null;
        try {
          context = await this.contextCapture.getFullContext();
        } catch (error) {
          log.warn('clipboard', 'Context capture failed', { opId })
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
        log.info('clipboard', 'Saving image to space: ...', { opId, spaceId: item.spaceId })
        await retryOperation(
          () => this.addToHistory(item),
          { maxRetries: 3, baseDelay: 200 }
        );
        
        const savedItem = this.history?.[0];
        log.info('clipboard', '✓ Image saved successfully, itemId: ...', { opId, detail: savedItem?.id })
        
        return { success: true, itemId: savedItem?.id };
        
      } catch (error) {
        log.error('clipboard', 'ERROR', { opId })
        return ingestionService.handleError(error, { opId, type: 'image', spaceId: data?.spaceId });
      }
    });
    
    ipcMain.handle('black-hole:add-file', async (event, data) => {
      const opId = `add-file-${Date.now()}`;
      log.info('clipboard', 'ADD-FILE HANDLER - spaceId: ..., fileName: ...', { opId, detail: data?.spaceId, detail: data?.fileName })
      
      const ingestionService = getContentIngestionService(this);
      
      try {
        // CRITICAL FIX: If filePath is provided (from paste), read the file
        if (data.filePath && !data.fileName) {
          try {
            if (!fs.existsSync(data.filePath)) {
              log.error('clipboard', 'File does not exist', { opId })
              return { success: false, error: 'File does not exist: ' + data.filePath, code: 'FILE_NOT_FOUND' };
            }
            
            const stats = fs.statSync(data.filePath);
            if (!stats.isFile()) {
              log.error('clipboard', 'Path is not a file', { opId })
              return { success: false, error: 'Path is not a file: ' + data.filePath, code: 'NOT_A_FILE' };
            }
            
            // Extract file info from path
            data.fileName = path.basename(data.filePath);
            data.fileSize = stats.size;
            
            // Read file data as base64
            const fileBuffer = fs.readFileSync(data.filePath);
            data.fileData = fileBuffer.toString('base64');
            
            log.info('clipboard', 'File read from path', { opId })
          } catch (readError) {
            log.error('clipboard', 'Error reading file', { opId })
            return ingestionService.handleError(readError, { opId, type: 'file', spaceId: data?.spaceId });
          }
        }
        
        // Validate using ingestion service
        const validation = ingestionService.validateContent('file', data);
        if (!validation.valid) {
          log.error('clipboard', 'Validation failed', { opId })
          return { success: false, error: validation.errors.join('; '), code: 'VALIDATION_ERROR' };
        }
        
        // Capture app context
        let context = null;
        try {
          context = await this.contextCapture.getFullContext();
        } catch (error) {
          log.warn('clipboard', 'Context capture failed', { opId })
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
      } else if (['.ppt', '.pptx', '.key', '.odp'].includes(ext)) {
        fileCategory = 'presentation';
        fileType = 'presentation';
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
      
      // Detect JSON subtypes (style-guide, journey-map)
      let jsonSubtype = null;
      if (ext === '.json') {
        // Try to detect from file data first (if provided as base64)
        if (data.fileData) {
          try {
            const content = Buffer.from(data.fileData, 'base64').toString('utf8');
            jsonSubtype = this.detectJsonSubtype(content);
          } catch (e) {
            log.warn('clipboard', 'Error detecting JSON subtype from fileData', { error: e.message })
          }
        }
        // If not detected yet and we have a file path, try reading the file
        if (!jsonSubtype && data.filePath) {
          jsonSubtype = this.detectJsonSubtypeFromFile(data.filePath);
        }
        
        if (jsonSubtype) {
          log.info('clipboard', 'Detected JSON subtype: ... for file: ...', { jsonSubtype, fileName: data.fileName })
        }
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
        log.info('clipboard', 'Generated image thumbnail, mimeType', { mimeType, arg2: 'dataLength:', fileDataCount: data.fileData.length })
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
        jsonSubtype: jsonSubtype,  // style-guide, journey-map, or null
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
        log.info('clipboard', 'Preparing file data for storage', { fileName: data.fileName, arg2: 'size:', fileDataCount: data.fileData.length, arg4: 'chars' })
        
        // Create a temporary file that the storage system will copy
        const tempDir = path.join(app.getPath('temp'), 'clipboard-temp-files');
        if (!fs.existsSync(tempDir)) {
          fs.mkdirSync(tempDir, { recursive: true });
        }
        
        // Use unique filename to avoid conflicts
        const tempFilePath = path.join(tempDir, `${item.id}_${data.fileName}`);
        try {
          const buffer = Buffer.from(data.fileData, 'base64');
          fs.writeFileSync(tempFilePath, buffer);
          
          // Verify the temp file was written correctly
          if (!fs.existsSync(tempFilePath)) {
            throw new Error('Temp file was not created');
          }
          const tempStats = fs.statSync(tempFilePath);
          log.info('clipboard', 'Temp file created', { tempFilePath, arg2: 'size:', size: tempStats.size, arg4: 'bytes' })
          
          if (tempStats.size === 0) {
            throw new Error('Temp file has 0 bytes - base64 decode may have failed');
          }
          
          // Set filePath so storage system can copy it
          item.filePath = tempFilePath;
          item.fileName = data.fileName;
          
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
          log.error('clipboard', 'CRITICAL: Error creating temp file', { error: err.message })
          log.error('clipboard', 'This will cause the file to not be saved properly!')
          return { success: false, error: `Failed to create temp file: ${err.message}`, code: 'TEMP_FILE_ERROR' };
        }
      }
      
      // Add item to history with retry for transient disk errors
      log.info('clipboard', 'Saving file item to space: ...', { opId, spaceId: item.spaceId })
      try {
        await retryOperation(
          () => this.addToHistory(item),
          { maxRetries: 3, baseDelay: 200 }
        );
      } catch (addError) {
        log.error('clipboard', 'CRITICAL: Failed to add item to history', { opId })
        return { success: false, error: `Failed to save file: ${addError.message}`, code: 'SAVE_ERROR' };
      }
      
      // CRITICAL: Verify the file was actually saved to storage
      const storedFilePath = path.join(this.storage.storageRoot, 'items', item.id, item.fileName);
      if (!fs.existsSync(storedFilePath)) {
        log.error('clipboard', 'CRITICAL: File was not saved to storage!', { opId })
        log.error('clipboard', 'Expected location: ...', { opId, storedFilePath })
        log.error('clipboard', 'Source was: ...', { opId, filePath: item.filePath })
        
        // Check what files exist in the item directory
        const itemDir = path.join(this.storage.storageRoot, 'items', item.id);
        if (fs.existsSync(itemDir)) {
          const files = fs.readdirSync(itemDir);
          log.error('clipboard', 'Files in item directory', { opId })
        } else {
          log.error('clipboard', 'Item directory doesn\'t exist!', { opId })
        }
        
        // Don't return error here - item is in index, just missing file content
        // This helps diagnose the issue without breaking the flow
      } else {
        const savedStats = fs.statSync(storedFilePath);
        log.info('clipboard', 'File verified at: ..., size: ... bytes', { opId, storedFilePath, size: savedStats.size })
      }
      
      // Post-processing for PDFs and text files
      if (item.needsPDFThumbnail || item.needsTextPreview) {
        if (fs.existsSync(storedFilePath)) {
          // Generate PDF thumbnail
          if (item.needsPDFThumbnail) {
            log.info('clipboard', 'Generating real PDF thumbnail for stored file', { storedFilePath })
            await this.generateRealPDFThumbnail(storedFilePath, item);
          }
          
          // Generate text preview
          if (item.needsTextPreview) {
            try {
              log.info('clipboard', 'Generating text preview for stored file', { storedFilePath })
              const preview = await this.generateTextPreview(storedFilePath, item);
              if (preview && !preview.includes('svg+xml')) {
                // Update item with real preview
                const historyItem = this.history.find(h => h.id === item.id);
                if (historyItem) {
                  historyItem.thumbnail = preview;
                  log.info('clipboard', 'Updated item with text preview')
                  this.notifyHistoryUpdate();
                }
              }
            } catch (error) {
              log.error('clipboard', 'Error generating text preview', { error: error.message || error })
            }
          }
        } else {
          log.error('clipboard', 'Stored file not found at expected location', { storedFilePath })
        }
      }
      
      // Clean up temp file
      if (item.filePath && item.filePath.includes('clipboard-temp-files')) {
        try {
          fs.unlinkSync(item.filePath);
          log.info('clipboard', 'Cleaned up temp file', { opId })
        } catch (err) {
          // Ignore cleanup errors
        }
      }
      
      log.info('clipboard', '✓ File saved successfully, itemId: ...', { opId, itemId: item.id })
      return { success: true, itemId: item.id };
      
      } catch (error) {
        log.error('clipboard', 'ERROR', { opId })
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
        log.error('clipboard', 'Error generating PDF', { error: error.message || error })
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
        log.error('clipboard', 'Error exporting PDF', { error: error.message || error })
        return { success: false, error: error.message };
      }
    });
    
    // Smart export handlers
    safeHandle('clipboard:smart-export-space', async (event, spaceId) => {
      log.info('clipboard', 'Opening smart export for space', { spaceId })
      
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
        log.error('clipboard', 'Error opening smart export', { error: error.message || error })
        throw error;
      }
    });
    
    // Unified export preview handler
    safeHandle('clipboard:open-export-preview', async (event, spaceId, options = {}) => {
      log.info('clipboard', 'Opening export preview for space', { spaceId, arg2: 'Options:', options })
      
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
        log.error('clipboard', 'Error opening export preview', { error: error.message || error })
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
        log.error('clipboard', 'Error adding website monitor', { error: error.message || error })
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
        log.error('clipboard', 'Error checking website', { error: error.message || error })
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
        log.error('clipboard', 'Error getting monitors', { error: error.message || error })
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
        log.error('clipboard', 'Error getting monitor history', { error: error.message || error })
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
        log.error('clipboard', 'Error removing monitor', { error: error.message || error })
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
        log.error('clipboard', 'Error pausing monitor', { error: error.message || error })
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
        log.error('clipboard', 'Error resuming monitor', { error: error.message || error })
        return { success: false, error: error.message };
      }
    });
    
    // YouTube download handlers
    this.setupYouTubeHandlers(safeHandle);
  }
  
  // Setup YouTube download IPC handlers
  setupYouTubeHandlers(safeHandle) {
    log.info('clipboard', 'Setting up YouTube handlers...')
    const { YouTubeDownloader, isYouTubeUrl, extractVideoId } = require('./youtube-downloader');
    log.info('clipboard', 'YouTube module loaded, isYouTubeUrl', { detail: typeof isYouTubeUrl })
    
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
        log.info('clipboard', 'Verifying item', { itemId })
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
        
        log.info('clipboard', 'Item verified', { itemId, arg2: 'checksum:', checksum })
        
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
        log.error('clipboard', 'Error', { error: error.message || error })
        return { success: false, error: error.message };
      }
    });
    
    // Download video to Space
    ipcMain.handle('youtube:download-to-space', async (event, url, spaceId) => {
      log.info('clipboard', 'download-to-space called with URL', { url, arg2: 'spaceId:', spaceId })
      try {
        const dl = getDownloader();
        log.info('clipboard', 'Starting download...')
        const result = await dl.downloadToSpace(url, this, spaceId || this.currentSpace, (percent, status) => { info: log.info('clipboard', 'Progress', { percent, status })
          // Send progress updates to renderer
          if (event.sender && !event.sender.isDestroyed()) {
            event.sender.send('youtube:download-progress', { percent, status, url });
          }
        });
        log.info('clipboard', 'Download result', { detail: JSON.stringify(result) })
        return result;
      } catch (error) {
        log.error('clipboard', 'Download error', { error: error.message || error })
        return { success: false, error: error.message };
      }
    });
    
    // Start YouTube download in background - returns immediately with placeholder item
    ipcMain.handle('youtube:start-background-download', async (event, url, spaceId) => {
      log.info('clipboard', '*** start-background-download called ***')
      log.info('clipboard', 'URL', { url })
      log.info('clipboard', 'spaceId', { spaceId })
      
      try {
        const targetSpaceId = spaceId || this.currentSpace || 'unclassified';
        log.info('clipboard', 'targetSpaceId', { targetSpaceId })
        
        // Extract video ID from URL for immediate feedback
        const { extractVideoId } = require('./youtube-downloader');
        const videoId = extractVideoId(url);
        log.info('clipboard', 'Extracted videoId', { videoId })
        
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
        log.info('clipboard', 'Created placeholder item', { placeholderId })
        
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
        log.error('clipboard', 'Error starting background download', { error: error.message || error })
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
    
    // Cancel YouTube download
    ipcMain.handle('youtube:cancel-download', async (event, placeholderId) => {
      log.info('clipboard', 'Cancel download requested for', { placeholderId })
      try {
        const success = this.cancelDownload(placeholderId);
        return { success };
      } catch (error) {
        log.error('clipboard', 'Cancel error', { error: error.message || error })
        return { success: false, error: error.message };
      }
    });
    
    // Get active downloads
    ipcMain.handle('youtube:get-active-downloads', async (event) => {
      try {
        const downloads = Array.from(this.activeDownloads.entries()).map(([id, info]) => ({
          placeholderId: id,
          progress: info.progress,
          url: info.url,
          duration: Date.now() - info.startTime
        }));
        return { success: true, downloads };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });
    
    // Get transcript from YouTube video (using YouTube captions)
    ipcMain.handle('youtube:get-transcript', async (event, url, lang = 'en') => {
      log.info('clipboard', 'get-transcript called for', { url, arg2: 'lang:', lang })
      try {
        const dl = getDownloader();
        const result = await dl.getTranscript(url, lang);
        log.info('clipboard', 'Transcript result', { detail: result.success ? 'success' : result.error })
        return result;
      } catch (error) {
        log.error('clipboard', 'Transcript error', { error: error.message || error })
        return { success: false, error: error.message };
      }
    });
    
    // Fetch and save YouTube transcript for an existing item
    ipcMain.handle('youtube:fetch-transcript-for-item', async (event, itemId, lang = 'en') => {
      log.info('clipboard', 'fetch-transcript-for-item called for', { itemId, arg2: 'lang:', lang })
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
        
        log.info('clipboard', 'Fetching transcript for', { youtubeUrl })
        
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
          
          log.info('clipboard', 'Transcript saved for item', { itemId, arg2: 'length:', transcriptCount: result.transcript.length })
          
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
        log.error('clipboard', 'fetch-transcript-for-item error', { error: error.message || error })
        return { success: false, error: error.message };
      }
    });

    // Transcribe YouTube video using unified TranscriptionService (ElevenLabs Scribe)
    // Replaces legacy Whisper endpoint - now uses ElevenLabs with speaker diarization
    ipcMain.handle('youtube:get-transcript-whisper', async (event, url, lang = 'en') => {
      log.info('clipboard', 'Transcription requested for', { url, arg2: 'lang:', lang })
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
        
        log.info('clipboard', 'Transcription result', { detail: result.success ? 
          `${result.wordCount} words, ${ result.speakerCount} speakers` : result.error })
        return result;
      } catch (error) {
        log.error('clipboard', 'Transcription error', { error: error.message || error })
        return { success: false, error: error.message };
      }
    });

    // Process speaker recognition - now uses unified TranscriptionService
    // ElevenLabs Scribe includes speaker diarization by default
    ipcMain.handle('youtube:process-speaker-recognition', async (event, url) => {
      log.info('clipboard', 'Speaker recognition requested for', { url })
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
        
        log.info('clipboard', 'Speaker recognition result', { detail: result.success ? 
          `${result.speakerCount} speakers, ${ result.wordCount} words` : result.error })
        return result;
      } catch (error) {
        log.error('clipboard', 'Speaker recognition error', { error: error.message || error })
        return { success: false, error: error.message };
      }
    });

    log.info('clipboard', 'YouTube download handlers registered')
  }
  
  // Helper method for space names
  getSpaceName(spaceId) {
    // Ensure spaces are loaded before accessing (lazy loading pattern)
    this.ensureHistoryLoaded();
    
    if (!spaceId || spaceId === null) {
      return 'All Items';
    }
    const space = this.spaces.find(s => s.id === spaceId);
    return space ? `${space.icon} ${space.name}` : 'Unknown Space';
  }
  
  // Helper method to update item metadata
  async updateItemMetadata(itemId, metadata) {
    try {
      let item;
      try {
        item = this.storage.loadItem(itemId);
      } catch (loadErr) {
        // Item may have been deleted between creation and metadata update
        log.debug('clipboard', 'Metadata update skipped (item removed)', { itemId });
        return { success: false, error: 'Item not found' };
      }
      if (!item) return { success: false, error: 'Item not found' };
      
      // Save back to storage - merge with existing metadata to preserve app-specific fields
      const metadataPath = path.join(this.storage.storageRoot, 'items', itemId, 'metadata.json');
      
      // Read existing metadata from file and merge
      let existingMetadata = {};
      if (fs.existsSync(metadataPath)) {
        try {
          existingMetadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
        } catch (parseErr) {
          log.warn('clipboard', 'Could not parse existing metadata, starting fresh', { error: parseErr.message })
        }
      }
      
      // Merge: existing fields preserved, new fields added/updated
      const mergedMetadata = {
        ...existingMetadata,  // Keep all existing fields (playbookNoteId, _prefixed, assets, etc.)
        ...metadata           // Overlay with new/updated fields
      };
      
      // Update in-memory item
      item.metadata = mergedMetadata;
      
      // Write merged metadata to file
      fs.writeFileSync(metadataPath, JSON.stringify(mergedMetadata, null, 2));
      
      // Update in history array if present
      const historyItem = this.history.find(h => h.id === itemId);
      if (historyItem) {
        historyItem.metadata = mergedMetadata;
        
        // For web-monitor items, also update the direct fields
        if (historyItem.type === 'web-monitor') {
          if (metadata.lastChecked !== undefined) historyItem.lastChecked = metadata.lastChecked;
          if (metadata.status !== undefined) historyItem.status = metadata.status;
          if (metadata.changeCount !== undefined) historyItem.changeCount = metadata.changeCount;
          if (metadata.timeline !== undefined) historyItem.timeline = metadata.timeline;
        }
      }
      
      // Also update the storage index for web-monitor items
      const indexItem = this.storage.index.items.find(i => i.id === itemId);
      if (indexItem && indexItem.type === 'web-monitor') {
        if (metadata.lastChecked !== undefined) indexItem.lastChecked = metadata.lastChecked;
        if (metadata.status !== undefined) indexItem.status = metadata.status;
        if (metadata.changeCount !== undefined) indexItem.changeCount = metadata.changeCount;
        if (metadata.timeline !== undefined) indexItem.timeline = metadata.timeline;
        // Save the updated index
        this.storage.saveIndex();
      }
      
      this.notifyHistoryUpdate();
      
      return { success: true, metadata: mergedMetadata };
    } catch (error) {
      log.error('clipboard', 'Error updating metadata', { error: error.message || error })
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
      log.error('clipboard', 'Error showing item in Finder', { error: error.message || error })
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
    
    log.info('clipboard', 'Clipboard manager cleaned up')
  }
  
  // Helper method to generate AI metadata
  async generateAIMetadata(itemId, apiKey, customPrompt) {
    try {
      
      // Get the full item with content loaded
      let item = this.storage.loadItem(itemId);
      if (!item) {
        return { success: false, error: 'Item not found' };
      }
      
      log.info('clipboard', 'Processing item', { detail: {
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
      } })
      
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
        
        log.info('clipboard', 'Processing as image/visual content')
        
        // For images, we need the actual image data
        if (item.thumbnail && !item.thumbnail.includes('svg+xml')) {
          imageData = item.thumbnail;
          contentType = 'image';
          content = `Filename: ${item.fileName || 'Screenshot'}`;
          log.info('clipboard', 'Using thumbnail as image data')
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
              log.info('clipboard', 'Loaded image from file path')
            } catch (e) {
      log.error('clipboard', 'Error loading image file', { error: e.message || e })
              // Fall back to text analysis of filename
              content = item.fileName || item.preview || 'Image file';
              contentType = 'file';
            }
          }
        }
      }
      // Check if this is a PDF that needs special handling
      else if (documentExtensions.includes(fileExt)) {
        log.info('clipboard', 'Processing as document file')
        
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
        log.info('clipboard', 'Processing as HTML/generated document')
        
        // Use the actual HTML content if available
        content = item.html || item.content || item.preview || 'No content available';
        contentType = 'html';
        
        // If it's a generated document, add context
        if (item.metadata?.type === 'generated-document') {
          const templateName = item.metadata?.templateName || 'Unknown';
          const generatedAt = item.metadata?.generatedAt ? new Date(item.metadata.generatedAt).toLocaleDateString() : 'Unknown date';
          content = `Generated Document (${templateName}) created on ${generatedAt}:\n\n${content}`;
        }
        
        log.info('clipboard', 'Using HTML content, length', { contentCount: content.length })
      }
      // Check if this is code
      else if (codeExtensions.includes(fileExt)) {
        log.info('clipboard', 'Processing as code file')
        
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
        log.info('clipboard', 'Processing as data file')
        
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
        log.info('clipboard', 'Processing as text content')
        
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
        log.info('clipboard', 'Processing as audio file')
        
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
        log.info('clipboard', 'Processing as video file')
        
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
        log.info('clipboard', 'Processing as archive file')
        
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
        log.info('clipboard', 'Processing as generic file')
        
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
        log.info('clipboard', 'Using default text analysis')
        content = item.content || item.text || item.preview || item.fileName || 'No content available';
        contentType = 'text';
      }
      
      // Ensure content is not empty
      if (!content && !imageData) {
        log.info('clipboard', 'No content available, using fallback')
        content = item.preview || item.fileName || 'No content available';
      }
      
      log.info('clipboard', 'Final analysis type', { contentType, arg2: 'Has image data:', arg3: !!imageData })
      
      // Generate metadata using centralized AI service
      let generatedMetadata;
      
      if (imageData) {
        // Use vision API for image analysis
        const visionPrompt = customPrompt || `Analyze this ${contentType} and generate comprehensive metadata including:
- title: A clear, descriptive title
- description: A detailed description of the content
- tags: Array of relevant tags
- category: The primary category
- keywords: Array of important keywords
- summary: A brief summary

Return the metadata as a JSON object.`;
        
        const result = await ai.vision(imageData, visionPrompt, {
          profile: 'standard',
          maxTokens: 2000,
          feature: 'clipboard-manager',
        });
        
        // Parse JSON from response
        const jsonMatch = result.content.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          generatedMetadata = JSON.parse(jsonMatch[0]);
        } else {
          // Fallback: create basic metadata from response
          generatedMetadata = {
            description: result.content,
            title: item.fileName || 'Untitled',
          };
        }
      } else {
        // Use chat API for text analysis
        const chatPrompt = customPrompt || `Analyze this ${contentType} and generate comprehensive metadata including:
- title: A clear, descriptive title
- description: A detailed description of the content
- tags: Array of relevant tags
- category: The primary category
- keywords: Array of important keywords
- summary: A brief summary

Content to analyze:
${content}

Return the metadata as a JSON object.`;
        
        const result = await ai.chat({
          profile: 'standard',
          messages: [{ role: 'user', content: chatPrompt }],
          maxTokens: 2000,
          feature: 'clipboard-manager',
        });
        
        // Parse JSON from response
        const jsonMatch = result.content.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          generatedMetadata = JSON.parse(jsonMatch[0]);
        } else {
          // Fallback: create basic metadata from response
          generatedMetadata = {
            description: result.content,
            title: item.fileName || 'Untitled',
          };
        }
      }
      
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
      
      log.info('clipboard', 'Generated metadata for', { contentType, arg2: 'with vision:', arg3: !!imageData })
      
      // Update the item's metadata
      const updateResult = await this.updateItemMetadata(itemId, updatedMetadata);
      
      return updateResult;
    } catch (error) {
      log.error('clipboard', 'Error generating AI metadata', { error: error.message || error })
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
          log.info('clipboard', 'Migration needed, running migration...')
          
          // Run migration (script may not exist if migration was already baked in)
          let StorageMigration;
          try {
            StorageMigration = require('./migrate-to-v2-storage');
          } catch (e) {
            log.warn('clipboard', 'Migration script not found, marking as migrated', { error: e.message });
            status.migrated = true;
            status.migratedAt = new Date().toISOString();
            fs.writeFileSync(statusPath, JSON.stringify(status, null, 2));
            return;
          }
          const migration = new StorageMigration();
          const result = migration.migrate();
          
          if (result.success) {
            // Update status
            status.migrated = true;
            status.migratedAt = new Date().toISOString();
            status.itemsMigrated = result.itemsMigrated;
            fs.writeFileSync(statusPath, JSON.stringify(status, null, 2));
            
            log.info('clipboard', 'Migration complete! Migrated ... items', { itemsMigrated: result.itemsMigrated })
          } else {
            log.error('clipboard', 'Migration failed', { error: result.error })
          }
        } else {
          log.info('clipboard', 'Already migrated')
        }
      }
    } catch (error) {
      log.error('clipboard', 'Error checking migration status', { error: error.message || error })
    }
  }
  
  /**
   * Migrate existing web monitor items to fix missing index fields
   * This runs on startup to repair items created before the fix
   */
  migrateWebMonitorItems() {
    try {
      log.info('clipboard', 'Checking for items needing migration...')
      
      const indexItems = this.storage.index.items || [];
      let migratedCount = 0;
      
      // Find items in web-monitors space that need migration
      for (const item of indexItems) {
        // Check if it's in web-monitors space but missing type or web-monitor fields
        if (item.spaceId === 'web-monitors' && item.type !== 'web-monitor') {
          log.info('clipboard', 'Fixing item ... - setting type to web-monitor', { itemId: item.id })
          
          // Try to load the full item to get monitor data
          try {
            const fullItem = this.storage.loadItem(item.id);
            let monitorData = {};
            
            // Parse content if it's JSON
            if (fullItem.content) {
              try {
                monitorData = JSON.parse(fullItem.content);
              } catch (e) {
                // Not JSON, might be a URL
                if (typeof fullItem.content === 'string' && fullItem.content.startsWith('http')) {
                  monitorData.url = fullItem.content;
                  try {
                    monitorData.name = new URL(fullItem.content).hostname;
                  } catch (e2) {
                    monitorData.name = 'Website';
                  }
                }
              }
            }
            
            // Also check metadata
            if (fullItem.metadata) {
              monitorData = { ...monitorData, ...fullItem.metadata };
            }
            
            // Update the index entry with web-monitor fields
            item.type = 'web-monitor';
            item.url = monitorData.url || item.url || '';
            item.name = monitorData.name || item.name || 'Website';
            item.monitorId = monitorData.monitorId || item.id.replace('monitor-', '');
            item.lastChecked = monitorData.lastChecked || null;
            item.status = monitorData.status || 'active';
            item.changeCount = monitorData.changeCount || 0;
            item.timeline = monitorData.timeline || [];
            item.settings = monitorData.settings || { aiDescriptions: false };
            
            migratedCount++;
            log.info('clipboard', 'Fixed item ...', { itemId: item.id })
          } catch (loadError) {
            log.error('clipboard', 'Failed to load item ...', { itemId: item.id })
          }
        }
        
        // Also check items that have type=web-monitor but missing fields
        if (item.type === 'web-monitor' && (!item.url || !item.monitorId)) {
          log.info('clipboard', 'Fixing incomplete web-monitor item ...', { itemId: item.id })
          
          try {
            const fullItem = this.storage.loadItem(item.id);
            let monitorData = {};
            
            if (fullItem.content) {
              try {
                monitorData = JSON.parse(fullItem.content);
              } catch (e) {}
            }
            if (fullItem.metadata) {
              monitorData = { ...monitorData, ...fullItem.metadata };
            }
            
            // Fill in missing fields
            if (!item.url) item.url = monitorData.url || '';
            if (!item.name) item.name = monitorData.name || 'Website';
            if (!item.monitorId) item.monitorId = monitorData.monitorId || item.id.replace('monitor-', '');
            if (item.lastChecked === undefined) item.lastChecked = monitorData.lastChecked || null;
            if (!item.status) item.status = monitorData.status || 'active';
            if (item.changeCount === undefined) item.changeCount = monitorData.changeCount || 0;
            if (!item.timeline) item.timeline = monitorData.timeline || [];
            if (!item.settings) item.settings = monitorData.settings || { aiDescriptions: false };
            
            migratedCount++;
          } catch (loadError) {
            log.error('clipboard', 'Failed to fix item ...', { itemId: item.id })
          }
        }
      }
      
      if (migratedCount > 0) {
        // Save the updated index
        this.storage.saveIndex();
        log.info('clipboard', 'Migrated ... items, index saved', { migratedCount })
      } else {
        log.info('clipboard', 'No items needed migration')
      }
    } catch (error) {
      log.error('clipboard', 'Error', { error: error.message || error })
    }
  }
  
  // Generate real PDF thumbnail using qlmanage (like Finder)
  async generateRealPDFThumbnail(filePath, item) {
    // Windows compatibility: Return placeholder for now
    if (process.platform !== 'darwin') {
      log.info('clipboard', 'Non-macOS platform detected, using placeholder')
      const fileName = path.basename(filePath);
      const fileSize = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
      return this.generatePDFThumbnail(fileName, fileSize);
    }
    
    const { exec } = require('child_process');
    const { promisify } = require('util');
    const execAsync = promisify(exec);
    
    log.info('clipboard', 'Starting real thumbnail generation for', { filePath })
    
    // Add a small delay to ensure file is fully written
    await new Promise(resolve => setTimeout(resolve, 500));
    
    try {
      // Verify file exists and has content
      const stats = fs.statSync(filePath);
      log.info('clipboard', 'PDF file size', { arg1: stats.size, arg2: 'bytes' })
      
      // Create temp directory
      let tempDir = path.join(app.getPath('temp'), 'pdf-thumbnails-v2', Date.now().toString());
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }
      log.info('clipboard', 'Temp directory', { tempDir })
      
      // Try qlmanage first
      try {
        const command = `/usr/bin/qlmanage -t -s 512 -o "${tempDir}" "${filePath}" 2>&1`;
        log.info('clipboard', 'Running command', { command })
        
        const { stdout, stderr } = await execAsync(command, {
          timeout: 15000,
          maxBuffer: 1024 * 1024 * 10,
          env: { ...process.env, PATH: '/usr/bin:/bin:/usr/sbin:/sbin:' + process.env.PATH }
        });
        
        if (stdout) log.info('clipboard', 'qlmanage stdout', { stdout })
        if (stderr) log.info('clipboard', 'qlmanage stderr', { stderr })
        
        // Wait a bit for qlmanage to finish writing
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        // List all files in temp directory to see what was generated
        const generatedFiles = fs.readdirSync(tempDir);
        log.info('clipboard', 'Generated files', { generatedFiles })
        
        // Find the thumbnail - qlmanage adds a suffix
        let thumbnailPath = null;
        for (const file of generatedFiles) {
          if (file.endsWith('.png')) {
            thumbnailPath = path.join(tempDir, file);
            const thumbStats = fs.statSync(thumbnailPath);
            log.info('clipboard', 'Found thumbnail', { file, arg2: 'size:', size: thumbStats.size, arg4: 'bytes' })
            
            // Check if thumbnail has reasonable size (not just placeholder)
            if (thumbStats.size > 5000) { // More than 5KB suggests real thumbnail
              break;
            } else {
              log.info('clipboard', 'Thumbnail too small, might be placeholder')
              thumbnailPath = null;
            }
          }
        }
        
        if (thumbnailPath && fs.existsSync(thumbnailPath)) { info: log.info('clipboard', 'Reading thumbnail from', { thumbnailPath })
          const thumbnailBuffer = fs.readFileSync(thumbnailPath);
          const base64 = thumbnailBuffer.toString('base64');
          const dataUrl = `data:image/png;base64,${base64}`;
          
          log.info('clipboard', 'Thumbnail data URL length', { dataUrlCount: dataUrl.length })
          
          // Update the item thumbnail immediately
          item.thumbnail = dataUrl;
          
          // CRITICAL: Save the real PNG thumbnail to storage (replacing placeholder SVG)
          try {
            const itemDir = path.join(this.storage.storageRoot, 'items', item.id);
            const pngThumbnailPath = path.join(itemDir, 'thumbnail.png');
            const svgThumbnailPath = path.join(itemDir, 'thumbnail.svg');
            
            // Save the PNG thumbnail
            fs.writeFileSync(pngThumbnailPath, thumbnailBuffer);
            log.info('clipboard', 'Saved real thumbnail to', { pngThumbnailPath })
            
            // Remove the placeholder SVG if it exists
            if (fs.existsSync(svgThumbnailPath)) {
              fs.unlinkSync(svgThumbnailPath);
              log.info('clipboard', 'Removed placeholder SVG')
            }
            
            // Update the storage index to point to the PNG
            const storageItem = this.storage.index?.items?.find(i => i.id === item.id);
            if (storageItem) {
              storageItem.thumbnailPath = `items/${item.id}/thumbnail.png`;
              this.storage.saveIndexSync();
              log.info('clipboard', 'Updated index with PNG thumbnail path')
            }
          } catch (saveErr) {
      log.error('clipboard', 'Error saving thumbnail to storage', { error: saveErr.message })
          }
          
          // Find item in history and update thumbnail immediately
          const historyItem = this.history.find(h => h.id === item.id);
          if (historyItem) {
            historyItem.thumbnail = dataUrl;
            // Set default page count first
            historyItem.pageCount = 1;
            this.notifyHistoryUpdate();
            log.info('clipboard', 'Updated item with real thumbnail immediately')
          }
          
          // Get page count asynchronously (don't block thumbnail display)
          this.getPDFPageCount(filePath).then(pageCount => { info: log.info('clipboard', 'Async page count result', { pageCount })
            item.pageCount = pageCount;
            
            // Update history item with correct page count
            const historyItem = this.history.find(h => h.id === item.id);
            if (historyItem && historyItem.pageCount !== pageCount) {
              historyItem.pageCount = pageCount;
              this.notifyHistoryUpdate();
              log.info('clipboard', 'Updated page count to', { pageCount })
            }
          }).catch(err => {
            log.error('clipboard', 'Error getting page count', { error: err.message || err })
          });
          
          // Clean up temp directory
          try {
            fs.rmSync(tempDir, { recursive: true, force: true });
          } catch (e) {
            log.error('clipboard', 'Error cleaning up temp dir', { error: e.message || e })
          }
          
          return dataUrl;
        } else {
          log.info('clipboard', 'No valid thumbnail found')
        }
      } catch (qlError) {
      log.error('clipboard', 'qlmanage error', { error: qlError.message })
        log.error('clipboard', 'Full error', { qlError })
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
      log.error('clipboard', 'Error generating real thumbnail', { error: error.message || error })
    }
    
    log.info('clipboard', 'Using placeholder thumbnail')
  }
  
  // Get PDF page count with multiple fallback methods
  async getPDFPageCount(filePath) {
    // Windows/Linux compatibility: Return default page count
    if (process.platform !== 'darwin') {
      log.info('clipboard', 'Non-macOS platform detected, returning default page count')
      return 1;
    }
    
    const { exec } = require('child_process');
    const { promisify } = require('util');
    const execAsync = promisify(exec);
    
    // First attempt: Try using file command to get PDF info (fastest)
    try {
      const fileCommand = `/usr/bin/file -b "${filePath}"`;
      const { stdout } = await execAsync(fileCommand, { timeout: 2000 });
      log.info('clipboard', 'file command output', { stdout })
      
      // Some PDFs might have page info in file output
      const pageMatch = stdout.match(/(\d+)\s*pages?/i);
      if (pageMatch) {
        const pageCount = parseInt(pageMatch[1]);
        if (!isNaN(pageCount) && pageCount > 0) {
          log.info('clipboard', 'Page count from file command', { pageCount })
          return pageCount;
        }
      }
    } catch (error) {
      log.error('clipboard', 'Error getting page count with file command', { error: error.message })
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
            log.info('clipboard', 'Page count from PDF structure', { pageCount })
            return pageCount;
          }
        }
      }
    } catch (error) {
      log.error('clipboard', 'Error parsing PDF structure', { error: error.message })
    }
    
    // Third attempt: Use mdls (only if file has been indexed)
    try {
      const command = `/usr/bin/mdls -name kMDItemNumberOfPages -raw "${filePath}"`;
      const { stdout } = await execAsync(command, { timeout: 2000 });
      
      // Clean up the output (remove % sign and whitespace)
      const cleanOutput = stdout.trim().replace('%', '');
      const pageCount = parseInt(cleanOutput);
      
      if (!isNaN(pageCount) && pageCount > 0) {
        log.info('clipboard', 'Page count from mdls', { pageCount })
        return pageCount;
      }
    } catch (error) {
      log.error('clipboard', 'Error getting page count with mdls', { error: error.message })
    }
    
    log.info('clipboard', 'Could not determine page count, defaulting to 1')
    return 1; // Default to 1 page if we can't determine
  }
  
  // Generate PDF thumbnail for specific page
  async generatePDFPageThumbnail(filePath, pageNumber = 1) { detail: // This method handles page-specific thumbnail requests
    log.info('clipboard', 'Generating thumbnail for page', { pageNumber })
    
    // Try to find the item by file path
    const item = this.history.find(h => h.filePath === filePath);
    if (item && item.thumbnail && !item.thumbnail.includes('svg+xml')) {
      log.info('clipboard', 'Returning existing thumbnail from history')
      return item.thumbnail;
    }
    
    // Windows/Linux compatibility: Return placeholder
    if (process.platform !== 'darwin') {
      log.info('clipboard', 'Non-macOS platform detected, using placeholder')
      return this.generatePDFThumbnail(path.basename(filePath), 0);
    }
    
    const { exec } = require('child_process');
    const { promisify } = require('util');
    const execAsync = promisify(exec);
    
    // Since macOS tools can only generate page 1 thumbnails,
    // we'll return the existing thumbnail from the history item
    // The UI will show an overlay for pages other than 1
    
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
      log.info('clipboard', 'Using qlmanage to extract thumbnail')
      
      try {
        const { stdout, stderr } = await execAsync(command, {
          timeout: 15000,
          maxBuffer: 1024 * 1024 * 10
        });
        
        if (stdout) log.info('clipboard', 'qlmanage stdout', { stdout })
        if (stderr) log.info('clipboard', 'qlmanage stderr', { stderr })
        
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
          
          log.info('clipboard', 'Generated thumbnail for page 1 (all pages show page 1 preview)')
          
          // Clean up
          try { rmSync: fs.rmSync(tempDir, { recursive: true, force: true });
          } catch (e) {
            // Ignore
          }
          
          return dataUrl;
        }
      } catch (error) {
        log.error('clipboard', 'qlmanage error', { error: error.message })
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
      log.error('clipboard', 'Error generating page thumbnail', { error: error.message || error })
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
      log.error('clipboard', 'Error generating PDF thumbnail', { error: error.message || error })
      
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
      log.error('clipboard', 'Error generating HTML thumbnail', { error: error.message || error })
      
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
      log.error('clipboard', 'Error generating notebook thumbnail', { error: error.message || error })
      
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
    log.info('clipboard', 'Starting text preview generation for', { filePath })
    
    // Windows/Linux compatibility: Use custom preview directly
    if (process.platform !== 'darwin') {
      log.info('clipboard', 'Non-macOS platform detected, using custom preview')
      return this.createCustomTextPreview(filePath, item);
    }
    
    const { exec } = require('child_process');
    const { promisify } = require('util');
    const execAsync = promisify(exec);
    
    try {
      // For text files, we'll use qlmanage to generate a preview
      let tempDir = path.join(app.getPath('temp'), 'text-previews-v2', Date.now().toString());
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }
      
      // Use qlmanage to generate preview
      const command = `/usr/bin/qlmanage -t -s 512 -o "${tempDir}" "${filePath}" 2>&1`;
      log.info('clipboard', 'Running command', { command })
      
      const { stdout, stderr } = await execAsync(command, { 
        timeout: 10000,
        env: { ...process.env, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }
      });
      
      log.info('clipboard', 'qlmanage stdout', { stdout })
      if (stderr) log.info('clipboard', 'qlmanage stderr', { stderr })
      
      // Check if thumbnail was generated
      const files = fs.readdirSync(tempDir);
      log.info('clipboard', 'Generated files', { files })
      
      const thumbnailFile = files.find(f => f.endsWith('.png'));
      if (thumbnailFile) {
        const thumbnailPath = path.join(tempDir, thumbnailFile);
        log.info('clipboard', 'Found thumbnail', { thumbnailFile, arg2: 'size:', arg3: fs.statSync(thumbnailPath).size, arg4: 'bytes' })
        
        // Read the thumbnail
        const thumbnailBuffer = fs.readFileSync(thumbnailPath);
        const base64 = thumbnailBuffer.toString('base64');
        const dataUrl = `data:image/png;base64,${base64}`;
        
        // Clean up temp files
        try {
          fs.unlinkSync(thumbnailPath);
          fs.rmdirSync(tempDir, { recursive: true });
        } catch (e) {
          log.error('clipboard', 'Error cleaning up temp files', { error: e.message })
        }
        
        return dataUrl;
      } else {
        // If qlmanage didn't generate a preview, create a custom preview
        log.info('clipboard', 'No thumbnail generated by qlmanage, creating custom preview')
        return this.createCustomTextPreview(filePath, item);
      }
    } catch (error) {
      log.error('clipboard', 'Error generating text preview', { error: error.message })
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
      log.error('clipboard', 'Error creating custom text preview', { error: error.message || error })
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
      log.info('clipboard', 'Global shortcuts not available in non-Electron environment')
      return;
    }
    
    // Register global shortcut for clipboard viewer
    const shortcut = process.platform === 'darwin' ? 'Cmd+Shift+V' : 'Ctrl+Shift+V';
    
    globalShortcut.register(shortcut, () => { createClipboardWindow: log.info('clipboard', 'Clipboard viewer shortcut triggered')
      this.createClipboardWindow(); });
    
    log.info('clipboard', 'Registered global shortcut: ...', { shortcut })
  }
  
  // ========================================
  // WEB MONITORS FEATURE
  // ========================================
  
  /**
   * Extract URL from text content
   * Returns the first valid URL found or null
   */
  extractURL(content) {
    if (!content || typeof content !== 'string') return null;
    
    // Match http/https URLs
    const urlRegex = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/gi;
    const matches = content.match(urlRegex);
    
    if (!matches || matches.length === 0) return null;
    
    // Clean up the URL (remove trailing punctuation)
    let url = matches[0];
    url = url.replace(/[.,;:!?)]+$/, '');
    
    // Validate URL
    try {
      new URL(url);
      return url;
    } catch (e) {
      return null;
    }
  }
  
  /**
   * Find existing monitor by URL
   */
  findMonitorByURL(url) {
    if (!this.websiteMonitor || !this.websiteMonitor.monitors) return null;
    
    for (const [id, monitor] of this.websiteMonitor.monitors) {
      if (monitor.url === url) {
        return monitor;
      }
    }
    return null;
  }
  
  /**
   * Create a website monitor from a URL
   * This is called when a URL is pasted into the Web Monitors space
   */
  async createWebsiteMonitorFromURL(url) {
    const WebsiteMonitor = require('./website-monitor');
    const { BrowserWindow } = require('electron');
    
    log.info('clipboard', 'createWebsiteMonitorFromURL called with', { url })
    
    // Initialize website monitor if needed
    if (!this.websiteMonitor) {
      log.info('clipboard', 'Initializing WebsiteMonitor...')
      try {
        this.websiteMonitor = new WebsiteMonitor();
        await this.websiteMonitor.initialize();
        log.info('clipboard', 'WebsiteMonitor initialized successfully')
      } catch (initError) {
      log.error('clipboard', 'Failed to initialize WebsiteMonitor', { initError })
        throw new Error(`Website Monitor initialization failed: ${initError.message}`);
      }
    }
    
    // Check for duplicate
    const existingMonitor = this.findMonitorByURL(url);
    if (existingMonitor) {
      log.info('clipboard', 'URL already being monitored', { url })
      
      // Check if a clipboard item exists for this monitor
      // Check both history cache AND storage index (source of truth)
      const existingItemInHistory = this.history.find(h => 
        h.type === 'web-monitor' && h.url === url
      );
      const existingItemInStorage = this.storage.index.items.find(i => 
        i.type === 'web-monitor' && i.spaceId === 'web-monitors'
      );
      
      if (existingItemInHistory || existingItemInStorage) {
        // Show notification
        BrowserWindow.getAllWindows().forEach(window => {
          window.webContents.send('show-notification', {
            title: 'Already Monitoring',
            body: `${new URL(url).hostname} is already being monitored`,
            type: 'warning'
          });
        });
        return existingItemInHistory || existingItemInStorage;
      }
      
      // Monitor exists in WebsiteMonitor but no clipboard item - create one
      log.info('clipboard', 'Monitor exists but no clipboard item, creating item...')
      // Use the existing monitor data, don't call addMonitor again
      var monitor = existingMonitor;
    } else { info: log.info('clipboard', 'Creating new monitor for', { url })
      
      // Create the monitor
      var monitor = await this.websiteMonitor.addMonitor({
        url: url,
        name: new URL(url).hostname,
        spaceId: 'web-monitors',
        selector: 'body', // Default to full page, user can change later
        includeScreenshot: true
      });
    }
    
    // Create a web-monitor item in the space
    const monitorData = {
      monitorId: monitor.id,
      url: url,
      name: monitor.name,
      selector: monitor.selector || 'body',
      selectorDescription: 'Full Page',
      lastChecked: monitor.lastChecked,
      status: 'active',
      settings: {
        aiDescriptions: false // Default OFF to save costs
      },
      checkCount: 0,
      changeCount: 0,
      timeline: []
    };
    
    const monitorItem = {
      id: `monitor-${monitor.id}`,
      type: 'web-monitor',
      url: url,
      name: monitor.name,
      spaceId: 'web-monitors',
      timestamp: Date.now(),
      preview: `Monitoring: ${monitor.name}`,
      // Content is required for storage - store the monitor data as JSON
      content: JSON.stringify(monitorData, null, 2),
      
      // Monitor-specific fields (also stored in metadata)
      monitorId: monitor.id,
      selector: monitor.selector || 'body',
      selectorDescription: 'Full Page',
      currentScreenshotPath: null, // Will be set after first check
      lastChecked: monitor.lastChecked,
      nextCheck: null,
      status: 'active',
      errorMessage: null,
      
      // Settings
      settings: {
        aiDescriptions: false // Default OFF to save costs
      },
      
      // Stats
      checkCount: 0,
      changeCount: 0,
      ignoredChangeCount: 0,
      pauseReason: null,
      
      // Badge tracking
      unviewedChanges: 0,
      lastViewedAt: new Date().toISOString(),
      
      // Cost tracking
      costTracking: {
        monthlyTokensUsed: 0,
        monthlyCost: 0,
        currentMonth: new Date().toISOString().slice(0, 7)
      },
      
      // Timeline (changes history)
      timeline: []
    };
    
    // Add to storage
    const indexEntry = this.storage.addItem(monitorItem);
    
    // Add to in-memory history
    this.history.unshift({
      ...monitorItem,
      id: indexEntry.id
    });
    
    // Update space count
    this.updateSpaceCounts();
    
    // Notify UI
    this.notifyHistoryUpdate();
    
    // Show success notification
    BrowserWindow.getAllWindows().forEach(window => {
      window.webContents.send('show-notification', {
        title: 'Website Monitor Created',
        body: `Now monitoring ${monitor.name}. Capturing initial baseline...`,
        type: 'success'
      });
    });
    
    log.info('clipboard', 'Monitor created successfully', { monitorItemId: monitorItem.id })
    
    // Perform initial check to capture baseline
    try {
      log.info('clipboard', 'Capturing initial baseline...')
      const initialResult = await this.websiteMonitor.checkWebsite(monitor.id);
      
      if (initialResult && initialResult.snapshot) {
        // Create baseline entry for timeline
        const baselineEntry = {
          id: `baseline-${Date.now()}`,
          timestamp: new Date().toISOString(),
          type: 'baseline',
          summary: 'Initial baseline captured',
          screenshotPath: initialResult.snapshot.screenshot || null,
          textLength: initialResult.snapshot.textContent?.length || 0
        };
        
        // Update the monitor item with baseline
        const historyItem = this.history.find(h => h.id === monitorItem.id || h.id === indexEntry.id);
        if (historyItem) {
          historyItem.timeline = [baselineEntry];
          historyItem.lastChecked = new Date().toISOString();
          historyItem.changeCount = 0;
          
          // Also update in storage
          await this.updateItemMetadata(historyItem.id, {
            timeline: [baselineEntry],
            lastChecked: historyItem.lastChecked,
            changeCount: 0
          });
        }
        
        log.info('clipboard', 'Initial baseline captured successfully')
        
        // Notify UI of update
        this.notifyHistoryUpdate();
      }
    } catch (baselineError) {
      log.error('clipboard', 'Failed to capture initial baseline', { error: baselineError.message })
      // Not critical - monitor will work, just no baseline in timeline
    }
    
    return monitorItem;
  }
  
  // ========================================
  // END WEB MONITORS FEATURE
  // ========================================
  
  startWebsiteMonitoring() {
    // Check websites every 30 minutes
    this.websiteCheckInterval = setInterval(async () => {
      try {
        // Skip if no monitors configured (optimization to avoid unnecessary work)
        if (!this.websiteMonitor) {
          const WebsiteMonitor = require('./website-monitor');
          this.websiteMonitor = new WebsiteMonitor();
          await this.websiteMonitor.initialize();
        }
        
        // Check if there are any active monitors
        const monitorCount = this.websiteMonitor.monitors?.size || 0;
        if (monitorCount === 0) {
          log.info('clipboard', 'No monitors configured, skipping check')
          return;
        }
        
        log.info('clipboard', 'Running periodic check for ... monitors...', { monitorCount })
        const results = await this.websiteMonitor.checkAllMonitors();
        
        // Process results and update monitor items
        for (const result of results) {
          if (result.changed && result.monitor) {
            await this.handleWebsiteChange(result);
          }
        }
        
        const changedCount = results.filter(r => r.changed).length;
        log.info('clipboard', 'Check complete. .../... sites changed.', { changedCount, monitorCount })
      } catch (error) {
        log.error('clipboard', 'Error in periodic check', { error: error.message || error })
      }
    }, 30 * 60 * 1000); // 30 minutes
  }
  
  /**
   * Handle a website change detected by the monitor
   * Updates the monitor item's timeline and optionally generates AI description
   */
  async handleWebsiteChange(result) {
    const { monitor, snapshot, previousSnapshot } = result;
    const { BrowserWindow, Notification } = require('electron');
    
    log.info('clipboard', 'Change detected for ...', { monitorName: monitor.name })
    
    // Find the monitor item in history
    const monitorItem = this.history.find(h => 
      h.type === 'web-monitor' && h.monitorId === monitor.id
    );
    
    if (!monitorItem) {
      log.warn('clipboard', 'Monitor item not found in history', { monitorId: monitor.id })
      return;
    }
    
    // ========================================
    // AUTO-PAUSE: Check for high-frequency changes
    // ========================================
    const oneDayAgo = Date.now() - (24 * 60 * 60 * 1000);
    const recentChanges = (monitorItem.timeline || []).filter(c => 
      new Date(c.timestamp).getTime() > oneDayAgo
    );
    
    if (recentChanges.length >= 5) {
      // Auto-pause this monitor - too dynamic
      log.info('clipboard', 'Auto-pausing ...: ... changes in 24h', { monitorName: monitor.name, recentChangesCount: recentChanges.length })
      
      monitorItem.status = 'paused';
      monitorItem.pauseReason = 'high_frequency';
      
      // Also pause in the WebsiteMonitor
      if (this.websiteMonitor) {
        await this.websiteMonitor.pauseMonitor(monitor.id);
      }
      
      // Update storage
      try {
        await this.updateItemMetadata(monitorItem.id, {
          status: 'paused',
          pauseReason: 'high_frequency'
        });
      } catch (e) {
        log.error('clipboard', 'Failed to update pause status', { error: e.message || e })
      }
      
      // Send notification about auto-pause
      if (Notification.isSupported()) {
        new Notification({
          title: 'Monitor Paused: Too Many Changes',
          body: `${monitor.name} changed ${recentChanges.length}+ times in 24h. This site may be too dynamic.`,
          silent: false
        }).show();
      }
      
      // Notify UI
      this.notifyHistoryUpdate();
      return; // Don't record this change
    }
    // ========================================
    // END AUTO-PAUSE
    // ========================================
    
    // Create change entry for timeline
    const changeId = `change-${Date.now()}`;
    const changeEntry = {
      id: changeId,
      timestamp: new Date().toISOString(),
      beforeScreenshotPath: previousSnapshot?.screenshot || null,
      afterScreenshotPath: snapshot?.screenshot || null,
      diffScreenshotPath: null, // TODO: Generate diff image
      aiSummary: 'Content updated', // Default summary (no AI)
      diffPercentage: 0, // TODO: Calculate
      contentDiff: {
        added: 0,
        removed: 0,
        modified: 0
      }
    };
    
    // Add to timeline (newest first, max 50)
    monitorItem.timeline = monitorItem.timeline || [];
    monitorItem.timeline.unshift(changeEntry);
    if (monitorItem.timeline.length > 50) {
      monitorItem.timeline = monitorItem.timeline.slice(0, 50);
    }
    
    // Update stats
    monitorItem.changeCount = (monitorItem.changeCount || 0) + 1;
    monitorItem.lastChecked = new Date().toISOString();
    monitorItem.unviewedChanges = (monitorItem.unviewedChanges || 0) + 1;
    monitorItem.currentScreenshotPath = snapshot?.screenshot || null;
    
    // Update in storage
    try {
      await this.updateItemMetadata(monitorItem.id, {
        timeline: monitorItem.timeline,
        changeCount: monitorItem.changeCount,
        lastChecked: monitorItem.lastChecked,
        unviewedChanges: monitorItem.unviewedChanges,
        currentScreenshotPath: monitorItem.currentScreenshotPath
      });
    } catch (e) {
      log.error('clipboard', 'Failed to update storage', { error: e.message || e })
    }
    
    // Update space badge count
    this.updateWebMonitorsBadge();
    
    // Send system notification
    if (Notification.isSupported()) {
      new Notification({
        title: `Website Changed: ${monitor.name}`,
        body: changeEntry.aiSummary,
        silent: false
      }).show();
    }
    
    // Notify UI
    this.notifyHistoryUpdate();
  }
  
  /**
   * Update the unviewedChanges count for the Web Monitors space badge
   */
  updateWebMonitorsBadge() {
    const webMonitorsSpace = this.storage.index?.spaces?.find(s => s.id === 'web-monitors');
    if (!webMonitorsSpace) return;
    
    // Count total unviewed changes across all monitors
    const totalUnviewed = this.history
      .filter(h => h.type === 'web-monitor')
      .reduce((sum, m) => sum + (m.unviewedChanges || 0), 0);
    
    webMonitorsSpace.unviewedChanges = totalUnviewed;
  }
}

module.exports = ClipboardManagerV2; 