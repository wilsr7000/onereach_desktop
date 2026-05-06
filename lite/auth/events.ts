/**
 * Auth module event types -- per-module typed event surface.
 * Per ADR-032.
 */

import type { Environment } from './types.js';
import type { EventRecord, SerializedEventError } from '../logging/events.js';

/** Stable event name catalog. */
export const AUTH_EVENTS = {
  // signIn: span (3) + coalesced
  SIGN_IN_START: 'auth.signIn.start',
  SIGN_IN_FINISH: 'auth.signIn.finish',
  SIGN_IN_FAIL: 'auth.signIn.fail',
  SIGN_IN_COALESCED: 'auth.signIn.coalesced',
  // signOut: span (2; never .fail)
  SIGN_OUT_START: 'auth.signOut.start',
  SIGN_OUT_FINISH: 'auth.signOut.finish',
  // hydrate: span (3)
  HYDRATE_START: 'auth.hydrate.start',
  HYDRATE_FINISH: 'auth.hydrate.finish',
  HYDRATE_FAIL: 'auth.hydrate.fail',
  // inject-token: span (3) -- ADR-042
  INJECT_TOKEN_START: 'auth.inject-token.start',
  INJECT_TOKEN_FINISH: 'auth.inject-token.finish',
  INJECT_TOKEN_FAIL: 'auth.inject-token.fail',
  // sync ops
  SESSION_READ: 'auth.session.read',
  // Sign-in window lifecycle -- granular trace events so the event
  // stream tells the whole story of an auth attempt: which URL is
  // opened, every redirect/navigation the user goes through, the
  // moment each cookie is captured, and any page-load failures.
  WINDOW_OPENED: 'auth.window.opened',
  WINDOW_NAV_START: 'auth.window.nav-start',
  WINDOW_NAV_FINISH: 'auth.window.nav-finish',
  WINDOW_NAV_FAIL: 'auth.window.nav-fail',
  WINDOW_TITLE: 'auth.window.title',
  WINDOW_CLOSED: 'auth.window.closed',
  COOKIE_CAPTURED: 'auth.cookie.captured',
  COOKIE_PROBED: 'auth.cookie.probed',
  PERSIST_OK: 'auth.persist.ok',
  PERSIST_FAIL: 'auth.persist.fail',
  // SSO Skip auto-click -- ultimate-convenience flow per the
  // ADR-042 amendment. Fires when an IDW tab lands on a OneReach
  // auth interstitial with `sso=true&showSkip=true` and the auto-
  // clicker either hits the button (CLICKED), can't find it
  // (NOT_FOUND), or the JS fails (FAILED).
  SSO_SKIP_ATTEMPT: 'auth.sso-skip.attempt',
  SSO_SKIP_CLICKED: 'auth.sso-skip.clicked',
  SSO_SKIP_NOT_FOUND: 'auth.sso-skip.not-found',
  SSO_SKIP_FAILED: 'auth.sso-skip.failed',
  // OAuth popup lifecycle (Google / Microsoft / Apple / GitHub /
  // Auth0 / Okta / Slack / Zoom / OpenAI / Anthropic / X). Helper
  // lives in lite/auth/oauth-popup.ts; event names match the
  // `auth.oauth-popup.*` namespace.
  OAUTH_POPUP_ALLOWED: 'auth.oauth-popup.allowed',
  OAUTH_POPUP_DENIED: 'auth.oauth-popup.denied',
  OAUTH_POPUP_PARENT_ORIGIN_REACHED: 'auth.oauth-popup.parent-origin-reached',
  OAUTH_POPUP_AUTO_CLOSED: 'auth.oauth-popup.auto-closed',
  OAUTH_POPUP_CRASHED: 'auth.oauth-popup.crashed',
  // TOTP autofill + account-picker auto-select (lite/auth/totp-autofill.ts).
  // 2FA codes and TOTP secrets are NEVER logged -- only metadata
  // (which frame URL, success/failure, attempt counter).
  TOTP_DETECTED: 'auth.totp.detected',
  TOTP_FILLED: 'auth.totp.filled',
  TOTP_FILL_FAILED: 'auth.totp.fill-failed',
  TOTP_NO_SECRET: 'auth.totp.no-secret',
  ACCOUNT_PICKER_DETECTED: 'auth.account-picker.detected',
  ACCOUNT_PICKER_SELECTED: 'auth.account-picker.selected',
  // IPC entries (5)
  IPC_SIGN_IN: 'auth.ipc.sign-in',
  IPC_SIGN_OUT: 'auth.ipc.sign-out',
  IPC_GET_SESSION: 'auth.ipc.get-session',
  IPC_GET_TOKEN_BUNDLE: 'auth.ipc.get-token-bundle',
  IPC_HAS_VALID_SESSION: 'auth.ipc.has-valid-session',
} as const;

