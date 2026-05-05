/**
 * KV transport via `@or-sdk/key-value-storage` -- the authenticated
 * replacement for `EdisonKVClient`.
 *
 * Per the lite-kv-via-sdk chunk in `lite/PORTING.md`, KV calls now
 * ride on the signed-in user's `mult` token instead of hitting the
 * anonymous Edison flow URL. The OneReach KV service scopes records
 * by accountId server-side, replacing today's client-side
 * `edison:<accountId>` key prefix with proper per-account isolation.
 *
 * Internal implementation. Other lite modules MUST consume
 * `getKVApi()` from `./api.ts` -- never reach into this file.
 *
 * This client preserves the public `KVApi` surface (set / get /
 * listKeys / list / delete / onEvent) so consumers (idw, main-window,
 * bug-report, ai, neon) need ZERO changes. The wire format and
 * authentication move; the surface stays.
 *
 * @internal
 */

import type { EventRecord } from '../logging/events.js';
import { getLoggingApi } from '../logging/api.js';
import { isKvEvent, type KvEvent } from './events.js';
import { KVError, KV_ERROR_CODES, type KVConfig, type KVRecord } from './client.js';

/**
 * Structural interface for the subset of `@or-sdk/key-value-storage`
 * we actually call. Lets test fakes satisfy `sdkCtor` without
 * implementing the SDK's full surface (`scrollKeys`, `composeRoute`,
 * `processMultipleRecords`, etc.).
 */
export interface KvSdkLike {
  setValueByKey(
    collection: string,
    key: string,
    value: unknown,
    expire?: number
  ): Promise<{ key: string; value: unknown }>;
  getValueByKey<T = unknown>(collection: string, key: string): Promise<{ key: string; value?: T }>;
  deleteKey(collection: string, key: string): Promise<void>;
  listKeys<T = unknown>(
    collection: string,
    prefix?: string,
    withValues?: boolean
  ): Promise<{ items: Array<{ key: string; value?: T; lastModified?: string }> }>;
}

/**
 * Configuration for `SdkKVClient`. Strict superset of `KVConfig` --
 * adds the SDK-specific token/discovery/accountId fields that the
 * legacy fetch-based client didn't need.
 */
export interface SdkKVClientConfig {
  /** Token getter -- returns the user's mult cookie, or empty string. */
  token: () => string;
  /** Discovery service base URL (used by the SDK to resolve KV's URL). */
  discoveryUrl: string;
  /** OneReach accountId -- used by the SDK to scope server-side. */
  accountId: () => string | null;
  /** Optional SDK constructor override (for tests). */
  sdkCtor?: new (params: {
    token: () => string;
    discoveryUrl: string;
    accountId?: string;
  }) => KvSdkLike;
  /** Optional logger -- defaults to silent. */
  logger?: KVConfig['logger'];
  /** Optional span emitter (ADR-030). */
  spanEmitter?: KVConfig['spanEmitter'];
}

/**
 * Authenticated, per-user KV transport. Same `KVApi` surface as the
 * legacy `EdisonKVClient`; under the hood it delegates to
 * `@or-sdk/key-value-storage` so every request carries the user's
 * `Authorization` header and the server scopes by accountId.
 *
 * @internal
 */
export class SdkKVClient {
  private readonly token: () => string;
  private readonly discoveryUrl: string;
  private readonly getAccountId: () => string | null;
  private readonly log: NonNullable<KVConfig['logger']>;
  private readonly spanEmitter: NonNullable<KVConfig['spanEmitter']> | null;
  private readonly sdkCtor: NonNullable<SdkKVClientConfig['sdkCtor']> | null;
  /** SDK instance, lazy. Re-built when accountId changes. */
  private sdk: KvSdkLike | null = null;
  private sdkForAccountId: string | null = null;

  constructor(config: SdkKVClientConfig) {
    this.token = config.token;
    this.discoveryUrl = config.discoveryUrl;
    this.getAccountId = config.accountId;
    this.log =
      config.logger ??
      ((): void => {
        /* default: silent */
      });
    this.spanEmitter = config.spanEmitter ?? null;
    this.sdkCtor = config.sdkCtor ?? null;
  }

  async set(collection: string, key: string, value: unknown): Promise<void> {
    return this.runRequest('set', collection, key, async () => {
      const sdk = this.getSdk();
      await sdk.setValueByKey(collection, key, value);
    });
  }

  async get(collection: string, key: string): Promise<unknown | null> {
    return this.runRequest('get', collection, key, async () => {
      const sdk = this.getSdk();
      try {
        const record = await sdk.getValueByKey(collection, key);
        if (record === null || record === undefined) return null;
        // SDK returns { key, value } where value is the parsed JSON.
        const value = (record as { value?: unknown }).value;
        return value === undefined ? null : value;
      } catch (err) {
        // Treat 404 / not-found as null rather than an error -- mirrors
        // the legacy client's "No data found" sentinel handling.
        if (isNotFoundError(err)) return null;
        throw err;
      }
    });
  }

  async listKeys(collection: string): Promise<string[]> {
    return this.runRequest('listKeys', collection, undefined, async () => {
      const sdk = this.getSdk();
      const result = await sdk.listKeys(collection);
      const items = Array.isArray(result?.items) ? result.items : [];
      return items
        .map((r) => (typeof r?.key === 'string' ? r.key : null))
        .filter((k): k is string => k !== null);
    });
  }

