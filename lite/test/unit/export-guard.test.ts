import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * ADR-067 — the export guard is the mechanical gate for open-sourcing:
 * it must BLOCK (exit 1) on a tree containing a baked secret or an
 * unauthenticated Edison flow URL, and PASS (exit 0) on a clean tree.
 * This test proves both directions so the gate itself can't rot.
 */
const GUARD = resolve(__dirname, '../../../scripts/export-guard.mjs');

function run(root: string): number {
  try {
    execFileSync('node', [GUARD, root], { stdio: 'pipe' });
    return 0;
  } catch (e) {
    return (e as { status?: number }).status ?? -1;
  }
}

describe('export-guard', () => {
  it('BLOCKS a tree with an unauthenticated Edison flow URL', () => {
    const dir = mkdtempSync(join(tmpdir(), 'exportguard-bad-'));
    try {
      mkdirSync(join(dir, 'lib'));
      writeFileSync(
        join(dir, 'lib', 'x.js'),
        'const u = "https://em.edison.api.onereach.ai/http/35254342-4a2e-475b-aec1-18547e517e29/keyvalue2";'
      );
      expect(run(dir)).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('BLOCKS a tree with a baked graph password', () => {
    const dir = mkdtempSync(join(tmpdir(), 'exportguard-secret-'));
    try {
      mkdirSync(join(dir, 'lite'));
      writeFileSync(
        join(dir, 'lite', 'c.ts'),
        "export const password = 'oCLF5bxkj66qivVDh1biePK7Byo9U1NUvFLJrHnQjzo';"
      );
      expect(run(dir)).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('PASSES a clean tree that reads creds from env/config', () => {
    const dir = mkdtempSync(join(tmpdir(), 'exportguard-clean-'));
    try {
      mkdirSync(join(dir, 'lib'));
      writeFileSync(
        join(dir, 'lib', 'ok.js'),
        'const key = process.env.NEON_PASSWORD;\nconst url = `${process.env.EDISON_BASE}/keyvalue2`;'
      );
      expect(run(dir)).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('BLOCKS a tree with committed signing material (.provisionprofile)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'exportguard-signing-'));
    try {
      mkdirSync(join(dir, 'lite', 'build'), { recursive: true });
      // Content is irrelevant — presence of the file type is the finding.
      writeFileSync(join(dir, 'lite', 'build', 'App_DeveloperID.provisionprofile'), 'binary-ish');
      expect(run(dir)).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('BLOCKS a tree with a private key (.p12)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'exportguard-p12-'));
    try {
      mkdirSync(join(dir, 'certs'), { recursive: true });
      writeFileSync(join(dir, 'certs', 'signing.p12'), 'not-a-real-key');
      expect(run(dir)).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
