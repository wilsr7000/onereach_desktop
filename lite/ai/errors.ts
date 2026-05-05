/**
 * Lite AI module errors.
 *
 * Codes namespaced with the `AI_` prefix per the
 * `error-conformance.ts` rule.
 */

import { LiteError } from '../errors.js';
import type { LiteErrorOptions } from '../errors.js';

export const AI_ERROR_CODES = {
  /** No API key configured. User must set one in Settings -> AI. */
  NOT_CONFIGURED: 'AI_NOT_CONFIGURED',
  /** OpenAI returned 429. Caller should back off + retry. */
  RATE_LIMITED: 'AI_RATE_LIMITED',
  /** OpenAI returned a non-2xx, non-429 status. */
  HTTP: 'AI_HTTP',
  /** Network-level failure (DNS, TCP, TLS). */
  NETWORK: 'AI_NETWORK',
  /** Request exceeded the per-call timeout budget. */
  TIMEOUT: 'AI_TIMEOUT',
  /** Caller passed malformed input (empty text, bad voice, etc.). */
  BAD_INPUT: 'AI_BAD_INPUT',
} as const;

export type AiErrorCode = (typeof AI_ERROR_CODES)[keyof typeof AI_ERROR_CODES];

export interface AiErrorOptions extends Omit<LiteErrorOptions, 'code'> {
  code: AiErrorCode;
  /** HTTP status code, when the error was an HTTP response. */
  status?: number;
  /** Truncated response body, for diagnostics. */
  responseBody?: string;
}

/**
 * Structured error from the Lite AI module. Always extends
 * `LiteError`, so consumers can catch with either
 * `instanceof LiteError` (generic) or `instanceof AiError`.
 */
export class AiError extends LiteError {
  public readonly status: number | undefined;
  public readonly responseBody: string | undefined;

  constructor(options: AiErrorOptions) {
    const baseOptions: LiteErrorOptions = {
      code: options.code,
      message: options.message,
      ...(options.context !== undefined ? { context: options.context } : {}),
      ...(options.remediation !== undefined ? { remediation: options.remediation } : {}),
      ...(options.cause !== undefined ? { cause: options.cause } : {}),
    };
    super(baseOptions);
    this.name = 'AiError';
    this.status = options.status;
    this.responseBody = options.responseBody;
  }
}