  async list(collection: string): Promise<KVRecord[]> {
    const span = this.spanEmitter?.('kv.list', { collection });
    try {
      const sdk = this.getSdk();
      // listKeys with `withValues=true` returns key + value in one
      // round trip -- much cheaper than the legacy "listKeys + N gets"
      // pattern in EdisonKVClient.
      const result = await sdk.listKeys<unknown>(collection, undefined, true);
      const items = Array.isArray(result?.items) ? result.items : [];
      const records: KVRecord[] = [];
      for (const item of items) {
        if (item === null || typeof item !== 'object') continue;
        const key = (item as { key?: unknown }).key;
        const value = (item as { value?: unknown }).value;
        if (typeof key !== 'string') continue;
        if (value === undefined || value === null) continue;
        records.push({ key, value });
      }
      span?.finish({ count: records.length });
      return records;
    } catch (err) {
      const wrapped = this.normalizeError(err, 'list', collection);
      span?.fail(wrapped);
      throw wrapped;
    }
  }

  async delete(collection: string, key: string): Promise<void> {
    return this.runRequest('delete', collection, key, async () => {
      const sdk = this.getSdk();
      await sdk.deleteKey(collection, key);
    });
  }

  /**
   * Subscribe to typed KV events (ADR-032). Same shape as the legacy
   * client's onEvent.
   */
  onEvent(handler: (event: KvEvent) => void): () => void {
    return getLoggingApi().onEvent('kv.*', (ev: EventRecord) => {
      if (isKvEvent(ev)) {
        handler(ev as unknown as KvEvent);
      }
    });
  }

  /** @internal -- exposed for tests that swap accounts and want to verify cache invalidation. */
  _resetSdkForTesting(): void {
    this.sdk = null;
    this.sdkForAccountId = null;
  }

  // ─── internals ───────────────────────────────────────────────────────────

  private getSdk(): KvSdkLike {
    const accountId = this.getAccountId();
    if (typeof accountId !== 'string' || accountId.length === 0) {
      throw new KVError({
        code: KV_ERROR_CODES.HTTP,
        message: 'KV requires a signed-in OneReach account.',
        status: 401,
        context: { reason: 'no-account' },
        remediation: 'Sign in to OneReach (Settings -> Account) and try again.',
      });
    }
    // Re-create the SDK if the active account changed -- the SDK's
    // accountId is set at construction time.
    if (this.sdk !== null && this.sdkForAccountId === accountId) return this.sdk;
    if (this.sdkCtor !== null) {
      this.sdk = new this.sdkCtor({
        token: this.token,
        discoveryUrl: this.discoveryUrl,
        accountId,
      });
    } else {
      // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
      const { KeyValueStorage } = require('@or-sdk/key-value-storage') as {
        KeyValueStorage: new (params: {
          token: () => string;
          discoveryUrl: string;
          accountId?: string;
        }) => KvSdkLike;
      };
      this.sdk = new KeyValueStorage({
        token: this.token,
        discoveryUrl: this.discoveryUrl,
        accountId,
      });
    }
    this.sdkForAccountId = accountId;
    return this.sdk;
  }

  private async runRequest<T>(
    op: string,
    collection: string,
    key: string | undefined,
    fn: () => Promise<T>
  ): Promise<T> {
    const span = this.spanEmitter?.(`kv.${op}`, {
      collection,
      ...(key !== undefined ? { key } : {}),
    });
    try {
      const result = await fn();
      this.log('info', `kv-client: ${op} ok`, { collection, key });
      span?.finish();
      return result;
    } catch (err) {
      const wrapped = this.normalizeError(err, op, collection, key);
      this.log('error', `kv-client: ${op} failed`, {
        collection,
        key,
        code: wrapped.code,
        status: wrapped.status,
      });
      span?.fail(wrapped);
      throw wrapped;
    }
  }

  private normalizeError(
    err: unknown,
    op: string,
    collection: string,
    key?: string
  ): KVError {
    if (err instanceof KVError) return err;
    const e = err as {
      message?: string;
      response?: { status?: number; data?: unknown };
      code?: string;
    };
    const status = typeof e?.response?.status === 'number' ? e.response.status : undefined;
    const message = typeof e?.message === 'string' ? e.message : `kv ${op} failed`;
    const baseContext: Record<string, unknown> = {
      op,
      collection,
      ...(key !== undefined ? { key } : {}),
    };

    if (typeof status === 'number') {
      return new KVError({
        code: KV_ERROR_CODES.HTTP,
        message: `KV ${op} HTTP ${status}: ${message}`,
        status,
        context: baseContext,
        remediation: kvHttpRemediation(status),
        cause: err,
      });
    }
    if (e?.code === 'ECONNABORTED' || /timeout/i.test(message)) {
      return new KVError({
        code: KV_ERROR_CODES.TIMEOUT,
        message: `KV ${op} timed out: ${message}`,
        context: baseContext,
        remediation: 'Check your network. Slow connections may need a longer timeout.',
        cause: err,
      });
    }
    return new KVError({
      code: KV_ERROR_CODES.NETWORK,
      message: `KV ${op} network error: ${message}`,
      context: baseContext,
      remediation: 'Check your network connection (DNS, VPN, captive portal).',
      cause: err,
    });
  }
}

function kvHttpRemediation(status: number): string {
  if (status === 401 || status === 403) {
    return 'OneReach rejected the request. Sign out and back in to refresh the token.';
  }
  if (status === 404) {
    return 'The KV record was not found. This may be expected for first-run reads.';
  }
  if (status === 429) {
    return 'OneReach is rate-limiting requests. Wait a few seconds and try again.';
  }
  if (status >= 500) {
    return 'OneReach KV returned a server error. Usually transient -- retry.';
  }
  return 'See OneReach KV docs for the request shape.';
}

function isNotFoundError(err: unknown): boolean {
  const e = err as { response?: { status?: number } };
  return e?.response?.status === 404;
}
