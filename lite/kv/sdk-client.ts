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
  /**
   * Optional hook invoked when the KV server rejects the token as
   * stale. The OneReach KV service surfaces this with messages like
   * `"Token was not accepted: wrong keyId"` even when the underlying
   * HTTP status is buried by the SDK's transport. The kernel wires
   * this to a "Sign in again?" prompt so the user isn't stranded with
   * an opaque KV error.
   *
   * Called once per detected rejection -- the consumer is responsible
   * for de-duping (e.g. only show one dialog at a time).
   */
  onAuthRejected?: (reason: string) => void;
}

/**
 * Substrings the OneReach KV service includes in its rejection
 * messages when the supplied token can't be verified. Detection is
 * defensive: the upstream wording has shifted between releases, so
 * we match on multiple known fragments.
 *
 * Treated as case-insensitive. Add more patterns as new server-side
 * rejection messages surface.
 */
const AUTH_REJECTED_PATTERNS = [
  'token was not accepted',
  'wrong keyid',
  'invalid token',
  'token expired',
  'token has expired',
  'jwt expired',
];

/** True iff `message` matches any of `AUTH_REJECTED_PATTERNS`. */
export function isAuthRejectedMessage(message: string): boolean {
  const lower = message.toLowerCase();
  return AUTH_REJECTED_PATTERNS.some((p) => lower.includes(p));
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
  private readonly onAuthRejected: NonNullable<SdkKVClientConfig['onAuthRejected']> | null;
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
    this.onAuthRejected = config.onAuthRejected ?? null;
  }

  async set(collection: string, key: string, value: unknown): Promise<void> {
    // Defense against the historical "menus disappeared" bug: a
    // callsite once passed `undefined` here and the SDK coerced it to
    // the string `"undefined"`, which was then persisted and silently
    // resurrected on every subsequent read as garbage. Stores
    // detected the bad shape and recovered to empty, leaving users
    // with the impression that their tabs / agents / tools never
    // saved. Now we refuse to write anything that isn't a plain
    // structured blob — undefined, null, and primitives all reject
    // with KV_INVALID_INPUT before the network call, so corrupt blobs
    // can no longer enter the store.
    rejectIfNotStructured(collection, key, value);
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
        if (value === undefined) return null;
        // Some OneReach KV API responses surface "key not found" as a
        // 200 body of `{Status: "No data found."}` instead of a 404.
        // The SDK passes that body through verbatim as the value, so
        // we'd otherwise hand the store a sentinel object that fails
        // shape validation and triggers an "empty" recovery. Treat
        // the sentinel as semantically equivalent to null.
        if (isNoDataFoundSentinel(value)) return null;
        return value;
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
    if (err instanceof KVError) {
      // Forward the auth-rejection signal even when the upstream
      // already wrapped the error -- e.g. `getSdk()` throws KVError
      // with status 401 when accountId is null, which is the same
      // re-sign-in case as a server-rejected token.
      if (err.status === 401 || err.status === 403) {
        this.notifyAuthRejected(err.message);
      }
      return err;
    }
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

    // The OneReach KV service occasionally rejects a stale `mult`
    // token by surfacing "Token was not accepted: wrong keyId" without
    // a clean HTTP status (the SDK swallows the response). Detect that
    // pattern and treat it as a 401 so the kernel can prompt
    // re-sign-in instead of leaving the user with an opaque
    // `KV_NETWORK` toast.
    if (typeof status !== 'number' && isAuthRejectedMessage(message)) {
      this.notifyAuthRejected(message);
      return new KVError({
        code: KV_ERROR_CODES.HTTP,
        message: `KV ${op} HTTP 401: ${message}`,
        status: 401,
        context: { ...baseContext, reason: 'token-rejected' },
        remediation: kvHttpRemediation(401),
        cause: err,
      });
    }

    if (typeof status === 'number') {
      if (status === 401 || status === 403) {
        this.notifyAuthRejected(message);
      }
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

  /**
   * Fire the optional auth-rejection callback. Wrapped in try/catch so
   * a misbehaving consumer (e.g. dialog-show throws) cannot mask the
   * original KV error.
   */
  private notifyAuthRejected(reason: string): void {
    if (this.onAuthRejected === null) return;
    try {
      this.onAuthRejected(reason);
    } catch (err) {
      this.log('warn', 'kv-client: onAuthRejected handler threw', {
        error: (err as Error).message,
      });
    }
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

/**
 * Detect the OneReach KV "key not found" sentinel that some API
 * deployments return as a 200 body instead of a 404. Shape:
 *   `{ Status: "No data found." }`
 *
 * Case-sensitive on both the key and value because that's the exact
 * response the server emits; matching loosely would risk eating a
 * legitimately stored object that happens to have a `Status` field.
 */
function isNoDataFoundSentinel(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  // Only a 1-key object whose sole key is `Status` with the exact
  // server sentinel string counts. Anything else (including objects
  // with `Status` plus other keys) is real data.
  const keys = Object.keys(obj);
  if (keys.length !== 1 || keys[0] !== 'Status') return false;
  return obj['Status'] === 'No data found.';
}

/**
 * Reject any `kv.set()` value that isn't a plain structured blob.
 * Throws `KV_INVALID_INPUT` for `undefined`, `null`, and primitives
 * (string / number / boolean / bigint / symbol / function).
 *
 * Arrays at the top level are also rejected: every callsite in the
 * codebase wraps its data in a parent object (`{tabs: [...]}`,
 * `{entries: [...]}`, ...), so a bare array landing here would be a
 * shape regression and would re-introduce the same "looks like data
 * but the store can't decode it" failure mode the readBlob guards
 * are meant to surface.
 */
function rejectIfNotStructured(collection: string, key: string, value: unknown): void {
  const t = typeof value;
  let reason: string | null = null;
  if (value === undefined) reason = 'value is undefined';
  else if (value === null) reason = 'value is null';
  else if (t !== 'object') reason = `value is a ${t}, expected an object`;
  else if (Array.isArray(value)) reason = 'value is an array, expected a plain object';
  if (reason === null) return;
  throw new KVError({
    code: KV_ERROR_CODES.INVALID_INPUT,
    message: `kv.set rejected: ${reason}`,
    context: { collection, key, valueType: t, isArray: Array.isArray(value) },
    remediation:
      'Wrap the data in a plain object before calling kv.set (e.g. `{tabs: [...]}` or `{entries: [...]}`).',
  });
}
