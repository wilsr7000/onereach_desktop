/**
 * Unit tests for the IDW-tab login-outcome verifier -- the "did
 * auto-login actually work?" check. Fully deterministic: the watcher's
 * clock + scheduler + page probes are injected, so no real timers.
 */

import { describe, it, expect } from 'vitest';
import {
  isOneReachAuthOrLoginUrl,
  classifyLoginState,
  deriveLoginCause,
  instructionForLoginCause,
  startLoginVerifier,
  type LoginVerifierDeps,
  type LoginOutcome,
} from '../../auth/login-verifier.js';
import { AUTH_EVENTS, type IdwLoginCause } from '../../auth/events.js';

// ─── pure helpers ──────────────────────────────────────────────────────────

describe('isOneReachAuthOrLoginUrl', () => {
  it('matches the auth.<env> host', () => {
    expect(isOneReachAuthOrLoginUrl('https://auth.edison.onereach.ai/?sso=true')).toBe(true);
  });
  it('matches a OneReach host on a /login path', () => {
    expect(isOneReachAuthOrLoginUrl('https://studio.edison.onereach.ai/login')).toBe(true);
    expect(isOneReachAuthOrLoginUrl('https://idw.edison.onereach.ai/sign-in')).toBe(true);
  });
  it('does NOT match a normal OneReach app URL', () => {
    expect(isOneReachAuthOrLoginUrl('https://idw.edison.onereach.ai/agent/marvin')).toBe(false);
  });
  it('does NOT match non-OneReach hosts', () => {
    expect(isOneReachAuthOrLoginUrl('https://grok.com/login')).toBe(false);
    expect(isOneReachAuthOrLoginUrl('not a url')).toBe(false);
  });
});

describe('classifyLoginState', () => {
  it('is stuck-on-login on an auth URL even with no DOM signals', () => {
    const r = classifyLoginState('https://auth.edison.onereach.ai/?sso=true', []);
    expect(r.verdict).toBe('stuck-on-login');
    expect(r.onAuthUrl).toBe(true);
  });
  it('is stuck-on-login when a login DOM signal is present on any URL', () => {
    const r = classifyLoginState('https://idw.edison.onereach.ai/app', ['password-field']);
    expect(r.verdict).toBe('stuck-on-login');
    expect(r.loginSignals).toEqual(['password-field']);
  });
  it('is logged-in on a normal URL with no login signals', () => {
    const r = classifyLoginState('https://idw.edison.onereach.ai/agent/x', ['nav-bar']);
    expect(r.verdict).toBe('logged-in');
    expect(r.loginSignals).toEqual([]);
  });
  it('is unknown before a real URL exists (still navigating)', () => {
    expect(classifyLoginState('about:blank', []).verdict).toBe('unknown');
    expect(classifyLoginState('', []).verdict).toBe('unknown');
  });
});

describe('deriveLoginCause', () => {
  it('prioritizes 2FA, then account-picker, then sso-skip, then manual', () => {
    expect(deriveLoginCause(['twofa-field', 'password-field'], true)).toBe('twofa-required');
    expect(deriveLoginCause(['account-picker'], true)).toBe('account-picker');
    expect(deriveLoginCause(['sso-skip-button'], true)).toBe('sso-skip-missed');
    expect(deriveLoginCause(['password-field'], false)).toBe('manual-login-required');
    expect(deriveLoginCause(['sign-in-text'], false)).toBe('manual-login-required');
  });
  it('falls back to no-session on an auth URL with no DOM signal, else unknown', () => {
    expect(deriveLoginCause([], true)).toBe('no-session');
    expect(deriveLoginCause([], false)).toBe('unknown');
  });
});

describe('instructionForLoginCause', () => {
  it('gives distinct, actionable guidance per cause and includes the label', () => {
    expect(instructionForLoginCause('twofa-required', 'Marvin')).toContain('Two-Factor');
    expect(instructionForLoginCause('account-picker', 'Marvin')).toContain('account picker');
    expect(instructionForLoginCause('sso-skip-missed', 'Marvin')).toContain('Continue');
    expect(instructionForLoginCause('manual-login-required', 'Marvin')).toContain('manual sign-in');
    expect(instructionForLoginCause('no-session', 'Marvin')).toContain('Settings → Account');
    expect(instructionForLoginCause('twofa-required', 'Marvin')).toContain('Marvin');
    // No label → generic "this agent".
    expect(instructionForLoginCause('unknown')).toContain('this agent');
  });
});

// ─── watcher ────────────────────────────────────────────────────────────────

interface Harness {
  deps: LoginVerifierDeps;
  events: Array<{ name: string; data: Record<string, unknown>; level?: string }>;
  outcomes: LoginOutcome[];
  userActions: Array<{ likelyCause: string; instruction: string }>;
  advance: () => Promise<void>;
  hasPending: () => boolean;
}

