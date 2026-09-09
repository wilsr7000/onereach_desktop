/**
 * ADR-101 (second review pass) — the unusable-feed guard lives in the
 * check runner, so every caller (menu, renderer IPC, periodic timer) is
 * refused up front instead of a check that looks fine and dies at
 * download time.
 */

import { describe, it, expect, vi } from 'vitest';
import { createCheckRunner } from '../../../updater/check.js';
import type { AutoUpdaterLike } from '../../../updater/init.js';

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
