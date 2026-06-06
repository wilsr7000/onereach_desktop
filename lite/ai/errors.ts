/**
 * AI module errors -- structured errors thrown by the lite/ai service
 * and IPC layer.
 *
 * Mirrors the KV / IDW pattern: a single `AiError` subclass of
 * `LiteError` carries a stable code, a human-readable message,
 * structured context, a remediation hint, and the original cause
 * (when one exists).
 *
 * Codes are namespaced with the `AI_` prefix per `error-conformance.ts`.
 * See `lite/ai/README.md` "Error catalog" for full descriptions.
 *
 * SECURITY: error `context` must never include the API key, flow token,
 * or any other secret. Throw sites log only provider/model/status and a
 * short body preview.
 */

import { LiteError } from '../errors.js';
import type { LiteErrorOptions } from '../errors.js';

/** Stable error codes thrown by the AI module. */
export const AI_ERROR_CODES = {
  /** No provider is configured (no Claude key and no OneReach flow). */
  NOT_CONFIGURED: 'AI_NOT_CONFIGURED',
  /** Caller passed an empty/blank purpose (or other invalid input). */
  INVALID_INPUT: 'AI_INVALID_INPUT',
  /** The request could not be sent (DNS, offline, TLS, abort). */
  NETWORK: 'AI_NETWORK',
  /** The provider rejected the credential (HTTP 401/403 or equivalent). */
  AUTH_REJECTED: 'AI_AUTH_REJECTED',
  /** The provider rate-limited the request (HTTP 429). */
  RATE_LIMITED: 'AI_RATE_LIMITED',
  /** The provider returned a non-2xx status or refused the request. */
  PROVIDER_ERROR: 'AI_PROVIDER_ERROR',
  /** The provider responded, but the body wasn't the expected shape. */
  BAD_RESPONSE: 'AI_BAD_RESPONSE',
} as const;

export type AiErrorCode = (typeof AI_ERROR_CODES)[keyof typeof AI_ERROR_CODES];

export interface AiErrorOptions extends Omit<LiteErrorOptions, 'code'> {
  code: AiErrorCode;
}

/**
 * Structured error from the AI module. Extends `LiteError`, so consumers
 * can catch with either `instanceof LiteError` (generic) or
 * `instanceof AiError` (AI-specific).
 */
export class AiError extends LiteError {
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
  }
}
