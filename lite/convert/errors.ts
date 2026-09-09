/**
 * Convert errors (ADR-100). Codes are stable and namespaced; every
 * throw carries what an agent needs to fix its call.
 */

import { LiteError } from '../errors.js';
import type { LiteErrorOptions } from '../errors.js';

export const CONVERT_ERROR_CODES = {
  INVALID_INPUT: 'CONVERT_INVALID_INPUT',
  TOO_LARGE: 'CONVERT_TOO_LARGE',
  UNKNOWN_FORMAT: 'CONVERT_UNKNOWN_FORMAT',
  NO_PATH: 'CONVERT_NO_PATH',
  UNKNOWN_STRATEGY: 'CONVERT_UNKNOWN_STRATEGY',
  FAILED: 'CONVERT_FAILED',
} as const;

export type ConvertErrorCode = (typeof CONVERT_ERROR_CODES)[keyof typeof CONVERT_ERROR_CODES];

export interface ConvertErrorOptions extends Omit<LiteErrorOptions, 'code'> {
  code: ConvertErrorCode;
}

export class ConvertError extends LiteError {
  constructor(options: ConvertErrorOptions) {
    super({
      code: options.code,
      message: options.message,
      context: { ...(options.context ?? {}) },
      ...(options.remediation !== undefined ? { remediation: options.remediation } : {}),
      ...(options.cause !== undefined ? { cause: options.cause } : {}),
    });
    this.name = 'ConvertError';
  }
}
