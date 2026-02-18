/**
 * Clipboard Storage Validator and Cleanup Utility
 * Ensures consistency between metadata and actual files
 */

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

class ClipboardStorageValidator {
  constructor() {
    this.documentsPath = app.getPath('documents');
    this.storageRoot = path.join(this.documentsPath, 'OR-Spaces');
    this.indexPath = path.join(this.storageRoot, 'index.json');
    this.itemsDir = path.join(this.storageRoot, 'items');
    this.spacesDir = path.join(this.storageRoot, 'spaces');

    this.issues = [];
    this.fixedCount = 0;
  }

  /**
   * Validate the entire storage structure
   * @param {boolean} autoFix - Automatically fix issues if true
   * @returns {Object} Validation report
   */
  async validateStorage(autoFix = false) {
    console.log('[Validator] Starting storage validation...');
    this.issues = [];
    this.fixedCount = 0;

    const report = {
      startTime: new Date().toISOString(),
      autoFix: autoFix,
      issues: [],
      fixes: [],
      summary: {},
    };

    try {
      // 1. Check if storage root exists
      if (!fs.existsSync(this.storageRoot)) {
        report.issues.push({
          type: 'missing_root',
          message: 'Storage root directory does not exist',
          path: this.storageRoot,
        });

        if (autoFix) {
          fs.mkdirSync(this.storageRoot, { recursive: true });
          fs.mkdirSync(this.itemsDir, { recursive: true });
          fs.mkdirSync(this.spacesDir, { recursive: true });
          report.fixes.push('Created storage directories');
        }
      }

      // 2. Load and validate index
      let index = null;
      if (fs.existsSync(this.indexPath)) {
        try {
          const indexData = fs.readFileSync(this.indexPath, 'utf8');
          index = JSON.parse(indexData);
        } catch (error) {
          report.issues.push({
            type: 'corrupt_index',
            message: 'Index file is corrupted',
            error: error.message,
          });

          // Try backup
          const backupPath = this.indexPath + '.backup';
          if (fs.existsSync(backupPath)) {
            try {
              const backupData = fs.readFileSync(backupPath, 'utf8');
              index = JSON.parse(backupData);

              if (autoFix) {
                fs.writeFileSync(this.indexPath, JSON.stringify(index, null, 2));
                report.fixes.push('Restored index from backup');
              }
            } catch (backupError) {
              report.issues.push({
                type: 'corrupt_backup',
                message: 'Backup index is also corrupted',
                error: backupError.message,
              });
            }
          }
        }
      } else {
        report.issues.push({
          type: 'missing_index',
          message: 'Index file does not exist',
        });
      }

      if (!index) {
        report.summary = {
          totalItems: 0,
          orphanedMetadata: 0,
          missingFiles: 0,
          corruptedFiles: 0,
          fixedIssues: 0,
        };
        return report;
      }

      // 3. Validate each item in the index
      const validItems = [];
      const orphanedItems = [];
      const missingFiles = [];

      for (const item of index.items) {
        const itemReport = await this.validateItem(item);

        if (itemReport.valid) {
          validItems.push(item);
        } else {
          report.issues.push({
            type: 'invalid_item',
            itemId: item.id,
            problems: itemReport.problems,
          });

          if (itemReport.problems.includes('missing_directory')) {
            orphanedItems.push(item);
          } else if (itemReport.problems.includes('missing_content_file')) {
            missingFiles.push(item);
          }
        }
      }

      // 4. Check for orphaned directories (not in index)
      const orphanedDirs = await this.findOrphanedDirectories(index.items);
      if (orphanedDirs.length > 0) {
        report.issues.push({
          type: 'orphaned_directories',
          count: orphanedDirs.length,
          directories: orphanedDirs,
        });

        if (autoFix) {
          for (const dir of orphanedDirs) {
            await this.removeDirectory(dir);
            report.fixes.push(`Removed orphaned directory: ${path.basename(dir)}`);
          }
        }
      }

      // 5. Fix issues if autoFix is enabled
      if (autoFix) {
        // Remove orphaned metadata entries
        for (const item of orphanedItems) {
          const idx = index.items.findIndex((i) => i.id === item.id);
          if (idx !== -1) {
            index.items.splice(idx, 1);
            report.fixes.push(`Removed orphaned metadata: ${item.id}`);
            this.fixedCount++;
          }
        }

        // Remove entries with missing files
        for (const item of missingFiles) {
          const idx = index.items.findIndex((i) => i.id === item.id);
          if (idx !== -1) {
            index.items.splice(idx, 1);
            report.fixes.push(`Removed entry with missing file: ${item.id}`);
            this.fixedCount++;
          }
        }

        // Save the cleaned index
        if (this.fixedCount > 0) {
          // Backup current index first
          fs.writeFileSync(this.indexPath + '.backup', fs.readFileSync(this.indexPath, 'utf8'));

          // Save cleaned index
          fs.writeFileSync(this.indexPath, JSON.stringify(index, null, 2));
          report.fixes.push(`Saved cleaned index (removed ${this.fixedCount} entries)`);
        }
      }

      // 6. Generate summary
      report.summary = {
        totalItems: index.items.length,
        validItems: validItems.length,
        orphanedMetadata: orphanedItems.length,
        missingFiles: missingFiles.length,
        orphanedDirectories: orphanedDirs.length,
        fixedIssues: this.fixedCount,
      };

      report.endTime = new Date().toISOString();

      console.log('[Validator] Validation complete:', report.summary);
    } catch (error) {
      console.error('[Validator] Validation error:', error);
      report.error = error.message;
    }

    return report;
  }

