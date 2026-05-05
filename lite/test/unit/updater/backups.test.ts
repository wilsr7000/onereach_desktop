/**
 * Unit tests for lite/updater/backups.ts -- backup retention.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { BackupManager, DEFAULT_MAX_BACKUPS } from '../../../updater/backups.js';

let userDataDir: string;

beforeEach(async () => {
  userDataDir = await fs.mkdtemp(path.join(tmpdir(), 'lite-backups-test-'));
});

afterEach(async () => {
  await fs.rm(userDataDir, { recursive: true, force: true });
});

describe('BackupManager.createBackup', () => {
  it('creates a v<version>/ dir with backup-metadata.json', async () => {
    const mgr = new BackupManager({ userDataPath: userDataDir });
    expect(await mgr.createBackup('1.0.0')).toBe(true);
    const meta = JSON.parse(
      await fs.readFile(path.join(userDataDir, 'app-backups', 'v1.0.0', 'backup-metadata.json'), 'utf-8')
    ) as { version: string; date: string };
    expect(meta.version).toBe('1.0.0');
    expect(typeof meta.date).toBe('string');
  });

  it('returns false on filesystem error (non-fatal -- install proceeds)', async () => {
    // Make app-backups/ a regular file so mkdir collides.
    await fs.mkdir(path.join(userDataDir, 'app-backups').replace(/\/$/, ''), { recursive: true });
    await fs.rm(path.join(userDataDir, 'app-backups'), { recursive: true, force: true });
    await fs.writeFile(path.join(userDataDir, 'app-backups'), 'collision');

    const mgr = new BackupManager({ userDataPath: userDataDir });
    expect(await mgr.createBackup('1.0.0')).toBe(false);
  });
});

describe('BackupManager.list', () => {
  it('returns empty when no backups exist', async () => {
    const mgr = new BackupManager({ userDataPath: userDataDir });
    expect(await mgr.list()).toEqual([]);
  });

  it('sorts newest version first', async () => {
    const mgr = new BackupManager({ userDataPath: userDataDir });
    await mgr.createBackup('1.0.0');
    await mgr.createBackup('1.10.0');
    await mgr.createBackup('1.2.0');
    const list = await mgr.list();
    expect(list.map((b) => b.version)).toEqual(['1.10.0', '1.2.0', '1.0.0']);
  });
});

describe('BackupManager.cleanupOldBackups', () => {
  it('retains DEFAULT_MAX_BACKUPS (3) most-recent backups', async () => {
    const mgr = new BackupManager({ userDataPath: userDataDir });
    for (let i = 1; i <= 5; i++) {
      await mgr.createBackup(`1.0.${i}`);
    }
    const list = await mgr.list();
    expect(list.length).toBe(DEFAULT_MAX_BACKUPS);
    expect(list.map((b) => b.version)).toEqual(['1.0.5', '1.0.4', '1.0.3']);
  });

  it('honors a custom maxBackups override', async () => {
    const mgr = new BackupManager({ userDataPath: userDataDir, maxBackups: 1 });
    await mgr.createBackup('1.0.0');
    await mgr.createBackup('1.0.1');
    const list = await mgr.list();
    expect(list.length).toBe(1);
    expect(list[0]!.version).toBe('1.0.1');
  });
});
