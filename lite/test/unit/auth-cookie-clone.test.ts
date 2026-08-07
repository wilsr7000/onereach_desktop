/**
 * Cookie clone translation — the host-only distinction.
 *
 * Diagnosed from production logs, not hypothetically: every boot's
 * partition clone failed the same three cookies —
 *
 *   __Host-GAPS@accounts.google.com
 *   __Host-1PLSID@accounts.google.com
 *   __Host-3PLSID@accounts.google.com
 *   "Failed to set cookie - ... invalid __Host- or __Secure- prefix"
 *
 * Those three ARE the Google SSO session. OneReach signs in via
 * Google, so a partition holding all 32 OneReach cookies but none of
 * these still walks the full Google login + 2FA on every single boot —
 * which is both the recurring "auto-login broke" report and the flood
 * of sign-in notifications the user received.
 *
 * The defect: Electron's read shape reports `domain` for EVERY cookie,
 * host-only or not, and the old translation passed it straight back
 * into `cookies.set()`. A set() with a Domain attribute violates the
 * `__Host-` prefix contract (secure + path=/ + host-only), so Chromium
 * rejected exactly the cookies that mattered most.
 */

import { describe, it, expect } from 'vitest';
import { cookieSetDetailsFromSource } from '../../auth/store.js';
import type { Cookie } from 'electron';

/** Build an Electron read-shape cookie. */
function cookie(over: Partial<Cookie> & { name: string }): Cookie {
  return {
    value: 'v',
    domain: 'example.com',
    hostOnly: true,
    path: '/',
    secure: true,
    httpOnly: true,
    session: false,
    ...over,
  } as Cookie;
}

describe('the three cookies that failed in production', () => {
  const NAMES = ['__Host-GAPS', '__Host-1PLSID', '__Host-3PLSID'];
  for (const name of NAMES) {
    it(`${name} produces a prefix-legal set()`, () => {
      const details = cookieSetDetailsFromSource(
        cookie({ name, domain: 'accounts.google.com', hostOnly: true })
      );
      // The prefix contract, verbatim: secure, path=/, NO Domain.
      expect(details.domain, 'a Domain attribute makes Chromium reject the set').toBeUndefined();
      expect(details.secure).toBe(true);
      expect(details.path).toBe('/');
      expect(details.url).toBe('https://accounts.google.com/');
    });
  }
});

describe('host-only cookies in general', () => {
  it('never sends a domain for a host-only source', () => {
    const details = cookieSetDetailsFromSource(
      cookie({ name: 'sid', domain: 'app.onereach.ai', hostOnly: true })
    );
    // Widening a host-only cookie to a Domain cookie exposes it to
    // every subdomain — subtly wrong even where Chromium accepts it.
    expect(details.domain).toBeUndefined();
    expect(details.url).toBe('https://app.onereach.ai/');
  });

  it('treats a __Host- name as host-only even if hostOnly is absent', () => {
    // Belt-and-braces: read shapes vary across Electron versions; the
    // NAME is the contract. Build the shape without hostOnly at all —
    // exactOptionalPropertyTypes forbids an explicit undefined.
    const base = cookie({ name: '__Host-x', domain: 'a.example' }) as unknown as Record<string, unknown>;
    delete base['hostOnly'];
    const details = cookieSetDetailsFromSource(base as never);
    expect(details.domain).toBeUndefined();
    expect(details.secure).toBe(true);
    expect(details.path).toBe('/');
  });

  it('forces path / for __Host- even when the source path is wrong', () => {
    const details = cookieSetDetailsFromSource(
      cookie({ name: '__Host-x', domain: 'a.example', path: '/weird' })
    );
    expect(details.path).toBe('/');
    expect(details.url).toBe('https://a.example/');
  });
});

describe('genuine domain cookies keep working', () => {
  it('preserves a leading-dot domain verbatim', () => {
    const details = cookieSetDetailsFromSource(
      cookie({ name: 'mult', domain: '.onereach.ai', hostOnly: false })
    );
    expect(details.domain).toBe('.onereach.ai');
    expect(details.url).toBe('https://onereach.ai/');
  });

  it('passes ordinary attributes through unchanged', () => {
    const details = cookieSetDetailsFromSource(
      cookie({
        name: 'or',
        domain: '.onereach.ai',
        hostOnly: false,
        path: '/api',
        secure: true,
        httpOnly: true,
        sameSite: 'lax',
        expirationDate: 1893456000,
      })
    );
    expect(details.path).toBe('/api');
    expect(details.secure).toBe(true);
    expect(details.httpOnly).toBe(true);
    expect(details.sameSite).toBe('lax');
    expect(details.expirationDate).toBe(1893456000);
  });

  it('does not force secure onto a non-prefixed insecure cookie', () => {
    const details = cookieSetDetailsFromSource(
      cookie({ name: 'plain', domain: 'a.example', hostOnly: true, secure: false })
    );
    expect(details.secure).toBe(false);
  });
});
