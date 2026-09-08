/**
 * GSX → Tickets, end to end (2026-09-06).
 *
 * The GSX menu's Tickets entry opens the account's own Agentic TMS app
 * (`TICKETS_APP_URL` in lite/gsx/menu-builder.ts) in the signed-in GSX
 * window. It used to point at `tickets.<env>.onereach.ai`, a host that
 * never existed, so every click failed to load. This proves two things
 * the unit tests cannot: that Tickets appears exactly once in the menu
 * bar (under GSX — nowhere else), and that a click really loads the app.
 * Needs the network: the window loads the real deployment.
 *
 * Runs against the packaged app like its siblings. Set
 * LITE_E2E_TARGET=bundle to drive the unpacked dev bundle instead
 * (node_modules Electron + dist-lite/build/main-lite.js).
 *
 * Run with:  npm run lite:test:e2e
 */

import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
// Per-file imports rather than the harness barrel: the barrel re-exports
// the vitest-bound conformance helpers, which Playwright can't load.
import {
  launchLite,
  closeLite,
  defaultExecutablePath,
  type LaunchOptions,
  type LiteHandle,
} from '../harness/launch.js';
import { getMenuStructure } from '../harness/menu.js';
import { LiteLogServerClient } from '../harness/log-server.js';

/**
 * The deployment the menu opens. Spelled out rather than imported: the
 * menu builder pulls in the auth module (and Electron) at load, which
 * Playwright's test process cannot host. The unit test pins the constant
 * itself; this spec pins the behaviour.
 */
const TICKETS_APP_URL =
  'https://files.edison.api.onereach.ai/public/' +
  '35254342-4a2e-475b-aec1-18547e517e29/agententic-tms/index.html';
const TICKETS_APP_ORIGIN = TICKETS_APP_URL.slice(0, TICKETS_APP_URL.lastIndexOf('/') + 1);
/** The deployed page's own <title> — proof the real app arrived. */
const PAGE_OWN_TITLE = 'IDW Agentic TMS';

const repoRoot = path.resolve(__dirname, '..', '..', '..');

let handle: LiteHandle | null = null;

test.afterEach(async () => {
  await closeLite(handle);
  handle = null;
});

type Target = Pick<LaunchOptions, 'executablePath' | 'additionalArgs'>;

/** Packaged app by default; LITE_E2E_TARGET=bundle drives the dev bundle. Skips when unbuilt. */
async function resolveTarget(testInfo: {
  skip: (cond: boolean, reason: string) => void;
}): Promise<Target | null> {
  if (process.env['LITE_E2E_TARGET'] === 'bundle') {
    const bundle = path.join(repoRoot, 'dist-lite', 'build', 'main-lite.js');
    try {
      await fs.access(bundle);
    } catch {
      testInfo.skip(true, 'No dev bundle -- run `npm run lite:build` first');
      return null;
    }
    // The electron package's export is the path of its binary.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electronBinary = require('electron') as string;
    return { executablePath: electronBinary, additionalArgs: [bundle] };
  }
  try {
    await fs.access(defaultExecutablePath());
  } catch {
    testInfo.skip(true, 'No built lite executable -- run `npm run lite:package:mac` (or :win) first');
    return null;
  }
  return {};
}

/** Click an item under one specific top-level menu, by label. */
async function clickMenuItemUnder(app: ElectronApplication, topLabel: string, label: string): Promise<void> {
  const found = await app.evaluate(({ Menu }, arg: { topLabel: string; label: string }) => {
    const menu = Menu.getApplicationMenu();
    const top = menu?.items.find((t) => t.label === arg.topLabel);
    const item = top?.submenu?.items.find((it) => it.label === arg.label);
    if (item === undefined) return false;
    item.click();
    return true;
  }, { topLabel, label });
  if (!found) throw new Error(`${topLabel} → ${label} not found in the live menu`);
}

/** Windows currently on the Tickets deployment. */
function ticketsWindows(app: ElectronApplication): Page[] {
  return app.windows().filter((w) => w.url().startsWith(TICKETS_APP_ORIGIN));
}

/** BrowserWindow titles as Electron holds them — the window's name, not document.title. */
function windowTitles(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.getTitle()));
}

test('gsx → tickets: Tickets is in the menu bar exactly once, under GSX', async ({}, testInfo) => {
  const target = await resolveTarget(testInfo);
  if (target === null) return;
  handle = await launchLite(target);

  const structure = await getMenuStructure(handle.app);
  const gsx = structure.find((t) => t.label === 'GSX');
  expect(gsx, 'GSX top-level menu').toBeDefined();
  // Signed out (test instances always are), Edison's links sit flat under GSX.
  expect(gsx?.items.map((it) => it.label)).toContain('Tickets');

  // Nowhere else — one Tickets entry in the whole menu bar.
  const carriers = structure.filter((t) => t.items.some((it) => it.label === 'Tickets')).map((t) => t.label);
  expect(carriers).toEqual(['GSX']);
  const planning = structure.find((t) => t.label === 'Planning');
  expect(planning?.items.map((it) => it.label) ?? []).not.toContain('Tickets');
});

test('gsx → tickets: a click loads the account’s Tickets app in the GSX window', async ({}, testInfo) => {
  const target = await resolveTarget(testInfo);
  if (target === null) return;
  handle = await launchLite(target);
  const { app } = handle;
  const client = new LiteLogServerClient(handle.logServerUrl);

  // Register the wait BEFORE the click so a fast open can't slip past it.
  const since = new Date().toISOString();
  const windowPromise = app.waitForEvent('window', { timeout: 15_000 });
  await clickMenuItemUnder(app, 'GSX', 'Tickets');
  const page = await windowPromise;

  // The deployment — over https, no platform host, no account parameter.
  await page.waitForURL((url) => url.href.startsWith(TICKETS_APP_ORIGIN), { timeout: 20_000, waitUntil: 'commit' });
  expect(page.url()).toBe(TICKETS_APP_URL);

  // The menu logged the link it opened.
  const opened = await client.waitForEvent('gsx.menu.open-link', { timeoutMs: 5_000, since });
  expect(opened.data.data).toMatchObject({ link: 'tickets' });

  // The real page arrives (network) — its own title is the app's...
  await page.waitForLoadState('domcontentloaded');
  await expect.poll(() => page.title(), { timeout: 20_000 }).toBe(PAGE_OWN_TITLE);
  // ...in a GSX window. GSX windows open named for the link ("Tickets —
  // Edison") and then follow the hosted page's own title, so either
  // name is the window we opened — and there is exactly one of it.
  const titles = await windowTitles(app);
  expect(titles.some((t) => t.startsWith('Tickets') || t === PAGE_OWN_TITLE)).toBe(true);
  expect(ticketsWindows(app)).toHaveLength(1);
});
