/**
 * Edison Neon flow client -- HTTP wrapper for the OneReach Neo4j
 * (Neon) Cypher proxy.
 *
 * Internal implementation. Other lite modules MUST NOT import this
 * file directly -- consume `getNeonApi()` from `./api.ts` (Rule 11 in
 * `lite/LITE-RULES.md`).
 *
 * Wire contract per the OneReach `/omnidata/neon` proxy:
 *
 *   POST  <endpoint>
 *   body: {
 *     cypher: string,
 *     parameters?: Record<string, unknown>,
 *     // basic-in-body credential variant (current default):
 *     neonUri: string,
 *     neonUser: string,
 *     neonPassword: string,
 *     database: string
 *   }
 *
 * Response shapes accepted (the proxy varies):
 *   { records: NeonRecord[] }
 *   { result: { records: NeonRecord[] } }
 *   { result: NeonRecord[] }
 *   raw NeonRecord[]
 *
 * Failures throw `NeonError`; callers decide whether to retry, fall
 * back, or surface to the user.
 *
 * Forward-security: credentials come from a `CredentialsProvider`
 * (see `./credentials.ts`). Today the provider returns
 * `{ kind: 'basic-in-body', ... }` and we embed the fields in the
 * body. When the endpoint hardens (bearer / OAuth2 / mTLS), a new
 * provider variant ships and `buildRequest()` adds a switch case --
 * call sites stay unchanged.
 *
 * @internal
 */

import type { Span, EventRecord } from '../logging/events.js';
import { getLoggingApi } from '../logging/api.js';
import { isNeonEvent, type NeonEvent } from './events.js';
import {
  NeonError,
  NEON_ERROR_CODES,
  neonHttpRemediation,
  type NeonErrorCode,
} from './errors.js';
import type { NeonRecord, NeonStatus, NeonValue } from './types.js';
import type { CredentialsProvider, NeonCredentials } from './credentials.js';

const DEFAULT_TIMEOUT_MS = 30_000;

export interface NeonClientConfig {
  /** Required: where to read credentials + endpoint from. */
  credentials: CredentialsProvider;
  /** Per-request timeout in milliseconds. Default 30000. */
  timeoutMs?: number;
  /** Optional fetch implementation override (for tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Optional logger -- structured events for diagnostics. */
  logger?: (level: 'info' | 'warn' | 'error', message: string, data?: unknown) => void;
  /**
   * Optional span emitter -- when provided, every operation
   * (`query` / `ping` / `configure`) wraps its work in a
   * `neon.<op>.start` / `.finish` / `.fail` span. ADR-030.
   * The default config in `neon/api.ts` wires this to
   * `getLoggingApi().start()`.
   */
  spanEmitter?: (name: string, data?: unknown) => Span;
}

/**
 * The HTTP client used by `NeonApi`. Internal -- consumers go through
 * `getNeonApi()` in `./api.ts`.
 */
export class EdisonNeonClient {
  private readonly credentials: CredentialsProvider;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly log: NonNullable<NeonClientConfig['logger']>;
  private readonly spanEmitter: NonNullable<NeonClientConfig['spanEmitter']> | null;

  constructor(config: NeonClientConfig) {
    this.credentials = config.credentials;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.log =
      config.logger ??
      ((): void => {
        /* default: silent */
      });
    this.spanEmitter = config.spanEmitter ?? null;
  }

  /**
   * Execute a Cypher query. Returns the records normalized to plain
   * objects keyed by RETURN aliases.
   */
  async query(cypher: string, parameters: Record<string, unknown> = {}): Promise<NeonRecord[]> {
    if (typeof cypher !== 'string' || cypher.trim().length === 0) {
      throw new NeonError({
        code: NEON_ERROR_CODES.BAD_INPUT,
        message: 'cypher must be a non-empty string',
        context: { op: 'query' },
        remediation: 'Pass a non-empty Cypher string to neon.query().',
      });
    }
    const truncated = cypher.length > 200 ? cypher.slice(0, 200) : cypher;
    const span = this.spanEmitter?.('neon.query', {
      cypher: truncated,
      paramCount: Object.keys(parameters).length,
    });
    try {
      const records = await this.runQuery('query', cypher, parameters);
      span?.finish({ recordCount: records.length });
      this.log('info', 'neon-client: query ok', {
        recordCount: records.length,
        cypherPreview: truncated,
      });
      return records;
    } catch (err) {
      span?.fail(err);
      throw err;
    }
  }