function makeHarness(
  script: { url: () => string; signals: () => string[] },
  extra: { attemptRecovery?: (cause: IdwLoginCause) => Promise<boolean> } = {}
): Harness {
  const events: Harness['events'] = [];
  const outcomes: LoginOutcome[] = [];
  const userActions: Harness['userActions'] = [];
  let clock = 0;
  let pending: { fn: () => void; ms: number } | null = null;

  const deps: LoginVerifierDeps = {
    probeUrl: () => script.url(),
    probeDom: async () => ({ signals: script.signals() }),
    emit: (name, data, level) =>
      events.push(level === undefined ? { name, data } : { name, data, level }),
    now: () => clock,
    schedule: (fn, ms) => {
      pending = { fn, ms };
      return () => {
        if (pending !== null && pending.fn === fn) pending = null;
      };
    },
    onOutcome: (o) => outcomes.push(o),
    onNeedsUserAction: (i) => userActions.push(i),
    ...(extra.attemptRecovery !== undefined ? { attemptRecovery: extra.attemptRecovery } : {}),
  };

  const advance = async (): Promise<void> => {
    if (pending === null) return;
    const { fn, ms } = pending;
    pending = null;
    clock += ms;
    fn();
    // Flush the async tick (probeDom is a resolved promise).
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  };

  return { deps, events, outcomes, userActions, advance, hasPending: () => pending !== null };
}

const names = (h: Harness): string[] => h.events.map((e) => e.name);

