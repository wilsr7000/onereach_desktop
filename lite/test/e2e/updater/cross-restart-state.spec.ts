/**
 * E2E: cross-restart install verification persists state correctly.
 *
 * Pre-seeds userData/update-state.json with a "we tried to install vX.Y.Z"
 * record where the version differs from the running one. Boots lite,
 * lets verifyUpdateOnStartup run, asserts that:
 *   - failedAttempts is incremented
 *   - The lastAttemptVersion is preserved (Skip path leaves state)
 *
 * The dialog itself is suppressed because Playwright cannot interact with
 * Electron's native dialog -- this test focuses on the persisted state
 * change, which is the contract the verify path must hold.
 */

import { test, expect } from '@playwright/test';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import {
  launchLite,
  closeLite,
  defaultExecutablePath,
  readUpdateState,
  writeUpdateState,
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

test('updater: failed install on prior run is detected and recorded', async ({}, testInfo) => {
  try {
    await fs.access(defaultExecutablePath());
  } catch {
    testInfo.skip(true, 'No built lite executable -- run `npm run lite:package:mac` first');
    return;
  }

  userDataDir = await fs.mkdtemp(path.join(tmpdir(), 'onereach-lite-test-crossstart-'));

  // Pre-seed: pretend we tried to install v999.999.999 last time.
  const fakeFailedVersion = '999.999.999';
  await writeUpdateState(userDataDir, {
    failedAttempts: 0,
    lastAttemptVersion: fakeFailedVersion,
    lastAttemptTime: new Date().toISOString(),
  });

  handle = await launchLite({ userDataDir });

  // Give verifyUpdateOnStartup time to run + write state. The dialog is
  // shown but isn't dismissed by us; verifyUpdateOnStartup writes state
  // BEFORE awaiting the dialog so the assertion still holds.
  await handle.mainWindow.waitForTimeout(500);

  const state = await readUpdateState(handle.userDataPath);
  expect(state.failedAttempts).toBe(1);
  expect(state.lastAttemptVersion).toBe(fakeFailedVersion);
});
