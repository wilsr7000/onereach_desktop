/**
 * Menu Data Manager - Hardened, Resilient Single Source of Truth
 * 
 * This module provides:
 * - Single authoritative source for all menu-related data
 * - Atomic file operations with backup/restore
 * - Debounced menu updates to prevent rapid rebuilds
 * - Event-driven architecture for decoupled updates
 * - Data validation and sanitization
 * - Graceful degradation on errors
 * - Automatic recovery from corrupted data
 */

const { app, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');

// Debounce helper
function debounce(fn, delay) {
  let timeoutId;
  return function (...args) {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => fn.apply(this, args), delay);
  };
}

class MenuDataManager extends EventEmitter {
  constructor() {
    super();
    
    // State
    this._initialized = false;
    this._userDataPath = null;
    this._cache = {
      idwEnvironments: [],
      externalBots: [],
      imageCreators: [],
      videoCreators: [],
      audioGenerators: [],
      uiDesignTools: [],
      gsxLinks: []
    };
    
    // File paths (initialized lazily)
    this._paths = null;
    
    // Debounced menu refresh (100ms)
    this._debouncedRefresh = debounce(() => this._triggerMenuRefresh(), 100);
    
    // Track pending writes for atomic operations
    this._writeQueue = new Map();
    this._isWriting = false;
    
    // Bind methods
    this.initialize = this.initialize.bind(this);
    this.getIDWEnvironments = this.getIDWEnvironments.bind(this);
    this.setIDWEnvironments = this.setIDWEnvironments.bind(this);
  }

  /**
   * Get file paths - lazy initialization after app is ready
   */
  get paths() {
    if (!this._paths && this._userDataPath) {
      this._paths = {
        idwEnvironments: path.join(this._userDataPath, 'idw-entries.json'),
        externalBots: path.join(this._userDataPath, 'external-bots.json'),
        imageCreators: path.join(this._userDataPath, 'image-creators.json'),
        videoCreators: path.join(this._userDataPath, 'video-creators.json'),
        audioGenerators: path.join(this._userDataPath, 'audio-generators.json'),
        uiDesignTools: path.join(this._userDataPath, 'ui-design-tools.json'),
        gsxLinks: path.join(this._userDataPath, 'gsx-links.json')
      };
    }
    return this._paths;
  }

  /**
   * Initialize the manager - must be called after app.whenReady()
   */
  initialize() {
    if (this._initialized) {
      console.log('[MenuDataManager] Already initialized');
      return;
    }

    try {
      this._userDataPath = app.getPath('userData');
      console.log('[MenuDataManager] Initializing with userData:', this._userDataPath);
      
      // Load all data from files
      this._loadAllData();
      
      // Register IPC handlers
      this._registerIPCHandlers();
      
      this._initialized = true;
      console.log('[MenuDataManager] ✅ Initialized successfully');
      
      // Emit ready event
      this.emit('ready', this.getAllData());
      
    } catch (error) {
      console.error('[MenuDataManager] ❌ Initialization failed:', error);
      // Continue with empty data - graceful degradation
      this._initialized = true;
      this.emit('ready', this.getAllData());
    }
  }

  /**
   * Check if manager is initialized
   */
  isInitialized() {
    return this._initialized;
  }

  // ============================================
  // DATA ACCESS METHODS
  // ============================================

  /**
   * Get all menu data
   */
  getAllData() {
    return { ...this._cache };
  }

  /**
   * Get IDW environments
   */
  getIDWEnvironments() {
    return [...this._cache.idwEnvironments];
  }

  /**
   * Set IDW environments with validation and atomic save
   */
  async setIDWEnvironments(environments, options = {}) {
    const { skipRefresh = false, source = 'unknown' } = options;
    
    console.log(`[MenuDataManager] setIDWEnvironments called from ${source} with ${environments?.length || 0} items`);
    
    // Validate input
    const validated = this._validateIDWEnvironments(environments);
    
    if (!validated.valid) {
      console.error('[MenuDataManager] Validation failed:', validated.errors);
      return { success: false, errors: validated.errors };
    }
    
    // Update cache
    this._cache.idwEnvironments = validated.data;
    
    // Atomic save to file
    const saveResult = await this._atomicSave('idwEnvironments', validated.data);
    
    if (!saveResult.success) {
      console.error('[MenuDataManager] Save failed:', saveResult.error);
      return { success: false, error: saveResult.error };
    }
    
    // Sync to settings manager if available
    this._syncToSettingsManager('idwEnvironments', validated.data);
    
    // Trigger menu refresh (debounced)
    if (!skipRefresh) {
      this._debouncedRefresh();
    }
    
    // Emit change event
    this.emit('idwEnvironments:changed', validated.data);
    
    return { success: true, data: validated.data };
  }

