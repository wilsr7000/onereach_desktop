#!/usr/bin/env electron
/**
 * Headless push of a local file or folder to GSX/Edison Files, the same
 * way scripts/deploy-guest-page.js and scripts/deploy-live-activity.js
 * publish their pages: inside Electron, through the app's signed-in GSX
 * session (the token lives in safeStorage-sealed settings, so bare node
 * cannot read it), with the token refreshed once on 401.
 *
 * Usage:
 *   npx electron scripts/deploy-file-to-gsx-files.js <local-file-or-dir> <remote-dir> [--private]
 *
 * A single file is staged alone into <remote-dir>; a folder is pushed
 * recursively under <remote-dir>. Files are streamed (never read into
 * memory) with their MIME type from the extension, so a 160 MB .mov goes
 * up as video/quicktime. Public by default (that is what "put it in
 * Files" means for demos and hosted pages); --private keeps it in the
 * private bucket. Prints the public URL of every file it pushed.
 *
 * Requires the same machine + user that signed into GSX in the app so the
 * "Onereach.ai Safe Storage" Keychain entry decrypts; macOS may ask once.
 */
const { app } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const APP_NAME = 'Onereach.ai';
app.setName(APP_NAME);
app.setPath('userData', path.join(app.getPath('appData'), APP_NAME));

const FILES_BASE = 'https://files.edison.api.onereach.ai/public';

function usage(message) {
  if (message) console.error(`[deploy] ${message}`);
  console.error('Usage: npx electron scripts/deploy-file-to-gsx-files.js <local-file-or-dir> <remote-dir> [--private]');
  app.exit(2);
}

function parseArgs(argv) {
  const args = argv.filter((a) => a !== '--private');
  const isPublic = !argv.includes('--private');
  const local = args[0];
  const remoteDir = (args[1] || '').replace(/^\/+|\/+$/g, '');
  if (!local || !remoteDir) return null;
  if (!/^[A-Za-z0-9._\-\/]+$/.test(remoteDir)) return null;
  return { local: path.resolve(local), remoteDir, isPublic };
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

app.whenReady().then(async () => {
  let stageDir = null;
  try {
    const parsed = parseArgs(process.argv.slice(2));
    if (parsed === null) return usage('need a local path and a remote directory (letters, digits, . _ - / only)');
    const { local, remoteDir, isPublic } = parsed;
    if (!fs.existsSync(local)) return usage(`local path not found: ${local}`);

    const { getSettingsManager } = require('../settings-manager');
    const { getGSXFileSync } = require('../gsx-file-sync');
    const { _reconcileGsxAccount: reconcileGsxAccount } = require('../recorder');

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

    // The SDK walks a directory; a lone file is staged into one (a hard
    // link when the volumes agree, a copy otherwise) so nothing is read
    // into memory here either.
    let localDir = local;
    if (fs.statSync(local).isFile()) {
      stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsx-files-deploy-'));
      const staged = path.join(stageDir, path.basename(local));
      try {
        fs.linkSync(local, staged);
      } catch {
        fs.copyFileSync(local, staged);
      }
      localDir = stageDir;
    }
    const files = walk(localDir);
    if (files.length === 0) throw new Error(`nothing to push under ${localDir}`);
    const totalBytes = files.reduce((n, f) => n + fs.statSync(f).size, 0);
    console.log(`[deploy] pushing ${files.length} file(s), ${(totalBytes / 1048576).toFixed(1)} MB, to ${isPublic ? 'public' : 'private'}/${remoteDir}/ ...`);

    const startedAt = Date.now();
    const push = () => fileSync.client.pushLocalPathToFiles(localDir, remoteDir, { isPublic, rewriteMode: 'rewrite' });
    if (typeof fileSync.executeWithTokenRefresh === 'function') {
      await fileSync.executeWithTokenRefresh(push, 'deployFileToGsxFiles');
    } else {
      await push();
    }
    console.log(`[deploy] upload finished in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);

    for (const file of files) {
      const rel = path.relative(localDir, file).split(path.sep).map(encodeURIComponent).join('/');
      if (isPublic) {
        console.log(`[deploy] URL: ${FILES_BASE}/${accountId}/${remoteDir}/${rel}`);
      } else {
        console.log(`[deploy] private key: ${remoteDir}/${rel}`);
      }
    }
    app.exit(0);
  } catch (error) {
    console.error('[deploy] FAILED:', error && error.message ? error.message : error);
    app.exit(1);
  } finally {
    if (stageDir) fs.rmSync(stageDir, { recursive: true, force: true });
  }
});
