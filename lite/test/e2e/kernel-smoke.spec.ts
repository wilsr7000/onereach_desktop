/**
 * Phase 0a kernel smoke test -- the falsifiable exit gate per the plan.
 *
 * Launches the BUILT lite installer (dist-lite/Onereach.ai Lite.app on
 * macOS, dist-lite/Onereach.ai Lite.exe / unpacked dir on Windows) and
 * asserts:
 *
 *   1. Single window opens with placeholder content
 *   2. App menu shows About + Quit (and only those two items)
 *   3. Help menu shows Report a Bug (and only that one item)
 *   4. No other top-level menus are visible
 *   5. About is reachable via the menu role
 *   6. Bug-report flow writes a JSON file to userData/lite-bugs/
 *   7. The seeded sk-... key in the description is REDACTED in the file
 *   8. macOS: codesign --verify --deep --strict passes on the .app
 *
 * Refactored onto the lite test harness (lite/test/harness/) per ADR-023.
 *
 * Run with:  npm run lite:test:e2e
 * Prerequisites:  npm run lite:package:mac (or :win) must have produced
 *                 a build under dist-lite/.
 */

import { test, expect } from '@playwright/test';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import {
  launchLite,
  closeLite,
  defaultExecutablePath,
  getMenuStructure,
  clickMenuItem,
  waitForBugReportModal,
  readBugReports,
  LiteLogServerClient,
  LITE_LOG_SERVER,
  type LiteHandle,
} from '../harness/index.js';

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const distLite = path.join(repoRoot, 'dist-lite');

let handle: LiteHandle | null = null;

test.afterEach(async () => {
  await closeLite(handle);
  handle = null;
});

test('kernel: code signing on macOS passes codesign --verify --deep --strict', async ({}, testInfo) => {
  test.skip(process.platform !== 'darwin', 'codesign is macOS-only');

  const appBundle = path.join(distLite, 'mac-arm64', 'Onereach.ai Lite.app');
  try {
    await fs.access(appBundle);
  } catch {
    testInfo.skip(true, 'No built .app -- run `npm run lite:package:mac` first');
    return;
  }

  expect(() => {
    execFileSync('codesign', ['--verify', '--deep', '--strict', appBundle], { stdio: 'pipe' });
  }).not.toThrow();
});

test('kernel: launches with single window and exact menu structure', async ({}, testInfo) => {
  try {
    await fs.access(defaultExecutablePath());
  } catch {
    testInfo.skip(true, 'No built lite executable -- run `npm run lite:package:mac` (or :win) first');
    return;
  }

  handle = await launchLite();
  expect(handle.mainWindow).toBeTruthy();

  // Window count -- kernel is single window
  expect(handle.app.windows().length).toBe(1);

  // Menu structure (per ADR-016): two top-levels -- Onereach.ai Lite (app
  // menu) and Help. Per ADR-017, Help does NOT use role:'help' (which
  // would cause macOS to inject "Send Feedback to Apple..." for
  // beta/developer users). It's a plain labeled top-level instead.
  const structure = await getMenuStructure(handle.app);
  expect(structure.length).toBe(2);
  expect(structure[1]?.label).toBe('Help');
  expect(structure[1]?.role).toBeNull();

  // App menu: exactly About, Quit (in that order).
  const appLabels = (structure[0]?.items ?? []).map((it) => it.label);
  expect(appLabels).toEqual(['About Onereach.ai Lite', 'Quit Onereach.ai Lite']);

  // Help menu: exactly Report a Bug...
  const helpLabels = (structure[1]?.items ?? []).map((it) => it.label);
  expect(helpLabels).toEqual(['Report a Bug...']);

  // Per ADR-015, no accelerator or item-level role on any kernel item.
  const allItems = [...(structure[0]?.items ?? []), ...(structure[1]?.items ?? [])];
  for (const item of allItems) {
    expect(item.accelerator).toBeNull();
    expect(item.role).toBeNull();
  }
});

test('kernel: bug-report flow writes redacted JSON to userData/lite-bugs/', async ({}, testInfo) => {
  try {
    await fs.access(defaultExecutablePath());
  } catch {
    testInfo.skip(true, 'No built lite executable -- run `npm run lite:package:mac` (or :win) first');
    return;
  }

  handle = await launchLite();

  const before = (await readBugReports(handle.userDataPath)).map((r) => r.filePath);

  // Trigger via menu click. Report a Bug lives in the Help menu (ADR-016);
  // no accelerator is bound (ADR-015) so menu click is the only path.
  await clickMenuItem(handle.app, 'Report a Bug...');

  const modalWindow = await waitForBugReportModal(handle.app, { timeoutMs: 5_000 });
  await modalWindow.waitForLoadState('domcontentloaded');

  // Fill description with a SECRET that should be redacted, then submit.
  const seededDescription = 'Test bug -- my OPENAI key sk-ABCDEFGHIJKLMNOPQRSTUVWX leaked here';
  await modalWindow.fill('#description', seededDescription);
  await modalWindow.click('#send');

  // Wait for the file write to land.
  await modalWindow.waitForTimeout(500);

  const after = await readBugReports(handle.userDataPath);
  const newReports = after.filter((r) => !before.includes(r.filePath));
  expect(newReports.length).toBe(1);

  const payload = newReports[0]!.payload as {
    appTag: string;
    source: string;
    version: string;
    description: string;
    os: { platform: string };
    redactionTelemetry: { bucket: string; countsByKind: Record<string, number> };
  };
  expect(payload.appTag).toBe('lite');
  expect(payload.source).toBe('user-bug-report');
  expect(payload.version).toBeTruthy();
  expect(payload.os.platform).toBe(process.platform);
  expect(payload.description).not.toContain('sk-ABCDEFGHIJKLMNOPQRSTUVWX');
  expect(payload.description).toContain('[REDACTED:OPENAI_KEY]');
  expect(payload.redactionTelemetry.countsByKind.OPENAI_KEY).toBeGreaterThanOrEqual(1);
  expect(payload.redactionTelemetry.bucket).not.toBe('none');
});

