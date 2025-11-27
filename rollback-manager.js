const { app, shell } = require('electron');
const fs = require('fs').promises;
const path = require('path');

class RollbackManager {
  constructor() {
    this.backupDir = null;
    this.maxBackups = 3;
  }
  
  _ensureBackupDir() {
    if (!this.backupDir) {
      this.backupDir = path.join(app.getPath('userData'), 'app-backups');
    }
    return this.backupDir;
  }

  async init() {
    try {
      this._ensureBackupDir();
      await fs.mkdir(this.backupDir, { recursive: true });
      console.log('Rollback manager initialized:', this.backupDir);
    } catch (error) {
      console.error('Failed to init rollback manager:', error);
    }
  }

  async createBackup(version) {
    try {
      this._ensureBackupDir();
      const backupPath = path.join(this.backupDir, `v${version}`);
      await fs.mkdir(backupPath, { recursive: true });
      await fs.writeFile(
        path.join(backupPath, 'backup-metadata.json'),
        JSON.stringify({ version, date: new Date().toISOString() }, null, 2)
      );
      await this.cleanupOldBackups();
      return true;
    } catch (error) {
      console.error('Backup failed:', error);
      return false;
    }
  }

  async getAvailableBackups() {
    try {
      this._ensureBackupDir();
      await fs.mkdir(this.backupDir, { recursive: true });
      const files = await fs.readdir(this.backupDir);
      return files.filter(f => f.startsWith('v')).map(f => ({
        version: f.substring(1),
        path: path.join(this.backupDir, f)
      }));
    } catch (error) {
      return [];
    }
  }

  async getBackups() {
    return this.getAvailableBackups();
  }

  async openBackupsFolder() {
    try {
      this._ensureBackupDir();
      await fs.mkdir(this.backupDir, { recursive: true });
      await shell.openPath(this.backupDir);
    } catch (error) {
      console.error('Failed to open backups folder:', error);
    }
  }

  async cleanupOldBackups() {
    try {
      const backups = await this.getAvailableBackups();
      if (backups.length > this.maxBackups) {
        for (const backup of backups.slice(this.maxBackups)) {
          await fs.rm(backup.path, { recursive: true, force: true });
        }
      }
    } catch (error) {}
  }

  async createRestoreScript() { return null; }
  formatSize(bytes) { return `${(bytes/1024).toFixed(1)} KB`; }
}

module.exports = new RollbackManager();
