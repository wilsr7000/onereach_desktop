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
      return files
        .filter((f) => f.startsWith('v'))
        .map((f) => ({
          version: f.substring(1),
          path: path.join(this.backupDir, f),
        }));
    } catch (_error) {
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
    } catch (err) {
      console.warn('[RollbackManager] cleanupOldBackups:', err.message);
    }
  }

  async createRestoreScript(version) {
    try {
      this._ensureBackupDir();
      const backups = await this.getAvailableBackups();
      const target = version
        ? backups.find(b => b.version === version)
        : backups[0];
      if (!target) return null;

      const scriptPath = path.join(this.backupDir, `restore-v${target.version}.sh`);
      const appDir = path.resolve(__dirname);
      const script = [
        '#!/bin/bash',
        `# Restore GSX Power User to v${target.version}`,
        `# Generated: ${new Date().toISOString()}`,
        '',
        `BACKUP_DIR="${target.path}"`,
        `APP_DIR="${appDir}"`,
        '',
        'if [ ! -d "$BACKUP_DIR" ]; then',
        '  echo "Backup not found: $BACKUP_DIR"',
        '  exit 1',
        'fi',
        '',
        'echo "Restoring from v' + target.version + '..."',
        'cp -f "$BACKUP_DIR/backup-metadata.json" "$APP_DIR/restore-marker.json" 2>/dev/null',
        'echo "Restore marker written. Restart the app to complete."',
      ].join('\n');

      const fsSync = require('fs');
      fsSync.writeFileSync(scriptPath, script, { mode: 0o755 });
      return scriptPath;
    } catch (error) {
      console.error('Failed to create restore script:', error);
      return null;
    }
  }
  formatSize(bytes) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
}

module.exports = new RollbackManager();
