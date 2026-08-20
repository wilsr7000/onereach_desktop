/**
 * OneReach session vault — OS keychain persistence of the captured
 * auth session, so the user signs in ONCE and stays signed in across
 * restarts (2026-08-10).
 *
 * THE PROBLEM this solves: the auth session lived only in the
 * `persist:lite-auth-<env>` partition cookie jar. OneReach's
 * load-bearing `mult`/`or` cookies are SESSION cookies (no
 * expirationDate), which Electron never writes to disk — so every app
 * quit evicted them, `hydrate()` found nothing on the next boot, and
 * every IDW tab fell back to the login page. "Log in to every IDW
 * every time."
 *
 * THE FIX: on every validated capture, mirror the `mult`+`or` cookie
 * pair into the OS keychain (encrypted at rest — the secure way to
 * "persist the token"). On boot, if the partition lost them, restore
 * them as PERSISTENT cookies (a forced future expiry) so they survive.
 * The OneReach SERVER remains the authority — it validates the token
 * VALUE against its own session store — so extending the client-side
 * cookie lifetime is safe: an expired server session still fails and
 * falls through to a normal re-login (which then re-vaults fresh
 * tokens). signOut clears the vault so it can't resurrect a session.
 *
 * SECURITY: token values appear only in `setPassword`/`getPassword`
 * calls, never in logs or error context. Mirrors the keytar pattern
 * proven by `lite/ai/key-store.ts` and `lite/totp/store.ts`. Every
 * method soft-fails (a broken Keychain degrades to "no vault", i.e.
 * today's behavior) so it can never crash the app or lock anyone out.
 *
 * @internal
 */

import type { Cookie } from 'electron';

/**
 * Minimal keytar surface (same shape as ai/totp). Production wires the
 * real `keytar`; tests inject a Map-backed fake.
 */
export interface KeychainBackend {
  setPassword(service: string, account: string, password: string): Promise<void>;
  getPassword(service: string, account: string): Promise<string | null>;
  deletePassword(service: string, account: string): Promise<boolean>;
}

/** Keychain service for the persisted OneReach session. */
export const SESSION_VAULT_SERVICE = 'OneReach.ai-Session';

/** A single stored cookie — the Electron.Cookie fields we need to re-set it. */
export interface VaultedCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  hostOnly?: boolean;
  sameSite?: Cookie['sameSite'];
  /** Seconds since epoch (Electron's unit). Absent = was a session cookie. */
  expirationDate?: number;
}

/** The persisted bundle: the load-bearing pair + when it was saved. */
export interface VaultedSession {
  mult: VaultedCookie;
  or: VaultedCookie;
  /** ms epoch. */
  savedAt: number;
}

const SCHEMA = 1;

let _defaultBackend: KeychainBackend | null = null;

function defaultKeychainBackend(): KeychainBackend {
  if (process.env['LITE_NO_KEYCHAIN'] === '1') {
    // Keychain disabled (e2e isolation, 2026-08-20): a test-launched
    // binary at a fresh path triggers a Keychain auth prompt nobody can
    // answer, and keytar's native completion then throws a C++ exception
    // that escapes the NAPI boundary — abort(), the 2026-08-12
    // "app-killer" crash class, reproduced twice today. A test instance
    // also has no business reading the user's REAL session tokens.
    if (_defaultBackend === null) {
      _defaultBackend = {
        setPassword: async () => undefined,
        getPassword: async () => null,
        deletePassword: async () => false,
      };
    }
    return _defaultBackend;
  }
  if (_defaultBackend === null) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
    _defaultBackend = require('keytar') as KeychainBackend;
  }
  return _defaultBackend;
}

/** @internal — tests reset the cached keytar binding. */
export function _resetSessionVaultBackendForTesting(): void {
  _defaultBackend = null;
}

/**
 * @internal — install a fake keychain as the process-wide default so
 * every `new SessionVault()` (incl. those inside AuthStore) uses it
 * instead of the real OS keychain. Mirrors `_setKVApiForTesting`.
 * Prevents tests from doing real keychain I/O.
 */
