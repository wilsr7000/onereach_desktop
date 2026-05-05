#!/usr/bin/env node
/**
 * Build version-A + version-B fixture lite apps for E2E updater tests.
 *
 * Each fixture is a complete packaged lite app with a version-overridden
 * package.json -- electron-builder bakes the version into Info.plist and
 * resources, so the fixture's `app.getVersion()` returns the override.
 *
 * Cached at ~/.cache/onereach-lite-fixture-cache/<version>/.
 *
 * Usage:
 *   node lite/scripts/build-fixtures.mjs                     # builds 0.0.1 + 0.0.2
 *   node lite/scripts/build-fixtures.mjs 0.5.0 0.6.0         # custom pair
 *   node lite/scripts/build-fixtures.mjs --force 0.0.1       # rebuild even if cached
 *
 * E2E specs reference fixtures by version via lite/test/harness/updater/fixtures.ts.
 */

import { execSync } from 'node:child_process';
import { promises as fs, existsSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const cacheDir = path.join(tmpdir(), 'onereach-lite-fixture-cache');

const args = process.argv.slice(2);
const force = args.includes('--force');
const versions = args.filter((a) => !a.startsWith('--'));
const pair = versions.length >= 2 ? versions : ['0.0.1-fixture', '0.0.2-fixture'];

console.log('[fixtures] Building lite app fixtures');
console.log(`[fixtures] Versions: ${pair.join(', ')}`);
console.log(`[fixtures] Cache dir: ${cacheDir}`);
console.log(`[fixtures] Force rebuild: ${force}`);
console.log('');

await fs.mkdir(cacheDir, { recursive: true });

for (const version of pair) {
  const versionCacheDir = path.join(cacheDir, version);
  const cachedApp = path.join(versionCacheDir, 'Onereach.ai Lite.app');

  if (!force && existsSync(cachedApp)) {
    console.log(`[fixtures] cache hit for v${version} -- skip`);
    continue;
  }

  console.log(`[fixtures] building v${version} (slow ~1-3 min)`);

  // electron-builder accepts --config.extraMetadata.version to override
  // package.json's version without mutating the file. This avoids race
  // conditions if multiple fixture builds run in parallel.
  const cmd = [
    'npm run lite:build',
    '&&',
    'npm run lite:lib-pin',
    '&&',
    'npx electron-builder build --mac',
    '--config lite/electron-builder.json',
    `--config.extraMetadata.version=${version}`,
    '--config.mac.identity=null',
    '--config.mac.notarize=false',
    '--publish never',
  ].join(' ');

  execSync(cmd, { cwd: repoRoot, stdio: 'inherit' });

  // Copy artifacts to cache.
  const builtAppPath = path.join(repoRoot, 'dist-lite', 'mac-arm64', 'Onereach.ai Lite.app');
  const builtZipPath = path.join(
    repoRoot,
    'dist-lite',
    `Onereach.ai Lite-${version}-arm64-mac.zip`
  );

  await fs.mkdir(versionCacheDir, { recursive: true });

  // Copy the .app (recursive) -- use cp -R because Node's fs.cp can
  // mishandle symlinks inside .app bundles.
  execSync(`cp -R "${builtAppPath}" "${path.join(versionCacheDir, 'Onereach.ai Lite.app')}"`);
  if (existsSync(builtZipPath)) {
    await fs.copyFile(builtZipPath, path.join(versionCacheDir, path.basename(builtZipPath)));
  }

  console.log(`[fixtures] cached v${version} -> ${versionCacheDir}`);
}

console.log('');
console.log('[fixtures] done');
