/**
 * Unified Spaces API
 * 
 * A clean, well-documented API for accessing and managing spaces and items.
 * This module wraps ClipboardStorageV2 and provides a consistent interface
 * for all apps (GSX Create, Black Hole, Clipboard Viewer, external windows, etc.)
 * 
 * IMPORTANT: All item additions should go through items.add() which routes
 * through the clipboard manager for proper validation, retry logic, 
 * in-memory sync, and space metadata updates.
 * 
 * @module SpacesAPI
 */

const ClipboardStorageV2 = require('./clipboard-storage-v2');
const { getSharedStorage } = require('./clipboard-storage-v2');
const { getContentIngestionService, VALID_TYPES } = require('./content-ingestion');
const path = require('path');
const fs = require('fs');
const { getLogQueue } = require('./lib/log-event-queue');
const log = getLogQueue();

/**
 * Get the shared storage instance
 * Uses the same singleton as ClipboardManager for consistency
 * @returns {ClipboardStorageV2}
 */
function getStorage() {
  return getSharedStorage();
}

/**
 * SpacesAPI - Unified API for space and item management
 */
/**
 * Safe characters for space/item/folder IDs (alphanumeric, hyphen, underscore).
 * Used to reject path traversal and injection.
 */
const SAFE_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

/**
 * Check that a relative filePath does not escape (no '..' or absolute segments).
 * @param {string} filePath - Relative path segment(s)
 * @returns {boolean} true if safe
 */
function isSafeRelativePath(filePath) {
  if (!filePath || typeof filePath !== 'string') return true;
  const normalized = path.normalize(filePath);
  return normalized !== '..' && !normalized.startsWith('..' + path.sep) && !path.isAbsolute(normalized);
}

class SpacesAPI {
  constructor() {
    this.storage = getStorage();
    this._eventListeners = new Map();
  }

  /**
   * Resolve a file path within a space and ensure it does not escape the space directory.
   * @param {string} spaceId - The space ID
   * @param {string} filePath - Relative path within the space
   * @returns {string} Resolved absolute path
   * @throws {Error} If path escapes the space directory (path traversal)
   */
  _resolveSpaceFilePath(spaceId, filePath) {
    const spaceRoot = path.resolve(this.storage.spacesDir, spaceId);
    const fullPath = path.resolve(spaceRoot, filePath || '.');
    const normalizedRoot = path.resolve(spaceRoot);
    if (fullPath !== normalizedRoot && !fullPath.startsWith(normalizedRoot + path.sep)) {
      throw new Error('Path escapes space directory');
    }
    return fullPath;
  }

  // ============================================
  // SPACE MANAGEMENT
  // ============================================

  /**
   * Get all spaces with their metadata
   * @returns {Promise<Array<Object>>} Array of space objects with metadata
   */
  async list() {
    try {
      const spaces = this.storage.index.spaces || [];
      
      // Enrich with item counts and paths
      return spaces.map(space => {
        const itemCount = this.storage.index.items.filter(
          item => item.spaceId === space.id
        ).length;
        
        return {
          id: space.id,
          name: space.name,
          icon: space.icon || '◯',
          color: space.color || '#64c8ff',
          itemCount,
          path: path.join(this.storage.spacesDir, space.id),
          createdAt: space.createdAt,
          updatedAt: space.updatedAt
        };
      });
    } catch (error) {
      log.error('spaces', 'Error listing spaces', { error: error.message || error });
      throw error;
    }
  }

  /**
   * Get a single space by ID with full metadata
   * @param {string} spaceId - The space ID
   * @returns {Promise<Object|null>} Space object with metadata or null if not found
   */
  async get(spaceId) {
    try {
      const space = this.storage.index.spaces.find(s => s.id === spaceId);
      if (!space) {
        return null;
      }

      const metadata = this.storage.getSpaceMetadata(spaceId);
      const itemCount = this.storage.index.items.filter(
        item => item.spaceId === spaceId
      ).length;

      return {
        id: space.id,
        name: space.name,
        icon: space.icon || '◯',
        color: space.color || '#64c8ff',
        itemCount,
        path: path.join(this.storage.spacesDir, spaceId),
        metadata: metadata || {}
      };
    } catch (error) {
      log.error('spaces', 'Error getting space', { error: error.message || error });
      throw error;
    }
  }

  /**
   * Create a new space
   * @param {string} name - Space name
   * @param {Object} options - Optional configuration
   * @param {string} options.icon - Emoji icon
   * @param {string} options.color - Hex color
   * @param {Object} options.notebook - Notebook data
   * @returns {Promise<Object>} Created space object
   */
  async create(name, options = {}) {
    try {
      const space = this.storage.createSpace({
        name,
        icon: options.icon || '◯',
        color: options.color || '#64c8ff',
        notebook: options.notebook
      });

      log.info('spaces', 'Created space', { spaceId: space.id, name: space.name });
      
      // Emit event
      this._emit('space:created', { space });

      return {
        id: space.id,
        name: space.name,
        icon: space.icon,
        color: space.color,
        itemCount: 0,
        path: path.join(this.storage.spacesDir, space.id)
      };
    } catch (error) {
      log.error('spaces', 'Error creating space', { error: error.message || error });
      throw error;
    }
  }

  /**
   * Ensure the GSX Agent space exists, creating it if necessary
   * Called automatically when agents write .md files to gsx-agent space
   * @returns {Promise<Object>} The GSX Agent space object
   */
  async ensureGSXAgentSpace() {
    try {
      const GSX_AGENT_SPACE_ID = 'gsx-agent';
      const GSX_AGENT_SPACE_NAME = 'GSX Agent';
      
      // Check if space already exists
      const spaces = await this.list();
      const existingSpace = spaces.find(s => s.id === GSX_AGENT_SPACE_ID);
      
      if (existingSpace) {
        return existingSpace;
      }
      
      // Space doesn't exist - create it
      log.info('spaces', 'Creating GSX Agent space');
      
      const space = this.storage.createSpace({
        id: GSX_AGENT_SPACE_ID,
        name: GSX_AGENT_SPACE_NAME,
        icon: '🤖',
        color: '#8b5cf6', // Purple for agent-related content
        isSystem: true
      });
      
      log.info('spaces', 'Created GSX Agent space', { spaceId: space.id });
      this._emit('space:created', { space });
      
      // Trigger default files creation
      if (this.storage.ensureGSXAgentDefaultFiles) {
        this.storage.ensureGSXAgentDefaultFiles();
      }
      
      return {
        id: space.id,
        name: space.name,
        icon: space.icon,
        color: space.color,
        itemCount: 0,
        path: path.join(this.storage.spacesDir, space.id)
      };
    } catch (error) {
      log.error('spaces', 'Error ensuring GSX Agent space', { error: error.message || error });
      throw error;
    }
  }

  /**
   * Update a space's properties
   * @param {string} spaceId - The space ID
   * @param {Object} data - Properties to update
   * @param {string} data.name - New name
   * @param {string} data.icon - New icon
   * @param {string} data.color - New color
   * @returns {Promise<boolean>} Success status
   */
  async update(spaceId, data) {
    try {
      const success = this.storage.updateSpace(spaceId, data);
      
      if (success) {
        log.info('spaces', 'Updated space', { spaceId });
        this._emit('space:updated', { spaceId, data });
      }
      
      return success;
    } catch (error) {
      log.error('spaces', 'Error updating space', { error: error.message || error });
      throw error;
    }
  }

  /**
   * Delete a space (items are moved to Unclassified)
   * @param {string} spaceId - The space ID
   * @returns {Promise<boolean>} Success status
   */
  async delete(spaceId) {
    try {
      if (spaceId === 'unclassified') {
        throw new Error('Cannot delete the Unclassified space');
      }
      
      if (spaceId === 'gsx-agent') {
        throw new Error('Cannot delete the GSX Agent space');
      }

      const success = this.storage.deleteSpace(spaceId);
      
      if (success) {
        log.info('spaces', 'Deleted space', { spaceId });
        this._emit('space:deleted', { spaceId });
      }
      
      return success;
    } catch (error) {
      log.error('spaces', 'Error deleting space', { error: error.message || error });
      throw error;
    }
  }

  // ============================================
  // ITEM MANAGEMENT
  // ============================================

