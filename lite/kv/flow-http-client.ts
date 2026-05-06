/**
 * Flow-token KV transport.
 *
 * The OneReach KV service that the user's account actually has access
 * to is the per-account flow KV at
 *
 *   https://em.edison.api.onereach.ai/http/{accountId}/keyvalue
 *
 * It accepts the token returned from the public per-account
 * `refresh_token` flow:
 *
 *   GET https://em.edison.api.onereach.ai/http/{accountId}/refresh_token
 *
 * The returned token must be sent literally as `Authorization: FLOW <token>`.
 *
 * Why this transport (not the SDK):
 *   - `@or-sdk/key-value-storage` (the path lite previously used) goes
 *     through Edison discovery and expects a "user-level platform token".
 *     Lite's auth captures the user's OAuth `mult` cookie -- the SDK KV
 *     server rejects that with `Token was not accepted: wrong keyId`.
 *   - The full app's KV consumers (tickets-client.js, signaling-client.js,
 *     capture-signaling.js) all use this direct-HTTP / FLOW-token path.
 *     It works for normal user accounts; the SDK path doesn't.
 *
 * Wire format:
 *   - GET    `?id={collection}&key={key}`             - read one
 *   - PUT    `?id={collection}&key={key}` body={...}  - write one
 *   - DELETE `?id={collection}&key={key}`             - remove one
 *   - POST   body={ id: collection }                  - list keys
 *
 * Response shapes vary across the flow's endpoints; the parser below
 * matches what `lib/tickets-client.js` actually saw in production.
 *
 * @internal
 */

import type { Span, EventRecord } from '../logging/events.js';
import { getLoggingApi } from '../logging/api.js';
import { KVError, KV_ERROR_CODES, type KVRecord } from './client.js';
import { isAuthRejectedMessage } from './sdk-client.js';
import { isKvEvent, type KvEvent } from './events.js';

/** 50 minutes -- conservative cache lifetime; matches lib/tickets-client.js. */
export const FLOW_TOKEN_TTL_MS = 50 * 60 * 1000;

/**
 * Configuration for {@link FlowHttpKVClient}. Strict superset of
 * `KVConfig` -- adds the per-account URL builder + token cache.
 */
export interface FlowHttpKVClientConfig {
  /** OneReach accountId resolver. Returns null when signed-out. */
  accountId: () => string | null;
  /**
   * Optional fetch impl override (for tests). Defaults to global
   * `fetch`. Tests pass a stub that records calls + returns canned
   * responses.
   */
  fetchImpl?: typeof fetch;
  /** Optional logger. Defaults to silent. */
  logger?: (level: 'info' | 'warn' | 'error', message: string, data?: unknown) => void;
  /** Optional span emitter (ADR-030). */
  spanEmitter?: (name: string, data?: unknown) => Span;
  /**
   * Optional hook fired when KV rejects a token (HTTP 401/403 or
   * `Token was not accepted` body). The kernel wires this to the
   * re-sign-in prompt. Calls are de-duped per-rejection by the
   * consumer (the prompter handle).
   */
  onAuthRejected?: (reason: string) => void;
  /**
   * Override for the URL host. Defaults to the production
   * `em.edison.api.onereach.ai`. Tests pass a localhost / nock URL.
   */
  baseUrl?: string;
  /** Token cache TTL override (ms). Defaults to {@link FLOW_TOKEN_TTL_MS}. */
  tokenTtlMs?: number;
  /** Clock override for tests. Defaults to `Date.now`. */
  now?: () => number;
}

interface CachedToken {
  /** The full Authorization header value (already prefixed with `FLOW `). */
  authHeader: string;
  /** Epoch ms when this token expires from the cache. */
  expiresAt: number;
  /** AccountId this token was minted for. Cache invalidates when account changes. */
  accountId: string;
}

const DEFAULT_BASE_URL = 'https://em.edison.api.onereach.ai';

/**
 * KV client that talks the full app's `/http/{accountId}/keyvalue`
 * protocol. Public surface mirrors `KVApi`; consumers go through
 * `getKVApi()` from `./api.ts`.
 *
 * @internal
 */
export class FlowHttpKVClient {
  private readonly getAccountId: FlowHttpKVClientConfig['accountId'];
  private readonly fetchImpl: typeof fetch;
  private readonly log: NonNullable<FlowHttpKVClientConfig['logger']>;
  private readonly spanEmitter: NonNullable<FlowHttpKVClientConfig['spanEmitter']> | null;
  private readonly onAuthRejected: NonNullable<FlowHttpKVClientConfig['onAuthRejected']> | null;
  private readonly baseUrl: string;
  private readonly tokenTtlMs: number;
  private readonly nowFn: () => number;
  private cachedToken: CachedToken | null = null;
  private inflightRefresh: Promise<CachedToken> | null = null;

