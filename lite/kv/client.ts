/**
 * Edison KV flow client -- HTTP wrapper for OneReach key-value storage.
 *
 * Internal implementation. Other lite modules MUST NOT import this file
 * directly -- consume via `getKVApi()` from `./api.ts` (Rule 11 in
 * lite/LITE-RULES.md, ADR-019 + ADR-020 in lite/DECISIONS.md).
 *
 * Contract per the OneReach KeyValue Storage API Guide:
 * https://files.edison.api.onereach.ai/public/35254342-4a2e-475b-aec1-18547e517e29/IDWintegrationDocs/OMNI_KEYVALUE_STORAGE_GUIDE.md
 *
 *   PUT    /keyvalue?id={collection}&key={key}     body: { id, key, itemValue: <JSON-stringified value> }
 *   GET    /keyvalue?id={collection}&key={key}     -> { value: <stringified> } | { Status: "No data found." }
 *   POST   /keyvalue                                body: { id: collection }  -> [{ key }, ...]
 *   DELETE /keyvalue?id={collection}&key={key}     (may timeout but typically succeeds)
 *
 * Important: itemValue must be a JSON string (we JSON.stringify before send,
 * JSON.parse on receive). The docs are explicit about this.
 *
 * Auth: anonymous -- the flow URL itself is the bearer of trust.
 *
 * Failures throw `KVError`; callers decide whether to retry, fall back,
 * or surface the error to the user.
 */

import { LiteError } from '../errors.js';
import type { LiteErrorOptions } from '../errors.js';
import type { Span, EventRecord } from '../logging/events.js';
import { getLoggingApi } from '../logging/api.js';
import { isKvEvent, type KvEvent } from './events.js';

const DEFAULT_KV_URL = 'https://em.edison.api.onereach.ai/http/35254342-4a2e-475b-aec1-18547e517e29/keyvalue';

const DEFAULT_TIMEOUT_MS = 5000; // For set/get/delete -- block the user's save button
const DEFAULT_LIST_TIMEOUT_MS = 2500; // For list -- runs while modal is open, must be snappy

/**
 * Stable error codes thrown by the KV module. See
 * `lite/kv/README.md` "Error catalog" for full descriptions.
 */
export const KV_ERROR_CODES = {
  /** Request didn't return within the configured timeout. */
  TIMEOUT: 'KV_TIMEOUT',
  /** Server returned non-2xx HTTP status. */
  HTTP: 'KV_HTTP',
  /** Underlying fetch threw (DNS, TCP, TLS, abort-not-timeout). */
  NETWORK: 'KV_NETWORK',
} as const;

export type KVErrorCode = (typeof KV_ERROR_CODES)[keyof typeof KV_ERROR_CODES];

export interface KVConfig {
  /** Override for tests / future port that moves URL into settings. */
  url?: string;
  /** Per-request timeout for set/get/delete in milliseconds. Default 5000. */
  timeoutMs?: number;
  /** Per-request timeout for list specifically. Default 2500 (snappier UX). */
  listTimeoutMs?: number;
  /** Optional fetch implementation override (for tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Optional logger -- called with structured events for diagnostics. */
  logger?: (level: 'info' | 'warn' | 'error', message: string, data?: unknown) => void;
  /**
   * Optional span emitter -- when provided, every operation
   * (`set/get/listKeys/delete/list`) wraps its work in a
   * `kv.<op>.start` / `.finish` / `.fail` span. ADR-030.
   * The default config in `kv/api.ts` wires this to `getLoggingApi().start()`.
   * Tests can pass a no-op or a recording stub.
   */
  spanEmitter?: (name: string, data?: unknown) => Span;
}

export interface KVRecord {
  /** Unique key within the collection */
  key: string;
  /** Stored value -- the deserialized JSON the caller originally `set()` */
  value: unknown;
}

export interface KVErrorOptions extends Omit<LiteErrorOptions, 'code'> {
  code: KVErrorCode;
  /** HTTP status code, if the failure originated from a server response. */
  status?: number;
  /** First ~200 chars of the response body, for diagnostics. */
  responseBody?: string;
}

