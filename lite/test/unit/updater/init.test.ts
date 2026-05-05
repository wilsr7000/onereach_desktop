/**
 * Unit tests for lite/updater/init.ts -- electron-updater configuration.
 */

import { describe, it, expect, vi } from 'vitest';
import { initAutoUpdater, type AutoUpdaterLike } from '../../../updater/init.js';

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
