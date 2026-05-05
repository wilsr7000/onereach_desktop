/**
 * Unit tests for lite/updater/lifecycle.ts -- event handlers + dialogs.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { attachLifecycle, type UpdaterUiSurface } from '../../../updater/lifecycle.js';
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
    isCheckInFlight: () => false,
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
});
