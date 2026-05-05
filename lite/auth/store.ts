/**
 * Auth store -- the engine.
 *
 * Per ADR-026: opens a `BrowserWindow` pointing at GSX, listens for the
 * `mult` and `or` cookies on the OneReach domain, persists the captured
 * session to `lite/kv/`, closes the window. The user does the auth
 * ceremony in the real OneReach UI; we just watch the cookie jar.
 *
 * Borrowed patterns (studied, never imported):
 *   - multi-tenant-store.js:387-469 -- session cookie listener shape
 *   - multi-tenant-store.js:81-87 -- safe OneReach domain validation
 *   - multi-tenant-store.js:573 -- env extraction from cookie domain
 *   - gsx-autologin.js:1063-1120 -- per-account session partition shape
 *
 * Other lite modules MUST NOT import this directly -- use
 * `getAuthApi()` from `./api.ts` instead (rule 11 in `lite/LITE-RULES.md`,
 * ADR-019 in `lite/DECISIONS.md`).
 *
 * @internal
 */

import { session as electronSession, type Cookie, type Session, type Event as ElectronEvent } from 'electron';
import { LiteError } from '../errors.js';
import type { LiteErrorOptions } from '../errors.js';
import { getKVApi, KVError } from '../kv/api.js';
import type { KVApi } from '../kv/api.js';
import { getLoggingApi } from '../logging/api.js';
import { AUTH_EVENTS, isAuthEvent, type AuthEvent } from './events.js';
import {
  ENVIRONMENT_CONFIGS,
  SUPPORTED_ENVIRONMENTS,
  type AuthSession,
  type AuthTokenBundle,
  type Environment,
  type EnvironmentConfig,
  type SignInOptions,
} from './types.js';
import {
  closeAuthWindow,
  createAuthWindow,
  onAuthWindowClosed,
  onAuthWindowFirstLoad,
  type AuthWindowHandle,
} from './window.js';
import { startTotpAutofill } from './totp-autofill.js';

/** KV collection where captured sessions persist. */
export const KV_COLLECTION = 'lite-auth-sessions';

/** Default timeout for `signIn()` -- 5 minutes. The user may be slow with 2FA. */
export const SIGN_IN_TIMEOUT_MS = 5 * 60_000;

/**
 * Stable error codes thrown by the auth module. See
 * `lite/auth/README.md` "Error catalog" for full descriptions.
 */
export const AUTH_ERROR_CODES = {
  /** User closed the auth window before both cookies were captured. */
  CANCELLED: 'AUTH_CANCELLED',
  /** Cookies didn't arrive within the timeout window. */
  TIMEOUT: 'AUTH_TIMEOUT',
  /** Cookies arrived but the KV write rejected. */
  KV_FAILED: 'AUTH_KV_FAILED',
  /** Caller passed an environment that v1 doesn't support. */
  UNSUPPORTED_ENV: 'AUTH_UNSUPPORTED_ENV',
  /** The `or` cookie value didn't decode as URL-encoded JSON. */
  INVALID_COOKIE: 'AUTH_INVALID_COOKIE',
} as const;

export type AuthErrorCode = (typeof AUTH_ERROR_CODES)[keyof typeof AUTH_ERROR_CODES];

export interface AuthErrorOptions extends Omit<LiteErrorOptions, 'code'> {
  code: AuthErrorCode;
}

/**
 * Structured error from the auth module. Always extends `LiteError`,
 * so consumers can catch via `instanceof LiteError` (generic) or
 * `instanceof AuthError` (module-specific).
 *
 * See `lite/auth/README.md` for the full error catalog.
 */
export class AuthError extends LiteError {
  constructor(options: AuthErrorOptions) {
    const baseOptions: LiteErrorOptions = {
      code: options.code,
      message: options.message,
      ...(options.context !== undefined ? { context: options.context } : {}),
      ...(options.remediation !== undefined ? { remediation: options.remediation } : {}),
      ...(options.cause !== undefined ? { cause: options.cause } : {}),
    };
    super(baseOptions);
    this.name = 'AuthError';
  }
}

// ---------------------------------------------------------------------------
// Domain validation -- TS-strict rewrite of the patterns from
// multi-tenant-store.js. NEVER imported from there.
// ---------------------------------------------------------------------------

/**
 * Strict OneReach domain check. Prevents subdomain attacks like
 * `api.onereach.ai.attacker.com`. Borrowed pattern from
 * `multi-tenant-store.js:81-87`.
 */
export function isOneReachDomain(domain: string | undefined | null): boolean {
  if (typeof domain !== 'string' || domain.length === 0) return false;
  const normalized = domain.toLowerCase().replace(/^\./, '');
  return normalized === 'onereach.ai' || normalized.endsWith('.onereach.ai');
}

/**
 * Extract the environment name from a OneReach cookie domain.
 * Borrowed regex shape from `multi-tenant-store.js:573`.
 */
export function extractEnvironment(domain: string): Environment | null {
  const match = domain.toLowerCase().match(/\.?(edison|staging|production|dev)\.(?:api\.)?onereach\.ai$/);
  if (match === null) return null;
  return match[1] as Environment;
}

/** Whether a cookie's domain matches one of an env's configured suffixes. */
export function cookieDomainMatchesEnv(domain: string | undefined | null, env: Environment): boolean {
  if (typeof domain !== 'string') return false;
  const config = ENVIRONMENT_CONFIGS[env];
  if (config === undefined) return false;
  const lower = domain.toLowerCase();
  return config.cookieDomainSuffixes.some((suffix) => lower === suffix || lower.endsWith(suffix));
}

/**
 * Determine which OneReach environment (if any) a tab URL belongs to.
 * Returns null for non-OneReach URLs (third-party agents) -- callers
 * use this to decide whether to inject auth tokens into the tab's
 * partition (per ADR-042). Uses the same `extractEnvironment` regex
 * as the cookie listener so the matchers stay in lockstep.
 */
