/**
 * TOTP store -- keychain-backed secret storage.
 *
 * Per the updated product direction after ADR-031:
 *   - Service name `OneReach.ai-TOTP`, account `onereach-unified-login`
 *     (same as the full app). The user configures the GSX/OneReach
 *     authenticator once and Lite can generate the same code.
 *   - Secret value never crosses IPC after save (manual entry necessarily
 *     does on the way IN, but it's never round-tripped back OUT to the
 *     renderer)
 *   - Secret value NEVER logged. Only metadata (length, savedAt, etc.)
 *
 * Borrowed pattern (studied, never imported):
 *   `credential-manager.js:512-572` -- TOTP keychain save/get/delete via
 *   `keytar`. Rewritten in TS-strict, narrower surface.
 *
 * Other lite modules MUST NOT import this directly -- use
 * `getTotpApi()` from `./api.ts`.
 *
 * @internal
 */

import { TotpError, TOTP_ERROR_CODES } from './errors.js';
import {
  getCurrentCodeInfo,
  isValidSecret,
  normalizeSecret,
  parseOtpAuthUri,
} from './manager.js';
import type { TotpCodeInfo, TotpSecretMetadata } from './types.js';

// Re-export so consumers (and api.ts) get the canonical error surface
// from this module's main internal entry point.
export { TotpError, TOTP_ERROR_CODES } from './errors.js';
export type { TotpErrorCode, TotpErrorOptions } from './errors.js';

/** Keytar service name for the secret. Matches full app's `credential-manager.js`. */
export const KEYCHAIN_SERVICE = 'OneReach.ai-TOTP';
/** Keytar service name for the metadata blob. Lite owns this lightweight metadata. */
export const KEYCHAIN_META_SERVICE = 'OneReach.ai-TOTP-meta';
/** Keytar account key. Matches full app's `ONEREACH_ACCOUNT_KEY`. */
export const KEYCHAIN_ACCOUNT = 'onereach-unified-login';

/**
 * Backward-compat fallback for secrets saved by the first Lite spike
 * before we aligned with the full app's keychain service. Read/delete
 * paths check both; save writes only the canonical shared service.
 */
const LEGACY_LITE_KEYCHAIN_SERVICE = 'OneReach.ai-Lite-TOTP';
const LEGACY_LITE_KEYCHAIN_META_SERVICE = 'OneReach.ai-Lite-TOTP-meta';
const LEGACY_LITE_KEYCHAIN_ACCOUNT = 'lite-totp-secret';

// ---------------------------------------------------------------------------
// Keytar-like surface (injectable for tests).
// ---------------------------------------------------------------------------

/**
 * Minimal keytar surface the store uses. Production wires this to the
 * real `keytar` package; tests inject a Map-backed fake.
 */
export interface KeychainBackend {
  setPassword(service: string, account: string, password: string): Promise<void>;
  getPassword(service: string, account: string): Promise<string | null>;
  deletePassword(service: string, account: string): Promise<boolean>;
}

let _defaultBackend: KeychainBackend | null = null;

function defaultKeychainBackend(): KeychainBackend {
  if (_defaultBackend === null) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
    _defaultBackend = require('keytar') as KeychainBackend;
  }
  return _defaultBackend;
}

/** @internal -- exposed for tests so they can reset cached keytar binding. */
export function _resetKeychainBackendForTesting(): void {
  _defaultBackend = null;
}

// ---------------------------------------------------------------------------
// Logger + span surface -- mirrors other lite modules.
// ---------------------------------------------------------------------------

/**
 * Minimal span shape this module needs. Mirrors `lite/logging/events.ts`
 * `Span` without forcing a runtime import (keeps store.ts free of
 * `getLoggingApi()` so tests can construct a TotpStore in isolation).
 */
export interface TotpSpanLike {
  finish(data?: unknown): void;
  fail(error: unknown, data?: unknown): void;
}

export interface TotpStoreConfig {
  /** Optional keychain backend override (for tests). */
  keychain?: KeychainBackend;
  /** Optional logger. Defaults to silent. */
  logger?: (level: 'info' | 'warn' | 'error', message: string, data?: unknown) => void;
  /**
   * Optional span emitter -- when provided, store ops (`saveSecret`,
   * `getCurrentCode`) wrap their work in `totp.<op>.start` /
   * `.finish` / `.fail` spans. ADR-030. The default config in
   * `totp/api.ts` wires this to `getLoggingApi().start()`. Tests can
   * pass a stub or omit (silent path).
   */
  spanEmitter?: (name: string, data?: unknown) => TotpSpanLike;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface StoredMetadata {
  issuer?: string;
  account?: string;
  savedAt: string;
  secretLength: number;
}

/**
 * TOTP store. Implements the storage half of `TotpApi`.
 *
 * @internal -- consumers go through `getTotpApi()`.
 */
export class TotpStore {
  private readonly keychain: KeychainBackend;
  private readonly log: NonNullable<TotpStoreConfig['logger']>;
  private readonly spanEmitter: NonNullable<TotpStoreConfig['spanEmitter']> | null;

