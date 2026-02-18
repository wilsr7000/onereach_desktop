const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const MetadataSchema = require('./lib/metadata-schema');

// Handle Electron imports gracefully
let app;
try {
  const electron = require('electron');
  app = electron.app;
} catch (_e) {
  // Not in Electron environment
  app = null;
}

// Structured logging
const { getLogQueue } = require('./lib/log-event-queue');
const log = getLogQueue();

const {
  UNCLASSIFIED_SPACE,
  GSX_AGENT_SPACE,
  GSX_AGENT_SPACE_NAME,
  GSX_AGENT_SPACE_ICON,
  GSX_AGENT_SPACE_COLOR,
  SYSTEM_ITEMS,
  PROTECTED_ITEM_IDS,
} = require('./lib/spaces-constants');

// DuckDB for primary storage and cross-space queries
let DuckDB = null;
try {
  DuckDB = require('@duckdb/node-api');
} catch (_e) {
  log.warn('clipboard', '@duckdb/node-api not installed, falling back to JSON');
}

// Legacy: DuckDB for cross-space queries (to be merged)
let eventDB = null;
function getEventDB() {
  if (!eventDB) {
    try {
      const { getEventDB: getDB } = require('./event-db');
      eventDB = getDB();
    } catch (e) {
      log.warn('clipboard', 'EventDB not available', { error: e.message });
    }
  }
  return eventDB;
}

/**
 * Extract custom metadata fields that don't belong to known schema fields.
 * These are preserved in the extensions namespace to avoid data loss.
 * @param {Object} meta - Raw metadata object passed by caller
 * @returns {Object} Object with custom fields placed in extensions
 */
