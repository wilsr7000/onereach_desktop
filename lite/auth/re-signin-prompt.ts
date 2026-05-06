/**
 * Re-sign-in prompter.
 *
 * Background: when the OneReach KV (or other authenticated) service
 * rejects the cached `mult` token as stale, every authenticated call
 * starts failing with the same opaque error. The kernel is the only
 * surface that knows enough to recover -- it can show a system dialog
 * and re-trigger the SSO popup -- so this module owns that flow.
 *
 * Shape: `installReSignInPrompter()` is called once at app boot. It
 * exposes `promptReSignIn(reason)`, which the KV (and any future
 * authenticated module) calls when it detects a stale-token rejection.
 *
 * UX guarantees:
 *  - **De-duped**: ten concurrent KV failures produce ONE dialog,
 *    not ten.
 *  - **Cool-down on dismiss**: if the user clicks "Not now", the next
 *    rejection within `DISMISS_COOLDOWN_MS` is silently ignored so
 *    they aren't badgered.
 *  - **Auto-clears on successful sign-in**: once `signIn()` resolves,
 *    the dedup gate resets so a future stale-token episode prompts
 *    again.
 *
 * No imports from `lite/kv/` -- consumers call `promptReSignIn` via
 * the prompter handle returned by `installReSignInPrompter`. This
 * keeps `auth -> kv -> auth` from re-introducing the cycle the KV
 * bindings indirection was designed to avoid.
 */

import { BrowserWindow, dialog, type MessageBoxOptions } from 'electron';
import { getAuthApi, AUTH_ERROR_CODES, AuthError } from './api.js';
import { getLoggingApi } from '../logging/api.js';
import type { Environment } from './api.js';

/**
 * After a user dismisses the prompt with "Not now", suppress further
 * prompts for this long (15 minutes). Long enough that they can keep
 * working without nagging; short enough that a real recovery attempt
 * later in the session will surface a fresh prompt.
 */
export const DISMISS_COOLDOWN_MS = 15 * 60 * 1000;

export interface InstallReSignInPrompterConfig {
  /** Environment to re-authenticate to. Lite is edison-only in v1. */
  env: Environment;
  /** Resolver for the dialog's parent window. May return null. */
  getParentWindow: () => BrowserWindow | null;
  /**
   * Optional hook for tests: the dialog system can't be exercised
   * headless. When provided, `showDialog` replaces the real
   * `dialog.showMessageBox` call.
   */
  showDialog?: (
    parent: BrowserWindow | null,
    options: MessageBoxOptions
  ) => Promise<{ response: number }>;
}

export interface ReSignInPrompterHandle {
  /**
   * Surface the re-sign-in prompt. Idempotent under concurrent
   * pressure: multiple calls while a prompt is open or the cool-down
   * is active are collapsed into a single dialog.
   *
   * Always returns. Errors during signIn are logged but do not bubble.
   */
  promptReSignIn(reason: string): void;
  /** True iff a dialog is currently open. For tests. */
  isPrompting(): boolean;
  /** True iff the cool-down is suppressing prompts. For tests. */
  isInCooldown(): boolean;
  /** Reset internal state. Useful for tests + after a manual signOut. */
  reset(): void;
}

let installed = false;
let handle: ReSignInPrompterHandle | null = null;

/**
 * Install the singleton prompter. Call exactly once at boot, after
 * `initAuth()` so `getAuthApi()` is wired. Returns the handle so the
 * caller can wire `promptReSignIn` into the KV bindings (or any other
 * authenticated transport).
 *
 * Idempotent: subsequent calls return the existing handle so wiring
 * code does not need to gate.
 */
