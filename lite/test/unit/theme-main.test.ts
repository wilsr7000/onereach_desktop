/**
 * Appearance — main-process behaviour.
 *
 * The stored preference must reach `nativeTheme.themeSource` (that is
 * the ONE mechanism every window's prefers-color-scheme follows), the
 * IPC surface must persist + apply + reject junk, and window factories
 * must get a background that matches the effective scheme.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

type Handler = (...args: unknown[]) => unknown;

// vi.mock factories are hoisted above every import; shared state must be too.
const { registered, backgrounds, fakeNativeTheme } = vi.hoisted(() => ({
  registered: new Map<string, Handler>(),
  backgrounds: [] as string[],
  fakeNativeTheme: {
    themeSource: 'system' as 'system' | 'light' | 'dark',
    get shouldUseDarkColors(): boolean {
      return this.themeSource === 'dark';
    },
    on: () => undefined,
    removeListener: () => undefined,
  },
}));

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp' },
  ipcMain: {
    handle: (channel: string, fn: Handler) => {
      registered.set(channel, fn);
    },
    removeHandler: (channel: string) => {
      registered.delete(channel);
    },
  },
  nativeTheme: fakeNativeTheme,
  BrowserWindow: {
    getAllWindows: () => [
      {
        isDestroyed: () => false,
        setBackgroundColor: (c: string) => {
          backgrounds.push(c);
        },
      },
    ],
  },
}));

vi.mock('../../logging/api.js', () => ({
  getLoggingApi: () => ({
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  }),
}));

import {
  initTheme,
  windowBackgroundColor,
  THEME_IPC,
  DARK_WINDOW_BACKGROUND,
  LIGHT_WINDOW_BACKGROUND,
} from '../../theme/main.js';
import { setThemeStoreDirForTesting, writeTheme } from '../../theme/store.js';

describe('theme main', () => {
  let dir: string;
  let teardown: (() => void) | null = null;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'theme-main-'));
    setThemeStoreDirForTesting(dir);
    fakeNativeTheme.themeSource = 'system';
    registered.clear();
    backgrounds.length = 0;
  });

  afterEach(() => {
    teardown?.();
    teardown = null;
    setThemeStoreDirForTesting(null);
    rmSync(dir, { recursive: true, force: true });
  });

  it('a fresh install applies LIGHT to nativeTheme (never leaves it on system)', async () => {
    const handle = await initTheme();
    teardown = handle.teardown;
    expect(fakeNativeTheme.themeSource).toBe('light');
    expect(handle.getState()).toEqual({ preference: 'light', isDefault: true });
    expect(windowBackgroundColor()).toBe(LIGHT_WINDOW_BACKGROUND);
  });

  it('a stored preference is applied at init', async () => {
    await writeTheme('dark');
    const handle = await initTheme();
    teardown = handle.teardown;
    expect(fakeNativeTheme.themeSource).toBe('dark');
    expect(windowBackgroundColor()).toBe(DARK_WINDOW_BACKGROUND);
  });

  it('the SET channel persists, applies, and repaints live windows', async () => {
    const handle = await initTheme();
    teardown = handle.teardown;
    const set = registered.get(THEME_IPC.SET);
    expect(set).toBeDefined();
    const state = await set?.({}, { preference: 'dark' });
    expect(state).toEqual({ preference: 'dark', isDefault: false });
    expect(fakeNativeTheme.themeSource).toBe('dark');
    expect(backgrounds).toEqual([DARK_WINDOW_BACKGROUND]);
    expect(await registered.get(THEME_IPC.GET)?.({})).toEqual({
      preference: 'dark',
      isDefault: false,
    });
    // Survives a "restart".
    handle.teardown();
    teardown = null;
    const again = await initTheme();
    teardown = again.teardown;
    expect(again.getState().preference).toBe('dark');
  });

  it('SET with null resets to light; junk is refused as an IPC error envelope', async () => {
    await writeTheme('dark');
    const handle = await initTheme();
    teardown = handle.teardown;
    const set = registered.get(THEME_IPC.SET);
    expect(await set?.({}, { preference: null })).toEqual({ preference: 'light', isDefault: true });
    expect(fakeNativeTheme.themeSource).toBe('light');
    await expect(set?.({}, { preference: 'neon' })).rejects.toThrow(/light, dark, system/);
    expect(fakeNativeTheme.themeSource).toBe('light');
  });

  it('teardown unregisters both channels', async () => {
    const handle = await initTheme();
    handle.teardown();
    expect(registered.has(THEME_IPC.GET)).toBe(false);
    expect(registered.has(THEME_IPC.SET)).toBe(false);
  });
});
