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

import { BrowserWindow, session as electronSession, type Cookie, type Session, type Event as ElectronEvent } from 'electron';
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

/**
 * Extract the OneReach `accountId` UUID from a URL's query string, or
 * null if the URL has no `?accountId=...` parameter (or it's
 * malformed). Used when generating per-account partition strings so
 * IDW tabs that share an account share their session.
 */
export function getOneReachAccountIdFromUrl(url: string): string | null {
  if (typeof url !== 'string' || url.length === 0) return null;
  const m = url.match(/[?&]accountId=([a-f0-9-]{36})/i);
  return m === null ? null : m[1] ?? null;
}

/**
 * Compute the canonical Electron partition string for a OneReach IDW
 * URL: `persist:idw-<env>-<accountId>`. Returns null when the URL is
 * NOT a OneReach IDW (third-party agents) or doesn't carry an
 * accountId (in which case the caller falls back to a per-tab
 * `persist:tab-<uuid>` partition).
 *
 * Per ADR-042 amendment ("ultimate convenience"): IDW tabs that share
 * an account use the same partition so signing in once persists
 * across all tabs and across app restarts. Multi-account works
 * naturally because different accounts produce different partitions.
 *
 * Format spec:
 *   - `persist:idw-<env>-<accountId>` -- env is one of edison /
 *     staging / dev / production; accountId is the lowercased UUID
 *     from the URL.
 *   - `null` for non-OneReach URLs or URLs without accountId.
 */
export function partitionForOneReachUrl(url: string): string | null {
  const env = getEnvironmentForUrl(url);
  if (env === null) return null;
  const accountId = getOneReachAccountIdFromUrl(url);
  if (accountId === null) return null;
  return `persist:idw-${env}-${accountId.toLowerCase()}`;
}

// ---------------------------------------------------------------------------
// Logger surface -- mirrors the bug-report module's pattern.
// ---------------------------------------------------------------------------

/**
 * Payload broadcast when the autofill watcher sees a OneReach 2FA
 * page but `getCurrentCode()` throws `TOTP_NO_SECRET` (i.e. nothing
 * is stored in the keychain). Renderer-side hints can use this to
 * show a contextual banner + "Open Settings -> Two-Factor" button.
 */
