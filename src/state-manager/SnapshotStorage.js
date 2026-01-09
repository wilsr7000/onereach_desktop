/**
 * SnapshotStorage - Persistent snapshot storage system
 * 
 * Handles file-based storage of named snapshots via IPC.
 * Stores snapshots in userData/editor-snapshots/{editorId}/
 * 
 * Each snapshot file: {id}.json containing full state
 * Index file: index.json containing metadata for quick listing
 */

const fs = require('fs');
const path = require('path');

class SnapshotStorage {
  /**
   * Create a new SnapshotStorage instance
   * @param {string} basePath - Base path for snapshot storage (usually app.getPath('userData'))
   */
  constructor(basePath) {
    this.basePath = basePath;
    this.snapshotsDir = path.join(basePath, 'editor-snapshots');
    this.maxSnapshotsPerEditor = 100;
    
    this._ensureDirectory(this.snapshotsDir);
  }

  /**
   * Get the storage path for an editor
   * @param {string} editorId 
   * @returns {string}
   */
  _getEditorPath(editorId) {
    const editorPath = path.join(this.snapshotsDir, editorId);
    this._ensureDirectory(editorPath);
    return editorPath;
  }

  /**
   * Get the index file path for an editor
   * @param {string} editorId 
   * @returns {string}
   */
  _getIndexPath(editorId) {
    return path.join(this._getEditorPath(editorId), 'index.json');
  }

  /**
   * Get the snapshot file path
   * @param {string} editorId 
   * @param {string} snapshotId 
   * @returns {string}
   */
  _getSnapshotPath(editorId, snapshotId) {
    return path.join(this._getEditorPath(editorId), `${snapshotId}.json`);
  }

  /**
   * Ensure a directory exists
   * @param {string} dirPath 
   */
  _ensureDirectory(dirPath) {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
  }

  /**
   * Load the index for an editor
   * @param {string} editorId 
   * @returns {array}
   */
  _loadIndex(editorId) {
    const indexPath = this._getIndexPath(editorId);
    
    if (fs.existsSync(indexPath)) {
      try {
        return JSON.parse(fs.readFileSync(indexPath, 'utf8'));
      } catch (error) {
        console.error('[SnapshotStorage] Error loading index:', error);
      }
    }
    
    return [];
  }

