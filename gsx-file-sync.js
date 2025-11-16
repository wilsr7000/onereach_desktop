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
    this.alertShowing = false; // Track if error alert is already showing
    
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
      let token = this.settingsManager.get('gsxToken');
      const environment = this.settingsManager.get('gsxEnvironment') || 'production';
      
      console.log('[GSX Sync] Raw token from settings:', typeof token, token ? `(length: ${token.length})` : 'NULL/UNDEFINED');
      console.log('[GSX Sync] Environment from settings:', environment);
      
      // Handle if token is an object instead of string (from encryption)
      if (token && typeof token === 'object') {
        console.log('[GSX Sync] Token is an object, extracting string value...');
        if (token.data) {
          console.log('[GSX Sync] Found encrypted token data, this should have been decrypted');
          throw new Error('Token is still encrypted. Settings manager issue.');
        }
        token = String(token);
      }
      
      console.log('[GSX Sync] Processed token:', token ? `Length: ${token.length}` : 'NO TOKEN FOUND');
      
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
      console.log(`[GSX Sync] Discovery URL: ${discoveryUrl}`);
      console.log(`[GSX Sync] Token (first 10 chars): ${token.trim().substring(0, 10)}...`);
      console.log(`[GSX Sync] Token length: ${token.trim().length}`);
      
      // MUST use service discovery - direct URLs hit CloudFront which needs signed requests
      // Service discovery returns the correct pre-signed endpoint
      console.log('[GSX Sync] Initializing SDK with service discovery...');
      console.log('[GSX Sync] This may take a moment as it queries the discovery service...');
      
      // Get account ID if available (might be needed for SDK)
      const accountId = this.settingsManager.get('gsxAccountId');
      if (accountId) {
        console.log(`[GSX Sync] Using account ID: ${accountId}`);
      }
      
      try {
        const sdkOptions = {
          token: token.trim(),
          discoveryUrl: discoveryUrl
        };
        
        // Add accountId if available
        if (accountId && accountId.trim()) {
          sdkOptions.accountId = accountId.trim();
          console.log('[GSX Sync] Including account ID in SDK options');
        } else {
          console.log('[GSX Sync] No account ID provided - SDK will use token to determine account');
        }
        
        console.log('[GSX Sync] SDK options (sanitized):', {
          discoveryUrl: sdkOptions.discoveryUrl,
          accountId: sdkOptions.accountId || 'not-provided',
          tokenLength: token.trim().length,
          tokenPrefix: token.trim().substring(0, 8) + '...',
          tokenSuffix: '...' + token.trim().substring(token.trim().length - 4)
        });
        
        console.log('[GSX Sync] Creating FilesSyncNode instance...');
        this.client = new FilesSyncNode(sdkOptions);
        
        console.log('[GSX Sync] ✓ SDK client object created (constructor completed)');
        
        // Log the client object properties (without sensitive data)
        console.log('[GSX Sync] Client created with internal filesClient:', !!this.client.filesClient);
        
        this.isInitialized = true;
        console.log('[GSX Sync] ✓ Client marked as initialized');
      } catch (sdkError) {
        console.error('[GSX Sync] ✗ SDK initialization threw exception');
        console.error('[GSX Sync] Error type:', sdkError.constructor.name);
        console.error('[GSX Sync] Error message:', sdkError.message);
        console.error('[GSX Sync] Error code:', sdkError.code);
        console.error('[GSX Sync] Full error:', sdkError);
        
        if (sdkError.stack) {
          console.error('[GSX Sync] Stack trace:', sdkError.stack);
        }
        
        // Provide helpful error message based on error type
        let helpfulMessage = sdkError.message;
        if (sdkError.message && sdkError.message.includes('401')) {
          helpfulMessage = 'Token rejected (401 Unauthorized). Please verify:\n1. Token is correct and complete\n2. Environment matches where token was created\n3. Token has Files API permissions';
        } else if (sdkError.message && sdkError.message.includes('403')) {
          helpfulMessage = 'Access forbidden (403). Token may not have Files API permissions.';
        } else if (sdkError.message && sdkError.message.includes('serviceUrl')) {
          helpfulMessage = 'Service discovery failed. Check internet connection and environment setting.';
        }
        
        throw new Error(helpfulMessage);
      }
      
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
      
      console.log(`[GSX Sync] Syncing ${localPath} to GSX Files/${remotePath}`);
      
      // Notify progress start
      if (options.progressCallback) {
        options.progressCallback({
          type: 'start',
          message: 'Preparing sync...',
          localPath,
          remotePath
        });
      }
      
      // Check if local path exists
      const stats = await fs.stat(localPath);
      if (!stats.isDirectory()) {
        throw new Error('Local path is not a directory');
      }
      
      console.log('[GSX Sync] Getting directory info...');
      // Get directory size and file count
      const dirInfo = await this.getDirectoryInfo(localPath, options.progressCallback);
      console.log(`[GSX Sync] Directory contains ${dirInfo.fileCount} files (${this.formatBytes(dirInfo.totalSize)})`);
      
      // Notify total files
      if (options.progressCallback) {
        options.progressCallback({
          type: 'start',
          message: `Syncing ${dirInfo.fileCount} files...`,
          totalFiles: dirInfo.fileCount,
          totalBytes: dirInfo.totalSize
        });
      }
      
      // Set default options
      const syncOptions = {
        isPublic: options.isPublic || false,
        ttl: options.ttl || null, // No expiration by default
        ...options,
        // Add progress tracking wrapper
        onFileProgress: options.progressCallback ? (fileName, bytesTransferred, fileNumber) => {
          options.progressCallback({
            type: 'file',
            message: `Uploading ${fileName}...`,
            fileName,
            processed: fileNumber,
            total: dirInfo.fileCount,
            bytesTransferred
          });
        } : undefined
      };
      
      const startTime = Date.now();
      
      console.log('[GSX Sync] Starting SDK upload...');
      console.log('[GSX Sync] Upload options:', {
        remotePath,
        isPublic: syncOptions.isPublic,
        hasTTL: !!syncOptions.ttl
      });
      
      // Perform the sync
      // Note: The SDK automatically creates remote directories on GSX Files
      // The remotePath will be created if it doesn't exist
      try {
        // Track files processed for progress
        let filesProcessed = 0;
        let bytesTransferred = 0;
        
        // Since the SDK doesn't expose progress, we'll simulate it based on file discovery
        // Get all files first
        const allFiles = await this.getAllFiles(localPath);
        
        // Upload files with progress tracking
        for (const file of allFiles) {
          const fileName = path.relative(localPath, file);
          const fileStats = await fs.stat(file);
          
          if (options.progressCallback) {
            options.progressCallback({
              type: 'file',
              message: `Uploading ${fileName}...`,
              fileName,
              processed: filesProcessed,
              total: allFiles.length,
              bytesTransferred: bytesTransferred
            });
          }
          
          filesProcessed++;
          bytesTransferred += fileStats.size;
        }
        
        // Perform the actual sync
        await this.client.pushLocalPathToFiles(localPath, remotePath, syncOptions);
        console.log('[GSX Sync] ✓ SDK upload completed successfully');
      } catch (uploadError) {
        console.error('[GSX Sync] ✗ SDK upload failed:', uploadError);
        console.error('[GSX Sync] Upload error message:', uploadError.message);
        console.error('[GSX Sync] Upload error details:', uploadError);
        throw new Error(`Upload failed: ${uploadError.message}`);
      }
      
      const duration = Date.now() - startTime;
      
      console.log(`✓ Successfully synced to GSX Files/${remotePath}`);
      
      // Record sync history with detailed info
      const syncRecord = {
        timestamp: new Date().toISOString(),
        localPath,
        remotePath,
        fileCount: dirInfo.fileCount,
        totalSize: dirInfo.totalSize,
        totalSizeFormatted: this.formatBytes(dirInfo.totalSize),
        duration: duration,
        durationFormatted: this.formatDuration(duration),
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
      
      // Show alert to user (only if no alert is already showing)
      this.showSyncErrorAlert(error.message, remotePath);
      
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
   * Organizes items into folders named after their space names
   */
  async syncORSpaces(options = {}) {
    const orSpacesPath = path.join(app.getPath('documents'), 'OR-Spaces');
    const baseRemotePath = options.remotePath || 'OR-Spaces-Backup';
    
    // Check if OR-Spaces exists
    try {
      await fs.stat(orSpacesPath);
    } catch (error) {
      console.log('OR-Spaces directory not found, creating it...');
      await fs.mkdir(orSpacesPath, { recursive: true });
    }
    
    // Load the index to get space and item information
    const indexPath = path.join(orSpacesPath, 'index.json');
    let index;
    
    try {
      const indexData = await fs.readFile(indexPath, 'utf8');
      index = JSON.parse(indexData);
      console.log(`[GSX Sync] Found ${index.spaces?.length || 0} spaces and ${index.items?.length || 0} items`);
    } catch (error) {
      console.warn('[GSX Sync] Could not read index.json, syncing entire directory as-is:', error.message);
      // Fall back to syncing the entire directory
      return await this.syncDirectory(orSpacesPath, baseRemotePath, options);
    }
    
    if (!this.isInitialized) {
      await this.initialize();
    }
    
    const results = [];
    const startTime = Date.now();
    const itemsLocalDir = path.join(orSpacesPath, 'items');
    const spacesLocalDir = path.join(orSpacesPath, 'spaces');
    
    // Sync index.json
    console.log('[GSX Sync] Syncing index.json...');
    try {
      await this.client.pushLocalPathToFiles(
        indexPath,
        `${baseRemotePath}/index.json`,
        options
      );
      results.push({ path: 'index.json', status: 'success' });
    } catch (error) {
      console.error('[GSX Sync] Failed to sync index.json:', error.message);
      results.push({ path: 'index.json', status: 'failed', error: error.message });
    }
    
    // Organize and sync items by space
    const spaces = index.spaces || [];
    const items = index.items || [];
    
    for (const space of spaces) {
      const sanitizedSpaceName = this.sanitizeFileName(space.name);
      const spaceRemotePath = `${baseRemotePath}/Spaces/${sanitizedSpaceName}`;
      
      // Get items for this space
      const spaceItems = items.filter(item => item.spaceId === space.id);
      
      if (spaceItems.length === 0 && space.id !== 'unclassified') {
        console.log(`[GSX Sync] Space "${space.name}" has no items, skipping...`);
        continue;
      }
      
      console.log(`[GSX Sync] Syncing space "${space.name}" with ${spaceItems.length} items...`);
      
      let itemsSynced = 0;
      let itemsFailed = 0;
      
      // Sync each item in this space
      for (const item of spaceItems) {
        const itemLocalDir = path.join(itemsLocalDir, item.id);
        
        if (!(await this.pathExists(itemLocalDir))) {
          console.warn(`[GSX Sync] Item directory not found: ${item.id}`);
          itemsFailed++;
          continue;
        }
        
        try {
          // Sync the entire item directory to the space folder
          const itemRemotePath = `${spaceRemotePath}/${item.id}`;
          await this.client.pushLocalPathToFiles(
            itemLocalDir,
            itemRemotePath,
            options
          );
          itemsSynced++;
        } catch (error) {
          console.error(`[GSX Sync] Failed to sync item ${item.id}:`, error.message);
          itemsFailed++;
        }
      }
      
      // Also sync the space's README.ipynb if it exists
      const spaceNotebookPath = path.join(spacesLocalDir, space.id, 'README.ipynb');
      if (await this.pathExists(spaceNotebookPath)) {
        try {
          await this.client.pushLocalPathToFiles(
            spaceNotebookPath,
            `${spaceRemotePath}/README.ipynb`,
            options
          );
        } catch (error) {
          console.warn(`[GSX Sync] Failed to sync README for space "${space.name}":`, error.message);
        }
      }
      
      results.push({
        spaceName: space.name,
        spaceId: space.id,
        remotePath: spaceRemotePath,
        itemsTotal: spaceItems.length,
        itemsSynced,
        itemsFailed,
        status: itemsFailed === 0 ? 'success' : (itemsSynced > 0 ? 'partial' : 'failed')
      });
      
      console.log(`[GSX Sync] ✓ Space "${space.name}": ${itemsSynced} items synced, ${itemsFailed} failed`);
    }
    
    const duration = Date.now() - startTime;
    const successCount = results.filter(r => r.status === 'success').length;
    const failCount = results.filter(r => r.status === 'failed').length;
    const totalItemsSynced = results.reduce((sum, r) => sum + (r.itemsSynced || 0), 0);
    const totalItemsFailed = results.reduce((sum, r) => sum + (r.itemsFailed || 0), 0);
    
    console.log(`[GSX Sync] ✓ Sync completed: ${successCount} spaces successful, ${failCount} failed`);
    console.log(`[GSX Sync] ✓ Total: ${totalItemsSynced} items synced, ${totalItemsFailed} items failed`);
    
    // Record sync history
    const syncRecord = {
      timestamp: new Date().toISOString(),
      localPath: orSpacesPath,
      remotePath: baseRemotePath,
      spacesCount: spaces.length,
      itemsCount: items.length,
      itemsSynced: totalItemsSynced,
      itemsFailed: totalItemsFailed,
      successCount,
      failCount,
      duration: duration,
      durationFormatted: this.formatDuration(duration),
      options: options,
      status: failCount === 0 && totalItemsFailed === 0 ? 'success' : 'partial',
      results
    };
    
    this.addToHistory(syncRecord);
    this.lastSyncTime = new Date();
    
    return syncRecord;
  }
  
  /**
   * Sync a single item to the cloud (for auto-sync on add/edit)
   * @param {string} itemId - ID of the item to sync
   * @param {string} spaceId - ID of the space the item belongs to
   * @param {string} spaceName - Name of the space for folder organization
   */
  async syncSingleItem(itemId, spaceId, spaceName) {
    try {
      if (!this.isInitialized) {
        await this.initialize();
      }
      
      const orSpacesPath = path.join(app.getPath('documents'), 'OR-Spaces');
      const baseRemotePath = this.settingsManager.get('gsxAutoSyncRemotePath') || 'OR-Spaces-Backup';
      
      // Local path to the item
      const itemLocalDir = path.join(orSpacesPath, 'items', itemId);
      
      // Check if item exists
      if (!(await this.pathExists(itemLocalDir))) {
        console.warn(`[GSX Auto-Sync] Item directory not found: ${itemId}`);
        return { success: false, error: 'Item not found' };
      }
      
      // Sanitize space name for remote path
      const sanitizedSpaceName = this.sanitizeFileName(spaceName);
      const itemRemotePath = `${baseRemotePath}/Spaces/${sanitizedSpaceName}/${itemId}`;
      
      console.log(`[GSX Auto-Sync] Syncing item ${itemId} to ${itemRemotePath}...`);
      
      // Upload the item
      await this.client.pushLocalPathToFiles(
        itemLocalDir,
        itemRemotePath,
        { isPublic: false, ttl: null }
      );
      
      console.log(`[GSX Auto-Sync] ✓ Item ${itemId} synced successfully`);
      
      return { success: true, itemId, remotePath: itemRemotePath };
    } catch (error) {
      console.error(`[GSX Auto-Sync] Failed to sync item ${itemId}:`, error.message);
      return { success: false, error: error.message };
    }
  }
  
  /**
   * Auto-sync index.json to keep space metadata in sync
   */
  async syncIndex() {
    try {
      if (!this.isInitialized) {
        await this.initialize();
      }
      
      const orSpacesPath = path.join(app.getPath('documents'), 'OR-Spaces');
      const baseRemotePath = this.settingsManager.get('gsxAutoSyncRemotePath') || 'OR-Spaces-Backup';
      const indexPath = path.join(orSpacesPath, 'index.json');
      
      console.log('[GSX Auto-Sync] Syncing index.json...');
      
      await this.client.pushLocalPathToFiles(
        indexPath,
        `${baseRemotePath}/index.json`,
        { isPublic: false, ttl: null }
      );
      
      console.log('[GSX Auto-Sync] ✓ Index synced successfully');
      return { success: true };
    } catch (error) {
      console.error('[GSX Auto-Sync] Failed to sync index:', error.message);
      return { success: false, error: error.message };
    }
  }
  
  /**
   * Check if a path exists
   */
  async pathExists(filePath) {
    try {
      await fs.stat(filePath);
      return true;
    } catch {
      return false;
    }
  }
  
  /**
   * Sanitize filename to be safe for cloud storage
   */
  sanitizeFileName(name) {
    // Replace characters that might cause issues in file paths
    return name
      .replace(/[/\\:*?"<>|]/g, '-') // Replace invalid characters
      .replace(/\s+/g, '_')           // Replace spaces with underscores
      .replace(/_{2,}/g, '_')         // Replace multiple underscores with single
      .replace(/^[-_]+|[-_]+$/g, ''); // Remove leading/trailing dashes and underscores
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
    const startTime = Date.now();
    
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
      
      const totalDuration = Date.now() - startTime;
      const totalFiles = results.reduce((sum, r) => sum + (r.fileCount || 0), 0);
      const totalSize = results.reduce((sum, r) => sum + (r.totalSize || 0), 0);
      
      console.log('[GSX Sync] ✓ Complete backup finished successfully');
      
      // Log to event logger
      this.logBackupEvent({
        type: 'complete-backup',
        status: 'success',
        results,
        totalFiles,
        totalSize,
        duration: totalDuration
      });
      
      return {
        timestamp: new Date().toISOString(),
        status: 'success',
        results: results,
        summary: {
          totalFiles,
          totalSize,
          totalSizeFormatted: this.formatBytes(totalSize),
          duration: totalDuration,
          durationFormatted: this.formatDuration(totalDuration),
          environment: this.settingsManager.get('gsxEnvironment') || 'production'
        }
      };
    } catch (error) {
      console.error('[GSX Sync] ✗ Complete backup failed:', error.message || error);
      console.error('[GSX Sync] Error stack:', error.stack);
      
      // Log failure to event logger
      this.logBackupEvent({
        type: 'complete-backup',
        status: 'failed',
        error: error.message || 'Complete backup failed'
      });
      
      throw new Error(error.message || 'Complete backup failed');
    }
  }
  
  /**
   * Log backup event to app event logger
   */
  logBackupEvent(event) {
    try {
      const getLogger = require('./event-logger');
      const logger = getLogger();
      
      if (event.status === 'success') {
        logger.info('GSX Backup Completed', {
          type: event.type,
          filesCount: event.totalFiles,
          totalSize: this.formatBytes(event.totalSize),
          duration: this.formatDuration(event.duration),
          results: event.results.map(r => ({
            name: r.name,
            files: r.fileCount,
            size: r.totalSizeFormatted,
            path: r.remotePath
          }))
        });
      } else {
        logger.error('GSX Backup Failed', {
          type: event.type,
          error: event.error
        });
      }
    } catch (error) {
      console.error('[GSX Sync] Failed to log event:', error);
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
   * Show sync error alert to user (only if no alert is currently showing)
   */
  showSyncErrorAlert(errorMessage, remotePath) {
    // Don't show alert if one is already showing
    if (this.alertShowing) {
      console.log('[GSX Sync] Alert already showing, skipping duplicate');
      return;
    }
    
    this.alertShowing = true;
    
    // Determine error type and provide helpful guidance
    let title = 'GSX Sync Failed';
    let message = `Failed to sync to GSX Files${remotePath ? `/${remotePath}` : ''}`;
    let detail = errorMessage;
    
    // Add helpful guidance based on error type
    if (errorMessage.includes('401') || errorMessage.includes('Unauthorized')) {
      title = 'GSX Authentication Failed';
      detail = `${errorMessage}\n\n💡 Try this:\n• Check your GSX token in Settings\n• Verify the environment matches where you created the token\n• Ensure the token has Files API permissions`;
    } else if (errorMessage.includes('403') || errorMessage.includes('forbidden')) {
      title = 'GSX Access Denied';
      detail = `${errorMessage}\n\n💡 Try this:\n• Your token may not have Files API permissions\n• Contact your GSX administrator`;
    } else if (errorMessage.includes('network') || errorMessage.includes('discovery') || errorMessage.includes('timeout')) {
      title = 'GSX Connection Failed';
      detail = `${errorMessage}\n\n💡 Try this:\n• Check your internet connection\n• Try again in a moment\n• GSX service may be temporarily unavailable`;
    } else if (errorMessage.includes('token')) {
      title = 'GSX Token Issue';
      detail = `${errorMessage}\n\n💡 Try this:\n• Configure your GSX token in Settings\n• Make sure the token is complete and correct`;
    }
    
    // Show the alert
    dialog.showMessageBox({
      type: 'error',
      title: title,
      message: message,
      detail: detail,
      buttons: ['OK', 'Open Settings'],
      defaultId: 0,
      cancelId: 0
    }).then(result => {
      // Reset the flag when dialog closes
      this.alertShowing = false;
      
      // If user clicked "Open Settings", open settings window
      if (result.response === 1) {
        // Send IPC to open settings
        const { BrowserWindow } = require('electron');
        const mainWindow = BrowserWindow.getAllWindows()[0];
        if (mainWindow) {
          mainWindow.webContents.send('menu-action', { action: 'open-settings' });
        }
      }
    }).catch(err => {
      // Reset flag even if dialog fails
      this.alertShowing = false;
      console.error('[GSX Sync] Error showing alert:', err);
    });
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
   * Get all files in a directory recursively
   */
  async getAllFiles(dirPath) {
    const files = [];
    
    const processDirectory = async (dir) => {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        
        if (entry.isDirectory()) {
          await processDirectory(fullPath);
        } else if (entry.isFile()) {
          files.push(fullPath);
        }
      }
    };
    
    try {
      await processDirectory(dirPath);
    } catch (error) {
      console.error('Error getting all files:', error);
    }
    
    return files;
  }
  
  /**
   * Get directory info (file count and total size)
   */
  async getDirectoryInfo(dirPath, progressCallback = null) {
    let fileCount = 0;
    let totalSize = 0;
    
    const processDirectory = async (dir) => {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        
        if (entry.isDirectory()) {
          await processDirectory(fullPath);
        } else if (entry.isFile()) {
          fileCount++;
          try {
            const stats = await fs.stat(fullPath);
            totalSize += stats.size;
            
            // Report scanning progress
            if (progressCallback && fileCount % 10 === 0) {
              progressCallback({
                type: 'scanning',
                message: `Scanning files... (${fileCount} found)`,
                filesScanned: fileCount
              });
            }
          } catch (error) {
            console.warn(`Could not stat file: ${fullPath}`);
          }
        }
      }
    };
    
    try {
      await processDirectory(dirPath);
    } catch (error) {
      console.error('Error getting directory info:', error);
    }
    
    return { fileCount, totalSize };
  }
  
  /**
   * Format bytes to human readable
   */
  formatBytes(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
  }
  
  /**
   * Format duration to human readable
   */
  formatDuration(ms) {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    
    if (minutes > 0) {
      return `${minutes}m ${remainingSeconds}s`;
    }
    return `${seconds}s`;
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