export interface TwoFactorNeedsSetupPayload {
  source: string;
  frameUrl: string;
  reason?: string;
  inputCount?: number;
  /** ISO timestamp of the broadcast for log correlation. */
  timestamp: string;
}

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
  create: (env, config, extras) => {
    // Glue the auth window to whichever window has focus right now
    // (typically the main tabbed window). Without `parent`, the auth
    // window can disappear behind Safari / VS Code / Slack on
    // multi-monitor setups, and first-time users don't realize the
    // sign-in flow is still running. `parent` doesn't make it modal;
    // it just keeps it from getting lost. Best-effort -- if no window
    // is focused (rare on app boot), createAuthWindow falls back to
    // an unparented window.
    let parent: BrowserWindow | null = null;
    try {
      parent = BrowserWindow.getFocusedWindow();
    } catch {
      parent = null;
    }
    return createAuthWindow(env, config, {
      ...(extras?.emitEvent !== undefined ? { emitEvent: extras.emitEvent } : {}),
      ...(parent !== null ? { parent } : {}),
    });
  },
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
  /**
   * Subscribers to 2FA-needs-setup events (the autofill watcher saw a
   * 2FA page but Lite has no TOTP secret in the keychain). The
   * renderer wires a banner + "Open Settings -> Two-Factor" button.
   */
  private readonly twoFactorNeedsSetupSubscribers = new Set<
    (payload: TwoFactorNeedsSetupPayload) => void
  >();
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

    // Remove EVERY OneReach-domain cookie from the partition. Just
    // removing `mult` + `or` from the two top-level suffix URLs is
    // not enough -- OneReach SSO also sets cookies on subdomains
    // like `auth.edison.onereach.ai`, and Electron's
    // `cookies.remove(url, name)` only matches the exact (url, name)
    // tuple. A surviving subdomain `or` cookie was the cause of
    // "sign out then relaunch shows signed in again": hydrate found
    // the leftover and reconstructed the session.
    //
    // Mirrors `collectAuthPartitionCookies` for completeness.
    if (config !== undefined) {
      try {
        const ses = this.sessionFromPartition(partition);
        const cookies = await this.collectAuthPartitionCookies(env);
        let removed = 0;
        for (const c of cookies) {
          // Build the URL Electron expects -- the cookie's actual
          // host (strip leading dot from domain) plus its path.
          const cookieDomain = typeof c.domain === 'string' ? c.domain : '';
          const host = cookieDomain.replace(/^\./, '');
          if (host.length === 0) continue;
          const cookiePath = typeof c.path === 'string' && c.path.length > 0 ? c.path : '/';
          const scheme = c.secure === true ? 'https' : 'http';
          const url = `${scheme}://${host}${cookiePath}`;
          try {
            await ses.cookies.remove(url, c.name);
            removed += 1;
          } catch {
            /* per-cookie best-effort -- continue */
          }
        }
        if (typeof ses.cookies.flushStore === 'function') {
          await ses.cookies.flushStore().catch(() => undefined);
        }
        this.log('info', 'auth: cleared partition cookies on signOut', {
          env,
          removed,
          totalCookies: cookies.length,
        });
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
   * Inject the captured OneReach session cookies into a target tab
   * partition's session, scoped to the env's UI + API cookie domains.
   * Per ADR-042, this is what makes the IDW agent recognize the user
   * on first tab open without showing the OneReach account picker.
   *
   * Strategy: clone EVERY cookie from the auth partition
   * (`persist:lite-auth-<env>`) whose domain matches one of the env's
   * cookie suffixes. The `mult` API bearer and `or` account/session
   * are the load-bearing pair, but OneReach also sets ancillary
   * cookies (CSRF tokens, session-id markers, etc.) that the SSO
   * interstitial checks before offering the Skip button. Cloning the
   * full set instead of cherry-picking mult+or means we don't have
   * to track which extra cookies OneReach uses today vs tomorrow.
   *
   * Per the user's amend (2026-05-05): we keep PER-TAB partition
   * isolation. Each tab has its own copy of the cookies; signing out
   * or invalidating in one tab doesn't affect siblings. The clone
   * happens once per tab on first attach. Multi-account is preserved
   * because tabs are independent.
   *
   * Returns `{ injected: false, reason: ... }` when no captured token
   * is available, or when the env config is unknown. Soft-fails on
   * cookie write errors.
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

      // Read every cookie from the auth partition that matches the env's
      // cookie domain suffixes. This catches mult + or + any ancillary
      // cookies (CSRF, session markers) the SSO interstitial checks.
      const sourceCookies = await this.collectAuthPartitionCookies(env);
      if (sourceCookies.length === 0) {
        span?.finish({ injected: false, reason: 'no-cookies' });
        return { injected: false, reason: 'no-cookies' };
      }

      // Refuse to clone if the load-bearing `mult` is missing or expired
      // -- without it we shouldn't pretend the partition is signed in.
      const mult = sourceCookies.find((c) => c.name === 'mult');
      if (mult === undefined) {
        span?.finish({ injected: false, reason: 'no-mult' });
        return { injected: false, reason: 'no-mult' };
      }
      if (
        typeof mult.expirationDate === 'number' &&
        mult.expirationDate * 1000 < Date.now()
      ) {
        this.log('warn', 'auth: refusing to clone cookies; mult is expired', {
          env,
          expiresAt: new Date(mult.expirationDate * 1000).toISOString(),
        });
        span?.finish({ injected: false, reason: 'expired' });
        return { injected: false, reason: 'expired' };
      }

      const ses = this.sessionFromPartition(partition);
      const successes: Array<{ name: string; domain: string }> = [];
      const failures: Array<{ name: string; domain: string; error: string }> = [];
      const skippedExpired: Array<{ name: string; domain: string }> = [];
      const now = Date.now() / 1000;
      for (const cookie of sourceCookies) {
        const cookieDomain = cookie.domain ?? '';
        // Drop individually-expired cookies (don't poison the new
        // partition with stale entries).
        if (
          typeof cookie.expirationDate === 'number' &&
          cookie.expirationDate < now
        ) {
          skippedExpired.push({ name: cookie.name, domain: cookieDomain });
          continue;
        }
        try {
          await ses.cookies.set(cookieSetDetailsFromSource(cookie));
          successes.push({ name: cookie.name, domain: cookieDomain });
        } catch (err) {
          failures.push({
            name: cookie.name,
            domain: cookieDomain,
            error: (err as Error).message,
          });
        }
      }
      // best-effort flush so the next loadURL sees the cookies
      try {
        if (typeof ses.cookies.flushStore === 'function') {
          await ses.cookies.flushStore();
        }
      } catch {
        /* best-effort */
      }
      const injected = successes.length > 0;
      if (injected) {
        this.log('info', 'auth: cloned session cookies into partition', {
          env,
          partitionPrefix: partition.slice(0, 16),
          totalSource: sourceCookies.length,
          successCount: successes.length,
          ...(failures.length > 0 ? { failureCount: failures.length } : {}),
          ...(skippedExpired.length > 0
            ? { skippedExpiredCount: skippedExpired.length }
            : {}),
        });
      } else if (failures.length > 0) {
        this.log('warn', 'auth: every cookie clone failed', {
          env,
          partitionPrefix: partition.slice(0, 16),
          failures: failures.length,
        });
      }
      // Include env + partitionPrefix + counts in the finish payload
      // so the event-bus translator (ADR-043) can project this into a
      // `token.injected` domain event without needing span correlation.
      span?.finish({
        injected,
        domains: successes.length, // legacy field name kept for translator
        cookies: successes.length,
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

  /**
   * Read every cookie from `persist:lite-auth-<env>` that matches one
   * of the env's cookie domain suffixes. Used by injection so the
   * full session state (mult + or + ancillary) clones to a tab
   * partition.
   */
  private async collectAuthPartitionCookies(env: Environment): Promise<Cookie[]> {
    const config = ENVIRONMENT_CONFIGS[env];
    if (config === undefined) return [];
    let ses: Session;
    try {
      ses = this.sessionFromPartition(`persist:lite-auth-${env}`);
    } catch {
      return [];
    }
    const collected: Cookie[] = [];
    const seen = new Set<string>();
    for (const suffix of config.cookieDomainSuffixes) {
      const host = suffix.replace(/^\./, '');
      try {
        const found = await ses.cookies.get({ domain: host });
        for (const c of found) {
          if (!cookieDomainMatchesEnv(c.domain, env)) continue;
          // Dedupe by name+domain+path -- a single cookie can show up
          // for multiple suffix queries.
          const key = `${c.name}|${c.domain}|${c.path}`;
          if (seen.has(key)) continue;
          seen.add(key);
          collected.push(c);
        }
      } catch {
        /* best-effort -- continue with what we have */
      }
    }
    return collected;
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
   * Subscribe to 2FA-needs-setup broadcasts. Fires when the autofill
   * watcher detects a 2FA prompt during sign-in and Lite has no
   * keychain secret to autofill from. Used by `lite/auth/main.ts` to
   * forward the event to all renderer windows so they can show a
   * contextual "open Settings -> Two-Factor" banner.
   */
  onTwoFactorNeedsSetup(cb: (payload: TwoFactorNeedsSetupPayload) => void): () => void {
    this.twoFactorNeedsSetupSubscribers.add(cb);
    return (): void => {
      this.twoFactorNeedsSetupSubscribers.delete(cb);
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
    //
    // SECURITY (per the 2026-05-05 multi-user leak fix): hydrate now
    // reads ONLY from this install's persistent partition cookie jar
    // (`persist:lite-auth-<env>`), which is local to this Mac/OS-user.
    // It NEVER reads `lite-auth-sessions` from the shared OneReach KV,
    // because that endpoint is anonymous and globally shared -- doing
    // so was loading every other user's session into this install and
    // making them appear signed-in as someone else.
    const span = this.spanEmitter?.('auth.hydrate');
    const rehydrated: Array<[Environment, AuthSession]> = [];
    try {
      let tokensRehydrated = 0;
      for (const env of SUPPORTED_ENVIRONMENTS) {
        const recovered = await this.recoverSessionFromAuthPartition(env);
        if (recovered === null) continue;
        tokensRehydrated += 1;
        const isNew = !this.sessions.has(env);
        this.sessions.set(env, recovered);
        if (isNew) rehydrated.push([env, recovered]);
      }
      this.log('info', 'auth: hydrated from partition cookies', {
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
   * Recover a full AuthSession + token bundle from this install's
   * `persist:lite-auth-<env>` partition cookies. Returns null when the
   * partition has no captured `mult` + `or` cookies (i.e. user has
   * never signed in on this install, or signed out).
   *
   * The `or` cookie carries `accountId` / `email` / `expiresAt`, so
   * the full AuthSession can be reconstructed from the local cookie
   * jar without ever consulting the shared KV namespace.
   *
   * Side-effect: also populates `this.tokens` and `this.tokenBundles`
   * for the env (mirrors `recoverTokenBundleFromAuthPartition`).
   */
  private async recoverSessionFromAuthPartition(env: Environment): Promise<AuthSession | null> {
    const config = ENVIRONMENT_CONFIGS[env];
    if (config === undefined) return null;
    const mult = await this.probeAuthPartitionCookie(env, 'mult');
    if (mult === null) return null;
    // Defense-in-depth: even if a stale `or` survives a botched
    // signOut, an expired `mult` should never re-activate a session.
    if (typeof mult.expirationDate === 'number' && mult.expirationDate * 1000 < Date.now()) {
      this.log('info', 'auth: hydrate skipping env -- mult cookie expired', {
        env,
        expiresAt: new Date(mult.expirationDate * 1000).toISOString(),
      });
      return null;
    }
    const or = await this.probeAuthPartitionCookie(env, 'or');
    if (or === null) return null;
    const decoded = decodeOrCookie(or.value);
    if (decoded === null) {
      this.log('warn', 'auth: hydrate or cookie decode failed; skipping env', { env });
      return null;
    }
    const accountId = decoded.accountId;
    if (typeof accountId !== 'string' || accountId.length === 0) {
      this.log('warn', 'auth: hydrate or cookie missing accountId; skipping env', { env });
      return null;
    }
    const session: AuthSession = {
      environment: env,
      accountId,
      capturedAt: Date.now(),
      ...(typeof decoded.email === 'string' ? { email: decoded.email } : {}),
      ...(typeof or.expirationDate === 'number'
        ? { expiresAt: Math.floor(or.expirationDate * 1000) }
        : {}),
    };
    this.tokens.set(env, mult.value);
    this.tokenBundles.set(env, {
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
    return session;
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
        onTwoFactorNeedsSetup: (payload) => {
          const broadcast: TwoFactorNeedsSetupPayload = {
            source: payload.source,
            frameUrl: payload.frameUrl,
            ...(payload.reason !== undefined ? { reason: payload.reason } : {}),
            ...(payload.inputCount !== undefined ? { inputCount: payload.inputCount } : {}),
            timestamp: new Date().toISOString(),
          };
          for (const cb of this.twoFactorNeedsSetupSubscribers) {
            try {
              cb(broadcast);
            } catch (cbErr) {
              this.log('warn', 'twoFactorNeedsSetup subscriber threw', {
                error: (cbErr as Error).message,
              });
            }
          }
        },
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

    // CRITICAL: install the new session + token + bundle in memory BEFORE
    // the KV write. `kv.set` reads the bearer token via
    // `getAuthApi().getToken(env)` and the accountId via
    // `getAuthApi().getSession(env)?.accountId` (see lite/kv/api.ts
    // defaultConfig). Both resolvers read directly from the maps below.
    // If we wrote to KV first, the SDK would authenticate with the
    // PREVIOUS sign-in's credentials (or null on first sign-in),
    // producing either "wrong keyId" / "Token was not accepted" (401)
    // from the OneReach KV service or the SDK's own "KV requires a
    // signed-in OneReach account" 401 -- both of which surface as
    // AUTH_KV_FAILED with the cryptic "Sign-in succeeded but the
    // session could not be saved" message.
    //
    // Ordering tradeoff: a KV failure now leaves the new credentials
    // in memory (so the user is effectively signed in for the rest of
    // the app run, including read paths). The catch block below still
    // rejects with AUTH_KV_FAILED so the placeholder UI shows the
    // banner, and a retry replays the same writes (idempotent in KV).
    // We do NOT roll back the maps because the captured cookies are
    // already in the Electron session partition; the in-memory maps
    // and the partition would otherwise drift.
    const previousSession = this.sessions.get(buffer.env);
    const previousToken = this.tokens.get(buffer.env);
    const previousBundle = this.tokenBundles.get(buffer.env);
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

    try {
      await this.kv.set(KV_COLLECTION, kvKeyFor(session), session);
      this.eventEmitter?.(AUTH_EVENTS.PERSIST_OK, {
        env: buffer.env,
        accountId,
        collection: KV_COLLECTION,
      });
    } catch (err) {
      const friendly = err instanceof KVError ? err.formatForUser() : (err as Error).message;
      // Detect the "the new token itself is bad" case explicitly --
      // when the OneReach KV service rejects the token we just
      // captured, leaving it in memory just guarantees more 401s on
      // every subsequent read. Fall back to the previous credentials
      // (or clear them, when there were none). Network / transient
      // failures keep the new credentials so an in-app retry can
      // replay the write without forcing a fresh sign-in.
      const status = err instanceof KVError ? err.status : undefined;
      const isAuthRejection =
        status === 401 ||
        status === 403 ||
        (typeof friendly === 'string' &&
          (friendly.toLowerCase().includes('wrong keyid') ||
            friendly.toLowerCase().includes('token was not accepted') ||
            friendly.toLowerCase().includes('invalid token') ||
            friendly.toLowerCase().includes('token expired')));
      if (isAuthRejection) {
        if (previousSession === undefined) this.sessions.delete(buffer.env);
        else this.sessions.set(buffer.env, previousSession);
        if (previousToken === undefined) this.tokens.delete(buffer.env);
        else this.tokens.set(buffer.env, previousToken);
        if (previousBundle === undefined) this.tokenBundles.delete(buffer.env);
        else this.tokenBundles.set(buffer.env, previousBundle);
      }
      this.log('error', 'auth: KV persist failed', {
        env: buffer.env,
        accountId,
        error: friendly,
        rolledBack: isAuthRejection,
        ...(err instanceof KVError ? { kvCode: err.code, kvStatus: status } : {}),
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
            ...(err instanceof KVError ? { kvCode: err.code, kvStatus: status } : {}),
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

    // Persist succeeded -- emit notifications + close window.
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

/**
 * Convert an Electron `Cookie` (read shape) to the `CookiesSetDetails`
 * shape that `cookies.set()` accepts. Preserves every meaningful
 * attribute so the cloned cookie behaves identically to the source on
 * the target partition.
 *
 * Notes:
 *   - `url` is required by `cookies.set`. We synthesize it from the
 *     cookie's domain (stripping a leading dot) and protocol (`https:`
 *     is mandatory when `secure: true`, which OneReach cookies are).
 *   - We deliberately omit `sameSite` when undefined so Electron
 *     defaults take over, but explicitly pass through when the source
 *     specified one.
 */
function cookieSetDetailsFromSource(c: Cookie): Electron.CookiesSetDetails {
  const host = (c.domain ?? '').replace(/^\./, '');
  const url = `https://${host}${c.path ?? '/'}`;
  const details: Electron.CookiesSetDetails = {
    url,
    name: c.name,
    value: c.value,
  };
  if (c.domain !== undefined) details.domain = c.domain;
  if (c.path !== undefined) details.path = c.path;
  if (c.secure !== undefined) details.secure = c.secure;
  if (c.httpOnly !== undefined) details.httpOnly = c.httpOnly;
  if (c.sameSite !== undefined) details.sameSite = c.sameSite;
  if (typeof c.expirationDate === 'number') details.expirationDate = c.expirationDate;
  return details;
}
