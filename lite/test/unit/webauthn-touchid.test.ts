import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * ADR-066 — Touch ID WebAuthn (Secure Enclave platform authenticator).
 * The keychain access group must be IDENTICAL in three places or the
 * feature silently fails in signed builds:
 *   1. the app.configureWebAuthn call (lite/main-lite.ts)
 *   2. the keychain-access-groups entitlement (lite/build/entitlements.mac.plist)
 *   3. the electron-builder mac config pointing at THAT plist
 * This suite makes drift mechanical.
 */

const GROUP = '6KTEPA3LSD.com.onereach.lite.webauthn';
const root = resolve(__dirname, '../../..');

describe('ADR-066 — Touch ID WebAuthn pairing', () => {
  it('main-lite.ts configures the authenticator with the canonical group', () => {
    const src = readFileSync(resolve(root, 'lite/main-lite.ts'), 'utf-8');
    expect(src).toContain(`WEBAUTHN_KEYCHAIN_ACCESS_GROUP = '${GROUP}'`);
    expect(src).toContain('app.configureWebAuthn');
    expect(src).toContain('keychainAccessGroup: WEBAUTHN_KEYCHAIN_ACCESS_GROUP');
    // Guarded: never crash a platform/build without the API.
    expect(src).toContain("typeof app.configureWebAuthn === 'function'");
  });

  it('the lite entitlements plist carries the same group', () => {
    const plist = readFileSync(resolve(root, 'lite/build/entitlements.mac.plist'), 'utf-8');
    expect(plist).toContain('<key>keychain-access-groups</key>');
    expect(plist).toContain(`<string>${GROUP}</string>`);
  });

  it('electron-builder signs with the lite plist (both entitlement keys)', () => {
    const cfg = JSON.parse(readFileSync(resolve(root, 'lite/electron-builder.json'), 'utf-8'));
    expect(cfg.mac.entitlements).toBe('lite/build/entitlements.mac.plist');
    expect(cfg.mac.entitlementsInherit).toBe('lite/build/entitlements.mac.plist');
    expect(cfg.appId).toBe('com.onereach.lite');
  });

  it('the account-select handler always answers (no pending-forever requests)', () => {
    const src = readFileSync(resolve(root, 'lite/auth/window.ts'), 'utf-8');
    expect(src).toContain("sess.on(\n    'select-webauthn-account'");
    // The callback invocation must be in a finally block.
    const idx = src.indexOf("'select-webauthn-account'");
    const body = src.slice(idx, idx + 1200);
    expect(body).toContain('} finally {');
    expect(body).toContain('pick(chosen);');
  });
});