export type AuthEventName = (typeof AUTH_EVENTS)[keyof typeof AUTH_EVENTS];

interface AuthEventBase {
  id: string;
  timestamp: string;
  category: 'auth';
}

interface AuthSpanBase extends AuthEventBase {
  spanId: string;
}

// ─── signIn ───────────────────────────────────────────────────────────────

export interface AuthSignInStartEvent extends AuthSpanBase {
  name: typeof AUTH_EVENTS.SIGN_IN_START;
  level: 'info';
  data: { env: Environment };
}
export interface AuthSignInFinishEvent extends AuthSpanBase {
  name: typeof AUTH_EVENTS.SIGN_IN_FINISH;
  level: 'info';
  durationMs: number;
  data: { env: Environment; accountId: string };
}
export interface AuthSignInFailEvent extends AuthSpanBase {
  name: typeof AUTH_EVENTS.SIGN_IN_FAIL;
  level: 'error';
  durationMs: number;
  error: SerializedEventError;
}
export interface AuthSignInCoalescedEvent extends AuthEventBase {
  name: typeof AUTH_EVENTS.SIGN_IN_COALESCED;
  level: 'info';
  data: { env: Environment };
}

// ─── signOut ──────────────────────────────────────────────────────────────

export interface AuthSignOutStartEvent extends AuthSpanBase {
  name: typeof AUTH_EVENTS.SIGN_OUT_START;
  level: 'info';
  data: { env: Environment };
}
export interface AuthSignOutFinishEvent extends AuthSpanBase {
  name: typeof AUTH_EVENTS.SIGN_OUT_FINISH;
  level: 'info';
  durationMs: number;
  data: { env: Environment; hadSession: boolean };
}

// ─── hydrate ──────────────────────────────────────────────────────────────

export interface AuthHydrateStartEvent extends AuthSpanBase {
  name: typeof AUTH_EVENTS.HYDRATE_START;
  level: 'info';
}
export interface AuthHydrateFinishEvent extends AuthSpanBase {
  name: typeof AUTH_EVENTS.HYDRATE_FINISH;
  level: 'info';
  durationMs: number;
  data: { count: number };
}
export interface AuthHydrateFailEvent extends AuthSpanBase {
  name: typeof AUTH_EVENTS.HYDRATE_FAIL;
  level: 'error';
  durationMs: number;
  error: SerializedEventError;
}

// ─── inject-token (ADR-042) ───────────────────────────────────────────────

export interface AuthInjectTokenStartEvent extends AuthSpanBase {
  name: typeof AUTH_EVENTS.INJECT_TOKEN_START;
  level: 'info';
  data: { env: Environment; partitionPrefix: string };
}
export interface AuthInjectTokenFinishEvent extends AuthSpanBase {
  name: typeof AUTH_EVENTS.INJECT_TOKEN_FINISH;
  level: 'info';
  durationMs: number;
  data: { env?: Environment; injected: boolean; reason?: string; domains?: number };
}
export interface AuthInjectTokenFailEvent extends AuthSpanBase {
  name: typeof AUTH_EVENTS.INJECT_TOKEN_FAIL;
  level: 'error';
  durationMs: number;
  error: SerializedEventError;
}

// ─── window lifecycle (granular trace) ────────────────────────────────────