export function getEnvironmentForUrl(url: string): Environment | null {
  if (typeof url !== 'string' || url.length === 0) return null;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (!isOneReachDomain(host)) return null;
  return extractEnvironment(host);
}

// ---------------------------------------------------------------------------
// Logger surface -- mirrors the bug-report module's pattern.
// ---------------------------------------------------------------------------

export interface AuthStoreConfig {
  /** Optional KV API override (for tests). */
  kvApi?: KVApi;
  /**
   * Optional session resolver -- returns the Electron session for a
   * partition string. Tests inject a fake; production uses
   * `electron.session.fromPartition`.
   */
  sessionFromPartition?: (partition: string) => Session;
  /**
   * Optional auth-window factory override -- tests inject a fake that
   * never opens a real BrowserWindow.
   */
  windowFactory?: AuthWindowFactory;
  /** Optional logger. Defaults to silent. */
  logger?: (level: 'info' | 'warn' | 'error', message: string, data?: unknown) => void;
  /**
   * Optional span emitter -- when provided, async ops (`signIn`,
   * `signOut`, `hydrate`) wrap their work in `auth.<op>.start` /
   * `.finish` / `.fail` spans. Sync ops (`getSession`,
   * `hasValidSession`) emit instant events instead. ADR-030.
   */
  spanEmitter?: (name: string, data?: unknown) => import('../logging/events.js').Span;
  /**
   * Optional event emitter for instant (non-span) events. Used by the
   * sync ops (`getSession`) to emit `auth.session.read` events, and
   * by the auth window factory to emit granular `auth.window.*`
   * lifecycle events. The optional `level` argument lets callers
   * promote nav-fail / persist-fail to `warn` / `error`.
   */
  eventEmitter?: (
    name: string,
    data?: unknown,
    level?: 'debug' | 'info' | 'warn' | 'error'
  ) => void;
}

/**
 * Pluggable factory for the auth window. The default implementation in
 * `window.ts` constructs a real `BrowserWindow`; tests inject a stub
 * that never touches Electron's window APIs.
 *
 * The optional `emitEvent` is the store's own event emitter, threaded
 * through so the window factory can emit `auth.window.*` lifecycle
 * events (opened / nav-start / nav-finish / nav-fail / title /
 * closed) per ADR-042 amendment.
 */
export interface AuthWindowFactory {
  create(
    env: Environment,
    config: EnvironmentConfig,
    extras?: {
      emitEvent?: (
        name: string,
        data: unknown,
        level?: 'debug' | 'info' | 'warn' | 'error'
      ) => void;
    }
  ): AuthWindowHandle;
}

const defaultWindowFactory: AuthWindowFactory = {
  create: (env, config, extras) =>
    createAuthWindow(env, config, {
      ...(extras?.emitEvent !== undefined ? { emitEvent: extras.emitEvent } : {}),
    }),
};

// ---------------------------------------------------------------------------
// Internal capture buffer per in-flight sign-in.
// ---------------------------------------------------------------------------

interface CaptureBuffer {
  env: Environment;
  partition: string;
  startedAt: number;
  multCookie: Cookie | null;
  orCookie: Cookie | null;
  resolve: (session: AuthSession) => void;
  reject: (err: AuthError) => void;
  timeoutHandle: NodeJS.Timeout;
  detachListener: () => void;
  detachTotpAutofill: () => void;
  windowHandle: AuthWindowHandle;
  settled: boolean;
}

// ---------------------------------------------------------------------------
// Public store class -- implements `AuthApi`.
// ---------------------------------------------------------------------------

/**
 * Auth store. Implements the AuthApi from `./api.ts`.
 *
 * @internal -- consumers go through `getAuthApi()`.
 */
export class AuthStore {
  private readonly kv: KVApi;
  private readonly sessionFromPartition: (partition: string) => Session;
  private readonly windowFactory: AuthWindowFactory;
  private readonly log: NonNullable<AuthStoreConfig['logger']>;
  private readonly spanEmitter: NonNullable<AuthStoreConfig['spanEmitter']> | null;
  private readonly eventEmitter: NonNullable<AuthStoreConfig['eventEmitter']> | null;

  /** Captured sessions per env. Hydrated from KV lazily on first read. */
  private readonly sessions = new Map<Environment, AuthSession>();
  /** Raw `mult` token per env. Never persisted; ephemeral across restarts. */
  private readonly tokens = new Map<Environment, string>();
  /**
   * Raw token bundles per env -- both `mult` (API bearer) and `or`
   * (account/session cookie) values + when they were captured. Held
   * in memory only; never written to KV. Surfaced via the
   * `getTokenBundle(env)` API for the Settings -> Account verification
   * UI. After a restart this map is empty until the user signs in
   * again, even when `sessions` is rehydrated from KV. ADR-026 amendment
   * 2026-05-04 (token reveal in Settings).
   */
  private readonly tokenBundles = new Map<Environment, AuthTokenBundle>();
  /** In-flight sign-in promises per env. Concurrent calls coalesce here. */
  private readonly inFlight = new Map<Environment, Promise<AuthSession>>();
  /** Subscribers to session-changed events. */
  private readonly subscribers = new Set<(env: Environment, s: AuthSession | null) => void>();
  /** Whether KV has been queried for previously-persisted sessions. */
  private hydrated = false;
  /**
   * In-flight hydrate Promise for coalescing concurrent calls. Without
   * this, a renderer's `get-session` IPC and `initAuth`'s background
   * hydrate can both call `kv.list` in parallel during boot.
   */
  private hydratePromise: Promise<void> | null = null;

