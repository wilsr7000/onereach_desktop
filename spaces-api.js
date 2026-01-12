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
class SpacesAPI {
  constructor() {
    this.storage = getStorage();
    this._eventListeners = new Map();
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
      console.error('[SpacesAPI] Error listing spaces:', error);
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
      console.error('[SpacesAPI] Error getting space:', error);
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

      console.log('[SpacesAPI] Created space:', space.id, space.name);
      
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
      console.error('[SpacesAPI] Error creating space:', error);
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
        console.log('[SpacesAPI] Updated space:', spaceId);
        this._emit('space:updated', { spaceId, data });
      }
      
      return success;
    } catch (error) {
      console.error('[SpacesAPI] Error updating space:', error);
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

      const success = this.storage.deleteSpace(spaceId);
      
      if (success) {
        console.log('[SpacesAPI] Deleted space:', spaceId);
        this._emit('space:deleted', { spaceId });
      }
      
      return success;
    } catch (error) {
      console.error('[SpacesAPI] Error deleting space:', error);
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
          console.error('[SpacesAPI] Error listing items:', error);
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
            console.warn('[SpacesAPI] Item found but in different space');
          }
          if (item) {
            // Ensure tags are at root level (from metadata or separate lookup)
            const tagsFromMetadata = item.metadata?.tags;
            const tagsFromFile = this._getItemTags(itemId);
            const finalTags = tagsFromMetadata || tagsFromFile;
            
            // #region agent log
            fetch('http://127.0.0.1:7242/ingest/54746cc5-c924-4bb5-9e76-3f6b729e6870',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'spaces-api.js:items.get',message:'Getting item with tags',data:{itemId,tagsFromMetadata,tagsFromFile,finalTags,hasMetadata:!!item.metadata},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'D'})}).catch(()=>{});
            // #endregion
            
            return {
              ...item,
              tags: finalTags
            };
          }
          return item;
        } catch (error) {
          console.error('[SpacesAPI] Error getting item:', error);
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
              console.log('[SpacesAPI] Added item via clipboardManager:', spaceId, newItem.id);
              this._emit('item:added', { spaceId, item: newItem });
              
              // Auto-generate metadata if incomplete and enabled
              if (!item.skipAutoMetadata && this._shouldAutoGenerateMetadata(item)) {
                this._queueMetadataGeneration(newItem.id, spaceId, type);
              }
              
              return newItem;
            }
          }
          
          // Fallback to direct storage (less ideal but still works)
          console.warn('[SpacesAPI] clipboardManager not available, using direct storage (may cause sync issues)');
          const newItem = this.storage.addItem({
            ...item,
            type,
            spaceId: spaceId || 'unclassified',
            timestamp: Date.now()
          });
          
          console.log('[SpacesAPI] Added item to space:', spaceId, newItem.id);
          this._emit('item:added', { spaceId, item: newItem });
          
          // Auto-generate metadata if incomplete and enabled
          if (!item.skipAutoMetadata && this._shouldAutoGenerateMetadata(item)) {
            this._queueMetadataGeneration(newItem.id, spaceId, type);
          }
          
          return newItem;
        } catch (error) {
          console.error('[SpacesAPI] Error adding item:', error);
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
            console.log('[SpacesAPI] Updated item:', itemId);
            this._emit('item:updated', { spaceId, itemId, data });
          }
          
          return success;
        } catch (error) {
          console.error('[SpacesAPI] Error updating item:', error);
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
            console.log('[SpacesAPI] Deleted item:', itemId);
            this._emit('item:deleted', { spaceId, itemId });
          }
          
          return success;
        } catch (error) {
          console.error('[SpacesAPI] Error deleting item:', error);
          throw error;
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
            console.log('[SpacesAPI] Moved item:', itemId, 'from', fromSpaceId, 'to', toSpaceId);
            this._emit('item:moved', { itemId, fromSpaceId, toSpaceId });
          }
          
          return success;
        } catch (error) {
          console.error('[SpacesAPI] Error moving item:', error);
          throw error;
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
          console.error('[SpacesAPI] Error toggling pin:', error);
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
          console.error('[SpacesAPI] Error getting tags:', error);
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
          console.error('[SpacesAPI] Error setting tags:', error);
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
          console.error('[SpacesAPI] Error adding tag:', error);
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
          console.error('[SpacesAPI] Error removing tag:', error);
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
          console.error('[SpacesAPI] Error generating metadata:', error);
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
          console.error('[SpacesAPI] Error listing tags:', error);
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
          console.error('[SpacesAPI] Error listing all tags:', error);
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
          console.error('[SpacesAPI] Error finding items by tags:', error);
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
          console.error('[SpacesAPI] Error renaming tag:', error);
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
          console.error('[SpacesAPI] Error deleting tag:', error);
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
          console.error('[SpacesAPI] Error listing smart folders:', error);
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
          return data.folders.find(f => f.id === folderId) || null;
        } catch (error) {
          console.error('[SpacesAPI] Error getting smart folder:', error);
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
          
          console.log('[SpacesAPI] Created smart folder:', folder.id, folder.name);
          this._emit('smartFolder:created', { folder });
          
          return folder;
        } catch (error) {
          console.error('[SpacesAPI] Error creating smart folder:', error);
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
          const index = data.folders.findIndex(f => f.id === folderId);
          
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
          
          console.log('[SpacesAPI] Updated smart folder:', folderId);
          this._emit('smartFolder:updated', { folderId, updates });
          
          return folder;
        } catch (error) {
          console.error('[SpacesAPI] Error updating smart folder:', error);
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
          const index = data.folders.findIndex(f => f.id === folderId);
          
          if (index === -1) {
            return false;
          }
          
          data.folders.splice(index, 1);
          this._saveSmartFolders(data);
          
          console.log('[SpacesAPI] Deleted smart folder:', folderId);
          this._emit('smartFolder:deleted', { folderId });
          
          return true;
        } catch (error) {
          console.error('[SpacesAPI] Error deleting smart folder:', error);
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
          console.error('[SpacesAPI] Error getting smart folder items:', error);
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
          console.error('[SpacesAPI] Error previewing smart folder:', error);
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
        console.error('[SpacesAPI] Error loading smart folders:', error);
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
  // SEARCH & QUERY
  // ============================================

  /**
   * Search across all spaces
   * @param {string} query - Search query
   * @param {Object} options - Search options
   * @param {string} options.spaceId - Limit to specific space
   * @param {string} options.type - Filter by item type
   * @param {boolean} options.searchTags - Also search in tags (default: true)
   * @param {number} options.limit - Max results
   * @returns {Promise<Array<Object>>} Matching items with tags
   */
  async search(query, options = {}) {
    try {
      const queryLower = query.toLowerCase();
      const searchTags = options.searchTags !== false; // Default to true
      let items = this.storage.getAllItems();
      
      // Filter by space if specified
      if (options.spaceId) {
        items = items.filter(item => item.spaceId === options.spaceId);
      }
      
      // Filter by type if specified
      if (options.type) {
        items = items.filter(item => item.type === options.type);
      }
      
      // Search in preview, filename, and optionally tags
      items = items.filter(item => {
        if (item.preview && item.preview.toLowerCase().includes(queryLower)) {
          return true;
        }
        if (item.fileName && item.fileName.toLowerCase().includes(queryLower)) {
          return true;
        }
        // Search in tags
        if (searchTags) {
          const tags = this._getItemTags(item.id);
          if (tags.some(tag => tag.toLowerCase().includes(queryLower))) {
            return true;
          }
        }
        return false;
      });
      
      // Add tags to results
      items = items.map(item => ({
        ...item,
        tags: this._getItemTags(item.id)
      }));
      
      // Apply limit
      if (options.limit) {
        items = items.slice(0, options.limit);
      }
      
      return items;
    } catch (error) {
      console.error('[SpacesAPI] Error searching:', error);
      throw error;
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
          console.error('[SpacesAPI] Error getting space metadata:', error);
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
          console.error('[SpacesAPI] Error updating space metadata:', error);
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
          console.error('[SpacesAPI] Error getting file metadata:', error);
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
          console.error('[SpacesAPI] Error setting file metadata:', error);
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
          console.error('[SpacesAPI] Error setting asset metadata:', error);
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
          console.error('[SpacesAPI] Error setting approval:', error);
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
          return this.storage.addVersion(spaceId, versionData);
        } catch (error) {
          console.error('[SpacesAPI] Error adding version:', error);
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
          console.error('[SpacesAPI] Error updating project config:', error);
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
          const spacePath = path.join(this.storage.spacesDir, spaceId, subPath);
          
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
          console.error('[SpacesAPI] Error listing files:', error);
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
          const fullPath = path.join(this.storage.spacesDir, spaceId, filePath);
          
          if (!fs.existsSync(fullPath)) {
            return null;
          }
          
          return fs.readFileSync(fullPath, 'utf8');
        } catch (error) {
          console.error('[SpacesAPI] Error reading file:', error);
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
          const fullPath = path.join(this.storage.spacesDir, spaceId, filePath);
          const dir = path.dirname(fullPath);
          
          // Ensure directory exists
          fs.mkdirSync(dir, { recursive: true });
          
          fs.writeFileSync(fullPath, content);
          
          this._emit('file:written', { spaceId, filePath });
          return true;
        } catch (error) {
          console.error('[SpacesAPI] Error writing file:', error);
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
          const fullPath = path.join(this.storage.spacesDir, spaceId, filePath);
          
          if (fs.existsSync(fullPath)) {
            fs.unlinkSync(fullPath);
            this._emit('file:deleted', { spaceId, filePath });
            return true;
          }
          
          return false;
        } catch (error) {
          console.error('[SpacesAPI] Error deleting file:', error);
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
          console.error('[SpacesAPI] Error in event listener:', error);
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
      
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/54746cc5-c924-4bb5-9e76-3f6b729e6870',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'spaces-api.js:_getItemTags',message:'Reading tags from metadata file',data:{itemId,metaPath,fileExists},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'E'})}).catch(()=>{});
      // #endregion
      
      if (fileExists) {
        const metadata = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        
        // #region agent log
        fetch('http://127.0.0.1:7242/ingest/54746cc5-c924-4bb5-9e76-3f6b729e6870',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'spaces-api.js:_getItemTags:read',message:'Read metadata file',data:{itemId,tags:metadata.tags,hasTags:!!metadata.tags},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'E'})}).catch(()=>{});
        // #endregion
        
        return metadata.tags || [];
      }
    } catch (error) {
      // Silently fail - item may not have metadata
    }
    return [];
  }

  /**
   * Update item metadata file
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
      
      // Merge updates
      Object.assign(metadata, updates);
      metadata.updatedAt = new Date().toISOString();
      
      fs.writeFileSync(metaPath, JSON.stringify(metadata, null, 2));
      return true;
    } catch (error) {
      console.error('[SpacesAPI] Error updating item metadata:', error);
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
        console.log('[SpacesAPI] Settings manager not available, skipping auto-metadata');
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
      console.error('[SpacesAPI] Error checking auto-metadata settings:', error);
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
        console.log('[SpacesAPI] Starting background metadata generation for:', itemId);
        
        const apiKey = global.settingsManager?.get('openaiApiKey');
        if (!apiKey) {
          console.log('[SpacesAPI] No API key, skipping metadata generation');
          return;
        }

        // Get the metadata generator
        const MetadataGenerator = require('./metadata-generator');
        
        // Create a minimal clipboard manager interface for the generator
        const clipboardInterface = {
          storage: this.storage,
          spaces: this.storage.index.spaces || []
        };
        
        const generator = new MetadataGenerator(clipboardInterface);
        const result = await generator.generateMetadataForItem(itemId, apiKey);
        
        if (result.success) {
          console.log('[SpacesAPI] Auto-generated metadata for:', itemId);
          
          // Emit event for listeners
          this._emit('item:metadata:generated', {
            spaceId,
            itemId,
            metadata: result.metadata || result
          });
        } else {
          console.error('[SpacesAPI] Failed to generate metadata:', result.error);
        }
      } catch (error) {
        console.error('[SpacesAPI] Error in background metadata generation:', error);
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
      
      // Create a minimal clipboard manager interface for the generator
      const clipboardInterface = {
        storage: this.storage,
        spaces: this.storage.index.spaces || []
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
      console.error('[SpacesAPI] Error generating metadata:', error);
      return { success: false, error: error.message };
    }
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
    console.log('[SpacesAPI] Index reloaded from disk');
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

