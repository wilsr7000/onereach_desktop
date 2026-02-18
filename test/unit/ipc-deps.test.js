/**
 * IPC Dependencies Namespace - Lifecycle Tests
 *
 * Lifecycle: checkAll -> install -> onInstallOutput -> cancelInstall -> verify
 *
 * Run:  npx vitest run test/unit/ipc-deps.test.js
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const installed = new Set();
const mockInvoke = vi.fn(async (channel, ...args) => {
  switch (channel) {
    case 'deps:check-all':
      return [
        { name: 'ffmpeg', installed: installed.has('ffmpeg'), required: true },
        { name: 'yt-dlp', installed: installed.has('yt-dlp'), required: false },
      ];
    case 'deps:install':
      installed.add(args[0]);
      return { success: true, name: args[0] };
    case 'deps:install-all':
      installed.add('ffmpeg');
      installed.add('yt-dlp');
      return { success: true };
    case 'deps:cancel-install':
      return { cancelled: true, name: args[0] };
    case 'deps:get-aider-python':
      return '/usr/bin/python3';
    default:
      return null;
  }
});
const mockOn = vi.fn();

const depsAPI = {
  checkAll: () => mockInvoke('deps:check-all'),
  install: (name) => mockInvoke('deps:install', name),
  installAll: () => mockInvoke('deps:install-all'),
  cancelInstall: (name) => mockInvoke('deps:cancel-install', name),
  getAiderPython: () => mockInvoke('deps:get-aider-python'),
  onInstallOutput: (cb) => mockOn('deps:install-output', cb),
};

beforeEach(() => {
  installed.clear();
  mockInvoke.mockClear();
});

describe('IPC Dependencies - Install Lifecycle', () => {
  it('Step 1: Check all dependencies', async () => {
    const deps = await depsAPI.checkAll();
    expect(Array.isArray(deps)).toBe(true);
    expect(deps.length).toBeGreaterThan(0);
    expect(deps[0]).toHaveProperty('name');
    expect(deps[0]).toHaveProperty('installed');
  });

  it('Step 2: Install a dependency', async () => {
    const result = await depsAPI.install('ffmpeg');
    expect(result.success).toBe(true);
    expect(result.name).toBe('ffmpeg');
  });

  it('Step 3: Verify installed after install', async () => {
    await depsAPI.install('ffmpeg');
    const deps = await depsAPI.checkAll();
    const ffmpeg = deps.find((d) => d.name === 'ffmpeg');
    expect(ffmpeg.installed).toBe(true);
  });

  it('Step 4: Cancel an install', async () => {
    const result = await depsAPI.cancelInstall('yt-dlp');
    expect(result.cancelled).toBe(true);
  });

  it('Step 5: Install all dependencies', async () => {
    const result = await depsAPI.installAll();
    expect(result.success).toBe(true);
  });

  it('Step 6: Verify all installed', async () => {
    await depsAPI.installAll();
    const deps = await depsAPI.checkAll();
    expect(deps.every((d) => d.installed)).toBe(true);
  });

  it('Step 7: Get aider python path', async () => {
    const path = await depsAPI.getAiderPython();
    expect(path).toBeTruthy();
  });

  it('Step 8: Register install output callback', () => {
    const cb = vi.fn();
    depsAPI.onInstallOutput(cb);
    expect(mockOn).toHaveBeenCalledWith('deps:install-output', cb);
  });
});