  constructor(config: AuthStoreConfig = {}) {
    this.kv = config.kvApi ?? getKVApi();
    this.sessionFromPartition = config.sessionFromPartition ?? ((p) => electronSession.fromPartition(p));
    this.windowFactory = config.windowFactory ?? defaultWindowFactory;
    this.log =
      config.logger ??
      ((): void => {
        /* default: silent */
      });
    this.spanEmitter = config.spanEmitter ?? null;
    this.eventEmitter = config.eventEmitter ?? null;
  }

  /**
   * Open the auth window, capture cookies, persist to KV, resolve.
   *
   * Concurrent calls for the same env coalesce on the first call's
   * promise -- the SAME promise instance is returned to all callers,
   * so `p1 === p2`. Concurrent calls for different envs are independent.
   *
   * Note: this method is intentionally NOT `async`. An `async` declaration
   * would cause every return value (including the in-flight one) to be
   * wrapped in a fresh Promise, breaking the `p1 === p2` coalesce
   * contract.
   */
  signIn(env: Environment, opts: SignInOptions = {}): Promise<AuthSession> {
    if (!SUPPORTED_ENVIRONMENTS.includes(env)) {
      return Promise.reject(
        new AuthError({
          code: AUTH_ERROR_CODES.UNSUPPORTED_ENV,
          message: `Environment "${env}" is not supported in v1.`,
          context: { env, supported: [...SUPPORTED_ENVIRONMENTS] },
          remediation: 'v1 supports edison only. Other environments will be added in a follow-up port.',
        })
      );
    }
    const config = ENVIRONMENT_CONFIGS[env];
    if (config === undefined) {
      return Promise.reject(
        new AuthError({
          code: AUTH_ERROR_CODES.UNSUPPORTED_ENV,
          message: `Environment "${env}" has no configured studio URL.`,
          context: { env },
          remediation: 'Add an EnvironmentConfig entry to ENVIRONMENT_CONFIGS in lite/auth/types.ts.',
        })
      );
    }

    const existing = this.inFlight.get(env);
    if (existing !== undefined) {
      this.log('info', 'auth: signIn coalesced (in-flight call returned)', { env });
      // The original caller already has a span open. Emit a coalesce
      // event so the second caller is observable too -- it doesn't
      // get its own span (would double-count).
      this.eventEmitter?.('auth.signIn.coalesced', { env });
      return existing;
    }

    // ADR-030: span the signIn for the first (non-coalesced) caller.
    // The .start fires now; .finish/.fail attach via .then/.catch
    // below so they fire exactly once at promise settlement and do
    // NOT change the promise identity (coalesce contract).
    const span = this.spanEmitter?.('auth.signIn', { env });

    const timeoutMs = opts.timeoutMs ?? SIGN_IN_TIMEOUT_MS;
    const promise = this.runSignIn(env, config, timeoutMs);
    this.inFlight.set(env, promise);
    const cleanup = (): void => {
      this.inFlight.delete(env);
    };
    // Span attaches alongside cleanup; .then/.catch don't change
    // identity because we're not returning the chained promise.
    promise.then(
      (session) => {
        cleanup();
        span?.finish({ env, accountId: session.accountId });
      },
      (err) => {
        cleanup();
        span?.fail(err);
      }
    );
    return promise;
  }

  /**
   * Clear a session: remove cookies from the partition AND delete the
   * KV record. Without removing cookies, the next `signIn()` would
   * silently re-use the cached cookie and never show a login form.
   */
  async signOut(env: Environment): Promise<void> {
    // ADR-030: span the whole signOut. signOut never throws (best-effort
    // cleanup), so finish() always fires, fail() never does.
    const span = this.spanEmitter?.('auth.signOut', { env });
    const config = ENVIRONMENT_CONFIGS[env];
    const partition = `persist:lite-auth-${env}`;
    const session = this.sessions.get(env) ?? null;

    // Clear in-memory state first so callers see consistent answers
    // even if the cookie/KV cleanup fails.
    this.sessions.delete(env);
    this.tokens.delete(env);
    this.tokenBundles.delete(env);

    // Remove cookies from the partition. Best-effort: failure here
    // doesn't propagate -- the in-memory clear has already happened.
    if (config !== undefined) {
      try {
        const ses = this.sessionFromPartition(partition);
        for (const suffix of config.cookieDomainSuffixes) {
          // ses.cookies.remove takes a URL, not just a domain. Build
          // an https URL with the suffix as host (strip leading dot).
          const host = suffix.replace(/^\./, '');
          const url = `https://${host}/`;
          await ses.cookies.remove(url, 'mult').catch(() => undefined);
          await ses.cookies.remove(url, 'or').catch(() => undefined);
        }
      } catch (err) {
        this.log('warn', 'auth: cookie removal during signOut failed', {
          env,
          error: (err as Error).message,
        });
      }
    }

    // Remove from KV. Best-effort: log but don't throw.
    if (session !== null) {
      try {
        await this.kv.delete(KV_COLLECTION, kvKeyFor(session));
      } catch (err) {
        this.log('warn', 'auth: KV delete during signOut failed', {
          env,
          accountId: session.accountId,
          error: (err as Error).message,
        });
      }
    }

    this.log('info', 'auth: signed out', { env });
    this.notify(env, null);
    span?.finish({ env, hadSession: session !== null });
  }

  getSession(env: Environment): AuthSession | null {
    const session = this.sessions.get(env) ?? null;
    // Sync ops emit instant events, not spans (no duration to track).
    this.eventEmitter?.('auth.session.read', { env, hasSession: session !== null });
    return session;
  }

  getToken(env: Environment): string | null {
    return this.tokens.get(env) ?? null;
  }

