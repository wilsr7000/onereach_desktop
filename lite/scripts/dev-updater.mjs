#!/usr/bin/env node
/**
 * Onereach Lite -- dev-mode update-flow tester.
 *
 * Boots a local HTTP server that serves a fake `latest-mac.yml` for a
 * "newer" version, writes a `dev-app-update.yml` pointing at it, then
 * spawns lite in dev mode (`electron dist-lite/build/main-lite.js`)
 * with `LITE_DEV_UPDATE_CONFIG=<path>` so `init.ts` wires
 * electron-updater at the local feed.
 *
 * What this lets you test:
 *   - Manual "Check for Updates" click flow (Help menu)
 *   - "Update Available" dialog
 *   - The download path + status events
 *   - The "Update Ready to Install" prompt
 *   - All without packaging a real .app
 *
 * What this CANNOT test:
 *   - The actual install (Squirrel.Mac requires a real signed .app)
 *   - Cross-restart failure detection (no actual install happens)
 *   - Notarization (irrelevant for dev)
 *
 * For those, you still need `npm run lite:package:mac`. But for clicking
 * around the menus, dialogs, and IPC wiring, this is a 5-second loop
 * instead of a 5-minute one.
 *
 * Usage:
 *   npm run lite:dev:updater
 *
 * Env vars:
 *   LITE_DEV_UPDATER_VERSION  -- override the fake new version (default: bump patch +1)
 *   LITE_DEV_UPDATER_PORT     -- override the server port (default: OS-assigned)
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const MAIN_LITE = path.join(REPO_ROOT, 'dist-lite', 'build', 'main-lite.js');

// ----------------------------------------------------------------------
// Step 1: Read current version, fake a newer one
//
// IMPORTANT: when lite runs via the `electron` CLI (which is what
// `npm run lite:dev:updater` does), `app.getVersion()` returns
// Electron's own framework version -- e.g. "41.2.1" -- NOT lite's
// package.json version. electron-updater compares the YAML's
// `version:` field against `app.getVersion()` and rejects anything
// older as a downgrade. So in dev we need to advertise a fake
// version that's higher than whatever Electron is currently at.
//
// "99.0.0" is comfortably above any plausible Electron version while
// still being a valid semver. In packaged builds this isn't an issue
// (app.getVersion reads from the embedded package.json), but the dev
// loop wouldn't fire `update-available` without this offset.
// ----------------------------------------------------------------------
const pkg = JSON.parse(await fsp.readFile(path.join(REPO_ROOT, 'package.json'), 'utf-8'));
const currentVersion = pkg.version;
const DEV_FAKE_DEFAULT = '99.0.0';
const fakeVersion = process.env.LITE_DEV_UPDATER_VERSION ?? DEV_FAKE_DEFAULT;

console.log(`[dev-updater] package.json version:                v${currentVersion}`);
console.log(`[dev-updater] electron framework version (~app.getVersion in dev): see node_modules/electron`);
console.log(`[dev-updater] fake "newer" version to advertise:    v${fakeVersion}`);
console.log(`[dev-updater] (override with LITE_DEV_UPDATER_VERSION=...)`);

// ----------------------------------------------------------------------
// Step 2: Set up a fixture directory + placeholder bundle
// ----------------------------------------------------------------------
const fixtureDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lite-dev-updater-'));
console.log(`[dev-updater] fixture dir: ${fixtureDir}`);

// electron-updater verifies the zip's sha512 against the YAML before it
// tries to extract. Generate a placeholder blob and compute its real
// hash so the verifier passes through download. The placeholder won't
// actually install (it's not a real .app), but click/dialog flow works.
const zipBasename = `Onereach.ai Lite-${fakeVersion}-arm64-mac.zip`;
const zipPath = path.join(fixtureDir, zipBasename);
const zipBytes = Buffer.from(`lite-dev-updater-placeholder-v${fakeVersion}`);
await fsp.writeFile(zipPath, zipBytes);
const sha512 = createHash('sha512').update(zipBytes).digest('base64');

// Write a YAML that mirrors the shape release-lite.sh produces.
const releaseDate = new Date().toISOString().replace(/\.\d{3}Z$/, '.000Z');
const yamlPath = path.join(fixtureDir, 'latest-mac.yml');
const yamlContent = [
  `version: ${fakeVersion}`,
  `files:`,
  `  - url: ${zipBasename}`,
  `    sha512: ${sha512}`,
  `    size: ${zipBytes.length}`,
  `path: ${zipBasename}`,
  `sha512: ${sha512}`,
  `releaseDate: '${releaseDate}'`,
  '',
].join('\n');
await fsp.writeFile(yamlPath, yamlContent);
console.log(`[dev-updater] YAML written: ${yamlPath}`);

// ----------------------------------------------------------------------
// Step 3: Boot an HTTP server serving fixtureDir
// ----------------------------------------------------------------------
const requestedPort = process.env.LITE_DEV_UPDATER_PORT
  ? Number(process.env.LITE_DEV_UPDATER_PORT)
  : 0;

const server = http.createServer((req, res) => {
  const url = (req.url ?? '/').split('?')[0]; // strip electron-updater's noCache query
  const filePath = path.join(fixtureDir, decodeURIComponent(url));
  if (!filePath.startsWith(fixtureDir)) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      console.log(`[dev-updater] 404 ${url}`);
      res.writeHead(404);
      res.end('not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const ctype =
      ext === '.yml' || ext === '.yaml' ? 'text/yaml'
        : ext === '.zip' ? 'application/zip'
          : 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': ctype, 'Content-Length': stat.size });
    fs.createReadStream(filePath).pipe(res);
    console.log(`[dev-updater] 200 ${url} (${stat.size}B)`);
  });
});

await new Promise((resolve) => server.listen(requestedPort, '127.0.0.1', resolve));
const addr = server.address();
const port = typeof addr === 'object' && addr !== null ? addr.port : requestedPort;
const baseUrl = `http://127.0.0.1:${port}`;
console.log(`[dev-updater] update server listening at ${baseUrl}`);

// ----------------------------------------------------------------------
// Step 4: Write dev-app-update.yml pointing at the local server
// ----------------------------------------------------------------------
const devUpdateConfigPath = path.join(fixtureDir, 'dev-app-update.yml');
await fsp.writeFile(
  devUpdateConfigPath,
  ['provider: generic', `url: ${baseUrl}`, ''].join('\n')
);
console.log(`[dev-updater] dev-app-update.yml -> ${devUpdateConfigPath}`);

// ----------------------------------------------------------------------
// Step 5: Verify lite is built
// ----------------------------------------------------------------------
if (!fs.existsSync(MAIN_LITE)) {
  console.error(`[dev-updater] ERROR: ${MAIN_LITE} not found.`);
  console.error(`[dev-updater] Run "npm run lite:build" first.`);
  process.exit(1);
}

// ----------------------------------------------------------------------
// Step 6: Spawn electron with the dev-config wired
// ----------------------------------------------------------------------
const electronBin = path.join(REPO_ROOT, 'node_modules', '.bin', 'electron');
console.log(`[dev-updater] launching: ${electronBin} ${MAIN_LITE}`);
console.log(`[dev-updater] tip: click Help -> Check for Updates to test the flow`);
console.log(``);

const child = spawn(electronBin, [MAIN_LITE], {
  stdio: 'inherit',
  env: {
    ...process.env,
    NODE_ENV: 'development',
    LITE_DEV_UPDATE_CONFIG: devUpdateConfigPath,
    // Force packaged-mode behavior so electron-updater doesn't bail
    // out with its dev-mode "skip" guard. lite/updater/init.ts's
    // forceDevUpdateConfig already handles part of this; this env is
    // belt-and-suspenders for any nested check that still asks
    // app.isPackaged.
    ELECTRON_FORCE_PACKAGED: 'true',
  },
});

const cleanup = async () => {
  try {
    await new Promise((r) => server.close(() => r()));
  } catch {}
  try {
    await fsp.rm(fixtureDir, { recursive: true, force: true });
  } catch {}
};

child.on('exit', async (code) => {
  console.log(`[dev-updater] electron exited with code ${code}; shutting down server.`);
  await cleanup();
  process.exit(code ?? 0);
});

process.on('SIGINT', async () => {
  console.log(`\n[dev-updater] SIGINT -- shutting down`);
  child.kill('SIGINT');
  // child's exit handler will run cleanup
});

