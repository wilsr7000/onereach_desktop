#!/usr/bin/env node
/**
 * Record the SHA of lib/ contents into a lite release artifact.
 *
 * Per ADR-006 (lib/ rollback policy), every lite release pins the
 * specific SHA of lib/ it was built against. This lets lite ship
 * against a known-good lib/ even after full advances lib/ at HEAD,
 * and lets the three-way check (`verify-pinned-lib.mjs`) re-validate
 * the pinned SHA against full's test suite before the lite release
 * is allowed to publish.
 *
 * Output: dist-lite/lib-pin.json
 *   {
 *     "libDir": "lib",
 *     "gitSha": "<full git SHA of HEAD that produced this release>",
 *     "libContentHash": "<sha256 of all lib/ file contents, deterministic>",
 *     "files": [{ "path": "lib/log-server.js", "sha256": "..." }, ...],
 *     "recordedAt": "<ISO timestamp>",
 *     "liteVersion": "<version from package.json>"
 *   }
 *
 * Usage:
 *   node lite/scripts/record-lib-sha.mjs
 *   node lite/scripts/record-lib-sha.mjs --check <previous-pin.json>  # 3-way verify
 */

import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const libDir = path.join(repoRoot, 'lib');
const distDir = path.join(repoRoot, 'dist-lite');

async function walkLib(dir) {
  const out = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = await walkLib(full);
      out.push(...nested);
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out.sort();
}

async function hashFile(filePath) {
  const buf = await fs.readFile(filePath);
  return createHash('sha256').update(buf).digest('hex');
}

async function recordLibSha() {
  const files = await walkLib(libDir);
  const fileRecords = await Promise.all(
    files.map(async (f) => ({
      path: path.relative(repoRoot, f),
      sha256: await hashFile(f),
    }))
  );

  // Deterministic content hash: sha256 of the sorted (path, sha256) tuples
  const contentHasher = createHash('sha256');
  for (const { path: p, sha256 } of fileRecords) {
    contentHasher.update(`${p}\n${sha256}\n`);
  }
  const libContentHash = contentHasher.digest('hex');

  // Git SHA of HEAD
  let gitSha = 'unknown';
  try {
    gitSha = execSync('git rev-parse HEAD', { cwd: repoRoot, encoding: 'utf-8' }).trim();
  } catch {
    /* not a git checkout or git unavailable -- continue with 'unknown' */
  }

  // Lite version from package.json
  const pkg = JSON.parse(await fs.readFile(path.join(repoRoot, 'package.json'), 'utf-8'));

  const pin = {
    libDir: 'lib',
    gitSha,
    libContentHash,
    files: fileRecords,
    recordedAt: new Date().toISOString(),
    liteVersion: pkg.version,
  };

  await fs.mkdir(distDir, { recursive: true });
  const pinPath = path.join(distDir, 'lib-pin.json');
  await fs.writeFile(pinPath, JSON.stringify(pin, null, 2), 'utf-8');

  // eslint-disable-next-line no-console
  console.log(`[lite] recorded lib pin -> ${pinPath}`);
  // eslint-disable-next-line no-console
  console.log(`[lite] git SHA: ${gitSha}`);
  // eslint-disable-next-line no-console
  console.log(`[lite] lib content hash: ${libContentHash}`);
  // eslint-disable-next-line no-console
  console.log(`[lite] file count: ${fileRecords.length}`);
}

async function checkPin(previousPinPath) {
  const previous = JSON.parse(await fs.readFile(previousPinPath, 'utf-8'));
  const files = await walkLib(libDir);
  const fileRecords = await Promise.all(
    files.map(async (f) => ({
      path: path.relative(repoRoot, f),
      sha256: await hashFile(f),
    }))
  );
  const contentHasher = createHash('sha256');
  for (const { path: p, sha256 } of fileRecords) {
    contentHasher.update(`${p}\n${sha256}\n`);
  }
  const currentContentHash = contentHasher.digest('hex');

  if (currentContentHash === previous.libContentHash) {
    // eslint-disable-next-line no-console
    console.log(`[lite] OK: lib/ matches pinned content hash ${currentContentHash}`);
    process.exit(0);
  } else {
    // eslint-disable-next-line no-console
    console.error(`[lite] FAIL: lib/ has drifted from the pinned SHA.`);
    // eslint-disable-next-line no-console
    console.error(`  expected: ${previous.libContentHash}`);
    // eslint-disable-next-line no-console
    console.error(`  current:  ${currentContentHash}`);
    process.exit(1);
  }
}

const args = process.argv.slice(2);
const checkIdx = args.indexOf('--check');
if (checkIdx >= 0 && args[checkIdx + 1]) {
  await checkPin(args[checkIdx + 1]);
} else {
  await recordLibSha();
}