  /**
   * Read the in-memory token bundle (`mult` API bearer + `or` account
   * cookie). On boot, `hydrate()` rehydrates this map from the
   * persistent cookie jar of `persist:lite-auth-<env>` (Electron
   * stores partition cookies on disk by default), so the bundle is
   * available across restarts as long as the user signed in at least
   * once before the cookies expired. Returns null when no token has
   * been captured for that env (or the cookie expired since last
   * hydrate).
   *
   * Per ADR-042, the tokens never cross the IPC boundary in raw form
   * (the renderer-bridge surface is `getTokenBundle` shape, but only
   * value-length is shown via the verification UI). Main-process code
   * (e.g. the multi-tab tab-injection path) reads the value directly
   * here.
   */
  getTokenBundle(env: Environment): AuthTokenBundle | null {
    return this.tokenBundles.get(env) ?? null;
  }

  /**
   * Inject the captured `mult` cookie into a target tab partition's
   * session, scoped to both the env's UI domain (e.g.
   * `.edison.onereach.ai`) and API domain (`.edison.api.onereach.ai`).
   * Mirrors the full app's `multi-tenant-store.js:659-856` injection
   * behaviour but stays inside lite. Per ADR-042, this is what makes
   * the IDW agent recognize the user on the first tab open without
   * showing the OneReach account picker.
   *
   * Returns `{ injected: false, reason: ... }` when no captured token
   * is available, or when the env config is unknown. Soft-fails on
   * cookie write errors and returns `{ injected: false, reason: 'cookie-write-failed' }`.
   */
  async injectTokenIntoPartition(
    env: Environment,
    partition: string
  ): Promise<{ injected: boolean; reason?: string }> {
    const span = this.spanEmitter?.('auth.inject-token', { env, partitionPrefix: partition.slice(0, 16) });
    try {
      const config = ENVIRONMENT_CONFIGS[env];
      if (config === undefined) {
        span?.finish({ injected: false, reason: 'unsupported-env' });
        return { injected: false, reason: 'unsupported-env' };
      }
      // Prefer the in-memory token bundle (freshest -- captured this session).
      // Fall back to the auth partition's persistent cookie jar (rehydrated
      // across restarts).
      let multValue = this.tokenBundles.get(env)?.multToken ?? null;
      let multExpirationDate: number | undefined;
      if (multValue === null) {
        const probed = await this.probeAuthPartitionCookie(env, 'mult');
        if (probed !== null) {
          multValue = probed.value;
          multExpirationDate = probed.expirationDate;
        }
      } else {
        // We may also have an expirationDate from the most-recent capture.
        const bundleExpiresAt = this.tokenBundles.get(env)?.multExpiresAt;
        if (typeof bundleExpiresAt === 'number') {
          multExpirationDate = bundleExpiresAt / 1000;
        }
      }
      if (multValue === null) {
        span?.finish({ injected: false, reason: 'no-token' });
        return { injected: false, reason: 'no-token' };
      }
      // Refuse to inject expired cookies.
      if (typeof multExpirationDate === 'number' && multExpirationDate * 1000 < Date.now()) {
        this.log('warn', 'auth: refusing to inject expired mult cookie', {
          env,
          expiresAt: new Date(multExpirationDate * 1000).toISOString(),
        });
        span?.finish({ injected: false, reason: 'expired' });
        return { injected: false, reason: 'expired' };
      }

      // ALSO load the `or` (account/session) cookie -- without it OneReach
      // has the bearer but no account/session context, so it routes the
      // user back through the login form even when `mult` is valid.
      // Same fall-through pattern: in-memory bundle -> auth-partition probe.
      let orValue = this.tokenBundles.get(env)?.accountToken ?? null;
      if (orValue !== null && orValue.length === 0) orValue = null;
      let orExpirationDate: number | undefined;
      if (orValue === null) {
        const probedOr = await this.probeAuthPartitionCookie(env, 'or');
        if (probedOr !== null) {
          orValue = probedOr.value;
          orExpirationDate = probedOr.expirationDate;
        }
      } else {
        const bundleOrExpiresAt = this.tokenBundles.get(env)?.accountExpiresAt;
        if (typeof bundleOrExpiresAt === 'number') {
          orExpirationDate = bundleOrExpiresAt / 1000;
        }
      }
      // Treat an expired `or` as missing rather than blocking the entire
      // injection -- the bearer alone is still useful for some pages.
      if (
        orValue !== null &&
        typeof orExpirationDate === 'number' &&
        orExpirationDate * 1000 < Date.now()
      ) {
        this.log('warn', 'auth: dropping expired or cookie from injection', {
          env,
          expiresAt: new Date(orExpirationDate * 1000).toISOString(),
        });
        orValue = null;
        orExpirationDate = undefined;
      }

      const ses = this.sessionFromPartition(partition);
      const successes: string[] = [];
      const failures: Array<{ domain: string; cookie: 'mult' | 'or'; error: string }> = [];
      const orInjections: string[] = [];
      for (const suffix of config.cookieDomainSuffixes) {
        const host = suffix.replace(/^\./, '');
        const url = `https://${host}/`;
        try {
          await ses.cookies.set({
            url,
            name: 'mult',
            value: multValue,
            domain: suffix,
            path: '/',
            secure: true,
            httpOnly: true,
            sameSite: 'no_restriction',
            ...(typeof multExpirationDate === 'number'
              ? { expirationDate: multExpirationDate }
              : {}),
          });
          successes.push(suffix);
        } catch (err) {
          failures.push({ domain: suffix, cookie: 'mult', error: (err as Error).message });
        }
        if (orValue !== null) {
          try {
            await ses.cookies.set({
              url,
              name: 'or',
              value: orValue,
              domain: suffix,
              path: '/',
              secure: true,
              // The `or` cookie is JS-readable in the OneReach SPA --
              // do NOT mark it httpOnly or the renderer can't read its
              // accountId. Same flags Electron captures with on the
              // auth window.
              httpOnly: false,
              sameSite: 'no_restriction',
              ...(typeof orExpirationDate === 'number'
                ? { expirationDate: orExpirationDate }
                : {}),
            });
            orInjections.push(suffix);
          } catch (err) {
            failures.push({ domain: suffix, cookie: 'or', error: (err as Error).message });
          }
        }
      }
      // best-effort flush so the next loadURL sees the cookie
      try {
        if (typeof ses.cookies.flushStore === 'function') {
          await ses.cookies.flushStore();
        }
      } catch {
        /* best-effort */
      }
      const injected = successes.length > 0;
      if (injected) {
        this.log('info', 'auth: injected session cookies into partition', {
          env,
          partitionPrefix: partition.slice(0, 16),
          multDomains: successes,
          orDomains: orInjections,
          orInjected: orInjections.length > 0,
          ...(failures.length > 0 ? { failures: failures.length } : {}),
        });
      } else if (failures.length > 0) {
        this.log('warn', 'auth: cookie write failed for every domain', {
          env,
          partitionPrefix: partition.slice(0, 16),
          failures: failures.length,
        });
      }
      // Include env + partitionPrefix in the finish payload so the
      // event-bus translator (ADR-043) can project this into a
      // `token.injected` domain event without needing span correlation.
      span?.finish({
        injected,
        domains: successes.length,
        orDomains: orInjections.length,
        env,
        partitionPrefix: partition.slice(0, 16),
      });
      return injected
        ? { injected: true }
        : { injected: false, reason: 'cookie-write-failed' };
    } catch (err) {
      span?.fail(err);
      this.log('warn', 'auth: injectTokenIntoPartition threw', {
        env,
        error: (err as Error).message,
      });
      return { injected: false, reason: 'unexpected-error' };
    }
  }

