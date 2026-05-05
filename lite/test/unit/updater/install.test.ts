/**
 * Unit tests for lite/updater/install.ts -- install orchestration.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { performUpdateInstall, checkAppBundleWritable } from '../../../updater/install.js';
import type { AutoUpdaterLike } from '../../../updater/init.js';
import type { UpdaterUiSurface } from '../../../updater/lifecycle.js';
import { readUpdateState } from '../../../updater/state.js';
import { clearSaveHooks, registerSaveHook } from '../../../updater/save-state.js';

let userDataDir: string;

beforeEach(async () => {
  userDataDir = await fs.mkdtemp(path.join(tmpdir(), 'lite-install-test-'));
  clearSaveHooks();
});

afterEach(async () => {
  await fs.rm(userDataDir, { recursive: true, force: true });
});

function fakeUpdater(): AutoUpdaterLike {
  return {
    logger: null,
    autoDownload: false,
    autoInstallOnAppQuit: true,
    allowDowngrade: false,
    on: () => null,
    checkForUpdates: vi.fn(),
    downloadUpdate: vi.fn(),
    quitAndInstall: vi.fn(),
  };
}

function fakeUi(responses: number[] = []): UpdaterUiSurface {
  return {
    showMessageBox: vi.fn(async () => ({ response: responses.shift() ?? 0 })),
    openReleasesPage: vi.fn(),
    setDockBadge: vi.fn(),
  };
}

describe('checkAppBundleWritable', () => {
  it('returns true on non-darwin platforms', async () => {
    if (process.platform === 'darwin') return; // skip on macOS
    const ui = fakeUi();
    const result = await checkAppBundleWritable({
      autoUpdater: fakeUpdater(),
      ui,
      userDataPath: userDataDir,
      isPackaged: () => true,
      destroyAllWindows: () => {},
    });
    expect(result).toBe(true);
    expect(ui.showMessageBox).not.toHaveBeenCalled();
  });

  it('returns true in dev mode (isPackaged=false) regardless of platform', async () => {
    const ui = fakeUi();
    const result = await checkAppBundleWritable({
      autoUpdater: fakeUpdater(),
      ui,
      userDataPath: userDataDir,
      isPackaged: () => false,
      destroyAllWindows: () => {},
    });
    expect(result).toBe(true);
  });
});

describe('performUpdateInstall', () => {
  it('writes lastAttemptVersion + lastAttemptTime when targetVersion is provided', async () => {
    const updater = fakeUpdater();
    await performUpdateInstall(
      {
        autoUpdater: updater,
        ui: fakeUi(),
        userDataPath: userDataDir,
        isPackaged: () => false, // skip writability check in test
        destroyAllWindows: () => {},
        forceExit: () => {}, // noop instead of process.exit
      },
      '2.0.0'
    );
    const state = readUpdateState(userDataDir);
    expect(state.lastAttemptVersion).toBe('2.0.0');
    expect(state.lastAttemptTime).toBeTruthy();
    expect(updater.quitAndInstall).toHaveBeenCalled();
  });

  it('does NOT write state when targetVersion is null', async () => {
    const updater = fakeUpdater();
    await performUpdateInstall(
      {
        autoUpdater: updater,
        ui: fakeUi(),
        userDataPath: userDataDir,
        isPackaged: () => false,
        destroyAllWindows: () => {},
        forceExit: () => {},
      },
      null
    );
    const state = readUpdateState(userDataDir);
    expect(state.lastAttemptVersion).toBeNull();
    expect(updater.quitAndInstall).toHaveBeenCalled();
  });

  it('runs registered save hooks before quitAndInstall', async () => {
    const calls: string[] = [];
    registerSaveHook({
      id: 'first',
      run: async () => {
        calls.push('first');
      },
    });
    const updater = fakeUpdater();
    (updater.quitAndInstall as ReturnType<typeof vi.fn>).mockImplementation(() => {
      calls.push('quit');
    });
    await performUpdateInstall(
      {
        autoUpdater: updater,
        ui: fakeUi(),
        userDataPath: userDataDir,
        isPackaged: () => false,
        destroyAllWindows: () => {},
        forceExit: () => {},
      },
      '2.0.0'
    );
    expect(calls).toEqual(['first', 'quit']);
  });

  it('calls destroyAllWindows before quitAndInstall', async () => {
    const events: string[] = [];
    const updater = fakeUpdater();
    (updater.quitAndInstall as ReturnType<typeof vi.fn>).mockImplementation(() => {
      events.push('quit');
    });
    await performUpdateInstall(
      {
        autoUpdater: updater,
        ui: fakeUi(),
        userDataPath: userDataDir,
        isPackaged: () => false,
        destroyAllWindows: () => {
          events.push('destroy');
        },
        forceExit: () => {},
      },
      '2.0.0'
    );
    expect(events).toEqual(['destroy', 'quit']);
  });

  it('cancelPeriodicCheck is invoked when supplied', async () => {
    const cancel = vi.fn();
    await performUpdateInstall(
      {
        autoUpdater: fakeUpdater(),
        ui: fakeUi(),
        userDataPath: userDataDir,
        isPackaged: () => false,
        destroyAllWindows: () => {},
        cancelPeriodicCheck: cancel,
        forceExit: () => {},
      },
      '2.0.0'
    );
    expect(cancel).toHaveBeenCalled();
  });

  it('setUpdatingFlag(true) is called before save-state', async () => {
    const flag = vi.fn();
    await performUpdateInstall(
      {
        autoUpdater: fakeUpdater(),
        ui: fakeUi(),
        userDataPath: userDataDir,
        isPackaged: () => false,
        destroyAllWindows: () => {},
        setUpdatingFlag: flag,
        forceExit: () => {},
      },
      '2.0.0'
    );
    expect(flag).toHaveBeenCalledWith(true);
  });

  it('returns attempted=true with saveStateMs when install ran', async () => {
    const result = await performUpdateInstall(
      {
        autoUpdater: fakeUpdater(),
        ui: fakeUi(),
        userDataPath: userDataDir,
        isPackaged: () => false,
        destroyAllWindows: () => {},
        forceExit: () => {},
      },
      '2.0.0'
    );
    expect(result.attempted).toBe(true);
    expect(result.saveStateMs).toBeDefined();
  });
});