  /**
   * Cheap connectivity check. Runs `RETURN 1 AS ok` and asserts a
   * single record came back.
   */
  async ping(): Promise<boolean> {
    const span = this.spanEmitter?.('neon.ping');
    try {
      const records = await this.runQuery('ping', 'RETURN 1 AS ok', {});
      const first = records[0] as { ok?: NeonValue } | undefined;
      const ok = first !== undefined && first.ok === 1;
      span?.finish({ ok });
      return ok;
    } catch (err) {
      span?.fail(err);
      throw err;
    }
  }

  /** Read the public status (no secrets). */
  async status(): Promise<NeonStatus> {
    const pub = await this.credentials.readPublic();
    if (pub === null) {
      return {
        endpoint: null,
        uri: null,
        user: 'neo4j',
        database: 'neo4j',
        hasPassword: false,
        ready: false,
      };
    }
    return {
      endpoint: pub.endpoint.length > 0 ? pub.endpoint : null,
      uri: pub.uri.length > 0 ? pub.uri : null,
      user: pub.user,
      database: pub.database,
      hasPassword: pub.hasPassword,
      ready: pub.endpoint.length > 0 && pub.uri.length > 0 && pub.hasPassword,
    };
  }

  /**
   * Subscribe to typed Neon events (ADR-032).
   */
  onEvent(handler: (event: NeonEvent) => void): () => void {
    return getLoggingApi().onEvent('neon.*', (ev: EventRecord) => {
      if (isNeonEvent(ev)) {
        handler(ev as unknown as NeonEvent);
      }
    });
  }

  // ─── internals ───────────────────────────────────────────────────────────