  hasValidSession(env: Environment): boolean {
    const s = this.sessions.get(env);
    if (s === undefined) return false;
    if (s.expiresAt !== undefined && s.expiresAt < Date.now()) return false;
    return true;
  }

  onSessionChanged(cb: (env: Environment, s: AuthSession | null) => void): () => void {
    this.subscribers.add(cb);
    return (): void => {
      this.subscribers.delete(cb);
    };
  }

  /**
   * Subscribe to typed auth events (ADR-032). Filters
   * `getLoggingApi().onEvent('auth.*', ...)` and casts each matching
   * record to `AuthEvent`. See lite/auth/events.ts.
   */
  onEvent(handler: (event: AuthEvent) => void): () => void {
    return getLoggingApi().onEvent('auth.*', (ev) => {
      if (isAuthEvent(ev)) {
        handler(ev as unknown as AuthEvent);
      }
    });
  }

  /**
   * Hydrate the in-memory session map from KV. Called eagerly at
   * `initAuth` time and again from the `get-session` / `has-valid-session`
   * IPC handlers so renderers always see the rehydrated value even if
   * their first probe lands before the boot-time hydrate finishes.
   *
   * Concurrent calls coalesce on a shared Promise -- two callers see
   * the same in-flight `kv.list` rather than racing two roundtrips.
   *
   * Notifies session-changed subscribers for every rehydrated session
   * so listeners that registered after the boot-time hydrate started
   * still receive the state transition (e.g. the placeholder window's
   * `onSessionChanged` listener attaches after init runs).
   *
   * Note: hydration loads the persisted `AuthSession` shape but NOT
   * the raw `mult` token (the token is never persisted). Rehydrated
   * sessions can be used for "is the user signed in" checks but not
   * for API calls until the user signs in again. This is a deliberate
   * security trade-off -- tokens stay ephemeral across restarts.
   */
  hydrate(): Promise<void> {
    if (this.hydrated) return Promise.resolve();
    if (this.hydratePromise !== null) return this.hydratePromise;
    this.hydratePromise = this.runHydrate().finally(() => {
      this.hydratePromise = null;
    });
    return this.hydratePromise;
  }

  private async runHydrate(): Promise<void> {
    // ADR-030: span the hydrate. Idempotent -- repeat calls return
    // early before this fires.
    const span = this.spanEmitter?.('auth.hydrate');
    const rehydrated: Array<[Environment, AuthSession]> = [];
    try {
      const records = await this.kv.list(KV_COLLECTION);
      for (const { key, value } of records) {
        const session = parseAuthSessionRecord(value);
        if (session === null) {
          this.log('warn', 'auth: hydrate skipped malformed record', { key });
          continue;
        }
        const isNew = !this.sessions.has(session.environment);
        this.sessions.set(session.environment, session);
        if (isNew) rehydrated.push([session.environment, session]);
      }
      // ADR-042: rehydrate the in-memory tokenBundles from the
      // persistent cookie jar of `persist:lite-auth-<env>`. Electron
      // stores cookies on disk by default for `persist:` partitions,
      // so as long as the user signed in at least once before the
      // cookie expired, we can recover the token without re-prompting
      // them. This is what fixes "tokens lost on restart".
      let tokensRehydrated = 0;
      for (const env of this.sessions.keys()) {
        const recovered = await this.recoverTokenBundleFromAuthPartition(env);
        if (recovered) tokensRehydrated += 1;
      }
      this.log('info', 'auth: hydrated from KV', {
        count: this.sessions.size,
        rehydrated: rehydrated.length,
        tokensRehydrated,
      });
      span?.finish({
        count: this.sessions.size,
        rehydrated: rehydrated.length,
        tokensRehydrated,
      });
    } catch (err) {
      span?.fail(err);
      this.log('warn', 'auth: hydrate failed (continuing with empty state)', {
        error: (err as Error).message,
      });
    } finally {
      this.hydrated = true;
    }
    // Broadcast outside the try/catch so a thrown subscriber doesn't
    // mask hydration completion. notify() already swallows subscriber
    // exceptions per-callback.
    for (const [env, session] of rehydrated) {
      this.notify(env, session);
    }
  }

