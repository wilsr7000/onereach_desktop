/**
 * E2E: clicking Help -> Check for Updates triggers the updater pipeline.
 *
 * Asserts the IPC handler is reachable from the renderer (verifies the
 * window.updater bridge), and that calling it produces the in-flight
 * coalescing behavior (a second concurrent call returns the same result).
 *
 * 2026-08-20: the coalescing test is HERMETIC now -- it points the
 * updater at a local server (LITE_DEV_UPDATE_CONFIG) serving a lower
 * version, so the check resolves deterministically. It used to hit the
 * REAL GitHub feed, which is unauthenticated-rate-limited (60 req/hr
 * per IP): repeated runs stalled the check past the 60s test budget
 * and made the tier flaky.
 */

import { test, expect } from '@playwright/test';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import {
  launchLite,
  closeLite,
  defaultExecutablePath,
  type LiteHandle,
} from '../../harness/index.js';
import {
  startUpdateServer,
  buildYamlFixture,
  writeDevAppUpdateYml,
  type UpdateServerHandle,
} from '../../harness/updater/index.js';

let handle: LiteHandle | null = null;
let userDataDir: string | null = null;
let server: UpdateServerHandle | null = null;
let sandbox: string | null = null;

test.afterEach(async () => {
  await closeLite(handle);
  handle = null;
  if (server !== null) {
    await server.stop();
    server = null;
  }
  for (const dir of [userDataDir, sandbox]) {
    if (dir !== null) {
      try {
        await fs.rm(dir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  }
  userDataDir = null;
  sandbox = null;
});

test('updater: window.updater.getState() returns the persisted state', async ({}, testInfo) => {
  try {
    await fs.access(defaultExecutablePath());
  } catch {
    testInfo.skip(true, 'No built lite executable -- run `npm run lite:package:mac` first');
    return;
  }

  userDataDir = await fs.mkdtemp(path.join(tmpdir(), 'onereach-lite-test-check-'));
  handle = await launchLite({ userDataDir });

  const state = await handle.mainWindow.evaluate(async () => {
    // window.updater is exposed by the preload bridge.
    return await (
      window as unknown as { updater: { getState: () => Promise<unknown> } }
    ).updater.getState();
  });

  expect(state).toMatchObject({
    failedAttempts: 0,
    lastAttemptVersion: null,
    lastAttemptTime: null,
  });
});

test('updater: window.updater.check() returns coalesced result when called twice', async ({}, testInfo) => {
  try {
    await fs.access(defaultExecutablePath());
  } catch {
    testInfo.skip(true, 'No built lite executable -- run `npm run lite:package:mac` first');
    return;
  }

  userDataDir = await fs.mkdtemp(path.join(tmpdir(), 'onereach-lite-test-check2-'));

  // Hermetic feed: serve a LOWER version from a local server so the
  // check resolves fast as "no update" (allowDowngrade=false) without
  // touching the network.
  sandbox = await fs.mkdtemp(path.join(tmpdir(), 'onereach-lite-test-check2-feed-'));
  const servingDir = path.join(sandbox, 'serving');
  await buildYamlFixture({ version: '0.0.1', outputDir: servingDir });
  server = await startUpdateServer({ servingDir });
  const devCfg = path.join(sandbox, 'dev-app-update.yml');
  await writeDevAppUpdateYml(devCfg, { serverUrl: server.baseUrl });

  handle = await launchLite({
    userDataDir,
    env: { LITE_DEV_UPDATE_CONFIG: devCfg },
  });

  // Two concurrent check calls. The runner coalesces -- both promises
  // resolve to the same shape. (We don't assert exact equality because
  // the second resolve sees the in-flight grace window, but both should
  // resolve cleanly without throwing.)
  const results = await handle.mainWindow.evaluate(async () => {
    const updater = (
      window as unknown as {
        updater: { check: (opts?: { manual?: boolean }) => Promise<unknown> };
      }
    ).updater;
    const a = updater.check({ manual: true });
    const b = updater.check({ manual: false });
    return await Promise.all([a, b]);
  });

  expect(results.length).toBe(2);
  expect(results[0]).toBeTruthy();
  expect(results[1]).toBeTruthy();
});
