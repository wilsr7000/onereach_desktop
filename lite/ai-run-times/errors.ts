/**
 * AI Run Times module errors. Codes namespaced `ART_`.
 */

import { LiteError } from '../errors.js';
import type { LiteErrorOptions } from '../errors.js';

export const AI_RUN_TIMES_ERROR_CODES = {
  /** RSS fetch failed (network, HTTP non-2xx, timeout, malformed XML). */
  FEED_FETCH_FAILED: 'ART_FEED_FETCH_FAILED',
  /** Article HTML fetch failed. */
  ARTICLE_FETCH_FAILED: 'ART_ARTICLE_FETCH_FAILED',
  /** Caller passed malformed input (empty url, bad feed id). */
  BAD_INPUT: 'ART_BAD_INPUT',
  /** Lookup miss: article id, feed id not in store. */
  NOT_FOUND: 'ART_NOT_FOUND',
  /** KV write rejected. */
  PERSISTENCE_FAILED: 'ART_PERSISTENCE_FAILED',
} as const;

export type AiRunTimesErrorCode =
  (typeof AI_RUN_TIMES_ERROR_CODES)[keyof typeof AI_RUN_TIMES_ERROR_CODES];

export interface AiRunTimesErrorOptions extends Omit<LiteErrorOptions, 'code'> {
  code: AiRunTimesErrorCode;
  /** HTTP status, when applicable. */
  status?: number;
}

export class AiRunTimesError extends LiteError {
  public readonly status: number | undefined;

  constructor(options: AiRunTimesErrorOptions) {
    const baseOptions: LiteErrorOptions = {
      code: options.code,
      message: options.message,
      ...(options.context !== undefined ? { context: options.context } : {}),
      ...(options.remediation !== undefined ? { remediation: options.remediation } : {}),
      ...(options.cause !== undefined ? { cause: options.cause } : {}),
    };
    super(baseOptions);
    this.name = 'AiRunTimesError';
    this.status = options.status;
  }
}
