/**
 * E2E: the updater port adds a `Help -> Check for Updates...` menu entry.
 *
 * Verifies the menu structure of the BUILT lite app contains the
 * Check for Updates item with the expected properties. No update server
 * involvement -- this is purely a menu-presence assertion.
 */

import { test, expect } from '@playwright/test';
import { promises as fs } from 'node:fs';
import {
  launchLite,
  closeLite,
  defaultExecutablePath,
  getMenuStructure,
  type LiteHandle,
} from '../../harness/index.js';

let handle: LiteHandle | null = null;

test.afterEach(async () => {
  await closeLite(handle);
  handle = null;
});

test('updater: Help menu contains Check for Updates... after Report a Bug...', async ({}, testInfo) => {
  try {
    await fs.access(defaultExecutablePath());
  } catch {
    testInfo.skip(true, 'No built lite executable -- run `npm run lite:package:mac` first');
    return;
  }

  handle = await launchLite();
  const structure = await getMenuStructure(handle.app);

  const help = structure.find((t) => t.label === 'Help');
  expect(help).toBeDefined();
  const labels = (help?.items ?? []).map((it) => it.label);
  expect(labels).toContain('Check for Updates...');
  expect(labels).toContain('Report a Bug...');

  // Per ADR-015 -- no accelerator, no role
  const checkItem = help?.items.find((it) => it.label === 'Check for Updates...');
  expect(checkItem?.accelerator).toBeNull();
  expect(checkItem?.role).toBeNull();
});
