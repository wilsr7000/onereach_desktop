/**
 * TOTP module -- PUBLIC API.
 *
 * The only file other lite modules should import from in this module.
 * Per ADR-019 / Rule 11 in `lite/LITE-RULES.md`, cross-module imports
 * go through `<module>/api.ts` -- never reach into `store.ts`,
 * `manager.ts`, `qr-scanner.ts`, or any other internal file.
 *
 * Per ADR-027:
 *   - Lite ships an authenticator widget (live code + countdown).
 *     Auto-fill into the OneReach 2FA form is NOT in v1; the user
 *     copies the code themselves.
 *   - The TOTP secret value never round-trips back to the renderer
 *     after save. `getCurrentCode()` returns the ephemeral code; the
 *     secret stays in keychain.
 *
 * Usage from another module:
 *
 *   import { getTotpApi } from '../totp/api.js';
 *   const totp = getTotpApi();
 *   if (await totp.hasSecret()) {
 *     const info = await totp.getCurrentCode();
 *     console.log(info.formattedCode);
 *   }
 *
 * Tests: `_setTotpApiForTesting(stub)` to inject a custom implementation,
 * `_resetTotpApiForTesting()` to clear the singleton.
 */

import { TotpStore } from './store.js';
import type { KeychainBackend, TotpStoreConfig } from './store.js';
import { QrScanner } from './qr-scanner.js';
import type { QrScannerConfig } from './qr-scanner.js';
import { isOtpAuthUri } from './manager.js';
import { getLoggingApi } from '../logging/api.js';
import type {
  QrScanResult,
  SaveSecretResult,
  TotpCodeInfo,
  TotpSecretMetadata,
} from './types.js';
import { TOTP_ERROR_CODES, TotpError } from './store.js';

// Re-export public types.
export type {
  QrScanResult,
  SaveSecretResult,
  TotpCodeInfo,
  TotpSecretMetadata,
} from './types.js';
export type { TotpErrorCode, TotpErrorOptions, KeychainBackend } from './store.js';
export { TotpError, TOTP_ERROR_CODES } from './store.js';
export { LiteError, isLiteError } from '../errors.js';

/**
 * The public surface of the TOTP module.
 *
 * **Error contract**: every method except `hasSecret` and `getMetadata`
 * (which return null on missing/error) throws {@link TotpError}.
 * Inspect `.code` to branch.
 *
 * **Secret visibility**: the secret bytes are write-only via
 * `saveSecret` / `scanQrFromScreen` / `scanQrFromClipboard`. There is
 * no `getSecret` -- by design.
 */
export interface TotpApi {
  /** True if a secret is currently stored. Cheap. */
  hasSecret(): Promise<boolean>;

  /** Public metadata about the stored secret, or null if none. */
  getMetadata(): Promise<TotpSecretMetadata | null>;

  /**
   * Save a Base32 secret (manual-entry path). Validates the secret;
   * rejects with `TOTP_INVALID_SECRET` if format is wrong.
   *
   * @throws {TotpError} `TOTP_INVALID_SECRET` | `TOTP_KEYCHAIN_FAILED`
   */
  saveSecret(secret: string, extra?: { issuer?: string; account?: string }): Promise<SaveSecretResult>;

  /**
   * Scan the user's screen for a QR code. If found AND the QR encodes
   * an `otpauth://` URI, parses it and saves the secret in one
   * operation. Returns metadata; never returns the secret value.
   *
   * @throws {TotpError} `TOTP_SCREEN_CAPTURE_FAILED` if the screen
   *   capture itself failed (e.g. permission denied).
   */
  scanQrFromScreen(): Promise<QrScanResult>;

  /**
   * Scan the clipboard image for a QR code. Used as a fallback to the
   * screen-recording path -- the user copies the QR image to the
   * clipboard, then triggers this. No screen-recording permission
   * required.
   */
  scanQrFromClipboard(): Promise<QrScanResult>;

  /**
   * Read the live 6-digit code + countdown.
   *
   * @throws {TotpError} `TOTP_NO_SECRET` | `TOTP_KEYCHAIN_FAILED` | `TOTP_GENERATION_FAILED`
   */
  getCurrentCode(): Promise<TotpCodeInfo>;

  /** Delete the stored secret. Idempotent: no-op if nothing stored. */
  deleteSecret(): Promise<void>;
}

/**
 * The default backing implementation. Combines `TotpStore` (keychain)
 * and `QrScanner` (screen capture) behind the typed `TotpApi`.
 */
class TotpApiImpl implements TotpApi {
  private readonly store: TotpStore;
  private readonly scanner: QrScanner;
  private readonly log: NonNullable<TotpStoreConfig['logger']>;
  private readonly spanEmitter: NonNullable<TotpStoreConfig['spanEmitter']> | null;

  constructor(config: {
    store?: TotpStore;
    scanner?: QrScanner;
    logger?: TotpStoreConfig['logger'];
    spanEmitter?: TotpStoreConfig['spanEmitter'];
  } = {}) {
    this.log =
      config.logger ??
      ((): void => {
        /* default: silent */
      });
    this.spanEmitter = config.spanEmitter ?? null;
    const storeConfig: TotpStoreConfig = {
      ...(config.logger !== undefined ? { logger: config.logger } : {}),
      ...(config.spanEmitter !== undefined ? { spanEmitter: config.spanEmitter } : {}),
    };
    this.store = config.store ?? new TotpStore(storeConfig);
    const scannerConfig: QrScannerConfig = config.logger !== undefined ? { logger: config.logger } : {};
    this.scanner = config.scanner ?? new QrScanner(scannerConfig);
  }