  /**
   * The shared transport: resolve creds + endpoint, build the
   * request, run fetch with timeout/abort, normalize records, raise
   * the right `NeonError` on failures. Span emission is the caller's
   * job (so query/ping can attach different metadata).
   */
  private async runQuery(
    op: string,
    cypher: string,
    parameters: Record<string, unknown>
  ): Promise<NeonRecord[]> {
    const [endpoint, creds] = await this.resolveConfig(op, cypher);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const { url, init } = buildRequest(endpoint, creds, cypher, parameters, controller.signal);
      let res: Response;
      try {
        res = await this.fetchImpl(url, init);
      } catch (err) {
        if ((err as Error).name === 'AbortError') {
          throw this.buildTimeoutError(op, cypher);
        }
        throw new NeonError({
          code: NEON_ERROR_CODES.NETWORK,
          message: `Neon ${op} network error: ${(err as Error).message}`,
          context: { op, cypher: cypher.slice(0, 200) },
          remediation:
            'Check your network connection (DNS, VPN, captive portal). The Neon endpoint may be unreachable.',
          cause: err,
        });
      }

      if (!res.ok) {
        const body = await safeText(res);
        // 401 from a future bearer flow: invalidate cached creds so
        // the next request re-resolves. Today's basic-in-body flow
        // doesn't cache, so this is a no-op but cheap.
        if (res.status === 401 && this.credentials.invalidate !== undefined) {
          this.credentials.invalidate();
        }
        throw new NeonError({
          code: NEON_ERROR_CODES.HTTP,
          message: `Neon ${op} failed: HTTP ${res.status} from ${endpoint}`,
          status: res.status,
          responseBody: body,
          context: { op, cypher: cypher.slice(0, 200) },
          remediation: neonHttpRemediation(res.status),
        });
      }

      const body = await safeText(res);
      if (body.trim().length === 0) return [];

      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch (err) {
        throw new NeonError({
          code: NEON_ERROR_CODES.HTTP,
          message: `Neon ${op} response was not JSON`,
          status: res.status,
          responseBody: body,
          context: { op, cypher: cypher.slice(0, 200) },
          remediation: 'The Neon proxy returned a non-JSON body. Check the endpoint URL.',
          cause: err,
        });
      }

      // Server-side error in the JSON body (the flow may return 200
      // with an `error` field for Cypher-side failures).
      if (parsed !== null && typeof parsed === 'object' && 'error' in parsed) {
        const errMsg = String((parsed as { error: unknown }).error);
        throw new NeonError({
          code: NEON_ERROR_CODES.QUERY,
          message: `Neon ${op} returned error: ${errMsg}`,
          status: res.status,
          responseBody: body,
          context: { op, cypher: cypher.slice(0, 200) },
          remediation: 'Inspect the Cypher and parameters; the server rejected the query.',
        });
      }

      return extractRecords(parsed);
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Read endpoint + creds from the provider; raise NEON_NOT_CONFIGURED if either missing. */
  private async resolveConfig(
    op: string,
    cypher: string
  ): Promise<readonly [string, NeonCredentials]> {
    const endpoint = await this.credentials.getEndpoint();
    const creds = await this.credentials.get();
    if (endpoint === null) {
      throw this.buildNotConfiguredError(op, cypher, 'endpoint URL');
    }
    if (creds === null) {
      throw this.buildNotConfiguredError(op, cypher, 'credentials');
    }
    return [endpoint, creds] as const;
  }

  private buildNotConfiguredError(op: string, cypher: string, missing: string): NeonError {
    return new NeonError({
      code: NEON_ERROR_CODES.NOT_CONFIGURED,
      message: `Neon ${op} blocked: missing ${missing}`,
      context: { op, cypher: cypher.slice(0, 200), missing },
      remediation: 'Open Settings -> Neon and fill in the endpoint URL, URI, and password.',
    });
  }

  private buildTimeoutError(op: string, cypher: string): NeonError {
    return new NeonError({
      code: NEON_ERROR_CODES.TIMEOUT,
      message: `Neon ${op} timed out after ${this.timeoutMs}ms`,
      context: { op, cypher: cypher.slice(0, 200), timeoutMs: this.timeoutMs },
      remediation:
        'Check your network connection. If you are on a slow link, the operation may need a longer timeout.',
    });
  }
}

// ─── helpers (module-private, exported for tests) ─────────────────────────

/**
 * Build the outgoing HTTP request based on the credentials variant.
 * This is the forward-security switch -- adding a new credential
 * `kind` means adding a new case here, with no other code changes.
 */
export function buildRequest(
  endpoint: string,
  creds: NeonCredentials,
  cypher: string,
  parameters: Record<string, unknown>,
  signal: AbortSignal
): { url: string; init: RequestInit } {
  switch (creds.kind) {
    case 'basic-in-body': {
      return {
        url: endpoint,
        init: {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            cypher,
            parameters,
            neonUri: creds.uri,
            neonUser: creds.user,
            neonPassword: creds.password,
            database: creds.database,
          }),
          signal,
        },
      };
    }
    case 'bearer': {
      // Reserved for the post-hardening world. Documented so callers
      // see the path forward; not exercised by N0.
      return {
        url: endpoint,
        init: {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${creds.token}`,
          },
          body: JSON.stringify({
            cypher,
            parameters,
            database: creds.database,
          }),
          signal,
        },
      };
    }
    default: {
      // Exhaustiveness guard for adding new variants without a case.
      const _exhaustive: never = creds;
      throw new Error(`Unhandled credentials kind: ${String(_exhaustive)}`);
    }
  }
}

/**
 * Extract records from any of the response shapes the proxy may
 * return. Returns `[]` when the parsed body has no records (the
 * caller's responsibility to detect "no rows" vs error).
 */
export function extractRecords(parsed: unknown): NeonRecord[] {
  if (Array.isArray(parsed)) return parsed.map(toRecord);
  if (parsed === null || typeof parsed !== 'object') return [];
  const obj = parsed as { records?: unknown; result?: unknown };
  if (Array.isArray(obj.records)) return obj.records.map(toRecord);
  if (obj.result !== undefined) {
    if (Array.isArray(obj.result)) return obj.result.map(toRecord);
    if (typeof obj.result === 'object' && obj.result !== null) {
      const rec = (obj.result as { records?: unknown }).records;
      if (Array.isArray(rec)) return rec.map(toRecord);
    }
  }
  return [];
}

function toRecord(value: unknown): NeonRecord {
  if (value === null || typeof value !== 'object') return {};
  return value as NeonRecord;
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

/** Re-export error code type for other internal modules. */
export type { NeonErrorCode };
