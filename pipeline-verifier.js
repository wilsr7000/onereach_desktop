/**
 * Pipeline Verifier
 *
 * Provides checksum calculation and verification for stored assets.
 * Used to ensure data integrity throughout the asset pipeline.
 *
 * Features:
 * - Content checksum calculation (SHA-256)
 * - Storage verification (file exists, readable)
 * - Index integrity checks
 * - Orphaned file detection
 * - Full integrity check (all items)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class PipelineVerifier {
  constructor(storage) {
    this.storage = storage;
  }

  /**
   * Calculate checksum for content
   * @param {Buffer|string} content - Content to hash
   * @returns {string} - Hex checksum (first 16 chars of SHA-256)
   */
  calculateChecksum(content) {
    const hash = crypto.createHash('sha256');

    if (Buffer.isBuffer(content)) {
      hash.update(content);
    } else if (typeof content === 'string') {
      hash.update(content);
    } else {
      throw new Error('Content must be a Buffer or string');
    }

    return hash.digest('hex').substring(0, 16);
  }

  /**
   * Calculate checksum for a file
   * @param {string} filePath - Path to file
   * @returns {Promise<string>} - Hex checksum
   */
  async calculateFileChecksum(filePath) {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const stream = fs.createReadStream(filePath);

      stream.on('data', (data) => hash.update(data));
      stream.on('end', () => resolve(hash.digest('hex').substring(0, 16)));
      stream.on('error', reject);
    });
  }

  /**
   * Verify an item's integrity
   * @param {string} itemId - Item ID to verify
   * @returns {Promise<Object>} - Verification result
   */
  async verifyItem(itemId) {
    const result = {
      itemId,
      valid: true,
      checks: {
        exists: false,
        readable: false,
        indexEntry: false,
        hasContent: false,
        thumbnailValid: null,
        metadataValid: false,
      },
      errors: [],
    };

    try {
      if (!this.storage) {
        result.errors.push('Storage not initialized');
        result.valid = false;
        return result;
      }

      // Check if item exists in index
      const indexEntry = this.storage.index?.items?.find((i) => i.id === itemId);
      if (!indexEntry) {
        result.errors.push('Item not found in index');
        result.valid = false;
        return result;
      }
      result.checks.indexEntry = true;

      // Check item directory
      const itemDir = path.join(this.storage.itemsDir, itemId);
      if (!fs.existsSync(itemDir)) {
        result.errors.push('Item directory not found');
        result.valid = false;
        return result;
      }
      result.checks.exists = true;

      // Check content file
      if (indexEntry.contentPath) {
        const contentPath = path.join(this.storage.storageRoot, indexEntry.contentPath);
        if (fs.existsSync(contentPath)) {
          result.checks.hasContent = true;

          // Check if readable
          try {
            fs.accessSync(contentPath, fs.constants.R_OK);
            result.checks.readable = true;
          } catch (_e) {
            result.errors.push('Content file not readable');
            result.valid = false;
          }
        } else {
          result.errors.push('Content file not found');
          result.valid = false;
        }
      }

      // Check thumbnail if expected
      if (indexEntry.thumbnailPath) {
        const thumbPath = path.join(this.storage.storageRoot, indexEntry.thumbnailPath);
        result.checks.thumbnailValid = fs.existsSync(thumbPath);
        if (!result.checks.thumbnailValid) {
          result.errors.push('Thumbnail file not found');
          // Don't mark as invalid - thumbnails can be regenerated
        }
      }

      // Check metadata file
      if (indexEntry.metadataPath) {
        const metaPath = path.join(this.storage.storageRoot, indexEntry.metadataPath);
        if (fs.existsSync(metaPath)) {
          try {
            const metaContent = fs.readFileSync(metaPath, 'utf8');
            JSON.parse(metaContent);
            result.checks.metadataValid = true;
          } catch (_e) {
            result.errors.push('Metadata file corrupted');
          }
        }
      }

      return result;
    } catch (error) {
      result.valid = false;
      result.errors.push(error.message);
      return result;
    }
  }

  /**
   * Verify checksum of stored item against original
   * @param {string} itemId - Item ID
   * @param {string} originalChecksum - Original checksum to compare
   * @returns {Promise<Object>} - Verification result
   */
  async verifyChecksum(itemId, originalChecksum) {
    try {
      if (!this.storage) {
        return { match: false, error: 'Storage not initialized' };
      }

      const indexEntry = this.storage.index?.items?.find((i) => i.id === itemId);
      if (!indexEntry?.contentPath) {
        return { match: false, error: 'Item not found' };
      }

      const contentPath = path.join(this.storage.storageRoot, indexEntry.contentPath);
      if (!fs.existsSync(contentPath)) {
        return { match: false, error: 'Content file not found' };
      }

      const currentChecksum = await this.calculateFileChecksum(contentPath);

      return {
        match: currentChecksum === originalChecksum,
        checksum: currentChecksum,
        originalChecksum,
      };
    } catch (error) {
      return { match: false, error: error.message };
    }
  }

  /**
   * Run full integrity check on all items
   * @returns {Promise<Object>} - Full check results
   */
  async runFullIntegrityCheck() {
    const startTime = Date.now();
    const results = {
      success: true,
      totalItems: 0,
      validItems: 0,
      invalidItems: 0,
      orphanedFiles: 0,
      missingFiles: 0,
      corruptedMetadata: 0,
      missingThumbnails: 0,
      issues: [],
      duration: 0,
    };

    try {
      if (!this.storage) {
        results.success = false;
        results.issues.push({ type: 'fatal', message: 'Storage not initialized' });
        return results;
      }

      const items = this.storage.index?.items || [];
      results.totalItems = items.length;

      // Verify each item
      for (const item of items) {
        const verification = await this.verifyItem(item.id);

        if (verification.valid) {
          results.validItems++;
        } else {
          results.invalidItems++;
          results.issues.push({
            type: 'invalid',
            itemId: item.id,
            errors: verification.errors,
          });
        }

        // Track specific issues
        if (!verification.checks.hasContent) {
          results.missingFiles++;
        }
        if (!verification.checks.metadataValid) {
          results.corruptedMetadata++;
        }
        if (verification.checks.thumbnailValid === false) {
          results.missingThumbnails++;
        }
      }

      // Check for orphaned files
      const orphaned = await this.findOrphanedFiles();
      results.orphanedFiles = orphaned.length;

      if (orphaned.length > 0) {
        results.issues.push({
          type: 'orphaned',
          files: orphaned.slice(0, 10), // Limit to first 10
          totalOrphaned: orphaned.length,
        });
      }

      results.success = results.invalidItems === 0 && results.orphanedFiles === 0;
    } catch (error) {
      results.success = false;
      results.issues.push({ type: 'error', message: error.message });
    }

    results.duration = Date.now() - startTime;
    return results;
  }

  /**
   * Find orphaned files (files in storage not in index)
   * @returns {Promise<string[]>} - List of orphaned file paths
   */
  async findOrphanedFiles() {
    const orphaned = [];

    try {
      if (!this.storage?.itemsDir || !fs.existsSync(this.storage.itemsDir)) {
        return orphaned;
      }

      // Get all item IDs from index
      const indexedIds = new Set((this.storage.index?.items || []).map((i) => i.id));

      // Scan items directory
      const dirs = fs.readdirSync(this.storage.itemsDir);

      for (const dir of dirs) {
        if (!indexedIds.has(dir)) {
          orphaned.push(path.join(this.storage.itemsDir, dir));
        }
      }
    } catch (error) {
      console.error('[Verifier] Error finding orphaned files:', error);
    }

    return orphaned;
  }

  /**
   * Repair an item by regenerating missing components
   * @param {string} itemId - Item ID to repair
   * @returns {Promise<Object>} - Repair result
   */
  async repairItem(itemId) {
    const repairs = {
      success: true,
      itemId,
      actions: [],
    };

    try {
      const verification = await this.verifyItem(itemId);

      if (verification.valid) {
        repairs.actions.push({ action: 'none', reason: 'Item is valid' });
        return repairs;
      }

      // Try to repair metadata
      if (!verification.checks.metadataValid) {
        try {
          await this._repairMetadata(itemId);
          repairs.actions.push({ action: 'repaired_metadata', success: true });
        } catch (e) {
          repairs.actions.push({ action: 'repaired_metadata', success: false, error: e.message });
          repairs.success = false;
        }
      }

      // Missing content cannot be repaired
      if (!verification.checks.hasContent) {
        repairs.actions.push({ action: 'content_missing', success: false, error: 'Cannot recover missing content' });
        repairs.success = false;
      }

      // Missing thumbnail can be flagged for regeneration
      if (verification.checks.thumbnailValid === false) {
        repairs.actions.push({ action: 'flag_thumbnail_regen', success: true });
      }
    } catch (error) {
      repairs.success = false;
      repairs.actions.push({ action: 'error', error: error.message });
    }

    return repairs;
  }

  /**
   * Repair corrupted metadata file
   */
  async _repairMetadata(itemId) {
    if (!this.storage) {
      throw new Error('Storage not initialized');
    }

    const indexEntry = this.storage.index?.items?.find((i) => i.id === itemId);
    if (!indexEntry) {
      throw new Error('Item not in index');
    }

    const metaPath = path.join(this.storage.storageRoot, indexEntry.metadataPath);
    const _itemDir = path.dirname(metaPath);

    // Create minimal valid metadata
    const metadata = {
      id: itemId,
      type: indexEntry.type,
      dateCreated: new Date().toISOString(),
      repaired: true,
      repairedAt: new Date().toISOString(),
    };

    fs.writeFileSync(metaPath, JSON.stringify(metadata, null, 2));
  }

  /**
   * Clean up orphaned files
   * @param {boolean} dryRun - If true, only report what would be deleted
   * @returns {Promise<Object>} - Cleanup result
   */
  async cleanupOrphanedFiles(dryRun = true) {
    const result = {
      dryRun,
      deleted: [],
      errors: [],
    };

    try {
      const orphaned = await this.findOrphanedFiles();

      for (const filePath of orphaned) {
        if (dryRun) {
          result.deleted.push(filePath);
        } else {
          try {
            // Delete directory and contents
            fs.rmSync(filePath, { recursive: true, force: true });
            result.deleted.push(filePath);
          } catch (e) {
            result.errors.push({ path: filePath, error: e.message });
          }
        }
      }
    } catch (error) {
      result.errors.push({ error: error.message });
    }

    return result;
  }

  /**
   * Get verification summary for dashboard
   * @returns {Object} - Summary stats
   */
  async getVerificationSummary() {
    try {
      const items = this.storage?.index?.items || [];
      const totalItems = items.length;

      // Quick check - just verify existence, not full integrity
      let validCount = 0;
      let missingCount = 0;

      for (const item of items) {
        const itemDir = path.join(this.storage.itemsDir, item.id);
        if (fs.existsSync(itemDir)) {
          validCount++;
        } else {
          missingCount++;
        }
      }

      return {
        totalItems,
        validItems: validCount,
        missingItems: missingCount,
        integrityPercentage: totalItems > 0 ? Math.round((validCount / totalItems) * 100) : 100,
      };
    } catch (error) {
      return {
        totalItems: 0,
        validItems: 0,
        missingItems: 0,
        integrityPercentage: 0,
        error: error.message,
      };
    }
  }
}

// Factory function
function getPipelineVerifier(storage) {
  return new PipelineVerifier(storage);
}

module.exports = {
  PipelineVerifier,
  getPipelineVerifier,
};
