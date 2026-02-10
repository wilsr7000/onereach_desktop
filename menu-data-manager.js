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
const { getLogQueue } = require('./lib/log-event-queue');
const log = getLogQueue();

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
      log.info('menu', 'Already initialized')
      return;
    }

    try {
    this._userDataPath = app.getPath('userData');
      log.info('menu', 'Initializing with userData', { _userDataPath: this._userDataPath })
      
      // Load all data from files
      this._loadAllData();
      
      // Register IPC handlers
      this._registerIPCHandlers();
      
      this._initialized = true;
      log.info('menu', '✅ Initialized successfully')
      
      // Emit ready event
      this.emit('ready', this.getAllData());
      
    } catch (error) {
      log.error('menu', 'Initialization failed', { error: error.message || error })
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
    
    log.info('menu', 'setIDWEnvironments called from ... with ... items', { source, detail: environments?.length || 0 })
    
    // Validate input
    const validated = this._validateIDWEnvironments(environments);
    
    if (!validated.valid) {
      log.error('menu', 'Validation failed', { errors: validated.errors })
      return { success: false, errors: validated.errors };
    }
    
    // Update cache
    this._cache.idwEnvironments = validated.data;
    
    // Atomic save to file
    const saveResult = await this._atomicSave('idwEnvironments', validated.data);
    
    if (!saveResult.success) {
      log.error('menu', 'Save failed', { error: saveResult.error })
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
    log.info('menu', 'setExternalBots: ... bots, skipRefresh=...', { detail: (bots || []).length, skipRefresh })
    
    const validated = this._validateArray(bots, 'externalBots');
    this._cache.externalBots = validated;
    
    await this._atomicSave('externalBots', validated);
    
    if (!skipRefresh) {
      this._debouncedRefresh();
    }
    
    this.emit('externalBots:changed', validated);
    log.info('menu', 'setExternalBots complete: ... saved', { validatedCount: validated.length })
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
    log.info('menu', 'setImageCreators: ... creators, skipRefresh=...', { detail: (creators || []).length, skipRefresh })
    
    const validated = this._validateArray(creators, 'imageCreators');
    this._cache.imageCreators = validated;
    
    await this._atomicSave('imageCreators', validated);
    
    if (!skipRefresh) {
      this._debouncedRefresh();
    }
    
    this.emit('imageCreators:changed', validated);
    log.info('menu', 'setImageCreators complete: ... saved', { validatedCount: validated.length })
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
    log.info('menu', 'setVideoCreators: ... creators, skipRefresh=...', { detail: (creators || []).length, skipRefresh })
    
    const validated = this._validateArray(creators, 'videoCreators');
    this._cache.videoCreators = validated;
    
    await this._atomicSave('videoCreators', validated);
    
    if (!skipRefresh) {
      this._debouncedRefresh();
    }
    
    this.emit('videoCreators:changed', validated);
    log.info('menu', 'setVideoCreators complete: ... saved', { validatedCount: validated.length })
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
    log.info('menu', 'setAudioGenerators: ... generators, skipRefresh=...', { detail: (generators || []).length, skipRefresh })
    
    const validated = this._validateArray(generators, 'audioGenerators');
    this._cache.audioGenerators = validated;
    
    await this._atomicSave('audioGenerators', validated);
    
    if (!skipRefresh) {
      this._debouncedRefresh();
    }
    
    this.emit('audioGenerators:changed', validated);
    log.info('menu', 'setAudioGenerators complete: ... saved', { validatedCount: validated.length })
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
    log.info('menu', 'setUIDesignTools: ... tools, skipRefresh=...', { detail: (tools || []).length, skipRefresh })
    
    const validated = this._validateArray(tools, 'uiDesignTools');
    this._cache.uiDesignTools = validated;
    
    await this._atomicSave('uiDesignTools', validated);
    
    if (!skipRefresh) {
      this._debouncedRefresh();
    }
    
    this.emit('uiDesignTools:changed', validated);
    log.info('menu', 'setUIDesignTools complete: ... saved', { validatedCount: validated.length })
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
    log.info('menu', 'setGSXLinks: ... links, skipRefresh=...', { detail: (links || []).length, skipRefresh })
    
    const validated = this._validateArray(links, 'gsxLinks');
    this._cache.gsxLinks = validated;
    
    await this._atomicSave('gsxLinks', validated);
    
    if (!skipRefresh) {
      this._debouncedRefresh();
    }
    
    this.emit('gsxLinks:changed', validated);
    log.info('menu', 'setGSXLinks complete: ... saved', { validatedCount: validated.length })
    return { success: true, data: validated };
  }

  // ============================================
  // CRUD OPERATIONS FOR INDIVIDUAL ITEMS
  // ============================================

  /**
   * Add an IDW environment
   */
  async addIDWEnvironment(env) {
    log.info('menu', 'addIDWEnvironment: "..." (id=...)', { detail: env && env.label, detail: env && env.id })
    const environments = this.getIDWEnvironments();
    
    // Check for duplicate
    const existing = environments.find(e => e.id === env.id);
    if (existing) {
      log.info('menu', 'IDW ... already exists, updating instead', { envId: env.id })
      return this.updateIDWEnvironment(env.id, env);
    }
    
    // Add timestamp
    env.createdAt = env.createdAt || new Date().toISOString();
    env.updatedAt = new Date().toISOString();
    
    environments.push(env);
    log.info('menu', 'addIDWEnvironment: total now ...', { environmentsCount: environments.length })
    return this.setIDWEnvironments(environments, { source: 'addIDWEnvironment' });
  }

  /**
   * Update an IDW environment
   */
  async updateIDWEnvironment(id, updates) {
    log.info('menu', 'updateIDWEnvironment', { id, fields: Object.keys(updates || {}) })
    const environments = this.getIDWEnvironments();
    const index = environments.findIndex(e => e.id === id);
    
    if (index === -1) {
      log.warn('menu', 'updateIDWEnvironment: IDW ... not found', { id })
      return { success: false, error: `IDW ${id} not found` };
    }
    
    environments[index] = {
      ...environments[index],
      ...updates,
      id, // Preserve original ID
      updatedAt: new Date().toISOString()
    };
    
    log.info('menu', 'updateIDWEnvironment: updated "..."', { detail: environments[index].label })
    return this.setIDWEnvironments(environments, { source: 'updateIDWEnvironment' });
  }

  /**
   * Remove an IDW environment
   */
  async removeIDWEnvironment(id) {
    log.info('menu', 'removeIDWEnvironment: id=...', { id })
    const environments = this.getIDWEnvironments();
    const filtered = environments.filter(e => e.id !== id);
    
    if (filtered.length === environments.length) {
      log.warn('menu', 'removeIDWEnvironment: IDW ... not found', { id })
      return { success: false, error: `IDW ${id} not found` };
    }
    
    log.info('menu', 'removeIDWEnvironment: ... -> ...', { environmentsCount: environments.length, filteredCount: filtered.length })
    return this.setIDWEnvironments(filtered, { source: 'removeIDWEnvironment' });
  }

  // ============================================
  // INTERNAL METHODS
  // ============================================

  /**
   * Load all data from files
   */
  _loadAllData() {
    log.info('menu', 'Loading all data from files...')
    
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
    
    log.info('menu', 'Data loaded', { detail: { idwEnvironments: this._cache.idwEnvironments.length,
      externalBots: this._cache.externalBots.length,
      imageCreators: this._cache.imageCreators.length,
      videoCreators: this._cache.videoCreators.length,
      audioGenerators: this._cache.audioGenerators.length,
      uiDesignTools: this._cache.uiDesignTools.length,
      gsxLinks: this._cache.gsxLinks.length
    } })
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
          log.warn('menu', '... is not an array, using empty', { dataType })
          return [];
        }
        
        return parsed;
      }
    } catch (error) {
      log.error('menu', 'Error loading ...', { dataType })
      
      // Try to recover from backup
      const recovered = this._tryRecoverFromBackup(filePath);
      if (recovered) {
        log.info('menu', 'Recovered ... from backup', { dataType })
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
          log.info('menu', 'Restored ... from backup', { filePath })
          return parsed;
        }
      }
    } catch (error) {
      log.error('menu', `[MenuDataManager] Backup recovery failed:`)
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
      
      log.info('menu', '✅ Saved ...: ... items', { dataType, dataCount: data.length })
      return { success: true };
      
    } catch (error) {
      log.error('menu', '❌ Save failed for ...', { dataType })
      
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
      log.warn('menu', '... is not an array, using empty', { dataType })
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
        log.info('menu', 'Synced ... to settingsManager', { dataType })
      }
    } catch (error) {
      log.error('menu', `[MenuDataManager] Settings sync failed:`)
      // Non-fatal - continue anyway
    }
  }

  /**
   * Trigger menu refresh
   */
  _triggerMenuRefresh() {
    const startTime = Date.now();
    const cacheState = {
      idw: this._cache.idwEnvironments.length,
      bots: this._cache.externalBots.length,
      images: this._cache.imageCreators.length,
      video: this._cache.videoCreators.length,
      audio: this._cache.audioGenerators.length,
      ui: this._cache.uiDesignTools.length,
      gsx: this._cache.gsxLinks.length
    };
    log.info('menu', 'Triggering menu refresh...', { detail: JSON.stringify(cacheState) })
    
    try {
      const { setApplicationMenu, invalidateMenuCache } = require('./menu');
      
      // Invalidate menu cache
      if (typeof invalidateMenuCache === 'function') {
        invalidateMenuCache();
        log.info('menu', 'Menu cache invalidated')
      }
      
      // Rebuild menu with current data
      setApplicationMenu(this._cache.idwEnvironments);
      
      this.emit('menu:refreshed');
      log.info('menu', 'Menu refreshed in ...ms', { detail: Date.now() - startTime })
      
    } catch (error) {
      log.error('menu', 'Menu refresh failed after ...ms', { detail: Date.now() - startTime })
      log.error('menu', 'Stack', { stack: error.stack })
      this.emit('menu:refreshError', error);
    }
  }

  /**
   * Force immediate menu refresh (bypasses debounce)
   */
  forceRefresh() {
    log.info('menu', 'forceRefresh() called')
    this._triggerMenuRefresh();
  }

  /**
   * Convenience: Full menu refresh using current cached data.
   * Replaces direct calls to refreshApplicationMenu() from menu.js.
   */
  refresh() {
    log.info('menu', 'refresh() called')
    this._triggerMenuRefresh();
  }

  /**
   * Convenience: Refresh only GSX links from disk, then rebuild menu.
   * Replaces direct calls to refreshGSXLinks() from menu.js.
   */
  refreshGSXLinks() {
    const startTime = Date.now();
    log.info('menu', 'refreshGSXLinks() called')
    try {
      const { refreshGSXLinks: menuRefreshGSXLinks } = require('./menu');
      menuRefreshGSXLinks();
      this.emit('menu:refreshed');
      log.info('menu', 'GSX links refreshed in ...ms', { detail: Date.now() - startTime })
    } catch (error) {
      log.error('menu', 'GSX links refresh failed after ...ms', { detail: Date.now() - startTime })
      log.error('menu', 'Stack', { stack: error.stack })
      this.emit('menu:refreshError', error);
    }
  }

  /**
   * Convenience: Rebuild the application menu with specific IDW environments.
   * Replaces direct calls to setApplicationMenu(envs) from menu.js.
   * @param {Array} idwEnvironments - IDW environment configurations
   */
  rebuild(idwEnvironments) {
    const startTime = Date.now();
    const envCount = (idwEnvironments || []).length;
    const source = idwEnvironments ? 'caller-provided' : 'cached';
    log.info('menu', 'rebuild() called - ... environments (...)', { envCount, source })
    try {
      const { setApplicationMenu, invalidateMenuCache } = require('./menu');
      if (typeof invalidateMenuCache === 'function') {
        invalidateMenuCache();
        log.info('menu', 'Menu cache invalidated for rebuild')
      }
      setApplicationMenu(idwEnvironments || this._cache.idwEnvironments);
      
      // Update cache if environments were provided
      if (idwEnvironments) {
        const prevCount = this._cache.idwEnvironments.length;
        this._cache.idwEnvironments = idwEnvironments;
        if (prevCount !== envCount) {
          log.info('menu', 'Cache updated: IDW environments ... -> ...', { prevCount, envCount })
        }
      }
      
      this.emit('menu:refreshed');
      log.info('menu', 'Menu rebuilt in ...ms with ... environments', { detail: Date.now() - startTime, envCount })
    } catch (error) {
      log.error('menu', 'Menu rebuild failed after ...ms', { detail: Date.now() - startTime })
      log.error('menu', 'Stack', { stack: error.stack })
      this.emit('menu:refreshError', error);
    }
  }

  /**
   * Get all openable menu items for voice/agent access.
   * Proxies to menu.js's getOpenableItems().
   * @returns {Array} Flat list of openable items
   */
  getOpenableItems() {
    const startTime = Date.now();
    log.info('menu', 'getOpenableItems() called')
    try {
      const { getOpenableItems } = require('./menu');
      const items = getOpenableItems();
      log.info('menu', 'getOpenableItems returned ... items in ...ms', { itemsCount: items.length, detail: Date.now() - startTime })
      return items;
    } catch (error) {
      log.error('menu', 'getOpenableItems failed after ...ms', { detail: Date.now() - startTime })
      log.error('menu', 'Stack', { stack: error.stack })
      return [];
    }
  }

  /**
   * Find a menu item by user query using LLM + phonetic matching.
   * Proxies to menu.js's findMenuItem().
   * @param {string} query - User's voice/text request
   * @returns {Promise<Object|null>} Matching menu item or null
   */
  async findMenuItem(query) {
    const startTime = Date.now();
    log.info('menu', 'findMenuItem() called with query: "..."', { query })
    try {
      const { findMenuItem } = require('./menu');
      const result = await findMenuItem(query);
      if (result) {
        log.info('menu', 'findMenuItem matched "..." in ...ms', { detail: result.name || result.label, detail: Date.now() - startTime })
      } else {
        log.info('menu', 'findMenuItem found no match for "..." in ...ms', { query, detail: Date.now() - startTime })
      }
      return result;
    } catch (error) {
      log.error('menu', 'findMenuItem failed for "..." after ...ms', { query, detail: Date.now() - startTime })
      log.error('menu', 'Stack', { stack: error.stack })
      return null;
    }
  }

  /**
   * Register IPC handlers
   */
  _registerIPCHandlers() {
    log.info('menu', 'Registering IPC handlers...')
    
    // Get IDW environments
    ipcMain.handle('menu-data:get-idw-environments', () => { logCount: log.info('menu', 'get-idw-environments')
      const envs = this.getIDWEnvironments();
      log.info('menu', 'Returning ... IDW environments', { envsCount: envs.length })
      return envs;
    });
    
    // Set IDW environments
    ipcMain.handle('menu-data:set-idw-environments', async (event, environments) => {
      log.info('menu', 'set-idw-environments (... envs)', { detail: (environments || []).length })
      const result = await this.setIDWEnvironments(environments, { source: 'ipc' });
      log.info('menu', 'set-idw-environments result', { result })
      return result;
    });
    
    // Add IDW environment
    ipcMain.handle('menu-data:add-idw-environment', async (event, env) => {
      log.info('menu', 'add-idw-environment: "..."', { detail: env && env.label })
      const result = await this.addIDWEnvironment(env);
      log.info('menu', 'add-idw-environment result', { result })
      return result;
    });
    
    // Update IDW environment
    ipcMain.handle('menu-data:update-idw-environment', async (event, id, updates) => {
      
      const result = await this.updateIDWEnvironment(id, updates);
      log.info('menu', 'update-idw-environment result', { result })
      return result;
    });
    
    // Remove IDW environment
    ipcMain.handle('menu-data:remove-idw-environment', async (event, id) => {
      log.info('menu', 'remove-idw-environment: id=...', { id })
      const result = await this.removeIDWEnvironment(id);
      log.info('menu', 'remove-idw-environment result', { result })
      return result;
    });
    
    // Get all data
    ipcMain.handle('menu-data:get-all', () => {
      log.info('menu', 'get-all')
      const data = this.getAllData();
      log.info('menu', 'get-all returned ... data keys', { detail: Object.keys(data).length })
      return data;
    });
    
    // Force refresh
    ipcMain.on('menu-data:force-refresh', () => {
      log.info('menu', 'force-refresh triggered')
      this.forceRefresh();
    });
    
    // Legacy support: redirect old IPC channels
    this._registerLegacyHandlers();
    
    log.info('menu', '✅ IPC handlers registered')
  }

  /**
   * Register legacy IPC handlers for backward compatibility
   */
  _registerLegacyHandlers() {
    // Legacy get-idw-environments
    ipcMain.on('get-idw-environments', (event) => {
      log.info('menu', 'get-idw-environments')
      const envs = this.getIDWEnvironments();
      log.info('menu', 'Replying with ... IDW environments', { envsCount: envs.length })
      event.reply('get-idw-environments', envs);
    });
    
    // Legacy get-external-bots
    ipcMain.on('get-external-bots', (event) => {
      const bots = this.getExternalBots();
      log.info('menu', 'get-external-bots -> ... bots', { botsCount: bots.length })
      event.reply('get-external-bots', bots);
    });
    
    // Legacy get-image-creators
    ipcMain.on('get-image-creators', (event) => {
      const creators = this.getImageCreators();
      log.info('menu', 'get-image-creators -> ... creators', { creatorsCount: creators.length })
      event.reply('get-image-creators', creators);
    });
    
    // Legacy get-video-creators
    ipcMain.on('get-video-creators', (event) => {
      const creators = this.getVideoCreators();
      log.info('menu', 'get-video-creators -> ... creators', { creatorsCount: creators.length })
      event.reply('get-video-creators', creators);
    });
    
    // Legacy get-audio-generators
    ipcMain.on('get-audio-generators', (event) => {
      const generators = this.getAudioGenerators();
      log.info('menu', 'get-audio-generators -> ... generators', { generatorsCount: generators.length })
      event.reply('get-audio-generators', generators);
    });
    
    // Legacy get-ui-design-tools
    ipcMain.on('get-ui-design-tools', (event) => {
      const tools = this.getUIDesignTools();
      log.info('menu', 'get-ui-design-tools -> ... tools', { toolsCount: tools.length })
      event.reply('get-ui-design-tools', tools);
    });
    
    // Legacy refresh-menu - SINGLE handler to replace duplicates
    ipcMain.on('refresh-menu', () => {
      log.info('menu', 'refresh-menu triggered')
      this.forceRefresh();
    });
    
    // Legacy save handlers
    ipcMain.on('save-idw-environments', async (event, environments) => { logCount: log.info('menu', 'save-idw-environments (... envs)', { detail: (environments || []).length })
      const result = await this.setIDWEnvironments(environments, { source: 'legacy-save' });
      log.info('menu', 'save-idw-environments result', { result })
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