function _extractCustomMetadata(meta) {
  if (!meta || typeof meta !== 'object') return {};

  // Fields that are handled explicitly by the schema factory
  const knownFields = new Set([
    'title',
    'description',
    'author',
    'source',
    'sourceUrl',
    'sourceApp',
    'tags',
    'notes',
    'pinned',
    'language',
    'scenes',
    'conversationId',
    'threadId',
    'participants',
    'channel',
    'ai_metadata_generated',
    'ai_metadata_timestamp',
    'space_context_used',
    'gsxPush',
    'youtubeUrl',
    'youtubeDescription',
    'uploader',
    'fileSize',
    'mimeType',
  ]);

  const custom = {};
  for (const key of Object.keys(meta)) {
    if (!knownFields.has(key)) {
      custom[key] = meta[key];
    }
  }

  // If there are custom fields, put them in extensions.custom
  if (Object.keys(custom).length > 0) {
    return { extensions: { custom } };
  }

  return {};
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

    // Transaction serialization lock (prevents nested/overlapping BEGIN TRANSACTION)
    this._txQueue = Promise.resolve();

    // Ensure directories exist
    this.ensureDirectories();

    // Load or create index (legacy JSON - kept for migration/backup)
    this.index = this.loadIndex();

    // In-memory cache for performance (must be before ensureGSXAgentDefaultFiles which calls addItem)
    this.cache = new Map();
    this.cacheSize = 100; // Keep last 100 items in cache

    // Create default GSX Agent context files (after index is loaded)
    this.ensureGSXAgentDefaultFiles();

    // Initialize DuckDB asynchronously
    this._initDuckDB();

    // Ensure all spaces have metadata files (including unclassified)
    this.ensureAllSpacesHaveMetadata();

    // Ensure system spaces exist (Web Monitors, etc.)
    this.ensureSystemSpaces();

    // PERFORMANCE: Debounce save operations (for legacy JSON backup)
    this._saveTimeout = null;
    this._pendingIndex = null;
    this._saveInProgress = false; // Track if async save is running
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
      log.info('clipboard', 'DuckDB not available, using JSON-only mode');
      return false;
    }

    try {
      dbPath: log.info('clipboard', 'Initializing DuckDB at', { dbPath: this.dbPath });

      // Create DuckDB instance (persistent file)
      this.dbInstance = await DuckDB.DuckDBInstance.create(this.dbPath);
      this.dbConnection = await this.dbInstance.connect();

      // Create schema
      await this._createSchema();

      // Check if migration is needed
      const itemCount = await this._dbGetItemCount();
      if (itemCount === 0 && this.index.items.length > 0) {
        log.info('clipboard', 'DuckDB empty but JSON has data - migrating...');
        await this._migrateFromJSON();
      }

      this.dbReady = true;
      log.info('clipboard', 'DuckDB initialized successfully');
      return true;
    } catch (error) {
      log.error('clipboard', 'Failed to initialize DuckDB', { error: error.message || error });
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
        space_id TEXT NOT NULL DEFAULT '${UNCLASSIFIED_SPACE}',
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
    } catch (_e) {
      // Column already exists, ignore
    }

    // GSX Push columns - add if they don't exist (migration for existing DBs)
    const gsxColumns = [
      { name: 'gsx_push_status', type: "TEXT DEFAULT 'not_pushed'" },
      { name: 'gsx_file_url', type: 'TEXT' },
      { name: 'gsx_share_link', type: 'TEXT' },
      { name: 'gsx_graph_node_id', type: 'TEXT' },
      { name: 'gsx_visibility', type: 'TEXT' },
      { name: 'gsx_version', type: 'TEXT' },
      { name: 'gsx_pushed_hash', type: 'TEXT' },
      { name: 'gsx_local_hash', type: 'TEXT' },
      { name: 'gsx_pushed_at', type: 'TEXT' },
      { name: 'gsx_pushed_by', type: 'TEXT' },
      { name: 'gsx_unpushed_at', type: 'TEXT' },
    ];

    for (const col of gsxColumns) {
      try {
        await this._dbRun(`ALTER TABLE items ADD COLUMN ${col.name} ${col.type}`);
      } catch (_e) {
        // Column already exists, ignore
      }
    }

    // Create index for GSX push status queries
    try {
      await this._dbRun('CREATE INDEX IF NOT EXISTS idx_items_gsx_status ON items(gsx_push_status)');
    } catch (_e) {
      // Index might already exist
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
      VALUES ('${UNCLASSIFIED_SPACE}', 'Unclassified', '◯', '#64c8ff')
    `);

    // Ensure GSX Agent context space exists (system space for agent context data)
    await this._dbRun(`
      INSERT OR IGNORE INTO spaces (id, name, icon, color) 
      VALUES ('${GSX_AGENT_SPACE}', '${GSX_AGENT_SPACE_NAME}', '${GSX_AGENT_SPACE_ICON}', '${GSX_AGENT_SPACE_COLOR}')
    `);

    log.info('clipboard', 'DuckDB schema created');
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
   * Check if an error indicates DuckDB connection/IO failure (caller may retry after reinit).
   */
  _isDuckDBConnectionError(err) {
    const msg = err && err.message ? String(err.message).toLowerCase() : '';
    return (
      msg.includes('closed') ||
      msg.includes('lock') ||
      msg.includes('io error') ||
      msg.includes('database is locked') ||
      msg.includes('connection') ||
      msg.includes('interrupted')
    );
  }

  /**
   * Mark DuckDB as unavailable and clear connection (call after connection-style errors).
   */
  _markDuckDBUnavailable() {
    this.dbReady = false;
    this.dbConnection = null;
    this.dbInstance = null;
    this.dbInitPromise = null;
    log.warn('clipboard', 'DuckDB marked unavailable; falling back to JSON-only mode');
  }

  /**
   * Execute a SQL statement (no results). On connection-style errors, marks DB unavailable and optionally retries once after reinit.
   * @param {string} sql - SQL statement
   * @param {Array} params - Optional parameters
   */
  async _dbRun(sql, params = []) {
    const run = async () => {
      if (!this.dbConnection) throw new Error('DuckDB not initialized');
      if (params.length === 0) {
        await this.dbConnection.run(sql);
        return;
      }
      const stmt = await this.dbConnection.prepare(sql);
      try {
        for (let i = 0; i < params.length; i++) {
          const param = params[i];
          const idx = i + 1;
          if (param === null || param === undefined) stmt.bindNull(idx);
          else if (typeof param === 'boolean') stmt.bindBoolean(idx, param);
          else if (typeof param === 'number') {
            if (Number.isInteger(param)) stmt.bindBigInt(idx, BigInt(param));
            else stmt.bindDouble(idx, param);
          } else if (typeof param === 'string') stmt.bindVarchar(idx, param);
          else if (Array.isArray(param)) stmt.bindVarchar(idx, JSON.stringify(param));
          else stmt.bindVarchar(idx, String(param));
        }
        await stmt.run();
      } finally {
        stmt.destroySync();
      }
    };
    try {
      await run();
    } catch (err) {
      if (this._isDuckDBConnectionError(err)) {
        this._markDuckDBUnavailable();
        await this._initDuckDB();
        if (this.dbReady) await run();
        else throw err;
      } else {
        throw err;
      }
    }
  }

  /**
   * Run a function inside a serialized DB transaction.
   * Queues the work so only one BEGIN TRANSACTION is active at a time,
   * preventing "cannot start a transaction within a transaction" errors.
   * @param {Function} fn - Async function that receives no args and should call _dbRun() for its SQL
   */
  async _dbTransaction(fn) {
    // Chain onto the queue so transactions don't overlap
    const ticket = this._txQueue.then(async () => {
      await this._dbRun('BEGIN TRANSACTION');
      try {
        const result = await fn();
        await this._dbRun('COMMIT');
        return result;
      } catch (error) {
        try {
          await this._dbRun('ROLLBACK');
        } catch (_e) {
          /* ignore rollback errors */
        }
        throw error;
      }
    });
    // Update queue (ignore errors so queue keeps flowing)
    this._txQueue = ticket.catch((err) => {
      console.warn('[clipboard-storage-v2] tx queue:', err.message);
    });
    return ticket;
  }

  /**
   * Execute a SQL query and return all rows. On connection-style errors, marks DB unavailable and optionally retries once after reinit.
   * @param {string} sql - SQL query
   * @param {Array} params - Optional parameters
   * @returns {Array} Array of row arrays
   */
  async _dbQuery(sql, params = []) {
    const query = async () => {
      if (!this.dbConnection) throw new Error('DuckDB not initialized');
      if (params.length === 0) {
        const reader = await this.dbConnection.runAndReadAll(sql);
        return reader.getRows();
      }
      const stmt = await this.dbConnection.prepare(sql);
      try {
        for (let i = 0; i < params.length; i++) {
          const param = params[i];
          const idx = i + 1;
          if (param === null || param === undefined) stmt.bindNull(idx);
          else if (typeof param === 'boolean') stmt.bindBoolean(idx, param);
          else if (typeof param === 'number') {
            if (Number.isInteger(param)) stmt.bindBigInt(idx, BigInt(param));
            else stmt.bindDouble(idx, param);
          } else if (typeof param === 'string') stmt.bindVarchar(idx, param);
          else if (Array.isArray(param)) stmt.bindVarchar(idx, JSON.stringify(param));
          else stmt.bindVarchar(idx, String(param));
        }
        const reader = await stmt.runAndReadAll();
        return reader.getRows();
      } finally {
        stmt.destroySync();
      }
    };
    try {
      return await query();
    } catch (err) {
      if (this._isDuckDBConnectionError(err)) {
        this._markDuckDBUnavailable();
        await this._initDuckDB();
        if (this.dbReady) return await query();
        throw err;
      }
      throw err;
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
    } catch (_e) {
      return 0;
    }
  }

  // ========== MIGRATION FROM JSON ==========

  /**
   * Migrate data from index.json to DuckDB
   */
  async _migrateFromJSON() {
    log.info('clipboard', 'Starting migration from JSON to DuckDB...');

    try {
      // Use serialized transaction for atomic migration
      await this._dbTransaction(async () => {
        // Migrate spaces
        for (const space of this.index.spaces) {
          await this._dbRun(
            `
          INSERT OR REPLACE INTO spaces (id, name, color, icon, item_count)
          VALUES (?, ?, ?, ?, ?)
        `,
            [space.id, space.name, space.color || '#64c8ff', space.icon || '◯', space.itemCount || 0]
          );
        }
        log.info('clipboard', 'Migrated ... spaces', { indexCount: this.index.spaces.length });

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
            } catch (_e) {
              // Ignore metadata read errors
            }
          }

          await this._dbRun(
            `
          INSERT OR REPLACE INTO items (
            id, type, space_id, timestamp, preview, 
            content_path, thumbnail_path, metadata_path, tags, pinned,
            file_name, file_size, file_type, file_category, file_ext,
            is_screenshot, json_subtype, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
            [
              item.id,
              item.type,
              item.spaceId || UNCLASSIFIED_SPACE,
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
              new Date(item.timestamp).toISOString(),
            ]
          );
          itemsMigrated++;
        }
        log.info('clipboard', 'Migrated ... items', { itemsMigrated });

        // Migrate preferences
        if (this.index.preferences) {
          for (const [key, value] of Object.entries(this.index.preferences)) {
            await this._dbRun(
              `
            INSERT OR REPLACE INTO preferences (key, value)
            VALUES (?, ?)
          `,
              [key, JSON.stringify(value)]
            );
          }
        }

        log.info('clipboard', 'Migration completed successfully');
      }); // end _dbTransaction
    } catch (error) {
      log.error('clipboard', 'Migration failed', { error: error.message || error });
      throw error;
    }
  }

  /**
   * Rebuild DuckDB index from metadata.json files on disk
   * Use this for recovery when the database is corrupted
   */
  async rebuildIndexFromFiles() {
    log.info('clipboard', 'Rebuilding index from metadata files...');

    if (!this.dbReady) {
      await this.ensureDBReady();
    }

    try {
      let rebuilt = 0;
      await this._dbTransaction(async () => {
        // Clear existing items
        await this._dbRun('DELETE FROM items');

        // Scan all item directories
        const itemDirs = fs.readdirSync(this.itemsDir);

        for (const itemId of itemDirs) {
          const itemDir = path.join(this.itemsDir, itemId);
          const metaPath = path.join(itemDir, 'metadata.json');

          if (!fs.existsSync(metaPath)) {
            log.warn('clipboard', 'No metadata.json found for item: ...', { itemId });
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
              } else if (file.startsWith('content.') || !file.includes('.')) {
                contentPath = `items/${itemId}/${file}`;
              } else if (!thumbnailPath && !contentPath) {
                // Assume it's the content file
                contentPath = `items/${itemId}/${file}`;
              }
            }

            // Insert into database
            await this._dbRun(
              `
              INSERT INTO items (
                id, type, space_id, timestamp, preview,
                content_path, thumbnail_path, metadata_path, tags, pinned,
                created_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `,
              [
                itemId,
                metadata.type || 'text',
                metadata.spaceId || UNCLASSIFIED_SPACE,
                metadata.dateCreated ? new Date(metadata.dateCreated).getTime() : Date.now(),
                metadata.preview || 'Item',
                contentPath,
                thumbnailPath,
                `items/${itemId}/metadata.json`,
                metadata.tags || [],
                false,
                metadata.dateCreated || new Date().toISOString(),
              ]
            );

            rebuilt++;
          } catch (_e) {
            log.error('clipboard', 'Error rebuilding item ...', { itemId });
          }
        }

        // Update space counts
        await this._dbRun(`
          UPDATE spaces SET item_count = (
            SELECT COUNT(*) FROM items WHERE items.space_id = spaces.id
          )
        `);
      }); // end _dbTransaction

      // Also sync to JSON index for backup
      await this._syncDBToJSON();

      log.info('clipboard', 'Rebuilt ... items from metadata files', { rebuilt });
      return rebuilt;
    } catch (error) {
      log.error('clipboard', 'Rebuild failed', { error: error.message || error });
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
      this.index.items = items.map((row) => this._rowToItem(row));
      this.index.spaces = spaces.map((row) => ({
        id: row[0],
        name: row[1],
        color: row[2],
        icon: row[3],
        itemCount: row[4],
      }));

      // Save JSON
      this.saveIndexSync();
      log.info('clipboard', 'Synced DB to JSON backup');
    } catch (e) {
      log.error('clipboard', 'Error syncing DB to JSON', { error: e.message || e });
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
      jsonSubtype: row[16],
    };
  }

  // Flush any pending async saves (call before app quit or reload)
  flushPendingSaves() {
    if (this._saveTimeout) {
      clearTimeout(this._saveTimeout);
      this._saveTimeout = null;
    }
    // If there's a pending index OR an async save is in progress,
    // save the current in-memory index synchronously to ensure consistency
    if (this._pendingIndex || this._saveInProgress) {
      // Always save the current this.index which has the latest state
      this.saveIndexSync(this.index);
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

    const index = this.index.items.findIndex((item) => item.id === itemId);
    if (index >= 0) {
      const item = this.index.items[index];

      // CRITICAL SAFETY CHECK: Never delete items that have files on disk!
      // Only remove truly orphaned items (where the directory/files are missing)
      if (item.type === 'file') {
        const itemDir = path.join(this.itemsDir, itemId);
        if (fs.existsSync(itemDir)) {
          // Check if there are actual content files
          try {
            const files = fs
              .readdirSync(itemDir)
              .filter((f) => !f.endsWith('.json') && !f.endsWith('.png') && !f.endsWith('.svg') && !f.startsWith('.'));
            if (files.length > 0) {
              log.error('clipboard', 'BLOCKED: Refusing to remove item ... - it has ... content file(s) on disk!', {
                itemId,
                filesCount: files.length,
              });
              log.error('clipboard', 'Files: ...', { detail: files.join(', ') });
              return false; // DO NOT DELETE - the item has real files!
            }
          } catch (_e) {
            // If we can't read the directory, don't delete
            log.error('clipboard', 'BLOCKED: Cannot verify item ... files, refusing to delete', { itemId });
            return false;
          }
        }
      } else if (item.contentPath) {
        const fullPath = path.join(this.storageRoot, item.contentPath);
        if (fs.existsSync(fullPath)) {
          log.error('clipboard', 'BLOCKED: Refusing to remove item ... - content file exists at ...', {
            itemId,
            contentPath: item.contentPath,
          });
          return false;
        }
      }

      // Only proceed with removal if files are truly missing
      this.index.items.splice(index, 1);
      log.info('clipboard', 'Removed orphaned item from index: ... (verified files missing)', { itemId });
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

    // CRITICAL FIX: Don't clean up items added in the last 60 seconds
    // This prevents race conditions where newly added items are incorrectly
    // identified as orphans before the file system has fully synced
    const GRACE_PERIOD_MS = 60000; // 60 seconds
    const now = Date.now();

    this.index.items = this.index.items.filter((item) => {
      // Skip items added recently (within grace period)
      const itemAge = now - (item.timestamp || 0);
      if (itemAge < GRACE_PERIOD_MS) {
        log.info('clipboard', 'Orphan cleanup: skipping ... (added ...s ago, within grace period)', {
          itemId: item.id,
          detail: Math.round(itemAge / 1000),
        });
        return true; // Keep the item
      }

      // For file-type items, check if the directory exists
      if (item.type === 'file') {
        const itemDir = path.join(this.itemsDir, item.id);
        if (!fs.existsSync(itemDir)) {
          removedItems.push(item.id);
          log.info('clipboard', 'Orphan cleanup: removing (directory missing)', { itemId: item.id });
          return false;
        }

        // Check if directory has any content files
        try {
          const files = fs
            .readdirSync(itemDir)
            .filter((f) => !f.endsWith('.json') && !f.endsWith('.png') && !f.endsWith('.svg') && !f.startsWith('.'));
          if (files.length === 0) {
            removedItems.push(item.id);
            log.info('clipboard', 'Orphan cleanup: removing (no content files)', { itemId: item.id });
            return false;
          }
        } catch (e) {
          removedItems.push(item.id);
          log.info('clipboard', 'Orphan cleanup: removing ... (read error: ...)', {
            itemId: item.id,
            error: e.message,
          });
          return false;
        }
      } else if (item.contentPath) {
        // For other types with contentPath, verify the file exists
        const fullPath = path.join(this.storageRoot, item.contentPath);
        if (!fs.existsSync(fullPath)) {
          removedItems.push(item.id);
          log.info('clipboard', 'Orphan cleanup: removing (contentPath missing)', { itemId: item.id });
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

      log.info('clipboard', 'Orphan cleanup complete: removed ... entries', { removed });
    }

    return removed;
  }

  ensureDirectories() {
    try {
      fs.mkdirSync(this.storageRoot, { recursive: true });
      fs.mkdirSync(this.itemsDir, { recursive: true });
      fs.mkdirSync(this.spacesDir, { recursive: true });
      this.ensureSpaceMetadata(UNCLASSIFIED_SPACE, {
        name: 'Unclassified',
        icon: '◯',
        color: '#64c8ff',
        isSystem: true,
      });
      this.ensureSpaceMetadata(GSX_AGENT_SPACE, {
        name: GSX_AGENT_SPACE_NAME,
        icon: GSX_AGENT_SPACE_ICON,
        color: GSX_AGENT_SPACE_COLOR,
        isSystem: true,
      });
    } catch (error) {
      log.error('clipboard', 'Failed to create storage directories', { error: error.message });
      throw new Error(`Spaces storage failed to initialize: ${error.message}`);
    }
  }

  /**
   * Ensure GSX Agent space has default context files
   * Creates main.md and agent-profile.md as proper indexed items
   */
  ensureGSXAgentDefaultFiles() {
    const mainId = SYSTEM_ITEMS.MAIN_CONTEXT;
    const profileId = SYSTEM_ITEMS.PROFILE;

    // Check if items already exist in index
    const mainExists = this.index?.items?.find((i) => i.id === mainId);
    const profileExists = this.index?.items?.find((i) => i.id === profileId);

    // Create main.md as indexed item
    if (!mainExists) {
      try {
        const mainContent = this.generateMainMdContent();
        this.addItem({
          id: mainId,
          type: 'text',
          content: mainContent,
          spaceId: GSX_AGENT_SPACE,
          pinned: true,
          metadata: {
            name: 'main.md',
            description: 'User and system context for AI agents',
            isProtected: true,
            category: 'context',
          },
        });
        log.info('clipboard', 'Created main.md item for GSX Agent space');
      } catch (e) {
        log.error('clipboard', 'Error creating main.md item', { error: e.message });
      }
    }

    // Create agent-profile.md as indexed item
    if (!profileExists) {
      try {
        const profileContent = this.generateAgentProfileContent();
        this.addItem({
          id: profileId,
          type: 'text',
          content: profileContent,
          spaceId: GSX_AGENT_SPACE,
          pinned: true,
          metadata: {
            name: 'agent-profile.md',
            description: 'Customize how your AI assistant behaves',
            isProtected: true,
            category: 'profile',
          },
        });
        log.info('clipboard', 'Created agent-profile.md item for GSX Agent space');
      } catch (e) {
        log.error('clipboard', 'Error creating agent-profile.md item', { error: e.message });
      }
    }
  }

  /**
   * Generate main.md content with real system data
   */
  generateMainMdContent() {
    const os = require('os');

    // Get user info
    const userInfo = os.userInfo();
    const homeDir = userInfo.homedir;
    const username = userInfo.username;

    // Get system info
    const platform = os.platform();
    const release = os.release();
    const arch = os.arch();
    const hostname = os.hostname();

    // Get timezone
    let timezone = 'Unknown';
    try {
      timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch (_ignored) {
      /* Intl unavailable, use fallback */
    }

    // Get timezone offset
    const offset = new Date().getTimezoneOffset();
    const offsetHours = Math.abs(Math.floor(offset / 60));
    const offsetMins = Math.abs(offset % 60);
    const offsetSign = offset <= 0 ? '+' : '-';
    const offsetStr = `${offsetSign}${String(offsetHours).padStart(2, '0')}:${String(offsetMins).padStart(2, '0')}`;

    // Get locale
    let language = 'en-US';
    let region = 'US';
    try {
      const locale = process.env.LANG || process.env.LC_ALL || 'en_US.UTF-8';
      const parts = locale.split('.')[0].split('_');
      language = parts.join('-');
      region = parts[1] || 'US';
    } catch (_ignored) {
      /* locale parse failed, use defaults */
    }

    // Get installed apps (macOS)
    let apps = [];
    if (platform === 'darwin') {
      try {
        const appsDir = '/Applications';
        if (fs.existsSync(appsDir)) {
          apps = fs
            .readdirSync(appsDir)
            .filter((f) => f.endsWith('.app'))
            .map((f) => f.replace('.app', ''))
            .sort()
            .slice(0, 50); // Limit to 50 apps
        }
      } catch (err) {
        console.warn('[clipboard-storage-v2] list apps:', err.message);
      }
    }

    // Map platform to friendly name
    const osName = platform === 'darwin' ? 'macOS' : platform === 'win32' ? 'Windows' : 'Linux';

    let content = `# GSX Agent Context

## User
name: ${userInfo.username}
username: ${username}
home: ${homeDir}

## System
os: ${osName}
version: ${release}
arch: ${arch}
hostname: ${hostname}

## Timezone
timezone: ${timezone}
offset: ${offsetStr}

## Locale
language: ${language}
region: ${region}

## Location
city: 
state: 
country: 

## Preferences
units: imperial
temperature: fahrenheit

## Installed Apps
`;

    // Add apps
    for (const app of apps) {
      content += `- ${app}\n`;
    }

    return content;
  }

  /**
   * Generate agent-profile.md with default settings
   */
  generateAgentProfileContent() {
    return `# Agent Profile

## Identity
name: Atlas
role: Personal Assistant

## Personality
tone: friendly
humor: light
formality: casual

## Communication
greeting: Hey there!
signoff: Let me know if you need anything else.
verbosity: brief
use_emoji: false

## Preferences
confirm_actions: true
proactive_suggestions: true
`;
  }

  // Ensure a space has a directory and metadata file
  ensureSpaceMetadata(spaceId, spaceInfo) {
    const spaceDir = path.join(this.spacesDir, spaceId);
    fs.mkdirSync(spaceDir, { recursive: true });

    const metadataPath = path.join(spaceDir, 'space-metadata.json');
    if (!fs.existsSync(metadataPath)) {
      this.initSpaceMetadata(spaceId, spaceInfo);
      log.info('clipboard', 'Created space-metadata.json for space', { spaceId });
    }
  }

  // Ensure all spaces in index have metadata files
  ensureAllSpacesHaveMetadata() {
    if (!this.index || !this.index.spaces) return;

    for (const space of this.index.spaces) {
      this.ensureSpaceMetadata(space.id, space);
    }
    log.info('clipboard', 'Verified metadata files for all', { arg1: this.index.spaces.length, arg2: 'spaces' });
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
        isSystem: true,
      },
      {
        id: GSX_AGENT_SPACE,
        name: GSX_AGENT_SPACE_NAME,
        icon: GSX_AGENT_SPACE_ICON,
        color: '#8b5cf6',
        isSystem: true,
      },
    ];

    for (const systemSpace of systemSpaces) {
      const existsById = this.index.spaces.find((s) => s.id === systemSpace.id);
      const existsByName = this.index.spaces.find((s) => s.name === systemSpace.name && s.id !== systemSpace.id);

      if (existsByName && !existsById) {
        // Migration: There's an existing space with the same name but different ID
        // We need to update the ID and migrate all items
        const oldId = existsByName.id;
        log.info('clipboard', 'Migrating system space "..." from ID "..." to "..."', {
          systemSpaceName: systemSpace.name,
          oldId,
          systemSpaceId: systemSpace.id,
        });

        // Update the space properties
        existsByName.id = systemSpace.id;
        existsByName.icon = systemSpace.icon;
        existsByName.color = systemSpace.color;
        existsByName.isSystem = true;

        // Migrate all items in this space
        let migratedCount = 0;
        this.index.items.forEach((item) => {
          if (item.spaceId === oldId) {
            item.spaceId = systemSpace.id;
            migratedCount++;
          }
        });

        log.info('clipboard', 'Migrated ... items to new space ID', { migratedCount });

        // Save the index
        this.saveIndexSync();
        log.info('clipboard', `[Storage] System space migration complete`);
      } else if (!existsById) {
        logName: log.info('clipboard', 'Creating system space: ...', { systemSpaceName: systemSpace.name });
        try {
          this.createSpace(systemSpace);
        } catch (_error) {
          log.error('clipboard', 'Failed to create system space ...', { systemSpaceId: systemSpace.id });
        }
      } else {
        // Update existing space properties if needed
        let needsSave = false;

        if (!existsById.isSystem) {
          existsById.isSystem = true;
          needsSave = true;
          log.info('clipboard', 'Marked existing space ... as system', { systemSpaceId: systemSpace.id });
        }

        // Update icon if it's not a proper SVG (fix for corrupted icons)
        if (!existsById.icon || !existsById.icon.includes('<svg')) {
          existsById.icon = systemSpace.icon;
          needsSave = true;
          log.info('clipboard', 'Updated icon for system space ...', { systemSpaceId: systemSpace.id });
        }

        if (needsSave) {
          this.saveIndexSync();
        }
      }
    }
  }

  /**
   * Return a fresh default index structure (used when primary and backup are corrupt or missing).
   */
  _getDefaultIndex() {
    return {
      version: '2.0',
      lastModified: new Date().toISOString(),
      items: [],
      spaces: [
        { id: UNCLASSIFIED_SPACE, name: 'Unclassified', icon: '◯', color: '#64c8ff', isSystem: true },
        {
          id: GSX_AGENT_SPACE,
          name: GSX_AGENT_SPACE_NAME,
          icon: GSX_AGENT_SPACE_ICON,
          color: GSX_AGENT_SPACE_COLOR,
          isSystem: true,
        },
      ],
      preferences: {
        spacesEnabled: true,
        screenshotCaptureEnabled: false,
        currentSpace: UNCLASSIFIED_SPACE,
      },
    };
  }

  loadIndex() {
    if (fs.existsSync(this.indexPath)) {
      try {
        const data = fs.readFileSync(this.indexPath, 'utf8');
        const parsed = JSON.parse(data);
        return parsed;
      } catch (error) {
        log.error('clipboard', 'Error loading index, checking backup', { error: error.message });
        const backupPath = this.indexPath + '.backup';
        if (fs.existsSync(backupPath)) {
          try {
            const backupData = fs.readFileSync(backupPath, 'utf8');
            const index = JSON.parse(backupData);
            this.saveIndex(index);
            return index;
          } catch (backupError) {
            log.error('clipboard', 'Backup also corrupt or unreadable, using default index', {
              error: backupError.message,
            });
            try {
              fs.renameSync(this.indexPath, this.indexPath + '.corrupt');
            } catch (_e) {
              // Ignore rename failure
            }
            try {
              fs.renameSync(backupPath, backupPath + '.corrupt');
            } catch (_e2) {
              // Ignore rename failure
            }
          }
        }
        return this._getDefaultIndex();
      }
    }
    return this._getDefaultIndex();
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

    log.info('clipboard', 'Index reloaded from disk');
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

  // Internal: Schedule an async save with debouncing (optional retryCount for retries after failure)
  _scheduleAsyncSave(index, retryCount = 0) {
    if (this._saveTimeout) {
      clearTimeout(this._saveTimeout);
    }
    this._pendingIndex = index;
    this._pendingRetryCount = retryCount;
    const delay = retryCount > 0 ? 2000 : 100; // 2s backoff on retry
    this._saveTimeout = setTimeout(() => {
      this._performAsyncSave();
    }, delay);
  }

  /** Max retries for async index save on transient failure */
  static ASYNC_SAVE_MAX_RETRIES = 2;

  // Internal: Perform the actual async save (retries on failure up to ASYNC_SAVE_MAX_RETRIES)
  async _performAsyncSave() {
    if (!this._pendingIndex) return;

    // Prevent concurrent saves -- queue if one is in progress
    if (this._saveInProgress) {
      return; // debounce will reschedule
    }

    this._saveInProgress = true;
    const index = this._pendingIndex;
    const retryCount = this._pendingRetryCount || 0;
    this._pendingIndex = null;
    this._saveTimeout = null;
    this._pendingRetryCount = 0;

    // Unique temp path per save to avoid race between overlapping operations
    const tempPath = this.indexPath + '.async-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6) + '.tmp';
    const backupPath = this.indexPath + '.backup';

    try {
      const fsPromises = fs.promises;
      // Ensure parent directory exists
      const dir = path.dirname(this.indexPath);
      await fsPromises
        .mkdir(dir, { recursive: true })
        .catch((err) => console.warn('[clipboard-storage-v2] mkdir:', err.message));

      await fsPromises.writeFile(tempPath, JSON.stringify(index, null, 2));
      try {
        await fsPromises.access(this.indexPath);
        await fsPromises.copyFile(this.indexPath, backupPath);
      } catch (_e) {
        // File doesn't exist, no backup needed
      }
      await fsPromises.rename(tempPath, this.indexPath);
      log.info('clipboard', 'Index saved asynchronously');
    } catch (error) {
      log.error('clipboard', 'Error saving index', { error: error.message });
      try {
        await fs.promises
          .unlink(tempPath)
          .catch((err) => console.warn('[clipboard-storage-v2] unlink temp:', err.message));
      } catch (_e) {
        // Ignore cleanup errors
      }
      if (retryCount < ClipboardStorageV2.ASYNC_SAVE_MAX_RETRIES) {
        log.info('clipboard', 'Will retry async save in 2s');
        this._scheduleAsyncSave(index, retryCount + 1);
      }
    } finally {
      this._saveInProgress = false;
      // If new data arrived while we were saving, kick off another save
      if (this._pendingIndex) {
        this._scheduleAsyncSave(this._pendingIndex, 0);
      }
    }
  }

  // Synchronous save for critical operations (e.g., before app quit)
  saveIndexSync(index = this.index) {
    // Use unique temp path to avoid race with debounced saveIndex()
    const tempPath = this.indexPath + '.sync-tmp';
    const backupPath = this.indexPath + '.backup';

    // Update lastModified
    index.lastModified = new Date().toISOString();

    try {
      // Ensure parent directory exists (guard against ENOENT)
      const dir = path.dirname(this.indexPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      // Write to temp file
      fs.writeFileSync(tempPath, JSON.stringify(index, null, 2));

      // Backup current if exists
      if (fs.existsSync(this.indexPath)) {
        fs.copyFileSync(this.indexPath, backupPath);
      }

      // Atomic rename
      fs.renameSync(tempPath, this.indexPath);

      log.info('clipboard', 'Index saved synchronously');
    } catch (error) {
      log.error('clipboard', 'Error saving index', { error: error.message || error });
      // Clean up temp file if it exists
      try {
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      } catch {
        /* ignore */
      }
      throw error;
    }
  }

  // Add new item (transactional - files + DB in single operation)
  addItem(item) {
    // Ensure GSX Agent space exists if adding to it
    if (item.spaceId === GSX_AGENT_SPACE) {
      const spaceExists = this.index?.spaces?.find((s) => s.id === GSX_AGENT_SPACE);
      if (!spaceExists) {
        log.info('clipboard', 'GSX Agent space not in index, creating it...');
        try {
          this.createSpace({
            id: GSX_AGENT_SPACE,
            name: GSX_AGENT_SPACE_NAME,
            icon: GSX_AGENT_SPACE_ICON,
            color: GSX_AGENT_SPACE_COLOR,
            isSystem: true,
          });
        } catch (_e) {
          // Space might already exist on disk, just ensure metadata
          this.ensureSpaceMetadata(GSX_AGENT_SPACE, {
            name: GSX_AGENT_SPACE_NAME,
            icon: GSX_AGENT_SPACE_ICON,
            color: GSX_AGENT_SPACE_COLOR,
            isSystem: true,
          });
        }
      }
    }

    const itemId = item.id || this.generateId();
    const itemDir = path.join(this.itemsDir, itemId);

    // Sanitize file name if present (removes quotes and other invalid characters)
    if (item.fileName) {
      const originalFileName = item.fileName;
      item.fileName = this.sanitizeFileName(item.fileName);
      if (item.fileName !== originalFileName) {
        log.info('clipboard', 'Sanitized filename: "..." -> "..."', { originalFileName, fileName: item.fileName });
      }
    }

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
      spaceId: item.spaceId || UNCLASSIFIED_SPACE,
      timestamp: timestamp,
      pinned: item.pinned || false,
      preview: this.generatePreview(item),
      contentPath: contentPath,
      thumbnailPath: thumbnailPath,
      metadataPath: metadataPath,
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

    // Add data-source specific properties
    if (item.type === 'data-source') {
      const ds = item.dataSource || {};
      indexEntry.sourceType = ds.sourceType || item.sourceType || null;
      indexEntry.dataSourceUrl = (ds.connection && ds.connection.url) || item.url || '';
      indexEntry.protocol = (ds.connection && ds.connection.protocol) || '';
      indexEntry.authType = (ds.auth && ds.auth.type) || 'none';
      indexEntry.dataSourceStatus = ds.status || item.status || 'inactive';
      indexEntry.lastTestedAt = ds.lastTestedAt || null;
      indexEntry.documentVisibility = (ds.document && ds.document.visibility) || 'private';
      indexEntry.name = item.name || (ds.mcp && ds.mcp.serverName) || '';
      indexEntry.dataSource = ds;
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

      // 4. Save metadata.json (SPACE framework v2.0 schema)
      const metadata = MetadataSchema.createItemMetadata({
        id: itemId,
        type: item.type,
        spaceId: indexEntry.spaceId,
        overrides: {
          dateCreated: new Date(timestamp).toISOString(),
          dateModified: new Date(timestamp).toISOString(),
          system: {
            source: item.source || 'clipboard',
            fileSize: item.fileSize || null,
            mimeType: item.mimeType || null,
          },
          physical: {
            sourceUrl: (item.metadata && item.metadata.sourceUrl) || item.sourceUrl || null,
            sourceApp: (item.metadata && item.metadata.sourceApp) || null,
          },
          attributes: {
            title: (item.metadata && item.metadata.title) || item.title || null,
            description: (item.metadata && item.metadata.description) || null,
            tags: tags,
            notes: (item.metadata && item.metadata.notes) || null,
          },
          events: {
            capturedAt: new Date(timestamp).toISOString(),
          },
          scenes: item.scenes || [],
          // Preserve any additional custom metadata passed by callers
          ...(item.metadata ? _extractCustomMetadata(item.metadata) : {}),
        },
      });

      fs.writeFileSync(path.join(itemDir, 'metadata.json'), JSON.stringify(metadata, null, 2));

      // 5. Insert into DuckDB (if ready) - this is the commit point
      if (this.dbReady) {
        this._addItemToDBSync(indexEntry, tags);
      }

      // 6. Update legacy JSON index (backup)
      this.index.items.unshift(indexEntry);
      this.updateSpaceCount(indexEntry.spaceId);

      // CRITICAL FIX: Use synchronous save for file additions to ensure index is persisted
      // before returning success. The debounced saveIndex() was causing race conditions
      // where the agent's orphan cleanup would run before the index was saved,
      // incorrectly identifying newly added items as orphans.
      this.saveIndexSync();

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
    const promise = this._addItemToDB(indexEntry, tags);
    promise.catch((err) => {
      log.warn('clipboard', 'DuckDB insert failed – JSON index is source of truth, will reconcile on next load', {
        itemId: indexEntry?.id,
        spaceId: indexEntry?.spaceId,
        error: err.message,
      });
    });
  }

  /**
   * Insert item into DuckDB
   */
  async _addItemToDB(indexEntry, tags) {
    if (!this.dbReady) return;

    await this._dbRun(
      `
      INSERT OR REPLACE INTO items (
        id, type, space_id, timestamp, preview,
        content_path, thumbnail_path, metadata_path, tags, pinned,
        file_name, file_size, file_type, file_category, file_ext,
        is_screenshot, json_subtype, created_at, modified_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      [
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
        new Date().toISOString(),
      ]
    );

    // Update space count
    await this._dbRun(
      `
      UPDATE spaces SET item_count = item_count + 1 WHERE id = ?
    `,
      [indexEntry.spaceId]
    );
  }

  /**
   * Clean up partial item files after failed transaction
   */
  _cleanupPartialItem(itemDir) {
    try {
      if (fs.existsSync(itemDir)) {
        fs.rmSync(itemDir, { recursive: true, force: true });
        log.info('clipboard', 'Cleaned up partial item', { itemDir });
      }
    } catch (e) {
      log.error('clipboard', 'Error cleaning up partial item', { error: e.message });
    }
  }

  // Load item with content
  loadItem(itemId) {
    // Check cache first
    if (this.cache.has(itemId)) {
      return this.cache.get(itemId);
    }

    // Find in index
    const indexEntry = this.index.items.find((item) => item.id === itemId);
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
        const files = fs
          .readdirSync(itemDir)
          .filter((f) => !f.endsWith('.json') && !f.endsWith('.png') && !f.endsWith('.svg') && !f.startsWith('.'));
        log.info('clipboard', 'Found files in ...', { itemId });

        if (files.length > 0) {
          // Prefer video files over audio files
          const videoExtensions = ['.mp4', '.webm', '.mkv', '.avi', '.mov', '.m4v'];
          const audioExtensions = ['.mp3', '.wav', '.aac', '.m4a', '.ogg'];

          // Sort: video files first, then non-audio, then audio
          const sortedFiles = files.sort((a, b) => {
            const aLower = a.toLowerCase();
            const bLower = b.toLowerCase();
            const aIsVideo = videoExtensions.some((ext) => aLower.endsWith(ext));
            const bIsVideo = videoExtensions.some((ext) => bLower.endsWith(ext));
            const aIsAudio = audioExtensions.some((ext) => aLower.endsWith(ext));
            const bIsAudio = audioExtensions.some((ext) => bLower.endsWith(ext));

            // Video first
            if (aIsVideo && !bIsVideo) return -1;
            if (!aIsVideo && bIsVideo) return 1;
            // Audio last
            if (aIsAudio && !bIsAudio) return 1;
            if (!aIsAudio && bIsAudio) return -1;
            return 0;
          });

          log.info('clipboard', `[Storage] Sorted files (video first):`);
          actualContentPath = path.join(itemDir, sortedFiles[0]);
          log.info('clipboard', `[Storage] Selected content path:`);

          // Verify the file exists and has content
          if (fs.existsSync(actualContentPath)) {
            const stats = fs.statSync(actualContentPath);
            if (stats.size > 0) {
              content = actualContentPath;
            } else {
              log.error('clipboard', 'File has 0 bytes: ...', { actualContentPath });
            }
          }
        } else {
          log.error('clipboard', 'No content file found in: ...', { itemDir });
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
      metadata,
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
    return rows.map((row) => this._rowToItem(row));
  }

  // Get items for a specific space
  getSpaceItems(spaceId) {
    return this.index.items.filter((item) => item.spaceId === spaceId);
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
    // Protect system context files
    if (PROTECTED_ITEM_IDS.includes(itemId)) {
      log.warn('clipboard', 'Cannot delete protected system item', { itemId });
      throw new Error('Cannot delete protected system file');
    }

    // Find in index first
    const itemIndex = this.index.items.findIndex((item) => item.id === itemId);
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
      log.error('clipboard', 'Error deleting item', { error: error.message || error });
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
    promise.catch((err) => {
      log.warn('clipboard', 'DuckDB delete failed – JSON index is source of truth, will reconcile on next load', {
        itemId,
        spaceId,
        error: err.message,
      });
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
      await this._dbRun(
        `
        UPDATE spaces SET item_count = GREATEST(0, item_count - 1) WHERE id = ?
      `,
        [spaceId]
      );
    }
  }

  // Move item to different space (transactional)
  moveItem(itemId, newSpaceId) {
    const item = this.index.items.find((item) => item.id === itemId);
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
      log.error('clipboard', 'Error moving item', { error: error.message || error });
      throw error;
    }
  }

  /**
   * Move item in DuckDB synchronously
   */
  _moveItemInDBSync(itemId, oldSpaceId, newSpaceId) {
    const promise = this._moveItemInDB(itemId, oldSpaceId, newSpaceId);
    promise.catch((err) => {
      log.warn('clipboard', 'DuckDB move failed – JSON index is source of truth, will reconcile on next load', {
        itemId,
        oldSpaceId,
        newSpaceId,
        error: err.message,
      });
    });
  }

  /**
   * Move item in DuckDB
   */
  async _moveItemInDB(itemId, oldSpaceId, newSpaceId) {
    if (!this.dbReady) return;

    await this._dbTransaction(async () => {
      // Update item
      await this._dbRun(
        `
        UPDATE items SET space_id = ?, modified_at = ? WHERE id = ?
      `,
        [newSpaceId, new Date().toISOString(), itemId]
      );

      // Update space counts
      await this._dbRun(
        `
        UPDATE spaces SET item_count = GREATEST(0, item_count - 1) WHERE id = ?
      `,
        [oldSpaceId]
      );

      await this._dbRun(
        `
        UPDATE spaces SET item_count = item_count + 1 WHERE id = ?
      `,
        [newSpaceId]
      );
    });
  }

  // Toggle pin (transactional)
  togglePin(itemId) {
    const item = this.index.items.find((item) => item.id === itemId);
    if (!item) {
      return false;
    }

    const newPinned = !item.pinned;
    item.pinned = newPinned;

    // Update DuckDB if ready
    if (this.dbReady) {
      this._dbRun('UPDATE items SET pinned = ?, modified_at = ? WHERE id = ?', [
        newPinned,
        new Date().toISOString(),
        itemId,
      ]).catch((err) => log.warn('clipboard', 'DB pin update deferred', { error: err.message }));
    }

    // FIX: Use synchronous save for pin updates to ensure persistence
    this.saveIndexSync();
    this.cache.delete(itemId); // Clear cache

    return newPinned;
  }

  // Update item index properties, metadata, and optionally content (transactional)
  updateItemIndex(itemId, updates) {
    const item = this.index.items.find((item) => item.id === itemId);
    if (!item) {
      return false;
    }

    const itemDir = path.join(this.itemsDir, itemId);

    // Handle metadata file updates (title, tags, author, source, etc.)
    const metadataFields = ['title', 'tags', 'author', 'source', 'description', 'scenes', 'metadata'];
    const hasMetadataUpdates = metadataFields.some((field) => updates[field] !== undefined);

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
        log.info('clipboard', 'Metadata file updated', {
          metadataPath,
          arg2: 'fields:',
          arg3: metadataFields.filter((f) => updates[f] !== undefined),
        });

        // Remove metadata fields from updates (they're in the file, not index)
        // But keep tags in updates since they're also in DuckDB
        for (const field of metadataFields) {
          if (field !== 'tags') {
            delete updates[field];
          }
        }
      } catch (err) {
        log.error('clipboard', 'Error updating metadata file', { error: err.message });
      }
    }

    // Handle content update if provided
    if (updates.content !== undefined) {
      try {
        if (fs.existsSync(itemDir)) {
          // Find existing content file
          const files = fs.readdirSync(itemDir);
          const contentFile = files.find((f) => f.startsWith('content.'));

          if (contentFile) {
            const contentPath = path.join(itemDir, contentFile);
            fs.writeFileSync(contentPath, updates.content, 'utf8');
            log.info('clipboard', 'Content file updated', { contentPath });

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
            log.info('clipboard', 'Content file created', { contentPath });
          }
        }
      } catch (err) {
        log.error('clipboard', 'Error updating content file', { error: err.message });
      }
      // Don't store content in the index - it's in the file
      delete updates.content;
    }

    // Apply updates to JSON index
    const _beforeState = { preview: item.preview, pinned: item.pinned, spaceId: item.spaceId };
    Object.assign(item, updates);
    item.timestamp = Date.now();

    // Update DuckDB if ready
    if (this.dbReady) {
      this._updateItemInDB(itemId, updates).catch((err) => {
        log.warn('clipboard', 'DB update deferred (will sync on next load)', { error: err.message });
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
      timestamp: 'timestamp',
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

    await this._dbRun(`UPDATE items SET ${setClauses.join(', ')} WHERE id = ?`, values);
  }

  // Space management (transactional)
  createSpace(space) {
    const spaceId = space.id || this.generateId();

    // Sanitize space name to be safe for GSX sync
    const sanitizedName = this.sanitizeFileName(space.name);
    if (sanitizedName !== space.name) {
      log.info('clipboard', 'Sanitized space name: "..." -> "..."', { spaceName: space.name, sanitizedName });
    }

    const newSpace = {
      id: spaceId,
      name: sanitizedName,
      icon: space.icon || '◯',
      color: space.color || '#64c8ff',
      itemCount: 0,
      isSystem: space.isSystem || false,
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
      log.error('clipboard', 'Error creating space', { error: error.message || error });
      throw error;
    }
  }

  /**
   * Create space in DuckDB synchronously
   */
  _createSpaceInDBSync(space) {
    const promise = this._createSpaceInDB(space);
    promise.catch((err) => log.warn('clipboard', 'DB space create deferred', { error: err.message }));
  }

  /**
   * Create space in DuckDB
   */
  async _createSpaceInDB(space) {
    if (!this.dbReady) return;

    await this._dbRun(
      `
      INSERT OR REPLACE INTO spaces (id, name, color, icon, item_count, is_system, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
      [
        space.id,
        space.name,
        space.color || '#64c8ff',
        space.icon || '◯',
        space.itemCount || 0,
        space.isSystem || false,
        new Date().toISOString(),
      ]
    );
  }

  // Initialize space metadata file (SPACE framework v2.0 schema)
  initSpaceMetadata(spaceId, space) {
    const metadataPath = path.join(this.spacesDir, spaceId, 'space-metadata.json');

    const metadata = MetadataSchema.createSpaceMetadata({
      id: spaceId,
      name: space.name,
      icon: space.icon || '◯',
      color: space.color || '#64c8ff',
      overrides: {
        physical: {
          storagePath: path.join(this.spacesDir, spaceId),
        },
        attributes: {
          isSystem: space.isSystem || false,
        },
      },
    });

    fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
    return metadata;
  }

  // Get space metadata (auto-migrates v1.0 to v2.0 SPACE schema on read)
  getSpaceMetadata(spaceId) {
    const metadataPath = path.join(this.spacesDir, spaceId, 'space-metadata.json');

    if (fs.existsSync(metadataPath)) {
      try {
        let metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));

        return metadata;
      } catch (e) {
        log.error('clipboard', 'Error reading space metadata', { error: e.message || e });
      }
    }

    // Create if doesn't exist
    const space = this.index.spaces.find((s) => s.id === spaceId);
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
      log.error('clipboard', 'Space not found', { spaceId });
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
      updatedAt: new Date().toISOString(),
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
      updatedAt: new Date().toISOString(),
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
      approvedBy: approvedBy,
    };

    return this.updateSpaceMetadata(spaceId, { approvals: metadata.approvals });
  }

  // Add version -- creates a Git commit via SpacesGit
  // Version history is tracked by Git, not metadata arrays.
  async addVersion(spaceId, versionData) {
    const { getSpacesGit } = require('./lib/spaces-git');
    const spacesGit = getSpacesGit();

    if (!spacesGit.isInitialized()) {
      log.warn('clipboard', 'Git not initialized -- cannot add version');
      return null;
    }

    const message = versionData.notes || versionData.message || `Version update for space ${spaceId}`;
    const authorName = versionData.author || 'system';

    // Commit all pending changes in this space
    const _spaceDir = `spaces/${spaceId}`;
    const result = await spacesGit.commitAll({
      message,
      authorName,
      authorEmail: `${authorName}@onereach.ai`,
    });

    return {
      sha: result.sha,
      message,
      author: authorName,
      createdAt: new Date().toISOString(),
      filesChanged: result.filesChanged,
    };
  }

  // Update project config
  updateProjectConfig(spaceId, configUpdates) {
    const metadata = this.getSpaceMetadata(spaceId);
    if (!metadata) return null;

    metadata.projectConfig = {
      ...metadata.projectConfig,
      ...configUpdates,
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
    const space = this.index.spaces.find((s) => s.id === spaceId);
    if (!space) {
      return false;
    }

    // Sanitize space name if being updated
    if (updates.name) {
      const sanitizedName = this.sanitizeFileName(updates.name);
      if (sanitizedName !== updates.name) {
        log.info('clipboard', 'Sanitized space name: "..." -> "..."', { updatesName: updates.name, sanitizedName });
        updates.name = sanitizedName;
      }
    }

    Object.assign(space, updates);

    // Update notebook if provided
    if (updates.notebook) {
      this.createSpaceNotebook(spaceId, { ...space, ...updates });
    }

    // Update DuckDB if ready
    if (this.dbReady) {
      this._updateSpaceInDB(spaceId, updates).catch((err) =>
        log.warn('clipboard', 'DB space update deferred', { error: err.message })
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
    await this._dbRun(`UPDATE spaces SET ${setClauses.join(', ')} WHERE id = ?`, values);
  }

  deleteSpace(spaceId) {
    if (spaceId === UNCLASSIFIED_SPACE) {
      throw new Error('Cannot delete unclassified space');
    }

    if (spaceId === GSX_AGENT_SPACE) {
      throw new Error('Cannot delete GSX Agent space');
    }

    // Check if this is a system space
    const space = this.index.spaces.find((s) => s.id === spaceId);
    if (space?.isSystem) {
      throw new Error('Cannot delete system space');
    }

    try {
      // 1. Update DuckDB (if ready) - move items and delete space
      if (this.dbReady) {
        this._deleteSpaceFromDBSync(spaceId);
      }

      // 2. Move all items to unclassified in JSON index
      this.index.items.forEach((item) => {
        if (item.spaceId === spaceId) {
          item.spaceId = UNCLASSIFIED_SPACE;

          // Also update metadata.json file
          try {
            const metaPath = path.join(this.storageRoot, item.metadataPath);
            if (fs.existsSync(metaPath)) {
              const metadata = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
              metadata.spaceId = UNCLASSIFIED_SPACE;
              fs.writeFileSync(metaPath, JSON.stringify(metadata, null, 2));
            }
          } catch (_e) {
            // Continue even if metadata update fails
          }
        }
      });

      // 3. Remove space from JSON index
      this.index.spaces = this.index.spaces.filter((s) => s.id !== spaceId);
      this.updateSpaceCount(UNCLASSIFIED_SPACE);
      this.saveIndexSync();

      // 4. Remove space directory
      const spaceDir = path.join(this.spacesDir, spaceId);
      if (fs.existsSync(spaceDir)) {
        fs.rmSync(spaceDir, { recursive: true, force: true });
      }

      return true;
    } catch (error) {
      log.error('clipboard', 'Error deleting space', { error: error.message || error });
      throw error;
    }
  }

  /**
   * Delete space from DuckDB synchronously
   */
  _deleteSpaceFromDBSync(spaceId) {
    const promise = this._deleteSpaceFromDB(spaceId);
    promise.catch((err) => log.warn('clipboard', 'DB space delete error (non-fatal)', { error: err.message }));
  }

  /**
   * Delete space from DuckDB
   */
  async _deleteSpaceFromDB(spaceId) {
    if (!this.dbReady) return;

    await this._dbTransaction(async () => {
      // Count items being moved
      const countResult = await this._dbQueryOne('SELECT COUNT(*) FROM items WHERE space_id = ?', [spaceId]);
      const itemCount = countResult ? Number(countResult[0]) : 0;

      // Move all items to unclassified
      await this._dbRun('UPDATE items SET space_id = ? WHERE space_id = ?', [UNCLASSIFIED_SPACE, spaceId]);

      // Update unclassified count
      await this._dbRun('UPDATE spaces SET item_count = item_count + ? WHERE id = ?', [itemCount, UNCLASSIFIED_SPACE]);

      // Delete space
      await this._dbRun('DELETE FROM spaces WHERE id = ?', [spaceId]);
    });
  }

  // Helper methods
  generateId() {
    return crypto.randomBytes(16).toString('hex');
  }

  /**
   * Sanitize a filename to be safe for storage and GSX sync
   * Removes characters that GSX and filesystems don't allow
   */
  sanitizeFileName(name) {
    if (!name) return name;
    return name
      .replace(/['"]/g, '') // Remove quotes (GSX doesn't allow them)
      .replace(/[/\\:*?<>|]/g, '-') // Replace invalid path characters
      .replace(/\s+/g, ' ') // Normalize spaces (keep single spaces for readability)
      .replace(/-{2,}/g, '-') // Replace multiple dashes with single
      .replace(/^[-\s]+|[-\s]+$/g, '') // Remove leading/trailing dashes and spaces
      .trim();
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
      const isBase64 =
        content.startsWith('data:') ||
        (content.length > 1000 && !content.includes('\n') && /^[A-Za-z0-9+/=]+$/.test(content.substring(0, 100)));

      if (!isBase64) {
        const detected = this.detectContentType(content);
        if (detected) return detected;
      }
    }

    // For file type, try magic-byte detection from the content buffer
    if (type === 'file' && content) {
      try {
        const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
        const detected = this.detectTypeFromBuffer(buf);
        if (detected) return detected;
      } catch (_e) {
        // Buffer conversion may fail on non-UTF8 content; fall through
      }
    }

    // Fallback based on type
    switch (type) {
      case 'text':
        return 'md';
      case 'html':
        return 'md';
      case 'file':
        return 'file';
      default:
        return 'md';
    }
  }

  /**
   * Detect file type from the first few bytes of a Buffer.
   * Returns an extension string or null if unrecognised.
   */
  detectTypeFromBuffer(buf) {
    if (!Buffer.isBuffer(buf) || buf.length < 4) return null;

    // PDF: %PDF
    if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) return 'pdf';
    // ZIP / DOCX / XLSX / JAR / EPUB: PK\x03\x04
    if (buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) return 'zip';
    // PNG: \x89PNG
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
    // JPEG: \xFF\xD8\xFF
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
    // GIF: GIF8
    if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return 'gif';
    // WebP: RIFF....WEBP
    if (
      buf[0] === 0x52 &&
      buf[1] === 0x49 &&
      buf[2] === 0x46 &&
      buf[3] === 0x46 &&
      buf.length >= 12 &&
      buf[8] === 0x57 &&
      buf[9] === 0x45 &&
      buf[10] === 0x42 &&
      buf[11] === 0x50
    )
      return 'webp';
    // GZIP: \x1F\x8B
    if (buf[0] === 0x1f && buf[1] === 0x8b) return 'gz';
    // RAR: Rar!
    if (buf[0] === 0x52 && buf[1] === 0x61 && buf[2] === 0x72 && buf[3] === 0x21) return 'rar';
    // TIFF: II or MM
    if (
      (buf[0] === 0x49 && buf[1] === 0x49 && buf[2] === 0x2a && buf[3] === 0x00) ||
      (buf[0] === 0x4d && buf[1] === 0x4d && buf[2] === 0x00 && buf[3] === 0x2a)
    )
      return 'tiff';

    return null;
  }

  // Detect content type and return appropriate extension
  detectContentType(content) {
    if (!content || typeof content !== 'string') return null;

    const trimmed = content.trim();

    // Quick magic-byte check for strings that may start with binary signatures
    if (trimmed.startsWith('%PDF')) return 'pdf';
    if (trimmed.startsWith('PK\x03\x04')) return 'zip';

    // Check for JSON
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      try {
        JSON.parse(trimmed);
        return 'json';
      } catch (_e) {
        // Not valid JSON, continue checking
      }
    }

    // Check for XML
    if (trimmed.startsWith('<?xml') || (trimmed.startsWith('<') && trimmed.includes('</') && !this.isHtml(trimmed))) {
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

    if (/^#{1,6}\s+.+/m.test(trimmed)) mdScore += 2; // Headers (strong indicator)
    if (/^\s*[-*+]\s+.+/m.test(trimmed)) mdScore += 1; // Unordered lists
    if (/^\s*\d+\.\s+.+/m.test(trimmed)) mdScore += 1; // Ordered lists
    if (/\[.+?\]\(.+?\)/.test(trimmed)) mdScore += 2; // Links (strong indicator)
    if (/!\[.*?\]\(.+?\)/.test(trimmed)) mdScore += 2; // Images (strong indicator)
    if (/^>\s+.+/m.test(trimmed)) mdScore += 1; // Blockquotes
    if (/```[\s\S]*?```/.test(trimmed)) mdScore += 2; // Fenced code blocks (strong indicator)
    if (/`[^`]+`/.test(trimmed)) mdScore += 1; // Inline code
    if (/\*\*[^*]+\*\*/.test(trimmed)) mdScore += 1; // Bold
    if (/__[^_]+__/.test(trimmed)) mdScore += 1; // Bold alt
    if (/(?<!\*)\*[^*\s][^*]*[^*\s]\*(?!\*)/.test(trimmed)) mdScore += 1; // Italic
    if (/(?<!_)_[^_\s][^_]*[^_\s]_(?!_)/.test(trimmed)) mdScore += 1; // Italic alt
    if (/^(-{3,}|\*{3,}|_{3,})$/m.test(trimmed)) mdScore += 1; // Horizontal rules
    if (/^\s*[-*]\s+\[[x ]\]/im.test(trimmed)) mdScore += 2; // Task lists (strong indicator)
    if (/\|.+\|.+\|/m.test(trimmed) && /\|[-:]+\|[-:]+\|/m.test(trimmed)) mdScore += 2; // Tables (strong indicator)

    if (mdScore >= 3) {
      return 'md';
    }

    // Check for URL
    if (/^https?:\/\/[^\s]+$/.test(trimmed)) {
      return 'url'; // Single URL - we'll handle this specially
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
      log.info('clipboard', 'Saved content as .... (detected from content)', { finalExt });
    } else if (item.type === 'image') {
      // Determine extension from data URL or default to png
      const ext = this.getExtension('image', item.content);
      const contentPath = path.join(itemDir, `content.${ext}`);
      const base64Data = item.content.replace(/^data:image\/[^;]+;base64,/, '');
      fs.writeFileSync(contentPath, Buffer.from(base64Data, 'base64'));
      log.info('clipboard', 'Saved image as ....', { ext });
    } else if (item.type === 'file' && item.filePath && item.fileName) {
      // Copy file with its original name
      if (fs.existsSync(item.filePath)) {
        const destPath = path.join(itemDir, item.fileName);
        try {
          fs.copyFileSync(item.filePath, destPath);
          log.info('clipboard', 'Successfully copied file from ... to ...', { filePath: item.filePath, destPath });

          // Verify the copy succeeded
          if (!fs.existsSync(destPath)) {
            throw new Error('File copy succeeded but destination file does not exist');
          }

          const sourceStats = fs.statSync(item.filePath);
          const destStats = fs.statSync(destPath);
          log.info('clipboard', 'Source size: ..., Dest size: ...', { size: sourceStats.size, size: destStats.size });

          // Verify sizes match
          if (sourceStats.size !== destStats.size) {
            log.error('clipboard', 'WARNING: File size mismatch! Source: ..., Dest: ...', {
              size: sourceStats.size,
              size: destStats.size,
            });
          }

          if (destStats.size === 0) {
            throw new Error('Copied file has 0 bytes');
          }
        } catch (error) {
          log.error('clipboard', 'CRITICAL: Error copying file: ...', { error: error.message });
          log.error('clipboard', 'Source: ..., Dest: ...', { filePath: item.filePath, destPath });
          throw new Error(`Failed to copy file: ${error.message}`);
        }
      } else {
        log.error('clipboard', 'CRITICAL: Source file not found: ...', { filePath: item.filePath });
        throw new Error(`Source file not found: ${item.filePath}`);
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
      log.info('clipboard', 'Saved file content directly as ...', { fileName });
    } else if (item.content) {
      // Fallback: save any item with content as text
      log.warn('clipboard', "Unhandled item type '...', saving content as text fallback", { type: item.type });
      const contentPath = path.join(itemDir, 'content.txt');
      fs.writeFileSync(contentPath, String(item.content), 'utf8');
    } else {
      log.error('clipboard', 'Cannot save item: no content and no file path. Type: ..., ID: ...', {
        type: item.type,
        itemId: item.id,
      });
    }
  }

  saveThumbnail(thumbnail, itemDir) {
    const isSvg = thumbnail.startsWith('data:image/svg+xml');
    const extension = isSvg ? 'svg' : 'png';
    const base64Data = thumbnail.replace(/^data:image\/[^;]+;base64,/, '');
    fs.writeFileSync(path.join(itemDir, `thumbnail.${extension}`), Buffer.from(base64Data, 'base64'));
  }

  generatePreview(item) {
    if (item.preview) return item.preview;

    if (item.type === 'text') {
      return item.content.substring(0, 100) + (item.content.length > 100 ? '...' : '');
    } else if (item.type === 'image') {
      return 'Image';
    } else if (item.type === 'file') {
      return `File: ${item.fileName}`;
    } else if (item.type === 'data-source') {
      const ds = item.dataSource || {};
      const label = item.name || (ds.mcp && ds.mcp.serverName) || (ds.connection && ds.connection.url) || 'Data Source';
      const subtype = ds.sourceType ? `[${ds.sourceType.toUpperCase()}]` : '';
      return `${subtype} ${label}`.trim();
    }

    return 'Item';
  }

  updateSpaceCount(spaceId, delta = 0) {
    const space = this.index.spaces.find((s) => s.id === spaceId);
    if (space) {
      if (delta !== 0) {
        space.itemCount = (space.itemCount || 0) + delta;
      } else {
        // Recalculate
        space.itemCount = this.index.items.filter((item) => item.spaceId === spaceId).length;
      }
    }
  }

  trimCache() {
    if (this.cache.size > this.cacheSize) {
      const keysToDelete = Array.from(this.cache.keys()).slice(0, this.cache.size - this.cacheSize);
      keysToDelete.forEach((key) => this.cache.delete(key));
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
            `**Author:** ${space.notebook?.author || require('os').userInfo().username || 'Unknown'}\n`,
          ],
        },
      ],
      metadata: {
        kernelspec: {
          display_name: 'Markdown',
          language: 'markdown',
          name: 'markdown',
        },
      },
      nbformat: 4,
      nbformat_minor: 5,
    };

    // Add description, objective, etc. if provided
    if (space.notebook?.description) {
      notebook.cells.push({
        cell_type: 'markdown',
        metadata: {},
        source: [`## Description\n\n${space.notebook.description}`],
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

    const queryWords = lowerQuery.split(/\s+/).filter((w) => w.length > 0);

    return this.index.items.filter((item) => {
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
      if (queryWords.some((word) => previewLower.includes(word) || fileNameLower.includes(word))) {
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
          if (metadata.tags?.some((tag) => tag.toLowerCase().includes(lowerQuery))) {
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
            ...(metadata.tags || []),
          ]
            .filter(Boolean)
            .join(' ')
            .toLowerCase();

          if (queryWords.some((word) => metadataText.includes(word))) {
            return true;
          }
        }
      } catch (_error) {
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
    return rows.map((row) => this._rowToItem(row));
  }

  /**
   * Search by tags (async)
   */
  async searchByTags(tags, matchAll = false) {
    if (!this.dbReady) {
      // Fallback to sync search
      return this.index.items.filter((item) => {
        try {
          const metaPath = path.join(this.storageRoot, item.metadataPath);
          if (fs.existsSync(metaPath)) {
            const metadata = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
            const itemTags = (metadata.tags || []).map((t) => t.toLowerCase());
            if (matchAll) {
              return tags.every((t) => itemTags.includes(t.toLowerCase()));
            } else {
              return tags.some((t) => itemTags.includes(t.toLowerCase()));
            }
          }
        } catch (_e) {
          return false;
        }
        return false;
      });
    }

    // Use DuckDB array operations
    if (matchAll) {
      // All tags must be present
      const conditions = tags.map(() => '? = ANY(tags)').join(' AND ');
      const rows = await this._dbQuery(`SELECT * FROM items WHERE ${conditions} ORDER BY timestamp DESC`, tags);
      return rows.map((row) => this._rowToItem(row));
    } else {
      // Any tag matches
      const conditions = tags.map(() => '? = ANY(tags)').join(' OR ');
      const rows = await this._dbQuery(`SELECT * FROM items WHERE ${conditions} ORDER BY timestamp DESC`, tags);
      return rows.map((row) => this._rowToItem(row));
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
    log.info('clipboard', 'Starting migration to unified metadata...');
    let migrated = 0;

    for (const space of this.index.spaces) {
      if (space.id === UNCLASSIFIED_SPACE) continue;

      const metadataPath = path.join(this.spacesDir, space.id, 'space-metadata.json');
      if (!fs.existsSync(metadataPath)) {
        this.migrateSpace(space.id);
        migrated++;
      }
    }

    log.info('clipboard', 'Migration complete. Migrated ... spaces.', { migrated });
    return migrated;
  }

  // Migrate a single space
  migrateSpace(spaceId) {
    const spaceDir = path.join(this.spacesDir, spaceId);
    if (!fs.existsSync(spaceDir)) {
      log.info('clipboard', 'Space directory not found: ...', { spaceId });
      return false;
    }

    const space = this.index.spaces.find((s) => s.id === spaceId);
    if (!space) {
      log.info('clipboard', 'Space not found in index: ...', { spaceId });
      return false;
    }

    log.info('clipboard', 'Migrating space: ... (...)', { spaceName: space.name, spaceId });

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
          status: 'existing',
        };
      }
    }

    // Check for old metadata files and merge
    const oldMetaFiles = ['.asset-metadata.json', 'project-config.json', '.gsx-costs.json'];

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

          log.info('clipboard', 'Merged old metadata: ...', { oldFile });
        } catch (_e) {
          log.error('clipboard', 'Error reading old metadata ...', { oldFile });
        }
      }
    }

    // Save unified metadata
    const metadataPath = path.join(spaceDir, 'space-metadata.json');
    fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));

    log.info('clipboard', 'Migrated space: ...', { spaceName: space.name });
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
      '.ipynb': 'notebook',
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
      if (space.id === UNCLASSIFIED_SPACE) continue;

      const metadata = this.getSpaceMetadata(space.id);
      if (metadata) {
        const searchLower = searchTerm.toLowerCase();
        if (
          metadata.name?.toLowerCase().includes(searchLower) ||
          metadata.projectConfig?.description?.toLowerCase().includes(searchLower)
        ) {
          results.push({
            spaceId: space.id,
            name: metadata.name,
            projectConfig: metadata.projectConfig,
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
        metadata: metadata,
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
      ...file,
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
      ...updates,
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
