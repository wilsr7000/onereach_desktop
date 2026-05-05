/**
 * Discovery store -- thin wrapper around `@or-sdk/discovery`.
 *
 * Wraps the SDK so other Lite modules:
 *   - get a uniform Lite-style API (no SDK imports outside this module)
 *   - never see the SDK's axios errors directly (we map to `LiteError`)
 *   - get an in-memory resolve cache so cold-start latency only hits once
 *
 * Per ADR-019 / Rule 11, this file is module-internal. Other lite
 * modules MUST consume `getDiscoveryApi()` from `./api.ts`.
 *
 * @internal
 */

import { LiteError } from '../errors.js';
import type { LiteErrorOptions } from '../errors.js';
import type { Span } from '../logging/events.js';
import { getLoggingApi } from '../logging/api.js';
import { DISCOVERY_EVENTS } from './events.js';
import type { DiscoveryService } from './types.js';

/**
 * Stable error codes thrown by the discovery module.
 * See `lite/discovery/README.md` "Error catalog" for full descriptions.
 */
export const DISCOVERY_ERROR_CODES = {
  /** Discovery returned a non-2xx (typically 401 = no token, 404 = unknown service). */
  HTTP: 'DISCOVERY_HTTP',
  /** Underlying network failure (DNS / TCP / TLS). */
  NETWORK: 'DISCOVERY_NETWORK',
  /** Discovery responded but the requested serviceKey isn't registered. */
  NOT_FOUND: 'DISCOVERY_NOT_FOUND',
  /** No token available -- caller is not signed in. */
  NOT_AUTHENTICATED: 'DISCOVERY_NOT_AUTHENTICATED',
} as const;

export type DiscoveryErrorCode =
  (typeof DISCOVERY_ERROR_CODES)[keyof typeof DISCOVERY_ERROR_CODES];

export interface DiscoveryErrorOptions extends Omit<LiteErrorOptions, 'code'> {
  code: DiscoveryErrorCode;
  /** HTTP status code, if the failure originated from a server response. */
  status?: number;
}

/**
 * Structured error from the discovery module. Always extends
 * `LiteError`, so consumers can catch via `instanceof LiteError`
 * (generic) or `instanceof DiscoveryError` (module-specific).
 */
export class DiscoveryError extends LiteError {
  public readonly status: number | undefined;

  constructor(options: DiscoveryErrorOptions) {
    const context: Record<string, unknown> = { ...(options.context ?? {}) };
    if (options.status !== undefined) context['status'] = options.status;
    const baseOptions: LiteErrorOptions = {
      code: options.code,
      message: options.message,
      context,
      ...(options.remediation !== undefined ? { remediation: options.remediation } : {}),
      ...(options.cause !== undefined ? { cause: options.cause } : {}),
    };
    super(baseOptions);
    this.name = 'DiscoveryError';
    this.status = options.status;
  }
}

/**
 * Structural interface for the subset of `@or-sdk/discovery`'s
 * `Discovery` we actually call. Lets test fakes satisfy `sdkCtor`
 * without implementing all 40+ methods of the real SDK class.
 */
export interface DiscoverySdkLike {
  getServiceUrl(serviceKey: string): Promise<string>;
  listServices(): Promise<{
    items: Array<{ serviceKey: string; type: string; version: string; url?: string }>;
  }>;
}

export interface StoreConfig {
  /** Token getter -- returns the user's mult cookie value, or empty string. */
  token: () => string;
  /** Discovery service base URL (env-specific). */
  discoveryUrl: string;
  /** Optional SDK constructor override (for tests). */
  sdkCtor?: new (params: { token: () => string; discoveryUrl: string }) => DiscoverySdkLike;
  /** Optional logger -- defaults to silent. */
  logger?: (level: 'info' | 'warn' | 'error', message: string, data?: unknown) => void;
  /** Optional span emitter -- when provided, every async op wraps in a span (ADR-030). */
  spanEmitter?: (name: string, data?: unknown) => Span;
  /**
   * Optional cache TTL in milliseconds. After TTL, the next resolve()
   * for that serviceKey re-queries discovery. Default: 5 minutes.
   * Set to 0 to disable caching (useful for tests).
   */
  cacheTtlMs?: number;
}