export function installReSignInPrompter(
  config: InstallReSignInPrompterConfig
): ReSignInPrompterHandle {
  if (installed && handle !== null) return handle;

  let prompting = false;
  /** Timestamp (Date.now) when the cool-down expires, or 0 when not in cool-down. */
  let cooldownUntil = 0;

  const showDialog: (
    parent: BrowserWindow | null,
    options: MessageBoxOptions
  ) => Promise<{ response: number }> =
    config.showDialog ??
    ((parent, options) =>
      parent === null ? dialog.showMessageBox(options) : dialog.showMessageBox(parent, options));

  function isInCooldown(): boolean {
    return cooldownUntil > 0 && Date.now() < cooldownUntil;
  }

  /**
   * Surface a dialog telling the user the OAuth step succeeded but the
   * KV service rejected even the brand-new token. There's nothing the
   * client can do at this point: the OneReach KV service is rejecting
   * every token for this account / environment. The dialog points the
   * user at the support paths.
   */
  async function showServerSideErrorDialog(): Promise<void> {
    const parent = config.getParentWindow();
    const opts: MessageBoxOptions = {
      type: 'error',
      title: 'OneReach KV is rejecting your account',
      message: 'Sign-in worked, but OneReach storage rejected the new token',
      detail:
        'You signed in successfully, but the OneReach KV service rejected the ' +
        'fresh token (Token was not accepted: wrong keyId). Every saved ' +
        'setting, IDW, and tool needs that service.\n\n' +
        'This is a server-side issue: your account or environment is not ' +
        'configured to use this KV cluster. Contact OneReach support, ' +
        'or check that you signed in to the correct environment.',
      buttons: ['OK'],
      defaultId: 0,
    };
    await showDialog(parent, opts);
  }

  async function runPrompt(reason: string): Promise<void> {
    if (prompting || isInCooldown()) return;
    prompting = true;
    try {
      getLoggingApi().event('auth.re-signin.prompt-shown', { reason });
      const parent = config.getParentWindow();
      const opts: MessageBoxOptions = {
        type: 'warning',
        title: 'Sign in again',
        message: 'Your OneReach session expired',
        detail:
          'OneReach rejected your sign-in token. Sign in again to keep using ' +
          'your tools, agents, and saved settings.',
        buttons: ['Sign in', 'Not now'],
        defaultId: 0,
        cancelId: 1,
      };
      const { response } = await showDialog(parent, opts);
      if (response === 0) {
        getLoggingApi().event('auth.re-signin.accepted', { reason });
        try {
          await getAuthApi().signIn(config.env);
          getLoggingApi().event('auth.re-signin.completed');
          // Successful sign-in resets cool-down so a later stale-token
          // episode (e.g. the user keeps the app open across another
          // server-side rotation) surfaces a fresh prompt.
          cooldownUntil = 0;
        } catch (err) {
          getLoggingApi().warn('auth', 're-signin.signIn rejected', {
            error: (err as Error).message,
          });
          // Special case: `AUTH_KV_FAILED` means the OAuth step itself
          // succeeded -- the user actually re-authenticated -- but the
          // post-OAuth `lite-auth-sessions` write was rejected by the
          // KV server (typically with the same `wrong keyId` error
          // that triggered this prompt in the first place). Applying
          // the cool-down here would strand the user, since the
          // dialog is the only recovery surface and KV will keep
          // failing. Surface a different dialog so they understand
          // it's a server-side issue and don't keep re-clicking
          // "Sign in" in a loop.
          if (
            err instanceof AuthError &&
            err.code === AUTH_ERROR_CODES.KV_FAILED
          ) {
            getLoggingApi().event('auth.re-signin.kv-rejected-fresh-token', { reason });
            // Don't apply cool-down -- the user can dismiss the
            // explanation dialog and the next KV failure will not
            // re-prompt because we set `cooldownUntil` after we show
            // the explanation below.
            await showServerSideErrorDialog();
            cooldownUntil = Date.now() + DISMISS_COOLDOWN_MS;
          } else {
            // Generic SSO/network failure: cool-down so the user
            // isn't hammered with dialogs when the SSO endpoint is
            // upstream-broken.
            cooldownUntil = Date.now() + DISMISS_COOLDOWN_MS;
          }
        }
      } else {
        getLoggingApi().event('auth.re-signin.dismissed', { reason });
        cooldownUntil = Date.now() + DISMISS_COOLDOWN_MS;
      }
    } finally {
      prompting = false;
    }
  }

  handle = {
    promptReSignIn(reason: string): void {
      // Fire and forget -- the KV path that called us is on its own
      // error stack; we don't want to await the dialog from inside KV.
      void runPrompt(reason);
    },
    isPrompting(): boolean {
      return prompting;
    },
    isInCooldown,
    reset(): void {
      prompting = false;
      cooldownUntil = 0;
    },
  };
  installed = true;
  return handle;
}

/** Read the singleton handle, or null when `install...` has not run. For tests. */
export function _getReSignInPrompterForTesting(): ReSignInPrompterHandle | null {
  return handle;
}

/** Reset the singleton. For tests. */
export function _resetReSignInPrompterForTesting(): void {
  installed = false;
  handle = null;
}
