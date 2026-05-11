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
// Read lite/package.json (source of truth for version + runtime deps + name)
// and lite/electron-builder.json (source of truth for productName).
// ---------------------------------------------------------------------------
const litePkg = JSON.parse(await fs.readFile(path.join(liteDir, 'package.json'), 'utf-8'));
if (version === null) version = litePkg.version;
const dependencies = litePkg.dependencies || {};
// The bundled package.json identity must match lite, not full. electron-updater
// derives its cache dir from app.getName() which is `productName || name` from
// the bundled package.json. Without these overrides the bundled package.json
// inherits the root's `name: gsx-power-user`, so electron-updater stages the
// downloaded update under ~/Library/Caches/gsx-power-user-updater/pending/.
// That path mismatch breaks the post-quit handoff to Squirrel.Mac and the app
// never restarts into the new version even though the download succeeded.
const _builderCfg = JSON.parse(
  await fs.readFile(path.join(liteDir, 'electron-builder.json'), 'utf-8')
);
const name = litePkg.name || 'onereach-lite';
const productName = _builderCfg.productName || 'Onereach.ai Lite';
const description = litePkg.description || 'Onereach.ai Lite';

console.log(`[electron-builder-mac] name: ${name}`);
console.log(`[electron-builder-mac] productName: ${productName}`);
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
    // Identity (overrides root package.json's "gsx-power-user" identity).
    // See ADR note in lite/PORTING.md: the bundled package.json must look
    // like lite, not full, or electron-updater + Squirrel.Mac install
    // pathing breaks.
    name,
    productName,
    description,
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
