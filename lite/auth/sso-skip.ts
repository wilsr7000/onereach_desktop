/**
 * SSO auto-skip -- click the "Skip" / "Continue with current session"
 * button on the OneReach auth page when an IDW tab redirects through
 * it.
 *
 * Why this exists:
 * --------------------------------------------------------------------
 * Per ADR-042, lite injects the captured `mult` + `or` cookies into a
 * per-tab partition before the IDW navigates. The OneReach auth flow
 * accepts these cookies (the redirect URLs preserve `accountId=...`)
 * but still renders an interstitial page with `sso=true&showSkip=true`
 * params -- it's offering a one-click "use my existing session" path.
 *
 * The full app's tab works "without prompting" because (presumably)
 * its UI auto-clicks the Skip button or the user does so once and
 * the partition cookie sticks.
 *
 * For lite's "ultimate convenience" goal, this module:
 *   1. Detects when an IDW tab's WebContentsView lands on a
 *      `auth.<env>.onereach.ai/login?sso=true&showSkip=true&...` URL
 *   2. Injects a tiny script that finds and clicks the Skip /
 *      Continue button
 *   3. Emits `auth.sso-skip.*` events so the action is auditable in
 *      the lite event log
 *
 * Safety:
 *   - Only runs on OneReach auth domains (`auth.<env>.onereach.ai`)
 *   - Only when the URL has the SSO query params (so we never
 *     auto-click on the password-required path)
 *   - Hard-coded selector list -- conservative, prefers exact text
 *     matches over fuzzy
 *   - Failures soft-fail (logged, no rejection); the user can still
 *     interact manually if our auto-click misses
 *
 * @internal -- consumed by `lite/main-window/window.ts`'s `attachTab`.
 */

import type { WebContents } from 'electron';
import { getLoggingApi } from '../logging/api.js';
import { isOneReachDomain, extractEnvironment } from './store.js';
import type { Environment } from './types.js';

/** Stable event name catalogue for the SSO-skip flow. */
export const SSO_SKIP_EVENTS = {
  ATTEMPT: 'auth.sso-skip.attempt',
  CLICKED: 'auth.sso-skip.clicked',
  NOT_FOUND: 'auth.sso-skip.not-found',
  FAILED: 'auth.sso-skip.failed',
} as const;

/**
 * Returns true iff the URL is the OneReach auth page with SSO + Skip
 * params -- the only place we should be auto-clicking.
 */
export function isOneReachSsoSkipUrl(url: string): {
  match: boolean;
  env: Environment | null;
} {
  if (typeof url !== 'string' || url.length === 0) return { match: false, env: null };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { match: false, env: null };
  }
  const host = parsed.hostname.toLowerCase();
  if (!isOneReachDomain(host)) return { match: false, env: null };
  if (!host.startsWith('auth.')) return { match: false, env: null };
  // The path can be `/`, `/login`, or anything inside the auth host
  // that carries the sso flow.
  const sso = parsed.searchParams.get('sso');
  const showSkip = parsed.searchParams.get('showSkip');
  if (sso !== 'true' || showSkip !== 'true') return { match: false, env: null };
  const env = extractEnvironment(host);
  return { match: env !== null, env };
}

/**
 * Script that runs in the auth page's context. Scans + watches for the
 * Skip button:
 *   1. Immediate scan on injection (most pages render Skip in the
 *      first paint when the SSO flow recognizes cookies).
 *   2. If not found, install a MutationObserver that watches for
 *      DOM mutations and re-scans on each one -- catches SPAs that
 *      render Skip after their JS bundle boots and reads cookies.
 *   3. Time-bounded: gives up after 5 seconds and disconnects the
 *      observer so we don't leak an indefinite watcher.
 *
 * Returns immediately with the initial-scan result; the observer
 * fires & clicks asynchronously inside the page (logged via
 * `console.log` which lite captures via `console-message` if needed,
 * but the main proof point is the click side-effect: the page
 * navigates away). For our purposes, "did the page navigate?" is the
 * definitive signal.
 *
 * Notes:
 *   - The function literal is serialized via executeJavaScript, so it
 *     must be self-contained (no closure references to lite types).
 *   - Idempotent: running twice on the same page is safe -- if the
 *     button was already clicked, the second observer immediately
 *     disconnects when it can't find it.
 */
