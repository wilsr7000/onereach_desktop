/**
 * Version Manager for GSX Create
 * Creates automatic backups before code changes and enables rollback
 */

const fs = require('fs');
const path = require('path');

class VersionManager {
  constructor(spaceFolder) {
    this.spaceFolder = spaceFolder;
    this.versionsDir = path.join(spaceFolder, '.gsx-versions');
    this.indexFile = path.join(this.versionsDir, 'index.json');
    this.maxVersionsPerFile = 50; // Keep last 50 versions per file
    this.ensureVersionsDir();
  }

  ensureVersionsDir() {
    if (!fs.existsSync(this.versionsDir)) {
      fs.mkdirSync(this.versionsDir, { recursive: true });
      // Add .gitignore to exclude versions from git
      fs.writeFileSync(
        path.join(this.versionsDir, '.gitignore'),
        '*\n!.gitignore\n'
      );
    }
  }

  getIndex() {
    try {
      if (fs.existsSync(this.indexFile)) {
        return JSON.parse(fs.readFileSync(this.indexFile, 'utf8'));
      }
    } catch (error) {
      console.error('[VersionManager] Error reading index:', error);
    }
    return { files: {}, sessions: [] };
  }

  saveIndex(index) {
    fs.writeFileSync(this.indexFile, JSON.stringify(index, null, 2));
  }

  /**
   * Create a backup of a file before modification
   * @param {string} filePath - Absolute path to the file
   * @param {string} reason - Why this backup was created (e.g., "Before AI edit")
   * @returns {object} Version info
   */
  createVersion(filePath, reason = 'Manual backup') {
    try {
      if (!fs.existsSync(filePath)) {
        console.log('[VersionManager] File does not exist yet:', filePath);
        return null;
      }

      const relativePath = path.relative(this.spaceFolder, filePath);
      const content = fs.readFileSync(filePath, 'utf8');
      const stats = fs.statSync(filePath);
      
      const timestamp = Date.now();
      const versionId = `v${timestamp}`;
      const versionFileName = `${relativePath.replace(/\//g, '_')}_${versionId}`;
      const versionPath = path.join(this.versionsDir, versionFileName);
      
      // Save the content
      fs.writeFileSync(versionPath, content);
      
      // Update index
      const index = this.getIndex();
      if (!index.files[relativePath]) {
        index.files[relativePath] = [];
      }
      
      const versionInfo = {
        id: versionId,
        timestamp,
        date: new Date(timestamp).toISOString(),
        reason,
        size: content.length,
        lines: content.split('\n').length,
        fileName: versionFileName,
        originalModified: stats.mtime.toISOString()
      };
      
      index.files[relativePath].unshift(versionInfo);
      
      // Trim old versions
      if (index.files[relativePath].length > this.maxVersionsPerFile) {
        const removed = index.files[relativePath].splice(this.maxVersionsPerFile);
        // Delete old version files
        removed.forEach(v => {
          const oldPath = path.join(this.versionsDir, v.fileName);
          if (fs.existsSync(oldPath)) {
            fs.unlinkSync(oldPath);
          }
        });
      }
      
      this.saveIndex(index);
      
      console.log('[VersionManager] Created version:', versionId, 'for', relativePath);
      return versionInfo;
      
    } catch (error) {
      console.error('[VersionManager] Error creating version:', error);
      return null;
    }
  }

  /**
   * Create versions for multiple files (before AI edit)
   * @param {string[]} filePaths - Array of absolute file paths
   * @param {string} sessionId - ID for this edit session
   * @param {string} prompt - The AI prompt that triggered this
   * @returns {object} Session info with all versions
   */
  createSessionBackup(filePaths, sessionId, prompt = '') {
    const timestamp = Date.now();
    const versions = [];
    
    filePaths.forEach(filePath => {
      const version = this.createVersion(filePath, `Before AI edit: ${prompt.substring(0, 50)}...`);
      if (version) {
        versions.push({
          filePath: path.relative(this.spaceFolder, filePath),
          version
        });
      }
    });
    
    // Record session
    const index = this.getIndex();
    const session = {
      id: sessionId,
      timestamp,
      date: new Date(timestamp).toISOString(),
      prompt: prompt.substring(0, 200),
      filesBackedUp: versions.length,
      versions: versions.map(v => ({
        file: v.filePath,
        versionId: v.version.id
      }))
    };
    
    index.sessions.unshift(session);
    
    // Keep last 100 sessions
    if (index.sessions.length > 100) {
      index.sessions = index.sessions.slice(0, 100);
    }
    
    this.saveIndex(index);
    
    console.log('[VersionManager] Session backup created:', sessionId, 'with', versions.length, 'files');
    return session;
  }

