/**
 * ADR-101 — updating must work in every bundle. Three guards, EXECUTED
 * rather than grepped: the packager writes the descriptor into every
 * bundle (the afterPack hook, run against fake --dir outputs), the
 * release gate refuses a bundle whose descriptor is missing or names
 * another feed (the check script, run against fake bundles), and the
 * constants the hook, the updater and electron-builder's publish block
 * use are one and the same.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { LITE_UPDATE_FEED, feedDescriptorYaml } from '../../updater/feed.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const liteRoot = path.resolve(here, '../..');
const require = createRequire(import.meta.url);

interface HookContext {
  appOutDir: string;
  electronPlatformName: string;
  packager: {
    appInfo: { productFilename: string };
    platform: { nodeName: string };
    config: { publish?: unknown; win?: Record<string, unknown> };
  };
}

const hook = require(path.join(liteRoot, 'scripts/after-pack-update-descriptor.cjs')) as {
  (context: HookContext, env?: Record<string, string | undefined>): Promise<void>;
  DESCRIPTOR: Record<string, string>;
  render: (d: Record<string, string>, publisherName?: string[]) => string;
};

const PUBLISH = { provider: 'github', owner: 'wilsr7000', repo: 'Onereach_Lite_Desktop_App' };

function macBundle(): { out: string; target: string; context: HookContext } {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'lite-afterpack-'));
  const resources = path.join(out, 'Onereach.ai Lite.app', 'Contents', 'Resources');
  fs.mkdirSync(resources, { recursive: true });
  return {
    out,
    target: path.join(resources, 'app-update.yml'),
    context: {
      appOutDir: out,
      electronPlatformName: 'darwin',
      packager: { appInfo: { productFilename: 'Onereach.ai Lite' }, platform: { nodeName: 'darwin' }, config: { publish: { ...PUBLISH } } },
    },
  };
}

function winBundle(win: Record<string, unknown>): { out: string; target: string; context: HookContext } {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'lite-afterpack-win-'));
  fs.mkdirSync(path.join(out, 'resources'), { recursive: true });
  return {
    out,
    target: path.join(out, 'resources', 'app-update.yml'),
    context: {
      appOutDir: out,
      electronPlatformName: 'win32',
      packager: { appInfo: { productFilename: 'Onereach Desktop' }, platform: { nodeName: 'win32' }, config: { publish: { ...PUBLISH }, win } },
    },
  };
}

describe('after-pack hook', () => {
  it('is registered in electron-builder.json and its constants equal the updater feed', () => {
    const cfg = JSON.parse(fs.readFileSync(path.join(liteRoot, 'electron-builder.json'), 'utf8')) as { afterPack?: string; publish?: unknown };
    expect(cfg.afterPack).toBe('lite/scripts/after-pack-update-descriptor.cjs');
    expect(hook.DESCRIPTOR).toEqual({ ...LITE_UPDATE_FEED });
    expect(cfg.publish).toEqual({ provider: LITE_UPDATE_FEED.provider, owner: LITE_UPDATE_FEED.owner, repo: LITE_UPDATE_FEED.repo });
    expect(hook.render(hook.DESCRIPTOR)).toBe(feedDescriptorYaml());
  });

  it('writes app-update.yml into a mac --dir bundle that lacks it, and leaves one that has it', async () => {
    const { out, target, context } = macBundle();
    await hook(context);
    expect(fs.readFileSync(target, 'utf8')).toBe(feedDescriptorYaml());
    fs.writeFileSync(target, 'owner: someone-else\n', 'utf8');
    await hook(context);
    expect(fs.readFileSync(target, 'utf8')).toBe('owner: someone-else\n');
    fs.rmSync(out, { recursive: true, force: true });
  });

  it('fails the build when the publish block disagrees with the pinned feed instead of propagating the drift', async () => {
    const { out, target, context } = macBundle();
    context.packager.config.publish = { provider: 'github', owner: 'wilsr7000', repo: 'gsx-power-user' };
    await expect(hook(context)).rejects.toThrow(/publish block .*disagrees with the pinned update feed/);
    expect(fs.existsSync(target)).toBe(false);
    context.packager.config.publish = [{ ...PUBLISH }];
    await hook(context);
    expect(fs.readFileSync(target, 'utf8')).toBe(feedDescriptorYaml());
    fs.rmSync(out, { recursive: true, force: true });
  });

  it('on Windows writes publisherName (what NsisUpdater verifies against), refuses signing without one, and says when unsigned', async () => {
    const named = winBundle({ publisherName: 'Onereach Inc' });
    await hook(named.context, {});
    expect(fs.readFileSync(named.target, 'utf8')).toBe(feedDescriptorYaml() + 'publisherName:\n  - Onereach Inc\n');
    fs.rmSync(named.out, { recursive: true, force: true });

    const signedNoName = winBundle({ certificateSubjectName: 'Onereach Inc' });
    await expect(hook(signedNoName.context, {})).rejects.toThrow(/win\.publisherName/);
    expect(fs.existsSync(signedNoName.target)).toBe(false);
    fs.rmSync(signedNoName.out, { recursive: true, force: true });

    const envSigned = winBundle({});
    await expect(hook(envSigned.context, { WIN_CSC_LINK: 'file:///cert.pfx' })).rejects.toThrow(/win\.publisherName/);
    fs.rmSync(envSigned.out, { recursive: true, force: true });

    // Second review pass: every signing option app-builder-lib knows, not only the store-certificate ones.
    for (const win of [{ certificateFile: 'cert.pfx' }, { certificatePassword: 'x' }, { sign: './sign.js' }, { signtoolOptions: {} }]) {
      const b = winBundle(win);
      await expect(hook(b.context, {}), JSON.stringify(win)).rejects.toThrow(/win\.publisherName/);
      fs.rmSync(b.out, { recursive: true, force: true });
    }
    for (const env of [{ CSC_LINK: 'file:///c.pfx' }, { CSC_KEY_PASSWORD: 'p' }, { WIN_CSC_KEY_PASSWORD: 'p' }]) {
      const b = winBundle({});
      await expect(hook(b.context, env), JSON.stringify(env)).rejects.toThrow(/win\.publisherName/);
      fs.rmSync(b.out, { recursive: true, force: true });
    }

    const unsigned = winBundle({});
    await hook(unsigned.context, {});
    expect(fs.readFileSync(unsigned.target, 'utf8')).toBe(feedDescriptorYaml());
    fs.rmSync(unsigned.out, { recursive: true, force: true });
  });
});

describe('release gate', () => {
  const checker = path.join(liteRoot, 'scripts/check-update-descriptor.sh');

  function run(bundle: string): { status: number | null; out: string } {
    const r = spawnSync('bash', [checker, bundle], { encoding: 'utf8' });
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  }

  function bundleWith(descriptor: string | null): string {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'lite-gate-'));
    const app = path.join(out, 'Onereach.ai Lite.app');
    fs.mkdirSync(path.join(app, 'Contents', 'Resources'), { recursive: true });
    if (descriptor !== null) fs.writeFileSync(path.join(app, 'Contents', 'Resources', 'app-update.yml'), descriptor, 'utf8');
    return app;
  }

  it('the check script passes exactly the feed descriptor and fails a missing, drifted or absent bundle', () => {
    const exact = bundleWith(feedDescriptorYaml());
    expect(run(exact)).toMatchObject({ status: 0 });
    expect(run(exact).out).toContain('Updater descriptor names the feed');

    const tolerated = bundleWith('# generated\nowner: wilsr7000  \nrepo: Onereach_Lite_Desktop_App\n\nprovider: github\nupdaterCacheDirName: onereach-lite-updater\n');
    expect(run(tolerated).status).toBe(0);

    const missing = bundleWith(null);
    const m = run(missing);
    expect(m.status).toBe(1);
    expect(m.out).toContain('is missing');

    const drifted = bundleWith('owner: wilsr7000\nrepo: gsx-power-user\nprovider: github\nupdaterCacheDirName: gsx-power-user-updater\n');
    const d = run(drifted);
    expect(d.status).toBe(1);
    expect(d.out).toContain('does not name the feed');

    const unanchored = bundleWith('owner: wilsr7000\nrepo: Onereach_Lite_Desktop_App\nprovider: github\nupdaterCacheDirName: onereach-lite-updater\nupdaterCacheDirName: other\n');
    expect(run(unanchored).status).toBe(1);

    // The gate and the runtime agree on extra keys: what the hook writes for Windows (publisherName) passes, as would a channel.
    const withPublisher = bundleWith(feedDescriptorYaml() + 'publisherName:\n  - Onereach Inc\nchannel: latest\n');
    expect(run(withPublisher).status).toBe(0);
    const commentedOut = bundleWith('owner: wilsr7000\n# repo: Onereach_Lite_Desktop_App\nprovider: github\nupdaterCacheDirName: onereach-lite-updater\n');
    expect(run(commentedOut).status).toBe(1);
    const indentedComment = bundleWith(feedDescriptorYaml() + '  # trailing note\n');
    expect(run(indentedComment).status).toBe(0);
    const prefixed = bundleWith('owner: wilsr7000\nrepo: Onereach_Lite_Desktop_App_2\nprovider: github\nupdaterCacheDirName: onereach-lite-updater\n');
    expect(run(prefixed).status).toBe(1);

    expect(run('').status).toBe(1);
    expect(run(path.join(os.tmpdir(), 'does-not-exist.app')).status).toBe(1);

    for (const b of [exact, tolerated, missing, drifted, unanchored, withPublisher, commentedOut, indentedComment, prefixed]) fs.rmSync(path.dirname(b), { recursive: true, force: true });
  });

  it('release-lite.sh runs the check on the packaged bundle and aborts when no bundle is found — never a stale one elsewhere', () => {
    const script = fs.readFileSync(path.join(liteRoot, 'scripts/release-lite.sh'), 'utf8');
    expect(script).toContain('bash lite/scripts/check-update-descriptor.sh "$APP_BUNDLE" || exit 1');
    expect(script).toMatch(/if \[ -z "\$APP_BUNDLE" \]; then\n\s+echo -e "\$\{RED\}✗ No packaged \.app found[\s\S]{0,200}exit 1/);
    expect(script).not.toMatch(/APP_BUNDLE=\$\(find dist-lite -maxdepth 2/);
  });

  it('both release scripts are executable (the commit must keep mode 100755)', () => {
    for (const rel of ['scripts/release-lite.sh', 'scripts/check-update-descriptor.sh']) {
      const mode = fs.statSync(path.join(liteRoot, rel)).mode & 0o111;
      expect(mode, `${rel} should be executable`).not.toBe(0);
    }
  });
});

describe('updater init', () => {
  it('index.ts hands the packaged paths to initAutoUpdater (behaviour is covered in updater/init.test.ts)', () => {
    const index = fs.readFileSync(path.join(liteRoot, 'updater/index.ts'), 'utf8');
    expect(index).toContain('if (app.isPackaged) initOpts.packaged = { resourcesPath: process.resourcesPath, userDataPath };');
    expect(index).toContain("import { packagedFeedState } from './init.js';");
  });
});
