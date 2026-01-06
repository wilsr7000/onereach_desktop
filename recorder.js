/**
 * Recorder Module for Onereach.ai
 * Standalone video recorder with instruction support
 * 
 * Features:
 * - Camera and screen capture
 * - Instruction-driven recording (from Editor)
 * - Live preview with duration counter
 * - Direct save to Space/Project
 */

const { BrowserWindow, ipcMain, systemPreferences, app } = require('electron');
const path = require('path');
const fs = require('fs');
const getLogger = require('./event-logger');

// Helper to get storage root for saving recordings
function getStorageRoot() {
  // Try global clipboard manager first
  if (global.clipboardManager && global.clipboardManager.storage && global.clipboardManager.storage.storageRoot) {
    return global.clipboardManager.storage.storageRoot;
  }
  
  // Fallback: create our own ClipboardStorage instance
  try {
    const ClipboardStorage = require('./clipboard-storage-v2');
    const storage = new ClipboardStorage();
    return storage.storageRoot;
  } catch (err) {
    console.warn('[Recorder] Could not load ClipboardStorage:', err.message);
    // Final fallback: use app's userData
    return path.join(app.getPath('userData'), 'clipboard-data');
  }
}

class Recorder {
  constructor() {
    this.window = null;
    this.instructions = null;
    this.targetSpace = null;
    this.targetProject = null;
    this.ipcHandlersRegistered = false;
  }

