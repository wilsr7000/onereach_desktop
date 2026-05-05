/**
 * Auth module -- PUBLIC API.
 *
 * The only file other lite modules should import from in this module.
 * Per ADR-019 / Rule 11 in `lite/LITE-RULES.md`, cross-module imports
 * go through `<module>/api.ts` -- never reach into `store.ts`,
 * `window.ts`, `main.ts`, or any other internal file.
 *
 * Per ADR-026, v1 supports Edison only. The token captured by
 * `signIn()` is held main-process only -- `getToken()` is intentionally
 * NOT bridged to the renderer. Callers that need to make OneReach API
 * calls do so from main and inject the `Authorization` header themselves.
 *
 * Usage from another module (main process only):
 *
 *   import { getAuthApi } from '../auth/api.js';
 *   const auth = getAuthApi();
 *   await auth.signIn('edison');
 *   const token = auth.getToken('edison'); // raw mult cookie value
 *
 * Tests: `_setAuthApiForTesting(stub)` to inject a custom implementation,
 * `_resetAuthApiForTesting()` to clear the singleton.
 */

import { AuthStore } from './store.js';
import type { AuthStoreConfig } from './store.js';
import { getLoggingApi } from '../logging/api.js';

// Re-export the public types consumers need to typecheck calls.
export type {
  AuthSession,
  AuthTokenBundle,
  Environment,
  EnvironmentConfig,
  SignInOptions,
} from './types.js';
export { SUPPORTED_ENVIRONMENTS, ENVIRONMENT_CONFIGS } from './types.js';

// Re-export the structured error class + code catalog so consumers
// catch and branch via the public surface, never reaching into store.ts.
export type { AuthErrorCode, AuthErrorOptions } from './store.js';
export { AuthError, AUTH_ERROR_CODES } from './store.js';

// Domain helpers -- used by main-window's tab attach flow to decide
// whether a tab URL is a OneReach domain (and which env) before
// calling `injectTokenIntoPartition`. Re-exported here so consumers
// stay on the api.ts surface (Rule 11).
export {
  isOneReachDomain,
  extractEnvironment,
  cookieDomainMatchesEnv,
  getEnvironmentForUrl,
} from './store.js';

// Per-module typed event surface (ADR-032).
export {
  AUTH_EVENTS,
  isAuthEvent,
  type AuthEvent,
  type AuthEventName,
  type AuthSignInStartEvent,
  type AuthSignInFinishEvent,
  type AuthSignInFailEvent,
  type AuthSignInCoalescedEvent,
  type AuthSignOutStartEvent,
  type AuthSignOutFinishEvent,
  type AuthHydrateStartEvent,
  type AuthHydrateFinishEvent,
  type AuthHydrateFailEvent,
  type AuthSessionReadEvent,
  type AuthIpcSignInEvent,
  type AuthIpcSignOutEvent,
  type AuthIpcGetSessionEvent,
  type AuthIpcGetTokenBundleEvent,
  type AuthIpcHasValidSessionEvent,
} from './events.js';

// Generic base class -- consumers can also catch via `instanceof LiteError`
// if they want to handle errors uniformly across all lite modules.
export { LiteError, isLiteError } from '../errors.js';

import type { AuthSession, AuthTokenBundle, Environment, SignInOptions } from './types.js';

/**
 * The public surface of the auth module. All cross-module callers
 * route through this interface.
 *
 * **Error contract**: `signIn()` throws {@link AuthError} (extends
 * `LiteError`) on failure. Inspect `.code` to branch:
 * `AUTH_CANCELLED`, `AUTH_TIMEOUT`, `AUTH_KV_FAILED`,
 * `AUTH_UNSUPPORTED_ENV`, `AUTH_INVALID_COOKIE`. `signOut()` and the
 * read-only methods do not throw.
 *
 * **Token visibility**: `getToken()` is main-process only. The preload
 * bridge (`window.lite.auth`) deliberately omits this method; future
 * consumer modules read the token from main and inject it into outgoing
 * API requests themselves.
 *
 * See `lite/auth/README.md` for the full error catalog and recipe-style
 * usage examples.
 */