/**
 * Structured error from the KV module. Always extends `LiteError`, so
 * consumers can catch with either `instanceof LiteError` (generic) or
 * `instanceof KVError` (KV-specific).
 *
 * Carries:
 *   - `.code` -- one of `KV_ERROR_CODES` (KV_TIMEOUT, KV_HTTP, etc.)
 *   - `.context` -- `{ op, collection, key, status?, body? }`
 *   - `.remediation` -- short, action-oriented hint
 *   - `.cause` -- the underlying Error (network, abort, etc.)
 *   - `.status` / `.responseBody` -- legacy convenience fields, mirror
 *     the values inside `.context`
 *
 * See `lite/kv/README.md` for the full error catalog.
 */
export class KVError extends LiteError {
  public readonly status: number | undefined;
  public readonly responseBody: string | undefined;

  constructor(options: KVErrorOptions) {
    const context: Record<string, unknown> = { ...(options.context ?? {}) };
    if (options.status !== undefined) context['status'] = options.status;
    if (options.responseBody !== undefined) {
      const trimmed = options.responseBody.slice(0, 200);
      context['body'] = trimmed;
    }
    const baseOptions: LiteErrorOptions = {
      code: options.code,
      message: options.message,
      context,
      ...(options.remediation !== undefined ? { remediation: options.remediation } : {}),
      ...(options.cause !== undefined ? { cause: options.cause } : {}),
    };
    super(baseOptions);
    this.name = 'KVError';
    this.status = options.status;
    this.responseBody = options.responseBody;
  }
}

function buildUrl(base: string, collection: string, key?: string): string {
  const params = new URLSearchParams({ id: collection });
  if (key !== undefined) params.set('key', key);
  return `${base}?${params.toString()}`;
}

/**
 * HTTP wrapper for the Edison KV flow. Module-internal; not part of the
 * public lite/kv surface. Consumers go through `getKVApi()` in `./api.ts`
 * (rule 11 in lite/LITE-RULES.md, ADR-019/020 in lite/DECISIONS.md).
 *
 * @internal
 */
export class EdisonKVClient {
  private readonly url: string;
  private readonly timeoutMs: number;
  private readonly listTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly log: NonNullable<KVConfig['logger']>;
  private readonly spanEmitter: NonNullable<KVConfig['spanEmitter']> | null;

  constructor(config: KVConfig = {}) {
    this.url = config.url ?? DEFAULT_KV_URL;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.listTimeoutMs = config.listTimeoutMs ?? DEFAULT_LIST_TIMEOUT_MS;
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.log =
      config.logger ??
      ((): void => {
        /* default: silent */
      });
    this.spanEmitter = config.spanEmitter ?? null;
  }

  /**
   * Set (upsert) a record. The value is JSON.stringified before send per
   * the API contract.
   */
  async set(collection: string, key: string, value: unknown): Promise<void> {
    const url = buildUrl(this.url, collection, key);
    const body = JSON.stringify({
      id: collection,
      key,
      itemValue: JSON.stringify(value),
    });
    return this.runRequest('set', collection, key, this.timeoutMs, async (signal) => {
      const res = await this.fetchImpl(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new KVError({
          code: KV_ERROR_CODES.HTTP,
          message: `KV set failed: HTTP ${res.status} from ${this.url}`,
          status: res.status,
          responseBody: text,
          context: { op: 'set', collection, key },
          remediation: kvHttpRemediation(res.status),
        });
      }
      return undefined;
    });
  }

