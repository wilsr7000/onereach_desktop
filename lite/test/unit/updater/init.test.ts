/**
 * Unit tests for lite/updater/init.ts -- electron-updater configuration.
 */

import { describe, it, expect, vi } from 'vitest';
import { initAutoUpdater, applyPackagedFeed, type AutoUpdaterLike, type PackagedFs } from '../../../updater/init.js';
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

function fakeFs(existing: Set<string>): PackagedFs & { written: Map<string, string>; dirs: string[] } {
  const written = new Map<string, string>();
  const dirs: string[] = [];
  return {
    written,
    dirs,
    existsSync: (p) => existing.has(p) || written.has(p),
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

describe('packaged feed (ADR-101)', () => {
  it('sets the provider from code and leaves a bundle that has its descriptor alone', () => {
    const fake = makeFakeUpdater();
    const setFeedURL = vi.fn();
    fake.setFeedURL = setFeedURL;
    const fs = fakeFs(new Set(['/App.app/Contents/Resources/app-update.yml']));
    const log = quietLog();
    const result = applyPackagedFeed(fake, { resourcesPath: '/App.app/Contents/Resources', userDataPath: '/ud', fs }, log);
    expect(result).toEqual({ feedFromCode: true, descriptor: 'bundle' });
    expect(setFeedURL).toHaveBeenCalledWith({ ...LITE_UPDATE_FEED });
    expect(fs.written.size).toBe(0);
    expect(fake.updateConfigPath).toBeNull();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('writes the descriptor under userData and points the updater at it when the bundle has none', () => {
    const fake = makeFakeUpdater();
    fake.setFeedURL = vi.fn();
    const fs = fakeFs(new Set());
    const log = quietLog();
    const result = applyPackagedFeed(fake, { resourcesPath: '/App.app/Contents/Resources', userDataPath: '/ud', fs }, log);
    expect(result).toEqual({ feedFromCode: true, descriptor: 'written' });
    expect(fake.updateConfigPath).toBe('/ud/app-update.yml');
    expect(fs.written.get('/ud/app-update.yml')).toBe(feedDescriptorYaml());
    expect(fs.dirs).toEqual(['/ud']);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it('still sets the provider when the fallback cannot be written, and says so', () => {
    const fake = makeFakeUpdater();
    fake.setFeedURL = vi.fn();
    const fs = fakeFs(new Set());
    fs.writeFileSync = () => {
      throw new Error('read-only');
    };
    const log = quietLog();
    const result = applyPackagedFeed(fake, { resourcesPath: '/r', userDataPath: '/ud', fs }, log);
    expect(result).toEqual({ feedFromCode: true, descriptor: 'unwritable' });
    expect(log.error).toHaveBeenCalledTimes(1);
  });

  it('initAutoUpdater applies the packaged feed only when told the app is packaged', () => {
    const packagedFake = makeFakeUpdater();
    packagedFake.setFeedURL = vi.fn();
    initAutoUpdater({ loadAutoUpdater: () => packagedFake, logger: quietLog(), packaged: { resourcesPath: '/r', userDataPath: '/ud', fs: fakeFs(new Set(['/r/app-update.yml'])) } });
    expect(packagedFake.setFeedURL).toHaveBeenCalledTimes(1);
    const devFake = makeFakeUpdater();
    devFake.setFeedURL = vi.fn();
    initAutoUpdater({ loadAutoUpdater: () => devFake, logger: quietLog() });
    expect(devFake.setFeedURL).not.toHaveBeenCalled();
  });

  it('the descriptor and the releases page name the same feed', () => {
    expect(feedDescriptorYaml()).toBe('owner: wilsr7000\nrepo: Onereach_Lite_Desktop_App\nprovider: github\nupdaterCacheDirName: onereach-lite-updater\n');
    expect(releasesUrl()).toBe('https://github.com/wilsr7000/Onereach_Lite_Desktop_App/releases');
  });
});
