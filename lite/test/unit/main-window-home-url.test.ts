/**
 * Configurable Home-tab URL (Settings → Home, 2026-08-07).
 *
 * Store behavior (temp dir), validation, placeholder substitution, and
 * the main-window wiring invariants: the remote mount reads the
 * configured URL, stays preload-free (ADR-038), grants media only to
 * the page's own origin, and never logs the URL (the default join
 * link's fragment carries the room key).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  DEFAULT_HOME_URL,
  readHomeUrl,
  resolveHomeUrl,
  setHomeUrlStoreDirForTesting,
  validateHomeUrl,
  writeHomeUrl,
} from '../../main-window/home-url-store.js';

describe('home-url store', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'home-url-'));
    setHomeUrlStoreDirForTesting(dir);
  });

  afterEach(() => {
    setHomeUrlStoreDirForTesting(null);
    rmSync(dir, { recursive: true, force: true });
  });

  it('defaults to the GSX Product Expert email-triage prototype', async () => {
    const state = await readHomeUrl();
    expect(state.isDefault).toBe(true);
    expect(state.url).toBe(DEFAULT_HOME_URL);
    expect(DEFAULT_HOME_URL).toBe('https://idw.edison.onereach.ai/gsx-expert');
    // The original request for this URL asked for the GSX account id
    // on the query string — the placeholder delivers it at load time.
    expect(validateHomeUrl(DEFAULT_HOME_URL)).toBe(DEFAULT_HOME_URL);
  });

  it('round-trips a custom URL and resets to default with null', async () => {
    const custom = 'https://thelearningmachine-production.up.railway.app/?accountId={accountId}';
    const saved = await writeHomeUrl(custom);
    expect(saved).toEqual({ url: custom, isDefault: false });
    expect(await readHomeUrl()).toEqual({ url: custom, isDefault: false });
    const reset = await writeHomeUrl(null);
    expect(reset.isDefault).toBe(true);
    expect((await readHomeUrl()).url).toBe(DEFAULT_HOME_URL);
  });

  it('rejects non-https, garbage, and oversized URLs', async () => {
    for (const bad of [
      'http://insecure.example.com',
      'javascript:alert(1)',
      'file:///etc/passwd',
      'not a url',
      '',
      `https://x.example/${'a'.repeat(2050)}`,
    ]) {
      expect(validateHomeUrl(bad), bad.slice(0, 40)).toBeNull();
      await expect(writeHomeUrl(bad)).rejects.toThrow(/https/);
    }
    // Corrupt file on disk degrades to the default, never throws.
    const fs = await import('node:fs');
    fs.writeFileSync(path.join(dir, 'home-url.json'), '{nope');
    expect((await readHomeUrl()).isDefault).toBe(true);
  });

  it('substitutes {accountId} only when present', () => {
    expect(
      resolveHomeUrl('https://x.example/app?accountId={accountId}', 'acct-1')
    ).toBe('https://x.example/app?accountId=acct-1');
    expect(resolveHomeUrl('https://x.example/app?accountId={accountId}', null)).toBe(
      'https://x.example/app?accountId='
    );
    // The new default (gsx-expert IDW) carries no placeholder — it must
    // pass through untouched.
    expect(resolveHomeUrl(DEFAULT_HOME_URL, 'acct-1')).toBe(DEFAULT_HOME_URL);
    expect(resolveHomeUrl('https://x.example/static', 'acct-1')).toBe(
      'https://x.example/static'
    );
  });
});

describe('main-window remote-home wiring (source-level)', () => {
  const read = (rel: string): string => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('node:fs') as typeof import('node:fs');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const p = require('node:path') as typeof import('node:path');
    const candidates = [p.resolve(rel), p.resolve('lite', rel)];
    const found = candidates.find((f) => fs.existsSync(f));
    if (found === undefined) throw new Error(`${rel} not found`);
    return fs.readFileSync(found, 'utf8');
  };

  it('the remote mount reads the configured URL, preload-free, media scoped to its origin', () => {
    const src = read('main-window/window.ts');
    const start = src.indexOf('function attachRemoteHome');
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf('\n}', start);
    const body = src.slice(start, end);
    expect(body).toContain('readHomeUrl()');
    expect(body).toContain('resolveHomeUrl(configured, accountId)');
    expect(body).not.toContain('preload:');
    expect(body).toContain('setPermissionRequestHandler');
    // Fail-closed: anything that is not a media request from the
    // configured page's own origin gets callback(false).
    expect(body).toMatch(/permission !== 'media' \|\| allowedOrigin === null/);
    expect(body).toContain('callback(requesterOrigin === allowedOrigin)');
    // The join link's fragment carries the room key — never log the URL.
    expect(body).toContain('never log the URL');
  });

  it('the Settings section + IPC + bridge are wired end to end', () => {
    expect(read('settings/settings.ts')).toContain('mountHome');
    expect(read('main-window/main.ts')).toContain("HOME_URL_GET: 'lite:main-window:homeUrl:get'");
    expect(read('preload-lite.ts')).toContain('homeUrl: {');
  });
});

// ---------------------------------------------------------------------------
// Fresh-install sign-in wall (2026-08-30 audit). A virgin profile's Home
// view loads the gsx-expert IDW, which bounces to
// idw.edison.onereach.ai/login — and that view sat VISIBLE over the
// boot-chat welcome, so a new user's first screen was the IDW's own SSO
// form (which signs into the web view's cookie jar, not the app). The
// rule: a signed-out app hides a Home view parked on a OneReach login
// page so the app's real sign-in wall shows through.
// ---------------------------------------------------------------------------
import {
  looksLikeOneReachLoginUrl,
  shouldShowRemoteHome,
} from '../../main-window/home-url-store.js';

describe('looksLikeOneReachLoginUrl', () => {
  it('matches the auth host and /login paths on any env host — including the IDW runtime', () => {
    expect(looksLikeOneReachLoginUrl('https://auth.edison.onereach.ai/login?x=1', 'edison')).toBe(true);
    expect(looksLikeOneReachLoginUrl('https://studio.edison.onereach.ai/login', 'edison')).toBe(true);
    // The fresh-install case that was missed: the IDW runtime's own interstitial.
    expect(looksLikeOneReachLoginUrl('https://idw.edison.onereach.ai/login?idwId=gsx-expert', 'edison')).toBe(true);
  });

  it('does not match signed-in IDW pages, other envs, or junk', () => {
    expect(looksLikeOneReachLoginUrl('https://idw.edison.onereach.ai/gsx-expert', 'edison')).toBe(false);
    expect(looksLikeOneReachLoginUrl('https://idw.staging.onereach.ai/login', 'edison')).toBe(false);
    expect(looksLikeOneReachLoginUrl('https://evil.example.com/login', 'edison')).toBe(false);
    expect(looksLikeOneReachLoginUrl('', 'edison')).toBe(false);
    expect(looksLikeOneReachLoginUrl('https://idw.edison.onereach.ai/login', null)).toBe(false);
  });
});

describe('shouldShowRemoteHome', () => {
  const login = 'https://idw.edison.onereach.ai/login?idwId=gsx-expert';
  it('hides a signed-out login interstitial so the boot-chat wall shows', () => {
    expect(shouldShowRemoteHome(login, 'edison', false)).toBe(false);
  });
  it('shows everything else: signed-in login bounce, real IDW pages, non-OneReach', () => {
    expect(shouldShowRemoteHome(login, 'edison', true)).toBe(true);
    expect(shouldShowRemoteHome('https://idw.edison.onereach.ai/gsx-expert', 'edison', false)).toBe(true);
    expect(shouldShowRemoteHome('https://example.com', null, false)).toBe(true);
  });
});
