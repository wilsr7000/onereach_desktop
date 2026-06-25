#!/usr/bin/env electron
/**
 * Headless deploy of the WISER Meeting guest page to GSX/Edison Files.
 *
 * Mirrors the `recorder:publish-guest-page` IPC handler in recorder.js, but
 * runs without the meeting UI. It must run inside Electron (not bare node)
 * because the GSX refresh URL / token live in app-settings-encrypted.json,
 * which is sealed with Electron safeStorage (macOS Keychain).
 *
 * Usage:  npx electron scripts/deploy-guest-page.js
 *
 * Requires: the same machine + user that signed into GSX in the app, so the
 * Keychain entry "Onereach.ai Safe Storage" can be decrypted. macOS may show
 * a one-time Keychain access prompt the first time the dev Electron binary
 * touches that key -- allow it.
 */

const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Running `electron <script>` defaults the app name to "Electron", which points
// userData at the wrong dir and makes safeStorage look up the wrong Keychain
// key. Align both with the packaged app so we read its encrypted settings and
// decrypt them with the same "Onereach.ai Safe Storage" key.
const APP_NAME = 'Onereach.ai';
app.setName(APP_NAME);
app.setPath('userData', path.join(app.getPath('appData'), APP_NAME));

const { getSettingsManager } = require('../settings-manager');
const { getGSXFileSync } = require('../gsx-file-sync');
const { buildGuestPageHTML, GUEST_PAGE_VERSION } = require('../lib/capture-guest-page');
const { _reconcileGsxAccount: reconcileGsxAccount } = require('../recorder');

const FILES_BASE = 'https://files.edison.api.onereach.ai/public';
const REMOTE_DIR = 'capture';

async function main() {
  const settings = getSettingsManager();
  global.settingsManager = settings;

  const fileSync = getGSXFileSync();
  global.gsxFileSync = fileSync;

  console.log(`[deploy] userData: ${app.getPath('userData')}`);
  console.log(`[deploy] guest page version to publish: ${GUEST_PAGE_VERSION}`);

  // 1. Resolve + reconcile the GSX account (URL is the source of truth)
  const reconcile = reconcileGsxAccount({
    settings,
    fileSync,
    warn: (msg, meta) => console.warn('[deploy][warn]', msg, meta || ''),
  });
  if (!reconcile.ok) {
    throw new Error(`Account reconcile failed (${reconcile.reason}): ${reconcile.error}`);
  }
  const { accountId, refreshUrl } = reconcile;
  console.log(`[deploy] account: ${accountId}`);

  // 2. Ensure the file-sync client is authenticated/initialized
  if (!fileSync.isInitialized) {
    const init = await fileSync.initialize();
    if (!init?.success && !fileSync.isInitialized) {
      throw new Error(`GSX File Sync init failed: ${init?.error || 'unknown'}`);
    }
  }

  // 3. Build the static page with the KV endpoint baked in
  const kvUrl = refreshUrl.replace('/refresh_token', '/keyvalue');
  const html = buildGuestPageHTML({ kvUrl });

  // 4. Stage to a temp dir
  const tempDir = path.join(os.tmpdir(), 'gsx-capture-publish-deploy');
  if (fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  fs.mkdirSync(tempDir, { recursive: true });
  fs.writeFileSync(path.join(tempDir, 'join.html'), html, 'utf8');

  // 5. Push to GSX Files (public), refreshing the token on 401
  console.log('[deploy] pushing join.html to GSX Files...');
  if (typeof fileSync.executeWithTokenRefresh === 'function') {
    await fileSync.executeWithTokenRefresh(
      () => fileSync.client.pushLocalPathToFiles(tempDir, REMOTE_DIR, { isPublic: true }),
      'deployGuestPage'
    );
  } else {
    await fileSync.client.pushLocalPathToFiles(tempDir, REMOTE_DIR, { isPublic: true });
  }
  fs.rmSync(tempDir, { recursive: true, force: true });

  // 6. Record what we published so the app reuses this URL
  const publicUrl = `${FILES_BASE}/${accountId}/${REMOTE_DIR}/join.html`;
  settings.set('captureGuestPageUrl', publicUrl);
  settings.set('captureGuestPageVersion', GUEST_PAGE_VERSION);

  console.log(`[deploy] OK -> ${publicUrl}`);
  console.log(`[deploy] published version: ${GUEST_PAGE_VERSION}`);
  return publicUrl;
}

app.whenReady()
  .then(main)
  .then(() => app.exit(0))
  .catch((err) => {
    console.error('[deploy] FAILED:', err && err.message ? err.message : err);
    if (err && err.stack) console.error(err.stack);
    app.exit(1);
  });