  /**
   * Items API namespace
   */
  get items() {
    return {
      /**
       * List items in a space
       * @param {string} spaceId - The space ID
       * @param {Object} options - Filter options
       * @param {number} options.limit - Max items to return
       * @param {number} options.offset - Skip items
       * @param {string} options.type - Filter by type (text, image, file, html)
       * @param {boolean} options.pinned - Filter by pinned status
       * @param {Array<string>} options.tags - Filter by tags (items must have ALL specified tags)
       * @param {Array<string>} options.anyTags - Filter by tags (items must have ANY of specified tags)
       * @param {boolean} options.includeContent - Include full content (slower)
       * @returns {Promise<Array<Object>>} Array of items
       */
      list: async (spaceId, options = {}) => {
        try {
          let items = this.storage.getSpaceItems(spaceId);
          
          // Apply filters
          if (options.type) {
            items = items.filter(item => item.type === options.type);
          }
          if (options.pinned !== undefined) {
            items = items.filter(item => item.pinned === options.pinned);
          }
          
          // Filter by tags (ALL tags must match)
          if (options.tags && options.tags.length > 0) {
            items = items.filter(item => {
              const itemTags = this._getItemTags(item.id);
              return options.tags.every(tag => 
                itemTags.some(t => t.toLowerCase() === tag.toLowerCase())
              );
            });
          }
          
          // Filter by tags (ANY tag matches)
          if (options.anyTags && options.anyTags.length > 0) {
            items = items.filter(item => {
              const itemTags = this._getItemTags(item.id);
              return options.anyTags.some(tag => 
                itemTags.some(t => t.toLowerCase() === tag.toLowerCase())
              );
            });
          }
          
          // Sort by timestamp (newest first), pinned items at top
          items.sort((a, b) => {
            if (a.pinned && !b.pinned) return -1;
            if (!a.pinned && b.pinned) return 1;
            return b.timestamp - a.timestamp;
          });
          
          // Apply pagination
          const offset = options.offset || 0;
          const limit = options.limit || items.length;
          items = items.slice(offset, offset + limit);
          
          // Optionally include full content (also includes tags)
          if (options.includeContent) {
            items = items.map(item => {
              try {
                return this.storage.loadItem(item.id);
              } catch (e) {
                return item;
              }
            });
          } else {
            // Add tags to items even without full content
            items = items.map(item => ({
              ...item,
              tags: this._getItemTags(item.id)
            }));
          }
          
          return items;
        } catch (error) {
          log.error('spaces', 'Error listing items', { error: error.message || error });
          throw error;
        }
      },

      /**
       * Get a single item by ID
       * @param {string} spaceId - The space ID (for validation)
       * @param {string} itemId - The item ID
       * @returns {Promise<Object|null>} Item with full content and tags or null
       */
      get: async (spaceId, itemId) => {
        try {
          const item = this.storage.loadItem(itemId);
          if (item && item.spaceId !== spaceId) {
            log.warn('spaces', 'Item found but in different space', { itemId, spaceId });
          }
          if (item) {
            // Ensure tags are at root level (v2.0: attributes.tags; v1.0: tags)
            const meta = item.metadata || {};
            const tagsFromMetadata = (meta.attributes && meta.attributes.tags) || meta.tags;
            const tagsFromFile = this._getItemTags(itemId);
            const finalTags = tagsFromMetadata || tagsFromFile;
            
            return {
              ...item,
              tags: finalTags
            };
          }
          return item;
        } catch (error) {
          const msg = error.message || String(error);
          if (msg.includes('not found') || msg.includes('Not found') || msg.includes('ENOENT')) {
            log.debug('spaces', 'Item not found', { error: msg });
          } else {
            log.error('spaces', 'Error getting item', { error: msg });
          }
          return null;
        }
      },

      /**
       * Add a new item to a space
       * 
       * This method routes through the clipboard manager for proper:
       * - Input validation
       * - Retry logic for transient disk errors
       * - In-memory history sync
       * - Space metadata updates
       * - Context capture
       * 
       * @param {string} spaceId - The space ID
       * @param {Object} item - The item to add
       * @param {string} item.type - Type: text, image, file, html, code
       * @param {string} item.content - The content (text, base64, or file path)
       * @param {Object} item.metadata - Additional metadata
       * @param {string} item.source - Source identifier
       * @param {boolean} item.skipAutoMetadata - Skip auto-generation even if enabled
       * @returns {Promise<Object>} Created item with id, type, spaceId, etc.
       */
      add: async (spaceId, item) => {
        try {
          // Validate type
          const type = item.type || 'text';
          if (!VALID_TYPES.includes(type)) {
            throw new Error(`Invalid content type: ${type}. Must be one of: ${VALID_TYPES.join(', ')}`);
          }
          
          // Validate spaceId exists (unless unclassified)
          if (spaceId && spaceId !== 'unclassified') {
            const spaceExists = this.storage.index.spaces.some(s => s.id === spaceId);
            if (!spaceExists) {
              throw new Error(`Space not found: ${spaceId}`);
            }
          }
          
          // Route through clipboard manager if available for proper sync
          if (global.clipboardManager) {
            const itemData = {
              ...item,
              type,
              spaceId: spaceId || 'unclassified',
              timestamp: Date.now(),
              source: item.source || 'spaces-api'
            };
            
            // Use addToHistory for proper in-memory sync and space metadata updates
            await global.clipboardManager.addToHistory(itemData);
            
            // Get the newly added item from history
            const newItem = global.clipboardManager.history?.[0];
            
            if (newItem) {
              log.info('spaces', 'Added item via clipboardManager', { spaceId, itemId: newItem.id });
              this._emit('item:added', { spaceId, item: newItem });
              
              // Auto-generate metadata if incomplete and enabled
              if (!item.skipAutoMetadata && this._shouldAutoGenerateMetadata(item)) {
                this._queueMetadataGeneration(newItem.id, spaceId, type);
              }
              
              return newItem;
            }
          }
          
          // Fallback to direct storage (less ideal but still works)
          log.warn('spaces', 'clipboardManager not available, using direct storage (may cause sync issues)');
          
          // Generate thumbnail for images if not provided
          const itemWithThumbnail = { ...item };
          if (type === 'image' && !item.thumbnail) {
            const imageData = item.content || item.dataUrl;
            if (imageData && typeof imageData === 'string' && imageData.startsWith('data:image/')) {
              // For small images, use full image; for large, we'd need nativeImage (not available here)
              itemWithThumbnail.thumbnail = imageData;
              log.info('spaces', 'Using image content as thumbnail (fallback path)');
            }
          }
          
          const newItem = this.storage.addItem({
            ...itemWithThumbnail,
            type,
            spaceId: spaceId || 'unclassified',
            timestamp: Date.now()
          });
          
          log.info('spaces', 'Added item to space', { spaceId, itemId: newItem.id });
          this._emit('item:added', { spaceId, item: newItem });
          
          // Auto-generate metadata if incomplete and enabled
          if (!item.skipAutoMetadata && this._shouldAutoGenerateMetadata(item)) {
            this._queueMetadataGeneration(newItem.id, spaceId, type);
          }
          
          return newItem;
        } catch (error) {
          // Validation errors (content type, missing fields) are client issues, not server errors
          const msg = error.message || '';
          if (msg.includes('Invalid content type') || msg.includes('Missing content') || msg.includes('Content is required')) {
            log.debug('spaces', 'Item validation rejected', { error: msg });
          } else if (msg.includes('not found') || msg.includes('Not found') || msg.includes('NOT_FOUND')) {
            log.debug('spaces', 'Add item to missing space', { error: msg });
          } else {
            log.error('spaces', 'Error adding item', { error: msg });
          }
          throw error;
        }
      },

      /**
       * Update an item's properties
       * @param {string} spaceId - The space ID
       * @param {string} itemId - The item ID
       * @param {Object} data - Properties to update
       * @returns {Promise<boolean>} Success status
       */
      update: async (spaceId, itemId, data) => {
        try {
          const success = this.storage.updateItemIndex(itemId, data);
          
          if (success) {
            log.info('spaces', 'Updated item', { itemId });
            this._emit('item:updated', { spaceId, itemId, data });
          }
          
          return success;
        } catch (error) {
          log.error('spaces', 'Error updating item', { error: error.message || error });
          throw error;
        }
      },

      /**
       * Delete an item
       * @param {string} spaceId - The space ID
       * @param {string} itemId - The item ID
       * @returns {Promise<boolean>} Success status
       */
      delete: async (spaceId, itemId) => {
        try {
          const success = this.storage.deleteItem(itemId);
          
          if (success) {
            log.info('spaces', 'Deleted item', { itemId });
            this._emit('item:deleted', { spaceId, itemId });
          }
          
          return success;
        } catch (error) {
          log.error('spaces', 'Error deleting item', { error: error.message || error });
          throw error;
        }
      },

      /**
       * Delete multiple items at once
       * @param {string} spaceId - The space ID (for validation)
       * @param {Array<string>} itemIds - Array of item IDs to delete
       * @returns {Promise<Object>} Result object with { success: boolean, deleted: number, failed: number, errors: Array }
       */
      deleteMany: async (spaceId, itemIds) => {
        try {
          if (!Array.isArray(itemIds) || itemIds.length === 0) {
            return { success: false, deleted: 0, failed: 0, errors: ['No items provided'] };
          }
          
          const results = {
            success: true,
            deleted: 0,
            failed: 0,
            errors: []
          };
          
          for (const itemId of itemIds) {
            try {
              const success = this.storage.deleteItem(itemId);
              if (success) {
                results.deleted++;
                this._emit('item:deleted', { spaceId, itemId });
              } else {
                results.failed++;
                results.errors.push(`Failed to delete item: ${itemId}`);
              }
            } catch (error) {
              results.failed++;
              results.errors.push(`Error deleting ${itemId}: ${error.message}`);
              log.error('spaces', 'Error deleting item in bulk', { itemId, error: error.message || error });
            }
          }
          
          // Consider overall success if at least one item was deleted
          results.success = results.deleted > 0;
          
          log.info('spaces', 'Bulk delete completed', { deleted: results.deleted, failed: results.failed });
          this._emit('items:bulk-deleted', { 
            spaceId, 
            itemIds: itemIds.slice(0, results.deleted), // Only successfully deleted IDs
            count: results.deleted 
          });
          
          return results;
        } catch (error) {
          log.error('spaces', 'Error in bulk delete', { error: error.message || error });
          return { 
            success: false, 
            deleted: 0, 
            failed: itemIds.length, 
            errors: [error.message] 
          };
        }
      },

      /**
       * Move an item to a different space
       * @param {string} itemId - The item ID
       * @param {string} fromSpaceId - Current space ID
       * @param {string} toSpaceId - Target space ID
       * @returns {Promise<boolean>} Success status
       */
      move: async (itemId, fromSpaceId, toSpaceId) => {
        try {
          const success = this.storage.moveItem(itemId, toSpaceId);
          
          if (success) {
            log.info('spaces', 'Moved item', { itemId, fromSpaceId, toSpaceId });
            this._emit('item:moved', { itemId, fromSpaceId, toSpaceId });
          }
          
          return success;
        } catch (error) {
          log.error('spaces', 'Error moving item', { error: error.message || error });
          throw error;
        }
      },

      /**
       * Move multiple items to a different space at once
       * @param {Array<string>} itemIds - Array of item IDs to move
       * @param {string} fromSpaceId - Current space ID (for reference)
       * @param {string} toSpaceId - Target space ID
       * @returns {Promise<Object>} Result object with { success: boolean, moved: number, failed: number, errors: Array }
       */
      moveMany: async (itemIds, fromSpaceId, toSpaceId) => {
        try {
          if (!Array.isArray(itemIds) || itemIds.length === 0) {
            return { success: false, moved: 0, failed: 0, errors: ['No items provided'] };
          }
          
          if (!toSpaceId || toSpaceId === 'null') {
            toSpaceId = 'unclassified';
          }
          
          // Validate target space exists (unless unclassified)
          if (toSpaceId !== 'unclassified') {
            const spaceExists = this.storage.index.spaces.some(s => s.id === toSpaceId);
            if (!spaceExists) {
              return { success: false, moved: 0, failed: itemIds.length, errors: ['Target space does not exist'] };
            }
          }
          
          const results = {
            success: true,
            moved: 0,
            failed: 0,
            errors: []
          };
          
          for (const itemId of itemIds) {
            try {
              const success = this.storage.moveItem(itemId, toSpaceId);
              if (success) {
                results.moved++;
                this._emit('item:moved', { itemId, fromSpaceId, toSpaceId });
              } else {
                results.failed++;
                results.errors.push(`Failed to move item: ${itemId}`);
              }
            } catch (error) {
              results.failed++;
              results.errors.push(`Error moving ${itemId}: ${error.message}`);
              log.error('spaces', 'Error moving item in bulk', { itemId, error: error.message || error });
            }
          }
          
          // Consider overall success if at least one item was moved
          results.success = results.moved > 0;
          
          log.info('spaces', 'Bulk move completed', { moved: results.moved, failed: results.failed });
          this._emit('items:bulk-moved', { 
            itemIds: itemIds.slice(0, results.moved), // Only successfully moved IDs
            fromSpaceId,
            toSpaceId,
            count: results.moved 
          });
          
          return results;
        } catch (error) {
          log.error('spaces', 'Error in bulk move', { error: error.message || error });
          return { 
            success: false, 
            moved: 0, 
            failed: itemIds.length, 
            errors: [error.message] 
          };
        }
      },

      /**
       * Toggle pin status of an item
       * @param {string} spaceId - The space ID
       * @param {string} itemId - The item ID
       * @returns {Promise<boolean>} New pinned status
       */
      togglePin: async (spaceId, itemId) => {
        try {
          const pinned = this.storage.togglePin(itemId);
          this._emit('item:updated', { spaceId, itemId, data: { pinned } });
          return pinned;
        } catch (error) {
          log.error('spaces', 'Error toggling pin', { error: error.message || error });
          throw error;
        }
      },

      /**
       * Get tags for an item
       * @param {string} spaceId - The space ID
       * @param {string} itemId - The item ID
       * @returns {Promise<Array<string>>} Array of tags
       */
      getTags: async (spaceId, itemId) => {
        try {
          return this._getItemTags(itemId);
        } catch (error) {
          log.error('spaces', 'Error getting tags', { error: error.message || error });
          return [];
        }
      },

      /**
       * Set tags for an item (replaces existing tags)
       * @param {string} spaceId - The space ID
       * @param {string} itemId - The item ID
       * @param {Array<string>} tags - Array of tags
       * @returns {Promise<boolean>} Success status
       */
      setTags: async (spaceId, itemId, tags) => {
        try {
          const success = this._updateItemMetadata(itemId, { tags: tags || [] });
          if (success) {
            this._emit('item:tags:updated', { spaceId, itemId, tags });
          }
          return success;
        } catch (error) {
          log.error('spaces', 'Error setting tags', { error: error.message || error });
          return false;
        }
      },

      /**
       * Add a tag to an item
       * @param {string} spaceId - The space ID
       * @param {string} itemId - The item ID
       * @param {string} tag - Tag to add
       * @returns {Promise<Array<string>>} Updated array of tags
       */
      addTag: async (spaceId, itemId, tag) => {
        try {
          const currentTags = this._getItemTags(itemId);
          const normalizedTag = tag.trim();
          
          // Don't add duplicate tags (case-insensitive check)
          if (currentTags.some(t => t.toLowerCase() === normalizedTag.toLowerCase())) {
            return currentTags;
          }
          
          const newTags = [...currentTags, normalizedTag];
          this._updateItemMetadata(itemId, { tags: newTags });
          this._emit('item:tags:updated', { spaceId, itemId, tags: newTags });
          return newTags;
        } catch (error) {
          log.error('spaces', 'Error adding tag', { error: error.message || error });
          return [];
        }
      },

      /**
       * Remove a tag from an item
       * @param {string} spaceId - The space ID
       * @param {string} itemId - The item ID
       * @param {string} tag - Tag to remove
       * @returns {Promise<Array<string>>} Updated array of tags
       */
      removeTag: async (spaceId, itemId, tag) => {
        try {
          const currentTags = this._getItemTags(itemId);
          const normalizedTag = tag.trim().toLowerCase();
          
          const newTags = currentTags.filter(t => t.toLowerCase() !== normalizedTag);
          this._updateItemMetadata(itemId, { tags: newTags });
          this._emit('item:tags:updated', { spaceId, itemId, tags: newTags });
          return newTags;
        } catch (error) {
          log.error('spaces', 'Error removing tag', { error: error.message || error });
          return [];
        }
      },

      /**
       * Generate or regenerate AI metadata for an item
       * @param {string} spaceId - The space ID
       * @param {string} itemId - The item ID
       * @param {Object} options - Generation options
       * @param {string} options.apiKey - Override API key
       * @param {string} options.customPrompt - Custom prompt for generation
       * @returns {Promise<Object>} { success, metadata } or { success: false, error }
       */
      generateMetadata: async (spaceId, itemId, options = {}) => {
        try {
          return await this.generateMetadataForItem(itemId, options);
        } catch (error) {
          log.error('spaces', 'Error generating metadata', { error: error.message || error });
          return { success: false, error: error.message };
        }
      }
    };
  }

  // ============================================
  // TAG MANAGEMENT
  // ============================================

  /**
   * Tags API namespace for space-level tag operations
   */
  get tags() {
    return {
      /**
       * Get all unique tags used in a space
       * @param {string} spaceId - The space ID
       * @returns {Promise<Array<{tag: string, count: number}>>} Tags with usage counts
       */
      list: async (spaceId) => {
        try {
          const items = this.storage.getSpaceItems(spaceId);
          const tagCounts = new Map();
          
          for (const item of items) {
            const tags = this._getItemTags(item.id);
            for (const tag of tags) {
              const lowerTag = tag.toLowerCase();
              const existing = tagCounts.get(lowerTag) || { tag, count: 0 };
              existing.count++;
              tagCounts.set(lowerTag, existing);
            }
          }
          
          // Sort by count (descending), then alphabetically
          return Array.from(tagCounts.values()).sort((a, b) => {
            if (b.count !== a.count) return b.count - a.count;
            return a.tag.localeCompare(b.tag);
          });
        } catch (error) {
          log.error('spaces', 'Error listing tags', { error: error.message || error });
          return [];
        }
      },

      /**
       * Get all unique tags across all spaces
       * @returns {Promise<Array<{tag: string, count: number, spaces: Array<string>}>>} Tags with counts and space IDs
       */
      listAll: async () => {
        try {
          const allItems = this.storage.getAllItems();
          const tagInfo = new Map();
          
          for (const item of allItems) {
            const tags = this._getItemTags(item.id);
            for (const tag of tags) {
              const lowerTag = tag.toLowerCase();
              const existing = tagInfo.get(lowerTag) || { tag, count: 0, spaces: new Set() };
              existing.count++;
              existing.spaces.add(item.spaceId);
              tagInfo.set(lowerTag, existing);
            }
          }
          
          // Convert Sets to Arrays and sort
          return Array.from(tagInfo.values())
            .map(t => ({ ...t, spaces: Array.from(t.spaces) }))
            .sort((a, b) => {
              if (b.count !== a.count) return b.count - a.count;
              return a.tag.localeCompare(b.tag);
            });
        } catch (error) {
          log.error('spaces', 'Error listing all tags', { error: error.message || error });
          return [];
        }
      },

      /**
       * Find all items with specific tags
       * @param {Array<string>} tags - Tags to search for
       * @param {Object} options - Search options
       * @param {string} options.spaceId - Limit to specific space
       * @param {boolean} options.matchAll - Require all tags (default: false = any tag)
       * @param {number} options.limit - Max results
       * @returns {Promise<Array<Object>>} Matching items
       */
      findItems: async (tags, options = {}) => {
        try {
          let items = options.spaceId 
            ? this.storage.getSpaceItems(options.spaceId)
            : this.storage.getAllItems();
          
          const searchTags = tags.map(t => t.toLowerCase());
          
          items = items.filter(item => {
            const itemTags = this._getItemTags(item.id).map(t => t.toLowerCase());
            
            if (options.matchAll) {
              // All search tags must be present
              return searchTags.every(t => itemTags.includes(t));
            } else {
              // Any search tag matches
              return searchTags.some(t => itemTags.includes(t));
            }
          });
          
          // Add tags to results
          items = items.map(item => ({
            ...item,
            tags: this._getItemTags(item.id)
          }));
          
          if (options.limit) {
            items = items.slice(0, options.limit);
          }
          
          return items;
        } catch (error) {
          log.error('spaces', 'Error finding items by tags', { error: error.message || error });
          return [];
        }
      },

      /**
       * Rename a tag across all items in a space
       * @param {string} spaceId - The space ID
       * @param {string} oldTag - Tag to rename
       * @param {string} newTag - New tag name
       * @returns {Promise<number>} Number of items updated
       */
      rename: async (spaceId, oldTag, newTag) => {
        try {
          const items = this.storage.getSpaceItems(spaceId);
          const oldTagLower = oldTag.toLowerCase();
          let updatedCount = 0;
          
          for (const item of items) {
            const tags = this._getItemTags(item.id);
            const tagIndex = tags.findIndex(t => t.toLowerCase() === oldTagLower);
            
            if (tagIndex !== -1) {
              tags[tagIndex] = newTag.trim();
              this._updateItemMetadata(item.id, { tags });
              updatedCount++;
            }
          }
          
          if (updatedCount > 0) {
            this._emit('tags:renamed', { spaceId, oldTag, newTag, count: updatedCount });
          }
          
          return updatedCount;
        } catch (error) {
          log.error('spaces', 'Error renaming tag', { error: error.message || error });
          return 0;
        }
      },

      /**
       * Delete a tag from all items in a space
       * @param {string} spaceId - The space ID
       * @param {string} tag - Tag to delete
       * @returns {Promise<number>} Number of items updated
       */
      deleteFromSpace: async (spaceId, tag) => {
        try {
          const items = this.storage.getSpaceItems(spaceId);
          const tagLower = tag.toLowerCase();
          let updatedCount = 0;
          
          for (const item of items) {
            const tags = this._getItemTags(item.id);
            const newTags = tags.filter(t => t.toLowerCase() !== tagLower);
            
            if (newTags.length !== tags.length) {
              this._updateItemMetadata(item.id, { tags: newTags });
              updatedCount++;
            }
          }
          
          if (updatedCount > 0) {
            this._emit('tags:deleted', { spaceId, tag, count: updatedCount });
          }
          
          return updatedCount;
        } catch (error) {
          log.error('spaces', 'Error deleting tag', { error: error.message || error });
          return 0;
        }
      }
    };
  }

