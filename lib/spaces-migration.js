/**
 * spaces-migration.js -- One-time migration from Spaces v2 to v3 (Git-backed)
 * 
 * This migration:
 * 1. Backs up the entire OR-Spaces directory
 * 2. Initializes it as a Git repo
 * 3. Creates an initial commit capturing the v2 state
 * 4. Strips legacy fields from all metadata files (upgrade to v3 schema)
 * 5. Commits the clean v3 state
 * 6. Writes a version marker so the migration never runs again
 * 
 * This is a one-way, non-reversible migration. The backup is the safety net.
 * No backward compatibility with v2 is maintained after migration.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { SpacesGit, OR_SPACES_DIR } = require('./spaces-git');

// ── Progress Reporting ───────────────────────────────────────────────────────

/**
 * @callback ProgressCallback
 * @param {string} step - Current step name
 * @param {string} detail - Human-readable detail
 * @param {number} percent - 0-100 progress
 */

// ── Migration Steps ──────────────────────────────────────────────────────────

/**
 * Run the full v2 -> v3 migration.
 * 
 * @param {Object} [opts]
 * @param {string} [opts.dir] - Override OR-Spaces directory (for testing)
 * @param {ProgressCallback} [opts.onProgress] - Progress callback
 * @param {boolean} [opts.skipBackup=false] - Skip backup step (for testing only)
 * @returns {Promise<{success: boolean, backupPath: string|null, commitSha: string, stats: Object}>}
 */