export function _setSessionVaultBackendForTesting(backend: KeychainBackend): void {
  _defaultBackend = backend;
}

/** Keep only the Electron.Cookie fields we re-set; drop everything else. */
function toVaultedCookie(c: Cookie): VaultedCookie {
  const out: VaultedCookie = { name: c.name, value: c.value };
  if (typeof c.domain === 'string') out.domain = c.domain;
  if (typeof c.path === 'string') out.path = c.path;
  if (typeof c.secure === 'boolean') out.secure = c.secure;
  if (typeof c.httpOnly === 'boolean') out.httpOnly = c.httpOnly;
  if (typeof c.hostOnly === 'boolean') out.hostOnly = c.hostOnly;
  if (typeof c.sameSite === 'string') out.sameSite = c.sameSite;
  if (typeof c.expirationDate === 'number') out.expirationDate = c.expirationDate;
  return out;
}

/**
 * Return the cookie with a GUARANTEED-future expirationDate, so a
 * restored session cookie becomes persistent and survives the next
 * quit. Preserves an already-future expiry; bumps a missing/past one to
 * `nowMs + ttlDays`. Pure — no I/O.
 */
export function withPersistentExpiry(
  c: VaultedCookie,
  nowMs: number,
  ttlDays = 30
): VaultedCookie {
  const nowSec = Math.floor(nowMs / 1000);
  const horizon = nowSec + ttlDays * 24 * 60 * 60;
  const current = typeof c.expirationDate === 'number' ? c.expirationDate : 0;
  return { ...c, expirationDate: current > nowSec ? current : horizon };
}

/**
 * Keychain-backed store of the OneReach session, keyed per environment.
 * Tiny surface: save / load / clear. Everything soft-fails.
 */
export class SessionVault {
  private readonly keychain: KeychainBackend;

  constructor(keychain?: KeychainBackend) {
    this.keychain = keychain ?? defaultKeychainBackend();
  }

  private account(env: string): string {
    return `session-${env}`;
  }

  /**
   * Persist the load-bearing cookie pair. Refuses to store an empty
   * token (nothing to restore). Soft-fails on keychain errors.
   */
  async save(env: string, mult: Cookie, or: Cookie): Promise<void> {
    if (
      typeof mult?.value !== 'string' ||
      mult.value.length === 0 ||
      typeof or?.value !== 'string' ||
      or.value.length === 0
    ) {
      return;
    }
    const payload = JSON.stringify({
      schema: SCHEMA,
      mult: toVaultedCookie(mult),
      or: toVaultedCookie(or),
      savedAt: Date.now(),
    });
    try {
      await this.keychain.setPassword(SESSION_VAULT_SERVICE, this.account(env), payload);
    } catch {
      /* soft-fail: no vault this run, behavior degrades to today's */
    }
  }

  /** Read the persisted bundle, or null on miss / corrupt / unavailable. */
  async load(env: string): Promise<VaultedSession | null> {
    let raw: string | null;
    try {
      raw = await this.keychain.getPassword(SESSION_VAULT_SERVICE, this.account(env));
    } catch {
      return null;
    }
    if (raw === null || raw.length === 0) return null;
    try {
      const parsed = JSON.parse(raw) as {
        schema?: number;
        mult?: VaultedCookie;
        or?: VaultedCookie;
        savedAt?: number;
      };
      if (parsed.schema !== SCHEMA) return null;
      if (
        parsed.mult === undefined ||
        parsed.or === undefined ||
        typeof parsed.mult.value !== 'string' ||
        typeof parsed.or.value !== 'string' ||
        parsed.mult.value.length === 0 ||
        parsed.or.value.length === 0
      ) {
        return null;
      }
      return {
        mult: parsed.mult,
        or: parsed.or,
        savedAt: typeof parsed.savedAt === 'number' ? parsed.savedAt : 0,
      };
    } catch {
      return null;
    }
  }

  /** Delete the persisted session (called on signOut). Soft-fails. */
  async clear(env: string): Promise<void> {
    try {
      await this.keychain.deletePassword(SESSION_VAULT_SERVICE, this.account(env));
    } catch {
      /* soft-fail */
    }
  }
}
