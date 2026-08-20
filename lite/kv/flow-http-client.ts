/**
 * Login-token KV transport.
 *
 * Lite's KV rides the shared org KV flow endpoint
 *
 *   https://em.edison.api.onereach.ai/http/{SHARED_KV_ACCOUNT_ID}/keyvalue2
 *
 * authenticated with the signed-in user's login token
 * (`Authorization: Bearer <mult>` -- the same token
 * `getAuthApi().getToken(env)` serves everywhere else).
 *
 * HISTORY (2026-08-20, per platform owner): this client previously
 * minted a per-account FLOW token from a public per-account
 * `/refresh_token` flow and talked to `/http/{signed-in-account}/keyvalue2`.
 * That made TWO per-account flow deployments an onboarding requirement,
 * and any teammate whose default GSX account lacked them hit
 * "Sign-in succeeded but the session could not be saved: KV
 * refresh_token failed: HTTP 404" at first sign-in (live incident:
 * rich@onereach.com, account dd96413e). The platform now accepts the
 * login token directly, so the refresh_token flow is retired and the
 * KV URL no longer varies by who signed in. Verified live 2026-08-20:
 * refresh_token 404s on non-org accounts while the org keyvalue2
 * answers -- exactly the old failure and the new path.
 *
 * Wire format (unchanged across the auth migration):
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
import { reportServiceDown, reportServiceUp } from '../health/api.js';
import { getLoggingApi } from '../logging/api.js';
import { KVError, KV_ERROR_CODES, type KVRecord } from './client.js';
import { isAuthRejectedMessage } from './sdk-client.js';
import { isKvEvent, type KvEvent } from './events.js';

/**
 * The org account whose `keyvalue2` flow serves ALL of Lite's KV. One
 * fixed endpoint for every user -- per-user scoping is by login token
 * and per-user keys, never by URL. Same org plumbing as
 * `BAKED_IN_DEFAULT_GRAPH` in lite/neon/credentials.ts (kv must not
 * import neon -- dep direction), and covered by the same pre-public
 * blocker: multi-tenant builds must not bake this in.
 */
export const SHARED_KV_ACCOUNT_ID = '35254342-4a2e-475b-aec1-18547e517e29';

/**
 * Configuration for {@link FlowHttpKVClient}.
 */
export interface FlowHttpKVClientConfig {
  /**
   * Login-token resolver (`KVAuthBindings.getToken`): the raw `mult`
   * value, or '' when signed out. Sent as `Authorization: Bearer <v>`.
   */
  token: () => string;
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
}

const DEFAULT_BASE_URL = 'https://em.edison.api.onereach.ai';

/**
 * KV client that talks the full app's `/http/{accountId}/keyvalue2`
 * protocol. Public surface mirrors `KVApi`; consumers go through
 * `getKVApi()` from `./api.ts`.
 *
 * @internal
 */
export class FlowHttpKVClient {
  private readonly getToken: FlowHttpKVClientConfig['token'];
  private readonly fetchImpl: typeof fetch;
  private readonly log: NonNullable<FlowHttpKVClientConfig['logger']>;
  private readonly spanEmitter: NonNullable<FlowHttpKVClientConfig['spanEmitter']> | null;
  private readonly onAuthRejected: NonNullable<FlowHttpKVClientConfig['onAuthRejected']> | null;
  private readonly baseUrl: string;

  constructor(config: FlowHttpKVClientConfig) {
    this.getToken = config.token;
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.log =
      config.logger ??
      ((): void => {
        /* default: silent */
      });
    this.spanEmitter = config.spanEmitter ?? null;
    this.onAuthRejected = config.onAuthRejected ?? null;
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
  }

  // ─── public surface (KVApi) ───────────────────────────────────────────

