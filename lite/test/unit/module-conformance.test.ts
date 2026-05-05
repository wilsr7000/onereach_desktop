/**
 * Module conformance meta-test.
 *
 * Enforces Rule 12 (LITE-RULES.md): every lite module that exposes a
 * public `api.ts` must have a `<module>-api.test.ts` that runs through
 * `runApiConformanceContract` from the harness.
 *
 * Adding a module without a contract test fails this test, fails CI,
 * and blocks the merge. That's the load-bearing piece -- without this
 * meta-test, Rule 12 is documentation; with it, it's policy.
 *
 * Discovery: scans `lite/<module>/api.ts` (one level deep). Tests live
 * at `lite/test/unit/<module>-api.test.ts`. Modules that intentionally
 * skip the contract list themselves in `EXEMPT_MODULES` below with a
 * justification comment.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Modules that have a public api.ts but legitimately skip the
 * conformance contract. Each entry needs a one-line justification.
 *
 * Empty by default -- prefer adding a contract test over an exemption.
 * If you must add an entry, link a follow-up issue to remove it.
 */
const EXEMPT_MODULES: ReadonlyArray<{ module: string; reason: string }> = [
  // Example (none today):
  // { module: 'shell', reason: 'shell module exposes only side-effect lifecycle hooks; no method surface to contract-test.' },
];

describe('Module conformance meta-test (Rule 12)', () => {
  const liteRoot = path.resolve(__dirname, '..', '..');
  const testUnitDir = path.resolve(liteRoot, 'test', 'unit');

  function discoverModulesWithApi(): string[] {
    const entries = fs.readdirSync(liteRoot, { withFileTypes: true });
    const modules: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      // Skip non-module directories.
      if (
        entry.name === 'test' ||
        entry.name === 'node_modules' ||
        entry.name === 'scripts' ||
        entry.name === 'menu' ||
        entry.name === 'updater'
      ) {
        continue;
      }
      const apiPath = path.join(liteRoot, entry.name, 'api.ts');
      if (fs.existsSync(apiPath)) modules.push(entry.name);
    }
    return modules.sort();
  }

  function readTestFile(module: string): string | null {
    const testFile = path.join(testUnitDir, `${module}-api.test.ts`);
    if (!fs.existsSync(testFile)) return null;
    return fs.readFileSync(testFile, 'utf-8');
  }

  it('discovers at least one module (sanity)', () => {
    const modules = discoverModulesWithApi();
    expect(modules.length).toBeGreaterThan(0);
  });

  it('every module with api.ts has a corresponding <module>-api.test.ts', () => {
    const modules = discoverModulesWithApi();
    const exempt = new Set(EXEMPT_MODULES.map((e) => e.module));
    const missing: string[] = [];
    for (const module of modules) {
      if (exempt.has(module)) continue;
      const contents = readTestFile(module);
      if (contents === null) {
        missing.push(`${module}-api.test.ts`);
      }
    }
    expect(
      missing,
      `Rule 12 violation: missing contract test files: ${missing.join(', ')}.\n` +
        `Add lite/test/unit/<module>-api.test.ts that calls runApiConformanceContract from '../harness'.`
    ).toHaveLength(0);
  });

  it('every <module>-api.test.ts imports runApiConformanceContract from the harness', () => {
    const modules = discoverModulesWithApi();
    const exempt = new Set(EXEMPT_MODULES.map((e) => e.module));
    const violations: string[] = [];
    for (const module of modules) {
      if (exempt.has(module)) continue;
      const contents = readTestFile(module);
      if (contents === null) continue; // already reported by the previous test
      const hasImport = /import\s*\{[^}]*runApiConformanceContract[^}]*\}\s*from\s*['"][^'"]*\/harness/.test(
        contents
      );
      if (!hasImport) {
        violations.push(`${module}-api.test.ts (no runApiConformanceContract import from harness)`);
      }
    }
    expect(
      violations,
      `Rule 12 violation: contract not invoked in: ${violations.join(', ')}`
    ).toHaveLength(0);
  });

  it('every <module>-api.test.ts actually calls runApiConformanceContract({...})', () => {
    const modules = discoverModulesWithApi();
    const exempt = new Set(EXEMPT_MODULES.map((e) => e.module));
    const violations: string[] = [];
    for (const module of modules) {
      if (exempt.has(module)) continue;
      const contents = readTestFile(module);
      if (contents === null) continue;
      const hasCall = /runApiConformanceContract\s*[<(]/.test(contents);
      if (!hasCall) {
        violations.push(`${module}-api.test.ts (imports the contract but never calls it)`);
      }
    }
    expect(
      violations,
      `Rule 12 violation: contract imported but not invoked: ${violations.join(', ')}`
    ).toHaveLength(0);
  });

  it('exemptions are documented (each EXEMPT_MODULES entry has a non-empty reason)', () => {
    const violations: string[] = [];
    for (const entry of EXEMPT_MODULES) {
      if (typeof entry.reason !== 'string' || entry.reason.trim().length < 20) {
        violations.push(`${entry.module} (reason too short or missing)`);
      }
    }
    expect(violations).toHaveLength(0);
  });
});
