const path = require('path');
const fs = require('fs');
const os = require('os');
const ClipboardStorageV2 = require('./clipboard-storage-v2');
const AppContextCapture = require('./app-context-capture');

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
    
    // Load data from storage
    this.history = [];
    this.spaces = [];
    this.loadFromStorage();
    
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
    
    // Load preferences
    this.loadPreferences();
    
    // Set up screenshot monitoring if enabled
    if (this.screenshotCaptureEnabled) {
      this.setupScreenshotWatcher();
    }
    
    // Set up website monitoring periodic checks
    this.startWebsiteMonitoring();
    
    // Set up IPC handlers
    this.setupIPC();
  }
  
  loadFromStorage() {
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
    console.log('[V2] Adding item to history:', item.type);
    
    // Capture app context if not already provided
    let context = item.context;
    if (!context && !item.source) {
      try {
        context = await this.contextCapture.getFullContext();
        console.log('[V2] Captured context:', context);
      } catch (error) {
        console.error('[V2] Error capturing context:', error);
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
  }
  
  getHistory() {
    // Load content on demand for items that need it
    return this.history.map(item => {
      if (item._needsContent) {
        try {
          const fullItem = this.storage.loadItem(item.id);
          item.content = fullItem.content;
          item.thumbnail = fullItem.thumbnail;
          item._needsContent = false;
          
          // For files, update the filePath to the stored location
          if (item.type === 'file' && fullItem.content) {
            item.filePath = fullItem.content; // Storage returns the actual file path
          }
        } catch (error) {
          console.error('Error loading item content:', error);
        }
      }
      return item;
    });
  }
  
  async deleteItem(id) {
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
    
    const success = this.storage.deleteItem(id);
    if (success) {
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
    const success = this.storage.moveItem(itemId, spaceId);
    
    if (success) {
      // Update in-memory history
      const item = this.history.find(h => h.id === itemId);
      if (item) {
        item.spaceId = spaceId;
      }
      
      this.updateSpaceCounts();
      this.notifyHistoryUpdate();
    }
    
    return { success };
  }
  
  // Space management
  
  getSpaces() {
    return this.spaces;
  }
  
  createSpace(space) {
    const newSpace = this.storage.createSpace(space);
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
      console.error('Error deleting space:', error);
      return { success: false };
    }
  }
  
  getSpaceItems(spaceId) {
    return this.history.filter(item => 
      spaceId === null ? true : item.spaceId === spaceId
    );
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
    return html.replace(/<[^>]*>/g, '');
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
  
  // Window management (same as original)
  
  createClipboardWindow() {
    if (this.clipboardWindow && !this.clipboardWindow.isDestroyed()) {
      this.clipboardWindow.focus();
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
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, 'preload.js')
      }
    });
    
    this.clipboardWindow.loadFile('clipboard-viewer.html');
    
    this.clipboardWindow.on('closed', () => {
      this.clipboardWindow = null;
    });
  }
  
  createBlackHoleWindow(position, startExpanded = false) {
    if (this.blackHoleWindow) {
      this.blackHoleWindow.focus();
      return;
    }
    
    const width = startExpanded ? 600 : 150;
    const height = startExpanded ? 800 : 150;
    
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
        preload: path.join(__dirname, 'preload.js')
      }
    };
    
    this.blackHoleWindow = new BrowserWindow(windowConfig);
    
    if (position && position.x !== undefined && position.y !== undefined) {
      this.blackHoleWindow.setBounds({
        x: position.x,
        y: position.y,
        width: width,
        height: height
      });
    }
    
    this.blackHoleWindow.loadFile('black-hole.html');
    
    this.blackHoleWindow.once('ready-to-show', () => {
      if (position && position.x !== undefined && position.y !== undefined) {
        this.blackHoleWindow.setPosition(position.x, position.y);
      }
      this.blackHoleWindow.show();
    });
    
    this.blackHoleWindow.on('closed', () => {
      this.blackHoleWindow = null;
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
      console.error('Error checking existing screenshots:', error);
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
        
        // Trigger AI metadata generation in the background
        setTimeout(async () => {
          try {
            const result = await this.generateAIMetadata(item.id, settings.llmApiKey, 'Analyze this screenshot and describe what you see in detail.');
            if (result.success) {
              console.log('AI metadata generated successfully for screenshot');
              
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
      console.error('Error handling screenshot:', error);
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
    if (!ipcMain) {
      console.log('IPC not available in non-Electron environment');
      return;
    }
    
    // Black hole window handlers
    ipcMain.on('black-hole:resize-window', (event, { width, height }) => {
      if (this.blackHoleWindow && !this.blackHoleWindow.isDestroyed()) {
        this.blackHoleWindow.setSize(width, height, true);
        
        // Center the window on screen when expanding
        if (width > 150 && screen) {
          const primaryDisplay = screen.getPrimaryDisplay();
          const { width: screenWidth, height: screenHeight } = primaryDisplay.workArea;
          const x = Math.round((screenWidth - width) / 2);
          const y = Math.round((screenHeight - height) / 2);
          this.blackHoleWindow.setPosition(x, y, true);
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
    ipcMain.handle('clipboard:get-history', () => {
      return this.getHistory();
    });
    
    ipcMain.handle('clipboard:clear-history', async () => {
      await this.clearHistory();
      return { success: true };
    });
    
    ipcMain.handle('clipboard:delete-item', async (event, id) => {
      await this.deleteItem(id);
      return { success: true };
    });
    
    ipcMain.handle('clipboard:toggle-pin', (event, id) => {
      return this.togglePin(id);
    });
    
    ipcMain.handle('clipboard:paste-item', (event, id) => {
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
      if (item.type === 'text' || item.type === 'html') {
        clipboard.writeText(item.content);
      } else if (item.type === 'image' && item.content) {
        const image = nativeImage.createFromDataURL(item.content);
        clipboard.writeImage(image);
      } else if (item.type === 'file' && item.filePath) {
        clipboard.writeBuffer('public.file-url', Buffer.from(item.filePath));
      }
      
      return { success: true };
    });
    
    ipcMain.handle('clipboard:search', (event, query) => {
      return this.searchHistory(query);
    });
    
    ipcMain.handle('clipboard:get-stats', () => {
      return {
        totalItems: this.history.length,
        pinnedItems: this.pinnedItems.size,
        typeBreakdown: this.getTypeBreakdown(),
        storageSize: 0 // Would need to calculate
      };
    });
    
    // Space management
    ipcMain.handle('clipboard:get-spaces', () => {
      return this.getSpaces();
    });
    
    ipcMain.handle('clipboard:create-space', (event, space) => {
      return this.createSpace(space);
    });
    
    ipcMain.handle('clipboard:update-space', (event, id, updates) => {
      return this.updateSpace(id, updates);
    });
    
    ipcMain.handle('clipboard:delete-space', (event, id) => {
      return this.deleteSpace(id);
    });
    
    ipcMain.handle('clipboard:set-current-space', (event, spaceId) => {
      this.setActiveSpace(spaceId);
      return { success: true };
    });
    
    ipcMain.handle('clipboard:move-to-space', (event, itemId, spaceId) => {
      return this.moveItemToSpace(itemId, spaceId);
    });
    
    ipcMain.handle('clipboard:get-space-items', (event, spaceId) => {
      return this.getSpaceItems(spaceId);
    });
    
    ipcMain.handle('clipboard:get-spaces-enabled', () => {
      return this.spacesEnabled;
    });
    
    ipcMain.handle('clipboard:toggle-spaces', (event, enabled) => {
      this.toggleSpaces(enabled);
      return { success: true };
    });
    
    ipcMain.handle('clipboard:get-active-space', () => {
      return {
        spaceId: this.currentSpace,
        spaceName: this.getSpaceName(this.currentSpace)
      };
    });
    
    // File system operations
    ipcMain.handle('clipboard:open-storage-directory', () => {
      const { shell } = require('electron');
      shell.openPath(this.storage.storageRoot);
      return { success: true };
    });
    
    ipcMain.handle('clipboard:open-space-directory', (event, spaceId) => {
      const { shell } = require('electron');
      const spaceDir = path.join(this.storage.spacesDir, spaceId);
      if (fs.existsSync(spaceDir)) {
        shell.openPath(spaceDir);
      }
      return { success: true };
    });
    
    // Metadata operations
    ipcMain.handle('clipboard:update-metadata', (event, itemId, updates) => {
      try {
        const item = this.storage.loadItem(itemId);
        if (!item) return { success: false };
        
        const metadataPath = path.join(this.storage.storageRoot, item.metadataPath);
        const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
        
        Object.assign(metadata, updates);
        fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
        
        return { success: true };
      } catch (error) {
        console.error('Error updating metadata:', error);
        return { success: false, error: error.message };
      }
    });
    
    ipcMain.handle('clipboard:get-metadata', (event, itemId) => {
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
          preview: item.preview
        };
        
        return { success: true, metadata };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });
    
    // Advanced search
    ipcMain.handle('clipboard:search-by-tags', (event, tags) => {
      const results = this.history.filter(item => {
        if (item._needsContent) {
          const fullItem = this.storage.loadItem(item.id);
          return fullItem.metadata?.tags?.some(tag => tags.includes(tag));
        }
        return false;
      });
      return results;
    });
    
    ipcMain.handle('clipboard:search-ai-content', (event, options = {}) => {
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
    ipcMain.handle('clipboard:diagnose', () => {
      return {
        historyCount: this.history.length,
        spacesCount: this.spaces.length,
        storageVersion: 'v2',
        indexPath: this.storage.indexPath,
        cacheSize: this.storage.cache.size
      };
    });
    
    ipcMain.handle('clipboard:force-resume', () => {
      // Not needed in V2
      return { success: true };
    });
    
    ipcMain.handle('clipboard:manual-check', () => {
      // Not needed in V2
      return { success: true };
    });
    
    ipcMain.handle('clipboard:show-item-in-finder', async (event, itemId) => {
      return this.showItemInFinder(itemId);
    });
    
    ipcMain.handle('clipboard:get-current-user', () => {
      return os.userInfo().username || 'Unknown';
    });
    
    // AI metadata generation
    ipcMain.handle('clipboard:generate-metadata-ai', async (event, { itemId, apiKey, customPrompt }) => {
      // Use the helper method that we just fixed
      const result = await this.generateAIMetadata(itemId, apiKey, customPrompt);
      
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
    ipcMain.handle('clipboard:capture-text', async (event, text) => {
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
    
    ipcMain.handle('clipboard:capture-html', async (event, html) => {
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
    
    // Get audio file as base64
    ipcMain.handle('clipboard:get-audio-data', (event, itemId) => {
      const item = this.history.find(h => h.id === itemId);
      if (!item || item.type !== 'file' || item.fileType !== 'audio') {
        return { success: false, error: 'Audio file not found' };
      }
      
      try {
        // Load full item if needed
        if (item._needsContent) {
          const fullItem = this.storage.loadItem(itemId);
          if (fullItem.filePath && fs.existsSync(fullItem.filePath)) {
            const audioData = fs.readFileSync(fullItem.filePath);
            const base64 = audioData.toString('base64');
            const mimeType = this.getAudioMimeType(item.fileExt);
            const dataUrl = `data:${mimeType};base64,${base64}`;
            return { success: true, dataUrl };
          }
        } else if (item.filePath && fs.existsSync(item.filePath)) {
          const audioData = fs.readFileSync(item.filePath);
          const base64 = audioData.toString('base64');
          const mimeType = this.getAudioMimeType(item.fileExt);
          const dataUrl = `data:${mimeType};base64,${base64}`;
          return { success: true, dataUrl };
        }
        
        return { success: false, error: 'Audio file no longer exists' };
      } catch (error) {
        console.error('Error reading audio file:', error);
        return { success: false, error: error.message };
      }
    });
    
    // Window operations
    ipcMain.handle('clipboard:open-black-hole', () => {
      this.createBlackHoleWindow();
      return { success: true };
    });
    
    ipcMain.handle('clipboard:open-space-notebook', (event, spaceId) => {
      const { shell } = require('electron');
      const notebookPath = path.join(this.storage.spacesDir, spaceId, 'README.ipynb');
      if (fs.existsSync(notebookPath)) {
        shell.openPath(notebookPath);
      }
      return { success: true };
    });
    
    // Screenshot capture
    ipcMain.handle('clipboard:get-screenshot-capture-enabled', () => {
      return this.screenshotCaptureEnabled;
    });
    
    ipcMain.handle('clipboard:toggle-screenshot-capture', (event, enabled) => {
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
    ipcMain.handle('clipboard:get-pdf-page-thumbnail', async (event, itemId, pageNumber) => {
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
    
    // Black hole handlers
    ipcMain.handle('black-hole:add-text', async (event, data) => {
      console.log('Black hole: Adding text to space:', data.spaceId);
      
      // Capture app context for the source of the paste
      let context = null;
      try {
        context = await this.contextCapture.getFullContext();
        console.log('[Black hole] Captured context:', context);
      } catch (error) {
        console.error('[Black hole] Error capturing context:', error);
      }
      
      // Enhance source detection with context
      const detectedSource = context 
        ? this.contextCapture.enhanceSourceDetection(data.content, context)
        : this.detectSource(data.content);
      
      const item = {
        type: 'text',
        content: data.content,
        preview: this.truncateText(data.content, 100),
        timestamp: Date.now(),
        pinned: false,
        spaceId: data.spaceId || this.currentSpace || 'unclassified',
        source: detectedSource
      };
      
      // Add context to metadata if available
      if (context) {
        item.metadata = {
          context: {
            app: context.app,
            window: context.window,
            contextDisplay: this.contextCapture.formatContextDisplay(context)
          }
        };
      }
      
      this.addToHistory(item);
      
      return { success: true };
    });
    
    ipcMain.handle('black-hole:add-html', async (event, data) => {
      console.log('Black hole: Adding HTML to space:', data.spaceId);
      
      // Capture app context for the source of the paste
      let context = null;
      try {
        context = await this.contextCapture.getFullContext();
        console.log('[Black hole] Captured context:', context);
      } catch (error) {
        console.error('[Black hole] Error capturing context:', error);
      }
      
      // Enhance source detection with context
      const detectedSource = context 
        ? this.contextCapture.enhanceSourceDetection(data.plainText || data.content, context)
        : 'black-hole';
      
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
      
      // Add context to metadata if available
      if (context) {
        item.metadata = {
          context: {
            app: context.app,
            window: context.window,
            contextDisplay: this.contextCapture.formatContextDisplay(context)
          }
        };
      }
      
      this.addToHistory(item);
      
      return { success: true };
    });
    
    ipcMain.handle('black-hole:add-image', async (event, data) => {
      console.log('Black hole: Adding image to space:', data.spaceId);
      
      // Capture app context for the source of the paste
      let context = null;
      try {
        context = await this.contextCapture.getFullContext();
        console.log('[Black hole] Captured context:', context);
      } catch (error) {
        console.error('[Black hole] Error capturing context:', error);
      }
      
      // Generate thumbnail if needed
      let thumbnail = data.dataUrl;
      if (data.dataUrl && data.dataUrl.length > 100000) {
        thumbnail = this.generateImageThumbnail(data.dataUrl);
      }
      
      const item = {
        type: 'image',
        content: data.dataUrl,
        thumbnail: thumbnail,
        preview: `Image: ${data.fileName}`,
        timestamp: Date.now(),
        pinned: false,
        spaceId: data.spaceId || this.currentSpace || 'unclassified',
        source: context?.app?.name || 'black-hole',
        metadata: {
          fileName: data.fileName,
          fileSize: data.fileSize
        }
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
      
      this.addToHistory(item);
      
      return { success: true };
    });
    
    ipcMain.handle('black-hole:add-file', async (event, data) => {
      console.log('Black hole: Adding file to space:', data.spaceId);
      
      // Capture app context for the source of the paste
      let context = null;
      try {
        context = await this.contextCapture.getFullContext();
        console.log('[Black hole] Captured context:', context);
      } catch (error) {
        console.error('[Black hole] Error capturing context:', error);
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
      } else if (['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.svg', '.webp', '.ico'].includes(ext)) {
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
      
      // Generate thumbnail for PDF files
      let thumbnail = null;
      if (fileType === 'pdf') {
        thumbnail = this.generatePDFThumbnail(data.fileName, data.fileSize);
      } else if (['.html', '.htm'].includes(ext)) {
        thumbnail = this.generateHTMLThumbnail(data.fileName, data.fileSize);
      } else if (fileType === 'notebook') {
        thumbnail = this.generateNotebookThumbnail(data.fileName, data.fileSize);
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
      
      // Add item to history - this will store the file in the correct location
      this.addToHistory(item);
      
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
          console.log('[V2] Cleaned up temp file:', item.filePath);
        } catch (err) {
          // Ignore cleanup errors
        }
      }
      
      return { success: true };
    });
    
    // Screenshot completion handler
    ipcMain.handle('clipboard:complete-screenshot', (event, { screenshotPath, spaceId, stats, ext }) => {
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
    ipcMain.handle('clipboard:generate-space-pdf', async (event, spaceId, options = {}) => {
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
    
    ipcMain.handle('clipboard:export-space-pdf', async (event, spaceId, options = {}) => {
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
    ipcMain.handle('clipboard:smart-export-space', async (event, spaceId) => {
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
    ipcMain.handle('clipboard:open-export-preview', async (event, spaceId, options = {}) => {
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
    ipcMain.handle('clipboard:add-website-monitor', async (event, config) => {
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
    
    ipcMain.handle('clipboard:check-website', async (event, monitorId) => {
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
    
    ipcMain.handle('clipboard:get-website-monitors', async () => {
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
    
    ipcMain.handle('clipboard:get-monitor-history', async (event, monitorId) => {
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
    
    ipcMain.handle('clipboard:remove-website-monitor', async (event, monitorId) => {
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
    
    ipcMain.handle('clipboard:pause-website-monitor', async (event, monitorId) => {
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
    
    ipcMain.handle('clipboard:resume-website-monitor', async (event, monitorId) => {
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
      const imageExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.svg', '.ico'];
      const documentExtensions = ['.pdf', '.doc', '.docx', '.odt', '.rtf'];
      const codeExtensions = ['.js', '.ts', '.py', '.java', '.cpp', '.c', '.h', '.css', '.html', '.jsx', '.tsx', '.vue', '.rb', '.go', '.rs', '.php', '.swift'];
      const dataExtensions = ['.json', '.xml', '.csv', '.yaml', '.yml', '.toml'];
      const textExtensions = ['.txt', '.md', '.log', '.ini', '.conf', '.config'];
      
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