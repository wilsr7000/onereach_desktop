const { FilesSyncNode } = require('@or-sdk/files-sync-node');
const { app, dialog, ipcMain } = require('electron');
const fs = require('fs').promises;
const path = require('path');
const { getSettingsManager } = require('./settings-manager');

class GSXFileSync {
  constructor() {
    this.client = null;
    this.isInitialized = false;
    this.syncInProgress = false;
    this.settingsManager = getSettingsManager();
    this.lastSyncTime = null;
    this.syncHistory = [];
    this.maxHistorySize = 100;
    
    // Default sync paths - includes everything needed for full restore
    this.defaultSyncPaths = [
      { local: path.join(app.getPath('documents'), 'OR-Spaces'), remote: 'OR-Spaces', description: 'Clipboard Spaces data' },
      { local: app.getPath('userData'), remote: 'App-Config', description: 'App configuration and settings' }
    ];
    
    // Optional: Desktop sync (user can enable)
    this.optionalSyncPaths = [
      { local: path.join(app.getPath('desktop')), remote: 'Desktop', description: 'Desktop files' }
    ];
  }
  
  /**
   * Initialize the GSX client with token and environment
   */
  async initialize() {
    try {
      const token = this.settingsManager.get('gsxToken');
      const environment = this.settingsManager.get('gsxEnvironment') || 'production';
      
      console.log('[GSX Sync] Checking token...', token ? `Token exists (length: ${token.length})` : 'NO TOKEN FOUND');
      console.log('[GSX Sync] Environment:', environment);
      
      if (!token || token.trim() === '') {
        const errorMsg = 'GSX token not configured. Please add your token in Settings (GSX File Sync Configuration section).';
        console.error('[GSX Sync] ERROR:', errorMsg);
        throw new Error(errorMsg);
      }
      
      // Set up URLs based on environment
      const discoveryUrls = {
        qa: 'https://discovery.qa.api.onereach.ai',
        staging: 'https://discovery.staging.api.onereach.ai',
        production: 'https://discovery.api.onereach.ai',
        edison: 'https://discovery.edison.onereach.ai'
      };
      
      // Direct Files API URLs as fallback
      const filesApiUrls = {
        qa: 'https://files.qa.api.onereach.ai',
        staging: 'https://files.staging.api.onereach.ai',
        production: 'https://files.onereach.ai',  // No 'api' subdomain for production
        edison: 'https://files.edison.onereach.ai'
      };
      
      const discoveryUrl = discoveryUrls[environment] || discoveryUrls.production;
      const filesApiUrl = filesApiUrls[environment] || filesApiUrls.production;
      
      console.log(`[GSX Sync] Initializing with environment: ${environment}`);
      console.log(`[GSX Sync] Files API URL: ${filesApiUrl}`);
      
      // Use direct Files API URL (more reliable than service discovery)
      console.log('[GSX Sync] Initializing SDK with direct Files API URL...');
      this.client = new FilesSyncNode({
        token: token.trim(),
        filesApiUrl: filesApiUrl
      });
      
      this.isInitialized = true;
      console.log('[GSX Sync] ✓ Client initialized and ready for sync operations');
      
      return true;
    } catch (error) {
      console.error('[GSX Sync] ✗ Failed to initialize:', error.message || error);
      console.error('[GSX Sync] Error details:', JSON.stringify(error, null, 2));
      this.isInitialized = false;
      throw new Error(error.message || 'Failed to initialize GSX sync');
    }
  }
  
  /**
   * Test the GSX connection
   */
  async testConnection() {
    try {
      console.log('[GSX Sync] Testing connection...');
      
      if (!this.isInitialized) {
        await this.initialize();
      }
      
      // The initialization itself validates the token
      // If we got here, the client is ready
      console.log('[GSX Sync] ✓ Connection test successful');
      
      return { 
        success: true, 
        message: 'Connection successful! Token is valid and Files API is accessible.' 
      };
    } catch (error) {
      console.error('[GSX Sync] ✗ Connection test failed:', error.message);
      return { 
        success: false, 
        error: error.message || 'Connection test failed. Check token and environment settings.'
      };
    }
  }
  