  /**
   * Read the `mult` and `or` cookies from `persist:lite-auth-<env>`
   * and repopulate the in-memory `tokens` and `tokenBundles` for that
   * env. Soft-fail: returns false on any error or when neither cookie
   * is present. Mirrors `probeExistingCookies()` but operates outside
   * the sign-in window flow.
   */
  private async recoverTokenBundleFromAuthPartition(env: Environment): Promise<boolean> {
    try {
      const config = ENVIRONMENT_CONFIGS[env];
      if (config === undefined) return false;
      const mult = await this.probeAuthPartitionCookie(env, 'mult');
      if (mult === null) return false;
      const or = await this.probeAuthPartitionCookie(env, 'or');
      this.tokens.set(env, mult.value);
      this.tokenBundles.set(env, {
        multToken: mult.value,
        accountToken: or?.value ?? '',
        capturedAt: Date.now(),
        ...(typeof mult.expirationDate === 'number'
          ? { multExpiresAt: Math.floor(mult.expirationDate * 1000) }
          : {}),
        ...(or !== null && typeof or.expirationDate === 'number'
          ? { accountExpiresAt: Math.floor(or.expirationDate * 1000) }
          : {}),
      });
      return true;
    } catch (err) {
      this.log('warn', 'auth: token rehydration probe failed', {
        env,
        error: (err as Error).message,
      });
      return false;
    }
  }

  /**
   * Probe the `persist:lite-auth-<env>` partition for the freshest
   * cookie matching `name` ('mult' or 'or') across the env's
   * configured cookie domain suffixes. Returns null if no cookie
   * found (or session lookup throws).
   */
  private async probeAuthPartitionCookie(
    env: Environment,
    name: 'mult' | 'or'
  ): Promise<Cookie | null> {
    const config = ENVIRONMENT_CONFIGS[env];
    if (config === undefined) return null;
    let ses: Session;
    try {
      ses = this.sessionFromPartition(`persist:lite-auth-${env}`);
    } catch {
      return null;
    }
    const candidates: Cookie[] = [];
    for (const suffix of config.cookieDomainSuffixes) {
      const host = suffix.replace(/^\./, '');
      try {
        const found = await ses.cookies.get({ domain: host, name });
        for (const c of found) {
          if (cookieDomainMatchesEnv(c.domain, env)) candidates.push(c);
        }
      } catch {
        /* best-effort */
      }
    }
    return pickFreshest(candidates);
  }

  // -------------------------------------------------------------------------
  // Internal: the actual sign-in flow.
  // -------------------------------------------------------------------------

  private async runSignIn(env: Environment, config: EnvironmentConfig, timeoutMs: number): Promise<AuthSession> {
    const partition = `persist:lite-auth-${env}`;
    this.log('info', 'auth: sign-in starting', { env, partition, timeoutMs });

    return new Promise<AuthSession>((resolve, reject) => {
      // Step 1: Resolve the session for the partition. Listener
      // attaches BEFORE the window is constructed so we never miss a
      // Set-Cookie that fires during the initial redirect.
      const ses = this.sessionFromPartition(partition);

      const buffer: CaptureBuffer = {
        env,
        partition,
        startedAt: Date.now(),
        multCookie: null,
        orCookie: null,
        resolve,
        reject,
        timeoutHandle: setTimeout(() => {
          this.settleAsTimeout(buffer);
        }, timeoutMs),
        detachListener: () => undefined,
        detachTotpAutofill: () => undefined,
        // Placeholder until we create the window below; we need
        // `buffer` referenceable by the listener before the window
        // exists.
        windowHandle: { close: () => undefined } as AuthWindowHandle,
        settled: false,
      };

      const cookieListener = (
        _event: ElectronEvent,
        cookie: Cookie,
        _cause: string,
        removed: boolean
      ): void => {
        this.handleCookieChange(buffer, cookie, removed);
      };

      ses.cookies.on('changed', cookieListener);
      buffer.detachListener = (): void => {
        try {
          ses.cookies.off('changed', cookieListener);
        } catch {
          // best-effort
        }
      };

      // Step 2: Create the auth window pointed at the studio URL.
      let handle: AuthWindowHandle;
      try {
        handle = this.windowFactory.create(env, config, {
          ...(this.eventEmitter !== null ? { emitEvent: this.eventEmitter } : {}),
        });
      } catch (err) {
        buffer.detachListener();
        clearTimeout(buffer.timeoutHandle);
        reject(
          new AuthError({
            code: AUTH_ERROR_CODES.CANCELLED,
            message: 'Failed to open the GSX sign-in window.',
            context: { env, partition },
            cause: err,
            remediation: 'Try signing in again. If the problem persists, file a bug report.',
          })
        );
        return;
      }
      buffer.windowHandle = handle;
      buffer.detachTotpAutofill = startTotpAutofill(handle, {
        logger: (level, message, data) => this.log(level, message, data),
      });

      // Step 3: When the window closes (user clicked X), reject as cancelled.
      onAuthWindowClosed(handle, () => {
        if (buffer.settled) return;
        this.settleAsCancelled(buffer);
      });

      // Step 4: After the first did-finish-load, probe for already-set
      // cookies. Handles the "still signed in from last session" case
      // where Set-Cookie never fires because the cookie is already
      // present.
      onAuthWindowFirstLoad(handle, async () => {
        if (buffer.settled) return;
        await this.probeExistingCookies(buffer, handle);
      });
    });
  }

  /**
   * Cookie listener handler. Filters to mult/or on the env's domain
   * suffixes; once both arrive, persists and settles.
   */
  private handleCookieChange(buffer: CaptureBuffer, cookie: Cookie, removed: boolean): void {
    if (removed || buffer.settled) return;
    if (!isOneReachDomain(cookie.domain)) return;
    if (!cookieDomainMatchesEnv(cookie.domain, buffer.env)) return;
    if (cookie.name !== 'mult' && cookie.name !== 'or') return;

    if (cookie.name === 'mult') {
      buffer.multCookie = cookie;
      this.log('info', 'auth: mult cookie captured', cookieMetadata(cookie));
    } else {
      buffer.orCookie = cookie;
      this.log('info', 'auth: or cookie captured', cookieMetadata(cookie));
    }
    this.eventEmitter?.(AUTH_EVENTS.COOKIE_CAPTURED, {
      env: buffer.env,
      cookieName: cookie.name,
      cookieDomain: cookie.domain ?? '',
      valueLength: cookie.value.length,
      via: 'cookie-event',
    });

    if (buffer.multCookie !== null && buffer.orCookie !== null) {
      void this.persistAndResolve(buffer);
    }
  }

