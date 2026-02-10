/**
 * TOTP Manager - Built-in Authenticator for OneReach
 * Generates 2FA codes compatible with Google Authenticator, Authy, 1Password, etc.
 * 
 * Uses the TOTP algorithm (RFC 6238) with standard settings:
 * - 30-second time step
 * - 6-digit codes
 * - SHA1 algorithm (most common)
 * 
 * Updated for otplib v13 API
 */

const { generateSync, verifySync, createGuardrails } = require('otplib');
const { getLogQueue } = require('./log-event-queue');
const log = getLogQueue();

// Create relaxed guardrails to allow standard 80-bit (10 byte) secrets
// Many services use shorter secrets than otplib v13's strict defaults
const guardrails = createGuardrails({ MIN_SECRET_BYTES: 10 });

class TOTPManager {
  constructor() {
    log.info('app', 'Initialized with standard TOTP settings (otplib v13)');
  }

  /**
   * Parse TOTP secret from otpauth:// URI (from QR code)
   * Format: otpauth://totp/Issuer:account?secret=XXXX&issuer=Issuer&algorithm=SHA1&digits=6&period=30
   * 
   * @param {string} uri - The otpauth:// URI from QR code
   * @returns {object} Parsed data: { secret, issuer, account, algorithm, digits, period }
   */
  parseOTPAuthURI(uri) {
    try {
      const url = new URL(uri);
      
      if (url.protocol !== 'otpauth:') {
        throw new Error('Invalid protocol - expected otpauth://');
      }
      
      const type = url.hostname; // 'totp' or 'hotp'
      if (type !== 'totp') {
        log.warn('app', 'Warning: type detected, only TOTP is fully supported', { type: type });
      }
      
      // Extract secret (required)
      const secret = url.searchParams.get('secret');
      if (!secret) {
        throw new Error('No secret found in OTP URI');
      }
      
      // Extract optional parameters
      const issuer = url.searchParams.get('issuer') || 'Unknown';
      const algorithm = url.searchParams.get('algorithm') || 'SHA1';
      const digits = parseInt(url.searchParams.get('digits') || '6', 10);
      const period = parseInt(url.searchParams.get('period') || '30', 10);
      
      // Parse account from path: /totp/Issuer:account or /totp/account
      const pathMatch = decodeURIComponent(url.pathname).match(/\/(?:totp|hotp)\/(?:([^:]+):)?(.+)/);
      const account = pathMatch ? pathMatch[2] : 'unknown';
      const pathIssuer = pathMatch ? pathMatch[1] : null;
      
      return {
        secret: secret.toUpperCase().replace(/\s/g, ''),
        issuer: pathIssuer || issuer,
        account,
        algorithm,
        digits,
        period,
        type
      };
    } catch (error) {
      log.error('app', 'Failed to parse OTP URI', { error: error.message });
      throw new Error(`Invalid OTP URI: ${error.message}`);
    }
  }

  /**
   * Generate current TOTP code
   * @param {string} secret - Base32 encoded secret
   * @returns {string} 6-digit code (e.g., "847293")
   */
  generateCode(secret) {
    try {
      const cleanSecret = this.normalizeSecret(secret);
      const code = generateSync({ secret: cleanSecret, guardrails });
      return code;
    } catch (error) {
      log.error('app', 'Failed to generate code', { error: error.message });
      throw new Error('Failed to generate TOTP code: ' + error.message);
    }
  }

  /**
   * Generate code with formatting (space in middle for readability)
   * @param {string} secret - Base32 encoded secret
   * @returns {string} Formatted code (e.g., "847 293")
   */
  generateFormattedCode(secret) {
    const code = this.generateCode(secret);
    return `${code.slice(0, 3)} ${code.slice(3)}`;
  }

  /**
   * Get seconds remaining until current code expires
   * @returns {number} Seconds remaining (0-30)
   */
  getTimeRemaining() {
    // Calculate time remaining manually (30-second step)
    const epoch = Math.floor(Date.now() / 1000);
    const step = 30;
    return step - (epoch % step);
  }

  /**
   * Verify a code is valid for a given secret
   * Useful for confirming setup is correct
   * @param {string} secret - Base32 encoded secret
   * @param {string} code - 6-digit code to verify
   * @returns {boolean} True if code is valid
   */
  verifyCode(secret, code) {
    try {
      const cleanSecret = this.normalizeSecret(secret);
      const cleanCode = code.replace(/\s/g, '');
      
      const result = verifySync({ 
        secret: cleanSecret, 
        token: cleanCode, 
        guardrails 
      });
      
      return result.valid;
    } catch (error) {
      log.error('app', 'Verification error', { error: error.message });
      return false;
    }
  }

  /**
   * Validate that a secret is properly formatted
   * @param {string} secret - Secret to validate
   * @returns {boolean} True if valid Base32 secret
   */
  isValidSecret(secret) {
    try {
      // Base32 alphabet check
      const base32Regex = /^[A-Z2-7]+=*$/i;
      const cleanSecret = this.normalizeSecret(secret);
      
      if (!base32Regex.test(cleanSecret)) {
        return false;
      }
      
      // Minimum length check (at least 16 chars Base32 = 10 bytes)
      if (cleanSecret.length < 16) {
        log.warn('app', 'Secret may be too short', { cleanSecret: cleanSecret.length, chars: 'chars' });
        // Still allow it - some services use shorter secrets
      }
      
      // Try to generate a code - if it works, secret is valid
      this.generateCode(cleanSecret);
      return true;
    } catch (error) {
      log.error('app', 'Invalid secret', { error: error.message });
      return false;
    }
  }

  /**
   * Clean and normalize a manually entered secret
   * @param {string} secret - Raw secret input
   * @returns {string} Cleaned secret (uppercase, no spaces)
   */
  normalizeSecret(secret) {
    return secret.replace(/\s/g, '').toUpperCase();
  }

  /**
   * Get current code info (code + time remaining)
   * Useful for UI display
   * @param {string} secret - Base32 encoded secret
   * @returns {object} { code, formattedCode, timeRemaining, expiresAt }
   */
  getCurrentCodeInfo(secret) {
    const code = this.generateCode(secret);
    const timeRemaining = this.getTimeRemaining();
    
    return {
      code,
      formattedCode: `${code.slice(0, 3)} ${code.slice(3)}`,
      timeRemaining,
      expiresAt: Date.now() + (timeRemaining * 1000)
    };
  }
}

// Singleton instance
let totpManager = null;

function getTOTPManager() {
  if (!totpManager) {
    totpManager = new TOTPManager();
  }
  return totpManager;
}

module.exports = { TOTPManager, getTOTPManager };
