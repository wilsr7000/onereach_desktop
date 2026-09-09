/**
 * Unit tests for lite/updater/init.ts -- electron-updater configuration.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  initAutoUpdater,
  applyPackagedFeed,
  packagedFeedState,
  parseDescriptor,
  descriptorMatchesFeed,
  type AutoUpdaterLike,
  type PackagedFs,
} from '../../../updater/init.js';
import { LITE_UPDATE_FEED, feedDescriptorYaml, releasesUrl } from '../../../updater/feed.js';

function makeFakeUpdater(): AutoUpdaterLike {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  return {
    logger: null,
    autoDownload: true,
    autoInstallOnAppQuit: false,
    allowDowngrade: true,
    updateConfigPath: null,
    getFeedURL: () => 'fake://feed',
    on: (event, listener) => {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event)!.push(listener);
      return null;
    },
    off: (event, listener) => {
      const arr = listeners.get(event) ?? [];
      const idx = arr.indexOf(listener);
      if (idx >= 0) arr.splice(idx, 1);
      return null;
    },
    removeAllListeners: () => {
      listeners.clear();
      return null;
    },
    checkForUpdates: vi.fn().mockResolvedValue(null),
    downloadUpdate: vi.fn().mockResolvedValue([]),
    quitAndInstall: vi.fn(),
  };
}

describe('initAutoUpdater', () => {
  it('applies the lite configuration: autoDownload=false, autoInstallOnAppQuit=true, allowDowngrade=false', () => {
    const fake = makeFakeUpdater();
    const result = initAutoUpdater({ loadAutoUpdater: () => fake });
    expect(result).toBe(fake);
    expect(fake.autoDownload).toBe(false);
    expect(fake.autoInstallOnAppQuit).toBe(true);
    expect(fake.allowDowngrade).toBe(false);
  });

  it('wires a logger that forwards to the supplied logger', () => {
    const fake = makeFakeUpdater();
    const log = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    initAutoUpdater({ loadAutoUpdater: () => fake, logger: log });
    const wired = fake.logger as { info: (m: unknown) => void; warn: (m: unknown) => void; error: (m: unknown) => void; debug: (m: unknown) => void };
    wired.info('hello');
    wired.warn('warn');
    wired.error('err');
    wired.debug('debug');
    expect(log.info).toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalled();
    expect(log.error).toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalled();
  });

  it('returns null when electron-updater fails to load (broken install)', () => {
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const result = initAutoUpdater({
      loadAutoUpdater: () => {
        throw new Error('module not found');
      },
      logger: log,
    });
    expect(result).toBeNull();
    expect(log.warn).toHaveBeenCalledWith(
      'updater: electron-updater not available',
      expect.objectContaining({ error: 'module not found' })
    );
  });

  it('does NOT set updateConfigPath when devUpdateConfigPath does not exist', () => {
    const fake = makeFakeUpdater();
    initAutoUpdater({
      loadAutoUpdater: () => fake,
      devUpdateConfigPath: '/tmp/this-file-does-not-exist-' + Math.random().toString(36),
    });
    expect(fake.updateConfigPath).toBeNull();
  });
});


// ─── ADR-101: the feed lives in code ─────────────────────────────────────

type FakeFs = PackagedFs & { files: Map<string, string>; written: Map<string, string>; dirs: string[] };

/** A bundle is `files` (path → content); what the updater writes lands in `written`. */
function fakeFs(files: Record<string, string> = {}): FakeFs {
  const fileMap = new Map(Object.entries(files));
  const written = new Map<string, string>();
  const dirs: string[] = [];
  return {
    files: fileMap,
    written,
    dirs,
    existsSync: (p) => fileMap.has(p) || written.has(p),
    readFileSync: (p) => {
      const v = fileMap.get(p) ?? written.get(p);
      if (v === undefined) throw new Error(`ENOENT: ${p}`);
      return v;
    },
    mkdirSync: (p) => dirs.push(p),
    writeFileSync: (p, data) => {
      written.set(p, data);
    },
  };
}

function quietLog(): {
  info: ReturnType<typeof vi.fn<(msg: string, data?: unknown) => void>>;
  warn: ReturnType<typeof vi.fn<(msg: string, data?: unknown) => void>>;
  error: ReturnType<typeof vi.fn<(msg: string, data?: unknown) => void>>;
} {
  return {
    info: vi.fn((_msg: string, _data?: unknown): void => undefined),
    warn: vi.fn((_msg: string, _data?: unknown): void => undefined),
    error: vi.fn((_msg: string, _data?: unknown): void => undefined),
  };
}

