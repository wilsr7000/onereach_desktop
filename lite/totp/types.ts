/**
 * TOTP module -- shared types + protocol constants.
 *
 * Internal-but-re-exported types live here so both `api.ts` (public)
 * and the internal files reference one source of truth.
 *
 * Per ADR-027, the TOTP authenticator generates codes for the user to
 * COPY into the OneReach 2FA prompt. There is no auto-fill in v1; the
 * code stays a plain string here, never injected into a DOM.
 */

/** RFC 6238 standard TOTP step. OneReach uses the default 30s. */
export const TOTP_STEP_SECONDS = 30;

/** RFC 6238 standard TOTP code length. OneReach uses 6 digits. */
export const TOTP_CODE_DIGITS = 6;

/** Minimum Base32 secret length we accept (~80 bits). */
export const MIN_SECRET_BASE32_CHARS = 16;

/**
 * Public-facing metadata about the stored secret. Does NOT include
 * the secret itself -- the secret value is main-process only and
 * never round-trips back over IPC.
 */
export interface TotpSecretMetadata {
  /** Friendly issuer name extracted from otpauth URI (e.g. "OneReach"). */
  issuer?: string;
  /** Account label extracted from otpauth URI (e.g. "alice@example.com"). */
  account?: string;
  /** ISO timestamp when the secret was saved to the keychain. */
  savedAt: string;
  /** Length of the Base32 secret in characters (no value). */
  secretLength: number;
}

/** Live code info for the authenticator UI -- ephemeral, regenerated each second. */
export interface TotpCodeInfo {
  /** The 6-digit code (e.g. "847293"). */
  code: string;
  /** Same code with a space in the middle for readability ("847 293"). */
  formattedCode: string;
  /** Seconds until the current code expires (1..30). */
  timeRemaining: number;
  /** Wall-clock ms epoch when the current code expires. */
  expiresAt: number;
}

/** Result of a QR-scan attempt. Never exposes the secret to the renderer. */
export interface QrScanResult {
  /** Whether a QR code was found AND parsed as an otpauth URI AND saved. */
  saved: boolean;
  /** Friendly issuer (only when saved=true). */
  issuer?: string;
  /** Account label (only when saved=true). */
  account?: string;
  /**
   * If saved=false, why. Use this for renderer UX, not for branching --
   * structured error codes are surfaced via the thrown `TotpError`.
   */
  reason?: 'no-qr-found' | 'not-authenticator-qr' | 'invalid-secret' | 'keychain-failed';
}

/** Result of a save-secret attempt (manual entry path). */
export interface SaveSecretResult {
  /** Whether the secret was validated and stored. */
  saved: boolean;
  /** Metadata if saved=true. */
  metadata?: TotpSecretMetadata;
}