  /**
   * Save the index for an editor
   * @param {string} editorId 
   * @param {array} index 
   */
  _saveIndex(editorId, index) {
    const indexPath = this._getIndexPath(editorId);
    fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));
  }

  // ═══════════════════════════════════════════════════════════
  // PUBLIC API
  // ═══════════════════════════════════════════════════════════

  /**
   * Save a snapshot
   * @param {string} editorId - Editor identifier
   * @param {object} snapshot - Snapshot object { id, name, state, timestamp, ... }
   * @returns {object} Snapshot metadata (without state)
   */
  saveSnapshot(editorId, snapshot) {
    const snapshotPath = this._getSnapshotPath(editorId, snapshot.id);
    
    // Save full snapshot to file
    fs.writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2));

    // Update index with metadata only
    const index = this._loadIndex(editorId);
    const metadata = {
      id: snapshot.id,
      name: snapshot.name,
      timestamp: snapshot.timestamp,
      createdAt: snapshot.createdAt,
      size: JSON.stringify(snapshot.state).length
    };

    // Add to beginning of index
    index.unshift(metadata);

    // Trim old snapshots if over limit
    while (index.length > this.maxSnapshotsPerEditor) {
      const removed = index.pop();
      const removedPath = this._getSnapshotPath(editorId, removed.id);
      if (fs.existsSync(removedPath)) {
        fs.unlinkSync(removedPath);
      }
    }

    this._saveIndex(editorId, index);

    console.log(`[SnapshotStorage] Saved snapshot: ${snapshot.name} (${editorId})`);
    return metadata;
  }

  /**
   * List snapshots for an editor (metadata only)
   * @param {string} editorId 
   * @returns {array}
   */
  listSnapshots(editorId) {
    return this._loadIndex(editorId);
  }

  /**
   * Get a specific snapshot with full state
   * @param {string} editorId 
   * @param {string} snapshotId 
   * @returns {object|null}
   */
  getSnapshot(editorId, snapshotId) {
    const snapshotPath = this._getSnapshotPath(editorId, snapshotId);
    
    if (!fs.existsSync(snapshotPath)) {
      console.error(`[SnapshotStorage] Snapshot not found: ${snapshotId}`);
      return null;
    }

    try {
      return JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
    } catch (error) {
      console.error('[SnapshotStorage] Error loading snapshot:', error);
      return null;
    }
  }

  /**
   * Delete a snapshot
   * @param {string} editorId 
   * @param {string} snapshotId 
   * @returns {boolean}
   */
  deleteSnapshot(editorId, snapshotId) {
    const snapshotPath = this._getSnapshotPath(editorId, snapshotId);
    
    // Remove file
    if (fs.existsSync(snapshotPath)) {
      fs.unlinkSync(snapshotPath);
    }

    // Update index
    const index = this._loadIndex(editorId);
    const newIndex = index.filter(s => s.id !== snapshotId);
    
    if (newIndex.length === index.length) {
      return false; // Not found
    }

    this._saveIndex(editorId, newIndex);
    console.log(`[SnapshotStorage] Deleted snapshot: ${snapshotId}`);
    return true;
  }

  /**
   * Rename a snapshot
   * @param {string} editorId 
   * @param {string} snapshotId 
   * @param {string} newName 
   * @returns {boolean}
   */
  renameSnapshot(editorId, snapshotId, newName) {
    // Update index
    const index = this._loadIndex(editorId);
    const entry = index.find(s => s.id === snapshotId);
    
    if (!entry) {
      return false;
    }

    entry.name = newName;
    this._saveIndex(editorId, index);

    // Update snapshot file
    const snapshotPath = this._getSnapshotPath(editorId, snapshotId);
    if (fs.existsSync(snapshotPath)) {
      const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
      snapshot.name = newName;
      fs.writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2));
    }

    console.log(`[SnapshotStorage] Renamed snapshot to: ${newName}`);
    return true;
  }

  /**
   * Get all editors that have snapshots
   * @returns {array}
   */
  listEditors() {
    if (!fs.existsSync(this.snapshotsDir)) {
      return [];
    }

    return fs.readdirSync(this.snapshotsDir)
      .filter(name => {
        const fullPath = path.join(this.snapshotsDir, name);
        return fs.statSync(fullPath).isDirectory();
      });
  }

  /**
   * Clear all snapshots for an editor
   * @param {string} editorId 
   */
  clearSnapshots(editorId) {
    const editorPath = this._getEditorPath(editorId);
    
    if (fs.existsSync(editorPath)) {
      fs.rmSync(editorPath, { recursive: true, force: true });
      this._ensureDirectory(editorPath);
    }

    console.log(`[SnapshotStorage] Cleared all snapshots for: ${editorId}`);
  }

  /**
   * Get storage statistics
   * @param {string} editorId 
   * @returns {object}
   */
  getStats(editorId) {
    const index = this._loadIndex(editorId);
    const editorPath = this._getEditorPath(editorId);
    
    let totalSize = 0;
    
    if (fs.existsSync(editorPath)) {
      const files = fs.readdirSync(editorPath);
      for (const file of files) {
        const filePath = path.join(editorPath, file);
        totalSize += fs.statSync(filePath).size;
      }
    }

    return {
      editorId,
      snapshotCount: index.length,
      totalSizeBytes: totalSize,
      totalSizeFormatted: this._formatBytes(totalSize),
      oldestSnapshot: index.length > 0 ? index[index.length - 1].createdAt : null,
      newestSnapshot: index.length > 0 ? index[0].createdAt : null
    };
  }

  /**
   * Format bytes to human readable
   * @param {number} bytes 
   * @returns {string}
   */
  _formatBytes(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }
}

module.exports = { SnapshotStorage };










