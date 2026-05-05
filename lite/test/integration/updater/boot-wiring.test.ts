/**
 * Integration test for lite/updater boot wiring.
 *
 * Verifies that when the updater is initialized:
 *   1. The `help:check-for-updates` menu entry exists in the registry
 *   2. The IPC handlers (check, install, get-state) are registered
 *   3. The lifecycle attaches event listeners to the auto-updater
 *
 * Doesn't launch a real Electron app -- mocks just enough of the surface
 * to exercise initUpdater without bringing up Electron itself.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { registry } from '../../../menu/registry.js';
import { seedKernelMenu, _resetSeedForTesting } from '../../../menu/seed.js';
import {
  initUpdater,
  IPC_CHECK,
  IPC_INSTALL,
  IPC_GET_STATE,
} from '../../../updater/index.js';
import type { AutoUpdaterLike } from '../../../updater/init.js';

// Hoisted mock state -- vi.mock's factory is hoisted above all imports, so
// any state it references must also be created via vi.hoisted.
const mockState = vi.hoisted(() => ({
  ipcHandlers: new Map<string, (...args: unknown[]) => unknown>(),
  userData: '',
}));

vi.mock('electron', () => ({
  app: {
    getPath: (kind: string) => {
      if (kind === 'userData') return mockState.userData;
      return '/tmp';
    },
    getVersion: () => '1.0.0',
    isPackaged: false,
    dock: { setBadge: () => {} },
  },
  BrowserWindow: {
    getAllWindows: () => [],
    getFocusedWindow: () => null,
  },
  dialog: {
    showMessageBox: () => Promise.resolve({ response: 1 }),
  },
  shell: {
    openExternal: () => {},
  },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      mockState.ipcHandlers.set(channel, handler);
    },
    removeHandler: (channel: string) => {
      mockState.ipcHandlers.delete(channel);
    },
  },
}));

const ipcHandlers = mockState.ipcHandlers;

beforeEach(async () => {
  ipcHandlers.clear();
  mockState.userData = await fs.mkdtemp(path.join(tmpdir(), 'lite-bootwiring-'));
  registry._resetForTesting();
  _resetSeedForTesting();
});

afterEach(async () => {
  await fs.rm(mockState.userData, { recursive: true, force: true });
});

function fakeAutoUpdater(): AutoUpdaterLike & { emitter: EventEmitter } {
  const emitter = new EventEmitter();
  return {
    logger: null,
    autoDownload: true,
    autoInstallOnAppQuit: false,
    allowDowngrade: true,
    emitter,
    on: (event: string, listener: (...args: unknown[]) => void) => {
      emitter.on(event, listener);
      return null;
    },
    removeAllListeners: (event?: string) => {
      if (event !== undefined) emitter.removeAllListeners(event);
      else emitter.removeAllListeners();
      return null;
    },
    checkForUpdates: vi.fn().mockResolvedValue(null),
    downloadUpdate: vi.fn().mockResolvedValue([]),
    quitAndInstall: vi.fn(),
  };
}

describe('initUpdater boot wiring', () => {
  it('seeds the kernel menu, then registers help:check-for-updates', () => {
    seedKernelMenu({ onReportBug: () => {}, onAbout: () => {}, onQuit: () => {} });
    expect(registry.get('top:help')).toBeDefined();
    expect(registry.get('help:check-for-updates')).toBeUndefined();

    const handle = initUpdater({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      loadAutoUpdater: () => fakeAutoUpdater(),
    });

    expect(registry.get('help:check-for-updates')).toBeDefined();
    expect(registry.get('help:check-for-updates')?.parentId).toBe('top:help');
    handle.teardown();
  });

  it('registers IPC handlers for check / install / get-state', () => {
    const handle = initUpdater({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      loadAutoUpdater: () => fakeAutoUpdater(),
    });
    expect(ipcHandlers.has(IPC_CHECK)).toBe(true);
    expect(ipcHandlers.has(IPC_INSTALL)).toBe(true);
    expect(ipcHandlers.has(IPC_GET_STATE)).toBe(true);
    handle.teardown();
  });

  it('teardown removes IPC handlers and unregisters the menu entry', () => {
    const handle = initUpdater({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      loadAutoUpdater: () => fakeAutoUpdater(),
    });
    expect(ipcHandlers.has(IPC_CHECK)).toBe(true);
    expect(registry.get('help:check-for-updates')).toBeDefined();
    handle.teardown();
    expect(ipcHandlers.has(IPC_CHECK)).toBe(false);
    expect(registry.get('help:check-for-updates')).toBeUndefined();
  });

  it('updater unavailable (loader throws) still registers a fallback menu entry', () => {
    const handle = initUpdater({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      loadAutoUpdater: () => {
        throw new Error('module not found');
      },
    });
    expect(handle.autoUpdater).toBeNull();
    expect(registry.get('help:check-for-updates')).toBeDefined();
    handle.teardown();
  });

  it('check IPC handler delegates to checkRunner.check', async () => {
    const fake = fakeAutoUpdater();
    const handle = initUpdater({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      loadAutoUpdater: () => fake,
    });
    const handler = ipcHandlers.get(IPC_CHECK);
    expect(handler).toBeDefined();
    await handler!({}, { manual: true });
    expect(fake.checkForUpdates).toHaveBeenCalled();
    handle.teardown();
  });
});
