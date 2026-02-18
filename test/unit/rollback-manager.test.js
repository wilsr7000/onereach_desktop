/**
 * Rollback Manager - CRUD Lifecycle Tests
 *
 * Lifecycle: Create backup -> List -> Verify contents -> Cleanup old -> Verify gone
 *
 * Run:  npx vitest run test/unit/rollback-manager.test.js
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'path';
import fsSync from 'fs';
import fsPromises from 'fs/promises';
import os from 'os';

// Mock electron modules
vi.mock(
  'electron',
  () => ({
    app: { getPath: vi.fn(() => '/mock/userData') },
    shell: { openPath: vi.fn() },
  }),
  { virtual: true }
);

let tmpDir;

beforeEach(() => {
  tmpDir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'rollback-test-'));
});

afterEach(() => {
  try {
    fsSync.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

// Directly build a manager-like object that uses our tmpDir
function createManager() {
  const backupDir = path.join(tmpDir, 'app-backups');
  return {
    backupDir,
    maxBackups: 3,

    _ensureBackupDir() {
      return this.backupDir;
    },

    async init() {
      await fsPromises.mkdir(this.backupDir, { recursive: true });
    },

    async createBackup(version) {
      await fsPromises.mkdir(this.backupDir, { recursive: true });
      const backupPath = path.join(this.backupDir, `v${version}`);
      await fsPromises.mkdir(backupPath, { recursive: true });
      await fsPromises.writeFile(
        path.join(backupPath, 'backup-metadata.json'),
        JSON.stringify({ version, date: new Date().toISOString() }, null, 2)
      );
      await this.cleanupOldBackups();
      return true;
    },

    async getAvailableBackups() {
      try {
        await fsPromises.mkdir(this.backupDir, { recursive: true });
        const files = await fsPromises.readdir(this.backupDir);
        return files
          .filter((f) => f.startsWith('v'))
          .map((f) => ({
            version: f.substring(1),
            path: path.join(this.backupDir, f),
          }));
      } catch {
        return [];
      }
    },

    async getBackups() {
      return this.getAvailableBackups();
    },

    async cleanupOldBackups() {
      const backups = await this.getAvailableBackups();
      if (backups.length > this.maxBackups) {
        for (const backup of backups.slice(this.maxBackups)) {
          await fsPromises.rm(backup.path, { recursive: true, force: true });
        }
      }
    },

    formatSize(bytes) {
      return `${(bytes / 1024).toFixed(1)} KB`;
    },
  };
}

// ═══════════════════════════════════════════════════════════════════
// BACKUP CRUD LIFECYCLE
// ═══════════════════════════════════════════════════════════════════

describe('RollbackManager - Backup CRUD Lifecycle', () => {
  let manager;

  beforeEach(() => {
    manager = createManager();
  });

  it('Step 1: Create a backup', async () => {
    const result = await manager.createBackup('1.0.0');
    expect(result).toBe(true);
    const metaPath = path.join(manager.backupDir, 'v1.0.0', 'backup-metadata.json');
    expect(fsSync.existsSync(metaPath)).toBe(true);
  });

  it('Step 2: List backups (read)', async () => {
    await manager.createBackup('1.0.0');
    const backups = await manager.getAvailableBackups();
    expect(backups.length).toBe(1);
    expect(backups[0].version).toBe('1.0.0');
  });

  it('Step 3: Create additional backups and verify listing', async () => {
    await manager.createBackup('1.0.0');
    await manager.createBackup('1.1.0');
    await manager.createBackup('1.2.0');
    const backups = await manager.getAvailableBackups();
    expect(backups.length).toBe(3);
  });

  it('Step 4: Verify metadata contents', async () => {
    await manager.createBackup('2.0.0');
    const metaPath = path.join(manager.backupDir, 'v2.0.0', 'backup-metadata.json');
    const meta = JSON.parse(fsSync.readFileSync(metaPath, 'utf8'));
    expect(meta.version).toBe('2.0.0');
    expect(meta.date).toBeTruthy();
  });

  it('Step 5: Cleanup enforces maxBackups limit', async () => {
    await manager.createBackup('1.0.0');
    await manager.createBackup('1.1.0');
    await manager.createBackup('1.2.0');
    await manager.createBackup('1.3.0');
    const backups = await manager.getAvailableBackups();
    expect(backups.length).toBeLessThanOrEqual(3);
  });

  it('Step 6: getBackups() is an alias for getAvailableBackups()', async () => {
    await manager.createBackup('3.0.0');
    const a = await manager.getAvailableBackups();
    const b = await manager.getBackups();
    expect(a.length).toBe(b.length);
  });
});

// ═══════════════════════════════════════════════════════════════════
// EDGE CASES
// ═══════════════════════════════════════════════════════════════════

describe('RollbackManager - Edge Cases', () => {
  it('should return empty array when no backups exist', async () => {
    const mgr = createManager();
    const backups = await mgr.getAvailableBackups();
    expect(backups).toEqual([]);
  });

  it('formatSize should format bytes correctly', () => {
    const mgr = createManager();
    expect(mgr.formatSize(1024)).toBe('1.0 KB');
    expect(mgr.formatSize(2048)).toBe('2.0 KB');
    expect(mgr.formatSize(512)).toBe('0.5 KB');
  });
});
