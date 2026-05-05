/**
 * TOTP code generator -- pure functions over otplib (RFC 6238).
 *
 * Borrowed pattern (studied, never imported): `lib/totp-manager.js`.
 * Rewritten in TS-strict, pruned to the operations lite actually uses
 * (no HOTP, no per-instance config, no logger -- the store does logging).
 *
 * Other lite modules MUST NOT import this directly -- use
 * `getTotpApi()` from `./api.ts`.
 *
 * @internal
 */

import { TotpError, TOTP_ERROR_CODES } from './errors.js';
import { MIN_SECRET_BASE32_CHARS, TOTP_STEP_SECONDS } from './types.js';
import type { TotpCodeInfo } from './types.js';

// otplib is externalized in esbuild and required at runtime. Wrapping
// the require in a getter so unit tests can stub it via vi.mock when
// they don't want the real otplib's strict guardrails enforced.
interface OtplibModule {
  generateSync: (opts: { secret: string; guardrails?: unknown }) => string;
  verifySync: (opts: { secret: string; token: string; guardrails?: unknown }) => { valid: boolean };
  createGuardrails: (opts: { MIN_SECRET_BYTES?: number }) => unknown;
}

let _otplib: OtplibModule | null = null;
let _guardrails: unknown = null;

function loadOtplib(): OtplibModule {
  if (_otplib === null) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
    _otplib = require('otplib') as OtplibModule;
    // Match full app's relaxed guardrails so 80-bit (10-byte) secrets
    // are accepted -- many services use shorter secrets than otplib
    // v13's strict default.
    _guardrails = _otplib.createGuardrails({ MIN_SECRET_BYTES: 10 });
  }
  return _otplib;
}

