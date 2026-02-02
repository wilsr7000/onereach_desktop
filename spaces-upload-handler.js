const { BrowserWindow, ipcMain, app } = require('electron');
const { getSpacesAPI } = require('./spaces-api');
const path = require('path');
const fs = require('fs');
const os = require('os');

/**
 * Spaces Upload Handler
 * 
 * Handles file selection from Spaces, file preparation/export,
 * and temp file cleanup for upload operations
 */

// Track temp files for cleanup
const tempUploadFiles = new Set();

// Track if cleanup handlers are registered
let cleanupHandlersRegistered = false;

/**
 * Show Spaces picker window and return selected file paths
 * @param {BrowserWindow} parentWindow - Parent window for modal
 * @returns {Promise<string[]|null>} Array of file paths or null if cancelled
 */
async function showSpacesPicker(parentWindow) {
  return new Promise((resolve) => {
    const picker = new BrowserWindow({
      width: 700,
      height: 600,
      modal: true,
      parent: parentWindow,
      title: 'Choose from Spaces',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, 'spaces-picker-preload.js')
      }
    });
    
    picker.loadFile('spaces-picker.html');
    
    // Handle selection
    const selectHandler = async (event, items) => {
      try {
        console.log('[Spaces Upload] Processing', items.length, 'selected items');
        const fileDataList = await prepareSpacesFiles(items);
        picker.close();
        resolve(fileDataList);
      } catch (err) {
        console.error('[Spaces Upload] Error preparing files:', err);
        picker.close();
        resolve(null);
      }
    };
    
    // Handle cancel
    const cancelHandler = () => {
      console.log('[Spaces Upload] User cancelled');
      picker.close();
      resolve(null);
    };
    
    // Register handlers
    ipcMain.once('spaces-picker:select', selectHandler);
    ipcMain.once('spaces-picker:cancel', cancelHandler);
    
    // Cleanup on window close
    picker.on('closed', () => {
      ipcMain.removeListener('spaces-picker:select', selectHandler);
      ipcMain.removeListener('spaces-picker:cancel', cancelHandler);
      resolve(null);
    });
  });
}

/**
 * Prepare Spaces items for upload - export to temporary files and return paths
 * @param {Array} items - Selected items from Spaces
 * @param {Function} onProgress - Optional progress callback (current, total, itemName) => void
 * @returns {Promise<string[]>} Array of temporary file paths
 */
async function prepareSpacesFiles(items, onProgress = null) {
  // Use the global Spaces API (shared singleton)
  const spacesAPI = getSpacesAPI();
  const filePaths = [];
  const total = items.length;
  
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const itemName = item.fileName || item.preview || `Item ${i + 1}`;
    
    // Report progress
    if (onProgress) {
      try {
        onProgress(i, total, itemName);
      } catch (e) {
        // Ignore progress callback errors
      }
    }
    
    try {
      let tempPath = null;
      
      if (item.type === 'file') {
        // Native file - check if it exists and return original path or copy to temp
        const fullItem = await spacesAPI.items.get(item.spaceId, item.id);
        const originalPath = fullItem.content;
        console.log('[Spaces Upload] File item:', originalPath);
        
        if (fs.existsSync(originalPath)) {
          // File exists, use original path
          tempPath = originalPath;
        } else {
          console.warn('[Spaces Upload] File not found:', originalPath);
        }
        
      } else if (item.type === 'text' || item.type === 'code' || item.type === 'html') {
        // Text/code/html - export to temp file
        const fullItem = await spacesAPI.items.get(item.spaceId, item.id);
        let ext = '.txt';
        if (item.type === 'code') {
          ext = path.extname(fullItem.contentPath || '.txt') || '.txt';
        } else if (item.type === 'html') {
          ext = '.html';
        }
        
        const fileName = fullItem.fileName || item.preview || `item-${item.id}`;
        const safeName = fileName.replace(/[^a-zA-Z0-9.-]/g, '_');
        tempPath = path.join(os.tmpdir(), `spaces-upload-${safeName}${ext}`);
        
        fs.writeFileSync(tempPath, fullItem.content, 'utf8');
        tempUploadFiles.add(tempPath);
        
        console.log('[Spaces Upload] Text item exported to:', tempPath);
        
      } else if (item.type === 'image') {
        // Image - export to temp file
        const fullItem = await spacesAPI.items.get(item.spaceId, item.id);
        
        if (fullItem.content && fullItem.content.startsWith('data:')) {
          // Data URL - extract base64 and write to temp file
          const matches = fullItem.content.match(/^data:image\/(\w+);base64,(.+)$/);
          if (matches) {
            const ext = matches[1] === 'jpeg' ? 'jpg' : matches[1];
            const base64Data = matches[2];
            
            const fileName = fullItem.fileName || `image-${item.id}`;
            const safeName = fileName.replace(/[^a-zA-Z0-9.-]/g, '_');
            tempPath = path.join(os.tmpdir(), `spaces-upload-${safeName}.${ext}`);
            
            fs.writeFileSync(tempPath, Buffer.from(base64Data, 'base64'));
            tempUploadFiles.add(tempPath);
            
            console.log('[Spaces Upload] Image data URL exported to:', tempPath);
          }
        } else if (fullItem.content && fs.existsSync(fullItem.content)) {
          // File path exists, use it directly
          tempPath = fullItem.content;
          console.log('[Spaces Upload] Image file:', tempPath);
        }
      }
      
      if (tempPath) {
        filePaths.push(tempPath);
      } else {
        console.warn('[Spaces Upload] Could not prepare item:', item.id, item.type);
      }
    } catch (err) {
      console.error('[Spaces Upload] Error preparing item:', item.id, err);
    }
  }
  
  // Report completion
  if (onProgress) {
    try {
      onProgress(total, total, 'Complete');
    } catch (e) {
      // Ignore progress callback errors
    }
  }
  
  // Schedule cleanup after 5 minutes
  if (tempUploadFiles.size > 0) {
    setTimeout(cleanupTempFiles, 5 * 60 * 1000);
  }
  
  return filePaths;
}

