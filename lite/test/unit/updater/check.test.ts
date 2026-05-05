/**
 * Unit tests for lite/updater/check.ts -- check-for-updates orchestration.
 */

import { describe, it, expect, vi } from 'vitest';
import { createCheckRunner } from '../../../updater/check.js';
import type { AutoUpdaterLike } from '../../../updater/init.js';

function fakeAutoUpdater(impl: () => Promise<unknown>): AutoUpdaterLike {
  return {
    logger: null,
    autoDownload: false,
    autoInstallOnAppQuit: true,
    allowDowngrade: false,
    on: () => null,
    checkForUpdates: vi.fn().mockImplementation(impl),
    downloadUpdate: vi.fn().mockResolvedValue([]),
    quitAndInstall: vi.fn(),
  };
}

describe('createCheckRunner', () => {
  it('emits "checking" status on each call', async () => {
    const emit = vi.fn();
    const runner = createCheckRunner({
      autoUpdater: fakeAutoUpdater(async () => null),
      emitStatus: emit,
    });
    await runner.check({ manual: true });
    expect(emit).toHaveBeenCalledWith({ status: 'checking' });
  });

  it('coalesces concurrent calls (returns same promise)', async () => {
    let resolveInner: () => void = () => {};
    const innerPromise = new Promise<void>((r) => {
      resolveInner = r;
    });
    const runner = createCheckRunner({
      autoUpdater: fakeAutoUpdater(() => innerPromise),
      emitStatus: vi.fn(),
    });
    const a = runner.check({ manual: true });
    const b = runner.check({ manual: false });
    expect(a).toBe(b); // coalesced
    resolveInner();
    await a;
  });

  it('records lastManual on each call', async () => {
    const runner = createCheckRunner({
      autoUpdater: fakeAutoUpdater(async () => null),
      emitStatus: vi.fn(),
    });
    await runner.check({ manual: true });
    expect(runner.wasLastManual()).toBe(true);
    // Wait out the 1s coalescing grace before issuing the next call
    await new Promise((r) => setTimeout(r, 1100));
    await runner.check({ manual: false });
    expect(runner.wasLastManual()).toBe(false);
  });

  it('emits "error" with timeout message when checkForUpdates exceeds budget', async () => {
    const emit = vi.fn();
    const runner = createCheckRunner({
      autoUpdater: fakeAutoUpdater(() => new Promise(() => {})), // never resolves
      emitStatus: emit,
    });
    const result = await runner.check({ manual: true, timeoutMs: 50 });
    expect(result.timedOut).toBe(true);
    expect(emit).toHaveBeenCalledWith({
      status: 'error',
      info: { error: 'Update check timed out' },
    });
  });

  it('emits "error" with the underlying error message on rejection', async () => {
    const emit = vi.fn();
    const runner = createCheckRunner({
      autoUpdater: fakeAutoUpdater(async () => {
        throw new Error('boom');
      }),
      emitStatus: emit,
    });
    await runner.check({ manual: false });
    expect(emit).toHaveBeenCalledWith({
      status: 'error',
      info: { error: 'boom' },
    });
  });

  it('isCheckInFlight is true during the call and false after the grace window', async () => {
    let resolveInner: () => void = () => {};
    const inner = new Promise<void>((r) => {
      resolveInner = r;
    });
    const runner = createCheckRunner({
      autoUpdater: fakeAutoUpdater(() => inner),
      emitStatus: vi.fn(),
    });
    const promise = runner.check({ manual: true });
    expect(runner.isCheckInFlight()).toBe(true);
    resolveInner();
    await promise;
    expect(runner.isCheckInFlight()).toBe(true); // still in grace window
    await new Promise((r) => setTimeout(r, 1100));
    expect(runner.isCheckInFlight()).toBe(false);
  });
});