test('kernel: events flow through the central queue end-to-end (ADR-025)', async ({}, testInfo) => {
  // Coverage: prove that
  //   (a) the harness can ADD events to the live event log via pushEvent()
  //   (b) the harness can READ events back via waitForEvent() / getEvents()
  //   (c) the bug-report and kv module migrations route their logs through
  //       the central queue (visible at /logs?category=bug-report and
  //       /logs?category=kv)
  //   (d) the queue-mirror means saved bug reports' `recentLogs` field
  //       captures the log lines automatically -- the "streams payoff" of
  //       ADR-025 / the centralized event logger.
  try {
    await fs.access(defaultExecutablePath());
  } catch {
    testInfo.skip(true, 'No built lite executable -- run `npm run lite:package:mac` (or :win) first');
    return;
  }

  handle = await launchLite();
  const client = new LiteLogServerClient(LITE_LOG_SERVER);

  // (a) + (b): push a synthetic event, verify the harness can read it back.
  // This is the load-bearing assertion that the harness's add/read API
  // works against the LIVE log server -- not just the in-memory test
  // server. The runId disambiguates if the same test reruns rapidly.
  const runId = `e2e-${Date.now()}`;
  await client.pushEvent('test.kernel.smoke', { runId });
  const echoedEvent = await client.waitForEvent('test.kernel.smoke', {
    timeoutMs: 3_000,
    predicate: (ev) =>
      typeof ev.data.data === 'object' &&
      ev.data.data !== null &&
      (ev.data.data as Record<string, unknown>)['runId'] === runId,
  });
  expect(echoedEvent.data.eventName).toBe('test.kernel.smoke');

  // File a bug -- this triggers the bug-report and kv module code paths
  // that, post ADR-025 migration, log through getLoggingApi() and end up
  // visible at /logs.
  const before = (await readBugReports(handle.userDataPath)).map((r) => r.filePath);
  await clickMenuItem(handle.app, 'Report a Bug...');
  const modalWindow = await waitForBugReportModal(handle.app, { timeoutMs: 5_000 });
  await modalWindow.waitForLoadState('domcontentloaded');
  await modalWindow.fill(
    '#description',
    'Event-flow smoke test -- verifies log queue migration'
  );
  await modalWindow.click('#send');
  await modalWindow.waitForTimeout(750);

  // (c): bug-report log lines appear under category=bug-report. Pre-ADR-025
  // these went to console.log and were invisible at the log server.
  const bugReportLogs = await client.queryLogs({ category: 'bug-report', limit: 100 });
  expect(
    bugReportLogs.length,
    'expected at least one bug-report category log after filing a bug'
  ).toBeGreaterThan(0);
  expect(
    bugReportLogs.some((entry) => /save/.test(entry.message)),
    'expected a save-related log line; got: ' +
      bugReportLogs.map((e) => e.message).join(', ')
  ).toBe(true);

  // (c) continued: kv log lines appear under category=kv (set during save).
  const kvLogs = await client.queryLogs({ category: 'kv', limit: 100 });
  expect(
    kvLogs.length,
    'expected at least one kv category log after filing a bug'
  ).toBeGreaterThan(0);
  expect(
    kvLogs.some((entry) => /set ok/.test(entry.message) || /set/.test(entry.message)),
    'expected a kv set log line; got: ' + kvLogs.map((e) => e.message).join(', ')
  ).toBe(true);

  // (d): the saved bug report's `recentLogs` field captures the queue
  // mirror. With the migration in place, recentLogs should now include
  // the bug-report and kv log lines that were emitted DURING this save.
  // Pre-ADR-025 the recentLogs only contained app/updater entries.
  const after = await readBugReports(handle.userDataPath);
  const newReports = after.filter((r) => !before.includes(r.filePath));
  expect(newReports.length).toBe(1);
  const recentLogs = (newReports[0]!.payload as { recentLogs?: string }).recentLogs ?? '';
  expect(recentLogs.length).toBeGreaterThan(0);

  // The pushed test event arrived on the queue BEFORE save, so it should
  // appear in this bug report's recentLogs window -- proves the queue
  // mirror works for harness-injected events too.
  expect(
    /test\.kernel\.smoke/.test(recentLogs),
    'expected the harness-pushed event to appear in recentLogs'
  ).toBe(true);
});