  /**
   * Get external bots
   */
  getExternalBots() {
    return [...this._cache.externalBots];
  }

  /**
   * Set external bots
   */
  async setExternalBots(bots, options = {}) {
    const { skipRefresh = false } = options;
    
    const validated = this._validateArray(bots, 'externalBots');
    this._cache.externalBots = validated;
    
    await this._atomicSave('externalBots', validated);
    
    if (!skipRefresh) {
      this._debouncedRefresh();
    }
    
    this.emit('externalBots:changed', validated);
    return { success: true, data: validated };
  }

  /**
   * Get image creators
   */
  getImageCreators() {
    return [...this._cache.imageCreators];
  }

  /**
   * Set image creators
   */
  async setImageCreators(creators, options = {}) {
    const { skipRefresh = false } = options;
    
    const validated = this._validateArray(creators, 'imageCreators');
    this._cache.imageCreators = validated;
    
    await this._atomicSave('imageCreators', validated);
    
    if (!skipRefresh) {
      this._debouncedRefresh();
    }
    
    this.emit('imageCreators:changed', validated);
    return { success: true, data: validated };
  }

  /**
   * Get video creators
   */
  getVideoCreators() {
    return [...this._cache.videoCreators];
  }

  /**
   * Set video creators
   */
  async setVideoCreators(creators, options = {}) {
    const { skipRefresh = false } = options;
    
    const validated = this._validateArray(creators, 'videoCreators');
    this._cache.videoCreators = validated;
    
    await this._atomicSave('videoCreators', validated);
    
    if (!skipRefresh) {
      this._debouncedRefresh();
    }
    
    this.emit('videoCreators:changed', validated);
    return { success: true, data: validated };
  }

  /**
   * Get audio generators
   */
  getAudioGenerators() {
    return [...this._cache.audioGenerators];
  }

  /**
   * Set audio generators
   */
  async setAudioGenerators(generators, options = {}) {
    const { skipRefresh = false } = options;
    
    const validated = this._validateArray(generators, 'audioGenerators');
    this._cache.audioGenerators = validated;
    
    await this._atomicSave('audioGenerators', validated);
    
    if (!skipRefresh) {
      this._debouncedRefresh();
    }
    
    this.emit('audioGenerators:changed', validated);
    return { success: true, data: validated };
  }

  /**
   * Get UI design tools
   */
  getUIDesignTools() {
    return [...this._cache.uiDesignTools];
  }

  /**
   * Set UI design tools
   */
  async setUIDesignTools(tools, options = {}) {
    const { skipRefresh = false } = options;
    
    const validated = this._validateArray(tools, 'uiDesignTools');
    this._cache.uiDesignTools = validated;
    
    await this._atomicSave('uiDesignTools', validated);
    
    if (!skipRefresh) {
      this._debouncedRefresh();
    }
    
    this.emit('uiDesignTools:changed', validated);
    return { success: true, data: validated };
  }

  /**
   * Get GSX links
   */
  getGSXLinks() {
    return [...this._cache.gsxLinks];
  }

  /**
   * Set GSX links
   */
  async setGSXLinks(links, options = {}) {
    const { skipRefresh = false } = options;
    
    const validated = this._validateArray(links, 'gsxLinks');
    this._cache.gsxLinks = validated;
    
    await this._atomicSave('gsxLinks', validated);
    
    if (!skipRefresh) {
      this._debouncedRefresh();
    }
    
    this.emit('gsxLinks:changed', validated);
    return { success: true, data: validated };
  }

  // ============================================
  // CRUD OPERATIONS FOR INDIVIDUAL ITEMS
  // ============================================

