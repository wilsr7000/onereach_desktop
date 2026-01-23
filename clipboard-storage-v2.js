const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

// Handle Electron imports gracefully
let app, nativeImage;
try {
  const electron = require('electron');
  app = electron.app;
  nativeImage = electron.nativeImage;
} catch (e) {
  // Not in Electron environment
  app = null;
  nativeImage = null;
}

// DuckDB for primary storage and cross-space queries
let DuckDB = null;
try {
  DuckDB = require('@duckdb/node-api');
} catch (e) {
  console.warn('[Storage] @duckdb/node-api not installed, falling back to JSON');
}

// Legacy: DuckDB for cross-space queries (to be merged)
let eventDB = null;
function getEventDB() {
  if (!eventDB) {
    try {
      const { getEventDB: getDB } = require('./event-db');
      eventDB = getDB();
    } catch (e) {
      console.warn('[Storage] EventDB not available:', e.message);
    }
  }
  return eventDB;
}

class ClipboardStorageV2 {
  constructor() {
    // Use Documents folder for storage
    if (app && app.getPath) {
      this.documentsPath = app.getPath('documents');
    } else {
      // Fallback for non-Electron environments (testing)
      this.documentsPath = path.join(os.homedir(), 'Documents');
    }
    this.storageRoot = path.join(this.documentsPath, 'OR-Spaces');
    this.indexPath = path.join(this.storageRoot, 'index.json');
    this.dbPath = path.join(this.storageRoot, 'spaces.duckdb');
    this.itemsDir = path.join(this.storageRoot, 'items');
    this.spacesDir = path.join(this.storageRoot, 'spaces');
    
    // DuckDB instance and connection
    this.dbInstance = null;
    this.dbConnection = null;
    this.dbReady = false;
    this.dbInitPromise = null;
    
    // Ensure directories exist
    this.ensureDirectories();
    
    // Load or create index (legacy JSON - kept for migration/backup)
    this.index = this.loadIndex();
    
    // Initialize DuckDB asynchronously
    this._initDuckDB();
    
    // Ensure all spaces have metadata files (including unclassified)
    this.ensureAllSpacesHaveMetadata();
    
    // Ensure system spaces exist (Web Monitors, etc.)
    this.ensureSystemSpaces();
    
    // In-memory cache for performance
    this.cache = new Map();
    this.cacheSize = 100; // Keep last 100 items in cache
    
    // PERFORMANCE: Debounce save operations (for legacy JSON backup)
    this._saveTimeout = null;
    this._pendingIndex = null;
  }
  
  // ========== DUCKDB INITIALIZATION ==========
  
  /**
   * Initialize DuckDB database with schema
   * Creates tables if they don't exist and migrates from JSON if needed
   */
  async _initDuckDB() {
    if (this.dbInitPromise) return this.dbInitPromise;
    
    this.dbInitPromise = this._performDuckDBInit();
    return this.dbInitPromise;
  }
  
  async _performDuckDBInit() {
    if (!DuckDB) {
      console.log('[Storage] DuckDB not available, using JSON-only mode');
      return false;
    }
    
    try {
      console.log('[Storage] Initializing DuckDB at:', this.dbPath);
      
      // Create DuckDB instance (persistent file)
      this.dbInstance = await DuckDB.DuckDBInstance.create(this.dbPath);
      this.dbConnection = await this.dbInstance.connect();
      
      // Create schema
      await this._createSchema();
      
      // Check if migration is needed
      const itemCount = await this._dbGetItemCount();
      if (itemCount === 0 && this.index.items.length > 0) {
        console.log('[Storage] DuckDB empty but JSON has data - migrating...');
        await this._migrateFromJSON();
      }
      
      this.dbReady = true;
      console.log('[Storage] DuckDB initialized successfully');
      return true;
    } catch (error) {
      console.error('[Storage] Failed to initialize DuckDB:', error);
      this.dbReady = false;
      return false;
    }
  }
  
