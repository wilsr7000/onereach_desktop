/**
 * Auth main-process orchestration.
 *
 * Owns:
 *   - IPC handlers for sign-in / sign-out / get-session / has-valid-session
 *   - Broadcast of `lite:auth:session-changed` events to all windows
 *   - Lazy hydration of the AuthStore from KV at first read
 *
 * Per ADR-026, `lite:auth:get-token` is intentionally NOT exposed --
 * the token stays main-process only. Renderers see `AuthSession`
 * metadata only.
 *
 * Renderer side lives in preload-lite.ts (`window.lite.auth`) and
 * placeholder.html (the Sign in button + signed-in state).
 */

import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { getAuthApi, AuthError } from './api.js';
import type { AuthSession, AuthTokenBundle, Environment, SignInOptions } from './types.js';
import { SUPPORTED_ENVIRONMENTS } from './types.js';
import { getLoggingApi } from '../logging/api.js';

// ---------------------------------------------------------------------------
// IPC channel names. All prefixed `lite:auth:` per Rule 3.
// ---------------------------------------------------------------------------

export const AUTH_IPC = {
  SIGN_IN: 'lite:auth:sign-in',
  SIGN_OUT: 'lite:auth:sign-out',
  GET_SESSION: 'lite:auth:get-session',
  GET_TOKEN_BUNDLE: 'lite:auth:get-token-bundle',
  HAS_VALID_SESSION: 'lite:auth:has-valid-session',
  SESSION_CHANGED: 'lite:auth:session-changed',
  /** Broadcast when a 2FA page is detected but Lite has no TOTP secret saved. */
  TWO_FACTOR_NEEDS_SETUP: 'lite:auth:2fa-needs-setup',
} as const;

// ---------------------------------------------------------------------------
// Init / teardown
// ---------------------------------------------------------------------------

export interface InitAuthOptions {
  /** Optional logger -- routed through lite logging by default in api.ts. */
  logger?: {
    info: (message: string, data?: unknown) => void;
    warn: (message: string, data?: unknown) => void;
    error: (message: string, data?: unknown) => void;
  };
}

export interface AuthHandle {
  /** Tear down IPC handlers and subscriptions. Idempotent. */
  teardown(): void;
}

let registered = false;
let unsubscribe: (() => void) | null = null;
let unsubscribeTwoFactorNeedsSetup: (() => void) | null = null;

/**
 * Register IPC handlers and start broadcasting session-changed events.
 * Safe to call multiple times -- idempotent (subsequent calls are no-ops).
 *
 * Hydration: kicked off in the background so the renderer can call
 * `getSession` immediately and get the rehydrated value. We don't
 * block boot on it.
 */
