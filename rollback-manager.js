const { app, shell } = require('electron');
const fs = require('fs').promises;
const path = require('path');
const { spawn } = require('child_process');

class RollbackManager {
  constructor() {
    this.backupDir = path.join(app.getPath('userData'), 'app-backups');
    this.maxBackups = 3; // Keep last 3 versions
  }

  /**
   * Initialize the rollback manager
   */
  async init() {
    try {
      await fs.mkdir(this.backupDir, { recursive: true });
      console.log('Rollback manager initialized. Backup directory:', this.backupDir);
    } catch (error) {
      console.error('Failed to initialize rollback manager:', error);
    }
  }

  /**
   * Create a backup of the current app before updating
   * @param {string} currentVersion - Current app version
   * @returns {Promise<boolean>} Success status
   */
  async createBackup(currentVersion) {
    try {
      const appPath = app.getAppPath();
      const backupPath = path.join(this.backupDir, `v${currentVersion}`);
      
      console.log(`Creating backup of v${currentVersion}...`);
      
      // Check if backup already exists
      try {
        await fs.access(backupPath);
        console.log(`Backup for v${currentVersion} already exists`);
        return true;
      } catch (e) {
        // Backup doesn't exist, proceed with creation
      }

      // Create backup directory
      await fs.mkdir(backupPath, { recursive: true });

      // Copy essential files for rollback
      const filesToBackup = [
        'package.json',
        'main.js',
        'renderer.js',
        'preload.js',
        // Add other critical files as needed
      ];

      // For macOS, we need to handle .app bundle differently
      if (process.platform === 'darwin' && appPath.includes('.app')) {
        // Store metadata about the app bundle
        const metadata = {
          version: currentVersion,
          appPath: appPath,
          backupDate: new Date().toISOString(),
          platform: process.platform,
          arch: process.arch
        };
        
        await fs.writeFile(
          path.join(backupPath, 'backup-metadata.json'),
          JSON.stringify(metadata, null, 2)
        );
        
        // Copy critical app files from Resources folder
        const resourcesPath = path.join(appPath, '..', '..', 'Resources');
        const appAsarPath = path.join(resourcesPath, 'app.asar');
        
        if (await this.fileExists(appAsarPath)) {
          // Copy app.asar for potential manual restore
          await this.copyFile(
            appAsarPath,
            path.join(backupPath, 'app.asar')
          );
        }
      } else {
        // For development or Windows/Linux
        for (const file of filesToBackup) {
          const srcPath = path.join(appPath, file);
          const destPath = path.join(backupPath, file);
          
          try {
            await this.copyFile(srcPath, destPath);
          } catch (error) {
            console.warn(`Failed to backup ${file}:`, error.message);
          }
        }
      }

      // Clean up old backups
      await this.cleanupOldBackups();
      
      console.log(`Backup created successfully at: ${backupPath}`);
      return true;
    } catch (error) {
      console.error('Failed to create backup:', error);
      return false;
    }
  }

  /**
   * Get list of available backups
   * @returns {Promise<Array>} List of backup versions
   */
  async getAvailableBackups() {
    try {
      const files = await fs.readdir(this.backupDir);
      const backups = [];
      
      for (const file of files) {
        if (file.startsWith('v')) {
          const backupPath = path.join(this.backupDir, file);
          const stats = await fs.stat(backupPath);
          
          // Try to read metadata
          let metadata = null;
          try {
            const metadataPath = path.join(backupPath, 'backup-metadata.json');
            const metadataContent = await fs.readFile(metadataPath, 'utf8');
            metadata = JSON.parse(metadataContent);
          } catch (e) {
            // No metadata file
          }
          
          backups.push({
            version: file.substring(1), // Remove 'v' prefix
            path: backupPath,
            createdAt: metadata?.backupDate || stats.birthtime,
            size: await this.getDirectorySize(backupPath),
            metadata
          });
        }
      }
      
      // Sort by version (newest first)
      backups.sort((a, b) => {
        return this.compareVersions(b.version, a.version);
      });
      
      return backups;
    } catch (error) {
      console.error('Failed to get available backups:', error);
      return [];
    }
  }

  /**
   * Open the backups folder in the system file explorer
   */
  async openBackupsFolder() {
    try {
      await shell.openPath(this.backupDir);
    } catch (error) {
      console.error('Failed to open backups folder:', error);
    }
  }

