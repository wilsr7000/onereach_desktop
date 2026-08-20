/**
 * Phase 0a kernel smoke test -- the falsifiable exit gate per the plan.
 *
 * Launches the BUILT lite installer (dist-lite/Onereach.ai Lite.app on
 * macOS, dist-lite/Onereach.ai Lite.exe / unpacked dir on Windows) and
 * asserts:
 *
 *   1. Single window opens with placeholder content
 *   2. App menu contains About + Quit (modules add entries between)
 *   3. Help menu contains Report a Bug
 *   4. Every visible top-level has at least one item (registry hides
 *      empty placeholders); no accelerators/roles outside Edit
 *   5. About is reachable via the menu role
 *
 * 2026-08-07: rewritten from an exact 2-menu census to INVARIANTS.
 * The kernel-era census rotted the moment modules started registering
 * top-levels (IDW/Tools/Spaces/University/Planning/Help ≈ 8 today) —
 * asserting a count repeats that mistake on every module launch.
 *   6. Bug-report flow: the seeded sk-... key is REDACTED in the live
 *      payload preview; save() hard-fails signed out (KV-only store,
 *      test instances have no session) and writes NOTHING locally
 *   7. macOS: codesign --verify --deep --strict passes on the .app
 *
 * 2026-08-20: item 6 re-pointed from the OLD local-file store
 * (userData/lite-bugs/) to the KV-only store's signed-out contract.
 * PRODUCT NOTE: signed-out/offline users currently cannot file bug
 * reports at all -- if a local spool lands (pending decision), point
 * this spec at the spool instead.
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

  // Menu invariants (ADR-016/-017), NOT a census — modules register
  // their own top-levels, so a hardcoded count rots on every launch.
  const structure = await getMenuStructure(handle.app);
  expect(structure.length).toBeGreaterThanOrEqual(2);

  // App menu is first and carries About (first) + Quit (last).
  const appLabels = (structure[0]?.items ?? []).map((it) => it.label);
  // WISER is the DISPLAY name (2026-08-15 rebrand, display-only); the
  // bundle identity stays 'Onereach.ai Lite'. This assertion sat broken
  // for five days because no gate runs the e2e tier.
  expect(appLabels[0]).toBe('About WISER');
  expect(appLabels[appLabels.length - 1]).toBe('Quit WISER');

  // Help is present, is a plain labeled top-level (ADR-017: never
  // role:'help', which injects "Send Feedback to Apple…"), and carries
  // the bug reporter.
  const help = structure.find((t) => t.label === 'Help');
  expect(help).toBeDefined();
  expect(help?.role).toBeNull();
  expect(help?.items.map((it) => it.label)).toContain('Report a Bug...');

  // Registry contract: an empty top-level must never render.
  for (const top of structure) {
    expect(top.items.length, `top-level "${top.label}" rendered empty`).toBeGreaterThan(0);
  }

  // ADR-015: no accelerators or item roles anywhere EXCEPT the Edit
  // menu, whose items are role-based by design (copy/paste/undo).
  for (const top of structure) {
    if (top.label === 'Edit') continue;
    for (const item of top.items) {
      expect(item.accelerator, `${top.label} → ${item.label}`).toBeNull();
      expect(item.role, `${top.label} → ${item.label}`).toBeNull();
    }
  }
});

test('kernel: bug-report redacts the live preview; save hard-fails signed out with no local spool', async ({}, testInfo) => {
  // 2026-08-20: the store is KV-only (lite/bug-report/store.ts) and
  // test instances run signed out (fresh userData, LITE_NO_KEYCHAIN=1),
  // so save() MUST reject with the signed-out error and nothing may be
  // written locally. Redaction is still asserted end-to-end via the
  // modal's live payload preview (capture runs before save).
  // If a signed-out local spool ships, re-point this spec at the spool.
  try {
    await fs.access(defaultExecutablePath());
  } catch {
    testInfo.skip(true, 'No built lite executable -- run `npm run lite:package:mac` (or :win) first');
    return;
  }

  handle = await launchLite();
  const client = new LiteLogServerClient(handle.logServerUrl);

  // Trigger via menu click. Report a Bug lives in the Help menu (ADR-016);
  // no accelerator is bound (ADR-015) so menu click is the only path.
  await clickMenuItem(handle.app, 'Report a Bug...');

  const modalWindow = await waitForBugReportModal(handle.app, { timeoutMs: 5_000 });
  await modalWindow.waitForLoadState('domcontentloaded');

  // Fill description with a SECRET. The modal debounces (200ms) a
  // capture IPC that renders the redacted payload preview.
  const seededDescription = 'Test bug -- my OPENAI key sk-ABCDEFGHIJKLMNOPQRSTUVWX leaked here';
  await modalWindow.fill('#description', seededDescription);

  // Redaction contract, previously asserted on the saved file: the
  // preview payload masks the key and never shows the raw secret.
  const preview = modalWindow.locator('#payload-preview');
  await expect(preview).toContainText('[REDACTED:OPENAI_KEY]', { timeout: 5_000 });
  await expect(preview).not.toContainText('sk-ABCDEFGHIJKLMNOPQRSTUVWX');

  // Submit. Signed out, the KV-only store rejects; the modal surfaces
  // the failure inline instead of pretending the report was filed.
  const beforeSubmit = new Date().toISOString();
  await modalWindow.click('#send');

  const result = modalWindow.locator('#result');
  await expect(result).toContainText(/signed out/i, { timeout: 5_000 });
  await expect(result).toHaveClass(/error/);

  // The rejection is observable on the central queue (ADR-025/-026):
  // the save span fails rather than silently vanishing.
  const failEvent = await client.waitForEvent('bug-report.save.fail', {
    timeoutMs: 5_000,
    since: beforeSubmit,
  });
  expect(failEvent.data.eventName).toBe('bug-report.save.fail');

  // KV-only store: NOTHING may land in the old local-file location.
  const localFiles = await readBugReports(handle.userDataPath);
  expect(localFiles).toEqual([]);
});

test('kernel: events flow through the central queue end-to-end (ADR-025)', async ({}, testInfo) => {
  // Coverage: prove that
  //   (a) the harness can ADD events to the live event log via pushEvent()
  //   (b) the harness can READ events back via waitForEvent() / getEvents()
  //   (c) the bug-report module migration routes its logs through the
  //       central queue (visible at /logs?category=bug-report), including
  //       the signed-out save FAILURE span -- test instances have no
  //       session, so the KV write never happens and category=kv stays
  //       silent (those assertions left with the file store, 2026-08-20)
  //   (d) signed out, nothing is persisted to the old local file store.
  try {
    await fs.access(defaultExecutablePath());
  } catch {
    testInfo.skip(true, 'No built lite executable -- run `npm run lite:package:mac` (or :win) first');
    return;
  }

  handle = await launchLite();
  const client = new LiteLogServerClient(handle.logServerUrl);

  // (a) + (b): push a synthetic event, verify the harness can read it back.
  // This is the load-bearing assertion that the harness's add/read API
  // works against the LIVE log server -- not just the in-memory test
  // server. The runId disambiguates if the same test reruns rapidly.
  //
  // `since` is captured BEFORE the push: waitForEvent's default lower
  // bound is its own call time, which is AFTER the push landed -- the
  // server-side since filter then excludes the event forever and the
  // wait times out (the 2026-08-20 failure mode of this very spec).
  const beforePush = new Date().toISOString();
  const runId = `e2e-${Date.now()}`;
  await client.pushEvent('test.kernel.smoke', { runId });
  const echoedEvent = await client.waitForEvent('test.kernel.smoke', {
    timeoutMs: 3_000,
    since: beforePush,
    predicate: (ev) =>
      typeof ev.data.data === 'object' &&
      ev.data.data !== null &&
      (ev.data.data as Record<string, unknown>)['runId'] === runId,
  });
  expect(echoedEvent.data.eventName).toBe('test.kernel.smoke');

  // File a bug -- this triggers the bug-report module code paths that,
  // post ADR-025 migration, log through getLoggingApi() and end up
  // visible at /logs. Test instances run SIGNED OUT (KV-only store), so
  // the save rejects -- what this section proves is that the attempt
  // and its failure flow through the central queue, not that a report
  // lands. (KV set/`recentLogs` assertions from the file-store era are
  // unreachable signed out; if a local spool ships, restore them.)
  const beforeSubmit = new Date().toISOString();
  await clickMenuItem(handle.app, 'Report a Bug...');
  const modalWindow = await waitForBugReportModal(handle.app, { timeoutMs: 5_000 });
  await modalWindow.waitForLoadState('domcontentloaded');
  await modalWindow.fill(
    '#description',
    'Event-flow smoke test -- verifies log queue migration'
  );
  await modalWindow.click('#send');

  // (c): the save attempt's failure span reaches the queue -- the
  // signed-out rejection is observable, not swallowed.
  const saveFail = await client.waitForEvent('bug-report.save.fail', {
    timeoutMs: 5_000,
    since: beforeSubmit,
  });
  expect(saveFail.data.eventName).toBe('bug-report.save.fail');

  // (c) continued: bug-report log lines appear under category=bug-report.
  // Pre-ADR-025 these went to console.log and were invisible at the log
  // server. The ipc.save instant event + the save span both qualify.
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

  // (d): KV-only store + signed out means NO report may be persisted
  // locally -- the old file store must stay gone.
  const localFiles = await readBugReports(handle.userDataPath);
  expect(localFiles).toEqual([]);
});
