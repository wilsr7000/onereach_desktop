/**
 * Appearance preference — main process store.
 *
 * Lite is light by default (2026-09-01, by user request); Dark keeps
 * the original palette; System follows the OS. The choice persists as
 * one JSON file under userData (`theme.json`), same conventions as the
 * Home-URL store: atomic tmp+rename write, corrupt-tolerant read that
 * falls back to the default, and a test hook for the base directory.
 *
 * Applying the preference is `theme/main.ts`'s job (it drives
 * `nativeTheme.themeSource`, which flips `prefers-color-scheme` in every
 * renderer live) — this module only knows how to remember it.
 */

import { app } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export type ThemePreference = 'light' | 'dark' | 'system';

export const THEME_PREFERENCES: readonly ThemePreference[] = ['light', 'dark', 'system'];

export const DEFAULT_THEME: ThemePreference = 'light';

export interface ThemeState {
  preference: ThemePreference;
  /** True when nothing is stored (or the stored file was unusable). */
  isDefault: boolean;
}

/** Overridable for tests. */
let baseDirOverride: string | null = null;

export function setThemeStoreDirForTesting(dir: string | null): void {
  baseDirOverride = dir;
}

function storePath(): string {
  const base = baseDirOverride ?? app.getPath('userData');
  return path.join(base, 'theme.json');
}

/** Narrow an untrusted value to a preference, or null. */
export function validateThemePreference(raw: unknown): ThemePreference | null {
  return typeof raw === 'string' && (THEME_PREFERENCES as readonly string[]).includes(raw)
    ? (raw as ThemePreference)
    : null;
}

/** The stored preference, or the default when unset/corrupt. */
export async function readTheme(): Promise<ThemeState> {
  try {
    const raw = await fs.readFile(storePath(), 'utf8');
    const parsed = JSON.parse(raw) as { preference?: unknown };
    const valid = validateThemePreference(parsed.preference);
    if (valid !== null) return { preference: valid, isDefault: false };
  } catch {
    /* missing or corrupt → default */
  }
  return { preference: DEFAULT_THEME, isDefault: true };
}

/**
 * Persist a preference, or reset to the default with null. Returns the
 * effective state after the write. Rejects anything outside the three
 * known values — the renderer never gets to invent a fourth theme.
 */
export async function writeTheme(raw: unknown): Promise<ThemeState> {
  const target = storePath();
  if (raw === null) {
    await fs.rm(target, { force: true });
    return { preference: DEFAULT_THEME, isDefault: true };
  }
  const valid = validateThemePreference(raw);
  if (valid === null) {
    throw new Error('Theme must be one of: light, dark, system.');
  }
  const tmp = `${target}.tmp`;
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(tmp, JSON.stringify({ preference: valid }, null, 2), 'utf8');
  await fs.rename(tmp, target);
  return { preference: valid, isDefault: false };
}
