/**
 * KV module -- PUBLIC API.
 *
 * This is the only file other lite modules should import from in this
 * module. Per ADR-019 and ADR-020 (and Rule 11 in lite/LITE-RULES.md),
 * cross-module imports go through `<module>/api.ts` -- never reach into
 * `client.ts` or any other internal file.
 *
 * Usage from a consumer module:
 *
 *   import { getKVApi, KVError } from '../kv/api.js';
 *   const kv = getKVApi();
 *   await kv.set('my-collection', 'key-1', { foo: 'bar' });
 *   const value = await kv.get('my-collection', 'key-1');
 *
 * Collection names are the consumer's responsibility -- the KV module
 * has no opinion on naming or schema. (E.g. bug-report uses
 * `lite-bugs`; future settings module would use its own.)
 *
 * Tests: `_setKVApiForTesting(stub)` to inject a custom implementation,
 * `_resetKVApiForTesting()` to clear the singleton.
 */

import { EdisonKVClient } from './client.js';
import type { KVConfig, KVRecord } from './client.js';
import { getLoggingApi } from '../logging/api.js';
import type { KvEvent } from './events.js';

// Re-export the types, error class, and error codes consumers need to
// typecheck calls and catch failures. Keeps callers from having to know
// about client.ts.
export type { KVConfig, KVRecord, KVErrorCode, KVErrorOptions } from './client.js';
export { KVError, KV_ERROR_CODES } from './client.js';
// Per-module typed event surface (ADR-032). Consumers branch on
// `ev.name` for type-narrowed access to `ev.data`.
export {
  KV_EVENTS,
  isKvEvent,
  type KvEvent,
  type KvEventName,
  type KvSetStartEvent,
  type KvSetFinishEvent,
  type KvSetFailEvent,
  type KvGetStartEvent,
  type KvGetFinishEvent,
  type KvGetFailEvent,
  type KvListKeysStartEvent,
  type KvListKeysFinishEvent,
  type KvListKeysFailEvent,
  type KvListStartEvent,
  type KvListFinishEvent,
  type KvListFailEvent,
  type KvDeleteStartEvent,
  type KvDeleteFinishEvent,
  type KvDeleteFailEvent,
} from './events.js';
// Generic base class -- consumers can also catch via `instanceof LiteError`
// if they want to handle errors uniformly across all lite modules.
export { LiteError, isLiteError } from '../errors.js';

/**
 * The public surface of the KV module. Mirrors the underlying Edison
 * key-value HTTP API.
 *
 * **Error contract**: every method throws `KVError` (which extends
 * `LiteError`) on network or server failures. Inspect `.code` for
 * branching (`KV_TIMEOUT`, `KV_HTTP`, `KV_NETWORK`), `.context` for
 * diagnostic fields, `.remediation` for a user-facing hint. See
 * `lite/kv/README.md` for the full error catalog.
 *
 * **Collection naming**: collections are unscoped strings; the consumer
 * picks the namespace (e.g. bug-report uses `lite-bugs`). The KV module
 * does not enforce naming conventions.
 *
 * **Serialization**: values are JSON-encoded on the wire. Anything that
 * survives `JSON.stringify` round-trips correctly; functions, undefined,
 * Maps, Dates-as-Date-objects, etc. do not.
 */
export interface KVApi {
  /**
   * Set (upsert) a record. Idempotent: writing the same key twice
   * overwrites silently.
   *
   * @param collection Logical namespace; consumers pick (e.g. `lite-bugs`).
   * @param key Unique within the collection.
   * @param value Anything `JSON.stringify`-able.
   * @returns Resolves when the server confirms the write.
   * @throws {KVError} `KV_TIMEOUT` if no response within configured timeout.
   * @throws {KVError} `KV_HTTP` if the server returned a non-2xx status.
   * @throws {KVError} `KV_NETWORK` if `fetch` itself rejected (DNS/TLS/etc).
   *
   * @example
   * ```typescript
   * import { getKVApi, KVError } from '../kv/api.js';
   * try {
   *   await getKVApi().set('settings', 'theme', { mode: 'dark' });
   * } catch (err) {
   *   if (err instanceof KVError && err.code === 'KV_TIMEOUT') retry();
   *   else throw err;
   * }
   * ```
   */
  set(collection: string, key: string, value: unknown): Promise<void>;

  /**
   * Get a single record by key.
   *
   * @param collection The collection that holds the key.
   * @param key The key to look up.
   * @returns The deserialized value, or `null` if the key is absent.
   *   `null` is also returned for the upstream "No data found" sentinel,
   *   so callers don't need to handle two not-found shapes.
   * @throws {KVError} `KV_TIMEOUT` | `KV_HTTP` | `KV_NETWORK`. Note:
   *   missing-key is NOT an error -- it returns `null`.
   *
   * @example
   * ```typescript
   * const settings = await getKVApi().get('settings', 'theme');
   * if (settings === null) {
   *   // First-run -- write defaults.
   * }
   * ```
   */
  get(collection: string, key: string): Promise<unknown | null>;

