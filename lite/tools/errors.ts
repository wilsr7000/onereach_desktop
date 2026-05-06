/**
 * Tools module errors -- structured errors thrown by the lite/tools
 * store and IPC layer. Mirrors the IDW / KV / Neon pattern.
 *
 * Codes are namespaced with the `TOOLS_` prefix per
 * `error-conformance.ts`.
 */

import { LiteError } from '../errors.js';
import type { LiteErrorOptions } from '../errors.js';

/** Stable error codes thrown by the Tools module. */
export const TOOLS_ERROR_CODES = {
  /** `get`/`update`/`remove` was called with an id that doesn't exist. */
  NOT_FOUND: 'TOOLS_NOT_FOUND',
  /** Required field missing or wrong type (label/url). */
  INVALID_INPUT: 'TOOLS_INVALID_INPUT',
  /** URL is missing, malformed, or not http/https. */
  INVALID_URL: 'TOOLS_INVALID_URL',
  /** Adding an entry whose id collides with an existing entry. */
  DUPLICATE: 'TOOLS_DUPLICATE',
  /** Underlying KV write rejected. */
  PERSISTENCE_FAILED: 'TOOLS_PERSISTENCE_FAILED',
} as const;

export type ToolsErrorCode = (typeof TOOLS_ERROR_CODES)[keyof typeof TOOLS_ERROR_CODES];

export interface ToolsErrorOptions extends Omit<LiteErrorOptions, 'code'> {
  code: ToolsErrorCode;
}

export class ToolsError extends LiteError {
  constructor(options: ToolsErrorOptions) {
    const baseOptions: LiteErrorOptions = {
      code: options.code,
      message: options.message,
      ...(options.context !== undefined ? { context: options.context } : {}),
      ...(options.remediation !== undefined ? { remediation: options.remediation } : {}),
      ...(options.cause !== undefined ? { cause: options.cause } : {}),
    };
    super(baseOptions);
    this.name = 'ToolsError';
  }
}