  /**
   * Get a single record by key. Returns null if not found.
   * Throws KVError on network/server errors.
   */
  async get(collection: string, key: string): Promise<unknown | null> {
    const url = buildUrl(this.url, collection, key);
    return this.runRequest('get', collection, key, this.timeoutMs, async (signal) => {
      const res = await this.fetchImpl(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new KVError({
          code: KV_ERROR_CODES.HTTP,
          message: `KV get failed: HTTP ${res.status} from ${this.url}`,
          status: res.status,
          responseBody: text,
          context: { op: 'get', collection, key },
          remediation: kvHttpRemediation(res.status),
        });
      }
      const text = await res.text();
      if (text.trim() === '') return null;
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return text; // Non-JSON body -- return as-is
      }
      // "No data found" sentinel
      if (this.isNoDataFound(parsed)) return null;
      // Wrapped value: { value: "<JSON-stringified>" }
      if (typeof parsed === 'object' && parsed !== null && 'value' in parsed) {
        const wrapped = (parsed as { value: unknown }).value;
        if (typeof wrapped === 'string') {
          try {
            return JSON.parse(wrapped);
          } catch {
            return wrapped; // Stored as plain string
          }
        }
        return wrapped;
      }
      return parsed;
    });
  }

  /**
   * Delete a record. The flow's DELETE may time out but typically
   * succeeds (per upstream docs). Treats timeouts as non-fatal -- caller
   * should not retry indefinitely.
   */
  async delete(collection: string, key: string): Promise<void> {
    const url = buildUrl(this.url, collection, key);
    return this.runRequest('delete', collection, key, this.timeoutMs, async (signal) => {
      const res = await this.fetchImpl(url, {
        method: 'DELETE',
        headers: { Accept: 'application/json' },
        signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new KVError({
          code: KV_ERROR_CODES.HTTP,
          message: `KV delete failed: HTTP ${res.status} from ${this.url}`,
          status: res.status,
          responseBody: text,
          context: { op: 'delete', collection, key },
          remediation: kvHttpRemediation(res.status),
        });
      }
      return undefined;
    });
  }

  /**
   * List all records in a collection. Per the docs:
   *   POST /keyvalue  body: { id: collection }  -> [{ key: "..." }, ...]
   * The list returns KEYS only -- not values. Callers that need values
   * must follow up with `get()` per key.
   *
   * For bug-report use, the store layer handles batching: it calls list()
   * then get() in parallel for each key.
   */
  async listKeys(collection: string): Promise<string[]> {
    return this.runRequest('listKeys', collection, undefined, this.listTimeoutMs, async (signal) => {
      const res = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: collection }),
        signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new KVError({
          code: KV_ERROR_CODES.HTTP,
          message: `KV listKeys failed: HTTP ${res.status} from ${this.url}`,
          status: res.status,
          responseBody: text,
          context: { op: 'listKeys', collection },
          remediation: kvHttpRemediation(res.status),
        });
      }
      const text = await res.text();
      if (text.trim() === '') return [];
      const parsed = JSON.parse(text) as unknown;
      if (!Array.isArray(parsed)) {
        // Empty / non-array means no records.
        if (this.isNoDataFound(parsed)) return [];
        return [];
      }
      const keys: string[] = [];
      for (const entry of parsed) {
        if (typeof entry === 'string') {
          keys.push(entry);
        } else if (typeof entry === 'object' && entry !== null && 'key' in entry) {
          const k = (entry as { key: unknown }).key;
          if (typeof k === 'string') keys.push(k);
        }
      }
      return keys;
    });
  }

  /**
   * Convenience: list keys + fetch each value in parallel. Returns full
   * KVRecord[]. Has the network cost of (1 list + N gets).
   *
   * Get failures for individual keys are skipped (logged) so a partial
   * fetch still returns useful data.
   */
  async list(collection: string): Promise<KVRecord[]> {
    // list() composes listKeys + N parallel gets, so it doesn't go
    // through runRequest. Span explicitly here so consumers see one
    // span for the whole list op (the inner listKeys/get spans are
    // separately visible for drill-down).
    const span = this.spanEmitter?.('kv.list', { collection });
    try {
      const keys = await this.listKeys(collection);
      if (keys.length === 0) {
        span?.finish({ count: 0 });
        return [];
      }
      const settled = await Promise.all(
        keys.map((key) =>
          this.get(collection, key)
            .then((value) => ({ key, value, ok: true }) as const)
            .catch((err) => {
              this.log('warn', 'kv-client: list per-key get failed', {
                collection,
                key,
                error: (err as Error).message,
              });
              return { key, value: null, ok: false } as const;
            })
        )
      );
      const records = settled
        .filter((r) => r.ok && r.value !== null)
        .map(({ key, value }) => ({ key, value }));
      span?.finish({ count: records.length });
      return records;
    } catch (err) {
      span?.fail(err);
      throw err;
    }
  }

  /**
   * Subscribe to typed KV events (ADR-032). Internally subscribes to
   * `getLoggingApi().onEvent('kv.*', ...)` and casts each matching
   * record to `KvEvent`. The implementation lives here so the public
   * `KVApi` returned by `getKVApi()` carries the method directly --
   * `getKVApi().onEvent(handler)` works without a wrapping layer.
   *
   * Imports `getLoggingApi`/`isKvEvent` via the lazy helper at the
   * top of this file to avoid a hard coupling from this internal
   * client to the logging singleton at module-load time (only when
   * `onEvent` is actually called).
   */
  onEvent(handler: (event: KvEvent) => void): () => void {
    return getLoggingApi().onEvent('kv.*', (ev: EventRecord) => {
      if (isKvEvent(ev)) {
        handler(ev as unknown as KvEvent);
      }
    });
  }

  private isNoDataFound(parsed: unknown): boolean {
    if (typeof parsed !== 'object' || parsed === null) return false;
    const status = (parsed as Record<string, unknown>).Status;
    return typeof status === 'string' && /no\s*data\s*found/i.test(status);
  }

  /**
   * Common request wrapper: timeout + abort + structured logging + error
   * normalization to KVError.
   */
  private async runRequest<T>(
    op: string,
    collection: string,
    key: string | undefined,
    timeoutMs: number,
    fn: (signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    // ADR-030: every KV op emits kv.<op>.start / kv.<op>.finish / kv.<op>.fail
    // when a spanEmitter is configured. The default config in kv/api.ts wires
    // it to getLoggingApi().start(); tests can pass a stub or omit entirely.
    const span = this.spanEmitter?.(`kv.${op}`, {
      collection,
      ...(key !== undefined ? { key } : {}),
    });
    try {
      const result = await fn(controller.signal);
      this.log('info', `kv-client: ${op} ok`, { collection, key });
      span?.finish();
      return result;
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        this.log('warn', `kv-client: ${op} timed out`, { collection, key, timeoutMs });
        const timeoutErr = new KVError({
          code: KV_ERROR_CODES.TIMEOUT,
          message: `KV ${op} timed out after ${timeoutMs}ms`,
          context: { op, collection, ...(key !== undefined ? { key } : {}), timeoutMs },
          remediation:
            'Check your network connection. If you are on a slow link, the operation may need a longer timeout.',
          cause: err,
        });
        span?.fail(timeoutErr);
        throw timeoutErr;
      }
      if (err instanceof KVError) {
        this.log('error', `kv-client: ${op} failed`, {
          collection,
          key,
          code: err.code,
          status: err.status,
          body: err.responseBody?.slice(0, 200),
        });
        span?.fail(err);
        throw err;
      }
      const causeMessage = (err as Error).message;
      this.log('error', `kv-client: ${op} network error`, {
        collection,
        key,
        error: causeMessage,
      });
      const wrappedErr = new KVError({
        code: KV_ERROR_CODES.NETWORK,
        message: `KV ${op} network error: ${causeMessage}`,
        context: { op, collection, ...(key !== undefined ? { key } : {}) },
        remediation:
          'Check your network connection (DNS, VPN, captive portal). The Edison KV endpoint may be unreachable.',
        cause: err,
      });
      span?.fail(wrappedErr);
      throw wrappedErr;
    } finally {
      clearTimeout(timeout);
    }
  }
}

