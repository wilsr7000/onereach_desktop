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

// DuckDB for cross-space queries
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
    this.itemsDir = path.join(this.storageRoot, 'items');
    this.spacesDir = path.join(this.storageRoot, 'spaces');
    
    // Ensure directories exist
    this.ensureDirectories();
    
    // Load or create index
    this.index = this.loadIndex();
    
    // Ensure all spaces have metadata files (including unclassified)
    this.ensureAllSpacesHaveMetadata();
    
    // In-memory cache for performance
    this.cache = new Map();
    this.cacheSize = 100; // Keep last 100 items in cache
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
  
  loadIndex() {
    if (fs.existsSync(this.indexPath)) {
      try {
        const data = fs.readFileSync(this.indexPath, 'utf8');
        return JSON.parse(data);
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
  
  saveIndex(index = this.index) {
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
      
      console.log('Index saved successfully');
    } catch (error) {
      console.error('Error saving index:', error);
      // Clean up temp file if it exists
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }
      throw error;
    }
  }
  
  // Add new item
  addItem(item) {
    const itemId = item.id || this.generateId();
    const itemDir = path.join(this.itemsDir, itemId);
    
    // Create item directory
    fs.mkdirSync(itemDir, { recursive: true });
    
    // Determine content path
    let contentPath;
    if (item.type === 'file' && item.fileName) {
      // For files, use the actual filename
      contentPath = `items/${itemId}/${item.fileName}`;
    } else {
      // For other types, use generic extension
      const ext = this.getExtension(item.type);
      contentPath = `items/${itemId}/content.${ext}`;
    }
    
    const thumbnailPath = item.thumbnail ? `items/${itemId}/thumbnail.png` : null;
    const metadataPath = `items/${itemId}/metadata.json`;
    
    // Save content
    this.saveContent(item, itemDir);
    
    // Save thumbnail if exists
    if (item.thumbnail) {
      this.saveThumbnail(item.thumbnail, itemDir);
    }
    
    // Save metadata
    const metadata = {
      id: itemId,
      type: item.type,
      dateCreated: new Date().toISOString(),
                author: require('os').userInfo().username || 'Unknown',
      source: item.source || 'clipboard',
      tags: item.tags || [],
      ...item.metadata
    };
    
    fs.writeFileSync(
      path.join(itemDir, 'metadata.json'),
      JSON.stringify(metadata, null, 2)
    );
    
    // Create index entry (no content, just pointers)
    const indexEntry = {
      id: itemId,
      type: item.type,
      spaceId: item.spaceId || 'unclassified',
      timestamp: item.timestamp || Date.now(),
      pinned: item.pinned || false,
      preview: this.generatePreview(item),
      contentPath: contentPath,
      thumbnailPath: thumbnailPath,
      metadataPath: metadataPath
    };
    
    // Add file-specific properties to index
    if (item.type === 'file') {
      indexEntry.fileName = item.fileName;
      indexEntry.fileSize = item.fileSize;
      indexEntry.fileType = item.fileType;
      indexEntry.fileCategory = item.fileCategory;
      indexEntry.fileExt = item.fileExt;
      indexEntry.isScreenshot = item.isScreenshot || false;
    }
    
    // Add to index
    this.index.items.unshift(indexEntry);
    
    // Update space item count
    this.updateSpaceCount(indexEntry.spaceId);
    
    // Save index
    this.saveIndex();
    
    // Add to cache with appropriate content
    let cacheContent = item.content;
    if (item.type === 'file' && item.fileName) {
      // For files, cache the full path to the stored file
      cacheContent = path.join(itemDir, item.fileName);
    }
    this.cache.set(itemId, { ...indexEntry, content: cacheContent });
    this.trimCache();
    
    return indexEntry;
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
        if (files.length > 0) {
          actualContentPath = path.join(itemDir, files[0]);
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
          content = `data:image/png;base64,${imageData.toString('base64')}`;
        }
      }
    }
    
    // Load thumbnail if exists
    let thumbnail = null;
    if (indexEntry.thumbnailPath) {
      const thumbPath = path.join(this.storageRoot, indexEntry.thumbnailPath);
      if (fs.existsSync(thumbPath)) {
        const thumbData = fs.readFileSync(thumbPath);
        thumbnail = `data:image/png;base64,${thumbData.toString('base64')}`;
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
  
  // Get items for a specific space
  getSpaceItems(spaceId) {
    return this.index.items.filter(item => item.spaceId === spaceId);
  }
  
  // Delete item
  deleteItem(itemId) {
    // Remove from index
    const itemIndex = this.index.items.findIndex(item => item.id === itemId);
    if (itemIndex === -1) {
      return false;
    }
    
    const item = this.index.items[itemIndex];
    this.index.items.splice(itemIndex, 1);
    
    // Update space count
    this.updateSpaceCount(item.spaceId, -1);
    
    // Remove from file system
    const itemDir = path.join(this.itemsDir, itemId);
    if (fs.existsSync(itemDir)) {
      fs.rmSync(itemDir, { recursive: true, force: true });
    }
    
    // Remove from cache
    this.cache.delete(itemId);
    
    // Save index
    this.saveIndex();
    
    return true;
  }
  
  // Move item to different space
  moveItem(itemId, newSpaceId) {
    const item = this.index.items.find(item => item.id === itemId);
    if (!item) {
      return false;
    }
    
    const oldSpaceId = item.spaceId;
    item.spaceId = newSpaceId;
    
    // Update space counts
    this.updateSpaceCount(oldSpaceId, -1);
    this.updateSpaceCount(newSpaceId, 1);
    
    // Update metadata file
    const metaPath = path.join(this.storageRoot, item.metadataPath);
    if (fs.existsSync(metaPath)) {
      const metadata = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      metadata.spaceId = newSpaceId;
      fs.writeFileSync(metaPath, JSON.stringify(metadata, null, 2));
    }
    
    // Save index
    this.saveIndex();
    
    return true;
  }
  
  // Toggle pin
  togglePin(itemId) {
    const item = this.index.items.find(item => item.id === itemId);
    if (!item) {
      return false;
    }
    
    item.pinned = !item.pinned;
    this.saveIndex();
    
    return item.pinned;
  }
  
  // Space management
  createSpace(space) {
    const spaceId = space.id || this.generateId();
    
    const newSpace = {
      id: spaceId,
      name: space.name,
      icon: space.icon || '◯',
      color: space.color || '#64c8ff',
      itemCount: 0
    };
    
    this.index.spaces.push(newSpace);
    
    // Create space directory
    const spaceDir = path.join(this.spacesDir, spaceId);
    fs.mkdirSync(spaceDir, { recursive: true });
    
    // Create unified space-metadata.json
    this.initSpaceMetadata(spaceId, newSpace);
    
    // Create README.ipynb if notebook data provided
    if (space.notebook) {
      this.createSpaceNotebook(spaceId, space);
    }
    
    this.saveIndex();
    
    return newSpace;
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
    
    this.saveIndex();
    
    return true;
  }
  
  deleteSpace(spaceId) {
    if (spaceId === 'unclassified') {
      throw new Error('Cannot delete unclassified space');
    }
    
    // Move all items to unclassified
    this.index.items.forEach(item => {
      if (item.spaceId === spaceId) {
        item.spaceId = 'unclassified';
      }
    });
    
    // Remove space
    this.index.spaces = this.index.spaces.filter(s => s.id !== spaceId);
    
    // Update unclassified count
    this.updateSpaceCount('unclassified');
    
    // Remove space directory
    const spaceDir = path.join(this.spacesDir, spaceId);
    if (fs.existsSync(spaceDir)) {
      fs.rmSync(spaceDir, { recursive: true, force: true });
    }
    
    this.saveIndex();
    
    return true;
  }
  
  // Helper methods
  generateId() {
    return crypto.randomBytes(16).toString('hex');
  }
  
  getExtension(type) {
    switch (type) {
      case 'text': return 'txt';
      case 'html': return 'html';
      case 'image': return 'png';
      case 'file': return 'file';
      default: return 'dat';
    }
  }
  
  saveContent(item, itemDir) {
    if (item.type === 'text' || item.type === 'html') {
      const ext = this.getExtension(item.type);
      const contentPath = path.join(itemDir, `content.${ext}`);
      fs.writeFileSync(contentPath, item.content, 'utf8');
    } else if (item.type === 'image') {
      const contentPath = path.join(itemDir, 'content.png');
                  const base64Data = item.content.replace(/^data:image\/[^;]+;base64,/, '');
      fs.writeFileSync(contentPath, Buffer.from(base64Data, 'base64'));
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
  
  // Search functionality
  search(query) {
    const lowerQuery = query.toLowerCase();
    
    return this.index.items.filter(item => {
      // Search in preview
      if (item.preview.toLowerCase().includes(lowerQuery)) {
        return true;
      }
      
      // Load and search in metadata
      try {
        const metaPath = path.join(this.storageRoot, item.metadataPath);
        if (fs.existsSync(metaPath)) {
          const metadata = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
          
          // Search in tags
          if (metadata.tags?.some(tag => tag.toLowerCase().includes(lowerQuery))) {
            return true;
          }
          
          // Search in description
          if (metadata.description?.toLowerCase().includes(lowerQuery)) {
            return true;
          }
        }
      } catch (error) {
        // Ignore errors
      }
      
      return false;
    });
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
    this.saveIndex();
  }
}

module.exports = ClipboardStorageV2; 