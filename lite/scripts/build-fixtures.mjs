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

  console.log(`[fixtures] building v${version} (slim build per ADR-047, ~120 sec)`);

  // Bump lite/package.json's version so the fixture's main-lite.ts
  // readLiteVersion() returns the right value. Restore after the build.
  const litePkgPath = path.join(repoRoot, 'lite', 'package.json');
  const litePkgBefore = await fs.readFile(litePkgPath, 'utf-8');
  const litePkg = JSON.parse(litePkgBefore);
  const originalVersion = litePkg.version;
  litePkg.version = version;
  await fs.writeFile(litePkgPath, JSON.stringify(litePkg, null, 2) + '\n');

  // The dedicated runner (lite/scripts/electron-builder-mac.mjs) reads
  // lite/package.json and writes a merged temp config with version +
  // deps overrides. The slim itself is enforced by the !node_modules/*
  // exclude list in lite/electron-builder.json (ADR-047).
  const cmd = [
    'npm run lite:build',
    '&&',
    'npm run lite:lib-pin',
    '&&',
    'node lite/scripts/electron-builder-mac.mjs',
    '--publish=never',
  ].join(' ');

  try {
    execSync(cmd, { cwd: repoRoot, stdio: 'inherit' });
  } finally {
    await fs.writeFile(litePkgPath, litePkgBefore);
  }

  // Copy artifacts to cache. Note artifactName produces dotted file names
  // per lite/electron-builder.json (avoids GitHub auto-rename surprise).
  const builtAppPath = path.join(repoRoot, 'dist-lite', 'mac-arm64', 'Onereach.ai Lite.app');
  const builtZipPath = path.join(
    repoRoot,
    'dist-lite',
    `Onereach.ai.Lite-${version}-arm64-mac.zip`
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
