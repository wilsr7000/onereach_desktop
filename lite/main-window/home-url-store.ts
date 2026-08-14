/**
 * Configurable Home-tab URL — main process.
 *
 * The main window's Home tab loads a remote page; WHICH page is a
 * user setting (Settings → Home) persisted as one JSON file under
 * userData. Default: the GSX Product Expert email-triage prototype
 * (see DEFAULT_HOME_URL).
 *
 * The stored URL may contain the literal placeholder `{accountId}`,
 * substituted at load time with the signed-in GSX account id — so a
 * URL like `https://…/app?accountId={accountId}` personalizes without
 * hardcoding the account. The default URL needs no placeholder.
 *
 * @internal — read by main-window/window.ts; written via IPC from the
 * Settings section.
 */

import { app } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * The default Home page (2026-08-14, fourth iteration by user request):
 * the GSX Expert IDW on Edison. No placeholder needed — the IDW reads
 * the signed-in session itself (the tab rides the auto-login
 * machinery like any IDW surface).
 */
export const DEFAULT_HOME_URL = 'https://idw.edison.onereach.ai/gsx-expert';

/** Overridable for tests. */
let baseDirOverride: string | null = null;

export function setHomeUrlStoreDirForTesting(dir: string | null): void {
  baseDirOverride = dir;
}

function storePath(): string {
  const base = baseDirOverride ?? app.getPath('userData');
  return path.join(base, 'home-url.json');
}

/**
 * Validate a candidate Home URL. https only (this loads inside the
 * app's most prominent surface), must parse, and the placeholder —
 * if present — must be the exact token.
 */
export function validateHomeUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 2048) return null;
  // Substitute a syntactically-valid dummy so URL parsing succeeds.
  const candidate = trimmed.replace('{accountId}', 'placeholder');
  try {
    const url = new URL(candidate);
    if (url.protocol !== 'https:') return null;
  } catch {
    return null;
  }
  return trimmed;
}

/** The configured URL, or the default when unset/corrupt. */
export async function readHomeUrl(): Promise<{ url: string; isDefault: boolean }> {
  try {
    const raw = await fs.readFile(storePath(), 'utf8');
    const parsed = JSON.parse(raw) as { url?: unknown };
    const valid = validateHomeUrl(parsed.url);
    if (valid !== null) return { url: valid, isDefault: false };
  } catch {
    /* missing or corrupt → default */
  }
  return { url: DEFAULT_HOME_URL, isDefault: true };
}

/**
 * Persist a new Home URL (validated), or reset to the default with
 * null. Returns the effective state after the write.
 */
export async function writeHomeUrl(
  raw: string | null
): Promise<{ url: string; isDefault: boolean }> {
  const target = storePath();
  if (raw === null) {
    await fs.rm(target, { force: true });
    return { url: DEFAULT_HOME_URL, isDefault: true };
  }
  const valid = validateHomeUrl(raw);
  if (valid === null) {
    throw new Error('Home URL must be a valid https:// URL (max 2048 chars).');
  }
  const tmp = `${target}.tmp`;
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(tmp, JSON.stringify({ url: valid }, null, 2), 'utf8');
  await fs.rename(tmp, target);
  return { url: valid, isDefault: false };
}

/** Substitute the account-id placeholder (no-op when absent). */
export function resolveHomeUrl(configured: string, accountId: string | null): string {
  if (!configured.includes('{accountId}')) return configured;
  // split/join: replaces EVERY occurrence (the Settings copy promises
  // "anywhere in the URL") and is immune to String.replace's
  // $-pattern expansion; encodeURIComponent keeps a hostile or odd
  // account id from restructuring the URL (2026-08-07 review).
  return configured.split('{accountId}').join(encodeURIComponent(accountId ?? ''));
}
