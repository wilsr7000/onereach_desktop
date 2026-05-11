/**
 * Deep re-sign an Electron .app bundle in correct dependency order.
 *
 * Background
 * ----------
 * electron-builder 26.x + Electron 41.x ships with a known signing-order
 * bug: nested frameworks/helpers are sometimes signed AFTER the items
 * that reference them, which produces malformed nested signatures that
 * fail `codesign --verify --deep --strict` and Apple's notary service.
 * Upstream issue:
 *   https://github.com/electron-userland/electron-builder/issues/8966
 *
 * Workaround
 * ----------
 * After electron-builder finishes its own (broken) signing pass, we:
 *   1. Walk the bundle bottom-up
 *   2. Strip every existing signature
 *   3. Re-sign each item innermost-first using a single, consistent
 *      identity, entitlements, and hardened runtime configuration
 *   4. Sign the outer .app last
 *   5. Verify with `codesign --verify --deep --strict --verbose=4`
 *
 * Both lite and full use this script via `scripts/notarize.js`'s
 * afterSign hook -- the bug is identical in both bundles.
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_IDENTITY = 'Developer ID Application: OneReach, Inc. (6KTEPA3LSD)';
const DEFAULT_ENTITLEMENTS = path.resolve(__dirname, '..', 'build', 'entitlements.mac.plist');

/**
 * Sign a single item with consistent flags. Errors are logged with the
 * item path so the failing nested bundle is obvious.
 */
function signItem(itemPath, options) {
  const args = [
    '--force',
    '--sign',
    options.identity,
    '--options',
    'runtime',
  ];
  // --timestamp asks codesign to contact Apple's timestamp authority
  // (timestamp.apple.com). That service goes down periodically; when it's
  // unreachable, codesign exits with "A timestamp was expected but was not
  // found" and the re-sign aborts mid-bundle. Skip the flag when the caller
  // sets `timestamp: false` so we can still produce a structurally-valid
  // (just not Apple-timestamped) signature for unnotarized distribution.
  if (options.timestamp !== false) {
    args.push('--timestamp');
  }
  // Hardened runtime requires entitlements on items that have an
  // executable. Frameworks without an executable inherit their parent's
  // entitlements, so attaching entitlements to leaf .dylib files is a no-op.
  // Apply entitlements to .app bundles always; to frameworks only when
  // they contain a Mach-O executable; skip for plain dylibs.
  if (options.attachEntitlements) {
    args.push('--entitlements', options.entitlements);
  }
  args.push(itemPath);
  try {
    execFileSync('codesign', args, { stdio: 'pipe' });
  } catch (err) {
    const stderr = (err.stderr ? err.stderr.toString() : '') || err.message;
    throw new Error(
      `codesign --sign failed on ${itemPath}\n  identity: ${options.identity}\n  stderr: ${stderr}`
    );
  }
}

/**
 * Strip an existing signature from an item. Failures are tolerated
 * because not every item has a signature to strip (and codesign exits
 * non-zero in that case).
 */
function removeSignature(itemPath) {
  try {
    execFileSync('codesign', ['--remove-signature', itemPath], { stdio: 'pipe' });
  } catch {
    // Item wasn't signed -- fine, we're about to sign it.
  }
}

/**
 * Decide whether an item should be signed with --entitlements attached.
 * - .app bundles: yes (they carry their own runtime entitlements)
 * - .framework bundles: only if they have an executable in Versions/A
 *   (e.g. Electron Framework yes; Mantle yes; ReactiveObjC yes)
 * - .dylib / .so / .node: no (no executable, no entitlements needed)
 */
function shouldAttachEntitlements(itemPath) {
  if (itemPath.endsWith('.app')) return true;
  if (itemPath.endsWith('.framework')) {
    // A framework with an executable has Versions/A/<FrameworkName>
    const name = path.basename(itemPath, '.framework');
    const exec = path.join(itemPath, 'Versions', 'A', name);
    return fs.existsSync(exec);
  }
  return false;
}

/**
 * Recursively collect every signable item under a path. Returns paths
 * sorted DEEPEST-FIRST so leaves are signed before the things that
 * reference them. .app and .framework directories are listed; we do NOT
 * recurse into them past their own boundary (they're signed as a unit).
 */