/**
 * Clean up temporary files created for uploads
 * @param {boolean} silent - If true, don't log cleanup count
 */
function cleanupTempFiles(silent = false) {
  let cleaned = 0;
  for (const filePath of tempUploadFiles) {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        cleaned++;
      }
    } catch (e) {
      if (!silent) {
        console.error('[Spaces Upload] Cleanup error:', e);
      }
    }
  }
  tempUploadFiles.clear();
  if (cleaned > 0 && !silent) {
    console.log('[Spaces Upload] Cleaned up', cleaned, 'temp files');
  }
  return cleaned;
}

/**
 * Register cleanup handlers for app quit
 * Call this once during app initialization
 */
function registerCleanupOnExit() {
  if (cleanupHandlersRegistered) {
    return;
  }
  
  // Clean up on app quit
  app.on('will-quit', () => {
    console.log('[Spaces Upload] App quitting, cleaning up temp files...');
    cleanupTempFiles(true);
  });
  
  // Also clean up on before-quit (earlier in quit sequence)
  app.on('before-quit', () => {
    cleanupTempFiles(true);
  });
  
  // Handle unexpected exits
  process.on('exit', () => {
    cleanupTempFiles(true);
  });
  
  cleanupHandlersRegistered = true;
  console.log('[Spaces Upload] Cleanup handlers registered for app exit');
}

/**
 * Register IPC handlers for Spaces picker
 */
function registerIPCHandlers() {
  // Handle picker request from webviews
  ipcMain.handle('open-spaces-picker', async (event) => {
    const browserWindow = BrowserWindow.fromWebContents(event.sender);
    return await showSpacesPicker(browserWindow);
  });

  // Get all spaces for picker
  ipcMain.handle('spaces-picker:get-spaces', async () => {
    const spacesAPI = getSpacesAPI();
    return await spacesAPI.list();
  });

  // Get items in a space for picker
  ipcMain.handle('spaces-picker:get-items', async (event, spaceId) => {
    const spacesAPI = getSpacesAPI();
    return await spacesAPI.items.list(spaceId, { includeContent: false });
  });
  
  // Also register cleanup handlers when IPC is registered
  registerCleanupOnExit();
  
  console.log('[Spaces Upload] IPC handlers registered');
}

/**
 * Get count of pending temp files (for diagnostics)
 */
function getTempFileCount() {
  return tempUploadFiles.size;
}

module.exports = { 
  showSpacesPicker, 
  prepareSpacesFiles, 
  cleanupTempFiles,
  registerIPCHandlers,
  registerCleanupOnExit,
  getTempFileCount
};