/**
 * Per-status remediation hint. Pulled out so the same advice surfaces
 * across set/get/listKeys/delete.
 */
function kvHttpRemediation(status: number): string {
  if (status === 401 || status === 403) {
    return 'The KV endpoint rejected the request as unauthorized. Verify the flow URL is correct and that the flow is enabled.';
  }
  if (status === 404) {
    return 'The KV endpoint URL is reachable but the path returned 404. Verify the configured URL matches the OneReach KV flow path.';
  }
  if (status === 429) {
    return 'The KV endpoint is rate-limiting requests. Wait a few seconds and try again.';
  }
  if (status >= 500) {
    return 'The KV endpoint returned a server error. This is usually transient -- retry in a few seconds.';
  }
  return 'Verify the request shape matches the OneReach KV API contract; see lite/kv/client.ts header for the schema.';
}

/** Default singleton. Lazy-initialized on first access. */
let _defaultClient: EdisonKVClient | null = null;

/** @internal -- module-internal accessor; consumers use `getKVApi()` from `./api.ts`. */
export function getDefaultKVClient(): EdisonKVClient {
  if (_defaultClient === null) {
    _defaultClient = new EdisonKVClient();
  }
  return _defaultClient;
}

/** @internal -- reset for tests. */
export function _resetDefaultKVClientForTesting(): void {
  _defaultClient = null;
}
