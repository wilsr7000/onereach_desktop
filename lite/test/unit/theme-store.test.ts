/**
 * Appearance preference store — light by default, persisted, corrupt-
 * tolerant, and closed to values the renderer might invent.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  DEFAULT_THEME,
  THEME_PREFERENCES,
  readTheme,
  writeTheme,
  validateThemePreference,
  setThemeStoreDirForTesting,
} from '../../theme/store.js';

describe('theme store', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'theme-store-'));
    setThemeStoreDirForTesting(dir);
  });

  afterEach(() => {
    setThemeStoreDirForTesting(null);
    rmSync(dir, { recursive: true, force: true });
  });

  it('light is the default, and the default is reported as such', async () => {
    expect(DEFAULT_THEME).toBe('light');
    expect(await readTheme()).toEqual({ preference: 'light', isDefault: true });
  });

  it('persists a choice and reads it back across "restarts"', async () => {
    expect(await writeTheme('dark')).toEqual({ preference: 'dark', isDefault: false });
    expect(existsSync(path.join(dir, 'theme.json'))).toBe(true);
    expect(await readTheme()).toEqual({ preference: 'dark', isDefault: false });
    expect(await writeTheme('system')).toEqual({ preference: 'system', isDefault: false });
    expect((await readTheme()).preference).toBe('system');
  });

  it('null resets to the default and removes the file', async () => {
    await writeTheme('dark');
    expect(await writeTheme(null)).toEqual({ preference: 'light', isDefault: true });
    expect(existsSync(path.join(dir, 'theme.json'))).toBe(false);
    expect(await readTheme()).toEqual({ preference: 'light', isDefault: true });
  });

  it('a corrupt or foreign file falls back to light', async () => {
    writeFileSync(path.join(dir, 'theme.json'), '{nope');
    expect(await readTheme()).toEqual({ preference: 'light', isDefault: true });
    writeFileSync(path.join(dir, 'theme.json'), JSON.stringify({ preference: 'neon' }));
    expect(await readTheme()).toEqual({ preference: 'light', isDefault: true });
  });

  it('rejects anything outside the three known values', async () => {
    for (const bad of ['neon', '', 'LIGHT', 42, {}, undefined]) {
      expect(validateThemePreference(bad)).toBeNull();
      await expect(writeTheme(bad)).rejects.toThrow(/light, dark, system/);
    }
    for (const good of THEME_PREFERENCES) {
      expect(validateThemePreference(good)).toBe(good);
    }
    expect(existsSync(path.join(dir, 'theme.json'))).toBe(false);
  });
});
