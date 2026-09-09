/**
 * electron-builder afterPack hook (ADR-101): every bundle carries
 * `app-update.yml`, including `--dir` (fast) builds, which electron-builder
 * only writes the descriptor for when it produces a release target. It runs
 * before signing, so the file is inside the code seal.
 *
 * The content is the same descriptor electron-builder writes for the
 * `publish` block; the cache dir name is pinned in lite/updater/feed.ts and
 * repeated here (this file is CommonJS loaded by electron-builder, the
 * updater module is TypeScript) — `updater-feed-guards.test.ts` pins the two.
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

function render(descriptor) {
  return (
    `owner: ${descriptor.owner}\n` +
    `repo: ${descriptor.repo}\n` +
    `provider: ${descriptor.provider}\n` +
    `updaterCacheDirName: ${descriptor.updaterCacheDirName}\n`
  );
}

async function afterPack(context) {
  const target = descriptorPath(context);
  if (fs.existsSync(target)) {
    console.log(`[after-pack] app-update.yml already present: ${target}`);
    return;
  }
  const publish = Array.isArray(context.packager.config.publish)
    ? context.packager.config.publish[0]
    : context.packager.config.publish;
  const descriptor = {
    ...DESCRIPTOR,
    ...(publish && publish.provider === 'github' && publish.owner && publish.repo
      ? { owner: publish.owner, repo: publish.repo }
      : {}),
  };
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, render(descriptor), 'utf8');
  console.log(`[after-pack] wrote app-update.yml (${descriptor.provider}:${descriptor.owner}/${descriptor.repo}) → ${target}`);
}

module.exports = afterPack;
module.exports.DESCRIPTOR = DESCRIPTOR;
module.exports.descriptorPath = descriptorPath;
module.exports.render = render;