async function migrateToV3(opts = {}) {
  const dir = opts.dir || OR_SPACES_DIR;
  const onProgress = opts.onProgress || (() => {});
  const spacesGit = new SpacesGit(dir);

  // Pre-check: already migrated?
  if (spacesGit.isV3()) {
    onProgress('complete', 'Already migrated to v3', 100);
    return { success: true, backupPath: null, commitSha: null, stats: { alreadyMigrated: true } };
  }

  const stats = {
    spacesProcessed: 0,
    itemsProcessed: 0,
    fieldsStripped: 0,
    filesStaged: 0,
    backupSizeMB: 0,
  };

  let backupPath = null;

  try {
    // ── Step 1: Full Backup ──────────────────────────────────────────────
    if (!opts.skipBackup) {
      onProgress('backup', 'Creating full backup...', 5);
      backupPath = await createBackup(dir);
      const backupSize = getDirSize(backupPath);
      stats.backupSizeMB = Math.round(backupSize / 1048576);
      onProgress('backup', `Backup created at ${backupPath} (${stats.backupSizeMB}MB)`, 15);
    }

    // ── Step 2: Git Init ─────────────────────────────────────────────────
    onProgress('init', 'Initializing version control...', 20);
    await spacesGit.init();
    onProgress('init', 'Git repository initialized', 25);

    // ── Step 3: Initial Commit (v2 snapshot) ─────────────────────────────
    onProgress('snapshot', 'Capturing current state...', 30);
    const snapshotResult = await spacesGit.commitAll({
      message: 'Migration from Spaces v2 -- initial snapshot\n\nCaptures the exact state of all spaces and items before v3 upgrade.',
      authorName: 'OneReach Migration',
      authorEmail: 'system@onereach.ai',
    });
    stats.filesStaged = snapshotResult.filesChanged;
    onProgress('snapshot', `Committed ${stats.filesStaged} files`, 50);

    // ── Step 4: Strip Legacy Fields ──────────────────────────────────────
    onProgress('clean', 'Upgrading metadata to v3 schema...', 55);
    
    // Process space metadata files
    const spacesDir = path.join(dir, 'spaces');
    if (fs.existsSync(spacesDir)) {
      const spaceDirs = fs.readdirSync(spacesDir, { withFileTypes: true })
        .filter(d => d.isDirectory() && !d.name.startsWith('.'));
      
      for (const spaceDir of spaceDirs) {
        const metaPath = path.join(spacesDir, spaceDir.name, 'space-metadata.json');
        if (fs.existsSync(metaPath)) {
          const { fieldsRemoved } = upgradeSpaceMetadata(metaPath);
          stats.fieldsStripped += fieldsRemoved;
          stats.spacesProcessed++;
        }
      }
    }
    onProgress('clean', `Upgraded ${stats.spacesProcessed} spaces`, 65);

    // Process item metadata files
    const itemsDir = path.join(dir, 'items');
    if (fs.existsSync(itemsDir)) {
      const itemDirs = fs.readdirSync(itemsDir, { withFileTypes: true })
        .filter(d => d.isDirectory() && !d.name.startsWith('.'));
      
      for (const itemDir of itemDirs) {
        const metaPath = path.join(itemsDir, itemDir.name, 'metadata.json');
        if (fs.existsSync(metaPath)) {
          const { fieldsRemoved } = upgradeItemMetadata(metaPath);
          stats.fieldsStripped += fieldsRemoved;
          stats.itemsProcessed++;
        }
      }
    }
    onProgress('clean', `Upgraded ${stats.itemsProcessed} items, stripped ${stats.fieldsStripped} legacy fields`, 80);

    // ── Step 5: Commit Clean v3 State ────────────────────────────────────
    onProgress('commit', 'Committing v3 schema...', 85);
    const cleanResult = await spacesGit.commitAll({
      message: 'Upgrade metadata to v3 schema\n\nRemoved legacy fields:\n- events.versions (now tracked by Git)\n- projectConfig.currentVersion (replaced by Git HEAD)\n- Legacy versions[] arrays\n- v1 migration markers',
      authorName: 'OneReach Migration',
      authorEmail: 'system@onereach.ai',
    });
    onProgress('commit', `Committed v3 schema (${cleanResult.filesChanged} files updated)`, 90);

    // ── Step 6: Remove Legacy Files ──────────────────────────────────────
    onProgress('cleanup', 'Removing legacy artifacts...', 92);
    removeLegacyFiles(dir);
    onProgress('cleanup', 'Legacy files removed', 94);

    // ── Step 7: Write v3 Marker ──────────────────────────────────────────
    onProgress('marker', 'Writing version marker...', 96);
    spacesGit.writeV3Marker();
    
    // Commit the marker
    await spacesGit.commit({
      filepaths: ['.spaces-version'],
      message: 'Add v3 version marker',
      authorName: 'OneReach Migration',
      authorEmail: 'system@onereach.ai',
    });
    onProgress('complete', 'Migration complete', 100);

    return {
      success: true,
      backupPath,
      commitSha: snapshotResult.sha,
      stats,
    };

  } catch (err) {
    onProgress('error', `Migration failed: ${err.message}`, -1);
    throw new MigrationError(err.message, { backupPath, stats, originalError: err });
  }
}

// ── Schema Upgrade Functions ─────────────────────────────────────────────────

/**
 * Upgrade a space-metadata.json file to v3 schema.
 * Strips legacy fields, updates schema version.
 * 
 * @param {string} metaPath - Absolute path to space-metadata.json
 * @returns {{fieldsRemoved: number}}
 */
function upgradeSpaceMetadata(metaPath) {
  let fieldsRemoved = 0;
  const raw = fs.readFileSync(metaPath, 'utf8');
  const meta = JSON.parse(raw);

  // Update schema version
  if (!meta._schema) {
    meta._schema = { version: '3.0', type: 'space', storageEngine: 'git' };
  } else {
    meta._schema.version = '3.0';
    meta._schema.storageEngine = 'git';
    // Remove migration marker -- no longer needed
    if (meta._schema.migratedFrom) {
      delete meta._schema.migratedFrom;
      fieldsRemoved++;
    }
  }

  // Remove events.versions (Git is now the version source)
  if (meta.events && Array.isArray(meta.events.versions)) {
    delete meta.events.versions;
    fieldsRemoved++;
  }

  // Remove legacy top-level versions array
  if (Array.isArray(meta.versions)) {
    delete meta.versions;
    fieldsRemoved++;
  }

  // Remove projectConfig.currentVersion (Git HEAD replaces this)
  if (meta.projectConfig && meta.projectConfig.currentVersion !== undefined) {
    delete meta.projectConfig.currentVersion;
    fieldsRemoved++;
  }

  // Remove v1 format 'version' field if it's the old schema version string
  if (meta.version && typeof meta.version === 'string' && /^\d+\.\d+$/.test(meta.version)) {
    delete meta.version;
    fieldsRemoved++;
  }

  // Write back
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  return { fieldsRemoved };
}

