#!/usr/bin/env node
/**
 * Live update flow test against the REAL GitHub releases API.
 *
 * Boots lite in dev mode with a dev-app-update.yml that points at the
 * github provider for wilsr7000/Onereach_Desktop_App on channel
 * the default `latest` channel. Triggers `window.updater.check({ manual: true })` and
 * captures every event the updater emits.
 *
 * Prereq: a release tagged `lite-v99.0.0` must exist on the repo with
 * latest-mac.yml as a release asset.
 *
 * In dev mode, app.getVersion() returns Electron's own version (41.2.1
 * at time of writing), which is < 99.0.0 -- so electron-updater treats
 * the GitHub release as an upgrade candidate and fires update-available.
 *
 * Run with:  node test-update-github.mjs
 */

import { _electron as electron } from 'playwright';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';

const REPO_OWNER = 'wilsr7000';
const REPO_NAME = 'Onereach_Lite_Desktop_App';

console.log('=== Lite update flow test against REAL GitHub ===');
console.log(`Repo:    ${REPO_OWNER}/${REPO_NAME}`);
console.log(`Channel: latest (default; lite has its own repo per ADR-027)`);
console.log('');

// ---------------------------------------------------------------------------
// Sandbox
// ---------------------------------------------------------------------------

const sandbox = await fs.mkdtemp(path.join(tmpdir(), 'lite-update-github-'));
const userDataDir = path.join(sandbox, 'userdata');
const devCfgPath = path.join(sandbox, 'dev-app-update.yml');
await fs.mkdir(userDataDir, { recursive: true });

// dev-app-update.yml -- electron-updater honors this when
// updateConfigPath is set + forceDevUpdateConfig is true (both wired
// up in lite/updater/init.ts when LITE_DEV_UPDATE_CONFIG is in env).
const devYml = [
  `provider: github`,
  `owner: ${REPO_OWNER}`,
  `repo: ${REPO_NAME}`,
  `releaseType: release`,
  '',
].join('\n');
await fs.writeFile(devCfgPath, devYml, 'utf-8');
console.log(`Sandbox:    ${sandbox}`);
console.log(`Dev config: ${devCfgPath}`);
console.log('');

// ---------------------------------------------------------------------------
// Boot lite
// ---------------------------------------------------------------------------

console.log('Booting lite...');
const env = { ...process.env, LITE_DEV_UPDATE_CONFIG: devCfgPath };
delete env.ELECTRON_RUN_AS_NODE;

const app = await electron.launch({
  args: ['dist-lite/build/main-lite.js', `--user-data-dir=${userDataDir}`],
  env,
});
const mainWindow = await app.firstWindow();
await mainWindow.waitForLoadState('domcontentloaded');

const runningVersion = await app.evaluate(({ app: a }) => a.getVersion());
console.log(`Lite booted -- running version: ${runningVersion} (Electron's own in dev mode)`);
console.log('');

// Give the updater a moment to initialize
await new Promise((r) => setTimeout(r, 1000));

// ---------------------------------------------------------------------------
// Trigger check + capture events
// ---------------------------------------------------------------------------

console.log('Triggering window.updater.check({ manual: true })...');
console.log('  (this hits api.github.com -- expect a few seconds)');
console.log('');

const statusEvents = await mainWindow.evaluate(() => {
  return new Promise((resolve) => {
    const events = [];
    const off = window.updater.onStatus((event) => {
      events.push(event);
      if (
        event.status === 'available' ||
        event.status === 'not-available' ||
        event.status === 'error' ||
        event.status === 'downloaded'
      ) {
        setTimeout(() => {
          off();
          resolve(events);
        }, 200);
      }
    });
    void window.updater.check({ manual: true });
    setTimeout(() => {
      off();
      resolve(events);
    }, 30000);
  });
});

console.log('=== Updater status events captured ===');
for (const event of statusEvents) {
  const infoStr = event.info ? ' ' + JSON.stringify(event.info).slice(0, 180) : '';
  console.log(`  ${event.status}${infoStr}`);
}
console.log('');

// ---------------------------------------------------------------------------
// Pull updater logs from lite's log server
// ---------------------------------------------------------------------------

const logsRes = await fetch('http://127.0.0.1:47392/logs?category=updater&limit=50');
const logsJson = await logsRes.json();
const updaterLogs = logsJson.logs ?? logsJson.data ?? [];
console.log('=== Updater logs from lite log server ===');
for (const entry of updaterLogs) {
  const dataStr =
    entry.data && Object.keys(entry.data).length > 0
      ? ' ' + JSON.stringify(entry.data).slice(0, 100)
      : '';
  console.log(`  ${entry.level} ${entry.message}${dataStr}`);
}
console.log('');

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

const sawChecking = statusEvents.some((e) => e.status === 'checking');
const sawAvailable = statusEvents.some((e) => e.status === 'available');
const sawError = statusEvents.some((e) => e.status === 'error');
const availableInfo = statusEvents.find((e) => e.status === 'available');

console.log('=== RESULTS ===');
console.log(`  ${sawChecking ? '[PASS]' : '[FAIL]'} Updater emitted "checking" status`);
console.log(
  `  ${sawAvailable ? '[PASS]' : sawError ? '[FAIL]' : '[INFO]'} Updater detected update from GitHub`
);
if (sawAvailable) {
  console.log(`         version: ${availableInfo?.info?.version}`);
  console.log(
    `         files: ${(availableInfo?.info?.files || []).map((f) => f.url).join(', ').slice(0, 200)}`
  );
}
if (sawError) {
  const errEv = statusEvents.find((e) => e.status === 'error');
  console.log(`         (error info: ${JSON.stringify(errEv?.info).slice(0, 300)})`);
}

// Cleanup
await app.close();
await fs.rm(sandbox, { recursive: true, force: true });

const allPassed = sawChecking && sawAvailable;
console.log('');
console.log(allPassed ? 'OVERALL: PASS -- lite can pull updates from GitHub' : 'OVERALL: FAIL');
process.exit(allPassed ? 0 : 1);
