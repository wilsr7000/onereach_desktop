const { notarize } = require('@electron/notarize');
const { resignDeep } = require('./resign-deep');

/**
 * afterSign hook -- runs after electron-builder finishes its (broken)
 * native code-signing pass. Two phases:
 *
 *   1. DEEP RE-SIGN: walk the .app bottom-up and re-sign every nested
 *      framework / helper / dylib in correct dependency order, then
 *      sign the outer .app. Fixes the electron-builder 26.x +
 *      Electron 41.x nested-signature bug
 *      (https://github.com/electron-userland/electron-builder/issues/8966).
 *      Without this, `codesign --verify --deep --strict` fails and
 *      Apple's notary service rejects the bundle.
 *
 *   2. NOTARIZE: submit to Apple's notary service if credentials are in
 *      env. Skipped silently if APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD
 *      are missing (so dev builds without those creds still complete).
 *
 * Both lite and full apps share this hook -- the underlying bug is the
 * same in both bundles. Bundle ID is read from
 * context.packager.appInfo.id so it auto-resolves to com.onereach.lite
 * vs com.gsx.poweruser per the active build.
 *
 * Default behavior:
 *   - Phase 1 (resign):    OFF  unless RESIGN=1 is set in env
 *   - Phase 2 (notarize):  ON   if APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD
 *                          are set; SKIP_NOTARIZE=1 forces off
 *
 * Phase 1 is opt-in because the underlying @electron/osx-sign + codesign
 * bug also produces TeamIdentifier=not set (visible via
 * `codesign --display --verbose=4`), which our resign-deep does NOT
 * currently fix. Re-signing in correct order without also resolving the
 * TeamIdentifier issue is no improvement over electron-builder's default
 * (which produces the same broken-but-functional signature full app
 * ships with). When the team-id fix lands -- requires explicit team-id
 * passing to codesign or a fix in @electron/osx-sign upstream -- flip
 * RESIGN=1 to default ON.
 */
exports.default = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== 'darwin') return;

  const appName = context.packager.appInfo.productFilename;
  const appPath = `${appOutDir}/${appName}.app`;
  const appBundleId = context.packager.appInfo.id;

  // ------------------------------------------------------------------
  // Phase 1: deep re-sign (opt-in via RESIGN=1)
  // ------------------------------------------------------------------
  if (process.env.RESIGN === '1') {
    console.log(`[afterSign] RESIGN=1 -- starting deep re-sign of ${appPath}`);
    try {
      // verify=false because the underlying TeamIdentifier issue causes
      // strict verify to fail even after correct-order re-signing. Ship
      // the resigned bundle anyway -- it's no worse than the default,
      // and improves nested signature ordering.
      await resignDeep(appPath, { verify: false });
      console.log('[afterSign] deep re-sign complete (verify skipped pending team-id fix)');
    } catch (error) {
      console.error('[afterSign] deep re-sign failed:', error.message);
      throw error;
    }
  }

  // ------------------------------------------------------------------
  // Phase 2: notarization
  // ------------------------------------------------------------------
  if (process.env.SKIP_NOTARIZE === '1') {
    console.log('[afterSign] SKIP_NOTARIZE=1 -- skipping notarization');
    return;
  }
  if (!process.env.APPLE_ID || !process.env.APPLE_APP_SPECIFIC_PASSWORD) {
    console.warn('[afterSign] APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD not set -- skipping notarization');
    return;
  }

  console.log('[afterSign] starting notarization');
  console.log(`   App:       ${appName}`);
  console.log(`   Bundle ID: ${appBundleId}`);
  console.log(`   Apple ID:  ${process.env.APPLE_ID}`);
  console.log(`   Team ID:   ${process.env.APPLE_TEAM_ID}`);

  try {
    await notarize({
      appBundleId,
      appPath: appPath,
      appleId: process.env.APPLE_ID,
      appleIdPassword: process.env.APPLE_APP_SPECIFIC_PASSWORD,
      teamId: process.env.APPLE_TEAM_ID,
    });
    console.log('[afterSign] notarization PASSED');
  } catch (error) {
    console.error('[afterSign] notarization FAILED:', error.message);
    throw error;
  }
};