function findSignableItems(rootDir, results = []) {
  let entries;
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const full = path.join(rootDir, entry.name);
    if (entry.isSymbolicLink()) continue; // Don't follow Versions/Current symlinks
    if (entry.isDirectory()) {
      // .app and .framework are signable units -- record but do NOT recurse
      if (entry.name.endsWith('.app') || entry.name.endsWith('.framework')) {
        // Recurse FIRST so anything nested inside them gets listed deeper
        findSignableItems(full, results);
        results.push(full);
      } else {
        findSignableItems(full, results);
      }
    } else if (entry.isFile()) {
      if (
        entry.name.endsWith('.dylib') ||
        entry.name.endsWith('.so') ||
        entry.name.endsWith('.node')
      ) {
        results.push(full);
      }
    }
  }
  return results;
}

/**
 * Re-sign an entire .app bundle deeply in the correct order.
 *
 * @param {string} appPath - Absolute path to the .app to re-sign.
 * @param {object} [options]
 * @param {string} [options.identity]      - Code-signing identity (CN). Defaults to OneReach Developer ID.
 * @param {string} [options.entitlements]  - Path to entitlements plist. Defaults to build/entitlements.mac.plist.
 * @param {boolean} [options.verify=true]  - Run codesign --verify --deep --strict after.
 * @param {boolean} [options.timestamp=true] - Pass --timestamp to codesign. Set false when Apple's
 *                                              timestamp.apple.com:443 is unreachable (the resign aborts
 *                                              otherwise). Bundles signed without --timestamp are valid
 *                                              for Gatekeeper but cannot be notarized.
 * @param {(msg: string) => void} [options.log] - Logger; defaults to console.log.
 */
async function resignDeep(appPath, options = {}) {
  const identity = options.identity || process.env.SIGN_IDENTITY || DEFAULT_IDENTITY;
  const entitlements = options.entitlements || DEFAULT_ENTITLEMENTS;
  const verify = options.verify !== false;
  const timestamp = options.timestamp !== false;
  const log = options.log || ((m) => console.log(m));

  if (!fs.existsSync(appPath)) {
    throw new Error(`resignDeep: app not found at ${appPath}`);
  }
  if (!fs.existsSync(entitlements)) {
    throw new Error(`resignDeep: entitlements not found at ${entitlements}`);
  }

  log(`[resign-deep] target app: ${appPath}`);
  log(`[resign-deep] identity:   ${identity}`);
  log(`[resign-deep] entitlements: ${entitlements}`);
  log(`[resign-deep] timestamp:  ${timestamp ? 'enabled (Apple TSA)' : 'DISABLED'}`);

  // 1. Collect every nested signable item from inside the .app, sorted
  //    deepest-first. The outer .app itself is signed at the very end.
  const items = findSignableItems(appPath);
  // Filter: anything found ABOVE the outer .app (shouldn't happen) is dropped.
  const insideOuter = items.filter((p) => p !== appPath);
  log(`[resign-deep] found ${insideOuter.length} nested signable items`);

  // 2. Strip + re-sign every nested item.
  let signedCount = 0;
  for (const item of insideOuter) {
    removeSignature(item);
    signItem(item, {
      identity,
      entitlements,
      timestamp,
      attachEntitlements: shouldAttachEntitlements(item),
    });
    signedCount += 1;
    if (signedCount % 25 === 0) {
      log(`[resign-deep]   signed ${signedCount}/${insideOuter.length}...`);
    }
  }
  log(`[resign-deep] signed ${signedCount} nested items`);

  // 3. Strip + re-sign the outer .app.
  removeSignature(appPath);
  signItem(appPath, {
    identity,
    entitlements,
    timestamp,
    attachEntitlements: true,
  });
  log(`[resign-deep] signed outer .app`);

  // 4. Verify.
  if (verify) {
    log('[resign-deep] running codesign --verify --deep --strict --verbose=4...');
    try {
      execFileSync(
        'codesign',
        ['--verify', '--deep', '--strict', '--verbose=4', appPath],
        { stdio: 'pipe' }
      );
      log('[resign-deep] verify PASSED');
    } catch (err) {
      const stderr = (err.stderr ? err.stderr.toString() : '') || err.message;
      throw new Error(`codesign --verify --deep --strict failed:\n${stderr}`);
    }
  }
}

module.exports = { resignDeep, findSignableItems };

// CLI entrypoint for ad-hoc use:  node scripts/resign-deep.js <path-to-app>
if (require.main === module) {
  const target = process.argv[2];
  if (!target) {
    console.error('Usage: node scripts/resign-deep.js <path-to-.app>');
    process.exit(2);
  }
  resignDeep(path.resolve(target)).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
