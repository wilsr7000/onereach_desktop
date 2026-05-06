/**
 * Re-sign-in prompter tests.
 *
 * Covers the dedup + cool-down + signIn-trigger behavior. The native
 * Electron dialog is replaced via the `showDialog` test hook so we
 * can drive deterministic responses.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  installReSignInPrompter,
  _resetReSignInPrompterForTesting,
  DISMISS_COOLDOWN_MS,
} from '../../auth/re-signin-prompt.js';
import * as authApi from '../../auth/api.js';
import type { AuthApi } from '../../auth/api.js';
import { AuthError, AUTH_ERROR_CODES } from '../../auth/api.js';

function makeStubAuthApi(overrides: Partial<AuthApi> = {}): AuthApi {
  return {
    signIn: vi.fn().mockResolvedValue({
      environment: 'edison',
      accountId: 'acct-1',
      capturedAt: 0,
    }),
    signOut: vi.fn().mockResolvedValue(undefined),
    getSession: vi.fn().mockReturnValue(null),
    hasValidSession: vi.fn().mockReturnValue(false),
    getToken: vi.fn().mockReturnValue(null),
    getTokenBundle: vi.fn().mockReturnValue(null),
    onSessionChanged: vi.fn().mockReturnValue(() => undefined),
    onEvent: vi.fn().mockReturnValue(() => undefined),
    parseError: vi.fn().mockReturnValue(null),
    ...overrides,
  } as unknown as AuthApi;
}

describe('installReSignInPrompter', () => {
  beforeEach(() => {
    _resetReSignInPrompterForTesting();
    authApi._resetAuthApiForTesting();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-05T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    _resetReSignInPrompterForTesting();
    authApi._resetAuthApiForTesting();
  });

  it('returns a handle with promptReSignIn / isPrompting / isInCooldown / reset', () => {
    const handle = installReSignInPrompter({
      env: 'edison',
      getParentWindow: () => null,
      showDialog: () => Promise.resolve({ response: 1 }),
    });
    expect(typeof handle.promptReSignIn).toBe('function');
    expect(typeof handle.isPrompting).toBe('function');
    expect(typeof handle.isInCooldown).toBe('function');
    expect(typeof handle.reset).toBe('function');
    expect(handle.isPrompting()).toBe(false);
    expect(handle.isInCooldown()).toBe(false);
  });

  it('is idempotent: subsequent installs return the same handle', () => {
    const a = installReSignInPrompter({
      env: 'edison',
      getParentWindow: () => null,
      showDialog: () => Promise.resolve({ response: 1 }),
    });
    const b = installReSignInPrompter({
      env: 'edison',
      getParentWindow: () => null,
      showDialog: () => Promise.resolve({ response: 1 }),
    });
    expect(a).toBe(b);
  });

  it('shows a single dialog when promptReSignIn fires concurrently', async () => {
    const showDialog = vi.fn().mockResolvedValue({ response: 1 });
    const handle = installReSignInPrompter({
      env: 'edison',
      getParentWindow: () => null,
      showDialog,
    });
    handle.promptReSignIn('first');
    handle.promptReSignIn('second');
    handle.promptReSignIn('third');
    // Drain the microtask queue + the showDialog promise.
    await vi.runAllTimersAsync();
    expect(showDialog).toHaveBeenCalledTimes(1);
  });

  it('triggers signIn when the user clicks Sign in (response 0)', async () => {
    const stub = makeStubAuthApi();
    authApi._setAuthApiForTesting(stub);
    const showDialog = vi.fn().mockResolvedValue({ response: 0 });
    const handle = installReSignInPrompter({
      env: 'edison',
      getParentWindow: () => null,
      showDialog,
    });
    handle.promptReSignIn('stale-token');
    await vi.runAllTimersAsync();
    expect(stub.signIn).toHaveBeenCalledTimes(1);
    expect(stub.signIn).toHaveBeenCalledWith('edison');
  });

  it('does NOT call signIn on dismiss (response 1)', async () => {
    const stub = makeStubAuthApi();
    authApi._setAuthApiForTesting(stub);
    const handle = installReSignInPrompter({
      env: 'edison',
      getParentWindow: () => null,
      showDialog: () => Promise.resolve({ response: 1 }),
    });
    handle.promptReSignIn('stale-token');
    await vi.runAllTimersAsync();
    expect(stub.signIn).not.toHaveBeenCalled();
  });

  it('enters cool-down after dismiss; suppresses next prompt within window', async () => {
    const showDialog = vi.fn().mockResolvedValue({ response: 1 });
    const handle = installReSignInPrompter({
      env: 'edison',
      getParentWindow: () => null,
      showDialog,
    });
    handle.promptReSignIn('first');
    await vi.runAllTimersAsync();
    expect(handle.isInCooldown()).toBe(true);

    // Within cool-down: prompt is silently suppressed.
    handle.promptReSignIn('second');
    await vi.runAllTimersAsync();
    expect(showDialog).toHaveBeenCalledTimes(1);

    // After cool-down expires: next prompt re-surfaces the dialog.
    vi.setSystemTime(new Date(Date.now() + DISMISS_COOLDOWN_MS + 1));
    expect(handle.isInCooldown()).toBe(false);
    handle.promptReSignIn('third');
    await vi.runAllTimersAsync();
    expect(showDialog).toHaveBeenCalledTimes(2);
  });

  it('clears cool-down after a successful signIn', async () => {
    const stub = makeStubAuthApi();
    authApi._setAuthApiForTesting(stub);
    let firstResponse = 1; // dismiss to enter cool-down
    const showDialog = vi.fn().mockImplementation(() => {
      const response = firstResponse;
      firstResponse = 0; // next call: accept
      return Promise.resolve({ response });
    });
    const handle = installReSignInPrompter({
      env: 'edison',
      getParentWindow: () => null,
      showDialog,
    });
    handle.promptReSignIn('first');
    await vi.runAllTimersAsync();
    expect(handle.isInCooldown()).toBe(true);

    // Even though we're in cool-down, after the user later accepts and
    // signIn succeeds, the cool-down should reset. Skip past the
    // cool-down to force a second prompt to show, accept it, then
    // verify isInCooldown is false.
    vi.setSystemTime(new Date(Date.now() + DISMISS_COOLDOWN_MS + 1));
    handle.promptReSignIn('second');
    await vi.runAllTimersAsync();
    expect(stub.signIn).toHaveBeenCalledTimes(1);
    expect(handle.isInCooldown()).toBe(false);
  });

  it('applies cool-down even when signIn rejects (avoids dialog spam if SSO is broken)', async () => {
    const stub = makeStubAuthApi({
      signIn: vi.fn().mockRejectedValue(new Error('sso unavailable')),
    });
    authApi._setAuthApiForTesting(stub);
    const handle = installReSignInPrompter({
      env: 'edison',
      getParentWindow: () => null,
      showDialog: () => Promise.resolve({ response: 0 }),
    });
    handle.promptReSignIn('first');
    await vi.runAllTimersAsync();
    expect(stub.signIn).toHaveBeenCalledTimes(1);
    expect(handle.isInCooldown()).toBe(true);
  });

  it(
    'AUTH_KV_FAILED on signIn shows the server-side dialog (OAuth succeeded; KV rejects fresh token)',
    async () => {
      // This is the production failure mode my original tests missed.
      // signIn() doesn't just complete OAuth -- it also writes the new
      // session bundle to KV's `lite-auth-sessions`. If the KV server
      // is rejecting every token for the account (the user's actual
      // case), signIn() rejects with AUTH_KV_FAILED even though the
      // OAuth step succeeded. The prompter's old code applied
      // cool-down here, stranding the user; the new path surfaces a
      // dedicated dialog explaining it's a server-side issue.
      const kvFailedErr = new AuthError({
        code: AUTH_ERROR_CODES.KV_FAILED,
        message:
          'Sign-in succeeded but the session could not be saved: ' +
          'KV set HTTP 401: Token was not accepted: wrong keyId',
        context: { env: 'edison' },
        remediation: 'Sign out and back in to refresh the token.',
      });
      const stub = makeStubAuthApi({
        signIn: vi.fn().mockRejectedValue(kvFailedErr),
      });
      authApi._setAuthApiForTesting(stub);

      const dialogResponses = [
        { response: 0 }, // accept first prompt
        { response: 0 }, // dismiss the server-side explanation dialog
      ];
      let callIdx = 0;
      const showDialog = vi.fn().mockImplementation(() => {
        const r = dialogResponses[callIdx] ?? { response: 0 };
        callIdx += 1;
        return Promise.resolve(r);
      });
      const handle = installReSignInPrompter({
        env: 'edison',
        getParentWindow: () => null,
        showDialog,
      });
      handle.promptReSignIn('initial');
      await vi.runAllTimersAsync();

      expect(stub.signIn).toHaveBeenCalledTimes(1);
      // Two dialogs surfaced: the initial prompt AND the server-side explanation.
      expect(showDialog).toHaveBeenCalledTimes(2);
      // The second dialog is the server-side explanation -- recognizable
      // by the `type: 'error'` and the explanatory message.
      const secondDialogOpts = showDialog.mock.calls[1]?.[1] as {
        type?: string;
        message?: string;
      };
      expect(secondDialogOpts?.type).toBe('error');
      expect(secondDialogOpts?.message ?? '').toMatch(
        /OneReach storage rejected/i
      );
      // Cool-down still applies so the user isn't badgered if they
      // trigger another KV failure immediately.
      expect(handle.isInCooldown()).toBe(true);
    }
  );

  it('reset() clears prompting + cool-down state', async () => {
    const handle = installReSignInPrompter({
      env: 'edison',
      getParentWindow: () => null,
      showDialog: () => Promise.resolve({ response: 1 }),
    });
    handle.promptReSignIn('first');
    await vi.runAllTimersAsync();
    expect(handle.isInCooldown()).toBe(true);
    handle.reset();
    expect(handle.isInCooldown()).toBe(false);
    expect(handle.isPrompting()).toBe(false);
  });
});