const DEFAULT_CACHE_TTL_MS = 5 * 60_000;

interface CacheEntry {
  url: string;
  expiresAt: number;
}

/**
 * Module-internal class. Other lite modules MUST NOT import this
 * directly -- use `getDiscoveryApi()` from `./api.ts` instead.
 *
 * @internal
 */
export class DiscoveryStore {
  private readonly token: () => string;
  private readonly discoveryUrl: string;
  private readonly log: NonNullable<StoreConfig['logger']>;
  private readonly spanEmitter: NonNullable<StoreConfig['spanEmitter']> | null;
  private readonly cacheTtlMs: number;
  private sdk: DiscoverySdkLike | null = null;
  private readonly sdkCtor: NonNullable<StoreConfig['sdkCtor']> | null;
  private readonly resolveCache = new Map<string, CacheEntry>();

  constructor(config: StoreConfig) {
    this.token = config.token;
    this.discoveryUrl = config.discoveryUrl;
    this.log =
      config.logger ??
      ((): void => {
        /* default: silent */
      });
    this.spanEmitter = config.spanEmitter ?? null;
    this.cacheTtlMs = config.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.sdkCtor = config.sdkCtor ?? null;
  }

  /**
   * Resolve a serviceKey to a base URL. Cached per serviceKey for
   * `cacheTtlMs` so cold-start cost is paid once per service.
   *
   * @throws {DiscoveryError} `DISCOVERY_NOT_AUTHENTICATED` if no token
   * @throws {DiscoveryError} `DISCOVERY_NOT_FOUND` if the serviceKey is unknown
   * @throws {DiscoveryError} `DISCOVERY_HTTP` | `DISCOVERY_NETWORK` on transport failure
   */
  async resolve(serviceKey: string): Promise<string> {
    if (typeof serviceKey !== 'string' || serviceKey.length === 0) {
      throw new DiscoveryError({
        code: DISCOVERY_ERROR_CODES.NOT_FOUND,
        message: 'serviceKey must be a non-empty string',
        context: { serviceKey: String(serviceKey) },
      });
    }

    // Cache hit?
    const cached = this.resolveCache.get(serviceKey);
    if (cached !== undefined && cached.expiresAt > Date.now()) {
      getLoggingApi().event(DISCOVERY_EVENTS.CACHE_HIT, { serviceKey });
      return cached.url;
    }

    const span = this.spanEmitter?.(DISCOVERY_EVENTS.RESOLVE_START.replace(/\.start$/, ''), {
      serviceKey,
    });
    try {
      this.assertAuthenticated();
      const sdk = this.getSdk();
      const url = await sdk.getServiceUrl(serviceKey);
      if (typeof url !== 'string' || url.length === 0) {
        throw new DiscoveryError({
          code: DISCOVERY_ERROR_CODES.NOT_FOUND,
          message: `Discovery returned no URL for serviceKey '${serviceKey}'`,
          context: { serviceKey },
          remediation: 'Confirm the serviceKey is registered for this account.',
        });
      }
      this.resolveCache.set(serviceKey, {
        url,
        expiresAt: Date.now() + this.cacheTtlMs,
      });
      this.log('info', 'discovery: resolved serviceKey', { serviceKey, url });
      span?.finish({ serviceKey, cached: false });
      return url;
    } catch (err) {
      const wrapped = this.normalizeError(err, serviceKey);
      span?.fail(wrapped);
      throw wrapped;
    }
  }