  /**
   * Probe `ses.cookies.get` for an existing valid mult+or pair after
   * the auth window's first load. Handles the "user is already signed
   * in" case where `cookies.on('changed')` doesn't fire because the
   * cookie was already present in the partition.
   *
   * Uses the same `sessionFromPartition` callback the listener
   * attached to, NOT `getAuthWindowSession` -- so tests that inject a
   * fake session see the same surface in both paths.
   */
  private async probeExistingCookies(buffer: CaptureBuffer, _handle: AuthWindowHandle): Promise<void> {
    let ses: Session;
    try {
      ses = this.sessionFromPartition(buffer.partition);
    } catch {
      return;
    }
    try {
      const config = ENVIRONMENT_CONFIGS[buffer.env];
      if (config === undefined) return;

      // Search across each domain suffix for both cookies.
      for (const suffix of config.cookieDomainSuffixes) {
        const host = suffix.replace(/^\./, '');
        const mults = await ses.cookies.get({ domain: host, name: 'mult' });
        const ors = await ses.cookies.get({ domain: host, name: 'or' });
        if (mults.length > 0 && buffer.multCookie === null) {
          const c = pickFreshest(mults);
          if (c !== null && cookieDomainMatchesEnv(c.domain, buffer.env)) {
            buffer.multCookie = c;
            this.log('info', 'auth: mult cookie found via probe', cookieMetadata(c));
          }
        }
        if (ors.length > 0 && buffer.orCookie === null) {
          const c = pickFreshest(ors);
          if (c !== null && cookieDomainMatchesEnv(c.domain, buffer.env)) {
            buffer.orCookie = c;
            this.log('info', 'auth: or cookie found via probe', cookieMetadata(c));
          }
        }
      }

      if (buffer.multCookie !== null && buffer.orCookie !== null) {
        await this.persistAndResolve(buffer);
      }
    } catch (err) {
      this.log('warn', 'auth: existing-cookie probe failed', {
        env: buffer.env,
        error: (err as Error).message,
      });
    }
  }

  /**
   * Both cookies present. Decode the `or` payload, persist to KV,
   * resolve. KV failure closes the window and rejects.
   */
  private async persistAndResolve(buffer: CaptureBuffer): Promise<void> {
    if (buffer.settled) return;
    buffer.settled = true;
    clearTimeout(buffer.timeoutHandle);
    buffer.detachListener();
    buffer.detachTotpAutofill();

    const mult = buffer.multCookie;
    const or = buffer.orCookie;
    if (mult === null || or === null) {
      // Defensive -- caller checks before invoking.
      return;
    }

    const decoded = decodeOrCookie(or.value);
    if (decoded === null) {
      this.log('warn', 'auth: or cookie decode failed', {
        env: buffer.env,
        valueLength: or.value.length,
      });
      closeAuthWindow(buffer.windowHandle);
      buffer.reject(
        new AuthError({
          code: AUTH_ERROR_CODES.INVALID_COOKIE,
          message: 'The OneReach session cookie could not be decoded.',
          context: { env: buffer.env, valueLength: or.value.length },
          remediation: 'Try signing in again. If the problem persists, file a bug report.',
        })
      );
      return;
    }

    const accountId = decoded.accountId ?? extractAccountIdFromUrl(buffer.windowHandle.lastUrl ?? '');
    if (accountId === null) {
      this.log('warn', 'auth: accountId not found in or cookie or URL', {
        env: buffer.env,
        decodedKeys: Object.keys(decoded),
      });
      closeAuthWindow(buffer.windowHandle);
      buffer.reject(
        new AuthError({
          code: AUTH_ERROR_CODES.INVALID_COOKIE,
          message: 'No accountId in the captured session.',
          context: { env: buffer.env, decodedKeys: Object.keys(decoded) },
          remediation: 'Make sure to pick an account in GSX before closing the window. Then try again.',
        })
      );
      return;
    }

    const session: AuthSession = {
      environment: buffer.env,
      accountId,
      ...(decoded.email !== undefined ? { email: decoded.email } : {}),
      capturedAt: Date.now(),
      ...(typeof mult.expirationDate === 'number'
        ? { expiresAt: Math.floor(mult.expirationDate * 1000) }
        : {}),
    };

    try {
      await this.kv.set(KV_COLLECTION, kvKeyFor(session), session);
      this.eventEmitter?.(AUTH_EVENTS.PERSIST_OK, {
        env: buffer.env,
        accountId,
        collection: KV_COLLECTION,
      });
    } catch (err) {
      const friendly = err instanceof KVError ? err.formatForUser() : (err as Error).message;
      this.log('error', 'auth: KV persist failed', {
        env: buffer.env,
        accountId,
        error: friendly,
        ...(err instanceof KVError ? { kvCode: err.code } : {}),
      });
      this.eventEmitter?.(
        AUTH_EVENTS.PERSIST_FAIL,
        { env: buffer.env, accountId, reason: friendly },
        'error'
      );
      closeAuthWindow(buffer.windowHandle);
      buffer.reject(
        new AuthError({
          code: AUTH_ERROR_CODES.KV_FAILED,
          message: `Sign-in succeeded but the session could not be saved: ${friendly}`,
          context: {
            env: buffer.env,
            accountId,
            collection: KV_COLLECTION,
            ...(err instanceof KVError ? { kvCode: err.code, kvStatus: err.status } : {}),
          },
          remediation:
            err instanceof KVError
              ? err.remediation
              : 'Check your network connection and try again.',
          cause: err,
        })
      );
      return;
    }

    // Persist succeeded -- update in-memory state, close window, resolve.
    this.sessions.set(buffer.env, session);
    this.tokens.set(buffer.env, mult.value);
    this.tokenBundles.set(buffer.env, {
      multToken: mult.value,
      accountToken: or.value,
      capturedAt: session.capturedAt,
      ...(typeof mult.expirationDate === 'number'
        ? { multExpiresAt: Math.floor(mult.expirationDate * 1000) }
        : {}),
      ...(typeof or.expirationDate === 'number'
        ? { accountExpiresAt: Math.floor(or.expirationDate * 1000) }
        : {}),
    });
    this.log('info', 'auth: session persisted', {
      env: buffer.env,
      accountId,
      collection: KV_COLLECTION,
      ...(session.email !== undefined ? { hasEmail: true } : { hasEmail: false }),
    });
    closeAuthWindow(buffer.windowHandle);
    buffer.resolve(session);
    this.notify(buffer.env, session);
  }

