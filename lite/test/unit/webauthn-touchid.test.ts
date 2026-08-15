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
    expect(src).toContain("typeof app.configureWebAuthn !== 'function'");
    // MUST run after whenReady — the module-load-time call SIGTRAPs
    // packaged builds (live-bisected 2026-08-14). The call lives in a
    // function invoked from the whenReady chain, never at module scope.
    expect(src).toContain('export function configureTouchIdWebAuthn');
    const readyIdx = src.indexOf('.whenReady()');
    const invokeIdx = src.indexOf('configureTouchIdWebAuthn();');
    expect(readyIdx).toBeGreaterThan(-1);
    expect(invokeIdx).toBeGreaterThan(readyIdx);
  });

  it('the restricted entitlements and the provisioning profile move together', () => {
    // Under Developer ID, keychain-access-groups without an embedded
    // Developer ID provisioning profile makes AMFI SIGKILL the app at
    // launch (live-confirmed 2026-08-14, exit 137). The profile landed
    // 2026-08-15; these assertions keep the pairing intact: entitlement
    // trio in the MAIN plist, profile wired in the builder, helpers on
    // a separate inherit plist with NO restricted keys.
    const plist = readFileSync(resolve(root, 'lite/build/entitlements.mac.plist'), 'utf-8');
    expect(plist).toContain('<key>keychain-access-groups</key>');
    expect(plist).toContain(`<string>${GROUP}</string>`);
    // Minimal restricted surface: the keychain group alone satisfies
    // configureWebAuthn; the application-identifier pair is deliberately
    // NOT requested (fewer restricted entitlements to reason about).
    expect(plist).not.toContain('com.apple.application-identifier');

    const cfg = JSON.parse(readFileSync(resolve(root, 'lite/electron-builder.json'), 'utf-8'));
    expect(cfg.mac.provisioningProfile).toBe('lite/build/Onereach_Lite_DeveloperID.provisionprofile');
    expect(cfg.mac.entitlementsInherit).toBe('lite/build/entitlements.mac.inherit.plist');

    // The embedded profile must actually allowlist our group (wildcard).
    const profile = readFileSync(resolve(root, 'lite/build/Onereach_Lite_DeveloperID.provisionprofile'), 'latin1');
    expect(profile).toContain('6KTEPA3LSD.*');
    expect(profile).toContain('6KTEPA3LSD.com.onereach.lite');

    // Helpers carry no restricted keys — they have no embedded profile.
    const inherit = readFileSync(resolve(root, 'lite/build/entitlements.mac.inherit.plist'), 'utf-8');
    expect(inherit).not.toContain('keychain-access-groups');
    expect(inherit).not.toContain('com.apple.application-identifier');
  });

  it('electron-builder signs with the lite plist (both entitlement keys)', () => {
    const cfg = JSON.parse(readFileSync(resolve(root, 'lite/electron-builder.json'), 'utf-8'));
    expect(cfg.mac.entitlements).toBe('lite/build/entitlements.mac.plist');
    // Helpers deliberately use the inherit plist (no restricted keys).
    expect(cfg.mac.entitlementsInherit).toBe('lite/build/entitlements.mac.inherit.plist');
    expect(cfg.appId).toBe('com.onereach.lite');
  });

  it('the account-select handler always answers, on EVERY session', () => {
    const src = readFileSync(resolve(root, 'lite/auth/window.ts'), 'utf-8');
    // Idempotent installer exported for boot wiring.
    expect(src).toContain('export function installWebAuthnAccountPicker');
    // The callback invocation must be in a finally block — an
    // unanswered event pends the WebAuthn ceremony forever, which
    // reads as "I clicked and nothing happened" (live-hit 2026-08-15).
    const idx = src.indexOf('export function installWebAuthnAccountPicker');
    const body = src.slice(idx, idx + 1600);
    expect(body).toContain('} finally {');
    expect(body).toContain('pick(chosen);');
    // Boot installs it on every session the app ever creates.
    const boot = readFileSync(resolve(root, 'lite/main-lite.ts'), 'utf-8');
    expect(boot).toContain("app.on('session-created'");
    expect(boot).toContain('installWebAuthnAccountPicker(sess);');
  });
});
