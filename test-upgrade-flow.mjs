#!/usr/bin/env node
/**
 * Full upgrade-path test: lite-v0.0.1 -> lite-v0.0.2 via real GitHub.
 *
 * Phases:
 *   `install`   -- mount DMG, copy to /Applications, strip quarantine
 *   `verify`    -- launch the installed v0.0.1, confirm it boots cleanly
 *   `upgrade`   -- launch v0.0.1, monkey-patch dialogs, trigger check, wait
 *                   for downloaded, trigger install, wait for Squirrel swap,
 *                   re-launch, assert app.getVersion() === '0.0.2'
 *   `cleanup`   -- (optional) remove /Applications/Onereach.ai Lite.app
 *
 * Run: node test-upgrade-flow.mjs <phase>
 *
 * Default if no phase given: install + verify (skips upgrade so you can
 * publish v0.0.2 first).
 */

import { _electron as electron } from 'playwright';
import { execSync, spawnSync } from 'node:child_process';
import { promises as fs, existsSync } from 'node:fs';
import * as path from 'node:path';

const PRODUCT_NAME = 'Onereach.ai Lite';
const APP_NAME = `${PRODUCT_NAME}.app`;
const APP_PATH = `/Applications/${APP_NAME}`;
const APP_EXE = `${APP_PATH}/Contents/MacOS/${PRODUCT_NAME}`;
const USER_DATA = path.join(
  process.env.HOME,
  'Library',
  'Application Support',
  PRODUCT_NAME
);
const LOG_PORT = 47392;

const DMG_V001 = `dist-lite/${PRODUCT_NAME}-0.0.1-arm64.dmg`;

const phase = process.argv[2] || 'install-verify';

function log(...args) {
  console.log('[test-upgrade]', ...args);
}

function sh(cmd, opts = {}) {
  log('$', cmd);
  return execSync(cmd, { stdio: 'inherit', ...opts });
}