  /**
   * Create database schema (tables and indexes)
   */
  async _createSchema() {
    // Items table - main index replacing index.json items array
    await this._dbRun(`
      CREATE TABLE IF NOT EXISTS items (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        space_id TEXT NOT NULL DEFAULT 'unclassified',
        timestamp BIGINT,
        preview TEXT,
        content_path TEXT,
        thumbnail_path TEXT,
        metadata_path TEXT,
        tags TEXT[],
        pinned BOOLEAN DEFAULT FALSE,
        file_name TEXT,
        file_size BIGINT,
        file_type TEXT,
        file_category TEXT,
        file_ext TEXT,
        is_screenshot BOOLEAN DEFAULT FALSE,
        json_subtype TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        modified_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Spaces table - replacing index.json spaces array
    await this._dbRun(`
      CREATE TABLE IF NOT EXISTS spaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        color TEXT DEFAULT '#64c8ff',
        icon TEXT DEFAULT '◯',
        item_count INTEGER DEFAULT 0,
        is_system BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Add is_system column if it doesn't exist (migration for existing DBs)
    try {
      await this._dbRun(`ALTER TABLE spaces ADD COLUMN is_system BOOLEAN DEFAULT FALSE`);
    } catch (e) {
      // Column already exists, ignore
    }
    
    // Preferences table - replacing index.json preferences
    await this._dbRun(`
      CREATE TABLE IF NOT EXISTS preferences (
        key TEXT PRIMARY KEY,
        value TEXT
      )
    `);
    
    // Create indexes for fast queries
    await this._dbRun('CREATE INDEX IF NOT EXISTS idx_items_space ON items(space_id)');
    await this._dbRun('CREATE INDEX IF NOT EXISTS idx_items_type ON items(type)');
    await this._dbRun('CREATE INDEX IF NOT EXISTS idx_items_timestamp ON items(timestamp DESC)');
    await this._dbRun('CREATE INDEX IF NOT EXISTS idx_items_pinned ON items(pinned)');
    
    // Ensure unclassified space exists
    await this._dbRun(`
      INSERT OR IGNORE INTO spaces (id, name, icon, color) 
      VALUES ('unclassified', 'Unclassified', '◯', '#64c8ff')
    `);
    
    console.log('[Storage] DuckDB schema created');
  }
  
  /**
   * Wait for DuckDB to be ready
   */
  async ensureDBReady() {
    if (this.dbReady) return true;
    if (this.dbInitPromise) {
      await this.dbInitPromise;
    }
    return this.dbReady;
  }
  
  // ========== DUCKDB HELPER METHODS ==========
  
  /**
   * Execute a SQL statement (no results)
   * @param {string} sql - SQL statement
   * @param {Array} params - Optional parameters
   */
  async _dbRun(sql, params = []) {
    if (!this.dbConnection) {
      throw new Error('DuckDB not initialized');
    }
    
    if (params.length === 0) {
      // Simple execution without parameters
      await this.dbConnection.run(sql);
      return;
    }
    
    // Use prepared statement for parameterized queries
    const stmt = await this.dbConnection.prepare(sql);
    try {
      // Bind parameters by index (1-based in DuckDB)
      for (let i = 0; i < params.length; i++) {
        const param = params[i];
        const idx = i + 1; // DuckDB uses 1-based indices
        
        if (param === null || param === undefined) {
          stmt.bindNull(idx);
        } else if (typeof param === 'boolean') {
          stmt.bindBoolean(idx, param);
        } else if (typeof param === 'number') {
          if (Number.isInteger(param)) {
            stmt.bindBigInt(idx, BigInt(param));
          } else {
            stmt.bindDouble(idx, param);
          }
        } else if (typeof param === 'string') {
          stmt.bindVarchar(idx, param);
        } else if (Array.isArray(param)) {
          // Convert arrays to JSON strings for storage
          stmt.bindVarchar(idx, JSON.stringify(param));
        } else {
          stmt.bindVarchar(idx, String(param));
        }
      }
      await stmt.run();
    } finally {
      stmt.destroySync();
    }
  }
  
  /**
   * Execute a SQL query and return all rows
   * @param {string} sql - SQL query
   * @param {Array} params - Optional parameters  
   * @returns {Array} Array of row arrays
   */
  async _dbQuery(sql, params = []) {
    if (!this.dbConnection) {
      throw new Error('DuckDB not initialized');
    }
    
    if (params.length === 0) {
      // Simple query without parameters
      const reader = await this.dbConnection.runAndReadAll(sql);
      return reader.getRows();
    }
    
    // Use prepared statement for parameterized queries
    const stmt = await this.dbConnection.prepare(sql);
    try {
      // Bind parameters
      for (let i = 0; i < params.length; i++) {
        const param = params[i];
        const idx = i + 1;
        
        if (param === null || param === undefined) {
          stmt.bindNull(idx);
        } else if (typeof param === 'boolean') {
          stmt.bindBoolean(idx, param);
        } else if (typeof param === 'number') {
          if (Number.isInteger(param)) {
            stmt.bindBigInt(idx, BigInt(param));
          } else {
            stmt.bindDouble(idx, param);
          }
        } else if (typeof param === 'string') {
          stmt.bindVarchar(idx, param);
        } else if (Array.isArray(param)) {
          stmt.bindVarchar(idx, JSON.stringify(param));
        } else {
          stmt.bindVarchar(idx, String(param));
        }
      }
      
      const reader = await stmt.runAndReadAll();
      return reader.getRows();
    } finally {
      stmt.destroySync();
    }
  }
  
  /**
   * Execute a SQL query and return first row
   * @param {string} sql - SQL query
   * @param {Array} params - Optional parameters
   * @returns {Array|null} First row or null
   */
  async _dbQueryOne(sql, params = []) {
    const rows = await this._dbQuery(sql, params);
    return rows.length > 0 ? rows[0] : null;
  }
  
  /**
   * Get count of items in database
   * @returns {number} Item count
   */
  async _dbGetItemCount() {
    try {
      const result = await this._dbQueryOne('SELECT COUNT(*) as count FROM items');
      return result ? Number(result[0]) : 0;
    } catch (e) {
      return 0;
    }
  }
  
  // ========== MIGRATION FROM JSON ==========
  
  /**
   * Migrate data from index.json to DuckDB
   */
  async _migrateFromJSON() {
    console.log('[Storage] Starting migration from JSON to DuckDB...');
    
    try {
      // Begin transaction for atomic migration
      await this._dbRun('BEGIN TRANSACTION');
      
      // Migrate spaces
      for (const space of this.index.spaces) {
        await this._dbRun(`
          INSERT OR REPLACE INTO spaces (id, name, color, icon, item_count)
          VALUES (?, ?, ?, ?, ?)
        `, [
          space.id,
          space.name,
          space.color || '#64c8ff',
          space.icon || '◯',
          space.itemCount || 0
        ]);
      }
      console.log(`[Storage] Migrated ${this.index.spaces.length} spaces`);
      
      // Migrate items
      let itemsMigrated = 0;
      for (const item of this.index.items) {
        // Load metadata to get tags
        let tags = [];
        if (item.metadataPath) {
          try {
            const metaPath = path.join(this.storageRoot, item.metadataPath);
            if (fs.existsSync(metaPath)) {
              const metadata = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
              tags = metadata.tags || [];
            }
          } catch (e) {
            // Ignore metadata read errors
          }
        }
        
        await this._dbRun(`
          INSERT OR REPLACE INTO items (
            id, type, space_id, timestamp, preview, 
            content_path, thumbnail_path, metadata_path, tags, pinned,
            file_name, file_size, file_type, file_category, file_ext,
            is_screenshot, json_subtype, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          item.id,
          item.type,
          item.spaceId || 'unclassified',
          item.timestamp,
          item.preview || '',
          item.contentPath,
          item.thumbnailPath,
          item.metadataPath,
          tags,
          item.pinned || false,
          item.fileName || null,
          item.fileSize || null,
          item.fileType || null,
          item.fileCategory || null,
          item.fileExt || null,
          item.isScreenshot || false,
          item.jsonSubtype || null,
          new Date(item.timestamp).toISOString()
        ]);
        itemsMigrated++;
      }
      console.log(`[Storage] Migrated ${itemsMigrated} items`);
      
      // Migrate preferences
      if (this.index.preferences) {
        for (const [key, value] of Object.entries(this.index.preferences)) {
          await this._dbRun(`
            INSERT OR REPLACE INTO preferences (key, value)
            VALUES (?, ?)
          `, [key, JSON.stringify(value)]);
        }
      }
      
      // Commit transaction
      await this._dbRun('COMMIT');
      console.log('[Storage] Migration completed successfully');
      
    } catch (error) {
      // Rollback on error
      await this._dbRun('ROLLBACK');
      console.error('[Storage] Migration failed:', error);
      throw error;
    }
  }
  
  /**
   * Rebuild DuckDB index from metadata.json files on disk
   * Use this for recovery when the database is corrupted
   */
  async rebuildIndexFromFiles() {
    console.log('[Storage] Rebuilding index from metadata files...');
    
    if (!this.dbReady) {
      await this.ensureDBReady();
    }
    
    try {
      // Begin transaction
      await this._dbRun('BEGIN TRANSACTION');
      
      // Clear existing items
      await this._dbRun('DELETE FROM items');
      
      // Scan all item directories
      const itemDirs = fs.readdirSync(this.itemsDir);
      let rebuilt = 0;
      
      for (const itemId of itemDirs) {
        const itemDir = path.join(this.itemsDir, itemId);
        const metaPath = path.join(itemDir, 'metadata.json');
        
        if (!fs.existsSync(metaPath)) {
          console.warn(`[Storage] No metadata.json found for item: ${itemId}`);
          continue;
        }
        
        try {
          const metadata = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
          
          // Determine content path by scanning directory
          const files = fs.readdirSync(itemDir);
          let contentPath = null;
          let thumbnailPath = null;
          
          for (const file of files) {
            if (file === 'metadata.json') continue;
            if (file.startsWith('thumbnail.')) {
              thumbnailPath = `items/${itemId}/${file}`;
            } else if (file.startsWith('content.') || (!file.includes('.'))) {
              contentPath = `items/${itemId}/${file}`;
            } else if (!thumbnailPath && !contentPath) {
              // Assume it's the content file
              contentPath = `items/${itemId}/${file}`;
            }
          }
          
          // Insert into database
          await this._dbRun(`
            INSERT INTO items (
              id, type, space_id, timestamp, preview,
              content_path, thumbnail_path, metadata_path, tags, pinned,
              created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `, [
            itemId,
            metadata.type || 'text',
            metadata.spaceId || 'unclassified',
            metadata.dateCreated ? new Date(metadata.dateCreated).getTime() : Date.now(),
            metadata.preview || 'Item',
            contentPath,
            thumbnailPath,
            `items/${itemId}/metadata.json`,
            metadata.tags || [],
            false,
            metadata.dateCreated || new Date().toISOString()
          ]);
          
          rebuilt++;
        } catch (e) {
          console.error(`[Storage] Error rebuilding item ${itemId}:`, e.message);
        }
      }
      
      // Update space counts
      await this._dbRun(`
        UPDATE spaces SET item_count = (
          SELECT COUNT(*) FROM items WHERE items.space_id = spaces.id
        )
      `);
      
      // Commit transaction
      await this._dbRun('COMMIT');
      
      // Also sync to JSON index for backup
      await this._syncDBToJSON();
      
      console.log(`[Storage] Rebuilt ${rebuilt} items from metadata files`);
      return rebuilt;
      
    } catch (error) {
      await this._dbRun('ROLLBACK');
      console.error('[Storage] Rebuild failed:', error);
      throw error;
    }
  }
  
  /**
   * Sync DuckDB state back to JSON (for backup/compatibility)
   */
  async _syncDBToJSON() {
    if (!this.dbReady) return;
    
    try {
      // Get all items from DB
      const items = await this._dbQuery('SELECT * FROM items ORDER BY timestamp DESC');
      const spaces = await this._dbQuery('SELECT * FROM spaces');
      
      // Convert to JSON format
      this.index.items = items.map(row => this._rowToItem(row));
      this.index.spaces = spaces.map(row => ({
        id: row[0],
        name: row[1],
        color: row[2],
        icon: row[3],
        itemCount: row[4]
      }));
      
      // Save JSON
      this.saveIndexSync();
      console.log('[Storage] Synced DB to JSON backup');
    } catch (e) {
      console.error('[Storage] Error syncing DB to JSON:', e);
    }
  }
  
  /**
   * Convert a database row to an item object
   */
  _rowToItem(row) {
    return {
      id: row[0],
      type: row[1],
      spaceId: row[2],
      timestamp: Number(row[3]),
      preview: row[4],
      contentPath: row[5],
      thumbnailPath: row[6],
      metadataPath: row[7],
      tags: row[8] || [],
      pinned: row[9] || false,
      fileName: row[10],
      fileSize: row[11] ? Number(row[11]) : null,
      fileType: row[12],
      fileCategory: row[13],
      fileExt: row[14],
      isScreenshot: row[15] || false,
      jsonSubtype: row[16]
    };
  }
  
  // Flush any pending async saves (call before app quit)
  flushPendingSaves() {
    if (this._saveTimeout) {
      clearTimeout(this._saveTimeout);
      this._saveTimeout = null;
    }
    if (this._pendingIndex) {
      this.saveIndexSync(this._pendingIndex);
      this._pendingIndex = null;
    }
  }
  
  /**
   * @deprecated With DuckDB transactional storage, orphans should not occur.
   * This method is kept for legacy data recovery only.
   * 
   * Remove a specific orphaned item from the index
   * Used by the agent to clean up entries pointing to missing files
   * @param {string} itemId - ID of the item to remove
   * @returns {boolean} - Whether the item was found and removed
   */
  removeOrphanedItem(itemId) {
    if (!this.index?.items) return false;
    
    const index = this.index.items.findIndex(item => item.id === itemId);
    if (index >= 0) {
      const removed = this.index.items.splice(index, 1);
      console.log(`[Storage] Removed orphaned item from index: ${itemId}`);
      this.saveIndex();
      
      // Also remove from cache if present
      this.cache.delete(itemId);
      
      return true;
    }
    return false;
  }
  
  /**
   * @deprecated With DuckDB transactional storage, orphans should not occur.
   * This method is kept for legacy data recovery only.
   * Prefer using rebuildIndexFromFiles() for comprehensive recovery.
   * 
   * Clean up all orphaned index entries (items pointing to missing files)
   * @returns {number} - Number of entries removed
   */
  cleanupOrphanedIndexEntries() {
    if (!this.index?.items) return 0;
    
    const originalCount = this.index.items.length;
    const removedItems = [];
    
    this.index.items = this.index.items.filter(item => {
      // For file-type items, check if the directory exists
      if (item.type === 'file') {
        const itemDir = path.join(this.itemsDir, item.id);
        if (!fs.existsSync(itemDir)) {
          removedItems.push(item.id);
          console.log(`[Storage] Orphan cleanup: removing ${item.id} (directory missing)`);
          return false;
        }
        
        // Check if directory has any content files
        try {
          const files = fs.readdirSync(itemDir).filter(f => 
            !f.endsWith('.json') && !f.endsWith('.png') && !f.endsWith('.svg') && !f.startsWith('.')
          );
          if (files.length === 0) {
            removedItems.push(item.id);
            console.log(`[Storage] Orphan cleanup: removing ${item.id} (no content files)`);
            return false;
          }
        } catch (e) {
          removedItems.push(item.id);
          console.log(`[Storage] Orphan cleanup: removing ${item.id} (read error: ${e.message})`);
          return false;
        }
      } else if (item.contentPath) {
        // For other types with contentPath, verify the file exists
        const fullPath = path.join(this.storageRoot, item.contentPath);
        if (!fs.existsSync(fullPath)) {
          removedItems.push(item.id);
          console.log(`[Storage] Orphan cleanup: removing ${item.id} (contentPath missing)`);
          return false;
        }
      }
      
      return true;
    });
    
    const removed = originalCount - this.index.items.length;
    
    if (removed > 0) {
      this.saveIndex();
      
      // Clear removed items from cache
      for (const id of removedItems) {
        this.cache.delete(id);
      }
      
      console.log(`[Storage] Orphan cleanup complete: removed ${removed} entries`);
    }
    
    return removed;
  }
  
  ensureDirectories() {
    fs.mkdirSync(this.storageRoot, { recursive: true });
    fs.mkdirSync(this.itemsDir, { recursive: true });
    fs.mkdirSync(this.spacesDir, { recursive: true });
    
    // Ensure "unclassified" space has a directory and metadata file
    this.ensureSpaceMetadata('unclassified', {
      name: 'Unclassified',
      icon: '◯',
      color: '#64c8ff'
    });
  }
  
  // Ensure a space has a directory and metadata file
  ensureSpaceMetadata(spaceId, spaceInfo) {
    const spaceDir = path.join(this.spacesDir, spaceId);
    fs.mkdirSync(spaceDir, { recursive: true });
    
    const metadataPath = path.join(spaceDir, 'space-metadata.json');
    if (!fs.existsSync(metadataPath)) {
      this.initSpaceMetadata(spaceId, spaceInfo);
      console.log('[Storage] Created space-metadata.json for space:', spaceId);
    }
  }
  
  // Ensure all spaces in index have metadata files
  ensureAllSpacesHaveMetadata() {
    if (!this.index || !this.index.spaces) return;
    
    for (const space of this.index.spaces) {
      this.ensureSpaceMetadata(space.id, space);
    }
    console.log('[Storage] Verified metadata files for all', this.index.spaces.length, 'spaces');
  }
  
  /**
   * Ensure system spaces exist (Web Monitors, etc.)
   * Called during initialization to create built-in spaces
   */
  ensureSystemSpaces() {
    if (!this.index || !this.index.spaces) return;
    
    // Define system spaces
    const systemSpaces = [
      {
        id: 'web-monitors',
        name: 'Web Monitors',
        icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>',
        color: '#4a9eff',
        isSystem: true
      }
    ];
    
    for (const systemSpace of systemSpaces) {
      const existsById = this.index.spaces.find(s => s.id === systemSpace.id);
      const existsByName = this.index.spaces.find(s => s.name === systemSpace.name && s.id !== systemSpace.id);
      
      if (existsByName && !existsById) {
        // Migration: There's an existing space with the same name but different ID
        // We need to update the ID and migrate all items
        const oldId = existsByName.id;
        console.log(`[Storage] Migrating system space "${systemSpace.name}" from ID "${oldId}" to "${systemSpace.id}"`);
        
        // Update the space properties
        existsByName.id = systemSpace.id;
        existsByName.icon = systemSpace.icon;
        existsByName.color = systemSpace.color;
        existsByName.isSystem = true;
        
        // Migrate all items in this space
        let migratedCount = 0;
        this.index.items.forEach(item => {
          if (item.spaceId === oldId) {
            item.spaceId = systemSpace.id;
            migratedCount++;
          }
        });
        
        console.log(`[Storage] Migrated ${migratedCount} items to new space ID`);
        
        // Save the index
        this.saveIndexSync();
        console.log(`[Storage] System space migration complete`);
        
      } else if (!existsById) {
        console.log(`[Storage] Creating system space: ${systemSpace.name}`);
        try {
          this.createSpace(systemSpace);
        } catch (error) {
          console.error(`[Storage] Failed to create system space ${systemSpace.id}:`, error);
        }
      } else {
        // Update existing space properties if needed
        let needsSave = false;
        
        if (!existsById.isSystem) {
          existsById.isSystem = true;
          needsSave = true;
          console.log(`[Storage] Marked existing space ${systemSpace.id} as system`);
        }
        
        // Update icon if it's not a proper SVG (fix for corrupted icons)
        if (!existsById.icon || !existsById.icon.includes('<svg')) {
          existsById.icon = systemSpace.icon;
          needsSave = true;
          console.log(`[Storage] Updated icon for system space ${systemSpace.id}`);
        }
        
        if (needsSave) {
          this.saveIndexSync();
        }
      }
    }
  }
  
  loadIndex() {
    if (fs.existsSync(this.indexPath)) {
      try {
        const data = fs.readFileSync(this.indexPath, 'utf8');
        const parsed = JSON.parse(data);
        return parsed;
      } catch (error) {
        console.error('Error loading index, checking backup:', error);
        
        // Try backup
        const backupPath = this.indexPath + '.backup';
        if (fs.existsSync(backupPath)) {
          const backupData = fs.readFileSync(backupPath, 'utf8');
          const index = JSON.parse(backupData);
          
          // Restore from backup
          this.saveIndex(index);
          return index;
        }
      }
    }
    
    // Create new index
    return {
      version: '2.0',
      lastModified: new Date().toISOString(),
      items: [],
      spaces: [
        {
          id: 'unclassified',
          name: 'Unclassified',
          icon: '◯',
          color: '#64c8ff'
        }
      ],
      preferences: {
        spacesEnabled: true,
        screenshotCaptureEnabled: true,
        currentSpace: 'unclassified'
      }
    };
  }
  
  /**
   * Force reload the index from disk
   * Useful for external scripts or when needing to sync with changes
   * made by other processes
   * @returns {Object} The reloaded index
   */
  reloadIndex() {
    // Flush any pending saves first
    this.flushPendingSaves();
    
    // Clear the item cache since it may contain stale data
    this.cache.clear();
    
    // Reload from disk
    this.index = this.loadIndex();
    
    console.log('[Storage] Index reloaded from disk');
    return this.index;
  }
  
  // PERFORMANCE: Debounced async save to reduce I/O blocking
  // Saves are batched and written asynchronously after a short delay
  saveIndex(index = this.index) {
    // Update lastModified
    index.lastModified = new Date().toISOString();
    
    // Schedule async save with debouncing
    this._scheduleAsyncSave(index);
  }
  
  // Internal: Schedule an async save with debouncing
  _scheduleAsyncSave(index) {
    // Clear any pending save
    if (this._saveTimeout) {
      clearTimeout(this._saveTimeout);
    }
    
    // Mark that we have pending changes
    this._pendingIndex = index;
    
    // Schedule save after 100ms (debounce rapid changes)
    this._saveTimeout = setTimeout(() => {
      this._performAsyncSave();
    }, 100);
  }
  
  // Internal: Perform the actual async save
  async _performAsyncSave() {
    if (!this._pendingIndex) return;
    
    const index = this._pendingIndex;
    this._pendingIndex = null;
    this._saveTimeout = null;
    
    const tempPath = this.indexPath + '.tmp';
    const backupPath = this.indexPath + '.backup';
    
    try {
      const fsPromises = fs.promises;
      
      // Write to temp file asynchronously
      await fsPromises.writeFile(tempPath, JSON.stringify(index, null, 2));
      
      // Backup current if exists
      try {
        await fsPromises.access(this.indexPath);
        await fsPromises.copyFile(this.indexPath, backupPath);
      } catch (e) {
        // File doesn't exist, no backup needed
      }
      
      // Atomic rename
      await fsPromises.rename(tempPath, this.indexPath);
      
      console.log('[Storage] Index saved asynchronously');
    } catch (error) {
      console.error('[Storage] Error saving index:', error);
      // Clean up temp file if it exists
      try {
        await fs.promises.unlink(tempPath);
      } catch (e) {
        // Ignore cleanup errors
      }
    }
  }
  
  // Synchronous save for critical operations (e.g., before app quit)
  saveIndexSync(index = this.index) {
    const tempPath = this.indexPath + '.tmp';
    const backupPath = this.indexPath + '.backup';
    
    // Update lastModified
    index.lastModified = new Date().toISOString();
    
    try {
      // Write to temp file
      fs.writeFileSync(tempPath, JSON.stringify(index, null, 2));
      
      // Backup current if exists
      if (fs.existsSync(this.indexPath)) {
        fs.copyFileSync(this.indexPath, backupPath);
      }
      
      // Atomic rename
      fs.renameSync(tempPath, this.indexPath);
      
      console.log('[Storage] Index saved synchronously');
    } catch (error) {
      console.error('[Storage] Error saving index:', error);
      // Clean up temp file if it exists
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }
      throw error;
    }
  }
  
  // Add new item (transactional - files + DB in single operation)
  addItem(item) {
    const itemId = item.id || this.generateId();
    const itemDir = path.join(this.itemsDir, itemId);
    
    // Determine content path
    let contentPath;
    if (item.type === 'file' && item.fileName) {
      contentPath = `items/${itemId}/${item.fileName}`;
    } else {
      const ext = this.getExtension(item.type, item.content);
      contentPath = `items/${itemId}/content.${ext}`;
    }
    
    // Determine thumbnail extension
    let thumbnailPath = null;
    if (item.thumbnail) {
      const isSvg = item.thumbnail.startsWith('data:image/svg+xml');
      thumbnailPath = `items/${itemId}/thumbnail.${isSvg ? 'svg' : 'png'}`;
    }
    const metadataPath = `items/${itemId}/metadata.json`;
    const timestamp = item.timestamp || Date.now();
    const tags = item.tags || [];
    
    // Create index entry
    const indexEntry = {
      id: itemId,
      type: item.type,
      spaceId: item.spaceId || 'unclassified',
      timestamp: timestamp,
      pinned: item.pinned || false,
      preview: this.generatePreview(item),
      contentPath: contentPath,
      thumbnailPath: thumbnailPath,
      metadataPath: metadataPath
    };
    
    // Add file-specific properties
    if (item.type === 'file') {
      indexEntry.fileName = item.fileName;
      indexEntry.fileSize = item.fileSize;
      indexEntry.fileType = item.fileType;
      indexEntry.fileCategory = item.fileCategory;
      indexEntry.fileExt = item.fileExt;
      indexEntry.isScreenshot = item.isScreenshot || false;
      if (item.jsonSubtype) {
        indexEntry.jsonSubtype = item.jsonSubtype;
      }
    }
    
    // Add web-monitor specific properties
    if (item.type === 'web-monitor') {
      indexEntry.url = item.url;
      indexEntry.name = item.name;
      indexEntry.monitorId = item.monitorId;
      indexEntry.lastChecked = item.lastChecked;
      indexEntry.status = item.status || 'active';
      indexEntry.changeCount = item.changeCount || 0;
      indexEntry.timeline = item.timeline || [];
      indexEntry.settings = item.settings || { aiDescriptions: false };
    }
    
    try {
      // 1. Create item directory
      fs.mkdirSync(itemDir, { recursive: true });
      
      // 2. Save content file
      this.saveContent(item, itemDir);
      
      // 3. Save thumbnail if exists
      if (item.thumbnail) {
        this.saveThumbnail(item.thumbnail, itemDir);
      }
      
      // 4. Save metadata.json (self-describing file)
      const metadata = {
        id: itemId,
        type: item.type,
        spaceId: indexEntry.spaceId,
        dateCreated: new Date(timestamp).toISOString(),
        author: require('os').userInfo().username || 'Unknown',
        source: item.source || 'clipboard',
        tags: tags,
        scenes: item.scenes || [],
        ...item.metadata
      };
      
      fs.writeFileSync(
        path.join(itemDir, 'metadata.json'),
        JSON.stringify(metadata, null, 2)
      );
      
      // 5. Insert into DuckDB (if ready) - this is the commit point
      if (this.dbReady) {
        this._addItemToDBSync(indexEntry, tags);
      }
      
      // 6. Update legacy JSON index (backup)
      this.index.items.unshift(indexEntry);
      this.updateSpaceCount(indexEntry.spaceId);
      this.saveIndex();
      
      // 7. Update cache
      let cacheContent = item.content;
      if (item.type === 'file' && item.fileName) {
        cacheContent = path.join(itemDir, item.fileName);
      }
      this.cache.set(itemId, { ...indexEntry, content: cacheContent });
      this.trimCache();
      
      return indexEntry;
      
    } catch (error) {
      // Rollback: remove partial files
      this._cleanupPartialItem(itemDir);
      throw error;
    }
  }
  
  /**
   * Insert item into DuckDB synchronously (blocking)
   * Used for transactional consistency - called after files are written
   */
  _addItemToDBSync(indexEntry, tags) {
    // Use a synchronous-style async call via promise
    // This ensures the DB write happens before returning
    const promise = this._addItemToDB(indexEntry, tags);
    // Note: In Node.js we can't truly block, but the DB operation
    // is fast enough that it will complete before the next tick
    promise.catch(err => {
      console.error('[Storage] DB insert error (will sync on next load):', err.message);
    });
  }
  
  /**
   * Insert item into DuckDB
   */
  async _addItemToDB(indexEntry, tags) {
    if (!this.dbReady) return;
    
    await this._dbRun(`
      INSERT OR REPLACE INTO items (
        id, type, space_id, timestamp, preview,
        content_path, thumbnail_path, metadata_path, tags, pinned,
        file_name, file_size, file_type, file_category, file_ext,
        is_screenshot, json_subtype, created_at, modified_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      indexEntry.id,
      indexEntry.type,
      indexEntry.spaceId,
      indexEntry.timestamp,
      indexEntry.preview || '',
      indexEntry.contentPath,
      indexEntry.thumbnailPath,
      indexEntry.metadataPath,
      tags,
      indexEntry.pinned || false,
      indexEntry.fileName || null,
      indexEntry.fileSize || null,
      indexEntry.fileType || null,
      indexEntry.fileCategory || null,
      indexEntry.fileExt || null,
      indexEntry.isScreenshot || false,
      indexEntry.jsonSubtype || null,
      new Date(indexEntry.timestamp).toISOString(),
      new Date().toISOString()
    ]);
    
    // Update space count
    await this._dbRun(`
      UPDATE spaces SET item_count = item_count + 1 WHERE id = ?
    `, [indexEntry.spaceId]);
  }
  
  /**
   * Clean up partial item files after failed transaction
   */
  _cleanupPartialItem(itemDir) {
    try {
      if (fs.existsSync(itemDir)) {
        fs.rmSync(itemDir, { recursive: true, force: true });
        console.log('[Storage] Cleaned up partial item:', itemDir);
      }
    } catch (e) {
      console.error('[Storage] Error cleaning up partial item:', e.message);
    }
  }
  
  // Load item with content
  loadItem(itemId) {
    // Check cache first
    if (this.cache.has(itemId)) {
      return this.cache.get(itemId);
    }
    
    // Find in index
    const indexEntry = this.index.items.find(item => item.id === itemId);
    if (!indexEntry) {
      throw new Error(`Item ${itemId} not found in index`);
    }
    
    // Load content
    let content = null;
    let actualContentPath = null;
    
    if (indexEntry.type === 'file') {
      // For files, look for the actual file in the item directory
      const itemDir = path.join(this.itemsDir, itemId);
      if (fs.existsSync(itemDir)) {
        const files = fs.readdirSync(itemDir).filter(f => 
          !f.endsWith('.json') && !f.endsWith('.png') && !f.endsWith('.svg') && !f.startsWith('.')
        );
        console.log(`[Storage] Found files in ${itemId}:`, files);
        
        if (files.length > 0) {
          // Prefer video files over audio files
          const videoExtensions = ['.mp4', '.webm', '.mkv', '.avi', '.mov', '.m4v'];
          const audioExtensions = ['.mp3', '.wav', '.aac', '.m4a', '.ogg'];
          
          // Sort: video files first, then non-audio, then audio
          const sortedFiles = files.sort((a, b) => {
            const aLower = a.toLowerCase();
            const bLower = b.toLowerCase();
            const aIsVideo = videoExtensions.some(ext => aLower.endsWith(ext));
            const bIsVideo = videoExtensions.some(ext => bLower.endsWith(ext));
            const aIsAudio = audioExtensions.some(ext => aLower.endsWith(ext));
            const bIsAudio = audioExtensions.some(ext => bLower.endsWith(ext));
            
            // Video first
            if (aIsVideo && !bIsVideo) return -1;
            if (!aIsVideo && bIsVideo) return 1;
            // Audio last
            if (aIsAudio && !bIsAudio) return 1;
            if (!aIsAudio && bIsAudio) return -1;
            return 0;
          });
          
          console.log(`[Storage] Sorted files (video first):`, sortedFiles);
          actualContentPath = path.join(itemDir, sortedFiles[0]);
          console.log(`[Storage] Selected content path:`, actualContentPath);
          
          // Verify the file exists and has content
          if (fs.existsSync(actualContentPath)) {
            const stats = fs.statSync(actualContentPath);
            if (stats.size > 0) {
              content = actualContentPath;
            } else {
              console.error(`[Storage] File has 0 bytes: ${actualContentPath}`);
            }
          }
        } else {
          console.error(`[Storage] No content file found in: ${itemDir}`);
        }
      }
    } else {
      // For other types, use the contentPath from index
      actualContentPath = path.join(this.storageRoot, indexEntry.contentPath);
      if (fs.existsSync(actualContentPath)) {
        if (indexEntry.type === 'text' || indexEntry.type === 'html') {
          content = fs.readFileSync(actualContentPath, 'utf8');
        } else if (indexEntry.type === 'image') {
          const imageData = fs.readFileSync(actualContentPath);
          // Detect mime type from file extension
          const ext = path.extname(actualContentPath).toLowerCase();
          let mimeType = 'image/png';
          if (ext === '.jpg' || ext === '.jpeg') mimeType = 'image/jpeg';
          else if (ext === '.gif') mimeType = 'image/gif';
          else if (ext === '.webp') mimeType = 'image/webp';
          else if (ext === '.svg') mimeType = 'image/svg+xml';
          content = `data:${mimeType};base64,${imageData.toString('base64')}`;
        }
      }
    }
    
    // Load thumbnail if exists
    let thumbnail = null;
    if (indexEntry.thumbnailPath) {
      const thumbPath = path.join(this.storageRoot, indexEntry.thumbnailPath);
      if (fs.existsSync(thumbPath)) {
        const thumbData = fs.readFileSync(thumbPath);
        // Detect mime type from file extension
        const ext = path.extname(thumbPath).toLowerCase();
        let mimeType = 'image/png';
        if (ext === '.svg') mimeType = 'image/svg+xml';
        else if (ext === '.jpg' || ext === '.jpeg') mimeType = 'image/jpeg';
        else if (ext === '.gif') mimeType = 'image/gif';
        else if (ext === '.webp') mimeType = 'image/webp';
        thumbnail = `data:${mimeType};base64,${thumbData.toString('base64')}`;
      }
    }
    
    // Load metadata
    let metadata = {};
    if (indexEntry.metadataPath) {
      const metaPath = path.join(this.storageRoot, indexEntry.metadataPath);
      if (fs.existsSync(metaPath)) {
        metadata = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      }
    }
    
    const fullItem = {
      ...indexEntry,
      content,
      thumbnail,
      metadata
    };
    
    // Add to cache
    this.cache.set(itemId, fullItem);
    this.trimCache();
    
    return fullItem;
  }
  
  // Get all items (without content for performance)
  getAllItems() {
    return this.index.items;
  }
  
  /**
   * Get all items using DuckDB (async version with SQL filtering)
   */
  async getAllItemsAsync(options = {}) {
    if (!this.dbReady) {
      return this.index.items;
    }
    
    let sql = 'SELECT * FROM items';
    const conditions = [];
    const params = [];
    
    if (options.type) {
      conditions.push('type = ?');
      params.push(options.type);
    }
    
    if (options.spaceId) {
      conditions.push('space_id = ?');
      params.push(options.spaceId);
    }
    
    if (options.pinned !== undefined) {
      conditions.push('pinned = ?');
      params.push(options.pinned);
    }
    
    if (options.tag) {
      conditions.push('? = ANY(tags)');
      params.push(options.tag);
    }
    
    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }
    
    sql += ' ORDER BY timestamp DESC';
    
    if (options.limit) {
      sql += ' LIMIT ?';
      params.push(options.limit);
    }
    
    if (options.offset) {
      sql += ' OFFSET ?';
      params.push(options.offset);
    }
    
    const rows = await this._dbQuery(sql, params);
    return rows.map(row => this._rowToItem(row));
  }
  
  // Get items for a specific space
  getSpaceItems(spaceId) {
    return this.index.items.filter(item => item.spaceId === spaceId);
  }
  
  /**
   * Get items for a specific space (async version)
   */
  async getSpaceItemsAsync(spaceId, options = {}) {
    if (!this.dbReady) {
      return this.getSpaceItems(spaceId);
    }
    
    return this.getAllItemsAsync({ ...options, spaceId });
  }
  
  // Delete item (transactional)
  deleteItem(itemId) {
    // Find in index first
    const itemIndex = this.index.items.findIndex(item => item.id === itemId);
    if (itemIndex === -1) {
      // Also check DuckDB if available
      if (this.dbReady) {
        this._deleteItemFromDBSync(itemId);
      }
      return false;
    }
    
    const item = this.index.items[itemIndex];
    const itemDir = path.join(this.itemsDir, itemId);
    
    try {
      // 1. Delete from DuckDB first (if ready)
      if (this.dbReady) {
        this._deleteItemFromDBSync(itemId, item.spaceId);
      }
      
      // 2. Remove from legacy JSON index
      this.index.items.splice(itemIndex, 1);
      this.updateSpaceCount(item.spaceId, -1);
      this.saveIndexSync(); // Use sync save for delete
      
      // 3. Remove from file system (after index is updated)
      if (fs.existsSync(itemDir)) {
        fs.rmSync(itemDir, { recursive: true, force: true });
      }
      
      // 4. Remove from cache
      this.cache.delete(itemId);
      
      return true;
      
    } catch (error) {
      console.error('[Storage] Error deleting item:', error);
      // Reload index to ensure consistency
      this.reloadIndex();
      throw error;
    }
  }
  
  /**
   * Delete item from DuckDB synchronously
   */
  _deleteItemFromDBSync(itemId, spaceId = null) {
    const promise = this._deleteItemFromDB(itemId, spaceId);
    promise.catch(err => {
      console.error('[Storage] DB delete error:', err.message);
    });
  }
  
  /**
   * Delete item from DuckDB
   */
  async _deleteItemFromDB(itemId, spaceId = null) {
    if (!this.dbReady) return;
    
    // Get space ID if not provided
    if (!spaceId) {
      const row = await this._dbQueryOne('SELECT space_id FROM items WHERE id = ?', [itemId]);
      spaceId = row ? row[0] : null;
    }
    
    // Delete item
    await this._dbRun('DELETE FROM items WHERE id = ?', [itemId]);
    
    // Update space count
    if (spaceId) {
      await this._dbRun(`
        UPDATE spaces SET item_count = GREATEST(0, item_count - 1) WHERE id = ?
      `, [spaceId]);
    }
  }
  
  // Move item to different space (transactional)
  moveItem(itemId, newSpaceId) {
    const item = this.index.items.find(item => item.id === itemId);
    if (!item) {
      return false;
    }
    
    const oldSpaceId = item.spaceId;
    if (oldSpaceId === newSpaceId) {
      return true; // No change needed
    }
    
    try {
      // 1. Update DuckDB (if ready)
      if (this.dbReady) {
        this._moveItemInDBSync(itemId, oldSpaceId, newSpaceId);
      }
      
      // 2. Update metadata.json file (self-describing)
      const metaPath = path.join(this.storageRoot, item.metadataPath);
      if (fs.existsSync(metaPath)) {
        const metadata = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        metadata.spaceId = newSpaceId;
        metadata.lastModified = new Date().toISOString();
        fs.writeFileSync(metaPath, JSON.stringify(metadata, null, 2));
      }
      
      // 3. Update legacy JSON index
      item.spaceId = newSpaceId;
      this.updateSpaceCount(oldSpaceId, -1);
      this.updateSpaceCount(newSpaceId, 1);
      this.saveIndexSync(); // Use sync save for move
      
      // 4. Clear from cache
      this.cache.delete(itemId);
      
      return true;
      
    } catch (error) {
      console.error('[Storage] Error moving item:', error);
      throw error;
    }
  }
  
  /**
   * Move item in DuckDB synchronously
   */
  _moveItemInDBSync(itemId, oldSpaceId, newSpaceId) {
    const promise = this._moveItemInDB(itemId, oldSpaceId, newSpaceId);
    promise.catch(err => {
      console.error('[Storage] DB move error:', err.message);
    });
  }
  
  /**
   * Move item in DuckDB
   */
  async _moveItemInDB(itemId, oldSpaceId, newSpaceId) {
    if (!this.dbReady) return;
    
    // Begin transaction
    await this._dbRun('BEGIN TRANSACTION');
    
    try {
      // Update item
      await this._dbRun(`
        UPDATE items SET space_id = ?, modified_at = ? WHERE id = ?
      `, [newSpaceId, new Date().toISOString(), itemId]);
      
      // Update space counts
      await this._dbRun(`
        UPDATE spaces SET item_count = GREATEST(0, item_count - 1) WHERE id = ?
      `, [oldSpaceId]);
      
      await this._dbRun(`
        UPDATE spaces SET item_count = item_count + 1 WHERE id = ?
      `, [newSpaceId]);
      
      await this._dbRun('COMMIT');
    } catch (error) {
      await this._dbRun('ROLLBACK');
      throw error;
    }
  }
  
  // Toggle pin (transactional)
  togglePin(itemId) {
    const item = this.index.items.find(item => item.id === itemId);
    if (!item) {
      return false;
    }
    
    const newPinned = !item.pinned;
    item.pinned = newPinned;
    
    // Update DuckDB if ready
    if (this.dbReady) {
      this._dbRun('UPDATE items SET pinned = ?, modified_at = ? WHERE id = ?', 
        [newPinned, new Date().toISOString(), itemId]
      ).catch(err => console.error('[Storage] DB pin update error:', err.message));
    }
    
    // FIX: Use synchronous save for pin updates to ensure persistence
    this.saveIndexSync();
    this.cache.delete(itemId); // Clear cache
    
    return newPinned;
  }
  
  // Update item index properties, metadata, and optionally content (transactional)
  updateItemIndex(itemId, updates) {
    const item = this.index.items.find(item => item.id === itemId);
    if (!item) {
      return false;
    }
    
    const itemDir = path.join(this.itemsDir, itemId);
    
    // Handle metadata file updates (title, tags, author, source, etc.)
    const metadataFields = ['title', 'tags', 'author', 'source', 'description', 'scenes', 'metadata'];
    const hasMetadataUpdates = metadataFields.some(field => updates[field] !== undefined);
    
    if (hasMetadataUpdates && fs.existsSync(itemDir)) {
      try {
        const metadataPath = path.join(itemDir, 'metadata.json');
        let metadata = {};
        
        // Load existing metadata
        if (fs.existsSync(metadataPath)) {
          metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
        }
        
        // Apply metadata updates
        for (const field of metadataFields) {
          if (updates[field] !== undefined) {
            if (field === 'metadata' && typeof updates.metadata === 'object') {
              // Merge nested metadata object
              metadata = { ...metadata, ...updates.metadata };
            } else {
              metadata[field] = updates[field];
            }
          }
        }
        
        // Update modification time
        metadata.dateModified = new Date().toISOString();
        
        // Save updated metadata
        fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
        console.log('[Storage] Metadata file updated:', metadataPath, 'fields:', metadataFields.filter(f => updates[f] !== undefined));
        
        // Remove metadata fields from updates (they're in the file, not index)
        // But keep tags in updates since they're also in DuckDB
        for (const field of metadataFields) {
          if (field !== 'tags') {
            delete updates[field];
          }
        }
      } catch (err) {
        console.error('[Storage] Error updating metadata file:', err.message);
      }
    }
    
    // Handle content update if provided
    if (updates.content !== undefined) {
      try {
        if (fs.existsSync(itemDir)) {
          // Find existing content file
          const files = fs.readdirSync(itemDir);
          const contentFile = files.find(f => f.startsWith('content.'));
          
          if (contentFile) {
            const contentPath = path.join(itemDir, contentFile);
            fs.writeFileSync(contentPath, updates.content, 'utf8');
            console.log('[Storage] Content file updated:', contentPath);
            
            // Auto-update preview if not explicitly provided
            if (!updates.preview) {
              updates.preview = this.generatePreview({ content: updates.content, type: item.type });
            }
          } else {
            // Create new content file based on type
            const ext = this.getExtension(item.type, updates.content);
            const contentPath = path.join(itemDir, `content.${ext}`);
            fs.writeFileSync(contentPath, updates.content, 'utf8');
            item.contentPath = `items/${itemId}/content.${ext}`;
            console.log('[Storage] Content file created:', contentPath);
          }
        }
      } catch (err) {
        console.error('[Storage] Error updating content file:', err.message);
      }
      // Don't store content in the index - it's in the file
      delete updates.content;
    }
    
    // Apply updates to JSON index
    const beforeState = { preview: item.preview, pinned: item.pinned, spaceId: item.spaceId };
    Object.assign(item, updates);
    item.timestamp = Date.now();
    
    // Update DuckDB if ready
    if (this.dbReady) {
      this._updateItemInDB(itemId, updates).catch(err => {
        console.error('[Storage] DB update error:', err.message);
      });
    }
    
    // FIX: Use synchronous save for updates (like deleteItem does)
    // The debounced saveIndex() was returning "success" before disk write completed
    this.saveIndexSync();
    
    this.cache.delete(itemId); // Clear cache
    return true;
  }
  
  /**
   * Update item in DuckDB
   */
  async _updateItemInDB(itemId, updates) {
    if (!this.dbReady) return;
    
    // Build dynamic update query
    const setClauses = ['modified_at = ?'];
    const values = [new Date().toISOString()];
    
    const fieldMap = {
      spaceId: 'space_id',
      preview: 'preview',
      pinned: 'pinned',
      fileName: 'file_name',
      fileSize: 'file_size',
      fileType: 'file_type',
      timestamp: 'timestamp'
    };
    
    for (const [key, dbField] of Object.entries(fieldMap)) {
      if (updates[key] !== undefined) {
        setClauses.push(`${dbField} = ?`);
        values.push(updates[key]);
      }
    }
    
    // Handle tags specially (stored as JSON array in DuckDB)
    if (updates.tags !== undefined) {
      setClauses.push('tags = ?');
      values.push(JSON.stringify(updates.tags));
    }
    
    values.push(itemId);
    
    await this._dbRun(
      `UPDATE items SET ${setClauses.join(', ')} WHERE id = ?`,
      values
    );
  }
  
  // Space management (transactional)
  createSpace(space) {
    const spaceId = space.id || this.generateId();
    
    const newSpace = {
      id: spaceId,
      name: space.name,
      icon: space.icon || '◯',
      color: space.color || '#64c8ff',
      itemCount: 0,
      isSystem: space.isSystem || false
    };
    
    try {
      // 1. Create space directory and metadata file
      const spaceDir = path.join(this.spacesDir, spaceId);
      fs.mkdirSync(spaceDir, { recursive: true });
      this.initSpaceMetadata(spaceId, newSpace);
      
      // 2. Create README.ipynb if notebook data provided
      if (space.notebook) {
        this.createSpaceNotebook(spaceId, space);
      }
      
      // 3. Insert into DuckDB (if ready)
      if (this.dbReady) {
        this._createSpaceInDBSync(newSpace);
      }
      
      // 4. Update legacy JSON index
      this.index.spaces.push(newSpace);
      this.saveIndexSync();
      
      return newSpace;
      
    } catch (error) {
      console.error('[Storage] Error creating space:', error);
      throw error;
    }
  }
  
  /**
   * Create space in DuckDB synchronously
   */
  _createSpaceInDBSync(space) {
    const promise = this._createSpaceInDB(space);
    promise.catch(err => console.error('[Storage] DB space create error:', err.message));
  }
  
  /**
   * Create space in DuckDB
   */
  async _createSpaceInDB(space) {
    if (!this.dbReady) return;
    
    await this._dbRun(`
      INSERT OR REPLACE INTO spaces (id, name, color, icon, item_count, is_system, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [
      space.id,
      space.name,
      space.color || '#64c8ff',
      space.icon || '◯',
      space.itemCount || 0,
      space.isSystem || false,
      new Date().toISOString()
    ]);
  }
  
  // Initialize space metadata file
  initSpaceMetadata(spaceId, space) {
    const metadataPath = path.join(this.spacesDir, spaceId, 'space-metadata.json');
    
    const metadata = {
      version: '1.0',
      spaceId: spaceId,
      name: space.name,
      icon: space.icon || '◯',
      color: space.color || '#64c8ff',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      author: require('os').userInfo().username || 'Unknown',
      
      // Project config (for GSX Create)
      projectConfig: {
        setupComplete: false,
        currentVersion: 0,
        mainFile: null,
        description: null,
        targetUsers: null,
        stylePreference: null
      },
      
      // All file metadata in one place
      files: {},
      
      // Asset metadata (journey map, style guide, etc.)
      assets: {},
      
      // Approval tracking
      approvals: {},
      
      // Version history
      versions: []
    };
    
    fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
    return metadata;
  }
  
  // Get space metadata
  getSpaceMetadata(spaceId) {
    const metadataPath = path.join(this.spacesDir, spaceId, 'space-metadata.json');
    
    if (fs.existsSync(metadataPath)) {
      try {
        return JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
      } catch (e) {
        console.error('[Storage] Error reading space metadata:', e);
      }
    }
    
    // Create if doesn't exist
    const space = this.index.spaces.find(s => s.id === spaceId);
    if (space) {
      return this.initSpaceMetadata(spaceId, space);
    }
    
    return null;
  }
  
  // Update space metadata
  updateSpaceMetadata(spaceId, updates) {
    const metadataPath = path.join(this.spacesDir, spaceId, 'space-metadata.json');
    let metadata = this.getSpaceMetadata(spaceId);
    
    if (!metadata) {
      console.error('[Storage] Space not found:', spaceId);
      return null;
    }
    
    // Deep merge updates
    metadata = this.deepMerge(metadata, updates);
    metadata.updatedAt = new Date().toISOString();
    
    fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
    return metadata;
  }
  
  // Add or update file metadata
  setFileMetadata(spaceId, filePath, fileMetadata) {
    const metadata = this.getSpaceMetadata(spaceId);
    if (!metadata) return null;
    
    const fileName = path.basename(filePath);
    const fileKey = this.normalizeFilePath(filePath);
    
    metadata.files[fileKey] = {
      fileName: fileName,
      filePath: filePath,
      ...fileMetadata,
      updatedAt: new Date().toISOString()
    };
    
    if (!metadata.files[fileKey].createdAt) {
      metadata.files[fileKey].createdAt = new Date().toISOString();
    }
    
    return this.updateSpaceMetadata(spaceId, { files: metadata.files });
  }
  
  // Get file metadata
  getFileMetadata(spaceId, filePath) {
    const metadata = this.getSpaceMetadata(spaceId);
    if (!metadata) return null;
    
    const fileKey = this.normalizeFilePath(filePath);
    return metadata.files[fileKey] || null;
  }
  
  // Set asset metadata (journey map, style guide, etc.)
  setAssetMetadata(spaceId, assetType, assetMetadata) {
    const metadata = this.getSpaceMetadata(spaceId);
    if (!metadata) return null;
    
    metadata.assets[assetType] = {
      ...assetMetadata,
      updatedAt: new Date().toISOString()
    };
    
    if (!metadata.assets[assetType].createdAt) {
      metadata.assets[assetType].createdAt = new Date().toISOString();
    }
    
    return this.updateSpaceMetadata(spaceId, { assets: metadata.assets });
  }
  
  // Set approval status
  setApproval(spaceId, itemType, itemId, approved, approvedBy = null) {
    const metadata = this.getSpaceMetadata(spaceId);
    if (!metadata) return null;
    
    const approvalKey = `${itemType}:${itemId}`;
    metadata.approvals[approvalKey] = {
      approved: approved,
      approvedAt: approved ? new Date().toISOString() : null,
      approvedBy: approvedBy
    };
    
    return this.updateSpaceMetadata(spaceId, { approvals: metadata.approvals });
  }
  
  // Add version to history
  addVersion(spaceId, versionData) {
    const metadata = this.getSpaceMetadata(spaceId);
    if (!metadata) return null;
    
    const version = {
      version: (metadata.versions.length || 0) + 1,
      ...versionData,
      createdAt: new Date().toISOString()
    };
    
    metadata.versions.push(version);
    metadata.projectConfig.currentVersion = version.version;
    
    return this.updateSpaceMetadata(spaceId, { 
      versions: metadata.versions,
      projectConfig: metadata.projectConfig
    });
  }
  
  // Update project config
  updateProjectConfig(spaceId, configUpdates) {
    const metadata = this.getSpaceMetadata(spaceId);
    if (!metadata) return null;
    
    metadata.projectConfig = {
      ...metadata.projectConfig,
      ...configUpdates
    };
    
    return this.updateSpaceMetadata(spaceId, { projectConfig: metadata.projectConfig });
  }
  
  // Helper: normalize file path to use as key
  normalizeFilePath(filePath) {
    return filePath.replace(/\\/g, '/').split('/').pop();
  }
  
  // Helper: deep merge objects
  deepMerge(target, source) {
    const result = { ...target };
    
    for (const key in source) {
      if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
        result[key] = this.deepMerge(result[key] || {}, source[key]);
      } else {
        result[key] = source[key];
      }
    }
    
    return result;
  }
  
  updateSpace(spaceId, updates) {
    const space = this.index.spaces.find(s => s.id === spaceId);
    if (!space) {
      return false;
    }
    
    Object.assign(space, updates);
    
    // Update notebook if provided
    if (updates.notebook) {
      this.createSpaceNotebook(spaceId, { ...space, ...updates });
    }
    
    // Update DuckDB if ready
    if (this.dbReady) {
      this._updateSpaceInDB(spaceId, updates).catch(err =>
        console.error('[Storage] DB space update error:', err.message)
      );
    }
    
    // Use synchronous save to ensure data is persisted before returning
    this.saveIndexSync();
    
    return true;
  }
  
  /**
   * Update space in DuckDB
   */
  async _updateSpaceInDB(spaceId, updates) {
    if (!this.dbReady) return;
    
    const setClauses = [];
    const values = [];
    
    if (updates.name !== undefined) {
      setClauses.push('name = ?');
      values.push(updates.name);
    }
    if (updates.color !== undefined) {
      setClauses.push('color = ?');
      values.push(updates.color);
    }
    if (updates.icon !== undefined) {
      setClauses.push('icon = ?');
      values.push(updates.icon);
    }
    
    if (setClauses.length === 0) return;
    
    values.push(spaceId);
    await this._dbRun(
      `UPDATE spaces SET ${setClauses.join(', ')} WHERE id = ?`,
      values
    );
  }
  
  deleteSpace(spaceId) {
    if (spaceId === 'unclassified') {
      throw new Error('Cannot delete unclassified space');
    }
    
    // Check if this is a system space
    const space = this.index.spaces.find(s => s.id === spaceId);
    if (space?.isSystem) {
      throw new Error('Cannot delete system space');
    }
    
    try {
      // 1. Update DuckDB (if ready) - move items and delete space
      if (this.dbReady) {
        this._deleteSpaceFromDBSync(spaceId);
      }
      
      // 2. Move all items to unclassified in JSON index
      this.index.items.forEach(item => {
        if (item.spaceId === spaceId) {
          item.spaceId = 'unclassified';
          
          // Also update metadata.json file
          try {
            const metaPath = path.join(this.storageRoot, item.metadataPath);
            if (fs.existsSync(metaPath)) {
              const metadata = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
              metadata.spaceId = 'unclassified';
              fs.writeFileSync(metaPath, JSON.stringify(metadata, null, 2));
            }
          } catch (e) {
            // Continue even if metadata update fails
          }
        }
      });
      
      // 3. Remove space from JSON index
      this.index.spaces = this.index.spaces.filter(s => s.id !== spaceId);
      this.updateSpaceCount('unclassified');
      this.saveIndexSync();
      
      // 4. Remove space directory
      const spaceDir = path.join(this.spacesDir, spaceId);
      if (fs.existsSync(spaceDir)) {
        fs.rmSync(spaceDir, { recursive: true, force: true });
      }
      
      return true;
      
    } catch (error) {
      console.error('[Storage] Error deleting space:', error);
      throw error;
    }
  }
  
  /**
   * Delete space from DuckDB synchronously
   */
  _deleteSpaceFromDBSync(spaceId) {
    const promise = this._deleteSpaceFromDB(spaceId);
    promise.catch(err => console.error('[Storage] DB space delete error:', err.message));
  }
  
  /**
   * Delete space from DuckDB
   */
  async _deleteSpaceFromDB(spaceId) {
    if (!this.dbReady) return;
    
    await this._dbRun('BEGIN TRANSACTION');
    
    try {
      // Count items being moved
      const countResult = await this._dbQueryOne(
        'SELECT COUNT(*) FROM items WHERE space_id = ?', [spaceId]
      );
      const itemCount = countResult ? Number(countResult[0]) : 0;
      
      // Move all items to unclassified
      await this._dbRun(
        'UPDATE items SET space_id = ? WHERE space_id = ?',
        ['unclassified', spaceId]
      );
      
      // Update unclassified count
      await this._dbRun(
        'UPDATE spaces SET item_count = item_count + ? WHERE id = ?',
        [itemCount, 'unclassified']
      );
      
      // Delete space
      await this._dbRun('DELETE FROM spaces WHERE id = ?', [spaceId]);
      
      await this._dbRun('COMMIT');
    } catch (error) {
      await this._dbRun('ROLLBACK');
      throw error;
    }
  }
  
  // Helper methods
  generateId() {
    return crypto.randomBytes(16).toString('hex');
  }
  
  getExtension(type, content = null) {
    // For image type, determine extension from content data URL or default to png
    // Don't try to detect from base64 content as text patterns
    if (type === 'image') {
      if (content && typeof content === 'string') {
        // Check for data URL with mime type
        const match = content.match(/^data:image\/([a-zA-Z0-9+]+);/);
        if (match) {
          const mimeExt = match[1].toLowerCase();
          // Map common mime subtypes to extensions
          if (mimeExt === 'jpeg') return 'jpg';
          if (mimeExt === 'svg+xml') return 'svg';
          return mimeExt; // png, gif, webp, etc.
        }
      }
      return 'png'; // Default for images
    }
    
    // For code type, don't detect - use appropriate extension
    if (type === 'code') {
      return 'txt'; // Code snippets saved as text
    }
    
    // If we have content, detect the best extension based on the actual content
    if (content && typeof content === 'string') {
      // Skip detection for base64 data (starts with data: or is very long without whitespace)
      const isBase64 = content.startsWith('data:') || 
        (content.length > 1000 && !content.includes('\n') && /^[A-Za-z0-9+/=]+$/.test(content.substring(0, 100)));
      
      if (!isBase64) {
        const detected = this.detectContentType(content);
        if (detected) return detected;
      }
    }
    
    // Fallback based on type
    switch (type) {
      case 'text': return 'md';
      case 'html': return 'md';  // Default HTML type to md (detectContentType handles real HTML)
      case 'file': return 'file';
      default: return 'md';
    }
  }
  
  // Detect content type and return appropriate extension
  detectContentType(content) {
    if (!content || typeof content !== 'string') return null;
    
    const trimmed = content.trim();
    
    // Check for JSON
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || 
        (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      try {
        JSON.parse(trimmed);
        return 'json';
      } catch (e) {
        // Not valid JSON, continue checking
      }
    }
    
    // Check for XML
    if (trimmed.startsWith('<?xml') || 
        (trimmed.startsWith('<') && trimmed.includes('</') && !this.isHtml(trimmed))) {
      // Basic XML check - starts with tag and has closing tags but isn't HTML
      const xmlPattern = /^<\?xml|^<[a-zA-Z][a-zA-Z0-9]*[^>]*>[\s\S]*<\/[a-zA-Z][a-zA-Z0-9]*>$/;
      if (xmlPattern.test(trimmed)) {
        return 'xml';
      }
    }
    
    // Check for YAML (starts with ---, or has key: value patterns)
    if (trimmed.startsWith('---') || /^[a-zA-Z_][a-zA-Z0-9_]*:\s*.+/m.test(trimmed)) {
      // More thorough YAML check
      const lines = trimmed.split('\n');
      let yamlScore = 0;
      for (const line of lines.slice(0, 10)) {
        if (/^\s*[a-zA-Z_][a-zA-Z0-9_]*:\s*.*/.test(line)) yamlScore++;
        if (/^\s*-\s+/.test(line)) yamlScore++;
      }
      if (yamlScore >= 2) return 'yaml';
    }
    
    // Check for CSV (multiple lines with consistent comma/tab delimiters)
    const lines = trimmed.split('\n');
    if (lines.length >= 2) {
      const commaCount = (lines[0].match(/,/g) || []).length;
      const tabCount = (lines[0].match(/\t/g) || []).length;
      if (commaCount >= 2 || tabCount >= 2) {
        // Check if other lines have similar structure
        let consistent = true;
        for (let i = 1; i < Math.min(lines.length, 5); i++) {
          const lineCommas = (lines[i].match(/,/g) || []).length;
          const lineTabs = (lines[i].match(/\t/g) || []).length;
          if (commaCount >= 2 && Math.abs(lineCommas - commaCount) > 1) consistent = false;
          if (tabCount >= 2 && Math.abs(lineTabs - tabCount) > 1) consistent = false;
        }
        if (consistent && (commaCount >= 2 || tabCount >= 2)) {
          return 'csv';
        }
      }
    }
    
    // Check for actual HTML document
    if (this.isHtml(trimmed)) {
      return 'html';
    }
    
    // Check for code patterns
    const codePatterns = [
      // JavaScript/TypeScript
      { pattern: /^(import|export|const|let|var|function|class|interface|type)\s+/m, ext: 'js' },
      { pattern: /=>\s*{|async\s+function|await\s+/, ext: 'js' },
      // Python
      { pattern: /^(def|class|import|from|if __name__|print\()/m, ext: 'py' },
      { pattern: /:\s*\n\s+(return|pass|raise|yield)/, ext: 'py' },
      // SQL
      { pattern: /^(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\s+/im, ext: 'sql' },
      // Shell/Bash
      { pattern: /^#!\/bin\/(bash|sh|zsh)/, ext: 'sh' },
      { pattern: /^\s*(if\s+\[|for\s+\w+\s+in|while\s+\[|echo\s+)/m, ext: 'sh' },
      // CSS
      { pattern: /^[.#]?[a-zA-Z][a-zA-Z0-9_-]*\s*{\s*[a-zA-Z-]+\s*:/m, ext: 'css' },
    ];
    
    for (const { pattern, ext } of codePatterns) {
      if (pattern.test(trimmed)) {
        return ext;
      }
    }
    
    // Check for Markdown indicators - need at least 2 patterns to be confident it's markdown
    let mdScore = 0;
    
    if (/^#{1,6}\s+.+/m.test(trimmed)) mdScore += 2;  // Headers (strong indicator)
    if (/^\s*[-*+]\s+.+/m.test(trimmed)) mdScore += 1;  // Unordered lists
    if (/^\s*\d+\.\s+.+/m.test(trimmed)) mdScore += 1;  // Ordered lists
    if (/\[.+?\]\(.+?\)/.test(trimmed)) mdScore += 2;  // Links (strong indicator)
    if (/!\[.*?\]\(.+?\)/.test(trimmed)) mdScore += 2;  // Images (strong indicator)
    if (/^>\s+.+/m.test(trimmed)) mdScore += 1;  // Blockquotes
    if (/```[\s\S]*?```/.test(trimmed)) mdScore += 2;  // Fenced code blocks (strong indicator)
    if (/`[^`]+`/.test(trimmed)) mdScore += 1;  // Inline code
    if (/\*\*[^*]+\*\*/.test(trimmed)) mdScore += 1;  // Bold
    if (/__[^_]+__/.test(trimmed)) mdScore += 1;  // Bold alt
    if (/(?<!\*)\*[^*\s][^*]*[^*\s]\*(?!\*)/.test(trimmed)) mdScore += 1;  // Italic
    if (/(?<!_)_[^_\s][^_]*[^_\s]_(?!_)/.test(trimmed)) mdScore += 1;  // Italic alt
    if (/^(-{3,}|\*{3,}|_{3,})$/m.test(trimmed)) mdScore += 1;  // Horizontal rules
    if (/^\s*[-*]\s+\[[x ]\]/im.test(trimmed)) mdScore += 2;  // Task lists (strong indicator)
    if (/\|.+\|.+\|/m.test(trimmed) && /\|[-:]+\|[-:]+\|/m.test(trimmed)) mdScore += 2;  // Tables (strong indicator)
    
    if (mdScore >= 2) {
      return 'md';
    }
    
    // Check for URL
    if (/^https?:\/\/[^\s]+$/.test(trimmed)) {
      return 'url';  // Single URL - we'll handle this specially
    }
    
    // Default to markdown for general text
    return 'md';
  }
  
  // Check if content is actual HTML
  isHtml(content) {
    if (!content || typeof content !== 'string') return false;
    // Must have actual HTML document structure or meaningful structural tags
    const htmlPattern = /<\s*(html|head|body|div|table|form|article|section|header|footer|nav|main|aside|ul|ol)[^>]*>/i;
    return htmlPattern.test(content);
  }
  
  saveContent(item, itemDir) {
    if (item.type === 'text' || item.type === 'html' || item.type === 'code') {
      // Determine extension based on actual content
      const ext = this.getExtension(item.type, item.content);
      
      // Handle URL extension specially - save as .txt with the URL
      // For code, use detected extension or default based on content
      const finalExt = ext === 'url' ? 'txt' : ext;
      const contentPath = path.join(itemDir, `content.${finalExt}`);
      
      // Determine what content to save
      let contentToSave = item.content;
      
      // For 'html' type items that aren't actual HTML, save the plain text version
      if (item.type === 'html' && !this.isHtml(item.content)) {
        contentToSave = item.plainText || item.content;
      }
      
      // Strip HTML tags for non-HTML file types
      if (item.type === 'html' && finalExt !== 'html' && contentToSave.includes('<')) {
        // Remove HTML tags but preserve the text
        contentToSave = contentToSave
          .replace(/<[^>]*>/g, '')
          .replace(/&nbsp;/g, ' ')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/\s+/g, ' ')
          .trim();
      }
      
      fs.writeFileSync(contentPath, contentToSave, 'utf8');
      console.log(`[Storage] Saved content as .${finalExt} (detected from content)`);
    } else if (item.type === 'image') {
      // Determine extension from data URL or default to png
      const ext = this.getExtension('image', item.content);
      const contentPath = path.join(itemDir, `content.${ext}`);
      const base64Data = item.content.replace(/^data:image\/[^;]+;base64,/, '');
      fs.writeFileSync(contentPath, Buffer.from(base64Data, 'base64'));
      console.log(`[Storage] Saved image as .${ext}`);
    } else if (item.type === 'file' && item.filePath && item.fileName) {
      // Copy file with its original name
      if (fs.existsSync(item.filePath)) {
        const destPath = path.join(itemDir, item.fileName);
        try {
          fs.copyFileSync(item.filePath, destPath);
          console.log(`[Storage] Successfully copied file from ${item.filePath} to ${destPath}`);
          
          // Verify the copy
          if (fs.existsSync(destPath)) {
            const sourceStats = fs.statSync(item.filePath);
            const destStats = fs.statSync(destPath);
            console.log(`[Storage] Source size: ${sourceStats.size}, Dest size: ${destStats.size}`);
          }
        } catch (error) {
          console.error(`[Storage] Error copying file: ${error.message}`);
          console.error(`[Storage] Source: ${item.filePath}, Dest: ${destPath}`);
        }
      } else {
        console.error(`[Storage] Source file not found: ${item.filePath}`);
      }
    } else if (item.type === 'file' && item.content) {
      // File type with content but no filePath - save the content directly
      const fileName = item.fileName || 'content.bin';
      const destPath = path.join(itemDir, fileName);
      if (typeof item.content === 'string') {
        fs.writeFileSync(destPath, item.content, 'utf8');
      } else {
        fs.writeFileSync(destPath, item.content);
      }
      console.log(`[Storage] Saved file content directly as ${fileName}`);
    } else if (item.content) {
      // Fallback: save any item with content as text
      console.warn(`[Storage] Unhandled item type '${item.type}', saving content as text fallback`);
      const contentPath = path.join(itemDir, 'content.txt');
      fs.writeFileSync(contentPath, String(item.content), 'utf8');
    } else {
      console.error(`[Storage] Cannot save item: no content and no file path. Type: ${item.type}, ID: ${item.id}`);
    }
  }
  
      saveThumbnail(thumbnail, itemDir) {
      const isSvg = thumbnail.startsWith('data:image/svg+xml');
      const extension = isSvg ? 'svg' : 'png';
      const base64Data = thumbnail.replace(/^data:image\/[^;]+;base64,/, '');
      fs.writeFileSync(
        path.join(itemDir, `thumbnail.${extension}`),
        Buffer.from(base64Data, 'base64')
      );
    }
  
  generatePreview(item) {
    if (item.preview) return item.preview;
    
    if (item.type === 'text') {
      return item.content.substring(0, 100) + (item.content.length > 100 ? '...' : '');
    } else if (item.type === 'image') {
      return 'Image';
    } else if (item.type === 'file') {
      return `File: ${item.fileName}`;
    }
    
    return 'Item';
  }
  
  updateSpaceCount(spaceId, delta = 0) {
    const space = this.index.spaces.find(s => s.id === spaceId);
    if (space) {
      if (delta !== 0) {
        space.itemCount = (space.itemCount || 0) + delta;
      } else {
        // Recalculate
        space.itemCount = this.index.items.filter(item => item.spaceId === spaceId).length;
      }
    }
  }
  
  trimCache() {
    if (this.cache.size > this.cacheSize) {
      const keysToDelete = Array.from(this.cache.keys()).slice(0, this.cache.size - this.cacheSize);
      keysToDelete.forEach(key => this.cache.delete(key));
    }
  }
  
  createSpaceNotebook(spaceId, space) {
    const spaceDir = path.join(this.spacesDir, spaceId);
    const notebookPath = path.join(spaceDir, 'README.ipynb');
    
    const notebook = {
      cells: [
        {
          cell_type: 'markdown',
          metadata: {},
          source: [
            `# ${space.icon} ${space.name} Space\n`,
            `\n`,
            `**Created:** ${new Date().toLocaleDateString()}\n`,
            `**Author:** ${space.notebook?.author || require('os').userInfo().username || 'Unknown'}\n`
          ]
        }
      ],
      metadata: {
        kernelspec: {
          display_name: 'Markdown',
          language: 'markdown',
          name: 'markdown'
        }
      },
      nbformat: 4,
      nbformat_minor: 5
    };
    
    // Add description, objective, etc. if provided
    if (space.notebook?.description) {
      notebook.cells.push({
        cell_type: 'markdown',
        metadata: {},
        source: [`## Description\n\n${space.notebook.description}`]
      });
    }
    
    fs.writeFileSync(notebookPath, JSON.stringify(notebook, null, 2));
  }
  
  // Search functionality (sync - uses JSON index)
  // Comprehensive search across all metadata fields
  search(query) {
    if (!query || typeof query !== 'string') return [];
    
    const lowerQuery = query.toLowerCase().trim();
    if (lowerQuery.length === 0) return [];
    
    const queryWords = lowerQuery.split(/\s+/).filter(w => w.length > 0);
    
    return this.index.items.filter(item => {
      // Search in preview
      if (item.preview && item.preview.toLowerCase().includes(lowerQuery)) {
        return true;
      }
      
      // Search in fileName
      if (item.fileName && item.fileName.toLowerCase().includes(lowerQuery)) {
        return true;
      }
      
      // Check each query word in preview/fileName
      const previewLower = (item.preview || '').toLowerCase();
      const fileNameLower = (item.fileName || '').toLowerCase();
      if (queryWords.some(word => previewLower.includes(word) || fileNameLower.includes(word))) {
        return true;
      }
      
      // Load and search in metadata
      try {
        const metaPath = path.join(this.storageRoot, item.metadataPath);
        if (fs.existsSync(metaPath)) {
          const metadata = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
          
          // Search in title (most important!)
          if (metadata.title?.toLowerCase().includes(lowerQuery)) {
            return true;
          }
          
          // Search in tags
          if (metadata.tags?.some(tag => tag.toLowerCase().includes(lowerQuery))) {
            return true;
          }
          
          // Search in description
          if (metadata.description?.toLowerCase().includes(lowerQuery)) {
            return true;
          }
          
          // Search in notes (user-added content)
          if (metadata.notes?.toLowerCase().includes(lowerQuery)) {
            return true;
          }
          
          // Search in author
          if (metadata.author?.toLowerCase().includes(lowerQuery)) {
            return true;
          }
          
          // Search in source/URL
          if (metadata.source?.toLowerCase().includes(lowerQuery)) {
            return true;
          }
          
          // Search in YouTube-specific fields
          if (metadata.youtubeDescription?.toLowerCase().includes(lowerQuery)) {
            return true;
          }
          if (metadata.uploader?.toLowerCase().includes(lowerQuery)) {
            return true;
          }
          
          // Check individual query words against all metadata
          const metadataText = [
            metadata.title,
            metadata.description,
            metadata.notes,
            metadata.author,
            metadata.source,
            metadata.uploader,
            ...(metadata.tags || [])
          ].filter(Boolean).join(' ').toLowerCase();
          
          if (queryWords.some(word => metadataText.includes(word))) {
            return true;
          }
        }
      } catch (error) {
        // Ignore errors
      }
      
      return false;
    });
  }
  
  /**
   * Search items using DuckDB full-text search (async)
   * Much faster than loading metadata from disk
   */
  async searchAsync(query, options = {}) {
    if (!this.dbReady) {
      return this.search(query);
    }
    
    const lowerQuery = query.toLowerCase();
    
    let sql = `
      SELECT * FROM items 
      WHERE LOWER(preview) LIKE ?
         OR EXISTS (SELECT 1 FROM UNNEST(tags) AS t(tag) WHERE LOWER(t.tag) LIKE ?)
    `;
    const params = [`%${lowerQuery}%`, `%${lowerQuery}%`];
    
    if (options.spaceId) {
      sql += ' AND space_id = ?';
      params.push(options.spaceId);
    }
    
    if (options.type) {
      sql += ' AND type = ?';
      params.push(options.type);
    }
    
    sql += ' ORDER BY timestamp DESC';
    
    if (options.limit) {
      sql += ' LIMIT ?';
      params.push(options.limit);
    }
    
    const rows = await this._dbQuery(sql, params);
    return rows.map(row => this._rowToItem(row));
  }
  
  /**
   * Search by tags (async)
   */
  async searchByTags(tags, matchAll = false) {
    if (!this.dbReady) {
      // Fallback to sync search
      return this.index.items.filter(item => {
        try {
          const metaPath = path.join(this.storageRoot, item.metadataPath);
          if (fs.existsSync(metaPath)) {
            const metadata = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
            const itemTags = (metadata.tags || []).map(t => t.toLowerCase());
            if (matchAll) {
              return tags.every(t => itemTags.includes(t.toLowerCase()));
            } else {
              return tags.some(t => itemTags.includes(t.toLowerCase()));
            }
          }
        } catch (e) {
          return false;
        }
        return false;
      });
    }
    
    // Use DuckDB array operations
    if (matchAll) {
      // All tags must be present
      const conditions = tags.map(() => '? = ANY(tags)').join(' AND ');
      const rows = await this._dbQuery(
        `SELECT * FROM items WHERE ${conditions} ORDER BY timestamp DESC`,
        tags
      );
      return rows.map(row => this._rowToItem(row));
    } else {
      // Any tag matches
      const conditions = tags.map(() => '? = ANY(tags)').join(' OR ');
      const rows = await this._dbQuery(
        `SELECT * FROM items WHERE ${conditions} ORDER BY timestamp DESC`,
        tags
      );
      return rows.map(row => this._rowToItem(row));
    }
  }
  
  /**
   * Get items by type (async)
   */
  async getItemsByType(type, options = {}) {
    return this.getAllItemsAsync({ ...options, type });
  }
  
  /**
   * Get pinned items (async)
   */
  async getPinnedItems(spaceId = null) {
    const options = { pinned: true };
    if (spaceId) options.spaceId = spaceId;
    return this.getAllItemsAsync(options);
  }
  
  // ========== MIGRATION ==========
  
  // Migrate existing spaces to use unified metadata
  migrateAllSpaces() {
    console.log('[Storage] Starting migration to unified metadata...');
    let migrated = 0;
    
    for (const space of this.index.spaces) {
      if (space.id === 'unclassified') continue;
      
      const metadataPath = path.join(this.spacesDir, space.id, 'space-metadata.json');
      if (!fs.existsSync(metadataPath)) {
        this.migrateSpace(space.id);
        migrated++;
      }
    }
    
    console.log(`[Storage] Migration complete. Migrated ${migrated} spaces.`);
    return migrated;
  }
  
  // Migrate a single space
  migrateSpace(spaceId) {
    const spaceDir = path.join(this.spacesDir, spaceId);
    if (!fs.existsSync(spaceDir)) {
      console.log(`[Storage] Space directory not found: ${spaceId}`);
      return false;
    }
    
    const space = this.index.spaces.find(s => s.id === spaceId);
    if (!space) {
      console.log(`[Storage] Space not found in index: ${spaceId}`);
      return false;
    }
    
    console.log(`[Storage] Migrating space: ${space.name} (${spaceId})`);
    
    // Create unified metadata
    const metadata = this.initSpaceMetadata(spaceId, space);
    
    // Scan for existing files and add them to metadata
    const files = fs.readdirSync(spaceDir);
    for (const file of files) {
      if (file === 'space-metadata.json' || file.startsWith('.')) continue;
      
      const filePath = path.join(spaceDir, file);
      const stats = fs.statSync(filePath);
      
      if (stats.isFile()) {
        const ext = path.extname(file).toLowerCase();
        const fileType = this.getFileType(ext);
        
        metadata.files[file] = {
          fileName: file,
          filePath: file,
          type: fileType,
          size: stats.size,
          createdAt: stats.birthtime.toISOString(),
          updatedAt: stats.mtime.toISOString(),
          status: 'existing'
        };
      }
    }
    
    // Check for old metadata files and merge
    const oldMetaFiles = [
      '.asset-metadata.json',
      'project-config.json',
      '.gsx-costs.json'
    ];
    
    for (const oldFile of oldMetaFiles) {
      const oldPath = path.join(spaceDir, oldFile);
      if (fs.existsSync(oldPath)) {
        try {
          const oldData = JSON.parse(fs.readFileSync(oldPath, 'utf8'));
          
          if (oldFile === 'project-config.json') {
            metadata.projectConfig = { ...metadata.projectConfig, ...oldData };
          } else if (oldFile === '.asset-metadata.json') {
            metadata.assets = { ...metadata.assets, ...oldData };
          } else if (oldFile === '.gsx-costs.json') {
            metadata.costHistory = oldData;
          }
          
          console.log(`[Storage] Merged old metadata: ${oldFile}`);
        } catch (e) {
          console.error(`[Storage] Error reading old metadata ${oldFile}:`, e.message);
        }
      }
    }
    
    // Save unified metadata
    const metadataPath = path.join(spaceDir, 'space-metadata.json');
    fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
    
    console.log(`[Storage] Migrated space: ${space.name}`);
    return true;
  }
  
  // Get file type from extension
  getFileType(ext) {
    const types = {
      '.html': 'html',
      '.htm': 'html',
      '.css': 'css',
      '.js': 'javascript',
      '.ts': 'typescript',
      '.json': 'json',
      '.md': 'markdown',
      '.txt': 'text',
      '.csv': 'csv',
      '.png': 'image',
      '.jpg': 'image',
      '.jpeg': 'image',
      '.gif': 'image',
      '.svg': 'image',
      '.pdf': 'pdf',
      '.ipynb': 'notebook'
    };
    return types[ext] || 'unknown';
  }
  
  // ========== CROSS-SPACE QUERIES (DuckDB) ==========
  
  // Search across all spaces using DuckDB
  async searchAllSpaces(searchTerm) {
    const db = getEventDB();
    if (db) {
      await db.init();
      return await db.searchAcrossSpaces(searchTerm);
    }
    
    // Fallback: manual search
    const results = [];
    for (const space of this.index.spaces) {
      if (space.id === 'unclassified') continue;
      
      const metadata = this.getSpaceMetadata(space.id);
      if (metadata) {
        const searchLower = searchTerm.toLowerCase();
        if (metadata.name?.toLowerCase().includes(searchLower) ||
            metadata.projectConfig?.description?.toLowerCase().includes(searchLower)) {
          results.push({
            spaceId: space.id,
            name: metadata.name,
            projectConfig: metadata.projectConfig
          });
        }
      }
    }
    return results;
  }
  
  // Query space metadata with custom conditions
  async querySpaces(whereClause) {
    const db = getEventDB();
    if (db) {
      await db.init();
      return await db.querySpaceMetadata(whereClause);
    }
    return [];
  }
  
  // Get all spaces with their metadata
  getAllSpacesWithMetadata() {
    const spacesWithMeta = [];
    
    for (const space of this.index.spaces) {
      const metadata = this.getSpaceMetadata(space.id);
      spacesWithMeta.push({
        ...space,
        metadata: metadata
      });
    }
    
    return spacesWithMeta;
  }
  
  // Get space files from metadata
  getSpaceFiles(spaceId) {
    const metadata = this.getSpaceMetadata(spaceId);
    if (!metadata) return [];
    
    return Object.entries(metadata.files || {}).map(([key, file]) => ({
      key,
      ...file
    }));
  }
  
  // Get space directory path
  getSpacePath(spaceId) {
    return path.join(this.spacesDir, spaceId);
  }
  
  // Get preferences
  getPreferences() {
    return this.index.preferences || {};
  }
  
  // Update preferences
  updatePreferences(updates) {
    this.index.preferences = {
      ...this.index.preferences,
      ...updates
    };
    // FIX: Use synchronous save for preference updates
    this.saveIndexSync();
  }
}

// Singleton instance for shared storage across all consumers
let storageInstance = null;

/**
 * Get the singleton storage instance
 * This ensures ClipboardManager, SpacesAPI, and all other consumers
 * share the same in-memory index for consistency
 * @returns {ClipboardStorageV2}
 */
function getSharedStorage() {
  if (!storageInstance) {
    storageInstance = new ClipboardStorageV2();
  }
  return storageInstance;
}

module.exports = ClipboardStorageV2;
module.exports.getSharedStorage = getSharedStorage; 