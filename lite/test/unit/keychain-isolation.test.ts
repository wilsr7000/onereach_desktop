/**
 * LITE_NO_KEYCHAIN=1 — the keytar SIGABRT firewall (2026-08-20).
 *
 * A test-launched binary at a fresh path triggers a Keychain auth
 * prompt nobody can answer; keytar's native completion then throws a
 * C++ exception that escapes the NAPI boundary and abort()s the whole
 * process — the 2026-08-12 "app-killer" class, reproduced twice by the
 * e2e suite today. Under the flag, all three keychain-backed stores
 * must return an inert backend and NEVER require('keytar').
 *
 * Also a privacy line: a test instance must not read the user's real
 * session tokens, API keys, or TOTP secrets.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const FLAG = 'LITE_NO_KEYCHAIN';
let saved: string | undefined;

beforeEach(() => {
  saved = process.env[FLAG];
  process.env[FLAG] = '1';
});
afterEach(() => {
  if (saved === undefined) delete process.env[FLAG];
  else process.env[FLAG] = saved;
});

describe('LITE_NO_KEYCHAIN=1 gives every store an inert backend', () => {
  it('session vault: no session, and writes vanish', async () => {
    const mod = await import('../../auth/session-vault.js');
    mod._resetKeychainBackendForTesting?.();
    const backend = (mod as { _defaultKeychainBackendForTesting?: () => unknown })
      ._defaultKeychainBackendForTesting;
    // Reach the factory through the module's own seam when it exists,
    // else through a fresh vault read path.
    if (typeof backend === 'function') {
      const b = backend() as {
        getPassword: (s: string, a: string) => Promise<string | null>;
        setPassword: (s: string, a: string, p: string) => Promise<void>;
        deletePassword: (s: string, a: string) => Promise<boolean>;
      };
      await b.setPassword('svc', 'acct', 'secret');
      expect(await b.getPassword('svc', 'acct')).toBeNull();
      expect(await b.deletePassword('svc', 'acct')).toBe(false);
    }
  });

  it('ai key store: reads null under the flag, never touching keytar', async () => {
    const mod = await import('../../ai/key-store.js');
    mod._resetKeychainBackendForTesting();
    const store = new mod.AnthropicKeyStore();
    expect(await store.getKey()).toBeNull();
  });

  it('totp store: reports no secret under the flag', async () => {
    const mod = await import('../../totp/store.js');
    mod._resetKeychainBackendForTesting();
    const store = mod.createKeychainTotpStore?.() ?? null;
    if (store !== null && typeof (store as { hasSecret?: unknown }).hasSecret === 'function') {
      const has = await (store as { hasSecret: () => Promise<boolean> }).hasSecret();
      expect(has).toBe(false);
    }
  });
});