/**
 * Upgrade an item metadata.json file to v3 schema.
 * Strips legacy fields, updates schema version.
 * 
 * @param {string} metaPath - Absolute path to metadata.json
 * @returns {{fieldsRemoved: number}}
 */
function upgradeItemMetadata(metaPath) {
  let fieldsRemoved = 0;
  const raw = fs.readFileSync(metaPath, 'utf8');
  const meta = JSON.parse(raw);

  // Update schema version
  if (!meta._schema) {
    meta._schema = { version: '3.0', type: 'item', storageEngine: 'git' };
  } else {
    meta._schema.version = '3.0';
    meta._schema.storageEngine = 'git';
    if (meta._schema.migratedFrom) {
      delete meta._schema.migratedFrom;
      fieldsRemoved++;
    }
  }

  // Remove events.versions (Git is now the version source)
  if (meta.events && Array.isArray(meta.events.versions)) {
    delete meta.events.versions;
    fieldsRemoved++;
  }

  // Remove legacy top-level versions array
  if (Array.isArray(meta.versions)) {
    delete meta.versions;
    fieldsRemoved++;
  }

  // Write back
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  return { fieldsRemoved };
}

// ── Backup ───────────────────────────────────────────────────────────────────

/**
 * Create a full backup of the OR-Spaces directory.
 * 
 * @param {string} dir - Source directory
 * @returns {Promise<string>} - Path to backup directory
 */
async function createBackup(dir) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(path.dirname(dir), `OR-Spaces-backup-${timestamp}`);
  
  copyDirRecursive(dir, backupDir);
  return backupDir;
}

/**
 * Recursively copy a directory.
 */
function copyDirRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    
    if (entry.isDirectory()) {
      // Skip .git directory in backup (it didn't exist before migration)
      if (entry.name === '.git') continue;
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// ── Legacy Cleanup ───────────────────────────────────────────────────────────

/**
 * Remove legacy files that are no longer needed after migration.
 */
function removeLegacyFiles(dir) {
  const legacyFiles = [
    'index.json',
    'index.json.backup',
  ];

  for (const file of legacyFiles) {
    const filePath = path.join(dir, file);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }

  // Remove backup-legacy-files-* directories
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('backup-legacy-files-') && entry.isDirectory()) {
      fs.rmSync(path.join(dir, entry.name), { recursive: true, force: true });
    }
    // Also remove timestamped index backups
    if (entry.name.startsWith('index.json.backup-') && !entry.isDirectory()) {
      fs.unlinkSync(path.join(dir, entry.name));
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function getDirSize(dir) {
  let size = 0;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        size += getDirSize(p);
      } else {
        size += fs.statSync(p).size;
      }
    }
  } catch { /* ignore permission errors */ }
  return size;
}

// ── Error Class ──────────────────────────────────────────────────────────────

class MigrationError extends Error {
  constructor(message, context) {
    super(message);
    this.name = 'MigrationError';
    this.backupPath = context.backupPath;
    this.stats = context.stats;
    this.originalError = context.originalError;
  }
}

// ── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  migrateToV3,
  upgradeSpaceMetadata,
  upgradeItemMetadata,
  createBackup,
  removeLegacyFiles,
  MigrationError,
};
