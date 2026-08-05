/**
 * IDW-tab login-outcome verifier -- the "did auto-login actually work?"
 * check.
 *
 * The problem this solves:
 * --------------------------------------------------------------------
 * The auto-login chain for an IDW tab (inject cookies → SSO-skip →
 * 2FA autofill → account-picker auto-select) is fire-and-forget. Each
 * step emits its own event, but NOTHING watched the OUTCOME. So a tab
 * that landed on a OneReach login page and stayed there -- because the
 * Skip button never rendered, the page wanted a password, the account
 * picker needed a manual choice, or 2FA had no saved secret -- "just
 * spun on login" with no signal in the event log and no guidance for
 * the user.
 *
 * This module is the separate check: after a tab settles, it probes
 * the live page (URL + a tiny DOM scan) on an interval until it either
 * observes a logged-in state (SUCCESS) or times out still on a login
 * page (STUCK). On STUCK it derives a best-guess cause and a plain
 * actionable instruction, emits `auth.idw-login.*` events to the
 * central logger, and hands the instruction to a callback so the
 * chrome can show the user what to do.
 *
 * Security: NO secrets are ever read or logged -- only URL origins,
 * the NAMES of DOM login markers (never their values), timing, and
 * the verdict.
 *
 * Pure logic + injectable seams (probeUrl / probeDom / emit / now /
 * schedule) so the whole watcher is unit-testable with fake timers and
 * a stubbed page. `lite/main-window/window.ts` wires the real seams via
 * {@link makeWebContentsProbe}.
 *
 * @internal
 */

import type { WebContents } from 'electron';
import { AUTH_EVENTS, type IdwLoginCause, type IdwLoginVerdict } from './events.js';
import { isOneReachDomain } from './store.js';
import type { Environment } from './types.js';

/** DOM markers that mean "this page is still asking the user to log in." */
const LOGIN_SIGNALS: ReadonlySet<string> = new Set([
  'password-field',
  'sso-skip-button',
  'account-picker',
  'twofa-field',
  'sign-in-text',
]);

/**
 * Returns true when the URL is a OneReach auth / login route -- the
 * `auth.<env>.onereach.ai` host (always an auth host), or any OneReach
 * host on a `/login|/signin|/sso` path.
 */
export function isOneReachAuthOrLoginUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const host = u.hostname.toLowerCase();
  if (!isOneReachDomain(host)) return false;
  if (host.startsWith('auth.')) return true;
  return /(^|\/)(login|signin|sign-in|sso)(\/|$)/.test(u.pathname.toLowerCase());
}

/**
 * Self-contained page script: scan the DOM for login markers and
 * return their NAMES (never values). Serialized via executeJavaScript,
 * so it must not close over anything.
 */
export const LOGIN_PROBE_SCRIPT = `(function () {
  var s = [];
  try {
    if (document.querySelector('input[type="password"]')) s.push('password-field');
    if (document.querySelector('button[data-testid="skip-button"],button[data-action="skip"],a[data-action="skip"],[data-test="skip"]')) s.push('sso-skip-button');
    if (document.querySelector('[data-testid="account-picker"],[data-test="account-list"],[data-testid="account-list"]')) s.push('account-picker');
    if (document.querySelector('input[autocomplete="one-time-code"],input[name*="otp" i],input[name*="totp" i]')) s.push('twofa-field');
    var els = document.querySelectorAll('button,a,h1,h2,[role="heading"]');
    for (var i = 0; i < els.length && i < 400; i++) {
      var t = (els[i].textContent || '').trim().toLowerCase();
      if (t.length === 0 || t.length > 40) continue;
      if (/^(sign[ -]?in|log[ -]?in|continue with|use existing session|stay signed in)/.test(t)) { s.push('sign-in-text'); break; }
    }
  } catch (e) { /* best-effort; a failed scan reports no signals */ }
  return { signals: s, title: (document.title || '').slice(0, 120) };
})()`;

export interface DomProbe {
  signals: string[];
  title?: string;
}

/**
 * Classify a single probe. `stuck-on-login` means "still looks like a
 * login page"; `logged-in` means "on a normal page with no login
 * markers"; `unknown` means "not yet a real URL" (still navigating).
 */
