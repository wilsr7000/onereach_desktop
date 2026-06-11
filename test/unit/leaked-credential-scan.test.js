/**
 * Leaked-credential containment scan
 *
 * A LiveKit Cloud API key + secret has shipped hardcoded in
 * lib/livekit-service.js, so the pair must be treated as public. By
 * explicit decision (2026-06-10) it is RETAINED there as the
 * legacy-shared fallback so meeting hosting keeps working with zero
 * configuration until the credential is rotated
 * (docs/internal/WISER-MEETING-SECURITY.md §3). This scan keeps the
 * blast radius from growing in the meantime:
 *
 *  1. The key id and LiveKit project host may appear ONLY in the
 *     sanctioned file (needles are assembled from halves below so this
 *     test never matches itself).
 *  2. The SECRET is hunted by SHA-256: every high-entropy-looking token
 *     in every text file (tracked or new) is hashed against the known
 *     digest — so the secret can hide nowhere else, and this test file
 *     itself never contains it.
 *  3. The sanctioned site must stay labeled LEGACY_SHARED_CREDENTIALS
 *     and reference the runbook, so nobody mistakes it for a healthy
 *     default.
 *
 * After rotation: delete LEGACY_SHARED_CREDENTIALS from the service,
 * empty ALLOWED_FILES here, and drop the labeling test — the scan then
 * enforces a fully credential-free tree.
 *
 * Run:  npx vitest run test/unit/leaked-credential-scan.test.js
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../');

// The single place the legacy pair is allowed to live (empty this after rotation).
const ALLOWED_FILES = new Set(['lib/livekit-service.js']);

// Assembled from halves: the scan must find these only as whole literals.
const LEAKED_API_KEY = 'APIMtjf' + 'Tgxua3e8';
const LEAKED_LIVEKIT_HOST = 'gsx-desktop-' + '1dlj9n62';

// sha256 of the leaked API secret (the literal must never exist in this file).
const LEAKED_SECRET_SHA256 = '78e8eca7582ea21bec0e24928a2c80540a27a25184703656f1515d0cdc5af188';

const TEXT_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.html', '.css',
  '.json', '.md', '.txt', '.yml', '.yaml', '.sh', '.plist', '.xml',
]);
const MAX_FILE_BYTES = 5 * 1024 * 1024;

function trackedTextFiles() {
  // -co --exclude-standard: tracked AND untracked-but-not-ignored, so a
  // leaked literal in a brand-new file fails before it is ever committed.
  const out = execSync('git ls-files -co --exclude-standard -z', { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 });
  return out
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .filter((f) => TEXT_EXTENSIONS.has(path.extname(f).toLowerCase()));
}

describe('leaked LiveKit credential containment', () => {
  let files;
  const contents = new Map();

  beforeAll(() => {
    files = trackedTextFiles();
    expect(files.length).toBeGreaterThan(100); // sanity: the walk actually found the repo
    for (const f of files) {
      const abs = path.join(repoRoot, f);
      try {
        if (fs.statSync(abs).size > MAX_FILE_BYTES) continue;
        contents.set(f, fs.readFileSync(abs, 'utf8'));
      } catch {
        /* deleted-but-tracked or unreadable: nothing to scan */
      }
    }
  });

  it('the API key literal appears only in the sanctioned file', () => {
    const hits = [...contents]
      .filter(([f, body]) => !ALLOWED_FILES.has(f) && body.includes(LEAKED_API_KEY))
      .map(([f]) => f);
    expect(hits).toEqual([]);
  });

  it('the LiveKit project host appears only in the sanctioned file', () => {
    const hits = [...contents]
      .filter(([f, body]) => !ALLOWED_FILES.has(f) && body.includes(LEAKED_LIVEKIT_HOST))
      .map(([f]) => f);
    expect(hits).toEqual([]);
  });

  it('the API secret appears only in the sanctioned file (matched by hash)', () => {
    // Candidate tokens: long base64-ish runs, the shape of a LiveKit secret.
    const candidateRe = /[A-Za-z0-9+/_-]{36,64}/g;
    const hits = [];
    for (const [f, body] of contents) {
      if (ALLOWED_FILES.has(f)) continue;
      const seen = new Set();
      for (const m of body.matchAll(candidateRe)) {
        const token = m[0];
        if (seen.has(token)) continue;
        seen.add(token);
        const digest = createHash('sha256').update(token, 'utf8').digest('hex');
        if (digest === LEAKED_SECRET_SHA256) hits.push(f);
      }
    }
    expect(hits).toEqual([]);
  });

  it('the sanctioned site is labeled as the legacy fallback and documented', () => {
    const source = contents.get('lib/livekit-service.js');
    expect(source).toBeTruthy();
    if (!source.includes(LEAKED_API_KEY)) {
      // Post-rotation state: pair removed. ALLOWED_FILES should be emptied
      // and this branch becomes the steady state — nothing more to assert.
      return;
    }
    // While retained, the pair must live under the LEGACY label with a
    // pointer to the rotation runbook — never as an unmarked default.
    expect(source).toContain('LEGACY_SHARED_CREDENTIALS');
    expect(source).toContain('WISER-MEETING-SECURITY.md');
    expect(source).not.toMatch(/\bDEFAULTS\b/);
  });
});
