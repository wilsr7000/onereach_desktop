/**
 * E2E: triggering a BackupManager.createBackup writes a marker dir and
 * its metadata file under userData/app-backups/v<version>/.
 *
 * Exercised via app.evaluate (no real download/install needed). The full
 * end-to-end path -- electron-updater fires update-downloaded -> backup
 * gets created -- requires a real signed fixture and is covered by the
 * future fixture-based scenario.
 */

import { test, expect } from '@playwright/test';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import {
  launchLite,
  closeLite,
  defaultExecutablePath,
  listAppBackups,
  type LiteHandle,
} from '../../harness/index.js';

let handle: LiteHandle | null = null;
let userDataDir: string | null = null;

test.afterEach(async () => {
  await closeLite(handle);
  handle = null;
  if (userDataDir !== null) {
    try {
      await fs.rm(userDataDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
    userDataDir = null;
  }
});

test('updater: BackupManager.createBackup writes app-backups/v<version>/backup-metadata.json', async ({}, testInfo) => {
  try {
    await fs.access(defaultExecutablePath());
  } catch {
    testInfo.skip(true, 'No built lite executable -- run `npm run lite:package:mac` first');
    return;
  }

  userDataDir = await fs.mkdtemp(path.join(tmpdir(), 'onereach-lite-test-backup-'));
  handle = await launchLite({ userDataDir });

  // Trigger via the updater handle's BackupManager (exposed on globalThis
  // for tests). Since lite doesn't expose BackupManager publicly, we
  // re-instantiate one inside the main process and invoke it directly.
  await handle.app.evaluate(async ({ app }, version: string) => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
    const updaterModule = require('./updater/backups.js') as typeof import('../../../updater/backups.js');
    const mgr = new updaterModule.BackupManager({ userDataPath: app.getPath('userData') });
    await mgr.createBackup(version);
  }, '0.0.1-test');

  const backups = await listAppBackups(handle.userDataPath);
  const v = backups.find((b) => b.version === '0.0.1-test');
  expect(v).toBeDefined();
  expect(v?.metadata).toMatchObject({ version: '0.0.1-test' });
  expect(v?.metadata?.date).toBeTruthy();
});