export function classifyLoginState(
  url: string,
  signals: string[]
): { verdict: IdwLoginVerdict; onAuthUrl: boolean; loginSignals: string[] } {
  const onAuthUrl = isOneReachAuthOrLoginUrl(url);
  const loginSignals = signals.filter((x) => LOGIN_SIGNALS.has(x));
  const looksLikeLogin = onAuthUrl || loginSignals.length > 0;
  let verdict: IdwLoginVerdict;
  if (looksLikeLogin) verdict = 'stuck-on-login';
  else if (/^https?:\/\//i.test(url)) verdict = 'logged-in';
  else verdict = 'unknown';
  return { verdict, onAuthUrl, loginSignals };
}

/** Best-guess cause from the strongest login signal present. */
export function deriveLoginCause(signals: string[], onAuthUrl: boolean): IdwLoginCause {
  if (signals.includes('twofa-field')) return 'twofa-required';
  if (signals.includes('account-picker')) return 'account-picker';
  if (signals.includes('sso-skip-button')) return 'sso-skip-missed';
  if (signals.includes('password-field') || signals.includes('sign-in-text')) {
    return 'manual-login-required';
  }
  if (onAuthUrl) return 'no-session';
  return 'unknown';
}

/** Plain, actionable guidance for the user, keyed to the cause. */
export function instructionForLoginCause(cause: IdwLoginCause, label?: string): string {
  const who = label !== undefined && label.length > 0 ? `“${label}”` : 'this agent';
  switch (cause) {
    case 'twofa-required':
      return `${who} is asking for a 2-factor code. Save your authenticator secret in Settings → Two-Factor so Lite can fill it automatically, or type the code in the tab.`;
    case 'account-picker':
      return `${who} is showing an account picker. Choose your account in the tab — Lite couldn’t select it automatically.`;
    case 'sso-skip-missed':
      return `${who} is on the OneReach “continue with your session” screen. Click Continue / Skip in the tab to finish signing in.`;
    case 'manual-login-required':
      return `${who} needs a manual sign-in. Sign in inside the tab and Lite will remember it next time.`;
    case 'no-session':
      return `You may not be signed in to OneReach. Open Settings → Account to sign in, then reopen ${who}.`;
    default:
      return `${who} didn’t finish signing in automatically. Sign in inside the tab to continue.`;
  }
}

export interface LoginOutcome {
  verdict: 'logged-in' | 'stuck-on-login';
  attempts: number;
  durationMs: number;
  urlOrigin: string;
  signals: string[];
  likelyCause?: IdwLoginCause;
  instruction?: string;
}

/** Injectable seams -- real ones come from a WebContents + the logger. */
export interface LoginVerifierDeps {
  /** Current top-level URL of the tab. */
  probeUrl: () => string;
  /** Scan the live DOM for login markers. */
  probeDom: () => Promise<DomProbe>;
  /** Emit an event to the central logger. */
  emit: (
    name: string,
    data: Record<string, unknown>,
    level?: 'info' | 'warn' | 'error'
  ) => void;
  /** Monotonic clock (ms). */
  now: () => number;
  /** Schedule `fn` after `ms`; returns a canceller. */
  schedule: (fn: () => void, ms: number) => () => void;
  /** Final verdict callback (both success and stuck). */
  onOutcome?: (outcome: LoginOutcome) => void;
  /** Stuck-only callback -- carries the user instruction for the chrome. */
  onNeedsUserAction?: (info: { likelyCause: IdwLoginCause; instruction: string }) => void;
  /**
   * Optional self-heal hook. When a probe times out on a RECOVERABLE
   * cause (no-session / sso-skip-missed / unknown -- cases a fresh
   * cookie inject + reload can fix), the watcher calls this instead of
   * giving up. Resolve `true` if a recovery was attempted (e.g. cookies
   * re-injected + tab reloaded) -- the watcher then opens a fresh probe
   * window. Resolve `false` (or omit the hook) to go straight to the
   * stuck verdict + user instruction. Bounded by `maxRecoveries`.
   */
  attemptRecovery?: (cause: IdwLoginCause) => Promise<boolean>;
}

export interface LoginVerifierOptions {
  tabId: string;
  env?: Environment;
  /** IDW label, used in the user instruction. */
  label?: string;
  /** Poll interval (ms). Default 1500. */
  intervalMs?: number;
  /** Give-up-and-declare-stuck deadline (ms) PER probe window. Default 20000. */
  timeoutMs?: number;
  /** How many self-heal (re-inject + reload) attempts before instructing the user. Default 1. */
  maxRecoveries?: number;
  /**
   * Consecutive logged-in probes required before declaring SUCCESS.
   * Default 3 (~4.5s at the default interval). Guards against an IDW
   * that paints its app shell before its own session check finishes
   * and then routes to /login -- a single good probe is not proof.
   */
  successConfirmations?: number;
}

/** Causes a cookie re-inject + reload can plausibly fix (vs. needing the user). */
const RECOVERABLE_CAUSES: ReadonlySet<IdwLoginCause> = new Set<IdwLoginCause>([
  'no-session',
  'sso-skip-missed',
  'unknown',
]);

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '<unparseable>';
  }
}

