/**
 * Downloads module — IPC channels for the picker window.
 *
 * Two channels:
 *   - `lite:download-picker:bootstrap` — picker renderer calls this on
 *     boot to fetch the captured-file summary + spaces list.
 *   - `lite:download-picker:resolve`   — picker renderer fires this
 *     when the user picks a space (or cancels). Main closes the
 *     window and resolves the outer Promise the orchestrator awaits.
 *
 * Channel naming follows the same `lite:<module>:<action>` rule used
 * by every other module's IPC (see `lite/LITE-RULES.md`). Bootstrap
 * payloads are stashed under the per-download id by `picker-window.ts`
 * at window-open time; this file just relays them.
 *
 * @internal -- main-process orchestrator (`main.ts`) calls
 * `registerDownloadsIpc` once at boot.
 */

import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { readBootstrap, resolvePicker } from './picker-window.js';
import type { PickerBootstrap, PickerResult } from './types.js';
import { getLoggingApi } from '../logging/api.js';
import { DOWNLOADS_EVENTS } from './events.js';

export const DOWNLOADS_IPC = {
  /** Renderer -> main: fetch the captured-file + spaces bootstrap. */
  PICKER_BOOTSTRAP: 'lite:download-picker:bootstrap',
  /** Renderer -> main: settle the picker promise with the user's pick. */
  PICKER_RESOLVE: 'lite:download-picker:resolve',
} as const;

export interface DownloadsIpcLogger {
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
}

interface RegisterOpts {
  logger?: DownloadsIpcLogger;
}

/**
 * Install the picker IPC handlers. Idempotent at the orchestrator
 * level (`main.ts` only calls it once at boot).
 */
export function registerDownloadsIpc(opts: RegisterOpts = {}): void {
  const log = opts.logger ?? defaultLogger();

  ipcMain.handle(
    DOWNLOADS_IPC.PICKER_BOOTSTRAP,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<PickerBootstrap> => {
      getLoggingApi().event(DOWNLOADS_EVENTS.IPC_PICKER_BOOTSTRAP);
      const downloadId = extractDownloadId(payload);
      if (downloadId === null) {
        log.warn('picker bootstrap rejected: missing downloadId', { payload });
        throw new Error('downloadId is required');
      }
      const bootstrap = readBootstrap(downloadId);
      if (bootstrap === null) {
        log.warn('picker bootstrap: no payload stashed for downloadId', {
          downloadId,
        });
        throw new Error(`no picker bootstrap stashed for ${downloadId}`);
      }
      return bootstrap;
    }
  );

  ipcMain.handle(
    DOWNLOADS_IPC.PICKER_RESOLVE,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<{ ok: true }> => {
      getLoggingApi().event(DOWNLOADS_EVENTS.IPC_PICKER_RESOLVE);
      const { downloadId, result } = extractResolvePayload(payload);
      if (downloadId === null) {
        log.warn('picker resolve rejected: missing downloadId', { payload });
        throw new Error('downloadId is required');
      }
      try {
        resolvePicker(downloadId, result);
      } catch (err) {
        log.error('picker resolve threw', {
          downloadId,
          error: (err as Error).message,
        });
        throw err;
      }
      return { ok: true };
    }
  );
}

/**
 * Uninstall the picker IPC handlers. Useful for hot reload + tests.
 * Idempotent.
 */
export function unregisterDownloadsIpc(): void {
  ipcMain.removeHandler(DOWNLOADS_IPC.PICKER_BOOTSTRAP);
  ipcMain.removeHandler(DOWNLOADS_IPC.PICKER_RESOLVE);
}

// ─── helpers ───────────────────────────────────────────────────────────────

function extractDownloadId(payload: unknown): string | null {
  if (payload === null || typeof payload !== 'object') return null;
  const id = (payload as { downloadId?: unknown }).downloadId;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

function extractResolvePayload(payload: unknown): {
  downloadId: string | null;
  result: PickerResult | null;
} {
  if (payload === null || typeof payload !== 'object') {
    return { downloadId: null, result: null };
  }
  const downloadId = extractDownloadId(payload);
  const rawResult = (payload as { result?: unknown }).result;
  if (rawResult === null || rawResult === undefined) {
    return { downloadId, result: null };
  }
  if (typeof rawResult !== 'object') {
    return { downloadId, result: null };
  }
  const spaceId = (rawResult as { spaceId?: unknown }).spaceId;
  const spaceName = (rawResult as { spaceName?: unknown }).spaceName;
  if (
    typeof spaceId !== 'string' ||
    spaceId.length === 0 ||
    typeof spaceName !== 'string'
  ) {
    return { downloadId, result: null };
  }
  return { downloadId, result: { spaceId, spaceName } };
}

function defaultLogger(): DownloadsIpcLogger {
  // Falls back to console when no logger is wired; main.ts always
  // injects the central logger in production. Kept defensive so unit
  // tests can register the IPC without first booting the log queue.
  return {
    warn: (message: string, data?: unknown) => {
      // eslint-disable-next-line no-console
      console.warn('[downloads/ipc]', message, data ?? '');
    },
    error: (message: string, data?: unknown) => {
      // eslint-disable-next-line no-console
      console.error('[downloads/ipc]', message, data ?? '');
    },
  };
}
