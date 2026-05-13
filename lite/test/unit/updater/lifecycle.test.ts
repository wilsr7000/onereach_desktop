/**
 * Unit tests for lite/updater/lifecycle.ts -- event handlers + dialogs.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import {
  attachLifecycle,
  PERIODIC_CHECK_INTERVAL_MS,
  STARTUP_CHECK_DELAY_MS,
  type UpdaterUiSurface,
} from '../../../updater/lifecycle.js';
import type { AutoUpdaterLike } from '../../../updater/init.js';
import type { CheckRunner } from '../../../updater/check.js';
import { BackupManager } from '../../../updater/backups.js';

let userDataDir: string;

beforeEach(async () => {
  userDataDir = await fs.mkdtemp(path.join(tmpdir(), 'lite-lifecycle-test-'));
});

afterEach(async () => {
  await fs.rm(userDataDir, { recursive: true, force: true });
});

interface FakeUpdater extends AutoUpdaterLike {
  emitter: EventEmitter;
}

function makeFakeUpdater(): FakeUpdater {
  const emitter = new EventEmitter();
  return {
    logger: null,
    autoDownload: false,
    autoInstallOnAppQuit: true,
    allowDowngrade: false,
    emitter,
    on: (event, listener) => {
      emitter.on(event, listener);
      return null;
    },
    off: (event, listener) => {
      emitter.off(event, listener);
      return null;
    },
    removeAllListeners: (event) => {
      if (event !== undefined) emitter.removeAllListeners(event);
      else emitter.removeAllListeners();
      return null;
    },
    checkForUpdates: vi.fn().mockResolvedValue(null),
    downloadUpdate: vi.fn().mockResolvedValue([]),
    quitAndInstall: vi.fn(),
  };
}

function makeUi(responses: number[] = []): UpdaterUiSurface & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    showMessageBox: vi.fn(async (params) => {
      calls.push(params);
      const next = responses.shift() ?? 0;
      return { response: next };
    }),
    openReleasesPage: vi.fn(),
    setDockBadge: vi.fn(),
  };
}

function makeCheckRunner(wasManual: boolean): CheckRunner {
  return {
    check: vi.fn().mockResolvedValue({ inFlight: false, timedOut: false, manual: wasManual }),
    isCheckInFlight: vi.fn().mockReturnValue(false),
    wasLastManual: () => wasManual,
  };
}

describe('attachLifecycle', () => {
  it('emits "checking" status on checking-for-update', () => {
    const updater = makeFakeUpdater();
    const ui = makeUi();
    const emitStatus = vi.fn();
    const handle = attachLifecycle({
      autoUpdater: updater,
      ui,
      backups: new BackupManager({ userDataPath: userDataDir }),
      getCurrentVersion: () => '1.0.0',
      performUpdateInstall: vi.fn(),
      emitStatus,
      getFailedAttemptsForVersion: () => 0,
      isPackaged: () => true,
      isVersionBroken: () => false,
      checkRunner: makeCheckRunner(true),
    });
    updater.emitter.emit('checking-for-update');
    expect(emitStatus).toHaveBeenCalledWith({ status: 'checking' });
    handle.teardown();
  });

  it('shows Download/Later dialog on update-available; clicking Download triggers download', async () => {
    const updater = makeFakeUpdater();
    const ui = makeUi([0]); // click Download
    const emitStatus = vi.fn();
    const handle = attachLifecycle({
      autoUpdater: updater,
      ui,
      backups: new BackupManager({ userDataPath: userDataDir }),
      getCurrentVersion: () => '1.0.0',
      performUpdateInstall: vi.fn(),
      emitStatus,
      getFailedAttemptsForVersion: () => 0,
      isPackaged: () => true,
      isVersionBroken: () => false,
      checkRunner: makeCheckRunner(true),
    });
    updater.emitter.emit('update-available', { version: '2.0.0' });
    await new Promise((r) => setTimeout(r, 10));
    expect(emitStatus).toHaveBeenCalledWith({ status: 'available', info: { version: '2.0.0' } });
    expect(ui.calls[0]).toMatchObject({
      title: 'Update Available',
      buttons: ['Download', 'Later'],
    });
    expect(updater.downloadUpdate).toHaveBeenCalled();
    handle.teardown();
  });

  it('does NOT show "no updates" dialog on auto checks (only on manual)', () => {
    const updater = makeFakeUpdater();
    const ui = makeUi();
    const handle = attachLifecycle({
      autoUpdater: updater,
      ui,
      backups: new BackupManager({ userDataPath: userDataDir }),
      getCurrentVersion: () => '1.0.0',
      performUpdateInstall: vi.fn(),
      emitStatus: vi.fn(),
      getFailedAttemptsForVersion: () => 0,
      isPackaged: () => true,
      isVersionBroken: () => false,
      checkRunner: makeCheckRunner(false), // auto
    });
    updater.emitter.emit('update-not-available', {});
    expect(ui.showMessageBox).not.toHaveBeenCalled();
    handle.teardown();
  });

  it('SHOWS "no updates" dialog on manual checks', () => {
    const updater = makeFakeUpdater();
    const ui = makeUi();
    const handle = attachLifecycle({
      autoUpdater: updater,
      ui,
      backups: new BackupManager({ userDataPath: userDataDir }),
      getCurrentVersion: () => '1.0.0',
      performUpdateInstall: vi.fn(),
      emitStatus: vi.fn(),
      getFailedAttemptsForVersion: () => 0,
      isPackaged: () => true,
      isVersionBroken: () => false,
      checkRunner: makeCheckRunner(true),
    });
    updater.emitter.emit('update-not-available', {});
    expect(ui.showMessageBox).toHaveBeenCalled();
    expect(ui.calls[0]).toMatchObject({ title: 'No Updates Available' });
    handle.teardown();
  });

  it('error event maps known network errors to friendly copy', () => {
    const updater = makeFakeUpdater();
    const ui = makeUi();
    const emitStatus = vi.fn();
    const handle = attachLifecycle({
      autoUpdater: updater,
      ui,
      backups: new BackupManager({ userDataPath: userDataDir }),
      getCurrentVersion: () => '1.0.0',
      performUpdateInstall: vi.fn(),
      emitStatus,
      getFailedAttemptsForVersion: () => 0,
      isPackaged: () => true,
      isVersionBroken: () => false,
      checkRunner: makeCheckRunner(true),
    });
    updater.emitter.emit('error', new Error('ERR_CONNECTION_REFUSED'));
    expect(emitStatus).toHaveBeenCalledWith({
      status: 'error',
      info: expect.objectContaining({
        error: 'Cannot connect to update server. Please check your internet connection.',
      }),
    });
    handle.teardown();
  });

  it('update-downloaded creates a backup and shows install dialog (clean path)', async () => {
    const updater = makeFakeUpdater();
    const ui = makeUi([1]); // click "Install Later"
    const emitStatus = vi.fn();
    const performUpdateInstall = vi.fn();
    const backups = new BackupManager({ userDataPath: userDataDir });
    const handle = attachLifecycle({
      autoUpdater: updater,
      ui,
      backups,
      getCurrentVersion: () => '1.0.0',
      performUpdateInstall,
      emitStatus,
      getFailedAttemptsForVersion: () => 0,
      isPackaged: () => true,
      isVersionBroken: () => false,
      checkRunner: makeCheckRunner(true),
    });
    updater.emitter.emit('update-downloaded', { version: '2.0.0' });
    await new Promise((r) => setTimeout(r, 50));
    // Backup created
    const list = await backups.list();
    expect(list.map((b) => b.version)).toContain('1.0.0');
    // "Install and Restart" dialog shown with clean copy
    expect(ui.calls[0]).toMatchObject({
      title: 'Update Ready to Install',
      message: expect.stringContaining('2.0.0'),
      buttons: ['Install and Restart', 'Install Later'],
    });
    // User chose Install Later -- no install
    expect(performUpdateInstall).not.toHaveBeenCalled();
    handle.teardown();
  });

  it('update-downloaded with prior failures uses the 3-button dialog', async () => {
    const updater = makeFakeUpdater();
    const ui = makeUi([0]); // click Install and Restart
    const performUpdateInstall = vi.fn();
    const handle = attachLifecycle({
      autoUpdater: updater,
      ui,
      backups: new BackupManager({ userDataPath: userDataDir }),
      getCurrentVersion: () => '1.0.0',
      performUpdateInstall,
      emitStatus: vi.fn(),
      getFailedAttemptsForVersion: (v) => (v === '2.0.0' ? 1 : 0),
      isVersionBroken: () => false,
      isPackaged: () => true,
      checkRunner: makeCheckRunner(true),
    });
    updater.emitter.emit('update-downloaded', { version: '2.0.0' });
    await new Promise((r) => setTimeout(r, 50));
    expect(ui.calls[0]).toMatchObject({
      buttons: ['Install and Restart', 'Download Manually', 'Later'],
    });
    expect(performUpdateInstall).toHaveBeenCalledWith('2.0.0');
    handle.teardown();
  });

  it('teardown removes all event listeners', () => {
    const updater = makeFakeUpdater();
    const handle = attachLifecycle({
      autoUpdater: updater,
      ui: makeUi(),
      backups: new BackupManager({ userDataPath: userDataDir }),
      getCurrentVersion: () => '1.0.0',
      performUpdateInstall: vi.fn(),
      emitStatus: vi.fn(),
      getFailedAttemptsForVersion: () => 0,
      isVersionBroken: () => false,
      isPackaged: () => true,
      checkRunner: makeCheckRunner(true),
    });
    expect(updater.emitter.eventNames().length).toBeGreaterThan(0);
    handle.teardown();
    expect(updater.emitter.eventNames().length).toBe(0);
  });

  it(
    'cancelPeriodicCheck stops the periodic timer WITHOUT removing autoUpdater listeners',
    () => {
      // Regression: the install flow used to call lifecycle.teardown()
      // pre-`quitAndInstall` to stop the periodic check. That also
      // stripped every listener off the autoUpdater EventEmitter,
      // which confused electron-updater's Squirrel.Mac driver and
      // caused the user-reported "Install and Relaunch" failure
      // (bundle never replaced, app relaunched into the old version).
      // The narrow `cancelPeriodicCheck` method is the install flow's
      // proper hook -- listeners stay intact during the handoff.
      const updater = makeFakeUpdater();
      const handle = attachLifecycle({
        autoUpdater: updater,
        ui: makeUi(),
        backups: new BackupManager({ userDataPath: userDataDir }),
        getCurrentVersion: () => '1.0.0',
        performUpdateInstall: vi.fn(),
        emitStatus: vi.fn(),
        getFailedAttemptsForVersion: () => 0,
        isVersionBroken: () => false,
        isPackaged: () => true,
        checkRunner: makeCheckRunner(true),
      });
      const listenersBefore = updater.emitter.eventNames().length;
      expect(listenersBefore).toBeGreaterThan(0);

      handle.cancelPeriodicCheck();

      // Listeners must still be present so Squirrel.Mac /
      // electron-updater can drive the rest of the install.
      expect(updater.emitter.eventNames().length).toBe(listenersBefore);
      handle.teardown();
    }
  );

  it('cancelPeriodicCheck is idempotent (can be called twice)', () => {
    const updater = makeFakeUpdater();
    const handle = attachLifecycle({
      autoUpdater: updater,
      ui: makeUi(),
      backups: new BackupManager({ userDataPath: userDataDir }),
      getCurrentVersion: () => '1.0.0',
      performUpdateInstall: vi.fn(),
      emitStatus: vi.fn(),
      getFailedAttemptsForVersion: () => 0,
      isVersionBroken: () => false,
      isPackaged: () => true,
      checkRunner: makeCheckRunner(true),
    });
    handle.cancelPeriodicCheck();
    expect(() => handle.cancelPeriodicCheck()).not.toThrow();
    handle.teardown();
  });

  describe('periodic + startup check timing', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('periodic interval is 24 hours (once-a-day cadence)', () => {
      // The constant is what the user feels; pin its value here so a
      // refactor can't quietly drop us back to the 6-hour cadence (or
      // bump it to a week without an intentional change).
      expect(PERIODIC_CHECK_INTERVAL_MS).toBe(24 * 60 * 60 * 1000);
    });

    it('schedules a startup check ~5s after attach (packaged build)', async () => {
      const updater = makeFakeUpdater();
      const checkRunner = makeCheckRunner(true);
      const handle = attachLifecycle({
        autoUpdater: updater,
        ui: makeUi(),
        backups: new BackupManager({ userDataPath: userDataDir }),
        getCurrentVersion: () => '1.0.0',
        performUpdateInstall: vi.fn(),
        emitStatus: vi.fn(),
        getFailedAttemptsForVersion: () => 0,
        isVersionBroken: () => false,
        isPackaged: () => true,
        checkRunner,
      });

      // No check before the delay elapses.
      vi.advanceTimersByTime(STARTUP_CHECK_DELAY_MS - 1);
      expect(checkRunner.check).not.toHaveBeenCalled();

      vi.advanceTimersByTime(2);
      expect(checkRunner.check).toHaveBeenCalledWith({ manual: false });

      handle.teardown();
    });

    it('does NOT run the startup check in unpacked builds (dev runs)', async () => {
      const updater = makeFakeUpdater();
      const checkRunner = makeCheckRunner(true);
      const handle = attachLifecycle({
        autoUpdater: updater,
        ui: makeUi(),
        backups: new BackupManager({ userDataPath: userDataDir }),
        getCurrentVersion: () => '1.0.0',
        performUpdateInstall: vi.fn(),
        emitStatus: vi.fn(),
        getFailedAttemptsForVersion: () => 0,
        isVersionBroken: () => false,
        isPackaged: () => false, // ← unpacked
        checkRunner,
      });

      vi.advanceTimersByTime(STARTUP_CHECK_DELAY_MS + 100);
      expect(checkRunner.check).not.toHaveBeenCalled();

      handle.teardown();
    });

    it('fires the periodic check at the 24h mark and again at 48h', () => {
      const updater = makeFakeUpdater();
      const checkRunner = makeCheckRunner(true);
      const handle = attachLifecycle({
        autoUpdater: updater,
        ui: makeUi(),
        backups: new BackupManager({ userDataPath: userDataDir }),
        getCurrentVersion: () => '1.0.0',
        performUpdateInstall: vi.fn(),
        emitStatus: vi.fn(),
        getFailedAttemptsForVersion: () => 0,
        isVersionBroken: () => false,
        isPackaged: () => true,
        checkRunner,
      });

      // Consume the startup check first (5s in).
      vi.advanceTimersByTime(STARTUP_CHECK_DELAY_MS + 10);
      expect(checkRunner.check).toHaveBeenCalledTimes(1);

      // Periodic at 24h.
      vi.advanceTimersByTime(PERIODIC_CHECK_INTERVAL_MS);
      expect(checkRunner.check).toHaveBeenCalledTimes(2);

      // And again at 48h -- the interval keeps repeating.
      vi.advanceTimersByTime(PERIODIC_CHECK_INTERVAL_MS);
      expect(checkRunner.check).toHaveBeenCalledTimes(3);

      handle.teardown();
    });

    it('cancelPeriodicCheck cancels both the startup timer and the periodic interval', () => {
      const updater = makeFakeUpdater();
      const checkRunner = makeCheckRunner(true);
      const handle = attachLifecycle({
        autoUpdater: updater,
        ui: makeUi(),
        backups: new BackupManager({ userDataPath: userDataDir }),
        getCurrentVersion: () => '1.0.0',
        performUpdateInstall: vi.fn(),
        emitStatus: vi.fn(),
        getFailedAttemptsForVersion: () => 0,
        isVersionBroken: () => false,
        isPackaged: () => true,
        checkRunner,
      });

      // Cancel before either timer fires.
      handle.cancelPeriodicCheck();

      // Neither the startup check nor the periodic interval should
      // fire after the cancel, even after we advance well past both
      // schedules.
      vi.advanceTimersByTime(PERIODIC_CHECK_INTERVAL_MS * 2);
      expect(checkRunner.check).not.toHaveBeenCalled();

      handle.teardown();
    });

    it('startup check is skipped when another check is already in flight', () => {
      const updater = makeFakeUpdater();
      const checkRunner = makeCheckRunner(true);
      // Force the in-flight gate to report true so the startup check
      // skips itself rather than racing the in-flight one.
      (checkRunner.isCheckInFlight as ReturnType<typeof vi.fn>).mockReturnValue(true);

      const handle = attachLifecycle({
        autoUpdater: updater,
        ui: makeUi(),
        backups: new BackupManager({ userDataPath: userDataDir }),
        getCurrentVersion: () => '1.0.0',
        performUpdateInstall: vi.fn(),
        emitStatus: vi.fn(),
        getFailedAttemptsForVersion: () => 0,
        isVersionBroken: () => false,
        isPackaged: () => true,
        checkRunner,
      });

      vi.advanceTimersByTime(STARTUP_CHECK_DELAY_MS + 10);
      expect(checkRunner.check).not.toHaveBeenCalled();

      handle.teardown();
    });
  });

  // ─── silent-check-still-prompts ─────────────────────────────────────────
  //
  // End-to-end pinning for the user-facing behavior: Lite checks in the
  // background (startup + daily), and when a check finds a new version
  // it MUST surface the "Update Available" dialog -- regardless of
  // whether the triggering check was manual (user clicked "Check for
  // updates") or silent (the 5s startup timer / 24h interval).
  //
  // Symmetrically, when a silent check finds NOTHING new, the user must
  // NOT see a "You're up to date" dialog -- that would defeat the
  // "silent in the background" contract. Manual checks DO get the
  // confirmation dialog so the user knows their click did something.
  //
  // A future refactor that accidentally gates the update-available
  // dialog on `wasLastManual()` (the way update-not-available is
  // gated) would silently break daily auto-checks for everyone --
  // updates would still download but the user would never be told.
  describe('silent background check + new-version prompt', () => {
    it(
      'silent check that finds an update STILL shows the "Update Available" dialog',
      async () => {
        const updater = makeFakeUpdater();
        const ui = makeUi([1]); // click Later
        // wasLastManual = false simulates an auto check (startup timer
        // or 24h periodic interval).
        const checkRunner = makeCheckRunner(false);
        const handle = attachLifecycle({
          autoUpdater: updater,
          ui,
          backups: new BackupManager({ userDataPath: userDataDir }),
          getCurrentVersion: () => '1.0.0',
          performUpdateInstall: vi.fn(),
          emitStatus: vi.fn(),
          getFailedAttemptsForVersion: () => 0,
          isVersionBroken: () => false,
          isPackaged: () => true,
          checkRunner,
        });

        updater.emitter.emit('update-available', { version: '2.0.0' });
        // Let the .then() handler attached inside the lifecycle resolve.
        await new Promise((r) => setTimeout(r, 10));

        expect(ui.showMessageBox).toHaveBeenCalled();
        expect(ui.calls[0]).toMatchObject({
          title: 'Update Available',
          buttons: ['Download', 'Later'],
        });
        handle.teardown();
      }
    );

    it('silent check that finds NOTHING new stays silent (no dialog)', () => {
      const updater = makeFakeUpdater();
      const ui = makeUi();
      const checkRunner = makeCheckRunner(false); // auto
      const handle = attachLifecycle({
        autoUpdater: updater,
        ui,
        backups: new BackupManager({ userDataPath: userDataDir }),
        getCurrentVersion: () => '1.0.0',
        performUpdateInstall: vi.fn(),
        emitStatus: vi.fn(),
        getFailedAttemptsForVersion: () => 0,
        isVersionBroken: () => false,
        isPackaged: () => true,
        checkRunner,
      });

      updater.emitter.emit('update-not-available', {});

      expect(ui.showMessageBox).not.toHaveBeenCalled();
      handle.teardown();
    });

    it('manual check that finds NOTHING new DOES show "No Updates Available"', () => {
      // Counterpoint: silent checks suppress the no-updates dialog,
      // but a manual "Check for Updates..." click should always
      // confirm to the user that something happened (otherwise the
      // click looks broken).
      const updater = makeFakeUpdater();
      const ui = makeUi();
      const checkRunner = makeCheckRunner(true); // manual
      const handle = attachLifecycle({
        autoUpdater: updater,
        ui,
        backups: new BackupManager({ userDataPath: userDataDir }),
        getCurrentVersion: () => '1.0.0',
        performUpdateInstall: vi.fn(),
        emitStatus: vi.fn(),
        getFailedAttemptsForVersion: () => 0,
        isVersionBroken: () => false,
        isPackaged: () => true,
        checkRunner,
      });

      updater.emitter.emit('update-not-available', {});

      expect(ui.showMessageBox).toHaveBeenCalled();
      expect(ui.calls[0]).toMatchObject({ title: 'No Updates Available' });
      handle.teardown();
    });
  });
});
