/**
 * TOTP code-generation tests.
 *
 * These exercise the pure helpers in `lite/totp/manager.ts` (no
 * keychain, no Electron). otplib is real -- we test against the
 * actual algorithm output to catch upstream regressions.
 */

import { describe, it, expect } from 'vitest';
import {
  generateCode,
  getCurrentCodeInfo,
  getTimeRemaining,
  isOtpAuthUri,
  isValidSecret,
  normalizeSecret,
  parseOtpAuthUri,
} from '../../totp/manager.js';
import { TotpError, TOTP_ERROR_CODES } from '../../totp/api.js';

const SAMPLE_SECRET = 'JBSWY3DPEHPK3PXP'; // standard test vector ("Hello!\xDE\xAD\xBE\xEF")
const ONEREACH_SECRET = 'KRSXG5CTMVRXEZLU'; // arbitrary 16-char Base32

describe('normalizeSecret', () => {
  it('strips whitespace and uppercases', () => {
    expect(normalizeSecret(' jbsw y3dp ehpk 3pxp ')).toBe('JBSWY3DPEHPK3PXP');
  });
  it('is idempotent', () => {
    const once = normalizeSecret('JBSWY3DPEHPK3PXP');
    expect(normalizeSecret(once)).toBe(once);
  });
});

describe('isValidSecret', () => {
  it('accepts a standard 16-char Base32 secret', () => {
    expect(isValidSecret(SAMPLE_SECRET)).toBe(true);
  });
  it('accepts whitespace-padded input', () => {
    expect(isValidSecret(' JBSW Y3DP EHPK 3PXP ')).toBe(true);
  });
  it('rejects too-short secrets', () => {
    expect(isValidSecret('JBSWY3DP')).toBe(false);
  });
  it('rejects non-Base32 characters', () => {
    expect(isValidSecret('JBSWY3DPEHPK3PX!')).toBe(false);
  });
  it('rejects lowercase letters that fall outside Base32', () => {
    expect(isValidSecret('hello world hello')).toBe(false);
  });
});

describe('generateCode', () => {
  it('returns a 6-digit numeric string', () => {
    const code = generateCode(SAMPLE_SECRET);
    expect(code).toMatch(/^\d{6}$/);
  });
  it('throws TotpError(TOTP_GENERATION_FAILED) on garbage secret', () => {
    expect(() => generateCode('!!!!')).toThrow(TotpError);
    try {
      generateCode('!!!!');
    } catch (err) {
      expect((err as TotpError).code).toBe(TOTP_ERROR_CODES.GENERATION_FAILED);
    }
  });
  it('produces the same code twice within the same 30s window', () => {
    const a = generateCode(SAMPLE_SECRET);
    const b = generateCode(SAMPLE_SECRET);
    expect(a).toBe(b);
  });
});

describe('getTimeRemaining', () => {
  it('returns 30 at the start of a window', () => {
    expect(getTimeRemaining(0)).toBe(30);
  });
  it('returns 1 in the last second', () => {
    expect(getTimeRemaining(29_000)).toBe(1);
  });
  it('returns 30 again after the window rolls over', () => {
    expect(getTimeRemaining(30_000)).toBe(30);
  });
  it('matches a known mid-window position', () => {
    expect(getTimeRemaining(15_000)).toBe(15);
  });
});

describe('getCurrentCodeInfo', () => {
  it('includes formattedCode with a space in the middle', () => {
    const info = getCurrentCodeInfo(SAMPLE_SECRET);
    expect(info.formattedCode).toMatch(/^\d{3} \d{3}$/);
    expect(info.formattedCode.replace(' ', '')).toBe(info.code);
  });
  it('expiresAt is in the future and within 30s', () => {
    const info = getCurrentCodeInfo(SAMPLE_SECRET);
    const delta = info.expiresAt - Date.now();
    expect(delta).toBeGreaterThan(0);
    expect(delta).toBeLessThanOrEqual(30_000);
  });
});

describe('parseOtpAuthUri', () => {
  it('extracts secret + issuer + account from a complete URI', () => {
    const uri = `otpauth://totp/OneReach:alice@example.com?secret=${ONEREACH_SECRET}&issuer=OneReach&algorithm=SHA1&digits=6&period=30`;
    const parsed = parseOtpAuthUri(uri);
    expect(parsed.secret).toBe(ONEREACH_SECRET);
    expect(parsed.issuer).toBe('OneReach');
    expect(parsed.account).toBe('alice@example.com');
    expect(parsed.algorithm).toBe('SHA1');
    expect(parsed.digits).toBe(6);
    expect(parsed.period).toBe(30);
    expect(parsed.type).toBe('totp');
  });
  it('falls back to the issuer query param when the path has no prefix', () => {
    const uri = `otpauth://totp/alice@example.com?secret=${ONEREACH_SECRET}&issuer=OneReach`;
    const parsed = parseOtpAuthUri(uri);
    expect(parsed.issuer).toBe('OneReach');
    expect(parsed.account).toBe('alice@example.com');
  });
  it('uses defaults when optional params are absent', () => {
    const uri = `otpauth://totp/alice?secret=${ONEREACH_SECRET}`;
    const parsed = parseOtpAuthUri(uri);
    expect(parsed.algorithm).toBe('SHA1');
    expect(parsed.digits).toBe(6);
    expect(parsed.period).toBe(30);
  });
  it('throws TotpError(NOT_AUTHENTICATOR_QR) on non-otpauth URIs', () => {
    expect(() => parseOtpAuthUri('https://example.com')).toThrow(TotpError);
    try {
      parseOtpAuthUri('https://example.com');
    } catch (err) {
      expect((err as TotpError).code).toBe(TOTP_ERROR_CODES.NOT_AUTHENTICATOR_QR);
    }
  });
  it('throws on missing secret param', () => {
    expect(() => parseOtpAuthUri('otpauth://totp/alice?issuer=OneReach')).toThrow(TotpError);
  });
  it('throws on unrecognized otpauth type', () => {
    expect(() => parseOtpAuthUri(`otpauth://garbage/alice?secret=${ONEREACH_SECRET}`)).toThrow(TotpError);
  });
  it('throws on completely malformed URI', () => {
    expect(() => parseOtpAuthUri('not a uri at all')).toThrow(TotpError);
  });
});

describe('isOtpAuthUri', () => {
  it('matches otpauth:// prefix', () => {
    expect(isOtpAuthUri('otpauth://totp/alice?secret=ABC')).toBe(true);
  });
  it('rejects everything else', () => {
    expect(isOtpAuthUri('https://onereach.ai')).toBe(false);
    expect(isOtpAuthUri('JBSWY3DPEHPK3PXP')).toBe(false);
    expect(isOtpAuthUri('')).toBe(false);
  });
});