  /**
   * List every service registered for the active account. Used by the
   * Settings -> Diagnostics surface; rarely called by feature modules.
   */
  async list(): Promise<DiscoveryService[]> {
    const span = this.spanEmitter?.(DISCOVERY_EVENTS.LIST_START.replace(/\.start$/, ''));
    try {
      this.assertAuthenticated();
      const sdk = this.getSdk();
      const result = await sdk.listServices();
      const items = Array.isArray(result?.items) ? result.items : [];
      const out: DiscoveryService[] = items.map((s) => ({
        serviceKey: String(s.serviceKey),
        type: String(s.type),
        version: String(s.version),
        ...(typeof s.url === 'string' ? { url: s.url } : {}),
      }));
      span?.finish({ count: out.length });
      return out;
    } catch (err) {
      const wrapped = this.normalizeError(err);
      span?.fail(wrapped);
      throw wrapped;
    }
  }

  /**
   * Drop all cached service URLs. Called when the user signs out so
   * the next resolve() re-queries (defensive: a different user might
   * sign in next).
   */
  invalidateCache(): void {
    this.resolveCache.clear();
  }

  // ─── internals ───────────────────────────────────────────────────────────

  private assertAuthenticated(): void {
    const t = this.token();
    if (typeof t !== 'string' || t.length === 0) {
      throw new DiscoveryError({
        code: DISCOVERY_ERROR_CODES.NOT_AUTHENTICATED,
        message: 'Discovery requires a signed-in user (no auth token available).',
        context: {},
        remediation: 'Sign in to OneReach (Settings -> Account) and try again.',
      });
    }
  }

  private getSdk(): DiscoverySdkLike {
    if (this.sdk !== null) return this.sdk;
    // Lazy require so esbuild keeps the SDK out of the bundle until
    // first call; matches the pattern used by lib/edison-sdk-manager.js.
    if (this.sdkCtor !== null) {
      this.sdk = new this.sdkCtor({ token: this.token, discoveryUrl: this.discoveryUrl });
    } else {
      // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
      const { Discovery } = require('@or-sdk/discovery') as {
        Discovery: new (params: { token: () => string; discoveryUrl: string }) => DiscoverySdkLike;
      };
      this.sdk = new Discovery({ token: this.token, discoveryUrl: this.discoveryUrl });
    }
    return this.sdk;
  }

  private normalizeError(err: unknown, serviceKey?: string): DiscoveryError {
    if (err instanceof DiscoveryError) return err;
    const e = err as { message?: string; response?: { status?: number; data?: unknown } };
    const status = typeof e?.response?.status === 'number' ? e.response.status : undefined;
    const message = typeof e?.message === 'string' ? e.message : 'discovery request failed';

    if (status === 401 || status === 403) {
      return new DiscoveryError({
        code: DISCOVERY_ERROR_CODES.HTTP,
        message: `Discovery rejected request (HTTP ${status}). Token may be expired.`,
        status,
        context: serviceKey !== undefined ? { serviceKey } : {},
        remediation: 'Sign out and back in to refresh the OneReach token.',
        cause: err,
      });
    }
    if (status === 404) {
      return new DiscoveryError({
        code: DISCOVERY_ERROR_CODES.NOT_FOUND,
        message: serviceKey !== undefined
          ? `Discovery has no service named '${serviceKey}'`
          : `Discovery returned 404`,
        status,
        context: serviceKey !== undefined ? { serviceKey } : {},
        remediation: 'Confirm the serviceKey is registered for this account.',
        cause: err,
      });
    }
    if (typeof status === 'number') {
      return new DiscoveryError({
        code: DISCOVERY_ERROR_CODES.HTTP,
        message: `Discovery HTTP ${status}: ${message}`,
        status,
        context: serviceKey !== undefined ? { serviceKey } : {},
        cause: err,
      });
    }
    return new DiscoveryError({
      code: DISCOVERY_ERROR_CODES.NETWORK,
      message: `Discovery network error: ${message}`,
      context: serviceKey !== undefined ? { serviceKey } : {},
      remediation: 'Check your network. The OneReach discovery endpoint may be unreachable.',
      cause: err,
    });
  }
}