  constructor(config: TotpStoreConfig = {}) {
    this.keychain = config.keychain ?? defaultKeychainBackend();
    this.log =
      config.logger ??
      ((): void => {
        /* default: silent */
      });
    this.spanEmitter = config.spanEmitter ?? null;
  }

  /**
   * Validate + save a Base32 secret. Returns the metadata that was
   * persisted (NOT the secret).
   *
   * @throws {TotpError} `TOTP_INVALID_SECRET` if the format is wrong.
   * @throws {TotpError} `TOTP_KEYCHAIN_FAILED` if keytar rejects.
   */
  async saveSecret(
    rawSecret: string,
    extra: { issuer?: string; account?: string } = {}
  ): Promise<TotpSecretMetadata> {
    // Span data deliberately omits the secret value and length
    // boundaries that could narrow it -- only presence flags. ADR-027.
    const span = this.spanEmitter?.('totp.save-secret', {
      hasIssuer: extra.issuer !== undefined,
      hasAccount: extra.account !== undefined,
    });
    try {
      const normalized = normalizeSecret(rawSecret);
      if (!isValidSecret(normalized)) {
        this.log('warn', 'totp: rejected invalid secret', { secretLength: normalized.length });
        const err = new TotpError({
          code: TOTP_ERROR_CODES.INVALID_SECRET,
          message: 'The TOTP secret is not a valid Base32-encoded value.',
          context: { secretLength: normalized.length },
          remediation:
            'Make sure you copied the entire secret. It should contain only A-Z and 2-7, and be at least 16 characters.',
        });
        span?.fail(err);
        throw err;
      }

      const meta: StoredMetadata = {
        ...(extra.issuer !== undefined ? { issuer: extra.issuer } : {}),
        ...(extra.account !== undefined ? { account: extra.account } : {}),
        savedAt: new Date().toISOString(),
        secretLength: normalized.length,
      };

      try {
        await this.keychain.setPassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, normalized);
        await this.keychain.setPassword(KEYCHAIN_META_SERVICE, KEYCHAIN_ACCOUNT, JSON.stringify(meta));
      } catch (err) {
        const wrapped = new TotpError({
          code: TOTP_ERROR_CODES.KEYCHAIN_FAILED,
          message: `Saving TOTP secret to the keychain failed: ${(err as Error).message}`,
          context: { op: 'saveSecret', secretLength: normalized.length },
          remediation:
            'Make sure macOS Keychain is unlocked. If the issue persists, restart the app and try again.',
          cause: err,
        });
        span?.fail(wrapped);
        throw wrapped;
      }

      this.log('info', 'totp: secret saved', {
        secretLength: normalized.length,
        hasIssuer: meta.issuer !== undefined,
        hasAccount: meta.account !== undefined,
      });
      const view = this.metadataView(meta);
      span?.finish({ secretLength: normalized.length });
      return view;
    } catch (err) {
      // Re-thrown above for typed errors; for any other failure path
      // (e.g., parseOtpAuthUri throwing inside saveFromOtpAuthUri ->
      // saveSecret), make sure the span sees it.
      if (err instanceof TotpError) throw err;
      span?.fail(err);
      throw err;
    }
  }

  /**
   * Save from a parsed otpauth URI -- convenience wrapper around
   * `saveSecret`. Used by the QR-scan paths.
   */
  async saveFromOtpAuthUri(uri: string): Promise<TotpSecretMetadata> {
    const parsed = parseOtpAuthUri(uri);
    return this.saveSecret(parsed.secret, {
      issuer: parsed.issuer,
      account: parsed.account,
    });
  }

  /**
   * Whether a secret is currently stored. Cheap -- one keychain read.
   */
  async hasSecret(): Promise<boolean> {
    try {
      const found = await this.readSecretFromAnyService();
      return found.secret !== null && found.secret.length > 0;
    } catch (err) {
      this.log('warn', 'totp: hasSecret keychain read failed', { error: (err as Error).message });
      return false;
    }
  }

  /**
   * Read the public-facing metadata, or null if no secret is stored.
   */
  async getMetadata(): Promise<TotpSecretMetadata | null> {
    const raw = await this.readMetadataFromAnyService();
    if (raw === null || raw.length === 0) {
      // Full app stores the secret but not lite's metadata blob. If a
      // shared full-app secret exists, synthesize enough metadata for
      // Settings to render the generated-code state instead of the setup
      // state. No secret value is exposed.
      const found = await this.readSecretFromAnyService();
      if (found.secret === null || found.secret.length === 0) return null;
      return this.metadataView({
        issuer: 'OneReach',
        account: found.source === 'full' ? 'configured in full app' : 'configured in lite',
        savedAt: 'unknown',
        secretLength: found.secret.length,
      });
    }
    try {
      const meta = JSON.parse(raw) as StoredMetadata;
      return this.metadataView(meta);
    } catch {
      this.log('warn', 'totp: metadata blob unparseable', {});
      return null;
    }
  }

