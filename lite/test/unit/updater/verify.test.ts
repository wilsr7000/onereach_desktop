/**
 * Unit tests for lite/updater/verify.ts -- cross-restart install verification.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { verifyUpdateOnStartup } from '../../../updater/verify.js';
import { readUpdateState, writeUpdateState } from '../../../updater/state.js';

let userDataDir: string;

beforeEach(async () => {
  userDataDir = await fs.mkdtemp(path.join(tmpdir(), 'lite-verify-test-'));
});

afterEach(async () => {
  await fs.rm(userDataDir, { recursive: true, force: true });
});

function makeDeps(opts: {
  currentVersion: string;
  dialogResponse?: 0 | 1 | 2;
}): Parameters<typeof verifyUpdateOnStartup>[0] {
  return {
    userDataPath: userDataDir,
    currentVersion: opts.currentVersion,
    openReleasesPage: vi.fn(),
    triggerCheck: vi.fn(),
    dialogs: {
      showFailureDialog: vi.fn().mockResolvedValue(opts.dialogResponse ?? 2),
    },
  };
}

describe('verifyUpdateOnStartup', () => {
  it('no-prior-attempt: returns immediately, no dialog, no state change', async () => {
    const deps = makeDeps({ currentVersion: '1.0.0' });
    const result = await verifyUpdateOnStartup(deps);
    expect(result.outcome).toBe('no-prior-attempt');
    expect(deps.dialogs.showFailureDialog).not.toHaveBeenCalled();
    expect(deps.openReleasesPage).not.toHaveBeenCalled();
  });

  it('install-succeeded: lastAttemptVersion === currentVersion clears state', async () => {
    writeUpdateState(userDataDir, {
      failedAttempts: 1,
      lastAttemptVersion: '1.0.0',
      lastAttemptTime: 'whenever',
      lastFailedVersions: [],
    });
    const deps = makeDeps({ currentVersion: '1.0.0' });
    const result = await verifyUpdateOnStartup(deps);
    expect(result.outcome).toBe('install-succeeded');
    expect(readUpdateState(userDataDir)).toEqual({
      failedAttempts: 0,
      lastAttemptVersion: null,
      lastAttemptTime: null,
      lastFailedVersions: [],
    });
    expect(deps.dialogs.showFailureDialog).not.toHaveBeenCalled();
  });

  it('install-failed: increments failedAttempts and shows dialog', async () => {
    writeUpdateState(userDataDir, {
      failedAttempts: 0,
      lastAttemptVersion: '2.0.0',
      lastAttemptTime: 'whenever',
      lastFailedVersions: [],
    });
    const deps = makeDeps({ currentVersion: '1.0.0', dialogResponse: 2 });
    const result = await verifyUpdateOnStartup(deps);
    expect(result.outcome).toBe('install-failed');
    expect(deps.dialogs.showFailureDialog).toHaveBeenCalledOnce();
    const call = (deps.dialogs.showFailureDialog as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(call.title).toBe("Update Didn't Install");
    expect(call.message).toContain('2.0.0');
    expect(call.buttons).toEqual(['Download Manually', 'Try Auto-Update Again', 'Skip']);
    expect(call.defaultId).toBe(0);
  });

  it('install-failed (>=2 attempts): uses repeat-failure copy', async () => {
    writeUpdateState(userDataDir, {
      failedAttempts: 1, // becomes 2 after this run
      lastAttemptVersion: '2.0.0',
      lastAttemptTime: 'whenever',
      lastFailedVersions: [],
    });
    const deps = makeDeps({ currentVersion: '1.0.0', dialogResponse: 2 });
    await verifyUpdateOnStartup(deps);
    const call = (deps.dialogs.showFailureDialog as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(call.title).toBe('Update Could Not Be Applied');
    expect(call.message).toContain('failed 2 times');
  });

  it('Download Manually (response=0) clears state and opens releases', async () => {
    writeUpdateState(userDataDir, {
      failedAttempts: 0,
      lastAttemptVersion: '2.0.0',
      lastAttemptTime: 'whenever',
      lastFailedVersions: [],
    });
    const deps = makeDeps({ currentVersion: '1.0.0', dialogResponse: 0 });
    await verifyUpdateOnStartup(deps);
    expect(deps.openReleasesPage).toHaveBeenCalledOnce();
    expect(readUpdateState(userDataDir).lastAttemptVersion).toBeNull();
  });

  it('Try Again (response=1) clears state and triggers a fresh check', async () => {
    writeUpdateState(userDataDir, {
      failedAttempts: 0,
      lastAttemptVersion: '2.0.0',
      lastAttemptTime: 'whenever',
      lastFailedVersions: [],
    });
    const deps = makeDeps({ currentVersion: '1.0.0', dialogResponse: 1 });
    await verifyUpdateOnStartup(deps);
    expect(deps.triggerCheck).toHaveBeenCalledOnce();
    expect(readUpdateState(userDataDir).lastAttemptVersion).toBeNull();
  });

  it('Skip (response=2) preserves state so we re-prompt next launch', async () => {
    writeUpdateState(userDataDir, {
      failedAttempts: 0,
      lastAttemptVersion: '2.0.0',
      lastAttemptTime: 'whenever',
      lastFailedVersions: [],
    });
    const deps = makeDeps({ currentVersion: '1.0.0', dialogResponse: 2 });
    await verifyUpdateOnStartup(deps);
    expect(deps.triggerCheck).not.toHaveBeenCalled();
    expect(deps.openReleasesPage).not.toHaveBeenCalled();
    const after = readUpdateState(userDataDir);
    expect(after.lastAttemptVersion).toBe('2.0.0');
    expect(after.failedAttempts).toBe(1);
  });
});
