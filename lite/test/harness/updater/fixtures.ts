/**
 * Onereach Lite Test Harness -- fixture builders for the local update server.
 *
 * Two fixture flavours:
 *   1. `buildYamlFixture` -- generates a valid latest-mac.yml + a
 *      placeholder zip from arbitrary bytes. Fast (no electron-builder).
 *      Suitable for testing the updater's check + dialog + state-write
 *      paths -- electron-updater's verifier still validates the zip's
 *      sha512 against the YAML before download succeeds, but we never
 *      attempt the actual install in unit-flavoured E2E.
 *   2. `buildAppFixture` -- runs `lite:package:mac` with a version
 *      override and copies the produced .app + .zip into a fixtures
 *      cache dir. Slow (~1-3 minutes per version) -- cached by
 *      content hash so back-to-back runs are fast.
 *
 * For the parity scenarios that actually exercise quitAndInstall, use
 * buildAppFixture. For most lifecycle assertions buildYamlFixture is
 * sufficient.
 */

import { promises as fs, createReadStream } from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');

export interface YamlFixtureOptions {
  /** Version string to embed (e.g. '0.2.0'). */
  version: string;
  /** Output directory -- the YAML + zip are written here. */
  outputDir: string;
  /** Optional release date override (defaults to now). */
  releaseDate?: string;
  /** Bytes to use for the placeholder zip. Default: a tiny static blob. */
  zipBytes?: Buffer;
  /** Filename basename for the zip (defaults to "Onereach.ai Lite-<version>-arm64-mac.zip"). */
  zipBasename?: string;
  /** YAML basename. Defaults to 'latest-mac.yml'. */
  yamlBasename?: string;
}

export interface YamlFixtureResult {
  yamlPath: string;
  zipPath: string;
  version: string;
  sha512: string;
  size: number;
}

const DEFAULT_PLACEHOLDER = Buffer.from('lite-fixture-placeholder');

/**
 * Build a valid latest-mac.yml + placeholder zip pair. Returns
 * absolute paths and the computed sha512 for assertions.
 */
export async function buildYamlFixture(opts: YamlFixtureOptions): Promise<YamlFixtureResult> {
  await fs.mkdir(opts.outputDir, { recursive: true });
  const zipBasename = opts.zipBasename ?? `Onereach.ai Lite-${opts.version}-arm64-mac.zip`;
  const yamlBasename = opts.yamlBasename ?? 'latest-mac.yml';
  const zipPath = path.join(opts.outputDir, zipBasename);
  const yamlPath = path.join(opts.outputDir, yamlBasename);
  const bytes = opts.zipBytes ?? DEFAULT_PLACEHOLDER;
  await fs.writeFile(zipPath, bytes);
  const sha512 = createHash('sha512').update(bytes).digest('base64');
  const size = bytes.length;

  const releaseDate = opts.releaseDate ?? new Date().toISOString().replace(/\.\d{3}Z$/, '.000Z');
  const yaml = [
    `version: ${opts.version}`,
    `files:`,
    `  - url: ${zipBasename}`,
    `    sha512: ${sha512}`,
    `    size: ${size}`,
    `path: ${zipBasename}`,
    `sha512: ${sha512}`,
    `releaseDate: '${releaseDate}'`,
    '',
  ].join('\n');
  await fs.writeFile(yamlPath, yaml, 'utf-8');

  return { yamlPath, zipPath, version: opts.version, sha512, size };
}

/**
 * Build a real lite app fixture for a given version. Bumps the version
 * in package.json (in a tempdir), runs `lite:package:mac`, copies
 * artifacts to a cache dir keyed by version + content hash. Slow.
 *
 * Implementation note: rather than mutating root package.json (race-prone
 * with parallel tests), this writes the version into the produced
 * artifacts via electron-builder's `--config.extraMetadata.version`.
 */
export async function buildAppFixture(opts: {
  version: string;
  /** Cache dir -- defaults to /tmp/onereach-lite-fixture-cache/. */
  cacheDir?: string;
  /** Force rebuild even if cached. Default false. */
  force?: boolean;
  /** Logger -- defaults to console.log. */
  logger?: (msg: string) => void;
}): Promise<{ appPath: string; zipPath: string; cached: boolean }> {
  const log = opts.logger ?? ((msg: string) => {
    // eslint-disable-next-line no-console
    console.log(`[fixtures] ${msg}`);
  });
  const cacheDir = opts.cacheDir ?? path.join(tmpdir(), 'onereach-lite-fixture-cache');
  const versionCache = path.join(cacheDir, opts.version);
  const cachedAppPath = path.join(versionCache, 'Onereach.ai Lite.app');
  const cachedZipPath = path.join(versionCache, `Onereach.ai Lite-${opts.version}-arm64-mac.zip`);

  if (opts.force !== true) {
    try {
      await fs.access(cachedAppPath);
      await fs.access(cachedZipPath);
      log(`cache hit for v${opts.version}`);
      return { appPath: cachedAppPath, zipPath: cachedZipPath, cached: true };
    } catch {
      /* cache miss */
    }
  }

  log(`building lite v${opts.version} (slow ~1-3 min)`);
  await fs.mkdir(versionCache, { recursive: true });

  // Build via electron-builder with extraMetadata.version override.
  const cmd = [
    'npm run lite:build &&',
    'npm run lite:lib-pin &&',
    'npx electron-builder build --mac',
    '--config lite/electron-builder.json',
    `--config.extraMetadata.version=${opts.version}`,
    '--config.mac.identity=null',
    '--config.mac.notarize=false',
    '--publish never',
  ].join(' ');
  execSync(cmd, { cwd: REPO_ROOT, stdio: 'inherit' });

  const builtApp = path.join(REPO_ROOT, 'dist-lite', 'mac-arm64', 'Onereach.ai Lite.app');
  const builtZip = path.join(REPO_ROOT, 'dist-lite', `Onereach.ai Lite-${opts.version}-arm64-mac.zip`);

  // Copy into cache. Recursive for the .app bundle.
  await copyRecursive(builtApp, cachedAppPath);
  await fs.copyFile(builtZip, cachedZipPath);

  log(`built and cached at ${versionCache}`);
  return { appPath: cachedAppPath, zipPath: cachedZipPath, cached: false };
}

async function copyRecursive(src: string, dst: string): Promise<void> {
  const stat = await fs.stat(src);
  if (stat.isDirectory()) {
    await fs.mkdir(dst, { recursive: true });
    const entries = await fs.readdir(src);
    for (const entry of entries) {
      await copyRecursive(path.join(src, entry), path.join(dst, entry));
    }
  } else if (stat.isSymbolicLink()) {
    const link = await fs.readlink(src);
    try {
      await fs.unlink(dst);
    } catch {
      /* may not exist */
    }
    await fs.symlink(link, dst);
  } else {
    await fs.copyFile(src, dst);
  }
}

/** Compute sha512 of an existing file -- useful for asserting a YAML is correct. */
export async function sha512OfFile(filePath: string): Promise<string> {
  const hash = createHash('sha512');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve());
    stream.on('error', reject);
  });
  return hash.digest('base64');
}