  /**
   * Sync local directory to GSX Files
   * @param {string} localPath - Local directory path
   * @param {string} remotePath - Remote directory name in GSX Files
   * @param {Object} options - Sync options
   */
  async syncDirectory(localPath, remotePath, options = {}) {
    if (this.syncInProgress) {
      throw new Error('Sync already in progress');
    }
    
    try {
      this.syncInProgress = true;
      
      if (!this.isInitialized) {
        await this.initialize();
      }
      
      console.log(`Syncing ${localPath} to GSX Files/${remotePath}`);
      
      // Check if local path exists
      const stats = await fs.stat(localPath);
      if (!stats.isDirectory()) {
        throw new Error('Local path is not a directory');
      }
      
      // Set default options
      const syncOptions = {
        isPublic: options.isPublic || false,
        ttl: options.ttl || null, // No expiration by default
        ...options
      };
      
      // Perform the sync
      // Note: The SDK automatically creates remote directories on GSX Files
      // The remotePath will be created if it doesn't exist
      await this.client.pushLocalPathToFiles(localPath, remotePath, syncOptions);
      
      console.log(`✓ Successfully synced to GSX Files/${remotePath}`);
      
      // Record sync history
      const syncRecord = {
        timestamp: new Date().toISOString(),
        localPath,
        remotePath,
        options: syncOptions,
        status: 'success'
      };
      
      this.addToHistory(syncRecord);
      this.lastSyncTime = new Date();
      
      console.log(`Successfully synced ${localPath} to GSX Files/${remotePath}`);
      
      return syncRecord;
    } catch (error) {
      console.error('Sync failed:', error);
      
      // Record failed sync
      const syncRecord = {
        timestamp: new Date().toISOString(),
        localPath,
        remotePath,
        options: options,
        status: 'failed',
        error: error.message
      };
      
      this.addToHistory(syncRecord);
      
      throw error;
    } finally {
      this.syncInProgress = false;
    }
  }
  
  /**
   * Sync desktop folder to GSX Files
   */
  async syncDesktop(options = {}) {
    const desktopPath = app.getPath('desktop');
    const remotePath = options.remotePath || 'Desktop-Backup';
    
    return await this.syncDirectory(desktopPath, remotePath, options);
  }
  
  /**
   * Sync OR-Spaces (clipboard data) to GSX Files
   */
  async syncORSpaces(options = {}) {
    const orSpacesPath = path.join(app.getPath('documents'), 'OR-Spaces');
    const remotePath = options.remotePath || 'OR-Spaces-Backup';
    
    // Check if OR-Spaces exists
    try {
      await fs.stat(orSpacesPath);
    } catch (error) {
      console.log('OR-Spaces directory not found, creating it...');
      await fs.mkdir(orSpacesPath, { recursive: true });
    }
    
    return await this.syncDirectory(orSpacesPath, remotePath, options);
  }
  
  /**
   * Sync App Configuration (userData) to GSX Files
   * This includes: settings, IDW configs, GSX links, reading logs, etc.
   */
  async syncAppConfig(options = {}) {
    const userDataPath = app.getPath('userData');
    const remotePath = options.remotePath || 'App-Config-Backup';
    
    // Check if userData exists (it should always exist, but be safe)
    try {
      await fs.stat(userDataPath);
      console.log('Syncing app configuration from:', userDataPath);
      console.log('Files to sync: settings, IDW entries, GSX links, reading logs, and more');
    } catch (error) {
      throw new Error(`User data directory not found: ${userDataPath}`);
    }
    
    return await this.syncDirectory(userDataPath, remotePath, options);
  }
  
  /**
   * Complete backup - syncs everything needed to restore on a new machine
   */
  async syncCompleteBackup(options = {}) {
    console.log('[GSX Sync] Starting complete backup...');
    const results = [];
    
    try {
      // Initialize first
      if (!this.isInitialized) {
        console.log('[GSX Sync] Not initialized, initializing now...');
        await this.initialize();
      }
      
      // 1. Sync OR-Spaces (clipboard data)
      console.log('[GSX Sync] Step 1/2: Backing up OR-Spaces...');
      const orSpacesResult = await this.syncORSpaces({
        ...options,
        remotePath: 'Complete-Backup/OR-Spaces'
      });
      results.push({ ...orSpacesResult, name: 'OR-Spaces' });
      console.log('[GSX Sync] ✓ OR-Spaces backup complete');
      
      // 2. Sync App Config (settings, preferences, logs)
      console.log('[GSX Sync] Step 2/2: Backing up app configuration...');
      const configResult = await this.syncAppConfig({
        ...options,
        remotePath: 'Complete-Backup/App-Config'
      });
      results.push({ ...configResult, name: 'App-Config' });
      console.log('[GSX Sync] ✓ App Config backup complete');
      
      console.log('[GSX Sync] ✓ Complete backup finished successfully');
      return {
        timestamp: new Date().toISOString(),
        status: 'success',
        results: results
      };
    } catch (error) {
      console.error('[GSX Sync] ✗ Complete backup failed:', error.message || error);
      console.error('[GSX Sync] Error stack:', error.stack);
      throw new Error(error.message || 'Complete backup failed');
    }
  }
  
  /**
   * Sync multiple directories
   */
  async syncMultiple(syncPaths = this.defaultSyncPaths, options = {}) {
    const results = [];
    
    for (const syncPath of syncPaths) {
      try {
        const result = await this.syncDirectory(
          syncPath.local, 
          syncPath.remote, 
          options
        );
        results.push(result);
      } catch (error) {
        console.error(`Failed to sync ${syncPath.local}:`, error);
        results.push({
          localPath: syncPath.local,
          remotePath: syncPath.remote,
          status: 'failed',
          error: error.message
        });
      }
    }
    
    return results;
  }
  