  /**
   * Clean up old backups, keeping only the most recent ones
   */
  async cleanupOldBackups() {
    try {
      const backups = await this.getAvailableBackups();
      
      if (backups.length > this.maxBackups) {
        // Remove oldest backups
        const backupsToRemove = backups.slice(this.maxBackups);
        
        for (const backup of backupsToRemove) {
          console.log(`Removing old backup: v${backup.version}`);
          await fs.rm(backup.path, { recursive: true, force: true });
        }
      }
    } catch (error) {
      console.error('Failed to cleanup old backups:', error);
    }
  }

  /**
   * Create a restore script for manual rollback
   * @param {string} targetVersion - Version to create restore script for
   */
  async createRestoreScript(targetVersion) {
    try {
      const backups = await this.getAvailableBackups();
      const backup = backups.find(b => b.version === targetVersion);
      
      if (!backup) {
        throw new Error(`Backup for v${targetVersion} not found`);
      }

      const scriptContent = process.platform === 'win32' 
        ? this.generateWindowsRestoreScript(backup)
        : this.generateUnixRestoreScript(backup);

      const scriptName = process.platform === 'win32' 
        ? `restore-v${targetVersion}.bat`
        : `restore-v${targetVersion}.sh`;

      const scriptPath = path.join(this.backupDir, scriptName);
      await fs.writeFile(scriptPath, scriptContent);
      
      // Make executable on Unix-like systems
      if (process.platform !== 'win32') {
        await fs.chmod(scriptPath, '755');
      }

      return scriptPath;
    } catch (error) {
      console.error('Failed to create restore script:', error);
      throw error;
    }
  }

  /**
   * Generate Windows restore script
   */
  generateWindowsRestoreScript(backup) {
    return `@echo off
echo ===============================================
echo Onereach.ai Rollback Tool
echo Restoring version ${backup.version}
echo ===============================================
echo.
echo WARNING: This will replace the current app version!
echo Close the Onereach.ai app before continuing.
echo.
pause

echo Creating backup of current version...
xcopy "%LOCALAPPDATA%\\onereach-ai" "%LOCALAPPDATA%\\onereach-ai-current-backup" /E /I /Y

echo Restoring v${backup.version}...
:: Add specific restore commands based on your app structure

echo.
echo Restore complete! You can now start Onereach.ai.
pause
`;
  }

  /**
   * Generate Unix (macOS/Linux) restore script
   */
  generateUnixRestoreScript(backup) {
    return `#!/bin/bash
echo "==============================================="
echo "Onereach.ai Rollback Tool"
echo "Restoring version ${backup.version}"
echo "==============================================="
echo ""
echo "WARNING: This will replace the current app version!"
echo "Make sure Onereach.ai is not running."
echo ""
read -p "Press Enter to continue or Ctrl+C to cancel..."

echo "Creating backup of current version..."
if [[ "$OSTYPE" == "darwin"* ]]; then
    # macOS specific
    cp -R "/Applications/Onereach.ai.app" "/Applications/Onereach.ai-backup.app" 2>/dev/null || true
    
    echo "Note: For macOS .app bundles, manual restoration may be required."
    echo "Backup location: ${backup.path}"
    echo ""
    echo "To manually restore:"
    echo "1. Quit Onereach.ai"
    echo "2. Move current app to Trash"
    echo "3. Download and install v${backup.version} from your backup"
else
    # Linux
    echo "Restoring application files..."
    # Add Linux-specific restore commands
fi

echo ""
echo "Restore information saved. Please refer to the backup location."
echo "Backup path: ${backup.path}"
`;
  }

  // Utility functions
  async fileExists(filePath) {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  async copyFile(src, dest) {
    const destDir = path.dirname(dest);
    await fs.mkdir(destDir, { recursive: true });
    await fs.copyFile(src, dest);
  }

  async getDirectorySize(dirPath) {
    let size = 0;
    const files = await fs.readdir(dirPath, { withFileTypes: true });
    
    for (const file of files) {
      const filePath = path.join(dirPath, file.name);
      if (file.isDirectory()) {
        size += await this.getDirectorySize(filePath);
      } else {
        const stats = await fs.stat(filePath);
        size += stats.size;
      }
    }
    
    return size;
  }

  compareVersions(v1, v2) {
    const parts1 = v1.split('.').map(Number);
    const parts2 = v2.split('.').map(Number);
    
    for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
      const part1 = parts1[i] || 0;
      const part2 = parts2[i] || 0;
      
      if (part1 > part2) return 1;
      if (part1 < part2) return -1;
    }
    
    return 0;
  }

  /**
   * Format file size for display
   */
  formatSize(bytes) {
    const units = ['B', 'KB', 'MB', 'GB'];
    let size = bytes;
    let unitIndex = 0;
    
    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex++;
    }
    
    return `${size.toFixed(1)} ${units[unitIndex]}`;
  }
}

module.exports = new RollbackManager(); 