export interface AuthWindowOpenedEvent extends AuthEventBase {
  name: typeof AUTH_EVENTS.WINDOW_OPENED;
  level: 'info';
  data: { env: Environment; url: string; partition: string };
}
export interface AuthWindowNavStartEvent extends AuthEventBase {
  name: typeof AUTH_EVENTS.WINDOW_NAV_START;
  level: 'info';
  data: { env: Environment; url: string; isMainFrame: boolean };
}
export interface AuthWindowNavFinishEvent extends AuthEventBase {
  name: typeof AUTH_EVENTS.WINDOW_NAV_FINISH;
  level: 'info';
  data: { env: Environment; url: string; durationMs: number };
}
export interface AuthWindowNavFailEvent extends AuthEventBase {
  name: typeof AUTH_EVENTS.WINDOW_NAV_FAIL;
  level: 'warn';
  data: { env: Environment; url: string; errorCode: number; errorDescription: string };
}
export interface AuthWindowTitleEvent extends AuthEventBase {
  name: typeof AUTH_EVENTS.WINDOW_TITLE;
  level: 'info';
  data: { env: Environment; title: string };
}
export interface AuthWindowClosedEvent extends AuthEventBase {
  name: typeof AUTH_EVENTS.WINDOW_CLOSED;
  level: 'info';
  data: { env: Environment; lastUrl?: string };
}
export interface AuthCookieCapturedEvent extends AuthEventBase {
  name: typeof AUTH_EVENTS.COOKIE_CAPTURED;
  level: 'info';
  data: {
    env: Environment;
    /** 'mult' or 'or' -- which cookie was just captured. Value is NEVER logged. */
    cookieName: 'mult' | 'or';
    cookieDomain: string;
    valueLength: number;
    /** 'cookie-event' = changed listener, 'probe' = first-load probe. */
    via: 'cookie-event' | 'probe';
  };
}
export interface AuthCookieProbedEvent extends AuthEventBase {
  name: typeof AUTH_EVENTS.COOKIE_PROBED;
  level: 'info';
  data: {
    env: Environment;
    found: { mult: boolean; or: boolean };
  };
}
export interface AuthPersistOkEvent extends AuthEventBase {
  name: typeof AUTH_EVENTS.PERSIST_OK;
  level: 'info';
  data: { env: Environment; accountId: string; collection: string };
}
export interface AuthPersistFailEvent extends AuthEventBase {
  name: typeof AUTH_EVENTS.PERSIST_FAIL;
  level: 'error';
  data: { env: Environment; accountId: string; reason: string };
}

// ─── SSO Skip auto-click ──────────────────────────────────────────────────

export interface AuthSsoSkipAttemptEvent extends AuthEventBase {
  name: typeof AUTH_EVENTS.SSO_SKIP_ATTEMPT;
  level: 'info';
  data: { env: Environment; url: string };
}
export interface AuthSsoSkipClickedEvent extends AuthEventBase {
  name: typeof AUTH_EVENTS.SSO_SKIP_CLICKED;
  level: 'info';
  data: { env: Environment; by: 'selector' | 'text'; selector?: string; text?: string };
}
export interface AuthSsoSkipNotFoundEvent extends AuthEventBase {
  name: typeof AUTH_EVENTS.SSO_SKIP_NOT_FOUND;
  level: 'info';
  data: { env: Environment; reason: string };
}
export interface AuthSsoSkipFailedEvent extends AuthEventBase {
  name: typeof AUTH_EVENTS.SSO_SKIP_FAILED;
  level: 'warn';
  data: { env: Environment; error: string };
}

// ─── session.read ─────────────────────────────────────────────────────────

export interface AuthSessionReadEvent extends AuthEventBase {
  name: typeof AUTH_EVENTS.SESSION_READ;
  level: 'info';
  data: { env: Environment; hasSession: boolean };
}

// ─── OAuth popup lifecycle ────────────────────────────────────────────────

export interface AuthOauthPopupAllowedEvent extends AuthEventBase {
  name: typeof AUTH_EVENTS.OAUTH_POPUP_ALLOWED;
  level: 'info';
  data: {
    /** Origin (scheme + host) of the popup target. Path/query NOT logged. */
    origin: string;
    reason: 'extra-predicate' | 'oauth-allowlist';
    partition: string;
    source?: string;
  };
}
export interface AuthOauthPopupDeniedEvent extends AuthEventBase {
  name: typeof AUTH_EVENTS.OAUTH_POPUP_DENIED;
  level: 'info';
  data: {
    /** Origin only -- the URL is opened in the OS default browser. */
    origin: string;
    source?: string;
  };
}
export interface AuthOauthPopupParentOriginReachedEvent extends AuthEventBase {
  name: typeof AUTH_EVENTS.OAUTH_POPUP_PARENT_ORIGIN_REACHED;
  level: 'info';
  data: { origin: string; graceMs: number; source?: string };
}
export interface AuthOauthPopupAutoClosedEvent extends AuthEventBase {
  name: typeof AUTH_EVENTS.OAUTH_POPUP_AUTO_CLOSED;
  level: 'info';
  data: {
    /** Trigger description, e.g. 'parent-navigated-post-auth'. */
    reason: string;
    source?: string;
  };
}
export interface AuthOauthPopupCrashedEvent extends AuthEventBase {
  name: typeof AUTH_EVENTS.OAUTH_POPUP_CRASHED;
  level: 'warn';
  data: { source?: string };
}

// ─── TOTP autofill + account picker ───────────────────────────────────────

