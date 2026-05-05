/**
 * Onereach Lite Auto-Updater -- backup management.
 *
 * Creates a marker dir per-version under userData/app-backups/v<version>/
 * before each install. Keeps the most recent N versions (default 3).
 *
 * Borrowed pattern: rollback-manager.js (full file). Lite's variant is
 * smaller because lite has minimal local state in Phase 0a -- the backup
 * is currently a metadata marker only. Future ports (Spaces local cache,
 * settings) will extend createBackup() to copy meaningful state too.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { BackupMetadata, BackupRecord } from './types.js';

export const DEFAULT_MAX_BACKUPS = 3;

export interface BackupManagerOptions {
  /** Lite's userData path. */
  userDataPath: string;
  /** Retain at most this many backups. Defaults to 3. */
  maxBackups?: number;
  /** Optional logger -- called with structured events for diagnostics. */
  logger?: (level: 'info' | 'warn' | 'error', message: string, data?: unknown) => void;
}

export class BackupManager {
  private readonly backupDir: string;
  private readonly maxBackups: number;
  private readonly log: NonNullable<BackupManagerOptions['logger']>;

  constructor(opts: BackupManagerOptions) {
    this.backupDir = path.join(opts.userDataPath, 'app-backups');
    this.maxBackups = opts.maxBackups ?? DEFAULT_MAX_BACKUPS;
    this.log =
      opts.logger ??
      ((): void => {
        /* default: silent */
      });
  }

  get directory(): string {
    return this.backupDir;
  }

  /**
   * Create a backup marker for the given version. Includes timestamped
   * metadata; future ports may copy real state next to it. Returns true on
   * success -- failure is non-fatal for the install flow.
   */
  async createBackup(version: string): Promise<boolean> {
    try {
      const backupPath = path.join(this.backupDir, `v${version}`);
      await fs.mkdir(backupPath, { recursive: true });
      const metadata: BackupMetadata = { version, date: new Date().toISOString() };
      await fs.writeFile(
        path.join(backupPath, 'backup-metadata.json'),
        JSON.stringify(metadata, null, 2),
        'utf-8'
      );
      await this.cleanupOldBackups();
      this.log('info', 'backups: created', { version, backupPath });
      return true;
    } catch (err) {
      this.log('error', 'backups: create failed', {
        version,
        error: (err as Error).message,
      });
      return false;
    }
  }

  /**
   * List existing backups, newest version first (lexicographic, which
   * matches semver for sane versions).
   */
  async list(): Promise<BackupRecord[]> {
    try {
      await fs.mkdir(this.backupDir, { recursive: true });
      const entries = await fs.readdir(this.backupDir);
      const backups = entries
        .filter((e) => e.startsWith('v'))
        .map<BackupRecord>((e) => ({
          version: e.slice(1),
          path: path.join(this.backupDir, e),
        }));
      backups.sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
      return backups;
    } catch {
      return [];
    }
  }

  /** Remove backups beyond maxBackups (oldest first). */
  async cleanupOldBackups(): Promise<void> {
    try {
      const backups = await this.list();
      if (backups.length <= this.maxBackups) return;
      const toRemove = backups.slice(this.maxBackups);
      for (const backup of toRemove) {
        await fs.rm(backup.path, { recursive: true, force: true });
        this.log('info', 'backups: cleaned', { version: backup.version });
      }
    } catch (err) {
      this.log('warn', 'backups: cleanup failed', { error: (err as Error).message });
    }
  }
}