export interface AuthApi {
  /**
   * Open an Electron window pointing at GSX, capture the `mult` and
   * `or` cookies once the user signs in and selects their account,
   * persist the session to KV, close the window, and resolve.
   *
   * Concurrent calls for the same env coalesce on the first call's
   * promise. Concurrent calls for different envs are independent.
   *
   * @param env Which OneReach environment to sign into. v1 supports
   *   `edison` only -- other values reject with `AUTH_UNSUPPORTED_ENV`.
   * @param opts Optional per-call overrides (e.g. `timeoutMs`).
   * @returns The captured {@link AuthSession}.
   * @throws {AuthError} `AUTH_CANCELLED` if the user closed the window
   *   before both cookies were captured.
   * @throws {AuthError} `AUTH_TIMEOUT` if cookies didn't arrive within
   *   the timeout (default 5 minutes).
   * @throws {AuthError} `AUTH_KV_FAILED` if the cookies were captured
   *   but persistence to KV rejected. Window closes either way.
   * @throws {AuthError} `AUTH_INVALID_COOKIE` if the captured `or`
   *   cookie payload could not be decoded.
   * @throws {AuthError} `AUTH_UNSUPPORTED_ENV` for any env not in
   *   {@link SUPPORTED_ENVIRONMENTS}.
   *
   * @example
   * ```typescript
   * try {
   *   const session = await getAuthApi().signIn('edison');
   *   console.log('signed in as', session.email, 'account', session.accountId);
   * } catch (err) {
   *   if (err instanceof AuthError) {
   *     toast(err.formatForUser());
   *   }
   * }
   * ```
   */
  signIn(env: Environment, opts?: SignInOptions): Promise<AuthSession>;

  /**
   * Sign out of an environment. Removes the captured `mult` and `or`
   * cookies from the partition AND deletes the persisted KV record.
   * Without removing the cookies, the next `signIn()` would silently
   * re-use the cached session and never show a login form.
   *
   * Soft-fails: never throws. Cookie / KV cleanup failures are logged
   * but the in-memory session is always cleared.
   */
  signOut(env: Environment): Promise<void>;

  /**
   * Synchronously get the captured session for an env, or null if
   * none exists. Does NOT trigger a sign-in. Hydrates from KV lazily
   * via `hydrate()` -- callers that need cross-restart awareness
   * should `await` `hydrate()` first.
   */
  getSession(env: Environment): AuthSession | null;

  /**
   * Synchronously get the raw `mult` cookie value for an env, or null
   * if no session is captured. Use this in main-process code to
   * inject `Authorization: Bearer <token>` headers when calling
   * OneReach APIs.
   *
   * Note: as of the ADR-026 token-reveal amendment, `getTokenBundle`
   * exposes both `mult` and `or` values (and is bridged to the
   * renderer for the Settings -> Account verification UI). Main-process
   * code that just needs the bearer token should still call
   * `getToken(env)` -- it returns the same value as
   * `getTokenBundle(env)?.multToken` and is the cheaper API.
   *
   * @returns The raw cookie value (typically a JWT or opaque token),
   *   or null if there is no captured session for this env.
   */
  getToken(env: Environment): string | null;

  /**
   * Synchronously get the captured token bundle (`mult` + `or`) for an
   * env, or null if no token is available. Per ADR-042, the bundle is
   * rehydrated on boot from the persistent cookie jar of
   * `persist:lite-auth-<env>` -- so it survives restarts as long as
   * the user signed in at least once before the cookie expired. After
   * a hard sign-out (which clears the partition), this returns null
   * until a fresh sign-in completes.
   *
   * Surfaced for the Settings -> Account verification UI; returned
   * values are bridged to renderers so users can confirm capture and
   * copy individual cookie values for manual debugging.
   *
   * @returns The captured token bundle, or null when no token is
   *   available for this env.
   */
  getTokenBundle(env: Environment): AuthTokenBundle | null;

