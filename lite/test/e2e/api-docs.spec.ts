/**
 * API Reference window E2E (ADR-035).
 *
 * Asserts:
 *   1. The API Reference button in Settings -> Developer opens a new window.
 *   2. The new window's title is "API Reference".
 *   3. The sidebar lists every documented module (kv, bug-report, auth,
 *      logging, neon, settings, totp).
 *   4. Clicking a sidebar tab renders that module's content.
 *   5. The filter input narrows the visible sidebar entries.
 *
 * Run with:  npm run lite:test:e2e
 * Prereqs:   `npm run lite:build` (or `npm run lite:package:mac`) so the
 *            built executable exists.
 */

import { test, expect, type Page } from '@playwright/test';
import { promises as fs } from 'node:fs';
import {
  launchLite,
  closeLite,
  defaultExecutablePath,
  clickMenuItem,
  type LiteHandle,
} from '../harness/index.js';

let handle: LiteHandle | null = null;

test.afterEach(async () => {
  await closeLite(handle);
  handle = null;
});

/**
 * Wait for a window whose URL ends with the given filename to attach.
 * The bug-report harness uses the same approach; abstracted here per
 * window pattern.
 */
async function waitForWindowMatching(
  app: LiteHandle['app'],
  match: (url: string) => boolean,
  timeoutMs = 8_000
): Promise<Page> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    for (const win of app.windows()) {
      if (match(win.url())) {
        await win.waitForLoadState('domcontentloaded');
        return win;
      }
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for window matching predicate`);
}

test('api-docs: Settings -> Developer button opens API Reference window with all modules', async ({}, testInfo) => {
  try {
    await fs.access(defaultExecutablePath());
  } catch {
    testInfo.skip(
      true,
      'No built lite executable -- run `npm run lite:package:mac` (or :win) first'
    );
    return;
  }

  handle = await launchLite();

  // Open Settings via the menu (matches existing harness conventions).
  await clickMenuItem(handle.app, 'Settings...');

  const settingsWindow = await waitForWindowMatching(
    handle.app,
    (url) => url.endsWith('settings.html'),
    8_000
  );

  // Click the Developer tab. The icon is decorative; the label is the click target.
  await settingsWindow.locator('.sidebar-tab', { hasText: 'Developer' }).click();

  // Click the "Open API Reference" button.
  const openBtn = settingsWindow.locator('button.btn-primary', {
    hasText: 'Open API Reference',
  });
  await expect(openBtn).toBeVisible({ timeout: 4_000 });
  await openBtn.click();

  // Wait for the API Reference window to attach.
  const docsWindow = await waitForWindowMatching(
    handle.app,
    (url) => url.endsWith('api-docs.html'),
    8_000
  );

  // Title is set in the BrowserWindow factory + the renderer.
  await expect(docsWindow.locator('.frame-header h1')).toHaveText('API Reference');

  // Sidebar lists every documented module.
  const sidebarLabels = await docsWindow.locator('.sidebar-tab span:first-child').allTextContents();
  const expected = ['Auth', 'Bug Report', 'KV', 'Logging', 'NEON', 'Settings', 'TOTP'];
  for (const label of expected) {
    expect(sidebarLabels, `expected sidebar to include ${label}`).toContain(label);
  }

  // First module activates by default; content header renders.
  await expect(docsWindow.locator('.module-title').first()).toBeVisible();

  // Clicking another module switches content.
  await docsWindow.locator('.sidebar-tab', { hasText: 'KV' }).click();
  await expect(docsWindow.locator('.module-title').first()).toHaveText('KV');
  await expect(docsWindow.locator('.module-slug').first()).toHaveText('lite/kv/');

  // Filter narrows the sidebar.
  await docsWindow.locator('#filter-input').fill('bug');
  const visibleAfterFilter = await docsWindow
    .locator('.sidebar-tab:not(.hidden) span:first-child')
    .allTextContents();
  expect(visibleAfterFilter).toContain('Bug Report');
  expect(visibleAfterFilter).not.toContain('TOTP');

  // Clearing the filter restores the full list.
  await docsWindow.locator('#filter-input').fill('');
  const visibleAfterClear = await docsWindow
    .locator('.sidebar-tab:not(.hidden) span:first-child')
    .allTextContents();
  expect(visibleAfterClear.length).toBe(expected.length);

  // README content renders (KV is selected, so we see its README section).
  await expect(docsWindow.locator('.readme-content').first()).toBeVisible();
});
