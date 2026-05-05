/**
 * TOTP main-process orchestration.
 *
 * Owns:
 *   - IPC handlers for has-secret / get-metadata / save-secret /
 *     scan-qr-screen / scan-qr-clipboard / get-current-code /
 *     delete-secret. Consumed by the Settings -> Two-Factor section
 *     (ADR-031). The standalone Authenticator window from ADR-027 was
 *     removed in ADR-031 -- this module is now data-only.
 *
 * Per ADR-027:
 *   - The TOTP secret VALUE crosses IPC only on the way IN
 *     (`save-secret` from manual-entry input). Never round-tripped
 *     back to the renderer.
 *   - QR-scan IPC handlers do scan + parse + save in one operation;
 *     the secret is born in main and stays in main.
 *   - Errors are surfaced to the renderer as JSON-encoded messages
 *     with an `__totpError` sentinel so the renderer can reconstruct
 *     the structured error.
 */

import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { getTotpApi, TotpError } from './api.js';
import { getLoggingApi } from '../logging/api.js';
import type {
  QrScanResult,
  SaveSecretResult,
  TotpCodeInfo,
  TotpSecretMetadata,
} from './types.js';

// ---------------------------------------------------------------------------
// IPC channel names. All prefixed `lite:totp:` per Rule 3.
// ---------------------------------------------------------------------------

export const TOTP_IPC = {
  HAS_SECRET: 'lite:totp:has-secret',
  GET_METADATA: 'lite:totp:get-metadata',
  SAVE_SECRET: 'lite:totp:save-secret',
  SCAN_QR_SCREEN: 'lite:totp:scan-qr-screen',
  SCAN_QR_CLIPBOARD: 'lite:totp:scan-qr-clipboard',
  GET_CURRENT_CODE: 'lite:totp:get-current-code',
  DELETE_SECRET: 'lite:totp:delete-secret',
} as const;

// ---------------------------------------------------------------------------
// Init / teardown
// ---------------------------------------------------------------------------

export interface InitTotpOptions {
  /** Optional logger (defaults to silent). */
  logger?: {
    info: (message: string, data?: unknown) => void;
    warn: (message: string, data?: unknown) => void;
    error: (message: string, data?: unknown) => void;
  };
}

export interface TotpHandle {
  /**
   * Tear down IPC handlers. Idempotent.
   *
   * Note: `openAuthenticator` was removed in ADR-031 -- the standalone
   * Authenticator window has been replaced by the Two-Factor section
   * inside the Settings window. The TOTP module now exposes only IPC
   * handlers consumed by `lite/settings/sections/two-factor.ts`.
   */
  teardown(): void;
}

let registered = false;

/**
 * Register IPC handlers. Safe to call multiple times -- idempotent.
 */
export function initTotp(opts: InitTotpOptions = {}): TotpHandle {
  const log = opts.logger ?? {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };

  const handle: TotpHandle = {
    teardown: teardownInternal,
  };

  if (registered) return handle;

  const totp = getTotpApi();

  // ADR-026: each handler emits an instant `totp.ipc.<verb>` event on
  // entry. The downstream API call may emit its own spans.

  ipcMain.handle(TOTP_IPC.HAS_SECRET, async (): Promise<{ hasSecret: boolean }> => {
    getLoggingApi().event('totp.ipc.has-secret');
    return { hasSecret: await totp.hasSecret() };
  });

  ipcMain.handle(TOTP_IPC.GET_METADATA, async (): Promise<{ metadata: TotpSecretMetadata | null }> => {
    getLoggingApi().event('totp.ipc.get-metadata');
    return { metadata: await totp.getMetadata() };
  });

  ipcMain.handle(
    TOTP_IPC.SAVE_SECRET,
    async (
      _event: IpcMainInvokeEvent,
      payload: { secret?: unknown; issuer?: unknown; account?: unknown }
    ): Promise<SaveSecretResult> => {
      // Don't include the secret value in the event data -- ADR-027
      // says the secret stays main-side. Just record presence.
      getLoggingApi().event('totp.ipc.save-secret');
      const secret = validateString(payload?.secret, 'secret');
      const extra: { issuer?: string; account?: string } = {};
      if (typeof payload?.issuer === 'string' && payload.issuer.length > 0) extra.issuer = payload.issuer;
      if (typeof payload?.account === 'string' && payload.account.length > 0) extra.account = payload.account;
      try {
        const result = await totp.saveSecret(secret, extra);
        log.info('saveSecret ok', { secretLength: secret.length });
        return result;
      } catch (err) {
        rethrowAsIpc(err, log, 'saveSecret');
      }
    }
  );

  ipcMain.handle(TOTP_IPC.SCAN_QR_SCREEN, async (): Promise<QrScanResult> => {
    getLoggingApi().event('totp.ipc.scan-qr-screen');
    try {
      const result = await totp.scanQrFromScreen();
      log.info('scanQrFromScreen complete', { saved: result.saved, reason: result.reason });
      return result;
    } catch (err) {
      rethrowAsIpc(err, log, 'scanQrFromScreen');
    }
  });

  ipcMain.handle(TOTP_IPC.SCAN_QR_CLIPBOARD, async (): Promise<QrScanResult> => {
    getLoggingApi().event('totp.ipc.scan-qr-clipboard');
    try {
      const result = await totp.scanQrFromClipboard();
      log.info('scanQrFromClipboard complete', { saved: result.saved, reason: result.reason });
      return result;
    } catch (err) {
      rethrowAsIpc(err, log, 'scanQrFromClipboard');
    }
  });

  ipcMain.handle(TOTP_IPC.GET_CURRENT_CODE, async (): Promise<TotpCodeInfo> => {
    getLoggingApi().event('totp.ipc.get-current-code');
    try {
      return await totp.getCurrentCode();
    } catch (err) {
      rethrowAsIpc(err, log, 'getCurrentCode');
    }
  });

  ipcMain.handle(TOTP_IPC.DELETE_SECRET, async (): Promise<{ ok: true }> => {
    getLoggingApi().event('totp.ipc.delete-secret');
    try {
      await totp.deleteSecret();
      log.info('deleteSecret ok', {});
      return { ok: true };
    } catch (err) {
      rethrowAsIpc(err, log, 'deleteSecret');
    }
  });

  registered = true;
  log.info('totp initialized', {});
  return handle;
}

function teardownInternal(): void {
  if (!registered) return;
  for (const channel of Object.values(TOTP_IPC)) {
    try {
      ipcMain.removeHandler(channel);
    } catch {
      // best-effort
    }
  }
  registered = false;
}

/** @internal -- exposed for tests. */
export function _isTotpRegisteredForTesting(): boolean {
  return registered;
}

/** @internal -- exposed for tests so they can re-init cleanly. */
export function _resetTotpRegistrationForTesting(): void {
  teardownInternal();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validateString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${fieldName} must be a non-empty string`);
  }
  return value;
}

/**
 * Rethrow a TotpError as an IPC-serializable error: encode the
 * structured fields in the message so the renderer's `parseError`
 * helper can reconstruct them.
 */
function rethrowAsIpc(
  err: unknown,
  log: NonNullable<InitTotpOptions['logger']>,
  op: string
): never {
  if (err instanceof TotpError) {
    log.warn(`${op} rejected`, { code: err.code, message: err.message });
    throw new Error(JSON.stringify({ __totpError: err.toJSON() }));
  }
  log.error(`${op} unexpected error`, { error: (err as Error).message });
  throw err;
}