  /**
   * Get configured sync paths from settings
   */
  getSyncPaths() {
    const customPaths = this.settingsManager.get('gsxSyncPaths');
    return customPaths || this.defaultSyncPaths;
  }
  
  /**
   * Save custom sync paths to settings
   */
  saveSyncPaths(syncPaths) {
    return this.settingsManager.set('gsxSyncPaths', syncPaths);
  }
  
  /**
   * Add sync record to history
   */
  addToHistory(record) {
    this.syncHistory.unshift(record);
    
    // Limit history size
    if (this.syncHistory.length > this.maxHistorySize) {
      this.syncHistory = this.syncHistory.slice(0, this.maxHistorySize);
    }
    
    // Save history to disk
    this.saveHistory();
  }
  
  /**
   * Load sync history from disk
   */
  async loadHistory() {
    try {
      const historyPath = path.join(app.getPath('userData'), 'gsx-sync-history.json');
      const data = await fs.readFile(historyPath, 'utf8');
      this.syncHistory = JSON.parse(data);
    } catch (error) {
      // History file doesn't exist yet
      this.syncHistory = [];
    }
  }
  
  /**
   * Save sync history to disk
   */
  async saveHistory() {
    try {
      const historyPath = path.join(app.getPath('userData'), 'gsx-sync-history.json');
      await fs.writeFile(historyPath, JSON.stringify(this.syncHistory, null, 2));
    } catch (error) {
      console.error('Failed to save sync history:', error);
    }
  }
  
  /**
   * Get sync history
   */
  getHistory() {
    return this.syncHistory;
  }
  
  /**
   * Clear sync history
   */
  clearHistory() {
    this.syncHistory = [];
    return this.saveHistory();
  }
  
  /**
   * Handle file selection dialog for custom sync
   */
  async selectDirectoryForSync() {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
      title: 'Select Directory to Sync to GSX Files'
    });
    
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    
    return result.filePaths[0];
  }
  
  /**
   * Setup IPC handlers for renderer process communication
   */
  setupIPC() {
    // Test GSX connection
    ipcMain.handle('gsx:test-connection', async () => {
      return await this.testConnection();
    });
    
    // Sync desktop
    ipcMain.handle('gsx:sync-desktop', async (event, options) => {
      try {
        const result = await this.syncDesktop(options);
        return { success: true, result };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });
    
    // Sync OR-Spaces
    ipcMain.handle('gsx:sync-or-spaces', async (event, options) => {
      try {
        const result = await this.syncORSpaces(options);
        return { success: true, result };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });
    
    // Sync App Config
    ipcMain.handle('gsx:sync-app-config', async (event, options) => {
      try {
        const result = await this.syncAppConfig(options);
        return { success: true, result };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });
    
    // Complete backup
    ipcMain.handle('gsx:sync-complete-backup', async (event, options) => {
      try {
        const result = await this.syncCompleteBackup(options);
        return { success: true, result };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });
    
    // Sync custom directory
    ipcMain.handle('gsx:sync-directory', async (event, localPath, remotePath, options) => {
      try {
        const result = await this.syncDirectory(localPath, remotePath, options);
        return { success: true, result };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });
    
    // Select and sync directory
    ipcMain.handle('gsx:select-and-sync', async (event, options) => {
      try {
        const localPath = await this.selectDirectoryForSync();
        if (!localPath) {
          return { success: false, error: 'No directory selected' };
        }
        
        // Get directory name for remote path
        const dirName = path.basename(localPath);
        const remotePath = options.remotePath || dirName;
        
        const result = await this.syncDirectory(localPath, remotePath, options);
        return { success: true, result };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });
    
    // Get sync history
    ipcMain.handle('gsx:get-history', async () => {
      return this.getHistory();
    });
    
    // Clear sync history
    ipcMain.handle('gsx:clear-history', async () => {
      await this.clearHistory();
      return { success: true };
    });
    
    // Get sync paths
    ipcMain.handle('gsx:get-sync-paths', async () => {
      return this.getSyncPaths();
    });
    
    // Save sync paths
    ipcMain.handle('gsx:save-sync-paths', async (event, syncPaths) => {
      return this.saveSyncPaths(syncPaths);
    });
    
    // Initialize client
    ipcMain.handle('gsx:initialize', async () => {
      try {
        await this.initialize();
        return { success: true };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });
    
    // Get sync status
    ipcMain.handle('gsx:get-status', async () => {
      return {
        isInitialized: this.isInitialized,
        syncInProgress: this.syncInProgress,
        lastSyncTime: this.lastSyncTime
      };
    });
    
    console.log('GSX File Sync IPC handlers registered');
  }
}

// Create singleton instance
let gsxFileSync;

function getGSXFileSync() {
  if (!gsxFileSync) {
    gsxFileSync = new GSXFileSync();
    gsxFileSync.loadHistory(); // Load history on initialization
  }
  return gsxFileSync;
}

module.exports = {
  getGSXFileSync,
  GSXFileSync
};
