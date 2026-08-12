#!/usr/bin/env electron
/**
 * ADR-064 — headless deploy of the Live Activity web page to
 * GSX/Edison Files (public). Mirrors scripts/deploy-guest-page.js:
 * must run inside Electron (`npx electron scripts/deploy-live-activity.js`)
 * because the GSX token lives in safeStorage-sealed settings.
 *
 * The page itself is static (web/live-activity.html) and read-only —
 * it queries the shared graph + KV directly from the browser (CORS is
 * open on both flows; credentials are the same baked dev-account debt
 * as the apps, punch-listed for rotation).
 */
const { app } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const FILES_BASE = 'https://files.edison.api.onereach.ai/public';
const REMOTE_DIR = 'live-activity';

app.whenReady().then(async () => {
  try {
    const { getSettingsManager } = require('../settings-manager');
    const { getGSXFileSync } = require('../lib/gsx-file-sync');
    const { reconcileGsxAccount } = require('../lib/gsx-account');

    const settings = getSettingsManager();
    global.settingsManager = settings;
    const fileSync = getGSXFileSync();
    global.gsxFileSync = fileSync;

    const reconcile = reconcileGsxAccount({
      settings,
      fileSync,
      warn: (msg, meta) => console.warn('[deploy][warn]', msg, meta || ''),
    });
    if (!reconcile.ok) {
      throw new Error(`Account reconcile failed (${reconcile.reason}): ${reconcile.error}`);
    }
    const { accountId } = reconcile;
    console.log(`[deploy] account: ${accountId}`);

    if (!fileSync.isInitialized) {
      const init = await fileSync.initialize();
      if (!init?.success && !fileSync.isInitialized) {
        throw new Error(`GSX File Sync init failed: ${init?.error || 'unknown'}`);
      }
    }

    const html = fs.readFileSync(path.join(__dirname, '..', 'web', 'live-activity.html'), 'utf8');
    const tempDir = path.join(os.tmpdir(), 'live-activity-deploy');
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
    fs.mkdirSync(tempDir, { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'index.html'), html, 'utf8');

    console.log('[deploy] pushing index.html to GSX Files...');
    if (typeof fileSync.executeWithTokenRefresh === 'function') {
      await fileSync.executeWithTokenRefresh(
        () => fileSync.client.pushLocalPathToFiles(tempDir, REMOTE_DIR, { isPublic: true }),
        'deployLiveActivity'
      );
    } else {
      await fileSync.client.pushLocalPathToFiles(tempDir, REMOTE_DIR, { isPublic: true });
    }
    fs.rmSync(tempDir, { recursive: true, force: true });

    const publicUrl = `${FILES_BASE}/${accountId}/${REMOTE_DIR}/index.html`;
    console.log(`[deploy] LIVE ACTIVITY URL: ${publicUrl}`);
    app.exit(0);
  } catch (error) {
    console.error('[deploy] FAILED:', error.message);
    app.exit(1);
  }
});
