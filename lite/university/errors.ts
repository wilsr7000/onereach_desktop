/**
 * Agentic University module errors -- surfaced when a curated id
 * doesn't resolve, or when a click target's URL is invalid.
 *
 * Codes are namespaced with the `UNIV_` prefix per the
 * `error-conformance.ts` rule.
 */

import { LiteError } from '../errors.js';
import type { LiteErrorOptions } from '../errors.js';

export const UNIVERSITY_ERROR_CODES = {
  /** `openCourse` / `openTutorial` etc. called with an unknown id. */
  NOT_FOUND: 'UNIV_NOT_FOUND',
  /** Curated entry has a malformed / non-http URL. */
  INVALID_URL: 'UNIV_INVALID_URL',
} as const;

export type UniversityErrorCode =
  (typeof UNIVERSITY_ERROR_CODES)[keyof typeof UNIVERSITY_ERROR_CODES];

export interface UniversityErrorOptions extends Omit<LiteErrorOptions, 'code'> {
  code: UniversityErrorCode;
}

/**
 * Structured error from the Agentic University module. Always
 * extends `LiteError`, so consumers can catch with either
 * `instanceof LiteError` (generic) or `instanceof UniversityError`.
 */
export class UniversityError extends LiteError {
  constructor(options: UniversityErrorOptions) {
    const baseOptions: LiteErrorOptions = {
      code: options.code,
      message: options.message,
      ...(options.context !== undefined ? { context: options.context } : {}),
      ...(options.remediation !== undefined ? { remediation: options.remediation } : {}),
      ...(options.cause !== undefined ? { cause: options.cause } : {}),
    };
    super(baseOptions);
    this.name = 'UniversityError';
  }
}
