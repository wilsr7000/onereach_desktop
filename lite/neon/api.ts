/**
 * Neon module -- PUBLIC API.
 *
 * The only file other lite modules should import from in this module.
 * Per ADR-019 / Rule 11 in `lite/LITE-RULES.md`, cross-module imports
 * go through `<module>/api.ts` -- never reach into `client.ts`,
 * `credentials.ts`, or any other internal file.
 *
 * The Neon module provides Cypher access to a OneReach Neo4j (Neon)
 * Aura instance via the `/omnidata/neon` Edison flow. Phase N0 ships
 * a minimal surface (`query`, `ping`, `status`, `configure`,
 * `onEvent`); typed CRUD helpers and write-blocking land later as
 * separate ports per `lite/PORTING.md` "chunk: neon".
 *
 * **Security posture (Phase N0)**: credentials travel in the request
 * body. The endpoint is expected to harden later (bearer tokens or
 * mTLS); the `CredentialsProvider` abstraction in
 * `./credentials.ts` is the seam where the new wire format lands
 * without changing call sites. See `./README.md` "Hardening roadmap".
 *
 * Tests: `_setNeonApiForTesting(stub)` to inject a custom
 * implementation, `_resetNeonApiForTesting()` to clear the singleton.
 */

import { EdisonNeonClient } from './client.js';
import {
  BAKED_IN_DEFAULT_GRAPH,
  KVCredentialsProvider,
  type CredentialsProvider,
} from './credentials.js';
import { NeonError, NEON_ERROR_CODES } from './errors.js';
import { getLoggingApi } from '../logging/api.js';

// Re-export the public types consumers need to typecheck calls.
export type { NeonRecord, NeonNode, NeonRelationship, NeonValue, NeonStatus, NeonConfig } from './types.js';
export { NEON_MODULE_VERSION } from './types.js';

// Re-export the structured error class + code catalog so consumers
// catch and branch via the public surface, never reaching into
// internals.
export type { NeonErrorCode, NeonErrorOptions } from './errors.js';
export { NeonError, NEON_ERROR_CODES };

// Re-export the typed event surface (ADR-032).
export type {
  NeonEvent,
  NeonEventName,
  NeonQueryStartEvent,
  NeonQueryFinishEvent,
  NeonQueryFailEvent,
  NeonPingStartEvent,
  NeonPingFinishEvent,
  NeonPingFailEvent,
  NeonConfigureStartEvent,
  NeonConfigureFinishEvent,
  NeonConfigureFailEvent,
  NeonIpcQueryEvent,
  NeonIpcStatusEvent,
  NeonIpcTestConnectionEvent,
  NeonIpcConfigureEvent,
} from './events.js';
export { NEON_EVENTS, isNeonEvent } from './events.js';

// Generic base class -- consumers can also catch via `instanceof
// LiteError` if they want to handle errors uniformly across all lite
// modules.
export { LiteError, isLiteError } from '../errors.js';

import type { NeonRecord, NeonStatus, NeonConfig } from './types.js';
import type { NeonEvent } from './events.js';

/**
 * The public surface of the Neon module.
 *
 * **Error contract**: `query` and `ping` throw `NeonError` (extends
 * `LiteError`) on failure. Inspect `.code` to branch on
 * `NEON_NOT_CONFIGURED`, `NEON_TIMEOUT`, `NEON_HTTP`, `NEON_NETWORK`,
 * `NEON_QUERY`, or `NEON_BAD_INPUT`. `status()` and `onEvent()` do
 * not throw. `configure()` throws on KV write failure (passes through
 * the underlying `KVError`).
 *
 * **Renderer surface**: `query`, `status`, `testConnection` are
 * bridged to the renderer via `window.lite.neon.*`. `configure` is
 * intentionally NOT bridged -- credentials writes happen from the
 * Settings UI through a dedicated flow.
 */
export interface NeonApi {
  /**
   * Run a Cypher query against the configured Neon endpoint.
   *
   * @param cypher Non-empty Cypher string. Use bound parameters
   *   (`$name`) instead of string-concatenating user input.
   * @param parameters Bound-parameter map. Values are JSON-serialized
   *   on the wire.
   * @returns Records keyed by Cypher RETURN aliases. Node values are
   *   normalized to `{ id, labels, properties }`; relationship values
   *   to `{ id, type, start, end, properties }`.
   * @throws {NeonError} `NEON_NOT_CONFIGURED` when endpoint or
   *   credentials are missing.
   * @throws {NeonError} `NEON_TIMEOUT` if no response within timeout.
   * @throws {NeonError} `NEON_HTTP` for non-2xx server responses.
   * @throws {NeonError} `NEON_NETWORK` for fetch-level failures.
   * @throws {NeonError} `NEON_QUERY` when the server accepted the
   *   request but Cypher execution failed.
   * @throws {NeonError} `NEON_BAD_INPUT` for empty / non-string cypher.
   *
   * @example
   * ```typescript
   * const rows = await getNeonApi().query(
   *   'MATCH (p:Person {email: $email}) RETURN p LIMIT 1',
   *   { email: 'rich@example.com' }
   * );
   * ```
   */
  query(cypher: string, parameters?: Record<string, unknown>): Promise<NeonRecord[]>;