/**
 * Start watching a tab's login outcome. Polls until logged-in (success)
 * or timeout (stuck). Returns a disposer -- call it if the tab closes
 * before a verdict.
 */
export function startLoginVerifier(
  opts: LoginVerifierOptions,
  deps: LoginVerifierDeps
): () => void {
  const intervalMs = opts.intervalMs ?? 1500;
  const timeoutMs = opts.timeoutMs ?? 20000;
  const maxRecoveries = opts.maxRecoveries ?? 1;
  const startedAt = deps.now();
  /** Reset on each recovery so the stuck-timeout is PER probe window. */
  let windowStart = startedAt;
  let recoveries = 0;
  let attempt = 0;
  let stopped = false;
  let cancelTimer: (() => void) | null = null;
  /** Consecutive logged-in probes seen so far (reset by any non-success). */
  let loggedInStreak = 0;
  /** How many consecutive logged-in probes are required to declare success. */
  const confirmations = Math.max(1, opts.successConfirmations ?? 3);

  const envData = opts.env !== undefined ? { env: opts.env } : {};

  const finish = (
    verdict: 'logged-in' | 'stuck-on-login',
    signals: string[],
    cause?: IdwLoginCause
  ): void => {
    if (stopped) return;
    stopped = true;
    if (cancelTimer !== null) cancelTimer();
    const durationMs = deps.now() - startedAt;
    const urlOrigin = originOf(deps.probeUrl());
    const base = { tabId: opts.tabId, ...envData, attempts: attempt, durationMs, urlOrigin };
    if (verdict === 'logged-in') {
      deps.emit(AUTH_EVENTS.IDW_LOGIN_SUCCESS, base, 'info');
      deps.onOutcome?.({ verdict, attempts: attempt, durationMs, urlOrigin, signals });
      return;
    }
    const likelyCause: IdwLoginCause = cause ?? 'unknown';
    const instruction = instructionForLoginCause(likelyCause, opts.label);
    deps.emit(AUTH_EVENTS.IDW_LOGIN_STUCK, { ...base, signals, likelyCause }, 'warn');
    deps.emit(
      AUTH_EVENTS.IDW_LOGIN_NEEDS_USER_ACTION,
      {
        tabId: opts.tabId,
        ...envData,
        ...(opts.label !== undefined ? { label: opts.label } : {}),
        likelyCause,
        instruction,
      },
      'warn'
    );
    deps.onNeedsUserAction?.({ likelyCause, instruction });
    deps.onOutcome?.({
      verdict,
      attempts: attempt,
      durationMs,
      urlOrigin,
      signals,
      likelyCause,
      instruction,
    });
  };

  const tick = async (): Promise<void> => {
    if (stopped) return;
    attempt += 1;
    const url = deps.probeUrl();
    let signals: string[] = [];
    // Whether we actually SAW the page this tick. A thrown scan (page
    // mid-navigation, destroyed, or a cross-origin frame we can't read)
    // yields no signals -- which is indistinguishable from "scanned it,
    // it's clean" unless we track it. That distinction matters: it
    // gates the auto-reload below, and reloading a page we couldn't
    // read risks wiping a login form the user is mid-way through.
    let scanOk = true;
    try {
      const dom = await deps.probeDom();
      signals = Array.isArray(dom.signals) ? dom.signals : [];
    } catch {
      signals = [];
      scanOk = false;
    }
    if (stopped) return;
    const { verdict, onAuthUrl, loginSignals } = classifyLoginState(url, signals);
    deps.emit(
      AUTH_EVENTS.IDW_LOGIN_PROBE,
      {
        tabId: opts.tabId,
        attempt,
        verdict,
        onAuthUrl,
        signals: loginSignals,
        urlOrigin: originOf(url),
      },
      'info'
    );
    if (verdict === 'logged-in') {
      // Require the logged-in state to HOLD before declaring success.
      // A OneReach IDW can render its app shell while its own session
      // check is still in flight, then route to /login moments later --
      // so a single good probe is not proof. Observed live: probe said
      // logged-in at 1.5s, the app bounced to /login at ~9s, and the
      // premature success had already stopped the watch.
      loggedInStreak += 1;
      if (loggedInStreak >= confirmations) {
        finish('logged-in', loginSignals);
        return;
      }
    } else {
      loggedInStreak = 0;
    }
    if (deps.now() - windowStart >= timeoutMs) {
      void handleStuck(loginSignals, deriveLoginCause(loginSignals, onAuthUrl), scanOk);
      return;
    }
    cancelTimer = deps.schedule(() => {
      void tick();
    }, intervalMs);
  };

  /**
   * Timed-out on a login page. If the cause is recoverable and we have
   * retry budget, self-heal (re-inject + reload via `attemptRecovery`)
   * and open a fresh probe window. Otherwise declare stuck + instruct.
   */
  const handleStuck = async (
    signals: string[],
    cause: IdwLoginCause,
    scanOk = true
  ): Promise<void> => {
    if (stopped) return;
    // Only self-heal when we could actually READ the page. Recovery
    // reloads the tab, and a reload throws away anything the user has
    // typed -- so if the last scan threw we surface the instruction
    // instead of gambling a reload on a page we couldn't classify.
    if (
      recoveries < maxRecoveries &&
      deps.attemptRecovery !== undefined &&
      scanOk &&
      RECOVERABLE_CAUSES.has(cause)
    ) {
      recoveries += 1;
      deps.emit(
        AUTH_EVENTS.IDW_LOGIN_RETRY,
        { tabId: opts.tabId, ...envData, attempt: recoveries, likelyCause: cause },
        'info'
      );
      let recovered = false;
      try {
        recovered = await deps.attemptRecovery(cause);
      } catch {
        recovered = false;
      }
      if (stopped) return;
      if (recovered) {
        windowStart = deps.now(); // fresh window after the reload
        cancelTimer = deps.schedule(() => {
          void tick();
        }, intervalMs);
        return;
      }
    }
    finish('stuck-on-login', signals, cause);
  };

  deps.emit(
    AUTH_EVENTS.IDW_LOGIN_START,
    { tabId: opts.tabId, ...envData, urlOrigin: originOf(deps.probeUrl()) },
    'info'
  );
  // First probe after one interval -- give the fire-and-forget auto-login
  // steps (sso-skip observer, account-picker autofill) a beat to land.
  cancelTimer = deps.schedule(() => {
    void tick();
  }, intervalMs);

  return (): void => {
    stopped = true;
    if (cancelTimer !== null) cancelTimer();
  };
}

/**
 * Build the live probe seams from a real WebContents. Used by
 * `attachTab`; kept here so the DOM script + URL access live next to
 * the logic they feed.
 */
export function makeWebContentsProbe(webContents: WebContents): {
  probeUrl: () => string;
  probeDom: () => Promise<DomProbe>;
} {
  return {
    probeUrl: () => {
      try {
        return webContents.isDestroyed() ? '' : webContents.getURL();
      } catch {
        return '';
      }
    },
    probeDom: async () => {
      if (webContents.isDestroyed()) return { signals: [] };
      const raw = (await webContents.executeJavaScript(LOGIN_PROBE_SCRIPT, false)) as
        | DomProbe
        | undefined;
      return {
        signals: Array.isArray(raw?.signals) ? raw!.signals : [],
        ...(typeof raw?.title === 'string' ? { title: raw.title } : {}),
      };
    },
  };
}