  /**
   * Add an IDW environment
   */
  async addIDWEnvironment(env) {
    const environments = this.getIDWEnvironments();
    
    // Check for duplicate
    const existing = environments.find(e => e.id === env.id);
    if (existing) {
      console.log(`[MenuDataManager] IDW ${env.id} already exists, updating instead`);
      return this.updateIDWEnvironment(env.id, env);
    }
    
    // Add timestamp
    env.createdAt = env.createdAt || new Date().toISOString();
    env.updatedAt = new Date().toISOString();
    
    environments.push(env);
    return this.setIDWEnvironments(environments, { source: 'addIDWEnvironment' });
  }

  /**
   * Update an IDW environment
   */
  async updateIDWEnvironment(id, updates) {
    const environments = this.getIDWEnvironments();
    const index = environments.findIndex(e => e.id === id);
    
    if (index === -1) {
      return { success: false, error: `IDW ${id} not found` };
    }
    
    environments[index] = {
      ...environments[index],
      ...updates,
      id, // Preserve original ID
      updatedAt: new Date().toISOString()
    };
    
    return this.setIDWEnvironments(environments, { source: 'updateIDWEnvironment' });
  }

  /**
   * Remove an IDW environment
   */
  async removeIDWEnvironment(id) {
    const environments = this.getIDWEnvironments();
    const filtered = environments.filter(e => e.id !== id);
    
    if (filtered.length === environments.length) {
      return { success: false, error: `IDW ${id} not found` };
    }
    
    return this.setIDWEnvironments(filtered, { source: 'removeIDWEnvironment' });
  }

  // ============================================
  // INTERNAL METHODS
  // ============================================

  /**
   * Load all data from files
   */
  _loadAllData() {
    console.log('[MenuDataManager] Loading all data from files...');
    
    const dataTypes = [
      'idwEnvironments',
      'externalBots', 
      'imageCreators',
      'videoCreators',
      'audioGenerators',
      'uiDesignTools',
      'gsxLinks'
    ];
    
    for (const dataType of dataTypes) {
      this._cache[dataType] = this._loadFromFile(dataType);
    }
    
    console.log('[MenuDataManager] Data loaded:', {
      idwEnvironments: this._cache.idwEnvironments.length,
      externalBots: this._cache.externalBots.length,
      imageCreators: this._cache.imageCreators.length,
      videoCreators: this._cache.videoCreators.length,
      audioGenerators: this._cache.audioGenerators.length,
      uiDesignTools: this._cache.uiDesignTools.length,
      gsxLinks: this._cache.gsxLinks.length
    });
  }

  /**
   * Load data from a file with error recovery
   */
  _loadFromFile(dataType) {
    const filePath = this.paths?.[dataType];
    if (!filePath) return [];
    
    try {
      if (fs.existsSync(filePath)) {
        const data = fs.readFileSync(filePath, 'utf8');
        const parsed = JSON.parse(data);
        
        if (!Array.isArray(parsed)) {
          console.warn(`[MenuDataManager] ${dataType} is not an array, using empty`);
          return [];
        }
        
        return parsed;
      }
    } catch (error) {
      console.error(`[MenuDataManager] Error loading ${dataType}:`, error.message);
      
      // Try to recover from backup
      const recovered = this._tryRecoverFromBackup(filePath);
      if (recovered) {
        console.log(`[MenuDataManager] Recovered ${dataType} from backup`);
        return recovered;
      }
    }
    
    return [];
  }

  /**
   * Try to recover data from backup file
   */
  _tryRecoverFromBackup(filePath) {
    const backupPath = filePath + '.backup';
    
    try {
      if (fs.existsSync(backupPath)) {
        const data = fs.readFileSync(backupPath, 'utf8');
        const parsed = JSON.parse(data);
        
        if (Array.isArray(parsed)) {
          // Restore the backup to main file
          fs.writeFileSync(filePath, data, 'utf8');
          console.log(`[MenuDataManager] Restored ${filePath} from backup`);
          return parsed;
        }
      }
    } catch (error) {
      console.error(`[MenuDataManager] Backup recovery failed:`, error.message);
    }
    
    return null;
  }

