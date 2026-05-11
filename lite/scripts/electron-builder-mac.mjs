#!/usr/bin/env node
/**
 * Slim electron-builder runner for lite (macOS).
 *
 * Why this script exists: electron-builder's CLI accepts
 * `--config.extraMetadata.x=y` for primitive values, but does NOT
 * deserialize JSON object values at leaf nodes. So
 * `--config.extraMetadata.dependencies={...}` ends up as a STRING in
 * config and electron-builder's `'electron' in dependencies` check
 * crashes with "Cannot use 'in' operator". Workaround: merge
 * extraMetadata into a temp config file and pass that to
 * electron-builder via --config.
 *
 * Usage:
 *   node lite/scripts/electron-builder-mac.mjs                    # version from lite/package.json
 *   node lite/scripts/electron-builder-mac.mjs --version=0.0.3    # explicit
 *   node lite/scripts/electron-builder-mac.mjs --publish=always   # publish (default: never)
 *   node lite/scripts/electron-builder-mac.mjs --fast             # skip rebuild + notarize for fast iteration
 *
 * The temp config is written to dist-lite/build-config.json (gitignored).
 * Source of truth for `dependencies` and `version`: lite/package.json.
 * Per ADR-047, lite ships with only its 4 declared deps -- the override
 * makes the version + name correct in the packaged metadata, and the
 * exclude list ("!node_modules/<pkg>/all-files") in
 * lite/electron-builder.json does the actual file-copy filtering that
 * drops the bundle from 283MB to ~165MB.
 */

import { execSync, spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const liteDir = path.join(repoRoot, 'lite');
const distLite = path.join(repoRoot, 'dist-lite');

// ---------------------------------------------------------------------------
// Parse args
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
let version = null;
let publish = 'never';
let fast = false;
for (const a of args) {
  if (a.startsWith('--version=')) version = a.slice('--version='.length);
  else if (a.startsWith('--publish=')) publish = a.slice('--publish='.length);
  else if (a === '--fast') fast = true;
}

// ---------------------------------------------------------------------------
// Read lite/package.json (source of truth for version + runtime deps)
// ---------------------------------------------------------------------------
const litePkg = JSON.parse(await fs.readFile(path.join(liteDir, 'package.json'), 'utf-8'));
if (version === null) version = litePkg.version;
const dependencies = litePkg.dependencies || {};

console.log(`[electron-builder-mac] version: ${version}`);
console.log(`[electron-builder-mac] runtime deps: ${JSON.stringify(dependencies)}`);
console.log(`[electron-builder-mac] publish: ${publish}`);
if (fast) console.log(`[electron-builder-mac] fast mode (--dir, no rebuild, no notarize)`);

// ---------------------------------------------------------------------------
// Generate merged config in dist-lite/build-config.json
// ---------------------------------------------------------------------------
await fs.mkdir(distLite, { recursive: true });
const baseConfig = JSON.parse(
  await fs.readFile(path.join(liteDir, 'electron-builder.json'), 'utf-8')
);
const merged = {
  ...baseConfig,
  extraMetadata: {
    ...(baseConfig.extraMetadata || {}),
    version,
    dependencies,
  },
};

// When skipping notarization (e.g. Apple's timestamp.apple.com:443 is down or
// credentials missing), also disable codesign's --timestamp flag. Without this
// codesign tries to contact Apple's timestamp authority and fails with
// "A timestamp was expected but was not found" when the service is unreachable.
// The resulting bundle has a signature with no embedded secure timestamp,
// which is fine for unnotarized distribution; we just re-enable timestamping
// (default Apple URL) for the next release once the service is back up.
if (process.env.SKIP_NOTARIZE === '1') {
  merged.mac = { ...(baseConfig.mac || {}), timestamp: 'none' };
  console.log('[electron-builder-mac] SKIP_NOTARIZE=1 -- mac.timestamp set to "none" (no Apple timestamp server)');
}
const tempConfigPath = path.join(distLite, 'build-config.json');
await fs.writeFile(tempConfigPath, JSON.stringify(merged, null, 2));
console.log(`[electron-builder-mac] wrote merged config to ${tempConfigPath}`);

// ---------------------------------------------------------------------------
// Invoke electron-builder
// ---------------------------------------------------------------------------
const ebArgs = ['electron-builder', 'build', '--mac', '--config', tempConfigPath, '--publish', publish];
if (fast) {
  ebArgs.push('--dir', '-c.npmRebuild=false', '-c.mac.notarize=false');
}

const start = Date.now();
const result = spawnSync('npx', ebArgs, { stdio: 'inherit', cwd: repoRoot });
const elapsed = Math.round((Date.now() - start) / 1000);
console.log(`[electron-builder-mac] elapsed: ${elapsed}s`);

if (result.status !== 0) {
  console.error(`[electron-builder-mac] electron-builder exited ${result.status}`);
  process.exit(result.status || 1);
}
