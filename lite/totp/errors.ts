/**
 * TOTP module -- error class + code catalog.
 *
 * Lives in its own file so `manager.ts` and `store.ts` can both import
 * it without creating a circular dependency (`store.ts` uses helpers
 * from `manager.ts`, and `manager.ts` throws errors).
 *
 * Per Rule 12 / ADR-024 in `lite/LITE-RULES.md` and `lite/DECISIONS.md`,
 * every module's error class extends `LiteError` and codes follow
 * `<MODULE_PREFIX>_<WHAT>` SCREAMING_SNAKE convention.
 *
 * @internal -- consumers import these via `./api.ts` re-exports.
 */

import { LiteError } from '../errors.js';
import type { LiteErrorOptions } from '../errors.js';

/** Stable error codes thrown by the TOTP module. */
export const TOTP_ERROR_CODES = {
  /** No TOTP secret has been saved yet. */
  NO_SECRET: 'TOTP_NO_SECRET',
  /** The provided string is not a valid Base32 TOTP secret. */
  INVALID_SECRET: 'TOTP_INVALID_SECRET',
  /** Keychain read/write/delete rejected (keytar threw). */
  KEYCHAIN_FAILED: 'TOTP_KEYCHAIN_FAILED',
  /** otplib code generation failed (e.g. corrupt secret). */
  GENERATION_FAILED: 'TOTP_GENERATION_FAILED',
  /** QR scan ran but found no QR code anywhere in the image. */
  NO_QR_FOUND: 'TOTP_NO_QR_FOUND',
  /** A QR code was found but is not an otpauth:// authenticator URI. */
  NOT_AUTHENTICATOR_QR: 'TOTP_NOT_AUTHENTICATOR_QR',
  /** Screen capture failed (e.g. macOS screen-recording permission denied). */
  SCREEN_CAPTURE_FAILED: 'TOTP_SCREEN_CAPTURE_FAILED',
} as const;

export type TotpErrorCode = (typeof TOTP_ERROR_CODES)[keyof typeof TOTP_ERROR_CODES];

export interface TotpErrorOptions extends Omit<LiteErrorOptions, 'code'> {
  code: TotpErrorCode;
}

/**
 * Structured error from the TOTP module. Always extends `LiteError`,
 * so consumers can catch via `instanceof LiteError` (generic) or
 * `instanceof TotpError` (module-specific).
 *
 * See `lite/totp/README.md` for the full error catalog.
 */
export class TotpError extends LiteError {
  constructor(options: TotpErrorOptions) {
    const baseOptions: LiteErrorOptions = {
      code: options.code,
      message: options.message,
      ...(options.context !== undefined ? { context: options.context } : {}),
      ...(options.remediation !== undefined ? { remediation: options.remediation } : {}),
      ...(options.cause !== undefined ? { cause: options.cause } : {}),
    };
    super(baseOptions);
    this.name = 'TotpError';
  }
}