  /**
   * Validate a single item
   * @param {Object} item - Item from index
   * @returns {Object} Validation result
   */
  async validateItem(item) {
    const problems = [];
    const itemDir = path.join(this.itemsDir, item.id);

    // Check if item directory exists
    if (!fs.existsSync(itemDir)) {
      problems.push('missing_directory');
      return { valid: false, problems };
    }

    // Check for content file
    if (item.contentPath) {
      const fullContentPath = path.join(this.storageRoot, item.contentPath);
      if (!fs.existsSync(fullContentPath)) {
        problems.push('missing_content_file');
      } else {
        // Check file size
        try {
          const stats = fs.statSync(fullContentPath);
          if (stats.size === 0) {
            problems.push('empty_content_file');
          }
        } catch (_error) {
          problems.push('cannot_stat_content_file');
        }
      }
    }

    // For file type items, check the actual file
    if (item.type === 'file' && item.fileName) {
      const filePath = path.join(itemDir, item.fileName);
      if (!fs.existsSync(filePath)) {
        // Try to find any file in the directory
        const files = fs
          .readdirSync(itemDir)
          .filter((f) => !f.endsWith('.json') && !f.endsWith('.png') && !f.startsWith('.'));

        if (files.length === 0) {
          problems.push('missing_file_content');
        } else if (files[0] !== item.fileName) {
          problems.push('filename_mismatch');
        }
      }
    }

    // Check metadata file
    const metadataPath = path.join(itemDir, 'metadata.json');
    if (!fs.existsSync(metadataPath)) {
      problems.push('missing_metadata');
    } else {
      try {
        JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
      } catch (_error) {
        problems.push('corrupt_metadata');
      }
    }

    return {
      valid: problems.length === 0,
      problems,
    };
  }

  /**
   * Find directories that exist but aren't in the index
   * @param {Array} indexItems - Items from the index
   * @returns {Array} Paths of orphaned directories
   */
  async findOrphanedDirectories(indexItems) {
    const orphaned = [];

    if (!fs.existsSync(this.itemsDir)) {
      return orphaned;
    }

    const indexedIds = new Set(indexItems.map((item) => item.id));
    const directories = fs
      .readdirSync(this.itemsDir, { withFileTypes: true })
      .filter((dirent) => dirent.isDirectory())
      .map((dirent) => dirent.name);

    for (const dirName of directories) {
      if (!indexedIds.has(dirName)) {
        orphaned.push(path.join(this.itemsDir, dirName));
      }
    }

    return orphaned;
  }

  /**
   * Safely remove a directory and its contents
   * @param {string} dirPath - Directory path to remove
   */
  async removeDirectory(dirPath) {
    try {
      if (fs.existsSync(dirPath)) {
        fs.rmSync(dirPath, { recursive: true, force: true });
        console.log('[Validator] Removed directory:', dirPath);
      }
    } catch (error) {
      console.error('[Validator] Failed to remove directory:', dirPath, error);
    }
  }

  /**
   * Get a summary of storage usage
   * @returns {Object} Storage summary
   */
  async getStorageSummary() {
    const summary = {
      totalSize: 0,
      itemCount: 0,
      spaceCount: 0,
      largestFiles: [],
      fileTypes: {},
    };

    try {
      // Load index
      if (!fs.existsSync(this.indexPath)) {
        return summary;
      }

      const indexData = fs.readFileSync(this.indexPath, 'utf8');
      const index = JSON.parse(indexData);

      summary.itemCount = index.items.length;
      summary.spaceCount = index.spaces ? index.spaces.length : 0;

      // Calculate sizes
      for (const item of index.items) {
        const itemDir = path.join(this.itemsDir, item.id);

        if (fs.existsSync(itemDir)) {
          const dirSize = await this.getDirectorySize(itemDir);
          summary.totalSize += dirSize;

          // Track file types
          if (item.type) {
            summary.fileTypes[item.type] = (summary.fileTypes[item.type] || 0) + 1;
          }

          // Track large files
          if (item.type === 'file' && item.fileSize) {
            summary.largestFiles.push({
              id: item.id,
              name: item.fileName,
              size: item.fileSize,
            });
          }
        }
      }

      // Sort largest files
      summary.largestFiles.sort((a, b) => b.size - a.size);
      summary.largestFiles = summary.largestFiles.slice(0, 10);
    } catch (error) {
      console.error('[Validator] Error getting storage summary:', error);
    }

    return summary;
  }

  /**
   * Get the total size of a directory
   * @param {string} dirPath - Directory path
   * @returns {number} Total size in bytes
   */
  async getDirectorySize(dirPath) {
    let totalSize = 0;

    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);

        if (entry.isDirectory()) {
          totalSize += await this.getDirectorySize(fullPath);
        } else if (entry.isFile()) {
          const stats = fs.statSync(fullPath);
          totalSize += stats.size;
        }
      }
    } catch (error) {
      console.error('[Validator] Error calculating directory size:', dirPath, error);
    }

    return totalSize;
  }
}

module.exports = ClipboardStorageValidator;
