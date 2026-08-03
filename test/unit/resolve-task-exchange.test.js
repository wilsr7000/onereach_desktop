/**
 * resolve-task-exchange -- packaging shim for @onereach/task-exchange
 *
 * Regression for the boot failure "Cannot find module
 * '@onereach/task-exchange/types'" (dynamic agents + spelling agent disabled
 * for the whole session): the workspace symlink for the package is not
 * materialized in dev after fresh installs, and never inside app.asar.
 * ensure() installs a Module._resolveFilename fallback mapping the bare
 * specifier (and subpaths) onto packages/task-exchange/dist.
 */

import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO = resolve(__dirname, '..', '..');
const shim = require('../../lib/resolve-task-exchange.js');

describe('resolve-task-exchange.ensure()', () => {
  it('the dist it aliases to actually exists in the repo (bundled into asar)', () => {
    expect(existsSync(resolve(REPO, 'packages/task-exchange/dist/index.js'))).toBe(true);
    expect(existsSync(resolve(REPO, 'packages/task-exchange/dist/types/index.js'))).toBe(true);
  });

  it('after ensure(), the bare specifier and /types subpath both resolve', () => {
    expect(shim.ensure()).toBe(true);
    // require.resolve (no execution) proves resolution works either natively
    // (symlink present) or via the shim (symlink absent).
    expect(() => require.resolve('@onereach/task-exchange')).not.toThrow();
    expect(() => require.resolve('@onereach/task-exchange/types')).not.toThrow();
  });

  it('resolution lands on real files', () => {
    shim.ensure();
    expect(existsSync(require.resolve('@onereach/task-exchange'))).toBe(true);
    expect(existsSync(require.resolve('@onereach/task-exchange/types'))).toBe(true);
  });

  it('is idempotent', () => {
    expect(shim.ensure()).toBe(true);
    expect(shim.ensure()).toBe(true);
  });

  it('the SDK consumers actually install the shim before requiring the SDK', () => {
    for (const f of ['packages/agents/dynamic-agent.js', 'packages/agents/spelling-agent.js']) {
      const src = require('node:fs').readFileSync(resolve(REPO, f), 'utf8');
      const shimIdx = src.indexOf("resolve-task-exchange').ensure()");
      const sdkIdx = src.indexOf("require('../task-agent/dist/index.js')");
      expect(shimIdx, `${f} must install the shim`).toBeGreaterThan(-1);
      expect(sdkIdx, `${f} must require the SDK`).toBeGreaterThan(-1);
      expect(shimIdx).toBeLessThan(sdkIdx);
    }
  });
});
