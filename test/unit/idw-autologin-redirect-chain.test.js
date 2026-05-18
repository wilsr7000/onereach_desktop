/**
 * IDW auto-login -- redirect-chain doom-loop regression
 *
 * Post-v5.0.14 fix.
 *
 * When an IDW session token expires, OneReach's auth flow runs the user
 * through a 5-step server-side redirect chain that finishes in ~7 seconds:
 *
 *   idw.edison.onereach.ai/<idwId>/<page>             (token-checked)
 *     -> auth.edison.onereach.ai/expired-token?...    (stateless redirector)
 *     -> idw.edison.onereach.ai/<idwId>/<page>        (re-attempt)
 *     -> idw.edison.onereach.ai/login?idwId=...       (begin SSO)
 *     -> auth.edison.onereach.ai/?sso=true&...        (SSO redirector)
 *     -> auth.edison.onereach.ai/login?sso=true&...   (REAL form)
 *
 * Two interlocking bugs trapped users on the final form:
 *
 *   1. /expired-token matched isAuthPage() (auth.* host + onereach.ai)
 *      and queued an auto-login attempt. By the time the queue ran, the
 *      page had moved on to the next hop.
 *
 *   2. The "no longer on auth page when queue ran" branch called
 *      markAutoLoginGaveUp(), setting a 10-second cooldown. The real
 *      /login page that arrived ~7s later was inside that cooldown and
 *      every re-detect was silently skipped, leaving the user stuck.
 *
 * Fix:
 *   - isAuthPage() short-circuits to false for known stateless redirector
 *     paths (/expired-token, /logout, /sign-out, /signout) even when
 *     the host matches auth.*.onereach.ai.
 *   - The "page navigated away" branch now calls clearActiveLogin() (which
 *     just releases the queue) instead of markAutoLoginGaveUp(). The 10s
 *     cooldown is preserved for its original purpose: "tried 5 times to
 *     find form, gave up" (line ~898) and "webview not accessible" (~826).
 *
 * Tests are split into:
 *   - Source-level invariants: regex pins on the file so a future refactor
 *     can't silently reintroduce the doom loop.
 *   - Behavioral: extracts isAuthPage() via vm and exercises it against the
 *     full redirect chain plus negative cases.
 */

import { describe, it, expect } from 'vitest';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const RENDERER_SOURCE = fs.readFileSync(
  path.join(__dirname, '../../browser-renderer.js'),
  'utf8'
);