  /**
   * List all keys in a collection. Values are not fetched; use
   * {@link KVApi.list} or follow up with `get()` per key.
   *
   * @param collection The collection to enumerate.
   * @returns Array of keys (order is not guaranteed). Empty array if
   *   the collection is empty or has never been written.
   * @throws {KVError} `KV_TIMEOUT` | `KV_HTTP` | `KV_NETWORK`.
   *
   * @example
   * ```typescript
   * const keys = await getKVApi().listKeys('settings');
   * // ['theme', 'language', ...]
   * ```
   */
  listKeys(collection: string): Promise<string[]>;

  /**
   * List keys + fetch each value in parallel. Convenience for callers
   * that want the full set in one call.
   *
   * **Cost**: 1 `listKeys` + N `get` requests in parallel. For large
   * collections, prefer `listKeys()` + per-key `get()` with your own
   * batching.
   *
   * **Partial-failure behavior**: per-key `get()` failures are logged
   * and skipped, so a partial fetch still returns useful data. The top
   * `list()` call only throws if `listKeys()` itself fails.
   *
   * @param collection The collection to enumerate.
   * @returns Array of `{ key, value }` records. Skips records whose
   *   per-key `get()` failed.
   * @throws {KVError} `KV_TIMEOUT` | `KV_HTTP` | `KV_NETWORK` from the
   *   underlying `listKeys()` call.
   *
   * @example
   * ```typescript
   * const records = await getKVApi().list('lite-bugs');
   * for (const { key, value } of records) {
   *   console.log(key, value);
   * }
   * ```
   */
  list(collection: string): Promise<KVRecord[]>;

  /**
   * Delete a record. The upstream flow's DELETE may time out but
   * typically succeeds; treat timeouts as advisory.
   *
   * @param collection The collection holding the record.
   * @param key The key to delete.
   * @returns Resolves once the server confirms the delete.
   * @throws {KVError} `KV_TIMEOUT` | `KV_HTTP` | `KV_NETWORK`.
   *
   * @example
   * ```typescript
   * await getKVApi().delete('settings', 'theme');
   * ```
   */
  delete(collection: string, key: string): Promise<void>;

  /**
   * Subscribe to typed KV events (ADR-032). The handler receives a
   * discriminated union (`KvEvent`) -- branch on `ev.name` for
   * type-narrowed access to `ev.data` / `ev.durationMs` / `ev.error`.
   *
   * Returns an unsubscribe function. Subscribing N times produces N
   * handlers; unsubscribe each independently. Subscribers that throw
   * are isolated from other subscribers (see `LoggingApi.onEvent`).
   *
   * @example
   * ```typescript
   * const unsub = getKVApi().onEvent((ev) => {
   *   switch (ev.name) {
   *     case 'kv.set.finish':
   *       metrics.timing('kv.set', ev.durationMs);
   *       break;
   *     case 'kv.set.fail':
   *       sentry.capture(ev.data.error);
   *       break;
   *   }
   * });
   * // ... later
   * unsub();
   * ```
   */
  onEvent(handler: (event: KvEvent) => void): () => void;
}

let _instance: KVApi | null = null;

/**
 * Get the singleton KV API. Lazily instantiates on first call.
 *
 * Default backing implementation is `EdisonKVClient` with default config
 * (URL, timeouts). To override (e.g. for tests, or to pass a custom
 * fetch implementation), use `_setKVApiForTesting()` before the first
 * call, or call `_resetKVApiForTesting()` to clear and re-init.
 *
 * @returns The shared `KVApi` instance.
 *
 * @example
 * ```typescript
 * import { getKVApi } from '../kv/api.js';
 * const kv = getKVApi();
 * await kv.set('settings', 'theme', 'dark');
 * ```
 */
export function getKVApi(): KVApi {
  if (_instance === null) {
    _instance = new EdisonKVClient(defaultConfig());
  }
  return _instance;
}

/** Reset the singleton (for tests). */
export function _resetKVApiForTesting(): void {
  _instance = null;
}

/**
 * Override the singleton with a custom implementation (for tests). The
 * provided value is returned by subsequent `getKVApi()` calls until
 * reset.
 */
export function _setKVApiForTesting(api: KVApi): void {
  _instance = api;
}

/**
 * Default client config -- console logger keyed to the [kv] tag so
 * consumers see KV activity without each having to wire its own logger.
 */
function defaultConfig(): KVConfig {
  return {
    logger: (level, message, data) => {
      const log = getLoggingApi();
      log[level]('kv', message, data);
    },
    // ADR-030: every kv op (set/get/listKeys/list/delete) emits a
    // start/finish/fail span through the central event log.
    spanEmitter: (name, data) => getLoggingApi().start(name, data),
  };
}