  async set(collection: string, key: string, value: unknown): Promise<void> {
    return this.runRequest('set', collection, key, async () => {
      const auth = this.requireAuthHeader();
      const url =
        `${this.kvUrl()}?id=${encodeURIComponent(collection)}&key=${encodeURIComponent(key)}`;
      // The Edison flow KV stores the value under `itemValue`, as a JSON
      // STRING -- confirmed by the live PUT response (which echoes
      // `itemValue`) AND the in-memory contract server the integration
      // tests run against. Earlier builds sent the value under `value`,
      // which the flow IGNORES: every blob silently round-tripped to the
      // literal string "undefined", so the IDW menu / tabs / tools list
      // were wiped on every relaunch (the read-side self-heal then
      // overwrote them with an empty list). We also send `n` (the field
      // the legacy EdisonKVClient documents) so we're robust to whichever
      // field a given account's flow version reads. The read path unwraps
      // the string back to an object (parseKvBody -> unwrapJsonString).
      const encoded = JSON.stringify(value);
      const body = JSON.stringify({ id: collection, key, itemValue: encoded, n: encoded });
      const resp = await this.fetchImpl(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: auth },
        body,
      });
      await this.assertOk(resp, 'set', collection, key);
    });
  }

  async get(collection: string, key: string): Promise<unknown | null> {
    return this.runRequest('get', collection, key, async () => {
      const auth = this.requireAuthHeader();
      const url =
        `${this.kvUrl()}?id=${encodeURIComponent(collection)}&key=${encodeURIComponent(key)}`;
      const resp = await this.fetchImpl(url, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json', Authorization: auth },
      });
      // 404 -> null (mirrors the SDK and the EdisonKVClient behavior).
      if (resp.status === 404) return null;
      await this.assertOk(resp, 'get', collection, key);
      const text = await resp.text();
      if (text === '' || text === 'null' || text === '""') return null;
      return parseKvBody(text);
    });
  }

  async listKeys(collection: string): Promise<string[]> {
    return this.runRequest('listKeys', collection, undefined, async () => {
      const auth = this.requireAuthHeader();
      const resp = await this.fetchImpl(this.kvUrl(), {
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
      const auth = this.requireAuthHeader();
      const url =
        `${this.kvUrl()}?id=${encodeURIComponent(collection)}&key=${encodeURIComponent(key)}`;
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

  // ─── internals ────────────────────────────────────────────────────────

  /** The shared org KV endpoint. One URL for every signed-in user. */
  private kvUrl(): string {
    return `${this.baseUrl}/http/${SHARED_KV_ACCOUNT_ID}/keyvalue2`;
  }

  /**
   * `Authorization: Bearer <login token>` from the auth bindings, or a
   * thrown signed-out error. The token is captured at sign-in and
   * lives in the auth store ("login settings") -- no refresh_token
   * flow, no cache, no per-account minting. When auth rotates the
   * token, the next call simply reads the new value.
   */
  private requireAuthHeader(): string {
    const token = this.getToken();
    if (typeof token !== 'string' || token.length === 0) {
      const err = new KVError({
        code: KV_ERROR_CODES.HTTP,
        message: 'KV requires a signed-in OneReach account.',
        status: 401,
        context: { reason: 'signed-out' },
        remediation: 'Sign in to OneReach (Settings -> Account) and try again.',
      });
      this.notifyAuthRejected(err.message);
      throw err;
    }
    return `Bearer ${token}`;
  }

  // ── Circuit breaker (2026-08-14) ──────────────────────────────────
  // The 08-12 incident: the KV backend 500'd and EVERY caller kept
  // hammering it full-speed (each graph query re-read config), turning
  // one server blip into a 90 MB/6s log storm and a hung sign-in.
  // After 5 consecutive server-side failures (5xx / timeout / network),
  // the breaker opens for 15s: requests fail fast WITHOUT touching the
  // network, one warn line marks each transition, and a single probe
  // is allowed through when the cooldown lapses.
  private breakerConsecutive = 0;
  private breakerOpenUntil = 0;

  private static readonly BREAKER_THRESHOLD = 5;
  private static readonly BREAKER_COOLDOWN_MS = 15_000;

  /** Server-side failure = the backend's fault, counts toward the breaker. */
  private static isBreakerCounted(err: KVError): boolean {
    if (typeof err.status === 'number' && err.status >= 500) return true;
    return err.code === KV_ERROR_CODES.TIMEOUT || err.code === KV_ERROR_CODES.NETWORK;
  }

  private async runRequest<T>(
    op: string,
    collection: string,
    key: string | undefined,
    fn: () => Promise<T>
  ): Promise<T> {
    const now = Date.now();
    if (now < this.breakerOpenUntil) {
      // Fail fast, no network, no error-level log (the dedupe upstream
      // would collapse it anyway; one warn marked the transition).
      throw new KVError({
        code: KV_ERROR_CODES.HTTP,
        message: `KV circuit open — failing fast (${op} ${collection})`,
        status: 503,
        context: { op, collection, ...(key !== undefined ? { key } : {}), breakerOpen: true },
        remediation:
          'OneReach KV had repeated server errors; requests resume automatically within 15s.',
      });
    }
    const span = this.spanEmitter?.(`kv.${op}`, {
      collection,
      ...(key !== undefined ? { key } : {}),
    });
    try {
      const result = await fn();
      if (this.breakerConsecutive > 0) {
        reportServiceUp('onereach');
        this.log('info', 'kv-flow: backend recovered — breaker reset', {
          afterFailures: this.breakerConsecutive,
        });
      }
      this.breakerConsecutive = 0;
      this.log('info', `kv-flow: ${op} ok`, { collection, key });
      span?.finish();
      return result;
    } catch (err) {
      const wrapped = this.normalizeError(err, op, collection, key);
      if (FlowHttpKVClient.isBreakerCounted(wrapped)) {
        this.breakerConsecutive += 1;
        if (this.breakerConsecutive >= FlowHttpKVClient.BREAKER_THRESHOLD) {
          this.breakerOpenUntil = Date.now() + FlowHttpKVClient.BREAKER_COOLDOWN_MS;
          // Half-open: one more counted failure after the cooldown
          // reopens immediately.
          this.breakerConsecutive = FlowHttpKVClient.BREAKER_THRESHOLD - 1;
          reportServiceDown('onereach', 'OneReach is returning server errors');
          this.log('warn', 'kv-flow: circuit OPENED — repeated KV server errors; failing fast 15s', {
            op,
            collection,
            status: wrapped.status,
          });
        }
      } else {
        this.breakerConsecutive = 0;
      }
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
      // The login token was rejected. There is no client-side cache to
      // drop anymore -- recovery is a fresh sign-in, and the
      // auth-rejection hook routes the kernel to exactly that prompt.
      const reason = body !== undefined && body.length > 0 ? body : `HTTP ${resp.status}`;
      this.notifyAuthRejected(reason);
    } else if (isAuthRejectedMessage(body ?? '')) {
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

/**
 * Parse a non-empty KV response body into the stored value. Tolerant of
 * the flow's several response shapes:
 *   { Status: 'No data found.' }     -> null
 *   { value: ... } | { get: { value } } | { data: { value } }
 *   <object|array at top level>
 * AND of multi-level JSON-string encoding — the value (or the whole
 * body) can come back as a JSON-stringified blob, e.g. after the
 * sign-in KV migration double-encodes it. Without unwrapping, callers
 * get a raw string and object-shaped stores (tabs, IDW menu, tools)
 * treat their blob as corrupt and reset to empty on every boot.
 */
function parseKvBody(text: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text; // body wasn't JSON -- return the raw string
  }
  if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>;
    if (obj['Status'] === 'No data found.' || obj['status'] === 'No data found.') {
      return null;
    }
    const inner =
      (obj['get'] as { value?: unknown } | undefined)?.value ??
      obj['value'] ??
      (obj['data'] as { value?: unknown } | undefined)?.value;
    if (inner !== undefined) return unwrapJsonString(inner);
    return parsed; // raw object stored at the top level
  }
  // Top-level string / array / primitive. A string may be an encoded blob.
  return unwrapJsonString(parsed);
}

/**
 * If `value` is a JSON-encoded string of an object/array (possibly
 * several encoding layers deep), unwrap it to the underlying value. A
 * legitimate plain-string value (e.g. "hello") is returned unchanged —
 * only strings that look like JSON (`{`, `[`, or a quoted string) are
 * unwrapped, and a bare number/boolean is never coerced.
 */
function unwrapJsonString(value: unknown): unknown {
  let cur = value;
  for (let depth = 0; depth < 5 && typeof cur === 'string'; depth++) {
    const trimmed = cur.trim();
    if (trimmed.length === 0 || !/^[[{"]/.test(trimmed)) break;
    let next: unknown;
    try {
      next = JSON.parse(cur);
    } catch {
      break;
    }
    if (typeof next === 'string') {
      cur = next; // another encoding layer -- keep unwrapping
      continue;
    }
    return next; // object / array / number / boolean / null
  }
  return cur;
}