  /**
   * Read the live code + countdown.
   *
   * @throws {TotpError} `TOTP_NO_SECRET` if no secret is stored.
   * @throws {TotpError} `TOTP_KEYCHAIN_FAILED` if keytar rejects.
   * @throws {TotpError} `TOTP_GENERATION_FAILED` if otplib rejects.
   */
  async getCurrentCode(): Promise<TotpCodeInfo> {
    const span = this.spanEmitter?.('totp.get-code');
    let found: { secret: string | null; source: 'full' | 'lite' | 'legacy' };
    try {
      found = await this.readSecretFromAnyService();
    } catch (err) {
      const wrapped = new TotpError({
        code: TOTP_ERROR_CODES.KEYCHAIN_FAILED,
        message: `Reading TOTP secret from the keychain failed: ${(err as Error).message}`,
        context: { op: 'getCurrentCode' },
        remediation: 'Make sure macOS Keychain is unlocked.',
        cause: err,
      });
      span?.fail(wrapped);
      throw wrapped;
    }
    if (found.secret === null || found.secret.length === 0) {
      const err = new TotpError({
        code: TOTP_ERROR_CODES.NO_SECRET,
        message: 'No TOTP secret is stored.',
        context: {},
        remediation: 'Open Settings -> Two-Factor and add the OneReach authenticator secret or setup QR first.',
      });
      span?.fail(err);
      throw err;
    }
    this.log('info', 'totp: code generated', { source: found.source, secretLength: found.secret.length });
    try {
      const info = getCurrentCodeInfo(found.secret);
      // Don't include the code value or remaining time in span data --
      // both are ephemeral and the value is sensitive.
      span?.finish({ source: found.source });
      return info;
    } catch (err) {
      span?.fail(err);
      throw err;
    }
  }

  /**
   * Delete the stored secret + metadata. Idempotent: succeeds even if
   * nothing was stored.
   *
   * @throws {TotpError} `TOTP_KEYCHAIN_FAILED` only if keytar throws.
   *   "Nothing to delete" is NOT an error.
   */
  async deleteSecret(): Promise<void> {
    try {
      await this.keychain.deletePassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
      await this.keychain.deletePassword(KEYCHAIN_META_SERVICE, KEYCHAIN_ACCOUNT);
      await this.keychain.deletePassword(LEGACY_LITE_KEYCHAIN_SERVICE, LEGACY_LITE_KEYCHAIN_ACCOUNT);
      await this.keychain.deletePassword(LEGACY_LITE_KEYCHAIN_META_SERVICE, LEGACY_LITE_KEYCHAIN_ACCOUNT);
    } catch (err) {
      throw new TotpError({
        code: TOTP_ERROR_CODES.KEYCHAIN_FAILED,
        message: `Deleting TOTP secret from the keychain failed: ${(err as Error).message}`,
        context: { op: 'deleteSecret' },
        remediation: 'Make sure macOS Keychain is unlocked.',
        cause: err,
      });
    }
    this.log('info', 'totp: secret deleted', {});
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /** Build a metadata view for callers (no value, just metadata). */
  private metadataView(meta: StoredMetadata): TotpSecretMetadata {
    return {
      ...(meta.issuer !== undefined ? { issuer: meta.issuer } : {}),
      ...(meta.account !== undefined ? { account: meta.account } : {}),
      savedAt: meta.savedAt,
      secretLength: meta.secretLength,
    };
  }

  /**
   * Read the secret from the canonical shared full-app service first,
   * then fall back to the legacy Lite-only spike entry. The full app
   * stores OneReach 2FA at OneReach.ai-TOTP/onereach-unified-login;
   * Lite needs to generate the same GSX code from that existing setup.
   */
  private async readSecretFromAnyService(): Promise<{
    secret: string | null;
    source: 'full' | 'legacy';
  }> {
    const full = await this.keychain.getPassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
    if (full !== null && full.length > 0) return { secret: full, source: 'full' };

    const legacy = await this.keychain.getPassword(LEGACY_LITE_KEYCHAIN_SERVICE, LEGACY_LITE_KEYCHAIN_ACCOUNT);
    if (legacy !== null && legacy.length > 0) return { secret: legacy, source: 'legacy' };

    return { secret: null, source: 'full' };
  }

  /** Read metadata from canonical then legacy service. */
  private async readMetadataFromAnyService(): Promise<string | null> {
    try {
      const full = await this.keychain.getPassword(KEYCHAIN_META_SERVICE, KEYCHAIN_ACCOUNT);
      if (full !== null && full.length > 0) return full;
    } catch (err) {
      this.log('warn', 'totp: canonical metadata read failed', { error: (err as Error).message });
    }
    try {
      return await this.keychain.getPassword(LEGACY_LITE_KEYCHAIN_META_SERVICE, LEGACY_LITE_KEYCHAIN_ACCOUNT);
    } catch (err) {
      this.log('warn', 'totp: legacy metadata read failed', { error: (err as Error).message });
      return null;
    }
  }
}
