/**
 * AuthApi tests.
 *
 * Structured per Rule 12 / HARNESS.md:
 *   1. `runApiConformanceContract` -- the uniform contract every module
 *      passes (singleton, reset, set-for-testing, expected methods).
 *   2. `runErrorConformanceContract` -- AuthError + AUTH_ERROR_CODES.
 *   3. Module-specific behavior tests for the sync ops (getSession,
 *      getToken, hasValidSession, onSessionChanged) -- the async ops
 *      (signIn / signOut / hydrate) are exercised in the integration
 *      tier where a real KV server is available.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  getAuthApi,
  _resetAuthApiForTesting,
  _setAuthApiForTesting,
  type AuthApi,
  AuthError,
  AUTH_ERROR_CODES,
} from '../../auth/api.js';
import type { AuthSession, AuthTokenBundle, Environment } from '../../auth/types.js';
import { runApiConformanceContract, runErrorConformanceContract } from '../harness/conformance.js';

// 1. Conformance contract -- runs the uniform suite.
runApiConformanceContract<AuthApi>({
  name: 'AuthApi',
  getInstance: getAuthApi,
  resetForTesting: _resetAuthApiForTesting,
  setForTesting: _setAuthApiForTesting,
  // `hydrate` is intentionally NOT on the public AuthApi -- it's a
  // store-internal method called lazily on first read of getSession.
  expectedMethods: [
    'signIn',
    'signOut',
    'getSession',
    'getToken',
    'getTokenBundle',
    'injectTokenIntoPartition',
    'hasValidSession',
    'onSessionChanged',
    'onTwoFactorNeedsSetup',
    'onEvent',
  ],
});

// 2. Error class conformance.
runErrorConformanceContract<AuthError>({
  name: 'AuthError',
  ErrorClass: AuthError,
  codeEnum: AUTH_ERROR_CODES,
  modulePrefix: 'AUTH_',
  constructErrorWithCode: (code) =>
    new AuthError({
      code: code as never,
      message: 'sample',
      context: { op: 'sample' },
    }),
});

// 3. Module-specific behavior tests using a stub.

/**
 * In-memory stub implementation of AuthApi. The async ops record the
 * call but never actually open a window or hit KV; the sync ops read
 * from an in-memory map.
 */
function makeStubApi(): AuthApi & {
  calls: Array<{ method: string; args: unknown[] }>;
  sessions: Map<Environment, AuthSession>;
  tokens: Map<Environment, string>;
  bundles: Map<Environment, AuthTokenBundle>;
  subscribers: Array<(env: Environment, s: AuthSession | null) => void>;
} {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const sessions = new Map<Environment, AuthSession>();
  const tokens = new Map<Environment, string>();
  const bundles = new Map<Environment, AuthTokenBundle>();
  const subscribers: Array<(env: Environment, s: AuthSession | null) => void> = [];
  return {
    calls,
    sessions,
    tokens,
    bundles,
    subscribers,
    signIn: async (env) => {
      calls.push({ method: 'signIn', args: [env] });
      const capturedAt = Date.parse('2026-05-04T00:00:00.000Z');
      const session: AuthSession = {
        environment: env,
        accountId: 'acct-1',
        capturedAt,
      };
      sessions.set(env, session);
      tokens.set(env, 'tok-1');
      bundles.set(env, { multToken: 'tok-1', accountToken: 'or-1', capturedAt });
      for (const cb of subscribers) cb(env, session);
      return session;
    },
    signOut: async (env) => {
      calls.push({ method: 'signOut', args: [env] });
      sessions.delete(env);
      tokens.delete(env);
      bundles.delete(env);
      for (const cb of subscribers) cb(env, null);
    },
    getSession: (env) => {
      calls.push({ method: 'getSession', args: [env] });
      return sessions.get(env) ?? null;
    },
    getToken: (env) => {
      calls.push({ method: 'getToken', args: [env] });
      return tokens.get(env) ?? null;
    },
    getTokenBundle: (env) => {
      calls.push({ method: 'getTokenBundle', args: [env] });
      return bundles.get(env) ?? null;
    },
    injectTokenIntoPartition: async (env, partition) => {
      calls.push({ method: 'injectTokenIntoPartition', args: [env, partition] });
      return bundles.has(env)
        ? { injected: true }
        : { injected: false, reason: 'no-token' };
    },
    hasValidSession: (env) => {
      calls.push({ method: 'hasValidSession', args: [env] });
      const s = sessions.get(env);
      if (s === undefined) return false;
      if (s.expiresAt !== undefined && s.expiresAt < Date.now()) return false;
      return true;
    },
    onSessionChanged: (cb) => {
      calls.push({ method: 'onSessionChanged', args: [] });
      subscribers.push(cb);
      return (): void => {
        const i = subscribers.indexOf(cb);
        if (i >= 0) subscribers.splice(i, 1);
      };
    },
    onTwoFactorNeedsSetup: () => {
      calls.push({ method: 'onTwoFactorNeedsSetup', args: [] });
      return (): void => undefined;
    },
    onEvent: () => {
      calls.push({ method: 'onEvent', args: [] });
      return (): void => {
        /* no-op */
      };
    },
  };
}

