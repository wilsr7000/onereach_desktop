/**
 * File Snapshots
 * Part of the Governed Self-Improving Agent Runtime
 * 
 * Captures before/after file states for undo and history tracking
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getLogQueue } = require('./log-event-queue');
const log = getLogQueue();

/**
 * File Snapshot Manager
 * Manages before/after snapshots of files for undo support
 */
class FileSnapshotManager {
  constructor(options = {}) {
    this.snapshotDir = options.snapshotDir || path.join(process.cwd(), '.snapshots');
    this.maxSnapshots = options.maxSnapshots || 100;
    this.snapshots = new Map(); // taskId -> snapshot data
    this.fileHashes = new Map(); // path -> current hash
  }

  /**
   * Initialize the snapshot directory
   */
  async init() {
    try {
      if (!fs.existsSync(this.snapshotDir)) {
        fs.mkdirSync(this.snapshotDir, { recursive: true });
      }
    } catch (error) {
      log.error('app', 'Failed to initialize snapshot directory:', { error: error });
    }
  }

  /**
   * Calculate hash of file content
   * @param {string} content - File content
   * @returns {string} SHA-256 hash
   */
  calculateHash(content) {
    return crypto.createHash('sha256').update(content || '').digest('hex');
  }

  /**
   * Capture the "before" state of files
   * @param {string} taskId - Task identifier
   * @param {string[]} filePaths - Paths to files to snapshot
   * @returns {Object} Snapshot data
   */
  async captureBeforeState(taskId, filePaths) {
    const beforeState = {
      taskId,
      timestamp: new Date().toISOString(),
      files: {}
    };

    for (const filePath of filePaths) {
      try {
        const absolutePath = path.resolve(filePath);
        const exists = fs.existsSync(absolutePath);
        
        if (exists) {
          const content = fs.readFileSync(absolutePath, 'utf-8');
          const hash = this.calculateHash(content);
          
          beforeState.files[filePath] = {
            exists: true,
            content,
            hash,
            size: content.length,
            capturedAt: new Date().toISOString()
          };
          
          this.fileHashes.set(filePath, hash);
        } else {
          beforeState.files[filePath] = {
            exists: false,
            content: null,
            hash: null,
            capturedAt: new Date().toISOString()
          };
        }
      } catch (error) {
        log.error('app', 'Error capturing before state for', { filePath: filePath, error: error });
        beforeState.files[filePath] = {
          exists: false,
          error: error.message
        };
      }
    }

    this.snapshots.set(taskId, { before: beforeState, after: null });
    return beforeState;
  }

  /**
   * Capture the "after" state of files
   * @param {string} taskId - Task identifier
   * @returns {Object} Complete snapshot with before and after
   */
  async captureAfterState(taskId) {
    const snapshot = this.snapshots.get(taskId);
    if (!snapshot) {
      throw new Error(`No before state found for task ${taskId}`);
    }

    const afterState = {
      taskId,
      timestamp: new Date().toISOString(),
      files: {}
    };

    const filePaths = Object.keys(snapshot.before.files);

    for (const filePath of filePaths) {
      try {
        const absolutePath = path.resolve(filePath);
        const exists = fs.existsSync(absolutePath);
        
        if (exists) {
          const content = fs.readFileSync(absolutePath, 'utf-8');
          const hash = this.calculateHash(content);
          const beforeHash = snapshot.before.files[filePath]?.hash;
          
          afterState.files[filePath] = {
            exists: true,
            content,
            hash,
            size: content.length,
            changed: hash !== beforeHash,
            capturedAt: new Date().toISOString()
          };
        } else {
          afterState.files[filePath] = {
            exists: false,
            content: null,
            hash: null,
            changed: snapshot.before.files[filePath]?.exists === true,
            capturedAt: new Date().toISOString()
          };
        }
      } catch (error) {
        log.error('app', 'Error capturing after state for', { filePath: filePath, error: error });
        afterState.files[filePath] = {
          exists: false,
          error: error.message
        };
      }
    }

    snapshot.after = afterState;
    snapshot.diff = this.calculateDiff(snapshot.before, afterState);
    
    // Persist snapshot to disk
    await this.persistSnapshot(taskId, snapshot);
    
    return snapshot;
  }

  /**
   * Calculate diff between before and after states
   * @param {Object} before - Before state
   * @param {Object} after - After state
   * @returns {Object} Diff summary
   */
  calculateDiff(before, after) {
    const diff = {
      filesCreated: [],
      filesModified: [],
      filesDeleted: [],
      totalLinesAdded: 0,
      totalLinesRemoved: 0
    };

    const allPaths = new Set([
      ...Object.keys(before.files),
      ...Object.keys(after.files)
    ]);

    for (const filePath of allPaths) {
      const beforeFile = before.files[filePath];
      const afterFile = after.files[filePath];

      if (!beforeFile?.exists && afterFile?.exists) {
        diff.filesCreated.push(filePath);
        diff.totalLinesAdded += (afterFile.content?.split('\n').length || 0);
      } else if (beforeFile?.exists && !afterFile?.exists) {
        diff.filesDeleted.push(filePath);
        diff.totalLinesRemoved += (beforeFile.content?.split('\n').length || 0);
      } else if (beforeFile?.exists && afterFile?.exists && afterFile.changed) {
        diff.filesModified.push(filePath);
        
        const beforeLines = beforeFile.content?.split('\n').length || 0;
        const afterLines = afterFile.content?.split('\n').length || 0;
        diff.totalLinesAdded += Math.max(0, afterLines - beforeLines);
        diff.totalLinesRemoved += Math.max(0, beforeLines - afterLines);
      }
    }

    return diff;
  }

