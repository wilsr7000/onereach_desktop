/**
 * GSX automation module -- error class + code catalog.
 *
 * Per Rule 12 / ADR-024 in `lite/LITE-RULES.md` and `lite/DECISIONS.md`,
 * every module's error class extends `LiteError` and codes follow the
 * `<MODULE_PREFIX>_<WHAT>` SCREAMING_SNAKE convention.
 *
 * @internal -- consumers import these via `./api.ts` re-exports.
 */

import { LiteError } from '../errors.js';
import type { LiteErrorOptions } from '../errors.js';

/** Stable error codes thrown by the GSX automation module. */
export const GSX_ERROR_CODES = {
  /** The requested environment isn't in SUPPORTED_ENVIRONMENTS. */
  UNSUPPORTED_ENV: 'GSX_UNSUPPORTED_ENV',
  /** No open GSX window with that windowId. */
  WINDOW_NOT_FOUND: 'GSX_WINDOW_NOT_FOUND',
  /** No script registered under that id. */
  SCRIPT_NOT_FOUND: 'GSX_SCRIPT_NOT_FOUND',
  /** A script (saved or AI-repaired) failed structural validation. */
  INVALID_SCRIPT: 'GSX_INVALID_SCRIPT',
  /** No run record with that runId. */
  RUN_NOT_FOUND: 'GSX_RUN_NOT_FOUND',
  /** The target URL is not a OneReach studio/app domain. */
  URL_NOT_ALLOWED: 'GSX_URL_NOT_ALLOWED',
  /** Navigation or page load failed hard (net error, window destroyed). */
  NAVIGATION_FAILED: 'GSX_NAVIGATION_FAILED',
  /** The repair path needs the AI module but it isn't configured. */
  AI_UNAVAILABLE: 'GSX_AI_UNAVAILABLE',
  /** The AI returned something that doesn't parse into a valid script. */
  REPAIR_FAILED: 'GSX_REPAIR_FAILED',
  /** Persistence (scripts/runs JSON) read or write rejected. */
  PERSIST_FAILED: 'GSX_PERSIST_FAILED',
  /** Seed scripts are read-only: they can't be deleted or overwritten. */
  SEED_READ_ONLY: 'GSX_SEED_READ_ONLY',
  /** stopRecording/cancel called on a window with no active recording. */
  NOT_RECORDING: 'GSX_NOT_RECORDING',
  /** A recording finished with zero captured actions. */
  EMPTY_RECORDING: 'GSX_EMPTY_RECORDING',
  /** No agent registered under that name. */
  AGENT_NOT_FOUND: 'GSX_AGENT_NOT_FOUND',
  /** Agent names are lowercase slugs (see AGENT_NAME_PATTERN). */
  INVALID_AGENT_NAME: 'GSX_INVALID_AGENT_NAME',
  /** Invocation is missing required params (after any extraction). */
  MISSING_PARAMS: 'GSX_MISSING_PARAMS',
} as const;

export type GsxErrorCode = (typeof GSX_ERROR_CODES)[keyof typeof GSX_ERROR_CODES];

export interface GsxErrorOptions extends Omit<LiteErrorOptions, 'code'> {
  code: GsxErrorCode;
}

/**
 * Structured error from the GSX automation module. Always extends
 * `LiteError`, so consumers can catch via `instanceof LiteError`
 * (generic) or `instanceof GsxError` (module-specific).
 *
 * See `lite/gsx/README.md` for the full error catalog.
 */
export class GsxError extends LiteError {
  constructor(options: GsxErrorOptions) {
    const baseOptions: LiteErrorOptions = {
      code: options.code,
      message: options.message,
      ...(options.context !== undefined ? { context: options.context } : {}),
      ...(options.remediation !== undefined ? { remediation: options.remediation } : {}),
      ...(options.cause !== undefined ? { cause: options.cause } : {}),
    };
    super(baseOptions);
    this.name = 'GsxError';
  }
}