function shCapture(cmd) {
  return execSync(cmd, { encoding: 'utf-8' }).trim();
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Phase: install
// ---------------------------------------------------------------------------

async function phaseInstall() {
  log('=== Phase: install ===');

  if (!existsSync(DMG_V001)) {
    throw new Error(`DMG not found at ${DMG_V001}. Build with: bash lite/scripts/release-lite.sh 0.0.1`);
  }

  // If a previous install exists, remove it
  if (existsSync(APP_PATH)) {
    log(`Removing existing ${APP_PATH}`);
    sh(`rm -rf "${APP_PATH}"`);
  }

  // Also clear userData so we get a clean install state for the test
  if (existsSync(USER_DATA)) {
    log(`Removing existing userData at ${USER_DATA}`);
    sh(`rm -rf "${USER_DATA}"`);
  }

  // Detach any leftover mounts of the same volume (idempotent)
  try {
    const mounts = shCapture(`hdiutil info | grep -E "/Volumes/Onereach" | awk '{print $1}'`);
    if (mounts) {
      for (const dev of mounts.split('\n')) {
        log(`Detaching leftover mount ${dev}`);
        try { sh(`hdiutil detach "${dev}" -quiet -force`); } catch {}
      }
    }
  } catch {
    /* no leftover mounts */
  }

  log(`Mounting ${DMG_V001}`);
  // Capture hdiutil's plist output to robustly find the mount point even
  // when the volume name contains spaces. -plist gives us a structured
  // response we can parse with PlistBuddy.
  const attachOut = shCapture(
    `hdiutil attach "${DMG_V001}" -nobrowse -noverify -noautoopen -plist`
  );
  // Write to a temp file so PlistBuddy can read it (PlistBuddy needs a file)
  const tmpPlist = `/tmp/lite-attach-${Date.now()}.plist`;
  await fs.writeFile(tmpPlist, attachOut, 'utf-8');
  // Find the entry that has a mount-point. Loop through system-entities.
  let mountPoint = '';
  for (let i = 0; i < 10; i++) {
    try {
      const mp = shCapture(
        `/usr/libexec/PlistBuddy -c "Print :system-entities:${i}:mount-point" "${tmpPlist}" 2>/dev/null`
      );
      if (mp && mp.startsWith('/Volumes/')) {
        mountPoint = mp;
        break;
      }
    } catch {
      /* not this index */
    }
  }
  await fs.unlink(tmpPlist).catch(() => {});
  if (!mountPoint) throw new Error('Could not find DMG mount point in plist output');
  log(`Mounted at: ${mountPoint}`);

  log(`Copying ${APP_NAME} to /Applications/`);
  sh(`cp -R "${mountPoint}/${APP_NAME}" /Applications/`);

  log('Detaching DMG');
  sh(`hdiutil detach "${mountPoint}" -quiet`);

  log('Stripping quarantine xattr (Gatekeeper bypass)');
  sh(`xattr -dr com.apple.quarantine "${APP_PATH}"`);

  log(`Installed: ${APP_PATH}`);

  // Verify the install
  if (!existsSync(APP_EXE)) {
    throw new Error(`Install failed: ${APP_EXE} not found`);
  }
  const stat = await fs.stat(APP_EXE);
  log(`Executable size: ${stat.size} bytes (mode ${stat.mode.toString(8)})`);
}

// ---------------------------------------------------------------------------
// Phase: verify -- launch the installed v0.0.1, confirm it boots
// ---------------------------------------------------------------------------

async function phaseVerify() {
  log('=== Phase: verify ===');

  if (!existsSync(APP_EXE)) {
    throw new Error(`No installed app at ${APP_EXE}. Run install phase first.`);
  }

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;

  log(`Launching ${APP_EXE} via Playwright`);
  const app = await electron.launch({ executablePath: APP_EXE, env });
  const window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');

  const version = await app.evaluate(({ app: a }) => a.getVersion());
  const productName = await app.evaluate(({ app: a }) => a.getName());
  const userDataPath = await app.evaluate(({ app: a }) => a.getPath('userData'));

  log(`  app.getVersion()        : ${version}`);
  log(`  app.getName()           : ${productName}`);
  log(`  app.getPath('userData') : ${userDataPath}`);

  // Confirm the log server is up
  await sleep(1500);
  try {
    const healthRes = await fetch(`http://127.0.0.1:${LOG_PORT}/health`);
    log(`  log server /health      : ${healthRes.status}`);
  } catch (e) {
    log(`  log server /health      : (${e.message})`);
  }

  await app.close();
  log('Verify: PASS');
  return { version, userDataPath };
}

// ---------------------------------------------------------------------------
// Phase: upgrade -- drive the full check + download + install via Playwright
// ---------------------------------------------------------------------------

async function phaseUpgrade() {
  log('=== Phase: upgrade ===');

  if (!existsSync(APP_EXE)) {
    throw new Error(`No installed app at ${APP_EXE}. Run install phase first.`);
  }

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;

  log(`Launching ${APP_EXE} (running version expected: 0.0.1)`);
  const app = await electron.launch({ executablePath: APP_EXE, env });
  const window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');

  const beforeVersion = await app.evaluate(({ app: a }) => a.getVersion());
  log(`  Running version: ${beforeVersion}`);

  if (beforeVersion !== '0.0.1') {
    log(`WARNING: expected 0.0.1, got ${beforeVersion}. Proceeding anyway.`);
  }

  // Monkey-patch dialog.showMessageBox in main process so the
  // Update Available + Install and Restart dialogs auto-respond response: 0
  log('Monkey-patching dialog.showMessageBox -> auto-respond {response: 0}');
  await app.evaluate(async ({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
  });

  // Capture status events via the renderer's window.updater.onStatus
  log('Subscribing to updater status events; triggering check...');
  const eventsPromise = window.evaluate(async () => {
    const events = [];
    return new Promise((resolve) => {
      const off = window.updater.onStatus((event) => {
        events.push({ ...event, ts: Date.now() });
        // Stop after we see downloaded (or terminal failure)
        if (
          event.status === 'downloaded' ||
          event.status === 'not-available' ||
          event.status === 'error'
        ) {
          setTimeout(() => {
            off();
            resolve(events);
          }, 200);
        }
      });
      void window.updater.check({ manual: true });
      // Hard timeout: 90s for download to complete
      setTimeout(() => {
        off();
        resolve(events);
      }, 90000);
    });
  });

  const events = await eventsPromise;
  log(`Captured ${events.length} status events:`);
  for (const e of events) {
    const info = e.info ? JSON.stringify(e.info).slice(0, 120) : '';
    log(`  ${e.status} ${info}`);
  }

  const sawAvailable = events.some((e) => e.status === 'available');
  const sawDownloaded = events.some((e) => e.status === 'downloaded');
  const sawError = events.some((e) => e.status === 'error');

  if (sawError) {
    const err = events.find((e) => e.status === 'error');
    await app.close().catch(() => {});
    throw new Error(`Updater error: ${JSON.stringify(err.info)}`);
  }

  if (!sawAvailable) {
    await app.close().catch(() => {});
    throw new Error('Updater never emitted "available" status -- no v0.0.2 visible from GitHub?');
  }

  if (!sawDownloaded) {
    await app.close().catch(() => {});
    throw new Error(
      'Updater never emitted "downloaded" status. Was the dialog auto-clicked? Did download complete within 90s?'
    );
  }

  log('Update downloaded. Triggering install...');

  // window.updater.install() calls performUpdateInstall directly.
  // The lifecycle's update-downloaded handler ALSO calls performUpdateInstall
  // (via the auto-clicked dialog) -- it may have already been triggered.
  // Calling it again is idempotent-ish (writeUpdateState happens twice; harmless).
  // Actually, since the dialog was auto-clicked with response 0, install
  // is ALREADY in progress -- just need to wait for the swap.

  // The app process will quit during quitAndInstall. Detach the playwright
  // session as best-effort.
  try {
    await Promise.race([
      app.evaluate(({ app: a }) => {
        // No-op probe; if app is still alive it returns. If quitting, throws.
        return a.getVersion();
      }),
      sleep(500),
    ]);
  } catch {
    /* expected -- app quitting */
  }

  log('Waiting for Squirrel.Mac to swap the bundle (up to 30s)...');
  // Squirrel logs to ~/Library/Caches/com.onereach.lite.ShipIt/
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    const exists = existsSync(APP_EXE);
    if (!exists) {
      log(`  ${i}s: app bundle missing (Squirrel mid-swap)`);
      continue;
    }
    // Read CFBundleShortVersionString from Info.plist to see swapped version
    try {
      const info = shCapture(`/usr/libexec/PlistBuddy -c "Print CFBundleShortVersionString" "${APP_PATH}/Contents/Info.plist"`);
      if (info === '0.0.2') {
        log(`  ${i}s: Info.plist now shows 0.0.2 -- swap complete`);
        break;
      }
      if (i % 5 === 0) log(`  ${i}s: Info.plist still shows ${info}`);
    } catch {
      log(`  ${i}s: Info.plist read failed (mid-swap)`);
    }
  }

  // Make sure the playwright connection is fully closed before re-launching
  try {
    await app.close();
  } catch {
    /* expected */
  }
  await sleep(2000);

  // Re-launch the (hopefully-now-v0.0.2) app
  log('Re-launching installed app to verify version...');
  const app2 = await electron.launch({ executablePath: APP_EXE, env });
  const window2 = await app2.firstWindow();
  await window2.waitForLoadState('domcontentloaded');

  const afterVersion = await app2.evaluate(({ app: a }) => a.getVersion());
  log(`  Post-upgrade version: ${afterVersion}`);

  await app2.close();

  // Read userData state for the test report
  const updateStatePath = path.join(USER_DATA, 'update-state.json');
  const backupsDir = path.join(USER_DATA, 'app-backups');
  let updateState = '(not present)';
  if (existsSync(updateStatePath)) {
    updateState = await fs.readFile(updateStatePath, 'utf-8');
  }
  let backups = [];
  if (existsSync(backupsDir)) {
    backups = (await fs.readdir(backupsDir)).filter((d) => d.startsWith('v'));
  }

  log('');
  log('=== RESULTS ===');
  log(`  Before version              : ${beforeVersion}`);
  log(`  After version               : ${afterVersion}`);
  log(`  Saw available status        : ${sawAvailable ? 'YES' : 'NO'}`);
  log(`  Saw downloaded status       : ${sawDownloaded ? 'YES' : 'NO'}`);
  log(`  userData/update-state.json  : ${updateState.replace(/\n/g, ' ')}`);
  log(`  userData/app-backups/       : ${backups.join(', ') || '(empty)'}`);

  const upgradeSucceeded = afterVersion === '0.0.2';
  log('');
  log(upgradeSucceeded ? 'OVERALL: PASS' : 'OVERALL: FAIL -- post-upgrade version is not 0.0.2');

  if (!upgradeSucceeded) {
    // Suggest places to look
    log('');
    log('Diagnostic hints:');
    log(`  Squirrel logs:  ls -la ~/Library/Caches/com.onereach.lite.ShipIt/`);
    log(`  Lite log:        tail -f /tmp/lite-update.log (if applicable)`);
    log(`  Installed bundle Info.plist:`);
    try {
      const info = shCapture(`/usr/libexec/PlistBuddy -c "Print CFBundleShortVersionString" "${APP_PATH}/Contents/Info.plist"`);
      log(`    -> CFBundleShortVersionString: ${info}`);
    } catch (e) {
      log(`    (read failed: ${e.message})`);
    }
  }

  process.exit(upgradeSucceeded ? 0 : 1);
}

// ---------------------------------------------------------------------------
// Phase: cleanup
// ---------------------------------------------------------------------------

async function phaseCleanup() {
  log('=== Phase: cleanup ===');
  if (existsSync(APP_PATH)) {
    log(`Removing ${APP_PATH}`);
    sh(`rm -rf "${APP_PATH}"`);
  }
  if (existsSync(USER_DATA)) {
    log(`Removing ${USER_DATA}`);
    sh(`rm -rf "${USER_DATA}"`);
  }
  log('Cleanup complete');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

(async () => {
  try {
    switch (phase) {
      case 'install':
        await phaseInstall();
        break;
      case 'verify':
        await phaseVerify();
        break;
      case 'install-verify':
        await phaseInstall();
        await phaseVerify();
        break;
      case 'upgrade':
        await phaseUpgrade();
        break;
      case 'cleanup':
        await phaseCleanup();
        break;
      default:
        console.error(`Unknown phase: ${phase}`);
        console.error('Usage: node test-upgrade-flow.mjs <install|verify|install-verify|upgrade|cleanup>');
        process.exit(2);
    }
  } catch (err) {
    console.error('FAILED:', err.message);
    process.exit(1);
  }
})();