  /**
   * Get all versions of a file
   * @param {string} filePath - Relative or absolute path
   * @returns {array} List of versions
   */
  getFileVersions(filePath) {
    const relativePath = filePath.startsWith(this.spaceFolder) 
      ? path.relative(this.spaceFolder, filePath)
      : filePath;
    
    const index = this.getIndex();
    return index.files[relativePath] || [];
  }

  /**
   * Get content of a specific version
   * @param {string} filePath - Relative path
   * @param {string} versionId - Version ID
   * @returns {string|null} File content or null
   */
  getVersionContent(filePath, versionId) {
    const versions = this.getFileVersions(filePath);
    const version = versions.find(v => v.id === versionId);
    
    if (!version) {
      console.error('[VersionManager] Version not found:', versionId);
      return null;
    }
    
    const versionPath = path.join(this.versionsDir, version.fileName);
    if (!fs.existsSync(versionPath)) {
      console.error('[VersionManager] Version file not found:', versionPath);
      return null;
    }
    
    return fs.readFileSync(versionPath, 'utf8');
  }

  /**
   * Rollback a file to a specific version
   * @param {string} filePath - Relative path
   * @param {string} versionId - Version ID to rollback to
   * @returns {boolean} Success
   */
  rollbackFile(filePath, versionId) {
    try {
      const relativePath = filePath.startsWith(this.spaceFolder) 
        ? path.relative(this.spaceFolder, filePath)
        : filePath;
      
      const absolutePath = path.join(this.spaceFolder, relativePath);
      
      // First, backup current state
      this.createVersion(absolutePath, `Before rollback to ${versionId}`);
      
      // Get the version content
      const content = this.getVersionContent(relativePath, versionId);
      if (content === null) {
        return false;
      }
      
      // Write the content
      fs.writeFileSync(absolutePath, content);
      
      console.log('[VersionManager] Rolled back', relativePath, 'to', versionId);
      return true;
      
    } catch (error) {
      console.error('[VersionManager] Error rolling back:', error);
      return false;
    }
  }

  /**
   * Rollback all files from a session
   * @param {string} sessionId - Session ID
   * @returns {object} Result with success status and details
   */
  rollbackSession(sessionId) {
    const index = this.getIndex();
    const session = index.sessions.find(s => s.id === sessionId);
    
    if (!session) {
      return { success: false, error: 'Session not found' };
    }
    
    const results = [];
    session.versions.forEach(v => {
      const success = this.rollbackFile(v.file, v.versionId);
      results.push({ file: v.file, success });
    });
    
    return {
      success: results.every(r => r.success),
      session,
      results
    };
  }

  /**
   * Get recent sessions
   * @param {number} limit - Number of sessions to return
   * @returns {array} List of sessions
   */
  getRecentSessions(limit = 20) {
    const index = this.getIndex();
    return index.sessions.slice(0, limit);
  }

  /**
   * Compare two versions
   * @param {string} filePath - File path
   * @param {string} versionId1 - First version
   * @param {string} versionId2 - Second version (or 'current' for current file)
   * @returns {object} Comparison result
   */
  compareVersions(filePath, versionId1, versionId2 = 'current') {
    const relativePath = filePath.startsWith(this.spaceFolder) 
      ? path.relative(this.spaceFolder, filePath)
      : filePath;
    
    const content1 = this.getVersionContent(relativePath, versionId1);
    let content2;
    
    if (versionId2 === 'current') {
      const absolutePath = path.join(this.spaceFolder, relativePath);
      content2 = fs.existsSync(absolutePath) ? fs.readFileSync(absolutePath, 'utf8') : '';
    } else {
      content2 = this.getVersionContent(relativePath, versionId2);
    }
    
    if (content1 === null || content2 === null) {
      return { error: 'Could not read version content' };
    }
    
    const lines1 = content1.split('\n');
    const lines2 = content2.split('\n');
    
    return {
      version1: { id: versionId1, lines: lines1.length, size: content1.length },
      version2: { id: versionId2, lines: lines2.length, size: content2.length },
      linesDiff: lines2.length - lines1.length,
      sizeDiff: content2.length - content1.length,
      content1,
      content2
    };
  }
}

// Singleton instances per space
const instances = new Map();

function getVersionManager(spaceFolder) {
  if (!instances.has(spaceFolder)) {
    instances.set(spaceFolder, new VersionManager(spaceFolder));
  }
  return instances.get(spaceFolder);
}

module.exports = { VersionManager, getVersionManager };