describe('browser-renderer -- AUTH_REDIRECTOR_PATHS pins the redirector blacklist', () => {
  it('exports the AUTH_REDIRECTOR_PATHS constant', () => {
    expect(RENDERER_SOURCE).toMatch(/const\s+AUTH_REDIRECTOR_PATHS\s*=\s*\[/);
  });

  it('blacklists /expired-token (the smoking-gun path from the original bug report)', () => {
    const decl = RENDERER_SOURCE.match(/const\s+AUTH_REDIRECTOR_PATHS\s*=\s*\[[^\]]+\]/);
    expect(decl, 'AUTH_REDIRECTOR_PATHS literal must be inline').toBeTruthy();
    expect(decl[0]).toMatch(/['"]\/expired-token['"]/);
  });

  it('blacklists /logout, /sign-out, /signout for symmetry with sign-out flows', () => {
    const decl = RENDERER_SOURCE.match(/const\s+AUTH_REDIRECTOR_PATHS\s*=\s*\[[^\]]+\]/);
    expect(decl[0]).toMatch(/['"]\/logout['"]/);
    expect(decl[0]).toMatch(/['"]\/sign-out['"]/);
    expect(decl[0]).toMatch(/['"]\/signout['"]/);
  });
});

describe('browser-renderer -- isAuthPage() consults AUTH_REDIRECTOR_PATHS', () => {
  it('isAuthPage short-circuits via AUTH_REDIRECTOR_PATHS before the host check', () => {
    // Slice the function body and assert the redirector check appears
    // before the auth.* host check. If the order ever flips, the
    // fallback host match will return true for /expired-token again.
    const fnMatch = RENDERER_SOURCE.match(/function isAuthPage\(url\)\s*\{[\s\S]*?\n\}/);
    expect(fnMatch, 'isAuthPage function must exist').toBeTruthy();
    const body = fnMatch[0];
    const redirectorCheckIdx = body.indexOf('AUTH_REDIRECTOR_PATHS');
    const hostCheckIdx = body.indexOf("'auth.'");
    expect(redirectorCheckIdx).toBeGreaterThan(-1);
    expect(hostCheckIdx).toBeGreaterThan(-1);
    expect(redirectorCheckIdx).toBeLessThan(hostCheckIdx);
  });
});

describe('browser-renderer -- "page navigated away" branch releases queue without 10s cooldown', () => {
  // Locate the attemptAutoLoginWithRetry function block.
  function extractAttemptFn() {
    const start = RENDERER_SOURCE.indexOf('async function attemptAutoLoginWithRetry');
    expect(start).toBeGreaterThan(-1);
    // Slice ~2500 chars; enough to span the early "page moved away"
    // branch but not the form-not-found "give up" branch ~80 lines down.
    return RENDERER_SOURCE.slice(start, start + 2500);
  }

  it('the "page navigated away mid-queue" branch calls clearActiveLogin (not markAutoLoginGaveUp)', () => {
    const body = extractAttemptFn();
    // Anchor on the structured event tag rather than a free-text log
    // message. The event tag is part of the auth:* observability
    // contract and is far less likely to drift than the message string.
    const branchIdx = body.indexOf('auth:queue-page-moved');
    expect(
      branchIdx,
      'the auth:queue-page-moved event tag must exist on the "page navigated away" branch'
    ).toBeGreaterThan(-1);
    const branchSlice = body.slice(branchIdx, branchIdx + 400);
    expect(branchSlice).toMatch(/clearActiveLogin\(tabId\)/);
    expect(branchSlice).not.toMatch(/markAutoLoginGaveUp\(tabId\)/);
  });

  it('the form-not-found branch (line ~898) still calls markAutoLoginGaveUp -- intentional cooldown', () => {
    // The 10s cooldown still has a legitimate use: when 5 retries
    // genuinely fail to find a form. This regression-tests that we
    // didn't accidentally rip out the right call along with the wrong one.
    const giveUpBranch = RENDERER_SOURCE.match(/No form found, giving up[\s\S]{0,300}/);
    expect(giveUpBranch, 'the form-not-found branch must still exist').toBeTruthy();
    expect(giveUpBranch[0]).toMatch(/markAutoLoginGaveUp\(tabId\)/);
  });

  it('the "webview not accessible" branch still calls markAutoLoginGaveUp -- intentional cooldown', () => {
    const wvBranch = RENDERER_SOURCE.match(/Webview not accessible[\s\S]{0,300}/);
    expect(wvBranch, 'the webview-error branch must still exist').toBeTruthy();
    expect(wvBranch[0]).toMatch(/markAutoLoginGaveUp\(tabId\)/);
  });
});

describe('browser-renderer -- isAuthPage() behavior on the full redirect chain', () => {
  // Build a tiny vm sandbox that contains just the AUTH_REDIRECTOR_PATHS
  // declaration and the isAuthPage function. This lets us exercise the
  // pure logic without booting the entire renderer.
  function makeIsAuthPage() {
    const declMatch = RENDERER_SOURCE.match(/const\s+AUTH_REDIRECTOR_PATHS\s*=\s*\[[^\]]+\];/);
    expect(declMatch).toBeTruthy();
    const fnMatch = RENDERER_SOURCE.match(/function isAuthPage\(url\)\s*\{[\s\S]*?\n\}/);
    expect(fnMatch).toBeTruthy();
    const program = `${declMatch[0]}\n${fnMatch[0]}\nresult = isAuthPage(URL);`;
    return (url) => {
      const ctx = { URL: url, result: undefined };
      vm.createContext(ctx);
      vm.runInContext(program, ctx);
      return ctx.result;
    };
  }

  const isAuthPage = makeIsAuthPage();

  // Hops from the actual log timeline (02:37:39 - 02:37:47 in the user's report).
  it('hop 1: /gsx-expert/chat (token-checked IDW page) is NOT an auth page', () => {
    expect(isAuthPage('https://idw.edison.onereach.ai/gsx-expert/chat')).toBe(false);
  });

  it('hop 2: /expired-token redirector is NOT an auth page (the bug we fixed)', () => {
    expect(
      isAuthPage(
        'https://auth.edison.onereach.ai/expired-token?username=robb%40onereach.com&userId=2b8136a1&accountId=dd96413e'
      )
    ).toBe(false);
  });

  it('hop 4: idw.*/login is an auth page (begins SSO)', () => {
    expect(
      isAuthPage(
        'https://idw.edison.onereach.ai/login?idwId=gsx-expert&accountId=dd96413e&page=Chat&returnTo=%2Fgsx-expert%2Fchat'
      )
    ).toBe(true);
  });

  it('hop 5: auth.* root with sso=true IS an auth page (legitimate SSO redirector to the real form)', () => {
    // We do NOT blacklist root `/` -- the form sometimes loads there
    // and even when it redirects again, the next hop (/login) will
    // re-arm auto-login. The 10s gaveUp cooldown is no longer set on
    // race losses, so a brief missed attempt no longer blocks the next.
    expect(isAuthPage('https://auth.edison.onereach.ai/?sso=true&showSkip=true')).toBe(true);
  });

  it('hop 6: auth.*/login (the real form) IS an auth page', () => {
    expect(isAuthPage('https://auth.edison.onereach.ai/login?sso=true&showSkip=true')).toBe(true);
  });

  it('logout / sign-out variants are excluded too', () => {
    expect(isAuthPage('https://auth.edison.onereach.ai/logout?username=foo')).toBe(false);
    expect(isAuthPage('https://auth.edison.onereach.ai/sign-out')).toBe(false);
    expect(isAuthPage('https://auth.edison.onereach.ai/signout')).toBe(false);
  });

  it('non-auth onereach pages do not trigger', () => {
    expect(isAuthPage('https://idw.edison.onereach.ai/gsx-expert/chat')).toBe(false);
    expect(isAuthPage('https://files.edison.api.onereach.ai/public/system/foo.png')).toBe(false);
  });

  it('handles falsy / non-string input gracefully', () => {
    expect(isAuthPage('')).toBe(false);
    expect(isAuthPage(null)).toBe(false);
    expect(isAuthPage(undefined)).toBe(false);
  });
});
