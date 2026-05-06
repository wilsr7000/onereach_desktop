#!/usr/bin/env node
/**
 * Live update flow test -- DEV ONLY.
 *
 * Boots lite (the dev-mode bundle, current package.json version = vA),
 * spins up a local HTTP update server serving a fictitious vB
 * (latest-mac.yml + placeholder zip with valid sha512), then
 * triggers `window.updater.check({ manual: true })` through the preload
 * bridge. Captures every event the updater emits.
 *
 * Logic mirrors lite/test/harness/updater/{server,fixtures,dev-config,
 * scenarios}.ts but is inlined here so the test runs as plain Node
 * (no TypeScript loader needed). When this stabilizes, fold it into
 * lite/test/e2e/updater/local-server.spec.ts.
 *
 * Run with:  node test-update-live.mjs
 */

import { _electron as electron } from 'playwright';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import * as http from 'node:http';

// In dev mode (`npx electron <script>`), `app.getVersion()` returns
// Electron's own version (41.2.1 at time of writing) rather than lite's
// 5.0.0 -- a known dev-mode quirk documented in lite/main-lite.ts.
// To make electron-updater treat this as an upgradable scenario, we
// advertise a version higher than Electron's. In packaged builds the
// running version is lite's real version and a 5.x.x advertised would
// work normally.
const VERSION_B = '99.0.0';

console.log('=== Lite update flow live test ===');
console.log(`Server-advertised version: ${VERSION_B}`);
console.log('');

// ---------------------------------------------------------------------------
// Sandbox
// ---------------------------------------------------------------------------

const sandbox = await fs.mkdtemp(path.join(tmpdir(), 'lite-update-livetest-'));
const servingDir = path.join(sandbox, 'serving');
const userDataDir = path.join(sandbox, 'userdata');
const devCfgPath = path.join(sandbox, 'dev-app-update.yml');
await fs.mkdir(servingDir, { recursive: true });
await fs.mkdir(userDataDir, { recursive: true });
console.log(`Sandbox: ${sandbox}`);

// ---------------------------------------------------------------------------
// YAML fixture (latest-mac.yml + placeholder zip with valid sha512)
// ---------------------------------------------------------------------------

const zipBytes = Buffer.from('lite-fixture-placeholder-' + VERSION_B);
const zipBasename = `Onereach.ai Lite-${VERSION_B}-arm64-mac.zip`;
const zipPath = path.join(servingDir, zipBasename);
await fs.writeFile(zipPath, zipBytes);
const sha512 = createHash('sha512').update(zipBytes).digest('base64');
const releaseDate = new Date().toISOString().replace(/\.\d{3}Z$/, '.000Z');

const yaml = [
  `version: ${VERSION_B}`,
  `files:`,
  `  - url: ${zipBasename}`,
  `    sha512: ${sha512}`,
  `    size: ${zipBytes.length}`,
  `path: ${zipBasename}`,
  `sha512: ${sha512}`,
  `releaseDate: '${releaseDate}'`,
  '',
].join('\n');
const yamlPath = path.join(servingDir, 'latest-mac.yml');
await fs.writeFile(yamlPath, yaml, 'utf-8');
console.log(`Fixture YAML: ${yamlPath}`);
console.log(`Fixture sha512: ${sha512.slice(0, 32)}...`);
console.log('');

// ---------------------------------------------------------------------------
// Local HTTP update server (mirrors lite/test/harness/updater/server.ts)
// ---------------------------------------------------------------------------

const requests = [];
const CONTENT_TYPES = {
  '.yml': 'text/yaml',
  '.zip': 'application/zip',
  '.blockmap': 'application/octet-stream',
};

const server = http.createServer((req, res) => {
  requests.push(req.url ?? '/');
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.writeHead(200).end();

  // Strip query string (electron-updater appends ?noCache=...) before
  // mapping URL to file path.
  const reqUrl = req.url ?? '/';
  const pathOnly = reqUrl.split('?')[0];
  const requested = pathOnly === '/' ? '/latest-mac.yml' : pathOnly;
  const filePath = path.join(servingDir, decodeURIComponent(requested));
  if (!fsSync.existsSync(filePath)) {
    return res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  }
  const ext = path.extname(filePath);
  const contentType = CONTENT_TYPES[ext] ?? 'application/octet-stream';
  fsSync.readFile(filePath, (err, data) => {
    if (err) return res.writeHead(500).end();
    res.writeHead(200, { 'Content-Type': contentType, 'Content-Length': data.length });
    res.end(data);
  });
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    server.removeListener('error', reject);
    resolve();
  });
});

const port = server.address().port;
const baseUrl = `http://127.0.0.1:${port}`;
console.log(`Local server: ${baseUrl}`);

// ---------------------------------------------------------------------------
// dev-app-update.yml (lite reads this when LITE_DEV_UPDATE_CONFIG is set)
// ---------------------------------------------------------------------------

const devYml = [
  `provider: generic`,
  `url: ${baseUrl}`,
  // No channel: line -- per ADR-027 lite uses its own public repo with the
  // default `latest` channel, no need to suffix the YAML name.
  '',
].join('\n');
await fs.writeFile(devCfgPath, devYml, 'utf-8');
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

// Read the running version
const runningVersion = await app.evaluate(({ app: a }) => a.getVersion());
console.log(`Lite booted -- running version: ${runningVersion}`);
console.log('');

// Give updater a moment to initialize
await new Promise((r) => setTimeout(r, 800));

// ---------------------------------------------------------------------------
// Trigger check + capture events
// ---------------------------------------------------------------------------

console.log('Triggering window.updater.check({ manual: true })...');
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
    }, 8000);
  });
});

console.log('=== Updater status events captured ===');
for (const event of statusEvents) {
  const infoStr = event.info ? ' ' + JSON.stringify(event.info).slice(0, 140) : '';
  console.log(`  ${event.status}${infoStr}`);
}
console.log('');

// ---------------------------------------------------------------------------
// Inspect the local server's request log
// ---------------------------------------------------------------------------

console.log('=== Local server requests ===');
for (const reqPath of requests) console.log(`  GET ${reqPath}`);
console.log('');

// ---------------------------------------------------------------------------
// Pull updater logs from lite's log server (port 47392)
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
const yamlRequested = requests.some((p) => p.includes('latest-mac.yml') || p === '/');

console.log('=== RESULTS ===');
console.log(`  ${sawChecking ? '[PASS]' : '[FAIL]'} Updater emitted "checking" status`);
console.log(`  ${yamlRequested ? '[PASS]' : '[FAIL]'} Local server received YAML request (${requests.length} total requests)`);
console.log(
  `  ${sawAvailable ? '[PASS]' : sawError ? '[FAIL]' : '[INFO]'} Updater detected v${VERSION_B} as available`
);
if (sawError) {
  const errEv = statusEvents.find((e) => e.status === 'error');
  console.log(`         (error info: ${JSON.stringify(errEv?.info)})`);
}

// Cleanup
await app.close();
await new Promise((resolve) => server.close(() => resolve()));
await fs.rm(sandbox, { recursive: true, force: true });

const allPassed = sawChecking && yamlRequested && sawAvailable;
console.log('');
console.log(allPassed ? 'OVERALL: PASS' : 'OVERALL: FAIL');
process.exit(allPassed ? 0 : 1);