/** @internal -- exposed for tests so they can inject a stub otplib. */
export function _setOtplibForTesting(stub: OtplibModule | null): void {
  _otplib = stub;
  _guardrails = stub === null ? null : stub.createGuardrails({ MIN_SECRET_BYTES: 10 });
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

const BASE32_PATTERN = /^[A-Z2-7]+=*$/;

/** Strip whitespace and uppercase. Mirrors the full app's normalization. */
export function normalizeSecret(raw: string): string {
  return raw.replace(/\s+/g, '').toUpperCase();
}

/**
 * Validate a Base32 secret. Returns true if the format passes AND
 * otplib accepts it (catches edge cases like tiny secrets that would
 * fail at code-generation time).
 */
export function isValidSecret(raw: string): boolean {
  const normalized = normalizeSecret(raw);
  if (normalized.length < MIN_SECRET_BASE32_CHARS) return false;
  if (!BASE32_PATTERN.test(normalized)) return false;
  try {
    generateCode(normalized);
    return true;
  } catch {
    return false;
  }
}

/**
 * Generate the current 6-digit TOTP code for a Base32 secret.
 *
 * @throws {TotpError} `TOTP_GENERATION_FAILED` if otplib rejects the secret.
 */
export function generateCode(secret: string): string {
  const normalized = normalizeSecret(secret);
  const otplib = loadOtplib();
  try {
    return otplib.generateSync({ secret: normalized, guardrails: _guardrails });
  } catch (err) {
    throw new TotpError({
      code: TOTP_ERROR_CODES.GENERATION_FAILED,
      message: `TOTP code generation failed: ${(err as Error).message}`,
      context: { secretLength: normalized.length },
      remediation: 'The stored secret may be malformed. Remove the authenticator and re-add the QR code.',
      cause: err,
    });
  }
}

/**
 * Get seconds remaining until the current 30-second TOTP window
 * rolls over. Pure -- depends only on `Date.now()`.
 */
export function getTimeRemaining(now: number = Date.now()): number {
  const epoch = Math.floor(now / 1000);
  return TOTP_STEP_SECONDS - (epoch % TOTP_STEP_SECONDS);
}

/** Get the live code + countdown for the authenticator UI. */
export function getCurrentCodeInfo(secret: string): TotpCodeInfo {
  const code = generateCode(secret);
  const timeRemaining = getTimeRemaining();
  return {
    code,
    formattedCode: `${code.slice(0, 3)} ${code.slice(3)}`,
    timeRemaining,
    expiresAt: Date.now() + timeRemaining * 1000,
  };
}

// ---------------------------------------------------------------------------
// otpauth URI parsing -- accepts the URI emitted by QR codes from
// authenticator-setup pages.
//
//   otpauth://totp/Issuer:account?secret=XXXX&issuer=Issuer&algorithm=SHA1&digits=6&period=30
// ---------------------------------------------------------------------------

export interface ParsedOtpAuthUri {
  secret: string;
  issuer: string;
  account: string;
  algorithm: string;
  digits: number;
  period: number;
  type: 'totp' | 'hotp';
}

/**
 * Parse an `otpauth://` URI.
 *
 * @throws {TotpError} `TOTP_NOT_AUTHENTICATOR_QR` if the URI is not a
 *   valid `otpauth://totp/...` form.
 */
export function parseOtpAuthUri(uri: string): ParsedOtpAuthUri {
  let url: URL;
  try {
    url = new URL(uri);
  } catch (err) {
    throw new TotpError({
      code: TOTP_ERROR_CODES.NOT_AUTHENTICATOR_QR,
      message: 'QR code is not a valid otpauth:// URI.',
      context: { uriLength: uri.length },
      remediation: 'Make sure the QR is the OneReach 2FA setup code, not a different QR.',
      cause: err,
    });
  }

  if (url.protocol !== 'otpauth:') {
    throw new TotpError({
      code: TOTP_ERROR_CODES.NOT_AUTHENTICATOR_QR,
      message: `QR code uses unexpected protocol "${url.protocol}".`,
      context: { protocol: url.protocol },
      remediation: 'Make sure the QR is the OneReach 2FA setup code, not a website link.',
    });
  }

  const type = url.hostname as 'totp' | 'hotp';
  if (type !== 'totp' && type !== 'hotp') {
    throw new TotpError({
      code: TOTP_ERROR_CODES.NOT_AUTHENTICATOR_QR,
      message: `Unsupported otpauth type "${type}". Only totp/hotp recognized.`,
      context: { type },
      remediation: 'Re-scan the OneReach 2FA setup QR code.',
    });
  }

  const secret = url.searchParams.get('secret');
  if (secret === null || secret.length === 0) {
    throw new TotpError({
      code: TOTP_ERROR_CODES.NOT_AUTHENTICATOR_QR,
      message: 'otpauth URI is missing the required `secret` parameter.',
      context: {},
      remediation: 'Re-scan the OneReach 2FA setup QR code.',
    });
  }

  const issuerParam = url.searchParams.get('issuer') ?? '';
  const algorithm = url.searchParams.get('algorithm') ?? 'SHA1';
  const digits = parseInt(url.searchParams.get('digits') ?? '6', 10);
  const period = parseInt(url.searchParams.get('period') ?? '30', 10);

  // After URL parsing, `url.hostname` is `totp` (or `hotp`) and
  // `url.pathname` is `/<label>`, where label is `Issuer:account` or
  // just `account`. (Earlier reads of full app's regex misled me by
  // including `/totp/` in the pattern; that prefix lives in the
  // hostname here, not the pathname.)
  const labelPath = decodeURIComponent(url.pathname).replace(/^\//, '');
  const colonIdx = labelPath.indexOf(':');
  const pathIssuer = colonIdx >= 0 ? labelPath.slice(0, colonIdx) : null;
  const account = colonIdx >= 0 ? labelPath.slice(colonIdx + 1) : labelPath;
  const issuer = pathIssuer !== null ? pathIssuer : issuerParam !== '' ? issuerParam : 'Unknown';

  return {
    secret: normalizeSecret(secret),
    issuer,
    account,
    algorithm,
    digits,
    period,
    type,
  };
}

/** Quick check used by the QR scanner before attempting full parse. */
export function isOtpAuthUri(uri: string): boolean {
  return uri.startsWith('otpauth://');
}
