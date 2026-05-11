/**
 * Unit tests for lite/updater/install.ts -- install orchestration.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import {
  performUpdateInstall,
  checkAppBundleWritable,
  type InstallDeps,
} from '../../../updater/install.js';
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

/**
 * Build the test-seam set the install flow needs to run without
 * actually spawning a child process or writing to /tmp. Returns the
 * captured spawn call + the helper-script body that would have been
 * written, so tests can assert on either.
 *
 * Default `appQuit` is a spy so tests can verify it fired. Default
 * `forceExit` is a no-op so the safety-net timer doesn't try to
 * exit the test process.
 */
function makeBypassSeams(): {
  spawnImpl: ReturnType<typeof vi.fn>;
  fsImpl: { writeFileSync: ReturnType<typeof vi.fn> };
  appQuit: ReturnType<typeof vi.fn> & (() => void);
  forceExit: ReturnType<typeof vi.fn> & (() => void);
  destroyAllWindows: ReturnType<typeof vi.fn> & (() => void);
  capturedScript: () => string | undefined;
  capturedScriptPath: () => string | undefined;
} {
  let capturedScriptBody: string | undefined;
  let capturedScriptPath: string | undefined;
  const fsImpl = {
    writeFileSync: vi.fn((p: string, contents: string) => {
      capturedScriptPath = p;
      capturedScriptBody = contents;
    }),
  };
  const spawnImpl = vi.fn(() => ({ pid: 12345, unref: vi.fn() }));
  return {
    spawnImpl,
    fsImpl,
    appQuit: vi.fn() as ReturnType<typeof vi.fn> & (() => void),
    forceExit: vi.fn() as ReturnType<typeof vi.fn> & (() => void),
    destroyAllWindows: vi.fn() as ReturnType<typeof vi.fn> & (() => void),
    capturedScript: () => capturedScriptBody,
    capturedScriptPath: () => capturedScriptPath,
  };
}

