const { BrowserWindow, ipcMain } = require('electron');
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
 * Prepare Spaces items for upload - export to file data objects
 * @param {Array} items - Selected items from Spaces
 * @returns {Promise<Array>} Array of file data objects {name, type, data}
 */
async function prepareSpacesFiles(items) {
  // Use the global Spaces API (shared singleton)
  const spacesAPI = getSpacesAPI();
  const fileDataList = [];
  
  for (const item of items) {
    try {
      let fileData;
      
      if (item.type === 'file') {
        // Native file - read content and convert to base64
        const fullItem = await spacesAPI.items.get(item.spaceId, item.id);
        const filePath = fullItem.content;
        console.log('[Spaces Upload] File item:', filePath);
        
        const fileContent = fs.readFileSync(filePath);
        const base64 = fileContent.toString('base64');
        const fileName = path.basename(filePath);
        
        fileData = {
          name: fileName,
          type: 'application/octet-stream', // Will be detected by browser
          data: base64
        };
        
      } else if (item.type === 'text' || item.type === 'code' || item.type === 'html') {
        // Text/code/html - export to temp file and read
        const fullItem = await spacesAPI.items.get(item.spaceId, item.id);
        const ext = path.extname(fullItem.contentPath || '.txt');
        const tempPath = path.join(os.tmpdir(), `spaces-upload-${item.id}${ext}`);
        
        fs.writeFileSync(tempPath, fullItem.content, 'utf8');
        tempUploadFiles.add(tempPath);
        
        const fileContent = fs.readFileSync(tempPath);
        const base64 = fileContent.toString('base64');
        const fileName = `${item.id}${ext}`;
        
        fileData = {
          name: fileName,
          type: 'text/plain',
          data: base64
        };
        
        console.log('[Spaces Upload] Text item exported');
        
      } else if (item.type === 'image') {
        // Image - export to temp file or use data URL
        const fullItem = await spacesAPI.items.get(item.spaceId, item.id);
        
        if (fullItem.content && fullItem.content.startsWith('data:')) {
          // Data URL - extract base64
          const matches = fullItem.content.match(/^data:image\/(\w+);base64,(.+)$/);
          if (matches) {
            const ext = matches[1];
            const base64Data = matches[2];
            
            fileData = {
              name: `${item.id}.${ext}`,
              type: `image/${ext}`,
              data: base64Data
            };
            console.log('[Spaces Upload] Image data URL');
          }
        } else if (fullItem.content) {
          // File path
          const filePath = fullItem.content;
          const fileContent = fs.readFileSync(filePath);
          const base64 = fileContent.toString('base64');
          const fileName = path.basename(filePath);
          
          fileData = {
            name: fileName,
            type: 'image/png', // Will be detected
            data: base64
          };
          console.log('[Spaces Upload] Image file:', filePath);
        }
      }
      
      if (fileData) {
        fileDataList.push(fileData);
      } else {
        console.warn('[Spaces Upload] Could not prepare item:', item.id, item.type);
      }
    } catch (err) {
      console.error('[Spaces Upload] Error preparing item:', item.id, err);
    }
  }
  
  // Schedule cleanup after 5 minutes
  setTimeout(cleanupTempFiles, 5 * 60 * 1000);
  
  return fileDataList;
}

/**
 * Clean up temporary files created for uploads
 */
function cleanupTempFiles() {
  let cleaned = 0;
  for (const filePath of tempUploadFiles) {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        cleaned++;
      }
    } catch (e) {
      console.error('[Spaces Upload] Cleanup error:', e);
    }
  }
  tempUploadFiles.clear();
  if (cleaned > 0) {
    console.log('[Spaces Upload] Cleaned up', cleaned, 'temp files');
  }
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
  
  console.log('[Spaces Upload] IPC handlers registered');
}

module.exports = { 
  showSpacesPicker, 
  prepareSpacesFiles, 
  cleanupTempFiles,
  registerIPCHandlers
};
