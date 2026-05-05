/**
 * IDW module errors -- structured errors thrown by the lite/idw store
 * and IPC layer.
 *
 * Mirrors the KV / Neon pattern: a single `IdwError` subclass of
 * `LiteError` carries a stable code, a human-readable message,
 * structured context, a remediation hint, and the original cause
 * (when one exists).
 *
 * Codes are namespaced with the `IDW_` prefix per
 * `error-conformance.ts`. Add new codes here AND in the `events.ts`
 * fail-event variants if applicable; the conformance tests will catch
 * drift.
 */

import { LiteError } from '../errors.js';
import type { LiteErrorOptions } from '../errors.js';

/**
 * Stable error codes thrown by the IDW module. See
 * `lite/idw/README.md` "Error catalog" for full descriptions.
 */
export const IDW_ERROR_CODES = {
  /** `get`/`update`/`remove` was called with an id that doesn't exist. */
  NOT_FOUND: 'IDW_NOT_FOUND',
  /** Required field missing or wrong type for the chosen kind. */
  INVALID_INPUT: 'IDW_INVALID_INPUT',
  /** URL is missing, malformed, or not http/https. */
  INVALID_URL: 'IDW_INVALID_URL',
  /** Adding an entry whose id collides with an existing manual entry. */
  DUPLICATE: 'IDW_DUPLICATE',
  /** `update()` attempted to change `kind` on an existing entry. */
  KIND_MISMATCH: 'IDW_KIND_MISMATCH',
  /** Underlying KV write rejected. */
  PERSISTENCE_FAILED: 'IDW_PERSISTENCE_FAILED',
} as const;

export type IdwErrorCode = (typeof IDW_ERROR_CODES)[keyof typeof IDW_ERROR_CODES];

export interface IdwErrorOptions extends Omit<LiteErrorOptions, 'code'> {
  code: IdwErrorCode;
}

/**
 * Structured error from the IDW module. Always extends `LiteError`,
 * so consumers can catch with either `instanceof LiteError` (generic)
 * or `instanceof IdwError` (IDW-specific).
 *
 * Carries:
 *   - `.code` -- one of `IDW_ERROR_CODES`
 *   - `.context` -- `{ op, id?, kind?, field? }`
 *   - `.remediation` -- short, action-oriented hint
 *   - `.cause` -- the underlying Error (e.g. KVError)
 *
 * See `lite/idw/README.md` for the full error catalog.
 */
export class IdwError extends LiteError {
  constructor(options: IdwErrorOptions) {
    const baseOptions: LiteErrorOptions = {
      code: options.code,
      message: options.message,
      ...(options.context !== undefined ? { context: options.context } : {}),
      ...(options.remediation !== undefined ? { remediation: options.remediation } : {}),
      ...(options.cause !== undefined ? { cause: options.cause } : {}),
    };
    super(baseOptions);
    this.name = 'IdwError';
  }
}
