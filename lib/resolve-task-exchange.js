/**
 * resolve-task-exchange - runtime module-resolution shim for the workspace
 * package `@onereach/task-exchange`.
 *
 * The task-agent SDK's compiled dist requires `@onereach/task-exchange` and
 * `@onereach/task-exchange/types` by bare specifier. That resolution depends
 * on a node_modules/@onereach symlink that is not always materialized -- and
 * is NEVER materialized inside the packaged app.asar. Result (seen in the
 * 2026-08-03 boot log): "Cannot find module '@onereach/task-exchange/types'"
 * -> dynamic agents disabled for the whole session.
 *
 * ensure() checks whether the bare specifier resolves; if not, it installs a
 * Module._resolveFilename fallback that maps the package (and its subpaths)
 * to packages/task-exchange/dist, which IS bundled. Idempotent, and a no-op
 * whenever normal resolution works.
 */

'use strict';

const path = require('path');
const fs = require('fs');

let _installed = false;

function ensure() {
  if (_installed) return true;
  try {
    require.resolve('@onereach/task-exchange/types');
    return true; // normal resolution works; nothing to do
  } catch (_e) {
    /* fall through to install the shim */
  }

  const distRoot = path.join(__dirname, '..', 'packages', 'task-exchange', 'dist');
  if (!fs.existsSync(path.join(distRoot, 'index.js'))) {
    // Nothing to alias to -- leave resolution alone so callers get the
    // original, accurate MODULE_NOT_FOUND.
    return false;
  }

  const Module = require('module');
  const orig = Module._resolveFilename;
  const PKG = '@onereach/task-exchange';
  Module._resolveFilename = function (request, ...rest) {
    if (typeof request === 'string' && request.startsWith(PKG)) {
      const sub = request.slice(PKG.length).replace(/^\//, '');
      const target = sub === '' ? path.join(distRoot, 'index.js') : path.join(distRoot, sub, 'index.js');
      const flat = sub === '' ? target : path.join(distRoot, `${sub}.js`);
      const resolved = fs.existsSync(target) ? target : flat;
      return orig.call(this, resolved, ...rest);
    }
    return orig.call(this, request, ...rest);
  };
  _installed = true;
  return true;
}

// Test seam: report whether the shim is active without side effects.
function isInstalled() {
  return _installed;
}

module.exports = { ensure, isInstalled };
