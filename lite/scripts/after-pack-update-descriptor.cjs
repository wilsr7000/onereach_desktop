/**
 * electron-builder afterPack hook (ADR-101): every bundle carries
 * `app-update.yml`, including `--dir` (fast) builds — electron-builder's
 * own writer is a system afterPack listener that runs before user hooks
 * and only for release targets, so on release builds this is a no-op
 * (the file exists) and on `--dir` builds it is the only writer. It runs
 * before signing, so the file is inside the code seal.
 *
 * The descriptor is the pinned feed (mirrored from lite/updater/feed.ts —
 * this file is CommonJS loaded by electron-builder; updater-feed-guards
 * .test.ts pins the two). A `publish` block that disagrees FAILS the build
 * rather than silently propagating: the updater in the app follows the
 * pinned feed, and a bundle whose descriptor says otherwise would be a lie.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DESCRIPTOR = {
  owner: 'wilsr7000',
  repo: 'Onereach_Lite_Desktop_App',
  provider: 'github',
  updaterCacheDirName: 'onereach-lite-updater',
};

/** Where the descriptor lives for a platform's packed output. */
function descriptorPath(context) {
  const platform = context.electronPlatformName || context.packager.platform.nodeName;
  if (platform === 'darwin') {
    const appName = `${context.packager.appInfo.productFilename}.app`;
    return path.join(context.appOutDir, appName, 'Contents', 'Resources', 'app-update.yml');
  }
  return path.join(context.appOutDir, 'resources', 'app-update.yml');
}

function render(descriptor, publisherName) {
  let out =
    `owner: ${descriptor.owner}\n` +
    `repo: ${descriptor.repo}\n` +
    `provider: ${descriptor.provider}\n` +
    `updaterCacheDirName: ${descriptor.updaterCacheDirName}\n`;
  if (Array.isArray(publisherName) && publisherName.length > 0) {
    out += 'publisherName:\n' + publisherName.map((n) => `  - ${n}\n`).join('');
  }
  return out;
}

/** The publish block, whatever shape electron-builder allows. */
function publishConfig(context) {
  const publish = context.packager.config.publish;
  return Array.isArray(publish) ? publish[0] : publish;
}

/**
 * On Windows the descriptor's `publisherName` is what NsisUpdater
 * verifies downloads against; without it, verification is silently
 * skipped. So: signed Windows builds must declare `win.publisherName`
 * (written here), an unsigned dev build gets no verification (say so),
 * and a signing identity without a publisher name fails the build.
 */
function windowsPublisher(context, env) {
  const win = context.packager.config.win || {};
  const names = Array.isArray(win.publisherName) ? win.publisherName : typeof win.publisherName === 'string' ? [win.publisherName] : [];
  // Every way app-builder-lib can be told WHAT to sign a Windows build
  // with: a certificate file (config or CSC_LINK / WIN_CSC_LINK), a store
  // certificate by subject or SHA-1, a custom sign function, signtool
  // options. A password on its own signs nothing — and CSC_KEY_PASSWORD
  // is the macOS variable too, so a Windows build in a mac-signing shell
  // must not trip on it (third review pass).
  const signing = Boolean(
    env.WIN_CSC_LINK || env.CSC_LINK || win.certificateFile || win.certificateSubjectName || win.certificateSha1 || win.sign || win.signtoolOptions
  );
  if (names.length > 0) return names;
  if (signing) {
    throw new Error(
      '[after-pack] Windows signing is configured but win.publisherName is not: the update descriptor would ship without a publisher and downloads would not be verified. Set win.publisherName in lite/electron-builder.json.'
    );
  }
  console.warn('[after-pack] unsigned Windows build: app-update.yml carries no publisherName, so downloaded updates are NOT signature-verified');
  return [];
}

async function afterPack(context, env = process.env) {
  const target = descriptorPath(context);
  const publish = publishConfig(context);
  if (publish && publish.provider !== undefined) {
    const same = publish.provider === DESCRIPTOR.provider && publish.owner === DESCRIPTOR.owner && publish.repo === DESCRIPTOR.repo;
    if (!same) {
      throw new Error(
        `[after-pack] electron-builder publish block (${publish.provider}:${publish.owner}/${publish.repo}) disagrees with the pinned update feed (${DESCRIPTOR.provider}:${DESCRIPTOR.owner}/${DESCRIPTOR.repo}) — fix one of them; the app follows lite/updater/feed.ts.`
      );
    }
  }
  if (fs.existsSync(target)) {
    console.log(`[after-pack] app-update.yml already present: ${target}`);
    return;
  }
  const platform = context.electronPlatformName || context.packager.platform.nodeName;
  const publisherName = platform === 'win32' ? windowsPublisher(context, env) : [];
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, render(DESCRIPTOR, publisherName), 'utf8');
  console.log(`[after-pack] wrote app-update.yml (${DESCRIPTOR.provider}:${DESCRIPTOR.owner}/${DESCRIPTOR.repo}) → ${target}`);
}

module.exports = afterPack;
module.exports.DESCRIPTOR = DESCRIPTOR;
module.exports.descriptorPath = descriptorPath;
module.exports.render = render;
module.exports.windowsPublisher = windowsPublisher;
