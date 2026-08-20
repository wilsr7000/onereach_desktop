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
    mod._resetSessionVaultBackendForTesting();
    const vault = new mod.SessionVault();
    const cookie = {
      name: 'c',
      value: 'secret',
      domain: 'example.test',
      path: '/',
    } as Parameters<typeof vault.save>[1];
    await vault.save('edison', cookie, cookie);
    expect(await vault.load('edison')).toBeNull();
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
    const store = new mod.TotpStore();
    expect(await store.hasSecret()).toBe(false);
  });
});
