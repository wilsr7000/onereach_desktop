/**
 * Bug-report E2E helper layer.
 *
 * Module-specific scenarios layered on top of the general harness
 * (`launchLite`, `clickMenuItem`, `waitForBugReportModal`, etc.).
 *
 * Pattern: every module that ships UI gets a `lite/test/harness/<module>/`
 * folder with composed scenarios. New port specs reach for these
 * helpers first; the general harness only when the module-specific
 * helper doesn't exist.
 *
 * See `lite/test/harness/updater/` for another example of a layered
 * scenario folder.
 */

import type { Page } from '@playwright/test';
import type { ElectronApplication } from '@playwright/test';
import { clickMenuItem } from '../menu.js';
import { waitForBugReportModal } from '../windows.js';

export interface FillAndSubmitOptions {
  /** Custom timeout to wait for the modal to appear (ms). Default 5000. */
  modalTimeoutMs?: number;
  /** Description text to type into the modal. */
  description: string;
  /**
   * Optional sleep after submit, to give the file/KV write time to
   * complete before assertions run. Default 500ms.
   */
  postSubmitSleepMs?: number;
}

export interface FillAndSubmitResult {
  /** Handle to the modal window. Useful for further assertions. */
  modal: Page;
}

/**
 * Open the bug-report modal via menu click, fill the description, and
 * submit. Mirrors the user flow.
 *
 * @example
 * ```typescript
 * const { modal } = await openAndFileBugReport(handle.app, {
 *   description: 'app crashed on save',
 * });
 * await modal.waitForLoadState('domcontentloaded');
 * ```
 */
export async function openAndFileBugReport(
  app: ElectronApplication,
  opts: FillAndSubmitOptions
): Promise<FillAndSubmitResult> {
  await clickMenuItem(app, 'Report a Bug...');
  const modal = await waitForBugReportModal(app, {
    timeoutMs: opts.modalTimeoutMs ?? 5_000,
  });
  await modal.waitForLoadState('domcontentloaded');
  await modal.fill('#description', opts.description);
  await modal.click('#send');
  await modal.waitForTimeout(opts.postSubmitSleepMs ?? 500);
  return { modal };
}