beforeEach(() => {
  _resetAuthApiForTesting();
});

describe('AuthApi (via stub) routes calls correctly', () => {
  it('signIn populates getSession + getToken + hasValidSession', async () => {
    const stub = makeStubApi();
    _setAuthApiForTesting(stub);
    const api = getAuthApi();

    expect(api.getSession('edison')).toBeNull();
    expect(api.hasValidSession('edison')).toBe(false);

    await api.signIn('edison');

    expect(api.getSession('edison')?.accountId).toBe('acct-1');
    expect(api.getToken('edison')).toBe('tok-1');
    expect(api.hasValidSession('edison')).toBe(true);
  });

  it('signOut clears the session', async () => {
    const stub = makeStubApi();
    _setAuthApiForTesting(stub);
    const api = getAuthApi();

    await api.signIn('edison');
    expect(api.getSession('edison')).not.toBeNull();

    await api.signOut('edison');
    expect(api.getSession('edison')).toBeNull();
    expect(api.getToken('edison')).toBeNull();
    expect(api.hasValidSession('edison')).toBe(false);
  });

  it('getTokenBundle returns null before sign-in, both tokens after, and null after sign-out', async () => {
    const stub = makeStubApi();
    _setAuthApiForTesting(stub);
    const api = getAuthApi();

    expect(api.getTokenBundle('edison')).toBeNull();

    await api.signIn('edison');
    const bundle = api.getTokenBundle('edison');
    expect(bundle).not.toBeNull();
    expect(bundle?.multToken).toBe('tok-1');
    expect(bundle?.accountToken).toBe('or-1');
    expect(typeof bundle?.capturedAt).toBe('number');

    await api.signOut('edison');
    expect(api.getTokenBundle('edison')).toBeNull();
  });

  it('onSessionChanged fires on signIn and signOut, returns unsubscribe', async () => {
    const stub = makeStubApi();
    _setAuthApiForTesting(stub);
    const api = getAuthApi();

    const events: Array<{ env: Environment; sessionPresent: boolean }> = [];
    const unsub = api.onSessionChanged((env, session) => {
      events.push({ env, sessionPresent: session !== null });
    });

    await api.signIn('edison');
    await api.signOut('edison');
    expect(events).toEqual([
      { env: 'edison', sessionPresent: true },
      { env: 'edison', sessionPresent: false },
    ]);

    unsub();
    await api.signIn('edison');
    expect(events.length).toBe(2); // unchanged after unsubscribe
  });

  it('hasValidSession returns false when session has expired', () => {
    const stub = makeStubApi();
    stub.sessions.set('edison', {
      environment: 'edison',
      accountId: 'a',
      capturedAt: Date.parse('2026-05-04T00:00:00.000Z'),
      expiresAt: Date.now() - 1000, // already expired
    });
    _setAuthApiForTesting(stub);
    expect(getAuthApi().hasValidSession('edison')).toBe(false);
  });
});

describe('AuthError', () => {
  it('AUTH_UNSUPPORTED_ENV signals which env was bad in context', () => {
    const err = new AuthError({
      code: AUTH_ERROR_CODES.UNSUPPORTED_ENV,
      message: 'Environment "future" is not supported',
      context: { env: 'future', supported: ['edison'] },
      remediation: 'v1 supports edison only.',
    });
    expect(err.code).toBe('AUTH_UNSUPPORTED_ENV');
    expect(err.context['env']).toBe('future');
  });

  it('AUTH_CANCELLED is the right code for user-closed-window paths', () => {
    const err = new AuthError({
      code: AUTH_ERROR_CODES.CANCELLED,
      message: 'auth window closed by user',
    });
    expect(err.code).toBe('AUTH_CANCELLED');
  });
});
