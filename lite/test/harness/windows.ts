/**
 * Onereach Lite Test Harness -- Window discovery + waiting.
 *
 * Wraps Playwright's app.windows() / app.waitForEvent('window') to locate
 * specific windows by URL, basename, or title. Lite kernel has at most
 * three concurrent windows: placeholder, bug-report modal, optional about.
 */

import type { ElectronApplication, Page } from '@playwright/test';

const DEFAULT_WAIT_TIMEOUT_MS = 5_000;

export interface WaitForWindowOptions {
  /** Max wait time in ms. Default 5000. */
  timeoutMs?: number;
}

/**
 * Wait for a new window matching the predicate. The predicate is evaluated
 * against the current window list first (so already-open windows are
 * matched immediately) before waiting for a new `window` event.
 */
export async function waitForWindow(
  app: ElectronApplication,
  predicate: (page: Page) => boolean,
  opts: WaitForWindowOptions = {}
): Promise<Page> {
  const existing = app.windows().find(predicate);
  if (existing !== undefined) return existing;
  return app.waitForEvent('window', {
    predicate,
    timeout: opts.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS,
  });
}

/**
 * Wait for a window whose URL ends with the given basename (e.g. 'modal.html'
 * or 'about.html'). Convenience over waitForWindow for the common case.
 */
export async function waitForWindowByUrl(
  app: ElectronApplication,
  basename: string,
  opts: WaitForWindowOptions = {}
): Promise<Page> {
  return waitForWindow(app, (w) => w.url().endsWith(basename), opts);
}

/**
 * Find an already-open window whose URL ends with the given basename.
 * Returns null if not found (does NOT wait).
 */
export function findWindowByUrl(app: ElectronApplication, basename: string): Page | null {
  return app.windows().find((w) => w.url().endsWith(basename)) ?? null;
}

/**
 * Wait for the bug-report modal window. Convenience for the most common
 * test case in the kernel.
 */
export function waitForBugReportModal(
  app: ElectronApplication,
  opts: WaitForWindowOptions = {}
): Promise<Page> {
  return waitForWindowByUrl(app, 'modal.html', opts);
}

/**
 * Wait for the about window (Windows + Linux only -- macOS uses the
 * native panel which doesn't show as a BrowserWindow).
 */
export function waitForAboutWindow(
  app: ElectronApplication,
  opts: WaitForWindowOptions = {}
): Promise<Page> {
  return waitForWindowByUrl(app, 'about.html', opts);
}

/**
 * Snapshot the current window list -- url + title for each. Useful for
 * asserting "exactly N windows are open" or similar.
 */
export async function getWindowSnapshot(
  app: ElectronApplication
): Promise<Array<{ url: string; title: string }>> {
  const wins = app.windows();
  const out: Array<{ url: string; title: string }> = [];
  for (const w of wins) {
    let title = '';
    try {
      title = await w.title();
    } catch {
      /* page might be closing */
    }
    out.push({ url: w.url(), title });
  }
  return out;
}