describe('startLoginVerifier', () => {
  it('emits START immediately and schedules the first probe', () => {
    const h = makeHarness({ url: () => 'https://idw.edison.onereach.ai/x', signals: () => [] });
    startLoginVerifier({ tabId: 't1' }, h.deps);
    expect(names(h)).toEqual([AUTH_EVENTS.IDW_LOGIN_START]);
    expect(h.hasPending()).toBe(true);
  });

  it('resolves to SUCCESS when a probe sees a logged-in page', async () => {
    const h = makeHarness({ url: () => 'https://idw.edison.onereach.ai/agent/x', signals: () => [] });
    startLoginVerifier({ tabId: 't1', env: 'edison' }, h.deps);
    await h.advance();
    expect(names(h)).toContain(AUTH_EVENTS.IDW_LOGIN_PROBE);
    expect(names(h)).toContain(AUTH_EVENTS.IDW_LOGIN_SUCCESS);
    expect(names(h)).not.toContain(AUTH_EVENTS.IDW_LOGIN_STUCK);
    expect(h.outcomes).toHaveLength(1);
    expect(h.outcomes[0]?.verdict).toBe('logged-in');
    expect(h.userActions).toHaveLength(0);
    expect(h.hasPending()).toBe(false); // stopped, no more polling
  });

  it('declares STUCK after the timeout and emits actionable user instruction', async () => {
    const h = makeHarness({
      url: () => 'https://auth.edison.onereach.ai/?sso=true&showSkip=true',
      signals: () => ['sso-skip-button'],
    });
    startLoginVerifier(
      { tabId: 't1', env: 'edison', label: 'Marvin', intervalMs: 1000, timeoutMs: 2500 },
      h.deps
    );
    await h.advance(); // t=1000, stuck, keep polling
    await h.advance(); // t=2000, stuck, keep polling
    await h.advance(); // t=3000 >= 2500 → STUCK
    const stuck = h.events.find((e) => e.name === AUTH_EVENTS.IDW_LOGIN_STUCK);
    expect(stuck?.data.likelyCause).toBe('sso-skip-missed');
    expect(stuck?.data.attempts).toBe(3);
    const action = h.events.find((e) => e.name === AUTH_EVENTS.IDW_LOGIN_NEEDS_USER_ACTION);
    expect(action?.level).toBe('warn');
    expect(String(action?.data.instruction)).toContain('Continue');
    expect(h.userActions).toHaveLength(1);
    expect(h.outcomes[0]?.verdict).toBe('stuck-on-login');
    expect(h.hasPending()).toBe(false);
  });

  it('recovers to SUCCESS if a later probe becomes logged-in (auto-login finishing late)', async () => {
    let loggedIn = false;
    const h = makeHarness({
      url: () => (loggedIn ? 'https://idw.edison.onereach.ai/agent/x' : 'https://auth.edison.onereach.ai/?sso=true'),
      signals: () => [],
    });
    startLoginVerifier({ tabId: 't1', intervalMs: 1000, timeoutMs: 60000 }, h.deps);
    await h.advance(); // stuck (still on auth)
    expect(names(h)).not.toContain(AUTH_EVENTS.IDW_LOGIN_SUCCESS);
    loggedIn = true; // SSO-skip finally landed
    await h.advance(); // now logged-in
    expect(names(h)).toContain(AUTH_EVENTS.IDW_LOGIN_SUCCESS);
    expect(names(h)).not.toContain(AUTH_EVENTS.IDW_LOGIN_STUCK);
  });

  it('disposer stops all further probing', async () => {
    const h = makeHarness({ url: () => 'https://auth.edison.onereach.ai/?sso=true', signals: () => [] });
    const stop = startLoginVerifier({ tabId: 't1', intervalMs: 1000, timeoutMs: 5000 }, h.deps);
    stop();
    expect(h.hasPending()).toBe(false);
    await h.advance(); // nothing pending → no-op
    expect(names(h)).toEqual([AUTH_EVENTS.IDW_LOGIN_START]);
  });

  it('self-heals: retries (re-inject+reload) on a recoverable stuck, then SUCCEEDS', async () => {
    let recovered = false;
    let recoveryCalls = 0;
    const h = makeHarness(
      {
        url: () =>
          recovered
            ? 'https://idw.edison.onereach.ai/agent/x'
            : 'https://auth.edison.onereach.ai/?sso=true',
        signals: () => [],
      },
      {
        attemptRecovery: async () => {
          recoveryCalls += 1;
          recovered = true; // the reload fixed it
          return true;
        },
      }
    );
    startLoginVerifier({ tabId: 't1', intervalMs: 1000, timeoutMs: 2500, maxRecoveries: 1 }, h.deps);
    await h.advance(); // t=1000 stuck
    await h.advance(); // t=2000 stuck
    await h.advance(); // t=3000 → timeout → RETRY + recover (no stuck yet)
    expect(recoveryCalls).toBe(1);
    expect(names(h)).toContain(AUTH_EVENTS.IDW_LOGIN_RETRY);
    expect(names(h)).not.toContain(AUTH_EVENTS.IDW_LOGIN_STUCK);
    await h.advance(); // fresh window → now logged-in → SUCCESS
    expect(names(h)).toContain(AUTH_EVENTS.IDW_LOGIN_SUCCESS);
    expect(h.outcomes.at(-1)?.verdict).toBe('logged-in');
  });

  it('does NOT retry a cause that needs the user (2FA)', async () => {
    let recoveryCalls = 0;
    const h = makeHarness(
      { url: () => 'https://auth.edison.onereach.ai/?sso=true', signals: () => ['twofa-field'] },
      {
        attemptRecovery: async () => {
          recoveryCalls += 1;
          return true;
        },
      }
    );
    startLoginVerifier({ tabId: 't1', label: 'Marvin', intervalMs: 1000, timeoutMs: 1500 }, h.deps);
    await h.advance(); // t=1000 stuck
    await h.advance(); // t=2000 → timeout; cause twofa-required is NOT recoverable → stuck
    expect(recoveryCalls).toBe(0);
    expect(names(h)).not.toContain(AUTH_EVENTS.IDW_LOGIN_RETRY);
    const stuck = h.events.find((e) => e.name === AUTH_EVENTS.IDW_LOGIN_STUCK);
    expect(stuck?.data.likelyCause).toBe('twofa-required');
  });

  it('goes straight to stuck when the recovery attempt reports failure', async () => {
    const h = makeHarness(
      { url: () => 'https://auth.edison.onereach.ai/?sso=true', signals: () => ['sso-skip-button'] },
      { attemptRecovery: async () => false }
    );
    startLoginVerifier({ tabId: 't1', intervalMs: 1000, timeoutMs: 1500 }, h.deps);
    await h.advance(); // t=1000 stuck
    await h.advance(); // t=2000 → timeout → RETRY, recovery=false → stuck
    expect(names(h)).toContain(AUTH_EVENTS.IDW_LOGIN_RETRY);
    expect(names(h)).toContain(AUTH_EVENTS.IDW_LOGIN_STUCK);
  });

  it('retries at most maxRecoveries times, then declares stuck', async () => {
    let recoveryCalls = 0;
    const h = makeHarness(
      { url: () => 'https://auth.edison.onereach.ai/?sso=true', signals: () => [] }, // never recovers
      {
        attemptRecovery: async () => {
          recoveryCalls += 1;
          return true;
        },
      }
    );
    startLoginVerifier({ tabId: 't1', intervalMs: 1000, timeoutMs: 1500, maxRecoveries: 1 }, h.deps);
    await h.advance(); // t=1000 stuck
    await h.advance(); // t=2000 → window1 timeout → RETRY(1), windowStart=2000
    expect(recoveryCalls).toBe(1);
    await h.advance(); // t=3000 → window2 elapsed 1000 < 1500 → still polling
    await h.advance(); // t=4000 → window2 elapsed 2000 ≥ 1500 → budget spent → stuck
    expect(recoveryCalls).toBe(1); // no second retry
    expect(names(h).filter((n) => n === AUTH_EVENTS.IDW_LOGIN_RETRY)).toHaveLength(1);
    expect(names(h)).toContain(AUTH_EVENTS.IDW_LOGIN_STUCK);
  });
});