  private settleAsCancelled(buffer: CaptureBuffer): void {
    if (buffer.settled) return;
    buffer.settled = true;
    clearTimeout(buffer.timeoutHandle);
    buffer.detachListener();
    buffer.detachTotpAutofill();
    this.log('info', 'auth: sign-in cancelled by user', { env: buffer.env });
    buffer.reject(
      new AuthError({
        code: AUTH_ERROR_CODES.CANCELLED,
        message: 'Sign-in was cancelled before it completed.',
        context: { env: buffer.env },
        remediation: 'Click "Sign in to GSX" to try again.',
      })
    );
  }

  private settleAsTimeout(buffer: CaptureBuffer): void {
    if (buffer.settled) return;
    buffer.settled = true;
    buffer.detachListener();
    buffer.detachTotpAutofill();
    closeAuthWindow(buffer.windowHandle);
    this.log('warn', 'auth: sign-in timed out', {
      env: buffer.env,
      hadMult: buffer.multCookie !== null,
      hadOr: buffer.orCookie !== null,
      elapsedMs: Date.now() - buffer.startedAt,
    });
    buffer.reject(
      new AuthError({
        code: AUTH_ERROR_CODES.TIMEOUT,
        message: 'Sign-in timed out before both session cookies arrived.',
        context: {
          env: buffer.env,
          hadMult: buffer.multCookie !== null,
          hadOr: buffer.orCookie !== null,
        },
        remediation: 'Try signing in again. If the problem persists, file a bug report.',
      })
    );
  }

  private notify(env: Environment, session: AuthSession | null): void {
    for (const cb of this.subscribers) {
      try {
        cb(env, session);
      } catch (err) {
        this.log('warn', 'auth: subscriber threw', {
          env,
          error: (err as Error).message,
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function kvKeyFor(session: { environment: Environment; accountId: string }): string {
  return `${session.environment}:${session.accountId}`;
}

/**
 * Extract metadata (no value!) from a cookie for safe logging.
 *
 * The value is intentionally omitted -- token values must NEVER be
 * logged. The unit test in `auth-store.test.ts` captures all log
 * output and asserts no captured token substring appears.
 */
function cookieMetadata(cookie: Cookie): Record<string, unknown> {
  return {
    name: cookie.name,
    domain: cookie.domain,
    path: cookie.path,
    valueLength: cookie.value.length,
    httpOnly: cookie.httpOnly,
    secure: cookie.secure,
    sameSite: cookie.sameSite,
    expirationDate: cookie.expirationDate,
  };
}

interface OrCookiePayload {
  accountId?: string;
  email?: string;
  [key: string]: unknown;
}

/**
 * Decode the `or` cookie value: URL-decode then JSON.parse. The value
 * is URL-encoded JSON containing user session info (accountId, email,
 * etc.). Returns null if the decode fails -- caller surfaces an
 * `AUTH_INVALID_COOKIE` error.
 *
 * Borrowed shape from `multi-tenant-store.js:218-234` (`getOrTokenUserData`).
 */
export function decodeOrCookie(rawValue: string): OrCookiePayload | null {
  try {
    const decoded = decodeURIComponent(rawValue);
    const parsed = JSON.parse(decoded) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    return parsed as OrCookiePayload;
  } catch {
    return null;
  }
}

/**
 * Validate a value loaded from KV against the AuthSession shape.
 * Returns null if the value is malformed (defensive -- KV may hold
 * orphaned records from older schemas).
 */
function parseAuthSessionRecord(value: unknown): AuthSession | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Partial<AuthSession>;
  if (typeof v.environment !== 'string' || typeof v.accountId !== 'string') return null;
  if (!SUPPORTED_ENVIRONMENTS.includes(v.environment as Environment)) return null;
  if (typeof v.capturedAt !== 'number') return null;
  return {
    environment: v.environment as Environment,
    accountId: v.accountId,
    ...(typeof v.email === 'string' ? { email: v.email } : {}),
    capturedAt: v.capturedAt,
    ...(typeof v.expiresAt === 'number' ? { expiresAt: v.expiresAt } : {}),
  };
}

function extractAccountIdFromUrl(url: string): string | null {
  const m = url.match(/[?&]accountId=([a-f0-9-]{36})/i);
  return m === null ? null : m[1] ?? null;
}

/**
 * Pick the freshest cookie from a list (highest expirationDate, then
 * the last one). Used when probing existing cookies finds duplicates
 * across paths.
 */
function pickFreshest(cookies: Cookie[]): Cookie | null {
  if (cookies.length === 0) return null;
  const sorted = [...cookies].sort((a, b) => (b.expirationDate ?? 0) - (a.expirationDate ?? 0));
  return sorted[0] ?? null;
}
