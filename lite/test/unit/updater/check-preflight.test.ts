/**
 * ADR-101 (second review pass) — the unusable-feed guard lives in the
 * check runner, so every caller (menu, renderer IPC, periodic timer) is
 * refused up front instead of a check that looks fine and dies at
 * download time.
 */

import { describe, it, expect, vi } from 'vitest';
import { createCheckRunner } from '../../../updater/check.js';
import { initAutoUpdater, packagedFeedState, feedRefusalMessage, FEED_UNUSABLE_MESSAGE, type AutoUpdaterLike, type PackagedFs } from '../../../updater/init.js';
import { feedDescriptorYaml } from '../../../updater/feed.js';

function fake(checkForUpdates: () => Promise<unknown>): AutoUpdaterLike {
  return {
    logger: null,
    autoDownload: false,
    autoInstallOnAppQuit: true,
    allowDowngrade: false,
    updateConfigPath: null,
    on: () => null,
    off: () => null,
    removeAllListeners: () => null,
    checkForUpdates,
    downloadUpdate: vi.fn().mockResolvedValue([]),
    quitAndInstall: vi.fn(),
  };
}

/** A packaged fs: `files` is the bundle; writes land in `written` unless `readOnly`. */
function packagedFs(files: Record<string, string>, readOnly = false): PackagedFs {
  const written = new Map<string, string>();
  return {
    existsSync: (p) => p in files || written.has(p),
    readFileSync: (p) => files[p] ?? written.get(p) ?? '',
    mkdirSync: () => undefined,
    writeFileSync: (p, data) => {
      if (readOnly) throw new Error('read-only');
      written.set(p, data);
    },
  };
}

const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };
const RES = '/App.app/Contents/Resources';

describe('the refusal composed with the runner, the way index.ts wires it', () => {
  it("a packaged app whose bundle carries the feed ('bundle') is allowed: the check runs", async () => {
    const checkForUpdates = vi.fn(async () => null);
    const updater = fake(checkForUpdates);
    updater.setFeedURL = () => undefined;
    initAutoUpdater({ loadAutoUpdater: () => updater, logger: quiet, packaged: { resourcesPath: RES, userDataPath: '/ud', fs: packagedFs({ [`${RES}/app-update.yml`]: feedDescriptorYaml() }) } });
    expect(packagedFeedState()?.descriptor).toBe('bundle');
    const emitStatus = vi.fn();
    const runner = createCheckRunner({ autoUpdater: updater, emitStatus, preflight: () => feedRefusalMessage(packagedFeedState(), true) });
    await runner.check({ manual: true });
    expect(checkForUpdates).toHaveBeenCalledTimes(1);
    expect(emitStatus).toHaveBeenCalledWith({ status: 'checking' });
  });
  it("'written' is allowed too; 'unwritable' refuses every caller with the message; dev and pre-init allow", async () => {
    const checkForUpdates = vi.fn(async () => null);
    const written = fake(checkForUpdates);
    written.setFeedURL = () => undefined;
    initAutoUpdater({ loadAutoUpdater: () => written, logger: quiet, packaged: { resourcesPath: RES, userDataPath: '/ud', fs: packagedFs({}) } });
    expect(packagedFeedState()?.descriptor).toBe('written');
    expect(feedRefusalMessage(packagedFeedState(), true)).toBeNull();

    const unwritable = fake(checkForUpdates);
    unwritable.setFeedURL = () => undefined;
    initAutoUpdater({ loadAutoUpdater: () => unwritable, logger: quiet, packaged: { resourcesPath: RES, userDataPath: '/ud', fs: packagedFs({}, true) } });
    expect(packagedFeedState()?.descriptor).toBe('unwritable');
    const emitStatus = vi.fn();
    const runner = createCheckRunner({ autoUpdater: unwritable, emitStatus, preflight: () => feedRefusalMessage(packagedFeedState(), true) });
    for (const manual of [true, false]) {
      await runner.check({ manual });
      expect(emitStatus).toHaveBeenLastCalledWith({ status: 'error', info: { error: FEED_UNUSABLE_MESSAGE } });
    }
    expect(checkForUpdates).not.toHaveBeenCalled();
    expect(feedRefusalMessage(packagedFeedState(), false)).toBeNull();
    expect(feedRefusalMessage(null, true)).toBeNull();
    expect(feedRefusalMessage({ feedFromCode: false, descriptor: 'error' }, true)).toBe(FEED_UNUSABLE_MESSAGE);
  });
});

describe('check runner preflight', () => {
  it('a refusal emits the error status, never calls checkForUpdates, records manual, and hands the caller the manual flag', async () => {
    const checkForUpdates = vi.fn(async () => null);
    const emitStatus = vi.fn();
    const preflight = vi.fn(({ manual }: { manual: boolean }) => (manual ? 'no descriptor (manual)' : 'no descriptor'));
    const runner = createCheckRunner({ autoUpdater: fake(checkForUpdates), emitStatus, preflight });
    await expect(runner.check({ manual: true })).resolves.toEqual({ inFlight: false, timedOut: false, manual: true });
    expect(preflight).toHaveBeenCalledWith({ manual: true });
    expect(emitStatus).toHaveBeenCalledTimes(1);
    expect(emitStatus).toHaveBeenCalledWith({ status: 'error', info: { error: 'no descriptor (manual)' } });
    expect(checkForUpdates).not.toHaveBeenCalled();
    expect(runner.wasLastManual()).toBe(true);
    expect(runner.isCheckInFlight()).toBe(false);
    await runner.check({ manual: false });
    expect(emitStatus).toHaveBeenLastCalledWith({ status: 'error', info: { error: 'no descriptor' } });
    expect(runner.wasLastManual()).toBe(false);
    expect(checkForUpdates).not.toHaveBeenCalled();
  });
  it('a null preflight (or none) lets the check run', async () => {
    const checkForUpdates = vi.fn(async () => null);
    const emitStatus = vi.fn();
    const runner = createCheckRunner({ autoUpdater: fake(checkForUpdates), emitStatus, preflight: () => null });
    await runner.check({ manual: true });
    expect(checkForUpdates).toHaveBeenCalledTimes(1);
    expect(emitStatus).toHaveBeenCalledWith({ status: 'checking' });
    const plain = createCheckRunner({ autoUpdater: fake(checkForUpdates), emitStatus });
    await plain.check({ manual: false });
    expect(checkForUpdates).toHaveBeenCalledTimes(2);
  });
});