  // ============================================
  // SMART FOLDERS
  // ============================================

  /**
   * Smart Folders API namespace
   * Smart folders are saved tag-based queries that create virtual views
   * showing items from across all spaces that match the criteria.
   */
  get smartFolders() {
    return {
      /**
       * List all smart folders
       * @returns {Promise<Array<Object>>} Array of smart folder definitions
       */
      list: async () => {
        try {
          const data = this._loadSmartFolders();
          return data.folders || [];
        } catch (error) {
          log.error('spaces', 'Error listing smart folders', { error: error.message || error });
          return [];
        }
      },

      /**
       * Get a single smart folder by ID
       * @param {string} folderId - The smart folder ID
       * @returns {Promise<Object|null>} Smart folder or null
       */
      get: async (folderId) => {
        try {
          const data = this._loadSmartFolders();
          return (data.folders || []).find(f => f.id === folderId) || null;
        } catch (error) {
          log.error('spaces', 'Error getting smart folder', { error: error.message || error });
          return null;
        }
      },

      /**
       * Create a new smart folder
       * @param {string} name - Folder name
       * @param {Object} criteria - Filter criteria
       * @param {Array<string>} criteria.tags - Required tags (all must match)
       * @param {Array<string>} criteria.anyTags - Optional tags (any matches)
       * @param {Array<string>} criteria.types - Filter by item types
       * @param {Array<string>} criteria.spaces - Limit to specific spaces
       * @param {Object} options - Additional options
       * @param {string} options.icon - Icon name or emoji
       * @param {string} options.color - Hex color
       * @returns {Promise<Object>} Created smart folder
       */
      create: async (name, criteria, options = {}) => {
        try {
          const data = this._loadSmartFolders();
          if (!data.folders) data.folders = [];
          
          const folder = {
            id: 'sf-' + require('crypto').randomBytes(8).toString('hex'),
            name: name.trim(),
            icon: options.icon || 'folder',
            color: options.color || '#64c8ff',
            criteria: {
              tags: criteria.tags || [],
              anyTags: criteria.anyTags || [],
              types: criteria.types || [],
              spaces: criteria.spaces || []
            },
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          };
          
          data.folders.push(folder);
          this._saveSmartFolders(data);
          
          log.info('spaces', 'Created smart folder', { folderId: folder.id, name: folder.name });
          this._emit('smartFolder:created', { folder });
          
          return folder;
        } catch (error) {
          log.error('spaces', 'Error creating smart folder', { error: error.message || error });
          throw error;
        }
      },

      /**
       * Update a smart folder
       * @param {string} folderId - The smart folder ID
       * @param {Object} updates - Properties to update
       * @returns {Promise<Object|null>} Updated smart folder or null
       */
      update: async (folderId, updates) => {
        try {
          const data = this._loadSmartFolders();
          const index = (data.folders || []).findIndex(f => f.id === folderId);
          
          if (index === -1) {
            return null;
          }
          
          const folder = data.folders[index];
          
          // Apply updates
          if (updates.name !== undefined) folder.name = updates.name.trim();
          if (updates.icon !== undefined) folder.icon = updates.icon;
          if (updates.color !== undefined) folder.color = updates.color;
          if (updates.criteria !== undefined) {
            folder.criteria = {
              ...folder.criteria,
              ...updates.criteria
            };
          }
          folder.updatedAt = new Date().toISOString();
          
          data.folders[index] = folder;
          this._saveSmartFolders(data);
          
          log.info('spaces', 'Updated smart folder', { folderId });
          this._emit('smartFolder:updated', { folderId, updates });
          
          return folder;
        } catch (error) {
          log.error('spaces', 'Error updating smart folder', { error: error.message || error });
          return null;
        }
      },

      /**
       * Delete a smart folder
       * @param {string} folderId - The smart folder ID
       * @returns {Promise<boolean>} Success status
       */
      delete: async (folderId) => {
        try {
          const data = this._loadSmartFolders();
          const index = (data.folders || []).findIndex(f => f.id === folderId);
          
          if (index === -1) {
            return false;
          }
          
          data.folders.splice(index, 1);
          this._saveSmartFolders(data);
          
          log.info('spaces', 'Deleted smart folder', { folderId });
          this._emit('smartFolder:deleted', { folderId });
          
          return true;
        } catch (error) {
          log.error('spaces', 'Error deleting smart folder', { error: error.message || error });
          return false;
        }
      },

      /**
       * Get items matching a smart folder's criteria
       * @param {string} folderId - The smart folder ID
       * @param {Object} options - Query options
       * @param {number} options.limit - Max items to return
       * @param {number} options.offset - Skip items
       * @param {boolean} options.includeContent - Include full content
       * @returns {Promise<Array<Object>>} Matching items with tags
       */
      getItems: async (folderId, options = {}) => {
        try {
          const data = this._loadSmartFolders();
          const folder = data.folders.find(f => f.id === folderId);
          
          if (!folder) {
            return [];
          }
          
          return await this._executeSmartFolderQuery(folder.criteria, options);
        } catch (error) {
          log.error('spaces', 'Error getting smart folder items', { error: error.message || error });
          return [];
        }
      },

      /**
       * Preview items for criteria without saving a folder
       * @param {Object} criteria - Filter criteria
       * @param {Object} options - Query options
       * @returns {Promise<Array<Object>>} Matching items
       */
      preview: async (criteria, options = {}) => {
        try {
          return await this._executeSmartFolderQuery(criteria, options);
        } catch (error) {
          log.error('spaces', 'Error previewing smart folder', { error: error.message || error });
          return [];
        }
      }
    };
  }

  /**
   * Load smart folders from storage
   * @private
   */
  _loadSmartFolders() {
    const filePath = path.join(this.storage.storageRoot, 'smart-folders.json');
    
    if (fs.existsSync(filePath)) {
      try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
      } catch (error) {
        log.error('spaces', 'Error loading smart folders', { error: error.message || error });
      }
    }
    