describe('performUpdateInstall', () => {
  it('writes lastAttemptVersion + lastAttemptTime when targetVersion is provided', async () => {
    const updater = fakeUpdater();
    const seams = makeBypassSeams();
    await performUpdateInstall(
      {
        autoUpdater: updater,
        ui: fakeUi(),
        userDataPath: userDataDir,
        isPackaged: () => false, // skip writability check in test
        destroyAllWindows: seams.destroyAllWindows,
        forceExit: seams.forceExit,
        appQuit: seams.appQuit,
        spawnImpl: seams.spawnImpl as unknown as NonNullable<InstallDeps['spawnImpl']>,
        fsImpl: seams.fsImpl as unknown as NonNullable<InstallDeps['fsImpl']>,
      },
      '2.0.0'
    );
    const state = readUpdateState(userDataDir);
    expect(state.lastAttemptVersion).toBe('2.0.0');
    expect(state.lastAttemptTime).toBeTruthy();
    // Bypass Squirrel.Mac on macOS 26.4: install spawns the detached
    // bash helper instead of calling autoUpdater.quitAndInstall().
    expect(seams.spawnImpl).toHaveBeenCalled();
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
  });

  it('does NOT write state when targetVersion is null', async () => {
    const updater = fakeUpdater();
    const seams = makeBypassSeams();
    await performUpdateInstall(
      {
        autoUpdater: updater,
        ui: fakeUi(),
        userDataPath: userDataDir,
        isPackaged: () => false,
        destroyAllWindows: seams.destroyAllWindows,
        forceExit: seams.forceExit,
        appQuit: seams.appQuit,
        spawnImpl: seams.spawnImpl as unknown as NonNullable<InstallDeps['spawnImpl']>,
        fsImpl: seams.fsImpl as unknown as NonNullable<InstallDeps['fsImpl']>,
      },
      null
    );
    const state = readUpdateState(userDataDir);
    expect(state.lastAttemptVersion).toBeNull();
    expect(seams.spawnImpl).toHaveBeenCalled();
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
  });

  it('runs registered save hooks before spawning the install helper', async () => {
    const calls: string[] = [];
    registerSaveHook({
      id: 'first',
      run: async () => {
        calls.push('first');
      },
    });
    const updater = fakeUpdater();
    const seams = makeBypassSeams();
    seams.spawnImpl.mockImplementation(() => {
      calls.push('spawn-helper');
      return { pid: 12345, unref: vi.fn() };
    });
    await performUpdateInstall(
      {
        autoUpdater: updater,
        ui: fakeUi(),
        userDataPath: userDataDir,
        isPackaged: () => false,
        destroyAllWindows: seams.destroyAllWindows,
        forceExit: seams.forceExit,
        appQuit: seams.appQuit,
        spawnImpl: seams.spawnImpl as unknown as NonNullable<InstallDeps['spawnImpl']>,
        fsImpl: seams.fsImpl as unknown as NonNullable<InstallDeps['fsImpl']>,
      },
      '2.0.0'
    );
    expect(calls).toEqual(['first', 'spawn-helper']);
  });

  it(
    'does NOT call destroyAllWindows before spawning the install helper',
    async () => {
      // Regression: the legacy Squirrel.Mac path force-destroyed
      // every BrowserWindow before quitAndInstall, which raced the
      // Squirrel terminate path. The bypass avoids that whole race
      // by spawning a detached bash helper and calling app.quit().
      // Destroying windows here is still the wrong thing -- the
      // before-quit guard handles the rest.
      const events: string[] = [];
      const updater = fakeUpdater();
      const seams = makeBypassSeams();
      seams.spawnImpl.mockImplementation(() => {
        events.push('spawn-helper');
        return { pid: 12345, unref: vi.fn() };
      });
      seams.destroyAllWindows.mockImplementation(() => {
        events.push('destroy');
      });
      await performUpdateInstall(
        {
          autoUpdater: updater,
          ui: fakeUi(),
          userDataPath: userDataDir,
          isPackaged: () => false,
          destroyAllWindows: seams.destroyAllWindows,
          forceExit: seams.forceExit,
          appQuit: seams.appQuit,
          spawnImpl: seams.spawnImpl as unknown as NonNullable<InstallDeps['spawnImpl']>,
          fsImpl: seams.fsImpl as unknown as NonNullable<InstallDeps['fsImpl']>,
        },
        '2.0.0'
      );
      // helper fired; destroy did NOT.
      expect(events).toEqual(['spawn-helper']);
    }
  );

  it('cancelPeriodicCheck is invoked when supplied', async () => {
    const cancel = vi.fn();
    const seams = makeBypassSeams();
    await performUpdateInstall(
      {
        autoUpdater: fakeUpdater(),
        ui: fakeUi(),
        userDataPath: userDataDir,
        isPackaged: () => false,
        destroyAllWindows: seams.destroyAllWindows,
        cancelPeriodicCheck: cancel,
        forceExit: seams.forceExit,
        appQuit: seams.appQuit,
        spawnImpl: seams.spawnImpl as unknown as NonNullable<InstallDeps['spawnImpl']>,
        fsImpl: seams.fsImpl as unknown as NonNullable<InstallDeps['fsImpl']>,
      },
      '2.0.0'
    );
    expect(cancel).toHaveBeenCalled();
  });

  it('setUpdatingFlag(true) is called before save-state', async () => {
    const flag = vi.fn();
    const seams = makeBypassSeams();
    await performUpdateInstall(
      {
        autoUpdater: fakeUpdater(),
        ui: fakeUi(),
        userDataPath: userDataDir,
        isPackaged: () => false,
        destroyAllWindows: seams.destroyAllWindows,
        setUpdatingFlag: flag,
        forceExit: seams.forceExit,
        appQuit: seams.appQuit,
        spawnImpl: seams.spawnImpl as unknown as NonNullable<InstallDeps['spawnImpl']>,
        fsImpl: seams.fsImpl as unknown as NonNullable<InstallDeps['fsImpl']>,
      },
      '2.0.0'
    );
    expect(flag).toHaveBeenCalledWith(true);
  });

  it('returns attempted=true with saveStateMs when install ran', async () => {
    const seams = makeBypassSeams();
    const result = await performUpdateInstall(
      {
        autoUpdater: fakeUpdater(),
        ui: fakeUi(),
        userDataPath: userDataDir,
        isPackaged: () => false,
        destroyAllWindows: seams.destroyAllWindows,
        forceExit: seams.forceExit,
        appQuit: seams.appQuit,
        spawnImpl: seams.spawnImpl as unknown as NonNullable<InstallDeps['spawnImpl']>,
        fsImpl: seams.fsImpl as unknown as NonNullable<InstallDeps['fsImpl']>,
      },
      '2.0.0'
    );
    expect(result.attempted).toBe(true);
    expect(result.saveStateMs).toBeDefined();
  });

  // ─── bypass-specific tests ──────────────────────────────────────────────
  //
  // The install path replaces autoUpdater.quitAndInstall() with a
  // detached bash helper because Squirrel.Mac is broken on macOS 26.4.
  // These tests pin the helper-spawn contract so a future refactor can't
  // regress back to the broken Squirrel path.

  it('writes a /bin/bash helper script and spawns it detached', async () => {
    const seams = makeBypassSeams();
    await performUpdateInstall(
      {
        autoUpdater: fakeUpdater(),
        ui: fakeUi(),
        userDataPath: userDataDir,
        isPackaged: () => false,
        destroyAllWindows: seams.destroyAllWindows,
        forceExit: seams.forceExit,
        appQuit: seams.appQuit,
        spawnImpl: seams.spawnImpl as unknown as NonNullable<InstallDeps['spawnImpl']>,
        fsImpl: seams.fsImpl as unknown as NonNullable<InstallDeps['fsImpl']>,
      },
      '2.0.0'
    );
    expect(seams.fsImpl.writeFileSync).toHaveBeenCalledOnce();
    expect(seams.capturedScriptPath()).toMatch(/onereach-lite-installer.*\.sh$/);
    expect(seams.spawnImpl).toHaveBeenCalledOnce();
    const [cmd, args, options] = seams.spawnImpl.mock.calls[0] as [
      string,
      string[],
      { detached: boolean; stdio: string }
    ];
    expect(cmd).toBe('/bin/bash');
    expect(args[0]).toMatch(/onereach-lite-installer.*\.sh$/);
    expect(options.detached).toBe(true);
    expect(options.stdio).toBe('ignore');
  });

  it('helper script targets the lite-specific bundle name + cache paths', async () => {
    const seams = makeBypassSeams();
    await performUpdateInstall(
      {
        autoUpdater: fakeUpdater(),
        ui: fakeUi(),
        userDataPath: userDataDir,
        isPackaged: () => false,
        destroyAllWindows: seams.destroyAllWindows,
        forceExit: seams.forceExit,
        appQuit: seams.appQuit,
        spawnImpl: seams.spawnImpl as unknown as NonNullable<InstallDeps['spawnImpl']>,
        fsImpl: seams.fsImpl as unknown as NonNullable<InstallDeps['fsImpl']>,
      },
      '2.0.0'
    );
    const script = seams.capturedScript();
    expect(script).toBeDefined();
    // Lite-specific identifiers must appear in the script body so the
    // helper finds the correct ShipIt cache / updater cache / bundle
    // name. A future refactor that accidentally falls back to the full
    // app's strings (com.gsx.poweruser / "Onereach.ai.app") would
    // silently target the wrong bundle.
    expect(script).toMatch(/com\.onereach\.lite\.ShipIt/);
    expect(script).toMatch(/onereach-lite-updater\/pending/);
    expect(script).toMatch(/Onereach\.ai Lite\.app/);
    // The codesign-verify gate is what stops a corrupted download from
    // overwriting /Applications. Pin its presence.
    expect(script).toMatch(/codesign --verify/);
  });

  it('calls app.quit() after the helper is spawned', async () => {
    const seams = makeBypassSeams();
    await performUpdateInstall(
      {
        autoUpdater: fakeUpdater(),
        ui: fakeUi(),
        userDataPath: userDataDir,
        isPackaged: () => false,
        destroyAllWindows: seams.destroyAllWindows,
        forceExit: seams.forceExit,
        appQuit: seams.appQuit,
        spawnImpl: seams.spawnImpl as unknown as NonNullable<InstallDeps['spawnImpl']>,
        fsImpl: seams.fsImpl as unknown as NonNullable<InstallDeps['fsImpl']>,
      },
      '2.0.0'
    );
    expect(seams.appQuit).toHaveBeenCalledOnce();
    // app.quit must come AFTER the spawn -- otherwise the helper's
    // wait-for-parent-PID loop never has a process to wait on.
    const spawnOrder = seams.spawnImpl.mock.invocationCallOrder[0];
    const quitOrder = seams.appQuit.mock.invocationCallOrder[0];
    expect(spawnOrder).toBeDefined();
    expect(quitOrder).toBeDefined();
    expect(quitOrder).toBeGreaterThan(spawnOrder as number);
  });
});