const AUTO_CLICK_SCRIPT = `(function () {
  // Ordered list of selectors to try. The first match wins.
  // Update this list as the OneReach auth UI evolves -- prefer
  // explicit data attributes over text matches.
  var SELECTORS = [
    'button[data-testid="skip-button"]',
    'button[data-testid="sso-continue"]',
    'button[data-action="skip"]',
    'a[data-action="skip"]',
    '[data-test="skip"]',
    'button[name="skip"]'
  ];
  var TEXT_PATTERNS = [
    /^skip$/i,
    /^continue$/i,
    /^use\\s+(existing|my)\\s+session$/i,
    /^stay\\s+signed\\s+in$/i,
    /^continue\\s+with\\s+/i
  ];

  function findSkip() {
    for (var i = 0; i < SELECTORS.length; i++) {
      var el = document.querySelector(SELECTORS[i]);
      if (el && typeof el.click === 'function') return { el: el, by: 'selector', match: SELECTORS[i] };
    }
    var candidates = document.querySelectorAll('button, a[role="button"], a.btn, a.button');
    for (var j = 0; j < candidates.length; j++) {
      var c = candidates[j];
      var text = (c.textContent || '').trim();
      if (text.length === 0 || text.length > 40) continue;
      for (var k = 0; k < TEXT_PATTERNS.length; k++) {
        if (TEXT_PATTERNS[k].test(text)) return { el: c, by: 'text', match: text };
      }
    }
    return null;
  }

  function tryClick() {
    var hit = findSkip();
    if (hit !== null) {
      try { hit.el.click(); } catch (e) { return { clicked: false, reason: 'click-threw' }; }
      return { clicked: true, by: hit.by, match: hit.match };
    }
    return null;
  }

  // 1. Immediate attempt.
  var first = tryClick();
  if (first !== null) return first;

  // 2. Watch the DOM for the button to appear. Self-disconnects on
  // success or after 5 seconds.
  if (typeof MutationObserver !== 'function' || !document.body) {
    return { clicked: false, reason: 'no-skip-button-found' };
  }
  try {
    var observer = new MutationObserver(function () {
      var hit = tryClick();
      if (hit !== null && hit.clicked) {
        observer.disconnect();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(function () { observer.disconnect(); }, 5000);
    return { clicked: false, reason: 'watching' };
  } catch (e) {
    return { clicked: false, reason: 'observer-failed' };
  }
})()`;

interface SsoSkipResult {
  clicked: boolean;
  by?: 'selector' | 'text';
  /** When clicked: the selector or text that matched. */
  match?: string;
  /** When NOT clicked: 'watching' = observer installed; otherwise a
   *  short failure reason. */
  reason?: string;
}

/**
 * Attempt the auto-click on the given webContents. Caller owns the
 * gate (only call when the URL matches `isOneReachSsoSkipUrl`). Soft-
 * fails: logs and emits events but never throws.
 */
export async function tryAutoSkipSso(
  webContents: WebContents,
  env: Environment,
  url: string
): Promise<SsoSkipResult> {
  const log = getLoggingApi();
  log.event(SSO_SKIP_EVENTS.ATTEMPT, { env, url });
  try {
    const result = (await webContents.executeJavaScript(
      AUTO_CLICK_SCRIPT,
      true /* userGesture */
    )) as SsoSkipResult;
    if (result.clicked) {
      log.event(SSO_SKIP_EVENTS.CLICKED, {
        env,
        by: result.by,
        ...(result.match !== undefined ? { match: result.match } : {}),
      });
    } else {
      // 'watching' is the expected state when the observer is
      // installed and waiting -- not really a failure. Log it as
      // not-found with the reason so the event stream still tells
      // the story.
      log.event(SSO_SKIP_EVENTS.NOT_FOUND, { env, reason: result.reason ?? 'unknown' });
    }
    return result;
  } catch (err) {
    log.event(
      SSO_SKIP_EVENTS.FAILED,
      { env, error: (err as Error).message },
      'warn'
    );
    return { clicked: false, reason: 'execute-js-failed' };
  }
}