  /**
   * Persist snapshot to disk
   * @param {string} taskId - Task identifier
   * @param {Object} snapshot - Snapshot data
   */
  async persistSnapshot(taskId, snapshot) {
    try {
      const filename = `${taskId}-${Date.now()}.json`;
      const filepath = path.join(this.snapshotDir, filename);
      
      // Store content references instead of full content to save space
      const persistable = {
        ...snapshot,
        before: {
          ...snapshot.before,
          files: Object.fromEntries(
            Object.entries(snapshot.before.files).map(([p, f]) => [
              p,
              { ...f, contentRef: f.hash }
            ])
          )
        },
        after: snapshot.after ? {
          ...snapshot.after,
          files: Object.fromEntries(
            Object.entries(snapshot.after.files).map(([p, f]) => [
              p,
              { ...f, contentRef: f.hash }
            ])
          )
        } : null
      };

      fs.writeFileSync(filepath, JSON.stringify(persistable, null, 2));
      
      // Cleanup old snapshots
      await this.cleanupOldSnapshots();
    } catch (error) {
      log.error('app', 'Error persisting snapshot:', { error: error });
    }
  }

  /**
   * Restore files to before state (undo)
   * @param {string} taskId - Task identifier
   * @returns {Object} Restore result
   */
  async restore(taskId) {
    const snapshot = this.snapshots.get(taskId);
    if (!snapshot) {
      throw new Error(`No snapshot found for task ${taskId}`);
    }

    const results = {
      restored: [],
      failed: [],
      deleted: []
    };

    for (const [filePath, beforeFile] of Object.entries(snapshot.before.files)) {
      try {
        const absolutePath = path.resolve(filePath);
        
        if (beforeFile.exists && beforeFile.content !== null) {
          // Restore file to before state
          const dir = path.dirname(absolutePath);
          if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
          }
          fs.writeFileSync(absolutePath, beforeFile.content);
          results.restored.push(filePath);
        } else if (!beforeFile.exists && fs.existsSync(absolutePath)) {
          // File was created, delete it
          fs.unlinkSync(absolutePath);
          results.deleted.push(filePath);
        }
      } catch (error) {
        log.error('app', 'Error restoring', { filePath: filePath, error: error });
        results.failed.push({ path: filePath, error: error.message });
      }
    }

    return results;
  }

  /**
   * Get snapshot for a task
   * @param {string} taskId - Task identifier
   * @returns {Object|null} Snapshot data
   */
  getSnapshot(taskId) {
    return this.snapshots.get(taskId) || null;
  }

  /**
   * Check if files have changed since snapshot
   * @param {string} taskId - Task identifier
   * @returns {boolean}
   */
  hasChangedSinceSnapshot(taskId) {
    const snapshot = this.snapshots.get(taskId);
    if (!snapshot?.before) return false;

    for (const [filePath, beforeFile] of Object.entries(snapshot.before.files)) {
      try {
        const absolutePath = path.resolve(filePath);
        const exists = fs.existsSync(absolutePath);
        
        if (exists !== beforeFile.exists) return true;
        
        if (exists) {
          const content = fs.readFileSync(absolutePath, 'utf-8');
          const hash = this.calculateHash(content);
          if (hash !== beforeFile.hash) return true;
        }
      } catch {
        return true;
      }
    }

    return false;
  }

  /**
   * Cleanup old snapshots
   */
  async cleanupOldSnapshots() {
    try {
      const files = fs.readdirSync(this.snapshotDir)
        .filter(f => f.endsWith('.json'))
        .map(f => ({
          name: f,
          path: path.join(this.snapshotDir, f),
          time: fs.statSync(path.join(this.snapshotDir, f)).mtime.getTime()
        }))
        .sort((a, b) => b.time - a.time);

      // Remove snapshots beyond the limit
      for (const file of files.slice(this.maxSnapshots)) {
        fs.unlinkSync(file.path);
      }
    } catch (error) {
      log.error('app', 'Error cleaning up snapshots:', { error: error });
    }
  }

  /**
   * Clear all snapshots for a task
   * @param {string} taskId - Task identifier
   */
  clearSnapshot(taskId) {
    this.snapshots.delete(taskId);
  }

  /**
   * Get all task IDs with snapshots
   * @returns {string[]}
   */
  getAllTaskIds() {
    return [...this.snapshots.keys()];
  }
}

module.exports = FileSnapshotManager;
module.exports.FileSnapshotManager = FileSnapshotManager;