  /**
   * Atomic save with backup
   */
  async _atomicSave(dataType, data) {
    const filePath = this.paths?.[dataType];
    if (!filePath) {
      return { success: false, error: 'Path not initialized' };
    }
    
    const tempPath = filePath + '.tmp';
    const backupPath = filePath + '.backup';
    
    try {
      const jsonData = JSON.stringify(data, null, 2);
      
      // 1. Write to temp file first
      fs.writeFileSync(tempPath, jsonData, 'utf8');
      
      // 2. Verify temp file is valid JSON
      const verify = JSON.parse(fs.readFileSync(tempPath, 'utf8'));
      if (!Array.isArray(verify)) {
        throw new Error('Written data is not a valid array');
      }
      
      // 3. Backup existing file (if exists)
      if (fs.existsSync(filePath)) {
        fs.copyFileSync(filePath, backupPath);
      }
      
      // 4. Rename temp to target (atomic on most filesystems)
      fs.renameSync(tempPath, filePath);
      
      console.log(`[MenuDataManager] ✅ Saved ${dataType}: ${data.length} items`);
      return { success: true };
      
    } catch (error) {
      console.error(`[MenuDataManager] ❌ Save failed for ${dataType}:`, error.message);
      
      // Clean up temp file
      try {
        if (fs.existsSync(tempPath)) {
          fs.unlinkSync(tempPath);
        }
      } catch (e) {
        // Ignore cleanup errors
      }
      
      return { success: false, error: error.message };
    }
  }

  /**
   * Validate IDW environments array
   */
  _validateIDWEnvironments(environments) {
    const errors = [];
    
    if (!Array.isArray(environments)) {
      return { valid: false, errors: ['Input must be an array'], data: [] };
    }
    
    const validated = environments.map((env, index) => {
      // Ensure required fields
      if (!env.id && env.label) {
        env.id = this._generateId(env.label, env.environment);
      }
      
      if (!env.id) {
        errors.push(`Item ${index}: missing id`);
        return null;
      }
      
      if (!env.label) {
        env.label = env.id; // Fallback
      }
      
      // Sanitize URLs
      if (env.homeUrl) {
        env.homeUrl = this._sanitizeUrl(env.homeUrl);
      }
      if (env.chatUrl) {
        env.chatUrl = this._sanitizeUrl(env.chatUrl);
      }
      
      // Ensure type
      env.type = env.type || 'idw';
      
      return env;
    }).filter(Boolean);
    
    return {
      valid: errors.length === 0,
      errors,
      data: validated
    };
  }

  /**
   * Validate a generic array
   */
  _validateArray(data, dataType) {
    if (!Array.isArray(data)) {
      console.warn(`[MenuDataManager] ${dataType} is not an array, using empty`);
      return [];
    }
    return data.filter(item => item && typeof item === 'object');
  }

  /**
   * Generate a safe ID from label and environment
   */
  _generateId(label, environment) {
    const base = `${label || 'unknown'}-${environment || 'default'}`;
    return base.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-');
  }

  /**
   * Sanitize URL
   */
  _sanitizeUrl(url) {
    if (!url || typeof url !== 'string') return '';
    
    url = url.trim();
    
    // Remove invalid prefixes
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      const httpsIndex = url.indexOf('https://');
      const httpIndex = url.indexOf('http://');
      
      if (httpsIndex > 0) {
        url = url.substring(httpsIndex);
      } else if (httpIndex > 0) {
        url = url.substring(httpIndex);
      }
    }
    