  /**
   * Inject the captured `mult` cookie into a target tab partition's
   * session, scoped to the env's UI + API cookie domains. Per ADR-042,
   * this is what makes IDW agents recognize the user on the first
   * tab open without showing the OneReach account picker.
   *
   * Soft-fail by design: returns `{ injected: false, reason: ... }`
   * when no token is available, the env is unsupported, the cookie has
   * expired, or the underlying cookies.set call rejected. Callers
   * (typically the main-window's tab attach flow) just log and proceed
   * to navigate -- the agent will fall back to its own sign-in
   * picker, which is the v1 baseline behaviour.
   *
   * Main-process callers only -- not bridged to the renderer.
   *
   * @param env Which OneReach environment's token to inject.
   * @param partition The destination tab partition string (e.g.
   *   `persist:tab-<uuid>`).
   * @returns Whether injection succeeded, plus a machine-readable
   *   reason on failure.
   */
  injectTokenIntoPartition(
    env: Environment,
    partition: string
  ): Promise<{ injected: boolean; reason?: string }>;

  /**
   * True if there is a captured session for the env AND its
   * `expiresAt` (if known) is in the future. Use this in callers that
   * need a quick "is the user signed in" check before triggering a
   * sign-in flow.
   */
  hasValidSession(env: Environment): boolean;

  /**
   * Subscribe to session changes. Fires whenever a sign-in completes
   * or a sign-out happens. Returns an unsubscribe function.
   *
   * The callback receives `(env, session)` where `session` is the new
   * session or `null` if the env was just signed out.
   */
  onSessionChanged(cb: (env: Environment, session: AuthSession | null) => void): () => void;

  /**
   * Subscribe to typed auth events (ADR-032). Branch on `ev.name` for
   * type-narrowed access to span data, IPC payloads, the
   * `auth.signIn.coalesced` event, and serialized errors.
   *
   * @example
   * ```typescript
   * import { getAuthApi, AUTH_EVENTS } from '../auth/api.js';
   * getAuthApi().onEvent((ev) => {
   *   if (ev.name === AUTH_EVENTS.SIGN_IN_FINISH) {
   *     metrics.timing('auth.signIn', ev.durationMs);
   *     metrics.tag({ accountId: ev.data.accountId });
   *   }
   * });
   * ```
   */
  onEvent(handler: (event: import('./events.js').AuthEvent) => void): () => void;
}

let _instance: AuthApi | null = null;

/**
 * Get the singleton auth API. Lazily instantiates on first call.
 *
 * Default backing implementation is `AuthStore` with a logger that
 * routes through the lite logging module (per ADR-025). To override
 * (e.g. for tests, or to pass a custom KV / session resolver), use
 * `_setAuthApiForTesting()` before this is first called, or call
 * `_resetAuthApiForTesting()` to clear and re-init.
 *
 * @returns The shared `AuthApi` instance.
 */
export function getAuthApi(): AuthApi {
  if (_instance === null) {
    _instance = new AuthStore(defaultConfig());
  }
  return _instance;
}

/** Reset the singleton (for tests). */
export function _resetAuthApiForTesting(): void {
  _instance = null;
}

/**
 * Override the singleton with a custom implementation (for tests). The
 * provided value is returned by subsequent `getAuthApi()` calls until
 * reset.
 */
export function _setAuthApiForTesting(api: AuthApi): void {
  _instance = api;
}

/**
 * Default store config -- routes the store's `logger` callback through
 * the lite logging module (per ADR-025), so every `[auth]` line shows
 * up in the unified log stream. Tests can override by passing their
 * own logger to `AuthStore` directly.
 */
function defaultConfig(): AuthStoreConfig {
  return {
    logger: (level, message, data) => {
      const log = getLoggingApi();
      log[level]('auth', message, data);
    },
    // ADR-030: spans on async ops (signIn/signOut/hydrate); instant
    // events on sync ops (getSession.read). Level forwards through to
    // the central log stream so window-nav-fail / persist-fail show
    // up at warn / error severity.
    spanEmitter: (name, data) => getLoggingApi().start(name, data),
    eventEmitter: (name, data, level) =>
      getLoggingApi().event(name, data, level ?? 'info'),
  };
}