const RES = '/App.app/Contents/Resources';
const BUNDLED = `${RES}/app-update.yml`;
const FALLBACK = '/ud/app-update.yml';
const packagedOpts = (fs: PackagedFs): NonNullable<Parameters<typeof applyPackagedFeed>[1]> => ({ resourcesPath: RES, userDataPath: '/ud', fs });

type SetFeedMock = ReturnType<typeof vi.fn<(options: Record<string, unknown>) => void>>;
type DownloadMock = ReturnType<typeof vi.fn<() => Promise<string[]>>>;

function packagedFake(): AutoUpdaterLike & { setFeedURL: SetFeedMock; download: DownloadMock } {
  const setFeedURL: SetFeedMock = vi.fn((_options: Record<string, unknown>): void => undefined);
  const download: DownloadMock = vi.fn(async (): Promise<string[]> => ['/cache/pending/update.zip']);
  const fake = makeFakeUpdater();
  fake.setFeedURL = setFeedURL;
  fake.downloadUpdate = download as unknown as AutoUpdaterLike['downloadUpdate'];
  return Object.assign(fake, { setFeedURL, download });
}

describe('packaged feed (ADR-101)', () => {
  it('sets the provider from code and leaves a bundle whose descriptor names our feed alone', () => {
    const fake = packagedFake();
    const fs = fakeFs({ [BUNDLED]: feedDescriptorYaml() });
    const log = quietLog();
    const result = applyPackagedFeed(fake, packagedOpts(fs), log);
    expect(result).toEqual({ feedFromCode: true, descriptor: 'bundle' });
    expect(fake.setFeedURL).toHaveBeenCalledWith({ ...LITE_UPDATE_FEED });
    expect(fs.written.size).toBe(0);
    expect(fake.updateConfigPath).toBeNull();
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
  });

  it('writes the descriptor under userData and points the updater at it when the bundle has none', () => {
    const fake = packagedFake();
    const fs = fakeFs();
    const log = quietLog();
    const result = applyPackagedFeed(fake, packagedOpts(fs), log);
    expect(result).toEqual({ feedFromCode: true, descriptor: 'written', reason: 'missing', fallbackPath: FALLBACK });
    expect(fake.updateConfigPath).toBe(FALLBACK);
    expect(fs.written.get(FALLBACK)).toBe(feedDescriptorYaml());
    expect(fs.dirs).toEqual(['/ud']);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it('ignores a bundle descriptor that names another feed (the gsx-power-user-updater drift class)', () => {
    const fake = packagedFake();
    const drifted = 'owner: wilsr7000\nrepo: gsx-power-user\nprovider: github\nupdaterCacheDirName: gsx-power-user-updater\n';
    const fs = fakeFs({ [BUNDLED]: drifted });
    const log = quietLog();
    const result = applyPackagedFeed(fake, packagedOpts(fs), log);
    expect(result).toEqual({ feedFromCode: true, descriptor: 'written', reason: 'drift', fallbackPath: FALLBACK });
    expect(fake.updateConfigPath).toBe(FALLBACK);
    expect(fs.written.get(FALLBACK)).toBe(feedDescriptorYaml());
    expect(fs.files.get(BUNDLED)).toBe(drifted);
    expect(log.warn.mock.calls[0]?.[0]).toContain('names another feed');
  });

  it('accepts a bundle descriptor with comments, CRLF and extra keys, but not a wrong key', () => {
    expect(descriptorMatchesFeed('# generated\r\nowner: wilsr7000\r\nrepo: Onereach_Lite_Desktop_App\r\nprovider: github\r\nupdaterCacheDirName: onereach-lite-updater\r\npublisherName:\r\n  - Onereach\r\n')).toBe(true);
    expect(descriptorMatchesFeed(feedDescriptorYaml().replace('provider: github', 'provider: generic'))).toBe(false);
    expect(descriptorMatchesFeed(feedDescriptorYaml().replace('owner: wilsr7000', 'owner: someone'))).toBe(false);
    expect(descriptorMatchesFeed('')).toBe(false);
    expect(parseDescriptor('a: 1\n b : two words \n#c: 3\nnocolon\n')).toEqual({ a: '1', b: 'two words' });
  });

  it('rewrites the userData descriptor right before every download (it is user-writable and read at download time)', async () => {
    const fake = packagedFake();
    const fs = fakeFs();
    applyPackagedFeed(fake, packagedOpts(fs), quietLog());
    fs.written.set(FALLBACK, 'owner: x\nrepo: y\nprovider: github\nupdaterCacheDirName: ../../etc\n');
    await expect(fake.downloadUpdate()).resolves.toEqual(['/cache/pending/update.zip']);
    expect(fs.written.get(FALLBACK)).toBe(feedDescriptorYaml());
    expect(fake.download).toHaveBeenCalledTimes(1);
  });

  it('a bundle whose own descriptor is exact is not rewritten at download time', async () => {
    const fake = packagedFake();
    const fs = fakeFs({ [BUNDLED]: feedDescriptorYaml() });
    applyPackagedFeed(fake, packagedOpts(fs), quietLog());
    await fake.downloadUpdate();
    expect(fs.written.size).toBe(0);
    expect(fake.download).toHaveBeenCalledTimes(1);
  });

  it('still sets the provider when the fallback cannot be written, says so, and refuses to download', async () => {
    const fake = packagedFake();
    const fs = fakeFs();
    fs.writeFileSync = () => {
      throw new Error('read-only');
    };
    const log = quietLog();
    const result = applyPackagedFeed(fake, packagedOpts(fs), log);
    expect(result).toEqual({ feedFromCode: true, descriptor: 'unwritable', reason: 'missing' });
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(fake.updateConfigPath).toBeNull();
    await expect(fake.downloadUpdate()).rejects.toThrow(/cannot be downloaded on this install/);
    expect(fake.download).not.toHaveBeenCalled();
  });

  it('a failing download-time rewrite refuses the download with a legible error', async () => {
    const fake = packagedFake();
    const fs = fakeFs();
    applyPackagedFeed(fake, packagedOpts(fs), quietLog());
    fs.writeFileSync = () => {
      throw new Error('disk full');
    };
    await expect(fake.downloadUpdate()).rejects.toThrow(/could not be refreshed \(disk full\)/);
    expect(fake.download).not.toHaveBeenCalled();
  });

  it('never throws: a packaged-path failure degrades to the bundle descriptor and is reported', () => {
    const fake = packagedFake();
    const fs = fakeFs();
    fs.existsSync = () => {
      throw new Error('EPERM');
    };
    const log = quietLog();
    let result: ReturnType<typeof applyPackagedFeed> | null = null;
    expect(() => {
      result = applyPackagedFeed(fake, packagedOpts(fs), log);
    }).not.toThrow();
    expect(result).toEqual({ feedFromCode: false, descriptor: 'error' });
    expect(fake.setFeedURL).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledTimes(1);
  });

  it('initAutoUpdater applies the packaged feed only when packaged and no dev update config is in effect', () => {
    const packaged = packagedFake();
    initAutoUpdater({ loadAutoUpdater: () => packaged, logger: quietLog(), packaged: packagedOpts(fakeFs({ [BUNDLED]: feedDescriptorYaml() })) });
    expect(packaged.setFeedURL).toHaveBeenCalledTimes(1);
    expect(packagedFeedState()).toEqual({ feedFromCode: true, descriptor: 'bundle' });

    const devConfigured = packagedFake();
    devConfigured.forceDevUpdateConfig = true;
    devConfigured.updateConfigPath = '/dev/dev-app-update.yml';
    const log = quietLog();
    initAutoUpdater({ loadAutoUpdater: () => devConfigured, logger: log, packaged: packagedOpts(fakeFs()) });
    expect(devConfigured.setFeedURL).not.toHaveBeenCalled();
    expect(devConfigured.updateConfigPath).toBe('/dev/dev-app-update.yml');
    expect(packagedFeedState()).toBeNull();
    expect(log.info.mock.calls.some((c) => String(c[0]).includes('dev update config in effect'))).toBe(true);

    const dev = packagedFake();
    initAutoUpdater({ loadAutoUpdater: () => dev, logger: quietLog() });
    expect(dev.setFeedURL).not.toHaveBeenCalled();
    expect(packagedFeedState()).toBeNull();
  });

  it('the descriptor and the releases page name the same feed', () => {
    expect(feedDescriptorYaml()).toBe('owner: wilsr7000\nrepo: Onereach_Lite_Desktop_App\nprovider: github\nupdaterCacheDirName: onereach-lite-updater\n');
    expect(releasesUrl()).toBe('https://github.com/wilsr7000/Onereach_Lite_Desktop_App/releases');
  });
});
