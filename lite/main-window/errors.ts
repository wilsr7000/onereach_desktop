/**
 * Main window module errors -- structured errors thrown by the
 * tab store and IPC layer.
 *
 * Mirrors the IDW / KV / Neon pattern: a single `MainWindowError`
 * subclass of `LiteError` carries a stable code, a human-readable
 * message, structured context, a remediation hint, and the original
 * cause (when one exists).
 *
 * Codes are namespaced with the `MW_` prefix per
 * `error-conformance.ts`. Add new codes here AND in the `events.ts`
 * fail-event variants if applicable; the conformance tests will catch
 * drift.
 */

import { LiteError } from '../errors.js';
import type { LiteErrorOptions } from '../errors.js';

/**
 * Stable error codes thrown by the main-window module. See
 * `lite/main-window/README.md` "Error catalog" for full descriptions.
 */
export const MAIN_WINDOW_ERROR_CODES = {
  /** `closeTab`/`activateTab` was called with an id that doesn't exist. */
  NOT_FOUND: 'MW_NOT_FOUND',
  /** Required field missing or wrong type. */
  INVALID_INPUT: 'MW_INVALID_INPUT',
  /** URL is missing, malformed, or not http/https. */
  INVALID_URL: 'MW_INVALID_URL',
  /** Two tabs would share the same partition string -- partitions must be unique. */
  DUPLICATE_PARTITION: 'MW_DUPLICATE_PARTITION',
  /** Underlying KV write rejected. */
  PERSISTENCE_FAILED: 'MW_PERSISTENCE_FAILED',
} as const;

export type MainWindowErrorCode =
  (typeof MAIN_WINDOW_ERROR_CODES)[keyof typeof MAIN_WINDOW_ERROR_CODES];

export interface MainWindowErrorOptions extends Omit<LiteErrorOptions, 'code'> {
  code: MainWindowErrorCode;
}

/**
 * Structured error from the main-window module. Always extends
 * `LiteError`, so consumers can catch with either `instanceof
 * LiteError` (generic) or `instanceof MainWindowError` (specific).
 *
 * Carries:
 *   - `.code` -- one of `MAIN_WINDOW_ERROR_CODES`
 *   - `.context` -- `{ op, id?, field? }`
 *   - `.remediation` -- short, action-oriented hint
 *   - `.cause` -- the underlying Error (e.g. KVError)
 */
export class MainWindowError extends LiteError {
  constructor(options: MainWindowErrorOptions) {
    const baseOptions: LiteErrorOptions = {
      code: options.code,
      message: options.message,
      ...(options.context !== undefined ? { context: options.context } : {}),
      ...(options.remediation !== undefined ? { remediation: options.remediation } : {}),
      ...(options.cause !== undefined ? { cause: options.cause } : {}),
    };
    super(baseOptions);
    this.name = 'MainWindowError';
  }
}