  constructor(config: FlowHttpKVClientConfig) {
    this.getAccountId = config.accountId;
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.log =
      config.logger ??
      ((): void => {
        /* default: silent */
      });
    this.spanEmitter = config.spanEmitter ?? null;
    this.onAuthRejected = config.onAuthRejected ?? null;
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
    this.tokenTtlMs = config.tokenTtlMs ?? FLOW_TOKEN_TTL_MS;
    this.nowFn = config.now ?? ((): number => Date.now());
  }

  // ─── public surface (KVApi) ───────────────────────────────────────────

  async set(collection: string, key: string, value: unknown): Promise<void> {
    return this.runRequest('set', collection, key, async () => {
      const accountId = this.requireAccountId();
      const auth = await this.getAuthHeader(accountId);
      const url =
        `${this.kvUrl(accountId)}?id=${encodeURIComponent(collection)}&key=${encodeURIComponent(key)}`;
      const resp = await this.fetchImpl(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: auth },
        body: JSON.stringify({ id: collection, key, value }),
      });
      await this.assertOk(resp, 'set', collection, key);
    });
  }

  async get(collection: string, key: string): Promise<unknown | null> {
    return this.runRequest('get', collection, key, async () => {
      const accountId = this.requireAccountId();
      const auth = await this.getAuthHeader(accountId);
      const url =
        `${this.kvUrl(accountId)}?id=${encodeURIComponent(collection)}&key=${encodeURIComponent(key)}`;
      const resp = await this.fetchImpl(url, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json', Authorization: auth },
      });
      // 404 -> null (mirrors the SDK and the EdisonKVClient behavior).
      if (resp.status === 404) return null;
      await this.assertOk(resp, 'get', collection, key);
      const text = await resp.text();
      if (text === '' || text === 'null' || text === '""') return null;
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        // Body was not JSON -- treat as raw string.
        return text;
      }
      // The flow returns shapes like
      //   { Status: 'No data found.' }
      //   { value: ... }
      //   { get: { value: ... } }
      //   { data: { value: ... } }
      // and sometimes the value itself wrapped in another JSON string.
      const obj = parsed as Record<string, unknown>;
      if (obj['Status'] === 'No data found.' || obj['status'] === 'No data found.') {
        return null;
      }
      const inner =
        (obj['get'] as { value?: unknown } | undefined)?.value ??
        obj['value'] ??
        (obj['data'] as { value?: unknown } | undefined)?.value;
      if (inner === undefined) {
        // Some paths return the raw value at the top level. Fall back
        // to the parsed body itself.
        return parsed;
      }
      if (typeof inner === 'string') {
        // The flow occasionally double-encodes the value (the original
        // PUT body was a JSON string of a JSON object). Try one more
        // parse, but never throw -- if the inner string isn't JSON,
        // return it verbatim.
        try {
          return JSON.parse(inner);
        } catch {
          return inner;
        }
      }
      return inner;
    });
  }

  async listKeys(collection: string): Promise<string[]> {
    return this.runRequest('listKeys', collection, undefined, async () => {
      const accountId = this.requireAccountId();
      const auth = await this.getAuthHeader(accountId);
      const resp = await this.fetchImpl(this.kvUrl(accountId), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: auth },
        body: JSON.stringify({ id: collection }),
      });
      await this.assertOk(resp, 'listKeys', collection);
      const text = await resp.text();
      if (text === '' || text === 'null') return [];
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return [];
      }
      const obj = parsed as Record<string, unknown>;
      const records: unknown =
        (obj['getStorageData'] as { records?: unknown } | undefined)?.records ??
        obj['records'] ??
        (obj['data'] as { records?: unknown } | undefined)?.records ??
        parsed;
      if (!Array.isArray(records)) return [];
      return records
        .map((r) => (typeof r === 'string' ? r : (r as { key?: unknown })?.key))
        .filter((k): k is string => typeof k === 'string');
    });
  }

  async list(collection: string): Promise<KVRecord[]> {
    const span = this.spanEmitter?.('kv.list', { collection });
    try {
      const keys = await this.listKeys(collection);
      const records: KVRecord[] = [];
      // Per-key get failures are logged and skipped (matches the
      // SdkKVClient + EdisonKVClient partial-failure behavior).
      const results = await Promise.allSettled(keys.map((k) => this.get(collection, k)));
      for (let i = 0; i < results.length; i += 1) {
        const r = results[i];
        const key = keys[i];
        if (key === undefined) continue;
        if (r === undefined) continue;
        if (r.status === 'fulfilled' && r.value !== null && r.value !== undefined) {
          records.push({ key, value: r.value });
        } else if (r.status === 'rejected') {
          this.log('warn', 'kv-flow: per-key get failed during list, skipping', {
            collection,
            key,
            error: (r.reason as Error)?.message,
          });
        }
      }
      span?.finish({ count: records.length });
      return records;
    } catch (err) {
      span?.fail(err);
      throw err;
    }
  }

  async delete(collection: string, key: string): Promise<void> {
    return this.runRequest('delete', collection, key, async () => {
      const accountId = this.requireAccountId();
      const auth = await this.getAuthHeader(accountId);
      const url =
        `${this.kvUrl(accountId)}?id=${encodeURIComponent(collection)}&key=${encodeURIComponent(key)}`;
      const resp = await this.fetchImpl(url, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', Authorization: auth },
      });
      // 404 on delete: idempotent success (the row was already gone).
      if (resp.status === 404) return;
      await this.assertOk(resp, 'delete', collection, key);
    });
  }

  /**
   * Subscribe to typed KV events (ADR-032). Same shape as the SDK
   * client's `onEvent` -- both clients emit the same span/event names
   * via the central logging API.
   */
  onEvent(handler: (event: KvEvent) => void): () => void {
    return getLoggingApi().onEvent('kv.*', (ev: EventRecord) => {
      if (isKvEvent(ev)) {
        handler(ev as unknown as KvEvent);
      }
    });
  }

  /** @internal -- exposed for tests to verify cache invalidation. */
  _resetTokenCacheForTesting(): void {
    this.cachedToken = null;
    this.inflightRefresh = null;
  }

  // ─── internals ────────────────────────────────────────────────────────

  /** Per-account KV endpoint URL. */
  private kvUrl(accountId: string): string {
    return `${this.baseUrl}/http/${accountId}/keyvalue`;
  }

  /** Per-account `refresh_token` flow URL. Public; no auth needed. */
  private refreshTokenUrl(accountId: string): string {
    return `${this.baseUrl}/http/${accountId}/refresh_token`;
  }

  private requireAccountId(): string {
    const accountId = this.getAccountId();
    if (typeof accountId !== 'string' || accountId.length === 0) {
      const err = new KVError({
        code: KV_ERROR_CODES.HTTP,
        message: 'KV requires a signed-in OneReach account.',
        status: 401,
        context: { reason: 'no-account' },
        remediation: 'Sign in to OneReach (Settings -> Account) and try again.',
      });
      this.notifyAuthRejected(err.message);
      throw err;
    }
    return accountId;
  }

  /**
   * Return a valid `Authorization: FLOW <token>` header value, fetching
   * a fresh one if the cache is empty / stale / for a different account.
   *
   * Concurrent callers all await the same in-flight refresh promise so
   * we make one network call per cache miss, not N.
   */
  private async getAuthHeader(accountId: string): Promise<string> {
    const now = this.nowFn();
    const cached = this.cachedToken;
    if (cached !== null && cached.accountId === accountId && cached.expiresAt > now) {
      return cached.authHeader;
    }
    if (this.inflightRefresh !== null) {
      const t = await this.inflightRefresh;
      return t.authHeader;
    }
    this.inflightRefresh = this.refreshToken(accountId).finally(() => {
      this.inflightRefresh = null;
    });
    const t = await this.inflightRefresh;
    return t.authHeader;
  }

  private async refreshToken(accountId: string): Promise<CachedToken> {
    const url = this.refreshTokenUrl(accountId);
    let resp: Response;
    try {
      resp = await this.fetchImpl(url, { method: 'GET' });
    } catch (err) {
      throw new KVError({
        code: KV_ERROR_CODES.NETWORK,
        message: `KV refresh_token network error: ${(err as Error).message}`,
        context: { op: 'refresh_token', accountId },
        remediation: 'Check your network connection (DNS, VPN, captive portal).',
        cause: err as Error,
      });
    }
    if (!resp.ok) {
      const body = await safeReadBody(resp);
      throw new KVError({
        code: KV_ERROR_CODES.HTTP,
        message: `KV refresh_token failed: HTTP ${resp.status}`,
        status: resp.status,
        ...(body !== undefined ? { responseBody: body } : {}),
        context: { op: 'refresh_token', accountId },
        remediation: `The /http/${accountId}/refresh_token flow may not be deployed for this account.`,
      });
    }
    let data: { token?: string; access_token?: string };
    try {
      data = (await resp.json()) as { token?: string; access_token?: string };
    } catch (err) {
      throw new KVError({
        code: KV_ERROR_CODES.HTTP,
        message: `KV refresh_token returned non-JSON body`,
        status: resp.status,
        context: { op: 'refresh_token', accountId },
        remediation: 'The refresh_token flow returned an unexpected payload.',
        cause: err as Error,
      });
    }
    let raw = data.token ?? data.access_token ?? '';
    if (raw === '') {
      throw new KVError({
        code: KV_ERROR_CODES.HTTP,
        message: 'KV refresh_token returned an empty token',
        status: resp.status,
        context: { op: 'refresh_token', accountId },
        remediation: 'The refresh_token flow must return `{ token: "..." }`.',
      });
    }
    if (!raw.startsWith('FLOW ')) raw = `FLOW ${raw}`;
    const cached: CachedToken = {
      authHeader: raw,
      expiresAt: this.nowFn() + this.tokenTtlMs,
      accountId,
    };
    this.cachedToken = cached;
    this.log('info', 'kv-flow: token acquired', { accountId, ttlMs: this.tokenTtlMs });
    return cached;
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
      this.log('info', `kv-flow: ${op} ok`, { collection, key });
      span?.finish();
      return result;
    } catch (err) {
      const wrapped = this.normalizeError(err, op, collection, key);
      this.log('error', `kv-flow: ${op} failed`, {
        collection,
        key,
        code: wrapped.code,
        status: wrapped.status,
      });
      span?.fail(wrapped);
      throw wrapped;
    }
  }

  /**
   * Convert an HTTP response or a thrown error into a KVError, firing
   * `onAuthRejected` when appropriate. Mirrors the sdk-client's
   * classification so the kernel's prompt-to-re-sign-in flow keeps
   * working unchanged.
   */
  private async assertOk(
    resp: Response,
    op: string,
    collection: string,
    key?: string
  ): Promise<void> {
    if (resp.ok) return;
    const body = await safeReadBody(resp);
    if (resp.status === 401 || resp.status === 403) {
      // Token cache may be stale (server rotated keyset). Drop it so
      // the next call refreshes. The auth-rejection hook still fires
      // for the kernel's prompt path.
      this.cachedToken = null;
      const reason = body !== undefined && body.length > 0 ? body : `HTTP ${resp.status}`;
      this.notifyAuthRejected(reason);
    } else if (isAuthRejectedMessage(body ?? '')) {
      this.cachedToken = null;
      this.notifyAuthRejected(body ?? '');
    }
    const baseContext: Record<string, unknown> = {
      op,
      collection,
      ...(key !== undefined ? { key } : {}),
    };
    throw new KVError({
      code: KV_ERROR_CODES.HTTP,
      message: `KV ${op} HTTP ${resp.status}${body !== undefined && body.length > 0 ? ': ' + body : ''}`,
      status: resp.status,
      ...(body !== undefined ? { responseBody: body } : {}),
      context: baseContext,
      remediation:
        resp.status === 401 || resp.status === 403
          ? 'OneReach rejected the request. Sign out and back in to refresh the token.'
          : resp.status === 404
            ? 'The KV record was not found. This may be expected for first-run reads.'
            : resp.status >= 500
              ? 'OneReach KV returned a server error. Usually transient -- retry.'
              : 'See OneReach KV docs for the request shape.',
    });
  }

  private normalizeError(
    err: unknown,
    op: string,
    collection: string,
    key?: string
  ): KVError {
    if (err instanceof KVError) return err;
    if (err instanceof Error) {
      const baseContext: Record<string, unknown> = {
        op,
        collection,
        ...(key !== undefined ? { key } : {}),
      };
      return new KVError({
        code: KV_ERROR_CODES.NETWORK,
        message: `KV ${op} network error: ${err.message}`,
        context: baseContext,
        remediation: 'Check your network connection (DNS, VPN, captive portal).',
        cause: err,
      });
    }
    return new KVError({
      code: KV_ERROR_CODES.NETWORK,
      message: `KV ${op} unknown error`,
      context: { op, collection, ...(key !== undefined ? { key } : {}) },
      remediation: 'Unexpected error type; retry, then file a bug if it persists.',
    });
  }

  private notifyAuthRejected(reason: string): void {
    if (this.onAuthRejected === null) return;
    try {
      this.onAuthRejected(reason);
    } catch (err) {
      this.log('warn', 'kv-flow: onAuthRejected handler threw', {
        error: (err as Error).message,
      });
    }
  }
}

/** Read response body text; never throw -- used for diagnostic context. */
async function safeReadBody(resp: Response): Promise<string | undefined> {
  try {
    const text = await resp.text();
    return text.slice(0, 500);
  } catch {
    return undefined;
  }
}
