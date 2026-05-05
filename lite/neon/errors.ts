/**
 * Neon module errors -- structured errors thrown by the lite/neon
 * client.
 *
 * Mirrors the KV pattern: a single `NeonError` subclass of `LiteError`
 * carries a stable code, a human-readable message, structured context,
 * a remediation hint, and the original cause (when one exists).
 *
 * Codes are namespaced with the `NEON_` prefix per
 * `error-conformance.ts`. Add new codes here AND in the `events.ts`
 * fail-event variants if applicable; the conformance tests will catch
 * drift.
 */

import { LiteError } from '../errors.js';
import type { LiteErrorOptions } from '../errors.js';

/**
 * Stable error codes thrown by the Neon module. See
 * `lite/neon/README.md` "Error catalog" for full descriptions.
 */
export const NEON_ERROR_CODES = {
  /** No endpoint, URI, or password configured. The client refuses to send. */
  NOT_CONFIGURED: 'NEON_NOT_CONFIGURED',
  /** Request didn't return within the configured timeout. */
  TIMEOUT: 'NEON_TIMEOUT',
  /** Server returned non-2xx HTTP status. */
  HTTP: 'NEON_HTTP',
  /** Underlying fetch threw (DNS, TCP, TLS, abort-not-timeout). */
  NETWORK: 'NEON_NETWORK',
  /** Server accepted the request but the Cypher query itself failed. */
  QUERY: 'NEON_QUERY',
  /** Caller passed an empty / non-string Cypher. Safe-guard at the boundary. */
  BAD_INPUT: 'NEON_BAD_INPUT',
} as const;

export type NeonErrorCode = (typeof NEON_ERROR_CODES)[keyof typeof NEON_ERROR_CODES];

export interface NeonErrorOptions extends Omit<LiteErrorOptions, 'code'> {
  code: NeonErrorCode;
  /** HTTP status code, if the failure originated from a server response. */
  status?: number;
  /** First ~200 chars of the response body, for diagnostics. */
  responseBody?: string;
}

/**
 * Structured error from the Neon module. Always extends `LiteError`,
 * so consumers can catch with either `instanceof LiteError` (generic)
 * or `instanceof NeonError` (Neon-specific).
 *
 * Carries:
 *   - `.code` -- one of `NEON_ERROR_CODES`
 *   - `.context` -- `{ op, cypher (truncated), status?, body? }`
 *   - `.remediation` -- short, action-oriented hint
 *   - `.cause` -- the underlying Error (network, abort, etc.)
 *   - `.status` / `.responseBody` -- legacy convenience fields, mirror
 *     the values inside `.context`
 *
 * See `lite/neon/README.md` for the full error catalog.
 */
export class NeonError extends LiteError {
  public readonly status: number | undefined;
  public readonly responseBody: string | undefined;

  constructor(options: NeonErrorOptions) {
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
    this.name = 'NeonError';
    this.status = options.status;
    this.responseBody = options.responseBody;
  }
}

/**
 * Per-status remediation hint. Pulled out so the same advice surfaces
 * across query/ping/test paths.
 */
export function neonHttpRemediation(status: number): string {
  if (status === 401 || status === 403) {
    return 'The Neon endpoint rejected the request as unauthorized. Verify the Neon credentials in Settings -> Neon.';
  }
  if (status === 404) {
    return 'The Neon endpoint URL is reachable but the path returned 404. Verify the endpoint URL in Settings -> Neon.';
  }
  if (status === 429) {
    return 'The Neon endpoint is rate-limiting requests. Wait a few seconds and try again.';
  }
  if (status >= 500) {
    return 'The Neon endpoint returned a server error. This is usually transient -- retry in a few seconds.';
  }
  return 'Verify the request matches the OneReach /omnidata/neon contract; see lite/neon/README.md.';
}