export function initAuth(opts: InitAuthOptions = {}): AuthHandle {
  const log = opts.logger ?? {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };

  if (registered) {
    return { teardown: teardownInternal };
  }

  const auth = getAuthApi();

  // Hydrate the in-memory state from KV in the background. Failures
  // are logged but don't block init.
  void (async (): Promise<void> => {
    try {
      // The store exposes hydrate() but not on the public AuthApi --
      // we go through a duck-typed cast since this is internal wiring.
      const maybeHydrate = (auth as unknown as { hydrate?: () => Promise<void> }).hydrate;
      if (typeof maybeHydrate === 'function') {
        await maybeHydrate.call(auth);
      }
    } catch (err) {
      log.warn('hydrate failed at init (continuing)', {
        error: (err as Error).message,
      });
    }
  })();

  // sign-in
  // ADR-030: each handler emits an `auth.ipc.<verb>` instant event on entry.
  ipcMain.handle(
    AUTH_IPC.SIGN_IN,
    async (_event: IpcMainInvokeEvent, payload: { env?: unknown; timeoutMs?: unknown }) => {
      getLoggingApi().event('auth.ipc.sign-in');
      const env = validateEnv(payload?.env);
      const opts: SignInOptions =
        typeof payload?.timeoutMs === 'number' ? { timeoutMs: payload.timeoutMs } : {};
      try {
        const session = await auth.signIn(env, opts);
        log.info('signIn ok', {
          env,
          accountId: session.accountId,
          hasEmail: session.email !== undefined,
        });
        return { session };
      } catch (err) {
        if (err instanceof AuthError) {
          log.warn('signIn rejected', { env, code: err.code, message: err.message });
          // Surface a JSON-serializable error so the renderer can
          // reconstruct the structure without losing the code. Note:
          // Electron prefixes the rejection's `.message` in the
          // renderer with "Error invoking remote method '<channel>':
          // Error: " before our JSON. The preload's `parseError`
          // strips that prefix by skipping to the first `{`.
          throw new Error(JSON.stringify({ __authError: err.toJSON() }));
        }
        log.error('signIn unexpected error', { env, error: (err as Error).message });
        throw err;
      }
    }
  );

  // sign-out
  ipcMain.handle(
    AUTH_IPC.SIGN_OUT,
    async (_event: IpcMainInvokeEvent, payload: { env?: unknown }) => {
      getLoggingApi().event('auth.ipc.sign-out');
      const env = validateEnv(payload?.env);
      await auth.signOut(env);
      log.info('signOut ok', { env });
      return { ok: true };
    }
  );

  // get-session
  // Awaits hydration before reading so a renderer that probes during
  // boot (e.g. placeholder.ts asking right after window load) sees the
  // KV-restored session, not the empty pre-hydration state. Without
  // this await the placeholder shows "Sign in" briefly even when the
  // user already has a captured session.
  ipcMain.handle(
    AUTH_IPC.GET_SESSION,
    async (_event: IpcMainInvokeEvent, payload: { env?: unknown }): Promise<{ session: AuthSession | null }> => {
      getLoggingApi().event('auth.ipc.get-session');
      const env = validateEnv(payload?.env);
      await ensureHydrated(auth, log);
      return { session: auth.getSession(env) };
    }
  );

  // has-valid-session
  // Same hydration-before-read contract as get-session: callers polling
  // "am I signed in?" during boot must see the rehydrated answer, not
  // the empty pre-hydration value.
  ipcMain.handle(
    AUTH_IPC.HAS_VALID_SESSION,
    async (_event: IpcMainInvokeEvent, payload: { env?: unknown }): Promise<{ valid: boolean }> => {
      getLoggingApi().event('auth.ipc.has-valid-session');
      const env = validateEnv(payload?.env);
      await ensureHydrated(auth, log);
      return { valid: auth.hasValidSession(env) };
    }
  );

  // get-token-bundle
  // Returns the in-memory token bundle ({mult, or}) captured by the
  // most recent signIn(env). Per the ADR-026 token-reveal amendment,
  // tokens are exposed to the renderer ONLY for the Settings -> Account
  // verification UI; nothing else in lite is expected to call this.
  // Tokens are not persisted to KV, so this returns null after a
  // restart until the user signs in again -- the boot-time hydrate
  // here is purely defensive symmetry with get-session.
  ipcMain.handle(
    AUTH_IPC.GET_TOKEN_BUNDLE,
    async (_event: IpcMainInvokeEvent, payload: { env?: unknown }): Promise<{ bundle: AuthTokenBundle | null }> => {
      getLoggingApi().event('auth.ipc.get-token-bundle');
      const env = validateEnv(payload?.env);
      await ensureHydrated(auth, log);
      return { bundle: auth.getTokenBundle(env) };
    }
  );

  // Subscribe to in-process session changes and broadcast them to all windows.
  unsubscribe = auth.onSessionChanged((env, session) => {
    const payload = { env, session };
    for (const win of BrowserWindow.getAllWindows()) {
      try {
        if (!win.isDestroyed()) {
          win.webContents.send(AUTH_IPC.SESSION_CHANGED, payload);
        }
      } catch (err) {
        log.warn('broadcast session-changed failed', {
          windowId: win.id,
          error: (err as Error).message,
        });
      }
    }
  });

  // Subscribe to 2FA-needs-setup notifications and broadcast them so
  // the renderer can show a contextual banner. Per-frame dedupe is
  // already handled inside the autofill watcher (`needsSetupNotified`
  // gates to one notification per watcher).
  unsubscribeTwoFactorNeedsSetup = auth.onTwoFactorNeedsSetup((payload) => {
    log.info('2fa-needs-setup broadcast', {
      source: payload.source,
      hasReason: payload.reason !== undefined,
    });
    for (const win of BrowserWindow.getAllWindows()) {
      try {
        if (!win.isDestroyed()) {
          win.webContents.send(AUTH_IPC.TWO_FACTOR_NEEDS_SETUP, payload);
        }
      } catch (err) {
        log.warn('broadcast 2fa-needs-setup failed', {
          windowId: win.id,
          error: (err as Error).message,
        });
      }
    }
  });

  registered = true;
  log.info('auth initialized', { supported: [...SUPPORTED_ENVIRONMENTS] });
  return { teardown: teardownInternal };
}

function teardownInternal(): void {
  if (!registered) return;
  try {
    ipcMain.removeHandler(AUTH_IPC.SIGN_IN);
    ipcMain.removeHandler(AUTH_IPC.SIGN_OUT);
    ipcMain.removeHandler(AUTH_IPC.GET_SESSION);
    ipcMain.removeHandler(AUTH_IPC.GET_TOKEN_BUNDLE);
    ipcMain.removeHandler(AUTH_IPC.HAS_VALID_SESSION);
  } catch {
    // best-effort
  }
  if (unsubscribe !== null) {
    try {
      unsubscribe();
    } catch {
      // best-effort
    }
    unsubscribe = null;
  }
  if (unsubscribeTwoFactorNeedsSetup !== null) {
    try {
      unsubscribeTwoFactorNeedsSetup();
    } catch {
      // best-effort
    }
    unsubscribeTwoFactorNeedsSetup = null;
  }
  registered = false;
}

/** @internal -- exposed for tests. */
export function _isAuthRegisteredForTesting(): boolean {
  return registered;
}

/** @internal -- exposed for tests so they can re-init cleanly. */
export function _resetAuthRegistrationForTesting(): void {
  teardownInternal();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validateEnv(value: unknown): Environment {
  if (typeof value !== 'string') {
    throw new Error('env must be a string');
  }
  // Cast through unknown -- the AuthStore validates against
  // SUPPORTED_ENVIRONMENTS itself and rejects with AUTH_UNSUPPORTED_ENV.
  return value as Environment;
}

/**
 * Best-effort hydration trigger. `hydrate` isn't on the public AuthApi
 * (per ADR-026 / api.ts comment), so we duck-type it. Concurrent calls
 * coalesce inside the store. Hydration errors are swallowed so the
 * read still returns whatever's in memory.
 */
async function ensureHydrated(
  auth: ReturnType<typeof getAuthApi>,
  log: NonNullable<InitAuthOptions['logger']>
): Promise<void> {
  const maybeHydrate = (auth as unknown as { hydrate?: () => Promise<void> }).hydrate;
  if (typeof maybeHydrate !== 'function') return;
  try {
    await maybeHydrate.call(auth);
  } catch (err) {
    log.warn('hydrate during read failed (continuing)', {
      error: (err as Error).message,
    });
  }
}