    return url;
  }

  /**
   * Sync data to settings manager
   */
  _syncToSettingsManager(dataType, data) {
    try {
      if (global.settingsManager && typeof global.settingsManager.set === 'function') {
        global.settingsManager.set(dataType, data);
        console.log(`[MenuDataManager] Synced ${dataType} to settingsManager`);
      }
    } catch (error) {
      console.error(`[MenuDataManager] Settings sync failed:`, error.message);
      // Non-fatal - continue anyway
    }
  }

  /**
   * Trigger menu refresh
   */
  _triggerMenuRefresh() {
    console.log('[MenuDataManager] Triggering menu refresh...');
    
    try {
      const { setApplicationMenu, invalidateMenuCache } = require('./menu');
      
      // Invalidate menu cache
      if (typeof invalidateMenuCache === 'function') {
        invalidateMenuCache();
      }
      
      // Rebuild menu with current data
      setApplicationMenu(this._cache.idwEnvironments);
      
      this.emit('menu:refreshed');
      console.log('[MenuDataManager] ✅ Menu refreshed');
      
    } catch (error) {
      console.error('[MenuDataManager] ❌ Menu refresh failed:', error.message);
      this.emit('menu:refreshError', error);
    }
  }

  /**
   * Force immediate menu refresh (bypasses debounce)
   */
  forceRefresh() {
    this._triggerMenuRefresh();
  }

  /**
   * Register IPC handlers
   */
  _registerIPCHandlers() {
    console.log('[MenuDataManager] Registering IPC handlers...');
    
    // Get IDW environments
    ipcMain.handle('menu-data:get-idw-environments', () => {
      return this.getIDWEnvironments();
    });
    
    // Set IDW environments
    ipcMain.handle('menu-data:set-idw-environments', async (event, environments) => {
      return this.setIDWEnvironments(environments, { source: 'ipc' });
    });
    
    // Add IDW environment
    ipcMain.handle('menu-data:add-idw-environment', async (event, env) => {
      return this.addIDWEnvironment(env);
    });
    
    // Update IDW environment
    ipcMain.handle('menu-data:update-idw-environment', async (event, id, updates) => {
      return this.updateIDWEnvironment(id, updates);
    });
    
    // Remove IDW environment
    ipcMain.handle('menu-data:remove-idw-environment', async (event, id) => {
      return this.removeIDWEnvironment(id);
    });
    
    // Get all data
    ipcMain.handle('menu-data:get-all', () => {
      return this.getAllData();
    });
    
    // Force refresh
    ipcMain.on('menu-data:force-refresh', () => {
      this.forceRefresh();
    });
    
    // Legacy support: redirect old IPC channels
    this._registerLegacyHandlers();
    
    console.log('[MenuDataManager] ✅ IPC handlers registered');
  }

  /**
   * Register legacy IPC handlers for backward compatibility
   */
  _registerLegacyHandlers() {
    // Legacy get-idw-environments
    ipcMain.on('get-idw-environments', (event) => {
      console.log('[MenuDataManager] Legacy get-idw-environments called');
      event.reply('get-idw-environments', this.getIDWEnvironments());
    });
    
    // Legacy get-external-bots
    ipcMain.on('get-external-bots', (event) => {
      event.reply('get-external-bots', this.getExternalBots());
    });
    
    // Legacy get-image-creators
    ipcMain.on('get-image-creators', (event) => {
      event.reply('get-image-creators', this.getImageCreators());
    });
    
    // Legacy get-video-creators
    ipcMain.on('get-video-creators', (event) => {
      event.reply('get-video-creators', this.getVideoCreators());
    });
    
    // Legacy get-audio-generators
    ipcMain.on('get-audio-generators', (event) => {
      event.reply('get-audio-generators', this.getAudioGenerators());
    });
    
    // Legacy get-ui-design-tools
    ipcMain.on('get-ui-design-tools', (event) => {
      event.reply('get-ui-design-tools', this.getUIDesignTools());
    });
    
    // Legacy refresh-menu - SINGLE handler to replace duplicates
    ipcMain.on('refresh-menu', () => {
      console.log('[MenuDataManager] Legacy refresh-menu called');
      this.forceRefresh();
    });
    
    // Legacy save handlers
    ipcMain.on('save-idw-environments', async (event, environments) => {
      console.log('[MenuDataManager] Legacy save-idw-environments called');
      const result = await this.setIDWEnvironments(environments, { source: 'legacy-save' });
      event.reply('idw-environments-saved', result);
    });
  }

  /**
   * Get debug info
   */
  getDebugInfo() {
    return {
      initialized: this._initialized,
      userDataPath: this._userDataPath,
      paths: this.paths,
      cache: {
        idwEnvironments: this._cache.idwEnvironments.length,
        externalBots: this._cache.externalBots.length,
        imageCreators: this._cache.imageCreators.length,
        videoCreators: this._cache.videoCreators.length,
        audioGenerators: this._cache.audioGenerators.length,
        uiDesignTools: this._cache.uiDesignTools.length,
        gsxLinks: this._cache.gsxLinks.length
      }
    };
  }
}

// Singleton instance
let instance = null;

/**
 * Get the singleton MenuDataManager instance
 */
function getMenuDataManager() {
  if (!instance) {
    instance = new MenuDataManager();
  }
  return instance;
}

module.exports = {
  MenuDataManager,
  getMenuDataManager
};