    // Return default structure
    return { version: '1.0', folders: [] };
  }

  /**
   * Save smart folders to storage
   * @private
   */
  _saveSmartFolders(data) {
    const filePath = path.join(this.storage.storageRoot, 'smart-folders.json');
    data.lastModified = new Date().toISOString();
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  }

  /**
   * Execute a smart folder query
   * @private
   */
  async _executeSmartFolderQuery(criteria, options = {}) {
    let items = this.storage.getAllItems();
    
    // Filter by spaces if specified
    if (criteria.spaces && criteria.spaces.length > 0) {
      items = items.filter(item => criteria.spaces.includes(item.spaceId));
    }
    
    // Filter by types if specified
    if (criteria.types && criteria.types.length > 0) {
      items = items.filter(item => criteria.types.includes(item.type));
    }
    
    // Filter by required tags (ALL must match)
    if (criteria.tags && criteria.tags.length > 0) {
      items = items.filter(item => {
        const itemTags = this._getItemTags(item.id).map(t => t.toLowerCase());
        return criteria.tags.every(tag => 
          itemTags.includes(tag.toLowerCase())
        );
      });
    }
    
    // Filter by optional tags (ANY must match)
    if (criteria.anyTags && criteria.anyTags.length > 0) {
      items = items.filter(item => {
        const itemTags = this._getItemTags(item.id).map(t => t.toLowerCase());
        return criteria.anyTags.some(tag => 
          itemTags.includes(tag.toLowerCase())
        );
      });
    }
    
    // Sort by timestamp (newest first)
    items.sort((a, b) => b.timestamp - a.timestamp);
    
    // Apply pagination
    const offset = options.offset || 0;
    const limit = options.limit || items.length;
    items = items.slice(offset, offset + limit);
    
    // Add tags and optionally full content
    if (options.includeContent) {
      items = items.map(item => {
        try {
          return this.storage.loadItem(item.id);
        } catch (e) {
          return { ...item, tags: this._getItemTags(item.id) };
        }
      });
    } else {
      items = items.map(item => ({
        ...item,
        tags: this._getItemTags(item.id)
      }));
    }
    
    return items;
  }

  // ============================================
  // SEARCH & QUERY (Awesome Search Engine!)
  // ============================================

  /**
   * Awesome search across all spaces with comprehensive metadata search,
   * relevance scoring, fuzzy matching, and search highlights.
   * 
   * @param {string} query - Search query (supports multiple words)
   * @param {Object} options - Search options
   * @param {string} options.spaceId - Limit to specific space
   * @param {string} options.type - Filter by item type
   * @param {boolean} options.searchTags - Search in tags (default: true)
   * @param {boolean} options.searchMetadata - Search in all metadata fields (default: true)
   * @param {boolean} options.searchContent - Search in full content for text items (default: false, slower)
   * @param {boolean} options.fuzzy - Enable fuzzy matching for typo tolerance (default: true)
   * @param {number} options.fuzzyThreshold - Fuzzy match threshold 0-1 (default: 0.7)
   * @param {number} options.limit - Max results
   * @param {boolean} options.includeHighlights - Include match highlights in results (default: true)
   * @returns {Promise<Array<Object>>} Matching items sorted by relevance score
   */
  async search(query, options = {}) {
    try {
      if (!query || typeof query !== 'string' || query.trim().length === 0) {
        return [];
      }
      
      const queryLower = query.toLowerCase().trim();
      const queryWords = queryLower.split(/\s+/).filter(w => w.length > 0);
      
      // Options with defaults
      const searchTags = options.searchTags !== false;
      const searchMetadata = options.searchMetadata !== false;
      const searchContent = options.searchContent === true;
      const fuzzy = options.fuzzy !== false;
      const fuzzyThreshold = options.fuzzyThreshold || 0.7;
      const includeHighlights = options.includeHighlights !== false;
      
      let items = this.storage.getAllItems();
      
      // Filter by space if specified
      if (options.spaceId) {
        items = items.filter(item => item.spaceId === options.spaceId);
      }
      
      // Filter by type if specified
      if (options.type) {
        items = items.filter(item => item.type === options.type);
      }
      
      // Score and filter items
      const scoredItems = [];
      
      for (const item of items) {
        const result = this._scoreItem(item, queryLower, queryWords, {
          searchTags,
          searchMetadata,
          searchContent,
          fuzzy,
          fuzzyThreshold,
          includeHighlights
        });
        
        if (result.score > 0) {
          scoredItems.push({
            ...item,
            tags: result.tags,
            metadata: result.metadata,
            _search: {
              score: result.score,
              matches: result.matches,
              highlights: includeHighlights ? result.highlights : undefined
            }
          });
        }
      }
      
      // Sort by relevance score (highest first), then by timestamp (most recent)
      scoredItems.sort((a, b) => {
        if (b._search.score !== a._search.score) {
          return b._search.score - a._search.score;
        }
        return new Date(b.timestamp) - new Date(a.timestamp);
      });
      
      // Apply limit
      if (options.limit && options.limit > 0) {
        return scoredItems.slice(0, options.limit);
      }
      
      return scoredItems;
    } catch (error) {
      log.error('spaces', 'Error searching', { error: error.message || error });
      throw error;
    }
  }

  /**
   * Score an item against search query
   * @private
   */
  _scoreItem(item, queryLower, queryWords, options) {
    let totalScore = 0;
    const matches = [];
    const highlights = {};
    
    // Get tags and metadata
    const tags = this._getItemTags(item.id);
    const metadata = this._getItemMetadataForSearch(item.id);
    
    // Field weights (higher = more important)
    const WEIGHTS = {
      title: 10,        // Title is most important
      fileName: 8,      // Filename is very important
      tags: 7,          // Tags are explicit categorization
      preview: 5,       // Preview/content preview
      description: 4,   // Description
      notes: 4,         // User notes
      author: 3,        // Author name
      source: 2,        // Source URL/info
      content: 1        // Full content (lower weight, more text)
    };
    
    // Bonus for exact phrase match
    const EXACT_PHRASE_BONUS = 5;
    
    // Helper to check and score a field
    const scoreField = (fieldName, fieldValue, weight) => {
      if (!fieldValue || typeof fieldValue !== 'string') return 0;
      
      const valueLower = fieldValue.toLowerCase();
      let fieldScore = 0;
      const fieldMatches = [];
      
      // Check exact phrase match first (bonus points)
      if (valueLower.includes(queryLower)) {
        fieldScore += weight * EXACT_PHRASE_BONUS;
        fieldMatches.push({ type: 'exact', query: queryLower });
        
        // Add highlight
        if (options.includeHighlights) {
          highlights[fieldName] = this._highlightMatches(fieldValue, [queryLower]);
        }
      }
      
      // Check individual word matches
      for (const word of queryWords) {
        if (valueLower.includes(word)) {
          fieldScore += weight;
          if (!fieldMatches.some(m => m.query === word)) {
            fieldMatches.push({ type: 'word', query: word });
          }
        } else if (options.fuzzy) {
          // Fuzzy matching - find similar words
          const words = valueLower.split(/\s+/);
          for (const fieldWord of words) {
            const similarity = this._stringSimilarity(word, fieldWord);
            if (similarity >= options.fuzzyThreshold) {
              fieldScore += weight * similarity;
              fieldMatches.push({ type: 'fuzzy', query: word, matched: fieldWord, similarity });
            }
          }
        }
      }
      
      if (fieldMatches.length > 0) {
        matches.push({ field: fieldName, matches: fieldMatches });
      }
      
      return fieldScore;
    };
    
    // Score each field
    
    // Title (from metadata)
    totalScore += scoreField('title', metadata.title, WEIGHTS.title);
    
    // File name
    totalScore += scoreField('fileName', item.fileName, WEIGHTS.fileName);
    
    // Tags
    if (options.searchTags && tags.length > 0) {
      const tagsString = tags.join(' ');
      totalScore += scoreField('tags', tagsString, WEIGHTS.tags);
    }
    
    // Preview
    totalScore += scoreField('preview', item.preview, WEIGHTS.preview);
    
    // Metadata fields (works with both v1.0 flat and v2.0 SPACE-normalized metadata)
    if (options.searchMetadata) {
      // A: Attributes
      totalScore += scoreField('description', metadata.description, WEIGHTS.description);
      totalScore += scoreField('notes', metadata.notes, WEIGHTS.notes);
      totalScore += scoreField('author', metadata.author, WEIGHTS.author);
      
      // S: System Insights
      totalScore += scoreField('source', metadata.source, WEIGHTS.source);
      
      // P: Physical Locations
      totalScore += scoreField('sourceUrl', metadata.sourceUrl, WEIGHTS.source);
      totalScore += scoreField('sourceApp', metadata.sourceApp, WEIGHTS.source);
      
      // C: Communication Context
      if (metadata.participants) {
        totalScore += scoreField('participants', metadata.participants, WEIGHTS.author);
      }
      if (metadata.channel) {
        totalScore += scoreField('channel', metadata.channel, WEIGHTS.source);
      }
      
      // E: Event & Sequence Data
      if (metadata.workflowStage) {
        totalScore += scoreField('workflowStage', metadata.workflowStage, WEIGHTS.source);
      }
      
      // Extensions: YouTube
      if (metadata.youtubeDescription) {
        totalScore += scoreField('youtubeDescription', metadata.youtubeDescription, WEIGHTS.description);
      }
      if (metadata.uploader) {
        totalScore += scoreField('uploader', metadata.uploader, WEIGHTS.author);
      }
    }
    
    // Full content search (optional, slower)
    if (options.searchContent && (item.type === 'text' || item.type === 'html')) {
      try {
        const contentPath = path.join(this.storage.storageRoot, item.contentPath);
        if (fs.existsSync(contentPath)) {
          const content = fs.readFileSync(contentPath, 'utf8');
          totalScore += scoreField('content', content, WEIGHTS.content);
        }
      } catch (e) {
        // Silently ignore content read errors
      }
    }
    
    return {
      score: totalScore,
      matches,
      highlights,
      tags,
      metadata
    };
  }

  /**
   * Get item metadata for search (normalizes v1.0 and v2.0 SPACE schema
   * into a flat structure the scoring engine can use consistently)
   * @private
   */
  _getItemMetadataForSearch(itemId) {
    try {
      const metaPath = path.join(this.storage.itemsDir, itemId, 'metadata.json');
      if (fs.existsSync(metaPath)) {
        const raw = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        return this._normalizeMetadataForSearch(raw);
      }
    } catch (error) {
      // Silently fail
    }
    return {};
  }

  /**
   * Normalize v1.0 or v2.0 SPACE metadata into a flat object for search scoring.
   * Reads from SPACE namespaces (attributes, system, physical, communication,
   * events, extensions) when present, falling back to flat v1.0 fields.
   * @private
   */
  _normalizeMetadataForSearch(raw) {
    if (!raw) return {};

    const attr = raw.attributes || {};
    const sys = raw.system || {};
    const phys = raw.physical || {};
    const comm = raw.communication || {};
    const evt = raw.events || {};
    const ext = raw.extensions || {};

    return {
      // A: Attributes
      title:       attr.title       || raw.title       || null,
      description: attr.description || raw.description || null,
      notes:       attr.notes       || raw.notes       || null,
      author:      attr.author      || raw.author      || null,
      tags:        attr.tags        || raw.tags        || [],
      language:    attr.language    || raw.language    || null,

      // S: System Insights
      source:      sys.source       || raw.source      || null,

      // P: Physical Locations
      sourceUrl:   phys.sourceUrl   || raw.sourceUrl   || null,
      sourceApp:   phys.sourceApp   || raw.sourceApp   || null,

      // C: Communication Context
      channel:     comm.channel     || raw.channel     || null,
      participants: (comm.participants && comm.participants.length > 0)
                     ? comm.participants.join(' ')
                     : null,

      // E: Event & Sequence Data
      workflowStage: evt.workflowStage || null,

      // Extensions: YouTube
      youtubeDescription: (ext.youtube && ext.youtube.description) || raw.youtubeDescription || null,
      uploader:           (ext.youtube && ext.youtube.uploader)    || raw.uploader           || null,

      // GSX Push metadata (needed by gsx.* methods that read via _getItemMetadataForSearch)
      gsxPush: raw.gsxPush || null,

      // Data Source metadata
      dataSource: raw.dataSource || null,

      // Pass-through for anything else the scorer might need
      _raw: raw
    };
  }

  /**
   * Calculate string similarity using Levenshtein distance
   * Returns value between 0 (no match) and 1 (exact match)
   * @private
   */
  _stringSimilarity(str1, str2) {
    if (str1 === str2) return 1;
    if (str1.length === 0 || str2.length === 0) return 0;
    
    // Quick check for containment
    if (str1.includes(str2) || str2.includes(str1)) {
      return Math.min(str1.length, str2.length) / Math.max(str1.length, str2.length);
    }
    
    // Levenshtein distance for fuzzy matching
    const matrix = [];
    const len1 = str1.length;
    const len2 = str2.length;
    
    // Quick reject if strings are too different in length
    if (Math.abs(len1 - len2) / Math.max(len1, len2) > 0.5) {
      return 0;
    }
    
    for (let i = 0; i <= len1; i++) {
      matrix[i] = [i];
    }
    for (let j = 0; j <= len2; j++) {
      matrix[0][j] = j;
    }
    
    for (let i = 1; i <= len1; i++) {
      for (let j = 1; j <= len2; j++) {
        const cost = str1[i - 1] === str2[j - 1] ? 0 : 1;
        matrix[i][j] = Math.min(
          matrix[i - 1][j] + 1,     // deletion
          matrix[i][j - 1] + 1,     // insertion
          matrix[i - 1][j - 1] + cost  // substitution
        );
      }
    }
    
    const distance = matrix[len1][len2];
    const maxLen = Math.max(len1, len2);
    return 1 - distance / maxLen;
  }

  /**
   * Create highlighted version of text with matches marked
   * @private
   */
  _highlightMatches(text, queries) {
    if (!text) return '';
    
    let highlighted = text;
    const lowerText = text.toLowerCase();
    
    // Find all match positions
    const positions = [];
    for (const query of queries) {
      let pos = 0;
      while ((pos = lowerText.indexOf(query, pos)) !== -1) {
        positions.push({ start: pos, end: pos + query.length });
        pos += 1;
      }
    }
    
    if (positions.length === 0) return text;
    
    // Sort and merge overlapping positions
    positions.sort((a, b) => a.start - b.start);
    const merged = [positions[0]];
    for (let i = 1; i < positions.length; i++) {
      const last = merged[merged.length - 1];
      if (positions[i].start <= last.end) {
        last.end = Math.max(last.end, positions[i].end);
      } else {
        merged.push(positions[i]);
      }
    }
    
    // Build highlighted string (from end to preserve positions)
    for (let i = merged.length - 1; i >= 0; i--) {
      const { start, end } = merged[i];
      highlighted = 
        highlighted.slice(0, start) + 
        '**' + highlighted.slice(start, end) + '**' + 
        highlighted.slice(end);
    }
    
    // Truncate long text around matches for readability
    if (highlighted.length > 200) {
      const firstMatch = highlighted.indexOf('**');
      if (firstMatch > 50) {
        highlighted = '...' + highlighted.slice(firstMatch - 30);
      }
      if (highlighted.length > 200) {
        highlighted = highlighted.slice(0, 197) + '...';
      }
    }
    
    return highlighted;
  }

  /**
   * Quick search - faster but less comprehensive (searches index only)
   * Good for autocomplete/typeahead
   * @param {string} query - Search query
   * @param {Object} options - Search options
   * @returns {Promise<Array<Object>>} Matching items
   */
  async quickSearch(query, options = {}) {
    return this.search(query, {
      ...options,
      searchMetadata: false,
      searchContent: false,
      fuzzy: false,
      includeHighlights: false,
      limit: options.limit || 10
    });
  }

  /**
   * Deep search - comprehensive but slower (includes full content)
   * Good for thorough searches
   * @param {string} query - Search query
   * @param {Object} options - Search options
   * @returns {Promise<Array<Object>>} Matching items
   */
  async deepSearch(query, options = {}) {
    return this.search(query, {
      ...options,
      searchMetadata: true,
      searchContent: true,
      fuzzy: true,
      includeHighlights: true
    });
  }

  /**
   * Get search suggestions based on existing tags and titles
   * @param {string} prefix - Search prefix
   * @param {number} limit - Max suggestions
   * @returns {Promise<Array<{text: string, type: string, count: number}>>}
   */
  async getSearchSuggestions(prefix, limit = 10) {
    try {
      const prefixLower = prefix.toLowerCase().trim();
      if (prefixLower.length === 0) return [];
      
      const suggestions = new Map();
      const items = this.storage.getAllItems();
      
      for (const item of items) {
        // Get tags
        const tags = this._getItemTags(item.id);
        for (const tag of tags) {
          if (tag.toLowerCase().startsWith(prefixLower)) {
            const key = `tag:${tag.toLowerCase()}`;
            if (!suggestions.has(key)) {
              suggestions.set(key, { text: tag, type: 'tag', count: 0 });
            }
            suggestions.get(key).count++;
          }
        }
        
        // Get title from metadata
        const metadata = this._getItemMetadataForSearch(item.id);
        if (metadata.title && metadata.title.toLowerCase().includes(prefixLower)) {
          const key = `title:${metadata.title.toLowerCase()}`;
          if (!suggestions.has(key)) {
            suggestions.set(key, { text: metadata.title, type: 'title', count: 0 });
          }
          suggestions.get(key).count++;
        }
        
        // Check fileName
        if (item.fileName && item.fileName.toLowerCase().includes(prefixLower)) {
          const key = `file:${item.fileName.toLowerCase()}`;
          if (!suggestions.has(key)) {
            suggestions.set(key, { text: item.fileName, type: 'file', count: 0 });
          }
          suggestions.get(key).count++;
        }
      }
      
      // Sort by count and return top suggestions
      return Array.from(suggestions.values())
        .sort((a, b) => b.count - a.count)
        .slice(0, limit);
    } catch (error) {
      log.error('spaces', 'Error getting search suggestions', { error: error.message || error });
      return [];
    }
  }

  // ============================================
  // METADATA MANAGEMENT
  // ============================================

  /**
   * Metadata API namespace
   */
  get metadata() {
    return {
      /**
       * Get space metadata
       * @param {string} spaceId - The space ID
       * @returns {Promise<Object|null>} Metadata object
       */
      getSpace: async (spaceId) => {
        try {
          return this.storage.getSpaceMetadata(spaceId);
        } catch (error) {
          log.error('spaces', 'Error getting space metadata', { error: error.message || error });
          return null;
        }
      },

      /**
       * Update space metadata
       * @param {string} spaceId - The space ID
       * @param {Object} data - Metadata to merge
       * @returns {Promise<Object|null>} Updated metadata
       */
      updateSpace: async (spaceId, data) => {
        try {
          const updated = this.storage.updateSpaceMetadata(spaceId, data);
          if (updated) {
            this._emit('space:metadata:updated', { spaceId, data });
          }
          return updated;
        } catch (error) {
          log.error('spaces', 'Error updating space metadata', { error: error.message || error });
          return null;
        }
      },

      /**
       * Get file metadata within a space
       * @param {string} spaceId - The space ID
       * @param {string} filePath - The file path
       * @returns {Promise<Object|null>} File metadata
       */
      getFile: async (spaceId, filePath) => {
        try {
          return this.storage.getFileMetadata(spaceId, filePath);
        } catch (error) {
          log.error('spaces', 'Error getting file metadata', { error: error.message || error });
          return null;
        }
      },

      /**
       * Set file metadata within a space
       * @param {string} spaceId - The space ID
       * @param {string} filePath - The file path
       * @param {Object} data - Metadata to set
       * @returns {Promise<Object|null>} Updated space metadata
       */
      setFile: async (spaceId, filePath, data) => {
        try {
          return this.storage.setFileMetadata(spaceId, filePath, data);
        } catch (error) {
          log.error('spaces', 'Error setting file metadata', { error: error.message || error });
          return null;
        }
      },

      /**
       * Set asset metadata (journey map, style guide, etc.)
       * @param {string} spaceId - The space ID
       * @param {string} assetType - The asset type
       * @param {Object} data - Asset metadata
       * @returns {Promise<Object|null>} Updated space metadata
       */
      setAsset: async (spaceId, assetType, data) => {
        try {
          return this.storage.setAssetMetadata(spaceId, assetType, data);
        } catch (error) {
          log.error('spaces', 'Error setting asset metadata', { error: error.message || error });
          return null;
        }
      },

      /**
       * Set approval status
       * @param {string} spaceId - The space ID
       * @param {string} itemType - The item type
       * @param {string} itemId - The item ID
       * @param {boolean} approved - Approval status
       * @returns {Promise<Object|null>} Updated space metadata
       */
      setApproval: async (spaceId, itemType, itemId, approved) => {
        try {
          return this.storage.setApproval(spaceId, itemType, itemId, approved);
        } catch (error) {
          log.error('spaces', 'Error setting approval', { error: error.message || error });
          return null;
        }
      },

      /**
       * Add a version to the space history
       * @param {string} spaceId - The space ID
       * @param {Object} versionData - Version data
       * @returns {Promise<Object|null>} Updated space metadata
       */
      addVersion: async (spaceId, versionData) => {
        try {
          return await this.storage.addVersion(spaceId, versionData);
        } catch (error) {
          log.error('spaces', 'Error adding version', { error: error.message || error });
          return null;
        }
      },

      /**
       * Update project configuration
       * @param {string} spaceId - The space ID
       * @param {Object} config - Config updates
       * @returns {Promise<Object|null>} Updated space metadata
       */
      updateProjectConfig: async (spaceId, config) => {
        try {
          return this.storage.updateProjectConfig(spaceId, config);
        } catch (error) {
          log.error('spaces', 'Error updating project config', { error: error.message || error });
          return null;
        }
      }
    };
  }

  // ============================================
  // FILE SYSTEM ACCESS
  // ============================================

  /**
   * File system API namespace
   */
  get files() {
    return {
      /**
       * Get the path to a space directory
       * @param {string} spaceId - The space ID
       * @returns {Promise<string>} Absolute path to space directory
       */
      getSpacePath: async (spaceId) => {
        return path.join(this.storage.spacesDir, spaceId);
      },

      /**
       * List files in a space directory
       * @param {string} spaceId - The space ID
       * @param {string} subPath - Optional subdirectory
       * @returns {Promise<Array<Object>>} Array of file info objects
       */
      list: async (spaceId, subPath = '') => {
        try {
          const spacePath = this._resolveSpaceFilePath(spaceId, subPath);
          
          if (!fs.existsSync(spacePath)) {
            return [];
          }
          
          const entries = fs.readdirSync(spacePath, { withFileTypes: true });
          
          return entries.map(entry => ({
            name: entry.name,
            isDirectory: entry.isDirectory(),
            path: path.join(spacePath, entry.name),
            relativePath: path.join(subPath, entry.name)
          }));
        } catch (error) {
          if (error.message === 'Path escapes space directory') throw error;
          log.error('spaces', 'Error listing files', { error: error.message || error });
          return [];
        }
      },

      /**
       * Read a file from a space
       * @param {string} spaceId - The space ID
       * @param {string} filePath - Relative path within space
       * @returns {Promise<string|null>} File contents or null
       */
      read: async (spaceId, filePath) => {
        try {
          const fullPath = this._resolveSpaceFilePath(spaceId, filePath);
          
          if (!fs.existsSync(fullPath)) {
            return null;
          }
          
          return fs.readFileSync(fullPath, 'utf8');
        } catch (error) {
          if (error.message === 'Path escapes space directory') throw error;
          log.error('spaces', 'Error reading file', { error: error.message || error });
          return null;
        }
      },

      /**
       * Write a file to a space
       * @param {string} spaceId - The space ID
       * @param {string} filePath - Relative path within space
       * @param {string} content - File content
       * @returns {Promise<boolean>} Success status
       */
      write: async (spaceId, filePath, content) => {
        try {
          // If writing a .md file to gsx-agent space, ensure the space exists first
          if (spaceId === 'gsx-agent' && filePath.endsWith('.md')) {
            await this.ensureGSXAgentSpace();
          }
          
          const fullPath = this._resolveSpaceFilePath(spaceId, filePath);
          const dir = path.dirname(fullPath);
          
          // Ensure directory exists
          fs.mkdirSync(dir, { recursive: true });
          
          fs.writeFileSync(fullPath, content);
          
          this._emit('file:written', { spaceId, filePath });
          return true;
        } catch (error) {
          if (error.message === 'Path escapes space directory') throw error;
          log.error('spaces', 'Error writing file', { error: error.message || error });
          return false;
        }
      },

      /**
       * Delete a file from a space
       * @param {string} spaceId - The space ID
       * @param {string} filePath - Relative path within space
       * @returns {Promise<boolean>} Success status
       */
      delete: async (spaceId, filePath) => {
        try {
          // Protect default context files in GSX Agent space
          if (spaceId === 'gsx-agent') {
            const protectedFiles = ['main.md', 'agent-profile.md'];
            const fileName = filePath.split('/').pop();
            if (protectedFiles.includes(fileName)) {
              log.warn('spaces', 'Cannot delete protected file', { fileName });
              throw new Error(`Cannot delete ${fileName} - this is a required system file`);
            }
          }
          
          const fullPath = this._resolveSpaceFilePath(spaceId, filePath);
          
          if (fs.existsSync(fullPath)) {
            fs.unlinkSync(fullPath);
            this._emit('file:deleted', { spaceId, filePath });
            return true;
          }
          
          return false;
        } catch (error) {
          if (error.message === 'Path escapes space directory') throw error;
          log.error('spaces', 'Error deleting file', { error: error.message || error });
          return false;
        }
      }
    };
  }

  // ============================================
  // EVENT SYSTEM
  // ============================================

  /**
   * Register an event listener
   * @param {string} event - Event name
   * @param {Function} callback - Callback function
   * @returns {Function} Unsubscribe function
   */
  on(event, callback) {
    if (!this._eventListeners.has(event)) {
      this._eventListeners.set(event, new Set());
    }
    this._eventListeners.get(event).add(callback);
    
    // Return unsubscribe function
    return () => {
      const listeners = this._eventListeners.get(event);
      if (listeners) {
        listeners.delete(callback);
      }
    };
  }

  /**
   * Emit an event
   * @private
   */
  _emit(event, data) {
    const listeners = this._eventListeners.get(event);
    if (listeners) {
      listeners.forEach(callback => {
        try {
          callback(data);
        } catch (error) {
          log.error('spaces', 'Error in event listener', { error: error.message || error });
        }
      });
    }
    
    // Also emit to global broadcast handler if set
    if (this._broadcastHandler) {
      this._broadcastHandler(event, data);
    }
  }

  /**
   * Set a broadcast handler for cross-window events
   * @param {Function} handler - Handler function (event, data) => void
   */
  setBroadcastHandler(handler) {
    this._broadcastHandler = handler;
  }

  // ============================================
  // PRIVATE HELPER METHODS
  // ============================================

  /**
   * Get tags for an item from its metadata file
   * @private
   * @param {string} itemId - The item ID
   * @returns {Array<string>} Array of tags
   */
  _getItemTags(itemId) {
    try {
      const metaPath = path.join(this.storage.itemsDir, itemId, 'metadata.json');
      const fileExists = fs.existsSync(metaPath);
      
      if (fileExists) {
        const metadata = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        
        // SPACE schema (v2.0+): tags in attributes.tags; v1.0: tags at root
        // Prefer non-empty attributes.tags, then root tags, then empty
        const attrTags = metadata.attributes && Array.isArray(metadata.attributes.tags) ? metadata.attributes.tags : [];
        const rootTags = Array.isArray(metadata.tags) ? metadata.tags : [];
        return attrTags.length > 0 ? attrTags : (rootTags.length > 0 ? rootTags : []);
      }
    } catch (error) {
      // Silently fail - item may not have metadata
    }
    return [];
  }

  /**
   * Update item metadata file.
   * Handles both v1.0 (flat) and v2.0 (SPACE-namespaced) metadata.
   * For v2.0, known fields are routed into the correct SPACE namespace.
   * @private
   * @param {string} itemId - The item ID
   * @param {Object} updates - Properties to update
   * @returns {boolean} Success status
   */
  _updateItemMetadata(itemId, updates) {
    try {
      const metaPath = path.join(this.storage.itemsDir, itemId, 'metadata.json');
      let metadata = {};
      
      if (fs.existsSync(metaPath)) {
        metadata = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      }
      
      // Accept any SPACE schema version (2.0, 3.0, etc.) -- not just 2.0
      const isV2 = metadata._schema && parseFloat(metadata._schema.version) >= 2.0;
      
      if (isV2) {
        // Route known flat fields into their SPACE namespaces
        if (updates.tags !== undefined) {
          metadata.attributes = metadata.attributes || {};
          metadata.attributes.tags = updates.tags;
        }
        if (updates.title !== undefined) {
          metadata.attributes = metadata.attributes || {};
          metadata.attributes.title = updates.title;
        }
        if (updates.description !== undefined) {
          metadata.attributes = metadata.attributes || {};
          metadata.attributes.description = updates.description;
        }
        if (updates.notes !== undefined) {
          metadata.attributes = metadata.attributes || {};
          metadata.attributes.notes = updates.notes;
        }
        if (updates.pinned !== undefined) {
          metadata.attributes = metadata.attributes || {};
          metadata.attributes.pinned = updates.pinned;
        }
        if (updates.author !== undefined) {
          metadata.attributes = metadata.attributes || {};
          metadata.attributes.author = updates.author;
        }
        if (updates.source !== undefined) {
          metadata.system = metadata.system || {};
          metadata.system.source = updates.source;
        }
        // Merge any SPACE namespace objects passed directly
        for (const ns of ['system', 'physical', 'attributes', 'communication', 'events', 'extensions']) {
          if (updates[ns] && typeof updates[ns] === 'object') {
            metadata[ns] = { ...(metadata[ns] || {}), ...updates[ns] };
          }
        }
        // Pass through non-SPACE fields (scenes, etc.)
        const handledKeys = new Set([
          'tags', 'title', 'description', 'notes', 'pinned', 'author', 'source',
          'system', 'physical', 'attributes', 'communication', 'events', 'extensions'
        ]);
        for (const key of Object.keys(updates)) {
          if (!handledKeys.has(key)) {
            metadata[key] = updates[key];
          }
        }
        metadata.dateModified = new Date().toISOString();
      } else {
        // v1.0 flat metadata: simple merge
        Object.assign(metadata, updates);
        metadata.updatedAt = new Date().toISOString();
      }
      
      fs.writeFileSync(metaPath, JSON.stringify(metadata, null, 2));
      return true;
    } catch (error) {
      log.error('spaces', 'Error updating item metadata', { error: error.message || error });
      return false;
    }
  }

  /**
   * Check if auto-metadata generation should run for an item
   * @private
   * @param {Object} item - The item being added
   * @returns {boolean} Whether to generate metadata
   */
  _shouldAutoGenerateMetadata(item) {
    try {
      // Check if settingsManager is available
      if (!global.settingsManager) {
        log.debug('spaces', 'Settings manager not available, skipping auto-metadata');
        return false;
      }

      // Check if auto-generation is enabled
      const autoAIMetadata = global.settingsManager.get('autoAIMetadata');
      if (!autoAIMetadata) {
        return false;
      }

      // Check if we have an API key
      const apiKey = global.settingsManager.get('openaiApiKey');
      if (!apiKey) {
        return false;
      }

      // Check if this item type is enabled for auto-generation
      const enabledTypes = global.settingsManager.get('autoAIMetadataTypes') || ['all'];
      if (!enabledTypes.includes('all') && !enabledTypes.includes(item.type)) {
        return false;
      }

      // Check if item already has complete metadata
      const hasTitle = item.metadata?.title && item.metadata.title.trim().length > 0;
      const hasDescription = item.metadata?.description && item.metadata.description.trim().length > 0;
      const hasTags = item.tags && item.tags.length > 0;

      // Generate if missing title, description, or tags
      const needsMetadata = !hasTitle || !hasDescription || !hasTags;
      
      return needsMetadata;
    } catch (error) {
      log.error('spaces', 'Error checking auto-metadata settings', { error: error.message || error });
      return false;
    }
  }

  /**
   * Queue metadata generation in the background (non-blocking)
   * @private
   * @param {string} itemId - The item ID
   * @param {string} spaceId - The space ID
   * @param {string} itemType - The item type
   */
  _queueMetadataGeneration(itemId, spaceId, itemType) {
    // Run asynchronously to not block the add operation
    setImmediate(async () => {
      try {
        log.info('spaces', 'Starting background metadata generation', { itemId });
        
        const apiKey = global.settingsManager?.get('openaiApiKey');
        if (!apiKey) {
          log.debug('spaces', 'No API key, skipping metadata generation');
          return;
        }

        // Get the metadata generator
        const MetadataGenerator = require('./metadata-generator');
        const storageRef = this.storage;
        
        // Create a clipboard manager interface with updateItemMetadata method
        const clipboardInterface = {
          storage: this.storage,
          spaces: this.storage.index.spaces || [],
          // Add the updateItemMetadata method that MetadataGenerator expects
          async updateItemMetadata(itemId, metadata) {
            try {
              const item = storageRef.loadItem(itemId);
              if (!item) {
                // Item may have been deleted between creation and metadata generation
                log.debug('spaces', 'Skipping metadata update for deleted item', { itemId });
                return { success: false, error: 'Item not found' };
              }
              
              const fs = require('fs');
              const path = require('path');
              const metadataPath = path.join(storageRef.storageRoot, 'items', itemId, 'metadata.json');
              
              // Read existing metadata and deep-merge (preserves tags, etc. in namespace objects)
              let existingMetadata = {};
              if (fs.existsSync(metadataPath)) {
                try {
                  existingMetadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
                } catch (parseErr) {
                  log.warn('spaces', 'Could not parse existing metadata', { error: parseErr.message });
                }
              }
              
              // Deep merge for SPACE namespace objects (attributes, system, etc.)
              // so auto-metadata doesn't overwrite user-set tags
              const mergedMetadata = { ...existingMetadata };
              for (const key of Object.keys(metadata)) {
                if (metadata[key] && typeof metadata[key] === 'object' && !Array.isArray(metadata[key])
                    && existingMetadata[key] && typeof existingMetadata[key] === 'object' && !Array.isArray(existingMetadata[key])) {
                  mergedMetadata[key] = { ...existingMetadata[key], ...metadata[key] };
                } else {
                  mergedMetadata[key] = metadata[key];
                }
              }
              fs.writeFileSync(metadataPath, JSON.stringify(mergedMetadata, null, 2));
              
              return { success: true };
            } catch (err) {
              // Downgrade "not found" errors to debug (item deleted before metadata generation)
              const msg = err.message || '';
              if (msg.includes('not found') || msg.includes('ENOENT')) {
                log.debug('spaces', 'Auto-metadata skipped (item removed)', { itemId });
              } else {
                log.error('spaces', 'updateItemMetadata error', { error: msg });
              }
              return { success: false, error: msg };
            }
          }
        };
        
        const generator = new MetadataGenerator(clipboardInterface);
        const result = await generator.generateMetadataForItem(itemId, apiKey);
        
        if (result.success) {
          log.info('spaces', 'Auto-generated metadata', { itemId });
          
          // Emit event for listeners
          this._emit('item:metadata:generated', {
            spaceId,
            itemId,
            metadata: result.metadata || result
          });
        } else {
          log.warn('spaces', 'Auto-metadata generation failed (non-critical)', { error: result.error });
        }
      } catch (error) {
        log.warn('spaces', 'Background metadata generation error (non-critical)', { error: error.message || error });
      }
    });
  }

  /**
   * Generate metadata for an item (manual trigger)
   * @param {string} itemId - The item ID
   * @param {Object} options - Generation options
   * @param {string} options.apiKey - Override API key
   * @param {string} options.customPrompt - Custom prompt for generation
   * @returns {Promise<Object>} Generated metadata or error
   */
  async generateMetadataForItem(itemId, options = {}) {
    try {
      // Get item to find its space
      const item = this.storage.loadItem(itemId);
      if (!item) {
        return { success: false, error: 'Item not found' };
      }

      // Get API key
      const apiKey = options.apiKey || global.settingsManager?.get('openaiApiKey');
      if (!apiKey) {
        return { success: false, error: 'No API key available' };
      }

      // Get the metadata generator
      const MetadataGenerator = require('./metadata-generator');
      const storageRef = this.storage;
      
      // Create a clipboard manager interface with updateItemMetadata method
      const clipboardInterface = {
        storage: this.storage,
        spaces: this.storage.index.spaces || [],
        // Add the updateItemMetadata method that MetadataGenerator expects
        async updateItemMetadata(itemId, metadata) {
          try {
            const item = storageRef.loadItem(itemId);
            if (!item) return { success: false, error: 'Item not found' };
            
            const fs = require('fs');
            const path = require('path');
            const metadataPath = path.join(storageRef.storageRoot, 'items', itemId, 'metadata.json');
            
            // Read existing metadata and merge
            let existingMetadata = {};
            if (fs.existsSync(metadataPath)) {
              try {
                existingMetadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
              } catch (parseErr) {
                  log.warn('spaces', 'Could not parse existing metadata', { error: parseErr.message });
                }
              }
              
              const mergedMetadata = { ...existingMetadata, ...metadata };
              fs.writeFileSync(metadataPath, JSON.stringify(mergedMetadata, null, 2));
              
              return { success: true };
            } catch (err) {
              log.error('spaces', 'updateItemMetadata error', { error: err.message || err });
              return { success: false, error: err.message };
            }
          }
        };
      
      const generator = new MetadataGenerator(clipboardInterface);
      const result = await generator.generateMetadataForItem(itemId, apiKey, options.customPrompt || '');
      
      if (result.success) {
        // Emit event for listeners
        this._emit('item:metadata:generated', {
          spaceId: item.spaceId,
          itemId,
          metadata: result.metadata || result
        });
      }
      
      return result;
    } catch (error) {
      log.error('spaces', 'Error generating metadata', { error: error.message || error });
      return { success: false, error: error.message };
    }
  }

  // ============================================
  // GSX PUSH API
  // ============================================

  /**
   * GSX Push API namespace for pushing assets and spaces to GSX ecosystem
   * All push operations go through here for consistency across all sources.
   */
  get gsx() {
    // Lazy load dependencies
    const { getOmniGraphClient, computeContentHash, computeVersionNumber } = require('./omnigraph-client');
    const crypto = require('crypto');
    
    /**
     * Verify a file URL is accessible
     * @param {string} fileUrl - URL to verify
     * @param {number} timeout - Timeout in ms (default 10s)
     * @returns {Promise<Object>} { verified, statusCode, reason }
     */
    const verifyFileUrl = async (fileUrl, timeout = 10000) => {
      if (!fileUrl) {
        return { verified: false, reason: 'No file URL provided' };
      }
      
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout);
        
        const response = await fetch(fileUrl, { 
          method: 'HEAD',
          signal: controller.signal
        });
        
        clearTimeout(timeoutId);
        
        return { 
          verified: response.ok,
          statusCode: response.status,
          reason: response.ok ? null : `HTTP ${response.status}`
        };
      } catch (error) {
        if (error.name === 'AbortError') {
          return { verified: false, reason: 'File verification timed out' };
        }
        return { verified: false, reason: error.message };
      }
    };
    
    return {
      /**
       * Get the OmniGraph client instance
       * @returns {OmniGraphClient}
       */
      getClient: () => {
        return getOmniGraphClient();
      },

      /**
       * Initialize GSX push with endpoint, auth, and user context
       * @param {string} endpoint - OmniGraph endpoint URL
       * @param {Function} getAuthToken - Function that returns auth token (optional, will use settings if not provided)
       * @param {string} currentUser - Current user email for provenance tracking
       */
      initialize: (endpoint, getAuthToken, currentUser) => {
        const client = getOmniGraphClient();
        client.setEndpoint(endpoint);
        
        // Set up auth token getter - use provided function or default to settings
        if (getAuthToken) {
          client.setAuthTokenGetter(getAuthToken);
        } else {
          // Default: get token from settings manager
          const { getSettingsManager } = require('./settings-manager');
          client.setAuthTokenGetter(() => {
            const settings = getSettingsManager();
            return settings.get('gsxToken') || null;
          });
        }
        
        if (currentUser) {
          client.setCurrentUser(currentUser);
        }
        log.info('spaces', 'GSX Push initialized', { endpoint, user: currentUser || 'system' });
      },
      
      /**
       * Set the current user for provenance tracking
       * @param {string} user - User email
       */
      setCurrentUser: (user) => {
        const client = getOmniGraphClient();
        client.setCurrentUser(user);
      },

      /**
       * Push a single asset to GSX (Files + Graph)
       * @param {string} itemId - Item ID to push
       * @param {Object} options - Push options
       * @param {boolean} options.isPublic - Public or private visibility
       * @param {boolean} options.force - Force push even if already synced
       * @returns {Promise<Object>} { success, fileUrl, graphNodeId, version, contentHash }
       */
      pushAsset: async (itemId, options = { isPublic: false }) => {
        try {
          // 1. Load item
          const item = this.storage.loadItem(itemId);
          if (!item) {
            return { success: false, error: 'ITEM_NOT_FOUND', message: 'Item not found' };
          }

          // 2. Get existing GSX metadata
          const metadata = this._getItemMetadataForSearch(itemId);
          const gsxPush = metadata.gsxPush || {};
          const history = gsxPush.history || [];

          // 3. Compute content hash
          let localHash;
          try {
            const contentPath = path.join(this.storage.storageRoot, item.contentPath);
            localHash = computeContentHash(contentPath);
          } catch (hashError) {
            log.error('spaces', 'Failed to compute content hash', { error: hashError.message || hashError });
            return { success: false, error: 'HASH_ERROR', message: 'Failed to read file content' };
          }

          // 4. Check if already synced (skip if no changes)
          if (localHash === gsxPush.pushedHash && !options.force) {
            return { success: true, skipped: true, message: 'Already synced', version: gsxPush.version };
          }

          // 5. Compute version number
          const version = computeVersionNumber(history, localHash);

          // 6. Push file to GSX Files API (via gsx-file-sync if available)
          let fileUrl = gsxPush.fileUrl || null;
          try {
            if (global.gsxFileSync && typeof global.gsxFileSync.pushFile === 'function') {
              const contentPath = path.join(this.storage.storageRoot, item.contentPath);
              const remotePath = `spaces/${item.spaceId}/assets/${itemId}/${item.fileName || 'content'}`;
              const result = await global.gsxFileSync.pushFile(contentPath, remotePath, { isPublic: options.isPublic });
              fileUrl = result.url || result.fileUrl || fileUrl;
            } else {
              // Fallback: construct expected URL format
              log.warn('spaces', 'gsxFileSync not available, using existing fileUrl');
            }
          } catch (fileError) {
            if (fileError.message?.includes('413') || fileError.message?.includes('too large')) {
              return { success: false, error: 'FILE_TOO_LARGE', message: 'File exceeds size limit (500MB)' };
            }
            log.warn('spaces', 'File push error (non-critical)', { error: fileError.message });
            // Continue - we can still update graph even if file push fails
          }

          // 7. Push to Graph (ALL metadata goes to graph - two-layer architecture)
          let graphNodeId = gsxPush.graphNodeId || null;
          let graphPushSucceeded = false;
          try {
            const client = getOmniGraphClient();
            if (client.isReady()) {
              const assetType = item.fileCategory || item.type || 'file';
              
              // Get file stats for size
              let fileSize = 0;
              try {
                const contentPath = path.join(this.storage.storageRoot, item.contentPath);
                const stats = fs.statSync(contentPath);
                fileSize = stats.size;
              } catch (e) {
                fileSize = item.size || 0;
              }

              // Load full space metadata so the space is created properly in the graph
              let spaceData = null;
              try {
                const space = this.storage.index.spaces.find(s => s.id === item.spaceId);
                if (space) {
                  const spaceMetadata = this.storage.getSpaceMetadata(item.spaceId);
                  spaceData = {
                    id: space.id,
                    name: space.name || space.id,
                    description: spaceMetadata?.description || '',
                    icon: space.icon || '',
                    color: space.color || '#64c8ff',
                    visibility: options.isPublic ? 'public' : 'private'
                  };
                }
              } catch (spaceError) {
                log.warn('spaces', 'Could not load space metadata', { error: spaceError.message });
              }

              // Build full asset object with all metadata
              const assetData = {
                id: itemId,
                title: metadata.title || item.fileName || item.name || 'Untitled',
                description: metadata.description || '',
                fileName: item.fileName || '',
                fileType: item.fileType || '',
                fileSize: fileSize,
                fileUrl: fileUrl || '',
                visibility: options.isPublic ? 'public' : 'private',
                version,
                contentHash: localHash,
                tags: metadata.tags || [],
                source: metadata.source || item.source || '',
                author: metadata.author || '',
                notes: metadata.notes || ''
              };
              
              // Add data-source-specific fields to graph node (no secrets)
              if (item.type === 'data-source') {
                const ds = item.dataSource || {};
                assetData.sourceType = ds.sourceType || item.sourceType || '';
                assetData.protocol = (ds.connection || {}).protocol || '';
                assetData.dataSourceUrl = (ds.connection || {}).url || '';
                assetData.authType = (ds.auth || {}).type || 'none';
                assetData.operationsEnabled = ['create','read','update','delete','list']
                  .filter(op => ds.operations && ds.operations[op] && ds.operations[op].enabled)
                  .join(',');
                assetData.dataSourceStatus = ds.status || 'inactive';
                assetData.documentVisibility = (ds.document || {}).visibility || 'private';
                // Use document content as description if no description set
                if (!assetData.description && ds.document && ds.document.content) {
                  assetData.description = ds.document.content.substring(0, 500);
                }
              }

              // Pass full space data so the space is created with proper metadata
              await client.upsertAsset(assetData, item.spaceId, assetType, spaceData);
              graphNodeId = `asset_${itemId}`;
              graphPushSucceeded = true;
              
              // 8. VERIFY graph write succeeded with checksum match
              log.info('spaces', 'Verifying graph write');
              const graphVerification = await client.verifyAsset(itemId, localHash);
              
              if (!graphVerification.verified) {
                log.error('spaces', 'Graph verification failed', { reason: graphVerification.reason });
                return {
                  success: false,
                  error: 'GRAPH_VERIFICATION_FAILED',
                  message: graphVerification.reason,
                  details: graphVerification
                };
              }
              
              log.info('spaces', 'Graph verification passed', { title: graphVerification.title });
              
              // Use verified fileUrl from graph if available
              if (graphVerification.fileUrl) {
                fileUrl = graphVerification.fileUrl;
              }
            } else {
              log.warn('spaces', 'OmniGraph client not ready - skipping graph push');
            }
          } catch (graphError) {
            log.error('spaces', 'Graph push error', { error: graphError.message });
            if (graphError.message.includes('timeout')) {
              return {
                success: false,
                error: 'GRAPH_TIMEOUT',
                partial: true,
                fileUrl,
                graphNodeId: null,
                version,
                message: 'Graph update timed out. Please retry.',
                retryable: true
              };
            }
            return {
              success: false,
              error: 'GRAPH_ERROR',
              message: graphError.message,
              retryable: true
            };
          }

          // 9. Optionally verify file URL is accessible (non-blocking)
          let fileVerification = { verified: false, reason: 'Not checked' };
          if (fileUrl) {
            try {
              fileVerification = await verifyFileUrl(fileUrl);
              if (fileVerification.verified) {
                log.info('spaces', 'File URL verification passed');
              } else {
                // File verification failure is non-fatal (might be auth required)
                log.warn('spaces', 'File URL verification failed', { reason: fileVerification.reason });
              }
            } catch (e) {
              log.warn('spaces', 'File verification skipped', { error: e.message });
            }
          }

          // 10. Update local metadata (only after graph verification passed)
          const newHistory = [...history];
          if (!history.some(h => h.contentHash === localHash)) {
            newHistory.push({
              version,
              contentHash: localHash,
              pushedAt: new Date().toISOString(),
              visibility: options.isPublic ? 'public' : 'private'
            });
          }

          const newGsxPush = {
            status: 'pushed',
            fileUrl: fileUrl || null,
            graphNodeId: graphNodeId || null,
            visibility: options.isPublic ? 'public' : 'private',
            version,
            pushedHash: localHash,
            localHash,
            pushedAt: new Date().toISOString(),
            pushedBy: 'desktop-app',
            unpushedAt: null,
            history: newHistory,
            verification: {
              graph: graphPushSucceeded,
              file: fileVerification.verified,
              verifiedAt: new Date().toISOString()
            }
          };

          this._updateItemMetadata(itemId, { gsxPush: newGsxPush });

          log.info('spaces', 'Pushed and verified asset', { itemId, version });
          this._emit('gsx:asset:pushed', { itemId, spaceId: item.spaceId, version, fileUrl, verified: true });

          return {
            success: true,
            verified: graphPushSucceeded,
            fileUrl: fileUrl || null,
            fileLink: fileUrl || null, // Alias for convenience
            graphNodeId: graphNodeId || null,
            version,
            contentHash: localHash,
            verification: {
              graph: graphPushSucceeded,
              graphDetails: graphPushSucceeded ? {
                spaceId: item.spaceId,
                assetType: item.fileCategory || item.type || 'file'
              } : null,
              file: fileVerification.verified,
              fileDetails: fileVerification,
              timestamp: new Date().toISOString()
            }
          };
        } catch (error) {
          log.error('spaces', 'Push asset error', { error: error.message || error });
          
          if (error.message?.includes('ENOTFOUND') || error.message?.includes('network')) {
            return { success: false, error: 'NETWORK_ERROR', message: 'No internet connection', retryable: true };
          }
          
          return { success: false, error: 'UNKNOWN', message: error.message, retryable: false };
        }
      },

      /**
       * Push multiple assets to GSX (bulk operation)
       * @param {string[]} itemIds - Array of item IDs
       * @param {Object} options - Push options
       * @param {boolean} options.isPublic - Public or private visibility
       * @param {Function} options.onProgress - Progress callback (current, total, item)
       * @returns {Promise<Object>} { success, pushed: [], skipped: [], failed: [] }
       */
      pushAssets: async (itemIds, options = { isPublic: false, onProgress: null }) => {
        const results = {
          success: true,
          pushed: [],
          skipped: [],
          failed: []
        };

        for (let i = 0; i < itemIds.length; i++) {
          const itemId = itemIds[i];
          
          if (options.onProgress) {
            options.onProgress(i + 1, itemIds.length, itemId);
          }

          try {
            const result = await this.gsx.pushAsset(itemId, { isPublic: options.isPublic });
            
            if (result.success) {
              if (result.skipped) {
                results.skipped.push({ itemId, ...result });
              } else {
                results.pushed.push({ itemId, ...result });
              }
            } else {
              results.failed.push({ itemId, ...result });
            }
          } catch (error) {
            results.failed.push({ itemId, error: error.message });
          }
        }

        results.success = results.pushed.length > 0 || results.skipped.length > 0;
        
        log.info('spaces', 'Bulk push completed', {
          pushed: results.pushed.length,
          skipped: results.skipped.length,
          failed: results.failed.length
        });

        return results;
      },

      /**
       * Push a space to GSX (as a Note in the graph)
       * @param {string} spaceId - Space ID
       * @param {Object} options - Push options
       * @param {boolean} options.isPublic - Public or private visibility
       * @param {boolean} options.includeAssets - Also push all assets in space
       * @param {Function} options.onProgress - Progress callback
       * @returns {Promise<Object>} { success, graphNodeId, assetsPushed }
       */
      pushSpace: async (spaceId, options = { isPublic: false, includeAssets: false, onProgress: null }) => {
        try {
          // 1. Get space data
          const space = await this.get(spaceId);
          if (!space) {
            return { success: false, error: 'SPACE_NOT_FOUND', message: 'Space not found' };
          }

          // 2. Push space to graph
          let graphNodeId;
          try {
            const client = getOmniGraphClient();
            if (client.isReady()) {
              await client.upsertSpace({
                id: spaceId,
                name: space.name,
                color: space.color,
                visibility: options.isPublic ? 'public' : 'private'
              });
              graphNodeId = `space_${spaceId}`;
            }
          } catch (graphError) {
            log.error('spaces', 'Space graph push error', { error: graphError.message });
          }

          // 3. Optionally push all assets
          let assetResults = { pushed: [], skipped: [], failed: [] };
          if (options.includeAssets) {
            const items = await this.items.list(spaceId);
            const itemIds = items.map(i => i.id);
            
            assetResults = await this.gsx.pushAssets(itemIds, {
              isPublic: options.isPublic,
              onProgress: options.onProgress
            });
          }

          // 4. Update space metadata
          const spaceGsxPush = {
            status: 'pushed',
            graphNodeId,
            visibility: options.isPublic ? 'public' : 'private',
            pushedAt: new Date().toISOString(),
            assetsPushed: assetResults.pushed.length,
            assetsTotal: options.includeAssets ? 
              (assetResults.pushed.length + assetResults.skipped.length + assetResults.failed.length) : 0
          };

          await this.metadata.updateSpace(spaceId, { gsxPush: spaceGsxPush });

          log.info('spaces', 'Pushed space', { spaceId });
          this._emit('gsx:space:pushed', { spaceId, assetsPushed: assetResults.pushed.length });

          return {
            success: true,
            graphNodeId,
            assetsPushed: assetResults.pushed.length,
            assetsSkipped: assetResults.skipped.length,
            assetsFailed: assetResults.failed.length
          };
        } catch (error) {
          log.error('spaces', 'Push space error', { error: error.message || error });
          return { success: false, error: 'UNKNOWN', message: error.message };
        }
      },

      /**
       * Unpush an asset - marks as unpublished in graph, keeps file
       * @param {string} itemId - Item ID to unpush
       * @returns {Promise<Object>} { success, message }
       */
      unpushAsset: async (itemId) => {
        try {
          const item = this.storage.loadItem(itemId);
          if (!item) {
            return { success: false, error: 'ITEM_NOT_FOUND', message: 'Item not found' };
          }

          const metadata = this._getItemMetadataForSearch(itemId);
          const gsxPush = metadata.gsxPush;
          
          if (!gsxPush || gsxPush.status === 'not_pushed') {
            return { success: false, error: 'NOT_PUSHED', message: 'Item is not pushed to GSX' };
          }

          // Soft-delete in graph
          try {
            const client = getOmniGraphClient();
            if (client.isReady()) {
              await client.softDeleteAsset(itemId);
            }
          } catch (graphError) {
            log.error('spaces', 'Graph soft-delete error', { error: graphError.message });
          }

          // Update local metadata
          const newGsxPush = {
            ...gsxPush,
            status: 'unpushed',
            unpushedAt: new Date().toISOString()
          };

          this._updateItemMetadata(itemId, { gsxPush: newGsxPush });

          log.info('spaces', 'Unpushed asset', { itemId });
          this._emit('gsx:asset:unpushed', { itemId, spaceId: item.spaceId });

          return { success: true, message: 'Asset unpushed from GSX' };
        } catch (error) {
          log.error('spaces', 'Unpush asset error', { error: error.message || error });
          return { success: false, error: 'UNKNOWN', message: error.message };
        }
      },

      /**
       * Unpush multiple assets
       * @param {string[]} itemIds - Item IDs to unpush
       * @returns {Promise<Object>} { success, unpushed: [], failed: [] }
       */
      unpushAssets: async (itemIds) => {
        const results = { success: true, unpushed: [], failed: [] };

        for (const itemId of itemIds) {
          const result = await this.gsx.unpushAsset(itemId);
          if (result.success) {
            results.unpushed.push(itemId);
          } else {
            results.failed.push({ itemId, ...result });
          }
        }

        results.success = results.unpushed.length > 0;
        return results;
      },

      /**
       * Unpush a space - marks as unpublished, optionally unpush assets
       * @param {string} spaceId - Space ID
       * @param {Object} options
       * @param {boolean} options.includeAssets - Also unpush all assets
       */
      unpushSpace: async (spaceId, options = { includeAssets: false }) => {
        try {
          // Soft-delete space in graph
          try {
            const client = getOmniGraphClient();
            if (client.isReady()) {
              await client.softDeleteSpace(spaceId, options.includeAssets);
            }
          } catch (graphError) {
            log.error('spaces', 'Space soft-delete error', { error: graphError.message });
          }

          // Optionally unpush all assets
          if (options.includeAssets) {
            const items = await this.items.list(spaceId);
            for (const item of items) {
              await this.gsx.unpushAsset(item.id);
            }
          }

          // Update space metadata
          const spaceMetadata = await this.metadata.getSpace(spaceId);
          await this.metadata.updateSpace(spaceId, {
            gsxPush: {
              ...(spaceMetadata?.gsxPush || {}),
              status: 'unpushed',
              unpushedAt: new Date().toISOString()
            }
          });

          log.info('spaces', 'Unpushed space', { spaceId });
          this._emit('gsx:space:unpushed', { spaceId });

          return { success: true };
        } catch (error) {
          log.error('spaces', 'Unpush space error', { error: error.message || error });
          return { success: false, error: 'UNKNOWN', message: error.message };
        }
      },

      /**
       * Change visibility of a pushed asset (public <-> private)
       * @param {string} itemId - Item ID
       * @param {boolean} isPublic - New visibility
       * @returns {Promise<Object>} { success, newVisibility, fileUrl }
       */
      changeVisibility: async (itemId, isPublic) => {
        try {
          const item = this.storage.loadItem(itemId);
          if (!item) {
            return { success: false, error: 'ITEM_NOT_FOUND', message: 'Item not found' };
          }

          const metadata = this._getItemMetadataForSearch(itemId);
          const gsxPush = metadata.gsxPush;

          if (!gsxPush || gsxPush.status !== 'pushed') {
            return { success: false, error: 'NOT_PUSHED', message: 'Item must be pushed first' };
          }

          // Update in graph
          try {
            const client = getOmniGraphClient();
            if (client.isReady()) {
              await client.changeAssetVisibility(itemId, isPublic ? 'public' : 'private');
            }
          } catch (graphError) {
            log.error('spaces', 'Visibility change graph error', { error: graphError.message });
          }

          // Update local metadata
          const newGsxPush = {
            ...gsxPush,
            visibility: isPublic ? 'public' : 'private'
          };

          this._updateItemMetadata(itemId, { gsxPush: newGsxPush });

          this._emit('gsx:asset:visibility:changed', { itemId, visibility: newGsxPush.visibility });

          return {
            success: true,
            newVisibility: newGsxPush.visibility,
            fileUrl: gsxPush.fileUrl
          };
        } catch (error) {
          log.error('spaces', 'Change visibility error', { error: error.message || error });
          return { success: false, error: 'UNKNOWN', message: error.message };
        }
      },

      /**
       * Change visibility for multiple assets
       * @param {string[]} itemIds - Item IDs
       * @param {boolean} isPublic - New visibility
       */
      changeVisibilityBulk: async (itemIds, isPublic) => {
        const results = { success: true, changed: [], failed: [] };

        for (const itemId of itemIds) {
          const result = await this.gsx.changeVisibility(itemId, isPublic);
          if (result.success) {
            results.changed.push(itemId);
          } else {
            results.failed.push({ itemId, ...result });
          }
        }

        results.success = results.changed.length > 0;
        return results;
      },

      /**
       * Get push status for an item
       * @param {string} itemId - Item ID
       * @returns {Promise<Object>} { status, fileUrl, graphNodeId, version, pushedAt, hasLocalChanges }
       */
      getPushStatus: async (itemId) => {
        try {
          const item = this.storage.loadItem(itemId);
          if (!item) {
            return { status: 'not_found', hasLocalChanges: false };
          }

          const metadata = this._getItemMetadataForSearch(itemId);
          const gsxPush = metadata.gsxPush || {};

          // Compute current local hash
          let localHash;
          try {
            const contentPath = path.join(this.storage.storageRoot, item.contentPath);
            localHash = computeContentHash(contentPath);
          } catch (e) {
            localHash = gsxPush.localHash;
          }

          // Determine status
          let status = 'not_pushed';
          let hasLocalChanges = false;

          if (gsxPush.unpushedAt) {
            status = 'unpushed';
          } else if (gsxPush.pushedHash) {
            if (gsxPush.pushedHash === localHash) {
              status = 'pushed';
            } else {
              status = 'changed_locally';
              hasLocalChanges = true;
            }
          }

          return {
            status,
            fileUrl: gsxPush.fileUrl,
            shareLink: gsxPush.shareLink || gsxPush.fileUrl,
            graphNodeId: gsxPush.graphNodeId,
            version: gsxPush.version,
            visibility: gsxPush.visibility,
            pushedAt: gsxPush.pushedAt,
            pushedHash: gsxPush.pushedHash,
            localHash,
            hasLocalChanges,
            history: gsxPush.history || []
          };
        } catch (error) {
          log.error('spaces', 'Get push status error', { error: error.message || error });
          return { status: 'error', error: error.message };
        }
      },

      /**
       * Get push statuses for multiple items (efficient bulk query)
       * @param {string[]} itemIds - Array of item IDs
       * @returns {Promise<Object>} Map of itemId -> pushStatus
       */
      getPushStatuses: async (itemIds) => {
        const statuses = {};
        for (const itemId of itemIds) {
          statuses[itemId] = await this.gsx.getPushStatus(itemId);
        }
        return statuses;
      },

      /**
       * Update push status (for external sources that pushed directly)
       * @param {string} itemId - Item ID
       * @param {Object} pushData - Push metadata to store
       */
      updatePushStatus: async (itemId, pushData) => {
        const metadata = this._getItemMetadataForSearch(itemId);
        const existingGsxPush = metadata.gsxPush || {};

        const newGsxPush = {
          ...existingGsxPush,
          ...pushData,
          updatedAt: new Date().toISOString()
        };

        this._updateItemMetadata(itemId, { gsxPush: newGsxPush });
        this._emit('gsx:status:updated', { itemId, status: newGsxPush.status });

        return { success: true };
      },

      /**
       * Check which items have local changes since last push
       * @param {string[]} itemIds - Item IDs to check
       * @returns {Promise<Object>} { changed: [], unchanged: [], notPushed: [] }
       */
      checkLocalChanges: async (itemIds) => {
        const result = { changed: [], unchanged: [], notPushed: [] };

        for (const itemId of itemIds) {
          const status = await this.gsx.getPushStatus(itemId);
          
          if (status.status === 'not_pushed') {
            result.notPushed.push(itemId);
          } else if (status.hasLocalChanges) {
            result.changed.push(itemId);
          } else {
            result.unchanged.push(itemId);
          }
        }

        return result;
      },

      /**
       * Get all links for a pushed asset
       * @param {string} itemId - Item ID
       * @returns {Promise<Object>} { fileUrl, graphNodeId, shareLink }
       */
      getLinks: async (itemId) => {
        const status = await this.gsx.getPushStatus(itemId);
        
        if (status.status === 'not_pushed' || status.status === 'not_found') {
          return { error: 'Item not pushed to GSX' };
        }

        return {
          fileUrl: status.fileUrl,
          graphNodeId: status.graphNodeId,
          shareLink: status.shareLink || status.fileUrl
        };
      },

      /**
       * Generate a formatted share link for an asset
       * @param {string} itemId - Item ID
       * @returns {Promise<Object>} Share link info
       */
      getShareLink: async (itemId) => {
        const status = await this.gsx.getPushStatus(itemId);
        
        if (!status.fileUrl) {
          return { error: 'Item not pushed to GSX' };
        }

        if (status.visibility === 'public') {
          return { url: status.fileUrl, requiresAuth: false };
        }

        return {
          url: status.fileUrl,
          requiresAuth: true,
          message: 'This file is private. Recipient needs GSX access.'
        };
      },

      /**
       * Copy link to clipboard (utility - returns link for UI to copy)
       * @param {string} itemId - Item ID
       * @param {string} linkType - 'file' | 'graph' | 'share'
       * @returns {Promise<Object>} { link, copied: false }
       */
      getLink: async (itemId, linkType = 'file') => {
        const links = await this.gsx.getLinks(itemId);
        
        if (links.error) {
          return { error: links.error };
        }

        let link;
        switch (linkType) {
          case 'graph':
            link = links.graphNodeId;
            break;
          case 'share':
            link = links.shareLink;
            break;
          case 'file':
          default:
            link = links.fileUrl;
        }

        return { link, type: linkType };
      }
    };
  }

  // ============================================
  // SHARING (Graph-based permission layer)
  // ============================================

  /**
   * Sharing namespace -- manages SHARED_WITH relationships in the graph
   * and syncs sharing state to local space metadata.
   * Part of the v3 Space API.
   */
  get sharing() {
    // Lazy load the same way as the gsx getter
    const { getOmniGraphClient } = require('./omnigraph-client');

    return {
      /**
       * Share a space with a user
       * @param {string} spaceId - Space ID
       * @param {string} email - Email of the person to share with
       * @param {string} permission - 'read', 'write', or 'admin'
       * @param {Object} [options] - { expiresIn (seconds), note }
       * @returns {Promise<Object>} Share result
       */
      shareSpace: async (spaceId, email, permission, options = {}) => {
        try {
          // Validate space exists
          const space = this.storage.index.spaces.find(s => s.id === spaceId);
          if (!space) {
            return { success: false, error: 'SPACE_NOT_FOUND', message: 'Space not found' };
          }

          // Validate inputs
          if (!['read', 'write', 'admin'].includes(permission)) {
            return { success: false, error: 'INVALID_PERMISSION', message: 'Permission must be read, write, or admin' };
          }
          if (!email || !email.includes('@')) {
            return { success: false, error: 'INVALID_EMAIL', message: 'Valid email address required' };
          }

          // Calculate TTL
          const expiresAt = options.expiresIn ? Date.now() + (options.expiresIn * 1000) : null;

          // Write to graph
          let graphResult = null;
          try {
            const client = getOmniGraphClient();
            if (client.isReady()) {
              // Ensure space node exists in graph
              const spaceMetadata = this.storage.getSpaceMetadata(spaceId);
              await client.upsertSpace({
                id: spaceId,
                name: space.name || spaceId,
                description: spaceMetadata?.attributes?.description || '',
                icon: space.icon || '',
                color: space.color || '#64c8ff',
                visibility: spaceMetadata?.attributes?.visibility || 'private'
              });

              graphResult = await client.shareWith('Space', spaceId, email, permission, {
                expiresAt,
                note: options.note || '',
                grantedBy: client.currentUser
              });
            }
          } catch (graphError) {
            log.error('spaces', 'Sharing graph error', { error: graphError.message, stack: graphError.stack });
            // Store error for diagnostics but continue -- local metadata still gets updated
            graphError._shareGraphError = graphError.message;
          }

          // Update local metadata
          const shareEntry = {
            email,
            name: email.split('@')[0],
            permission,
            grantedAt: new Date().toISOString(),
            expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
            grantedBy: graphResult?.grantedBy || 'system'
          };

          const spaceMetadata = this.storage.getSpaceMetadata(spaceId);
          const sharedWith = (spaceMetadata?.communication?.sharedWith || [])
            .filter(s => s.email !== email); // Remove existing entry for this email
          sharedWith.push(shareEntry);

          this.storage.updateSpaceMetadata(spaceId, {
            communication: { ...spaceMetadata?.communication, sharedWith }
          });

          this._emit('sharing:space:shared', { spaceId, email, permission });

          // Include graph diagnostics
          const client = getOmniGraphClient();
          return {
            success: true,
            share: shareEntry,
            graphSynced: graphResult !== null,
            _debug: {
              clientReady: client.isReady(),
              schemaError: client._permissionSchemaError || null,
              schemaEnsured: !!client._permissionSchemaEnsured
            }
          };
        } catch (error) {
          log.error('spaces', 'Share space error', { error: error.message || error });
          return { success: false, error: 'UNKNOWN', message: error.message };
        }
      },

      /**
       * Revoke a user's access to a space
       * @param {string} spaceId - Space ID
       * @param {string} email - Email of the person to unshare from
       * @returns {Promise<Object>} Unshare result
       */
      unshareSpace: async (spaceId, email) => {
        try {
          // Remove from graph
          let graphResult = null;
          try {
            const client = getOmniGraphClient();
            if (client.isReady()) {
              graphResult = await client.unshare('Space', spaceId, email);
            }
          } catch (graphError) {
            log.error('spaces', 'Unshare graph error', { error: graphError.message });
          }

          // Update local metadata
          const spaceMetadata = this.storage.getSpaceMetadata(spaceId);
          if (spaceMetadata) {
            const sharedWith = (spaceMetadata?.communication?.sharedWith || [])
              .filter(s => s.email !== email);
            this.storage.updateSpaceMetadata(spaceId, {
              communication: { ...spaceMetadata?.communication, sharedWith }
            });
          }

          this._emit('sharing:space:unshared', { spaceId, email });

          return { success: true, graphSynced: graphResult !== null };
        } catch (error) {
          log.error('spaces', 'Unshare space error', { error: error.message || error });
          return { success: false, error: 'UNKNOWN', message: error.message };
        }
      },

      /**
       * List who a space is shared with (active, non-expired)
       * @param {string} spaceId - Space ID
       * @returns {Promise<Object>} { shares: [...] }
       */
      getSpaceSharedWith: async (spaceId) => {
        try {
          // Try graph first for authoritative data
          let shares = null;
          try {
            const client = getOmniGraphClient();
            if (client.isReady()) {
              shares = await client.getSharedWith('Space', spaceId);
            }
          } catch (graphError) {
            log.warn('spaces', 'Could not read shares from graph', { error: graphError.message });
          }

          // Fallback to local metadata
          if (!shares) {
            const spaceMetadata = this.storage.getSpaceMetadata(spaceId);
            const now = Date.now();
            shares = (spaceMetadata?.communication?.sharedWith || [])
              .filter(s => !s.expiresAt || new Date(s.expiresAt).getTime() > now);
          }

          // Prune expired entries from local metadata
          const spaceMetadata = this.storage.getSpaceMetadata(spaceId);
          if (spaceMetadata?.communication?.sharedWith?.length) {
            const now = Date.now();
            const active = spaceMetadata.communication.sharedWith
              .filter(s => !s.expiresAt || new Date(s.expiresAt).getTime() > now);
            if (active.length !== spaceMetadata.communication.sharedWith.length) {
              this.storage.updateSpaceMetadata(spaceId, {
                communication: { ...spaceMetadata.communication, sharedWith: active }
              });
            }
          }

          return { shares: shares || [] };
        } catch (error) {
          log.error('spaces', 'Get space shared with error', { error: error.message || error });
          return { shares: [], error: error.message };
        }
      },

      /**
       * Share an item/asset with a user
       * @param {string} itemId - Item ID
       * @param {string} email - Email of the person to share with
       * @param {string} permission - 'read', 'write', or 'admin'
       * @param {Object} [options] - { expiresIn (seconds), note }
       * @returns {Promise<Object>} Share result
       */
      shareAsset: async (itemId, email, permission, options = {}) => {
        try {
          // Validate item exists
          const item = this.storage.loadItem(itemId);
          if (!item) {
            return { success: false, error: 'ITEM_NOT_FOUND', message: 'Item not found' };
          }

          if (!['read', 'write', 'admin'].includes(permission)) {
            return { success: false, error: 'INVALID_PERMISSION', message: 'Permission must be read, write, or admin' };
          }
          if (!email || !email.includes('@')) {
            return { success: false, error: 'INVALID_EMAIL', message: 'Valid email address required' };
          }

          const expiresAt = options.expiresIn ? Date.now() + (options.expiresIn * 1000) : null;

          // Write to graph
          let graphResult = null;
          try {
            const client = getOmniGraphClient();
            if (client.isReady()) {
              graphResult = await client.shareWith('Asset', itemId, email, permission, {
                expiresAt,
                note: options.note || '',
                grantedBy: client.currentUser
              });
            }
          } catch (graphError) {
            log.error('spaces', 'Share asset graph error', { error: graphError.message });
          }

          const shareEntry = {
            email,
            name: email.split('@')[0],
            permission,
            grantedAt: new Date().toISOString(),
            expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
            grantedBy: graphResult?.grantedBy || 'system'
          };

          // Update item metadata with share info
          const metadata = this._getItemMetadataForSearch(itemId);
          const shares = (metadata?.shares || []).filter(s => s.email !== email);
          shares.push(shareEntry);
          this._updateItemMetadata(itemId, { shares });

          this._emit('sharing:asset:shared', { itemId, email, permission });

          return {
            success: true,
            share: shareEntry,
            graphSynced: graphResult !== null
          };
        } catch (error) {
          log.error('spaces', 'Share asset error', { error: error.message || error });
          return { success: false, error: 'UNKNOWN', message: error.message };
        }
      },

      /**
       * Revoke a user's access to an item/asset
       * @param {string} itemId - Item ID
       * @param {string} email - Email of the person to unshare from
       * @returns {Promise<Object>} Unshare result
       */
      unshareAsset: async (itemId, email) => {
        try {
          let graphResult = null;
          try {
            const client = getOmniGraphClient();
            if (client.isReady()) {
              graphResult = await client.unshare('Asset', itemId, email);
            }
          } catch (graphError) {
            log.error('spaces', 'Unshare asset graph error', { error: graphError.message });
          }

          // Update item metadata
          const metadata = this._getItemMetadataForSearch(itemId);
          if (metadata) {
            const shares = (metadata?.shares || []).filter(s => s.email !== email);
            this._updateItemMetadata(itemId, { shares });
          }

          this._emit('sharing:asset:unshared', { itemId, email });

          return { success: true, graphSynced: graphResult !== null };
        } catch (error) {
          log.error('spaces', 'Unshare asset error', { error: error.message || error });
          return { success: false, error: 'UNKNOWN', message: error.message };
        }
      },

      /**
       * List who an item/asset is shared with (active, non-expired)
       * @param {string} itemId - Item ID
       * @returns {Promise<Object>} { shares: [...] }
       */
      getAssetSharedWith: async (itemId) => {
        try {
          let shares = null;
          try {
            const client = getOmniGraphClient();
            if (client.isReady()) {
              shares = await client.getSharedWith('Asset', itemId);
            }
          } catch (graphError) {
            log.warn('spaces', 'Could not read asset shares from graph', { error: graphError.message });
          }

          if (!shares) {
            const metadata = this._getItemMetadataForSearch(itemId);
            const now = Date.now();
            shares = (metadata?.shares || [])
              .filter(s => !s.expiresAt || new Date(s.expiresAt).getTime() > now);
          }

          return { shares: shares || [] };
        } catch (error) {
          log.error('spaces', 'Get asset shared with error', { error: error.message || error });
          return { shares: [], error: error.message };
        }
      },

      /**
       * Get all spaces and assets shared with the current user
       * @returns {Promise<Object>} { shares: [...] }
       */
      getSharedWithMe: async () => {
        try {
          const client = getOmniGraphClient();
          if (!client.isReady()) {
            return { shares: [], error: 'Graph not connected' };
          }

          const email = client.currentUser;
          if (!email || !email.includes('@')) {
            return { shares: [], error: 'No valid user email configured' };
          }

          const shares = await client.getSharedWithMe(email);
          return { shares: shares || [] };
        } catch (error) {
          log.error('spaces', 'Get shared with me error', { error: error.message || error });
          return { shares: [], error: error.message };
        }
      }
    };
  }

  // ============================================
  // UTILITY METHODS
  // ============================================

  /**
   * Get storage root path
   * @returns {string} Path to OR-Spaces directory
   */
  getStorageRoot() {
    return this.storage.storageRoot;
  }

  /**
   * Flush any pending saves (call before app quit)
   */
  flush() {
    this.storage.flushPendingSaves();
  }

  /**
   * Force reload the index from disk
   * Use this when running external scripts or when you need to sync
   * with changes made by another process (e.g., the main app).
   * 
   * @returns {void}
   * @example
   * // Reload before reading to ensure fresh data
   * api.reload();
   * const items = await api.items.list('unclassified');
   */
  reload() {
    this.storage.reloadIndex();
    log.info('spaces', 'Index reloaded from disk');
  }
  
  // ============================================
  // DUCKDB-POWERED ASYNC METHODS
  // ============================================
  
  /**
   * Check if DuckDB is ready for queries
   * @returns {boolean} Whether DuckDB is initialized
   */
  isDatabaseReady() {
    return this.storage.dbReady || false;
  }
  
  /**
   * Wait for DuckDB to be ready
   * @returns {Promise<boolean>} True if ready, false if unavailable
   */
  async waitForDatabase() {
    if (this.storage.ensureDBReady) {
      return await this.storage.ensureDBReady();
    }
    return false;
  }
  
  /**
   * Rebuild the database index from metadata.json files
   * Use this for recovery when the database is corrupted
   * @returns {Promise<number>} Number of items rebuilt
   */
  async rebuildIndex() {
    if (this.storage.rebuildIndexFromFiles) {
      return await this.storage.rebuildIndexFromFiles();
    }
    throw new Error('rebuildIndexFromFiles not available');
  }
  
  /**
   * Search using DuckDB (faster than JSON-based search for large datasets)
   * Falls back to regular search if DuckDB is not ready
   * @param {string} query - Search query
   * @param {Object} options - Search options
   * @returns {Promise<Array<Object>>} Matching items
   */
  async searchAsync(query, options = {}) {
    if (this.storage.searchAsync && this.storage.dbReady) {
      return await this.storage.searchAsync(query, options);
    }
    // Fallback to sync search
    return this.search(query, options);
  }
  
  /**
   * Get all items with optional filtering using DuckDB
   * @param {Object} options - Filter options
   * @param {string} options.type - Filter by type
   * @param {string} options.spaceId - Filter by space
   * @param {string} options.tag - Filter by tag
   * @param {boolean} options.pinned - Filter by pinned status
   * @param {number} options.limit - Max results
   * @param {number} options.offset - Skip results
   * @returns {Promise<Array<Object>>} Matching items
   */
  async getAllItemsAsync(options = {}) {
    if (this.storage.getAllItemsAsync && this.storage.dbReady) {
      return await this.storage.getAllItemsAsync(options);
    }
    // Fallback to sync method
    let items = this.storage.getAllItems();
    if (options.type) items = items.filter(i => i.type === options.type);
    if (options.spaceId) items = items.filter(i => i.spaceId === options.spaceId);
    if (options.pinned !== undefined) items = items.filter(i => i.pinned === options.pinned);
    if (options.limit) items = items.slice(options.offset || 0, (options.offset || 0) + options.limit);
    return items;
  }
  
  /**
   * Search items by tags using DuckDB
   * @param {Array<string>} tags - Tags to search for
   * @param {boolean} matchAll - Require all tags (default: any)
   * @returns {Promise<Array<Object>>} Matching items
   */
  async searchByTags(tags, matchAll = false) {
    if (this.storage.searchByTags && this.storage.dbReady) {
      return await this.storage.searchByTags(tags, matchAll);
    }
    // Fallback to sync search
    return this.tags.findItems(tags, { matchAll });
  }
  
  /**
   * Get database status information
   * @returns {Object} Database status
   */
  getDatabaseStatus() {
    return {
      ready: this.storage.dbReady || false,
      path: this.storage.dbPath || null,
      hasConnection: !!this.storage.dbConnection
    };
  }
}

// Singleton instance
let spacesAPIInstance = null;

/**
 * Get the SpacesAPI singleton instance
 * @returns {SpacesAPI}
 */
function getSpacesAPI() {
  if (!spacesAPIInstance) {
    spacesAPIInstance = new SpacesAPI();
  }
  return spacesAPIInstance;
}

module.exports = {
  SpacesAPI,
  getSpacesAPI
};