  /**
   * Open the recorder window
   * @param {Object} options - Launch options
   * @param {string} options.instructions - Recording instructions text
   * @param {number} options.targetDuration - Target duration in seconds
   * @param {string} options.spaceId - Target space ID for saving
   * @param {string} options.projectId - Target project ID for saving
   */
  open(options = {}) {
    const logger = getLogger();
    
    if (this.window) {
      this.window.focus();
      if (options.instructions) {
        this.instructions = options;
        this.window.webContents.send('recorder:instructions', options);
      }
      logger.logFeatureUsed('recorder', { action: 'focus-existing' });
      return this.window;
    }

    logger.logFeatureUsed('recorder', { 
      action: 'open',
      hasInstructions: !!options.instructions,
      targetSpace: options.spaceId || null,
      targetProject: options.projectId || null
    });

    this.instructions = options;
    this.targetSpace = options.spaceId || null;
    this.targetProject = options.projectId || null;

    this.window = new BrowserWindow({
      width: 800,
      height: 700,
      minWidth: 600,
      minHeight: 500,
      title: 'GSX Capture',
      backgroundColor: '#0d0d0d',
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 12, y: 12 },
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        devTools: true,
        preload: path.join(__dirname, 'preload-recorder.js'),
        // Enable media features
        enableBlinkFeatures: 'MediaStreamAPI,WebRTC,MediaRecorder'
      }
    });

    // Enable dev tools keyboard shortcut (Cmd+Option+I / Ctrl+Shift+I)
    this.window.webContents.on('before-input-event', (event, input) => {
      if ((input.meta && input.alt && input.key === 'i') || 
          (input.control && input.shift && input.key === 'I')) {
        this.window.webContents.toggleDevTools();
      }
    });

    this.window.loadFile('recorder.html');

    this.window.on('closed', () => {
      this.window = null;
      this.instructions = null;
    });

    // Send instructions once window is ready
    this.window.webContents.on('did-finish-load', () => {
      if (this.instructions) {
        this.window.webContents.send('recorder:instructions', this.instructions);
      }
    });

    return this.window;
  }

  /**
   * Close the recorder window
   */
  close() {
    if (this.window) {
      this.window.close();
    }
  }

  /**
   * Setup IPC handlers
   */
  setupIPC() {
    if (this.ipcHandlersRegistered) {
      console.log('[Recorder] IPC handlers already registered');
      return;
    }
    this.ipcHandlersRegistered = true;

    // Get current instructions
    ipcMain.handle('recorder:get-instructions', () => {
      return this.instructions || null;
    });

    // Get available media devices
    ipcMain.handle('recorder:get-devices', async () => {
      // This is handled in renderer via navigator.mediaDevices
      return { success: true };
    });

    // Request media permissions (macOS)
    ipcMain.handle('recorder:request-permissions', async (event, type) => {
      if (process.platform !== 'darwin') {
        return { granted: true, status: 'not-darwin' };
      }

      try {
        const mediaType = type === 'screen' ? 'screen' : type;
        const status = systemPreferences.getMediaAccessStatus(mediaType);
        
        if (status === 'granted') {
          return { granted: true, status };
        }

        if (mediaType === 'camera' || mediaType === 'microphone') {
          const granted = await systemPreferences.askForMediaAccess(mediaType);
          return { granted, status: systemPreferences.getMediaAccessStatus(mediaType) };
        }

        return { granted: status === 'granted', status };
      } catch (error) {
        console.error('[Recorder] Permission error:', error);
        return { granted: false, status: 'error', error: error.message };
      }
    });

    // Save recording to space
    ipcMain.handle('recorder:save-to-space', async (event, data) => {
      try {
        const { blob, filename, spaceId, projectId, metadata } = data;
        
        // Determine save path
        let savePath;
        const storageRoot = getStorageRoot();
        
        if (projectId) {
          // Save to project folder
          const projectDir = path.join(
            storageRoot,
            'spaces',
            spaceId || 'default',
            'projects',
            projectId,
            'source'
          );
          
          if (!fs.existsSync(projectDir)) {
            fs.mkdirSync(projectDir, { recursive: true });
          }
          
          savePath = path.join(projectDir, filename || `recording_${Date.now()}.webm`);
        } else if (spaceId) {
          // Save to space root
          const spaceDir = path.join(
            storageRoot,
            'spaces',
            spaceId
          );
          
          if (!fs.existsSync(spaceDir)) {
            fs.mkdirSync(spaceDir, { recursive: true });
          }
          
          savePath = path.join(spaceDir, filename || `recording_${Date.now()}.webm`);
        } else {
          // Save to default exports folder
          const exportsDir = path.join(app.getPath('userData'), 'video-exports');
          if (!fs.existsSync(exportsDir)) {
            fs.mkdirSync(exportsDir, { recursive: true });
          }
          savePath = path.join(exportsDir, filename || `recording_${Date.now()}.webm`);
        }

        // Write the blob data
        const buffer = Buffer.from(blob, 'base64');
        fs.writeFileSync(savePath, buffer);

        const logger = getLogger();
        logger.logFeatureUsed('recorder', {
          action: 'save-recording',
          spaceId: spaceId || null,
          projectId: projectId || null,
          size: buffer.length
        });
        logger.logFileOperation('save', savePath, { 
          size: buffer.length,
          type: 'video-recording'
        });

        // Save metadata if provided
        if (metadata) {
          const metadataPath = savePath.replace(/\.[^.]+$/, '.json');
          fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
        }

        return {
          success: true,
          path: savePath,
          size: buffer.length
        };
      } catch (error) {
        const logger = getLogger();
        logger.error('Recorder save failed', {
          error: error.message,
          stack: error.stack
        });
        return { success: false, error: error.message };
      }
    });

    // Get project folder
    ipcMain.handle('recorder:get-project-folder', async (event, spaceId) => {
      const storageRoot = getStorageRoot();
      
      const projectsDir = path.join(
        storageRoot,
        'spaces',
        spaceId,
        'projects'
      );

      if (!fs.existsSync(projectsDir)) {
        return { success: true, projects: [] };
      }

      try {
        const projects = fs.readdirSync(projectsDir)
          .filter(f => fs.statSync(path.join(projectsDir, f)).isDirectory())
          .map(f => {
            const projectJson = path.join(projectsDir, f, 'project.json');
            let name = f;
            if (fs.existsSync(projectJson)) {
              try {
                const data = JSON.parse(fs.readFileSync(projectJson, 'utf8'));
                name = data.name || f;
              } catch (e) {}
            }
            return { id: f, name };
          });

        return { success: true, projects };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    // Close recorder
    ipcMain.handle('recorder:close', () => {
      this.close();
      return { success: true };
    });

    // Minimize recorder
    ipcMain.handle('recorder:minimize', () => {
      if (this.window) {
        this.window.minimize();
      }
      return { success: true };
    });

    console.log('[Recorder] IPC handlers registered');
  }
}

// Singleton instance
let recorder = null;

function getRecorder() {
  if (!recorder) {
    recorder = new Recorder();
  }
  return recorder;
}

module.exports = {
  Recorder,
  getRecorder
};