  hasSecret(): Promise<boolean> {
    return this.store.hasSecret();
  }

  getMetadata(): Promise<TotpSecretMetadata | null> {
    return this.store.getMetadata();
  }

  async saveSecret(secret: string, extra: { issuer?: string; account?: string } = {}): Promise<SaveSecretResult> {
    const metadata = await this.store.saveSecret(secret, extra);
    return { saved: true, metadata };
  }

  async scanQrFromScreen(): Promise<QrScanResult> {
    // Outer span captures the full scan -> decode -> save pipeline.
    // The inner store.saveSecret call emits its own `totp.save-secret`
    // span when a setup QR is found and persisted (nested timing).
    const span = this.spanEmitter?.('totp.scan-qr-screen');
    try {
      const result = await this.runScan(() => this.scanner.scanFromScreen());
      span?.finish({ saved: result.saved, ...(result.reason !== undefined ? { reason: result.reason } : {}) });
      return result;
    } catch (err) {
      span?.fail(err);
      throw err;
    }
  }

  async scanQrFromClipboard(): Promise<QrScanResult> {
    const span = this.spanEmitter?.('totp.scan-qr-clipboard');
    try {
      const result = await this.runScan(() => this.scanner.scanFromClipboard());
      span?.finish({ saved: result.saved, ...(result.reason !== undefined ? { reason: result.reason } : {}) });
      return result;
    } catch (err) {
      span?.fail(err);
      throw err;
    }
  }

  getCurrentCode(): Promise<TotpCodeInfo> {
    return this.store.getCurrentCode();
  }

  deleteSecret(): Promise<void> {
    return this.store.deleteSecret();
  }

  // -------------------------------------------------------------------------
  // Internal: shared scan -> parse -> save pipeline.
  // -------------------------------------------------------------------------

  private async runScan(scan: () => Promise<string | null>): Promise<QrScanResult> {
    const decoded = await scan();
    if (decoded === null) {
      return { saved: false, reason: 'no-qr-found' };
    }
    if (!isOtpAuthUri(decoded)) {
      this.log('warn', 'totp: scanned QR is not otpauth', { dataLength: decoded.length });
      return { saved: false, reason: 'not-authenticator-qr' };
    }
    try {
      const metadata = await this.store.saveFromOtpAuthUri(decoded);
      return {
        saved: true,
        ...(metadata.issuer !== undefined ? { issuer: metadata.issuer } : {}),
        ...(metadata.account !== undefined ? { account: metadata.account } : {}),
      };
    } catch (err) {
      if (err instanceof TotpError) {
        if (err.code === TOTP_ERROR_CODES.NOT_AUTHENTICATOR_QR) {
          return { saved: false, reason: 'not-authenticator-qr' };
        }
        if (err.code === TOTP_ERROR_CODES.INVALID_SECRET) {
          return { saved: false, reason: 'invalid-secret' };
        }
        if (err.code === TOTP_ERROR_CODES.KEYCHAIN_FAILED) {
          return { saved: false, reason: 'keychain-failed' };
        }
      }
      throw err;
    }
  }
}

let _instance: TotpApi | null = null;

/**
 * Get the singleton TOTP API. Lazily instantiates on first call.
 *
 * Default backing implementation routes the store + scanner loggers
 * through the lite logging module (per ADR-025), so every `[totp]`
 * line shows up in the unified log stream.
 */
export function getTotpApi(): TotpApi {
  if (_instance === null) {
    const log = getLoggingApi();
    _instance = new TotpApiImpl({
      logger: (level, message, data) => log[level]('totp', message, data),
      // ADR-030: every async TOTP op emits start/finish/fail through
      // the central event log. PORTING.md "chunk: totp-authenticator-v1"
      // commits to spans for save-secret, scan-qr-screen,
      // scan-qr-clipboard, and get-code.
      spanEmitter: (name, data) => log.start(name, data),
    });
  }
  return _instance;
}

/** Reset the singleton (for tests). */
export function _resetTotpApiForTesting(): void {
  _instance = null;
}

/**
 * Override the singleton with a custom implementation (for tests).
 * The provided value is returned by subsequent `getTotpApi()` calls
 * until reset.
 */
export function _setTotpApiForTesting(api: TotpApi): void {
  _instance = api;
}

/**
 * @internal -- exposed so tests that don't want a full custom impl
 * can build an in-process `TotpApiImpl` with stub keychain + scanner.
 */
export function _buildTotpApiForTesting(opts: {
  keychain: KeychainBackend;
  scanner?: QrScanner;
  logger?: TotpStoreConfig['logger'];
}): TotpApi {
  const storeConfig: TotpStoreConfig = {
    keychain: opts.keychain,
    ...(opts.logger !== undefined ? { logger: opts.logger } : {}),
  };
  const store = new TotpStore(storeConfig);
  return new TotpApiImpl({
    store,
    ...(opts.scanner !== undefined ? { scanner: opts.scanner } : {}),
    ...(opts.logger !== undefined ? { logger: opts.logger } : {}),
  });
}
