/**
 * ADR-101 — updating must work in every bundle. Three guards, pinned at
 * the source: the packager writes the descriptor into every bundle (the
 * afterPack hook, run against a fake --dir output), the release script
 * refuses a bundle without it, and the constants the hook, the updater
 * and electron-builder's publish block use are one and the same.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { LITE_UPDATE_FEED, feedDescriptorYaml } from '../../updater/feed.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const liteRoot = path.resolve(here, '../..');
const require = createRequire(import.meta.url);

describe('after-pack hook', () => {
  const hook = require(path.join(liteRoot, 'scripts/after-pack-update-descriptor.cjs')) as {
    (context: unknown): Promise<void>;
    DESCRIPTOR: Record<string, string>;
    render: (d: Record<string, string>) => string;
  };

  it('is registered in electron-builder.json and its constants equal the updater feed', () => {
    const cfg = JSON.parse(fs.readFileSync(path.join(liteRoot, 'electron-builder.json'), 'utf8')) as { afterPack?: string; publish?: { provider: string; owner: string; repo: string } };
    expect(cfg.afterPack).toBe('lite/scripts/after-pack-update-descriptor.cjs');
    expect(hook.DESCRIPTOR).toEqual({ ...LITE_UPDATE_FEED });
    expect(cfg.publish).toEqual({ provider: LITE_UPDATE_FEED.provider, owner: LITE_UPDATE_FEED.owner, repo: LITE_UPDATE_FEED.repo });
    expect(hook.render(hook.DESCRIPTOR)).toBe(feedDescriptorYaml());
  });

  it('writes app-update.yml into a mac --dir bundle that lacks it, and leaves one that has it', async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'lite-afterpack-'));
    const resources = path.join(out, 'Onereach.ai Lite.app', 'Contents', 'Resources');
    fs.mkdirSync(resources, { recursive: true });
    const context = {
      appOutDir: out,
      electronPlatformName: 'darwin',
      packager: { appInfo: { productFilename: 'Onereach.ai Lite' }, platform: { nodeName: 'darwin' }, config: { publish: { provider: 'github', owner: 'wilsr7000', repo: 'Onereach_Lite_Desktop_App' } } },
    };
    await hook(context);
    const target = path.join(resources, 'app-update.yml');
    expect(fs.readFileSync(target, 'utf8')).toBe(feedDescriptorYaml());
    fs.writeFileSync(target, 'owner: someone-else\n', 'utf8');
    await hook(context);
    expect(fs.readFileSync(target, 'utf8')).toBe('owner: someone-else\n');
    fs.rmSync(out, { recursive: true, force: true });
  });
});

describe('release gate', () => {
  it('release-lite.sh refuses a bundle without the descriptor or with another feed', () => {
    const script = fs.readFileSync(path.join(liteRoot, 'scripts/release-lite.sh'), 'utf8');
    expect(script).toContain('UPDATE_DESCRIPTOR="$APP_BUNDLE/Contents/Resources/app-update.yml"');
    expect(script).toMatch(/if \[ ! -f "\$UPDATE_DESCRIPTOR" \]; then[\s\S]{0,300}exit 1/);
    expect(script).toContain('repo: Onereach_Lite_Desktop_App');
    expect(script).toContain('updaterCacheDirName: onereach-lite-updater');
  });
});

describe('updater init', () => {
  it('sets the feed from code for packaged apps (source pin)', () => {
    const src = fs.readFileSync(path.join(liteRoot, 'updater/init.ts'), 'utf8');
    expect(src).toContain("autoUpdater.setFeedURL({ ...LITE_UPDATE_FEED })");
    const index = fs.readFileSync(path.join(liteRoot, 'updater/index.ts'), 'utf8');
    expect(index).toContain('if (app.isPackaged) initOpts.packaged = { resourcesPath: process.resourcesPath, userDataPath };');
  });
});
