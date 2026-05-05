/**
 * Auth module -- shared types.
 *
 * Internal-but-re-exported types live here so both `api.ts` (public) and
 * `store.ts` / `window.ts` (internal) reference one source of truth.
 *
 * Per ADR-026, v1 supports Edison only. The `Environment` union lists
 * all four so call sites compile against the union; only `edison` is
 * present in `SUPPORTED_ENVIRONMENTS`. `signIn()` rejects with
 * `AUTH_UNSUPPORTED_ENV` for anything else until follow-up tickets land.
 */

/**
 * Every OneReach environment lite could eventually sign into. Listed so
 * call sites compile against the union from day one. Only environments
 * present in {@link SUPPORTED_ENVIRONMENTS} actually accept `signIn()`
 * in v1.
 */
export type Environment = 'edison' | 'staging' | 'dev' | 'production';

/**
 * Environments `signIn()` accepts in v1. Anything not listed here
 * causes `signIn()` to reject with `AUTH_UNSUPPORTED_ENV`.
 *
 * Adding an environment requires:
 *   1. Adding its `EnvironmentConfig` to {@link ENVIRONMENT_CONFIGS}.
 *   2. Adding it here.
 *   3. Updating the auth-multi-env chunk in `lite/PORTING.md`.
 */
export const SUPPORTED_ENVIRONMENTS: readonly Environment[] = ['edison'] as const;

/**
 * Per-environment configuration: the URL the auth window opens to, and
 * the cookie domain suffixes the listener filters on.
 *
 * The `mult` cookie is set on `.<env>.api.onereach.ai` (the API
 * subdomain), but `or` is set on `.<env>.onereach.ai`. The store's
 * cookie listener accepts both -- listing both suffixes here keeps the
 * filter narrow without missing either cookie.
 */
export interface EnvironmentConfig {
  /** URL the auth window opens to. OneReach redirects to `auth.*` from here. */
  readonly studioUrl: string;
  /** Cookie domain suffixes the listener filters on (with leading dot). */
  readonly cookieDomainSuffixes: readonly string[];
  /** Hostname prefix that identifies the auth page (used to detect "left auth"). */
  readonly authHostnamePrefix: string;
  /**
   * OneReach Service Discovery base URL. Used by `lite/discovery/` to
   * resolve serviceKey -> service URL via `@or-sdk/discovery`. The
   * resolved URLs feed every other authenticated SDK call (e.g.
   * `@or-sdk/key-value-storage`), so per-env routing is mandatory.
   *
   * Matches the URL `lib/edison-sdk-manager.js:36` uses for the full app.
   */
  readonly discoveryUrl: string;
}

/**
 * Per-env URL and cookie-domain config. Edison only in v1; entries for
 * other environments would land here as part of the auth-multi-env
 * chunk (see `lite/PORTING.md` deferred queue).
 */
export const ENVIRONMENT_CONFIGS: Readonly<Partial<Record<Environment, EnvironmentConfig>>> = {
  edison: {
    studioUrl: 'https://studio.edison.onereach.ai',
    cookieDomainSuffixes: ['.edison.onereach.ai', '.edison.api.onereach.ai'] as const,
    authHostnamePrefix: 'auth.',
    discoveryUrl: 'https://discovery.edison.api.onereach.ai',
  },
};

/**
 * The persisted shape of a successful sign-in. Saved to KV under
 * `lite-auth-sessions/${environment}:${accountId}`. The raw `mult`
 * token is NOT in this shape -- it stays main-process only in the
 * store's in-memory map. Renderers see `AuthSession` via IPC; main
 * code reads the token via `getAuthApi().getToken(env)`.
 */
export interface AuthSession {
  /** Which OneReach environment this session is for. */
  environment: Environment;
  /** The accountId the user picked in GSX (UUID). */
  accountId: string;
  /** User email, extracted from the decoded `or` cookie if available. */
  email?: string;
  /** Wall-clock time (ms epoch) the cookies were captured. */
  capturedAt: number;
  /** Cookie expiration (ms epoch), if known. From cookie.expirationDate * 1000. */
  expiresAt?: number;
}

/** Per-call options for {@link AuthApi.signIn}. */
export interface SignInOptions {
  /**
   * Override the default 5-minute timeout. The user might be slow at
   * typing 2FA; tests may want a much shorter timeout.
   */
  timeoutMs?: number;
}

/**
 * Raw token bundle for an environment -- both `mult` (the OneReach API
 * bearer cookie value) and `or` (the account/session cookie value)
 * captured during the most recent successful `signIn(env)` call.
 *
 * Held in memory only by `AuthStore.tokenBundles`. Surfaced via
 * `getTokenBundle(env)` so the Settings -> Account section can show
 * users that both cookies were captured. Token values are NEVER
 * persisted to KV and NEVER appear in log output (a unit test in
 * `auth-store.test.ts` enforces this).
 *
 * Per ADR-026, tokens are deliberately ephemeral across restarts:
 * after the app reopens, this bundle is null until the user signs
 * in again, even when the persisted `AuthSession` shape rehydrates
 * from KV.
 */
export interface AuthTokenBundle {
  /** Raw `mult` cookie value -- the OneReach API bearer. */
  multToken: string;
  /** Raw `or` cookie value -- URL-encoded account/session payload. */
  accountToken: string;
  /** Wall-clock time (ms epoch) the bundle was captured. */
  capturedAt: number;
  /** mult cookie expiration (ms epoch), if known. From `cookie.expirationDate * 1000`. */
  multExpiresAt?: number;
  /** or cookie expiration (ms epoch), if known. From `cookie.expirationDate * 1000`. */
  accountExpiresAt?: number;
}