export interface AuthTotpDetectedEvent extends AuthEventBase {
  name: typeof AUTH_EVENTS.TOTP_DETECTED;
  level: 'info';
  data: {
    /** Frame origin where the 2FA input was detected (NOT the path/query). */
    frameOrigin: string;
    /** Number of fill attempts already made on this watcher. */
    attempts: number;
  };
}
export interface AuthTotpFilledEvent extends AuthEventBase {
  name: typeof AUTH_EVENTS.TOTP_FILLED;
  level: 'info';
  data: { frameOrigin: string; attempts: number };
}
export interface AuthTotpFillFailedEvent extends AuthEventBase {
  name: typeof AUTH_EVENTS.TOTP_FILL_FAILED;
  level: 'warn';
  data: {
    frameOrigin: string;
    /** 'fill-threw' | 'fill-failed' | 'submit-threw' | 'code-error' */
    stage: string;
    attempts: number;
    error?: string;
  };
}
export interface AuthTotpNoSecretEvent extends AuthEventBase {
  name: typeof AUTH_EVENTS.TOTP_NO_SECRET;
  level: 'info';
  data: { frameOrigin: string };
}
export interface AuthAccountPickerDetectedEvent extends AuthEventBase {
  name: typeof AUTH_EVENTS.ACCOUNT_PICKER_DETECTED;
  level: 'info';
  data: { frameOrigin: string; hasTargetAccountId: boolean };
}
export interface AuthAccountPickerSelectedEvent extends AuthEventBase {
  name: typeof AUTH_EVENTS.ACCOUNT_PICKER_SELECTED;
  level: 'info';
  data: {
    frameOrigin: string;
    success: boolean;
    /** 'auto-selected' | 'select-failed' | 'select-threw' | 'no-target' | 'no-script' */
    reason: string;
  };
}

// ─── IPC entries ──────────────────────────────────────────────────────────

export interface AuthIpcSignInEvent extends AuthEventBase {
  name: typeof AUTH_EVENTS.IPC_SIGN_IN;
  level: 'info';
}
export interface AuthIpcSignOutEvent extends AuthEventBase {
  name: typeof AUTH_EVENTS.IPC_SIGN_OUT;
  level: 'info';
}
export interface AuthIpcGetSessionEvent extends AuthEventBase {
  name: typeof AUTH_EVENTS.IPC_GET_SESSION;
  level: 'info';
}
export interface AuthIpcGetTokenBundleEvent extends AuthEventBase {
  name: typeof AUTH_EVENTS.IPC_GET_TOKEN_BUNDLE;
  level: 'info';
}
export interface AuthIpcHasValidSessionEvent extends AuthEventBase {
  name: typeof AUTH_EVENTS.IPC_HAS_VALID_SESSION;
  level: 'info';
}

/** Discriminated union of every event the auth module emits. */
export type AuthEvent =
  | AuthSignInStartEvent
  | AuthSignInFinishEvent
  | AuthSignInFailEvent
  | AuthSignInCoalescedEvent
  | AuthSignOutStartEvent
  | AuthSignOutFinishEvent
  | AuthHydrateStartEvent
  | AuthHydrateFinishEvent
  | AuthHydrateFailEvent
  | AuthInjectTokenStartEvent
  | AuthInjectTokenFinishEvent
  | AuthInjectTokenFailEvent
  | AuthWindowOpenedEvent
  | AuthWindowNavStartEvent
  | AuthWindowNavFinishEvent
  | AuthWindowNavFailEvent
  | AuthWindowTitleEvent
  | AuthWindowClosedEvent
  | AuthCookieCapturedEvent
  | AuthCookieProbedEvent
  | AuthPersistOkEvent
  | AuthPersistFailEvent
  | AuthSsoSkipAttemptEvent
  | AuthSsoSkipClickedEvent
  | AuthSsoSkipNotFoundEvent
  | AuthSsoSkipFailedEvent
  | AuthSessionReadEvent
  | AuthIpcSignInEvent
  | AuthIpcSignOutEvent
  | AuthIpcGetSessionEvent
  | AuthIpcGetTokenBundleEvent
  | AuthIpcHasValidSessionEvent
  | AuthOauthPopupAllowedEvent
  | AuthOauthPopupDeniedEvent
  | AuthOauthPopupParentOriginReachedEvent
  | AuthOauthPopupAutoClosedEvent
  | AuthOauthPopupCrashedEvent
  | AuthTotpDetectedEvent
  | AuthTotpFilledEvent
  | AuthTotpFillFailedEvent
  | AuthTotpNoSecretEvent
  | AuthAccountPickerDetectedEvent
  | AuthAccountPickerSelectedEvent;

export function isAuthEvent(ev: EventRecord): ev is EventRecord & AuthEvent {
  return Object.values(AUTH_EVENTS).includes(ev.name as AuthEventName);
}