  /**
   * Cheap connectivity check. Runs `RETURN 1 AS ok` and returns
   * `true` on success. Throws `NeonError` on any failure (so the
   * caller can inspect `.code` for the actual reason).
   */
  ping(): Promise<boolean>;

  /**
   * Read the current Neon client status. Always returns a snapshot;
   * never throws. Includes `ready: true` only when endpoint, URI,
   * and password are all configured.
   */
  status(): Promise<NeonStatus>;

  /**
   * Persist a partial configuration update via the active credentials
   * provider. Fields omitted from `config` are left unchanged. Pass
   * `password: ''` to clear the password explicitly.
   *
   * **Main-process only.** This method is intentionally NOT bridged
   * to the renderer -- the Settings UI calls it via a dedicated
   * settings IPC, not via `window.lite.neon.configure`.
   *
   * @throws Underlying `KVError` if the persistence layer rejects.
   */
  configure(config: NeonConfig): Promise<void>;

  /**
   * Subscribe to typed Neon events (ADR-032). The handler receives
   * a discriminated union (`NeonEvent`) -- branch on `ev.name` for
   * type-narrowed access to `ev.data` / `ev.durationMs` / `ev.error`.
   *
   * Returns an unsubscribe function. Subscribers that throw are
   * isolated from other subscribers (see `LoggingApi.onEvent`).
   *
   * @example
   * ```typescript
   * const unsub = getNeonApi().onEvent((ev) => {
   *   switch (ev.name) {
   *     case 'neon.query.finish':
   *       metrics.timing('neon.query', ev.durationMs);
   *       break;
   *     case 'neon.query.fail':
   *       sentry.capture(ev.error);
   *       break;
   *   }
   * });
   * unsub();
   * ```
   */
  onEvent(handler: (event: NeonEvent) => void): () => void;
}

let _instance: NeonApi | null = null;
let _credentialsProvider: CredentialsProvider | null = null;

/**
 * Get the singleton Neon API. Lazily instantiates on first call with
 * a `KVCredentialsProvider` reading from KV collection
 * `lite-neon-config`, key `default`.
 *
 * To override (e.g. for tests with `StaticCredentialsProvider`), use
 * `_setNeonApiForTesting()` before the first call, or call
 * `_resetNeonApiForTesting()` and `_setNeonCredentialsProviderForTesting()`.
 */
export function getNeonApi(): NeonApi {
  if (_instance === null) {
    _instance = buildDefaultApi();
  }
  return _instance;
}

/** Reset the singleton (for tests). */
export function _resetNeonApiForTesting(): void {
  _instance = null;
  _credentialsProvider = null;
}

/**
 * Override the singleton with a custom implementation. Used by
 * tests to inject stubs.
 */
export function _setNeonApiForTesting(api: NeonApi): void {
  _instance = api;
}

/**
 * Override the credentials provider used when constructing the
 * default API. Must be called before the first `getNeonApi()` (or
 * after `_resetNeonApiForTesting()`).
 */
export function _setNeonCredentialsProviderForTesting(provider: CredentialsProvider): void {
  _credentialsProvider = provider;
}

// ─── default implementation ──────────────────────────────────────────────

function buildDefaultApi(): NeonApi {
  // Production singleton: pre-seed the OneReach default graph as the
  // fallback so fresh installs connect without any setup. Once the user
  // explicitly saves anything in Settings -> OAGI, the persisted KV
  // record wins. See `BAKED_IN_DEFAULT_GRAPH` for the temporary-status
  // notice and removal plan.
  const credentials =
    _credentialsProvider ??
    new KVCredentialsProvider({ fallbackRecord: { ...BAKED_IN_DEFAULT_GRAPH } });
  const client = new EdisonNeonClient({
    credentials,
    logger: (level, message, data) => {
      const log = getLoggingApi();
      log[level]('neon', message, data);
    },
    // ADR-030: every neon op (query/ping) emits start/finish/fail
    // through the central event log.
    spanEmitter: (name, data) => getLoggingApi().start(name, data),
  });

  return {
    query: (cypher, parameters) => client.query(cypher, parameters),
    ping: () => client.ping(),
    status: () => client.status(),
    onEvent: (handler) => client.onEvent(handler),
    configure: async (config: NeonConfig) => {
      const span = getLoggingApi().start('neon.configure', {
        fields: configFieldNames(config),
      });
      try {
        await credentials.write({
          ...(config.endpoint !== undefined ? { endpoint: config.endpoint } : {}),
          ...(config.uri !== undefined ? { uri: config.uri } : {}),
          ...(config.user !== undefined ? { user: config.user } : {}),
          ...(config.password !== undefined ? { password: config.password } : {}),
          ...(config.database !== undefined ? { database: config.database } : {}),
        });
        span.finish();
      } catch (err) {
        span.fail(err);
        throw err;
      }
    },
  };
}

function configFieldNames(config: NeonConfig): string[] {
  const fields: string[] = [];
  if (config.endpoint !== undefined) fields.push('endpoint');
  if (config.uri !== undefined) fields.push('uri');
  if (config.user !== undefined) fields.push('user');
  if (config.password !== undefined) fields.push('password');
  if (config.database !== undefined) fields.push('database');
  return fields;
}
