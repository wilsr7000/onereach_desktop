/**
 * Settings main-process orchestration.
 *
 * Owns:
 *   - The Settings window factory (single-instance) -- exposed via the
 *     `open()` method on `SettingsApi`.
 *   - One IPC channel: `lite:settings:open` -- lets the renderer
 *     request open from anywhere (e.g. a future "Manage 2FA" link in
 *     the placeholder window).
 *
 * Per ADR-031, the Settings window itself is a thin BrowserWindow that
 * loads `settings.html`. All section UI lives in `settings/sections/*.ts`
 * and consumes other modules' public APIs (e.g. `getTotpApi()`); this
 * module knows nothing about Two-Factor specifically.
 */

import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { _setSettingsApiForTesting, _resetSettingsApiForTesting, type SettingsApi } from './api.js';
import { openSettingsWindow, closeSettingsWindow } from './window.js';

// ---------------------------------------------------------------------------
// IPC channel name. Per Rule 3, prefixed `lite:settings:`.
// ---------------------------------------------------------------------------

export const SETTINGS_IPC = {
  OPEN: 'lite:settings:open',
} as const;

// ---------------------------------------------------------------------------
// Init / teardown
// ---------------------------------------------------------------------------

export interface InitSettingsOptions {
  /** Path to the bundled preload-lite.js. */
  preloadPath: string;
  /** Path to the bundled settings.html. */
  htmlPath: string;
  /** Resolver for the parent window. Called each time Settings opens. */
  getParentWindow: () => BrowserWindow | null;
  /** Optional logger (defaults to silent). */
  logger?: {
    info: (message: string, data?: unknown) => void;
    warn: (message: string, data?: unknown) => void;
    error: (message: string, data?: unknown) => void;
  };
}

export interface SettingsHandle {
  /**
   * Open (or focus) the Settings window. Convenience for menu wiring.
   * Optional `sectionId` deep-links to a specific section.
   */
  open(sectionId?: string): void;
  /** Tear down IPC handlers + close the window. Idempotent. */
  teardown(): void;
}

let registered = false;
let initOptions: InitSettingsOptions | null = null;

/**
 * Register IPC handlers and install the BrowserWindow-backed
 * `SettingsApi` singleton. Safe to call multiple times -- idempotent.
 */
export function initSettings(opts: InitSettingsOptions): SettingsHandle {
  const log = opts.logger ?? {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
  initOptions = opts;

  const handle: SettingsHandle = {
    open: (sectionId?: string) => {
      if (initOptions === null) {
        log.warn('open() called before init', {});
        return;
      }
      try {
        const cfg: Parameters<typeof openSettingsWindow>[0] = {
          parent: initOptions.getParentWindow(),
          htmlPath: initOptions.htmlPath,
          preloadPath: initOptions.preloadPath,
        };
        if (typeof sectionId === 'string' && sectionId.length > 0) {
          cfg.sectionId = sectionId;
        }
        openSettingsWindow(cfg);
        log.info('settings window opened', sectionId !== undefined ? { sectionId } : {});
      } catch (err) {
        log.error('failed to open settings window', { error: (err as Error).message });
      }
    },
    teardown: teardownInternal,
  };

  // Install the real API singleton -- replaces the no-op placeholder
  // that `getSettingsApi()` returns until init runs.
  const api: SettingsApi = { open: handle.open };
  _setSettingsApiForTesting(api);

  if (registered) return handle;

  ipcMain.handle(
    SETTINGS_IPC.OPEN,
    (_event: IpcMainInvokeEvent, payload?: { sectionId?: unknown }): { ok: true } => {
      const sectionId =
        payload !== undefined && typeof payload.sectionId === 'string' && payload.sectionId.length > 0
          ? payload.sectionId
          : undefined;
      handle.open(sectionId);
      return { ok: true };
    }
  );

  registered = true;
  log.info('settings initialized', {});
  return handle;
}

function teardownInternal(): void {
  if (!registered) return;
  try {
    ipcMain.removeHandler(SETTINGS_IPC.OPEN);
  } catch {
    // best-effort
  }
  registered = false;
  initOptions = null;
  closeSettingsWindow();
  // Reset the singleton so any post-teardown calls hit the safe no-op
  // implementation again.
  _resetSettingsApiForTesting();
}

/** @internal -- exposed for tests. */
export function _isSettingsRegisteredForTesting(): boolean {
  return registered;
}

/** @internal -- exposed for tests so they can re-init cleanly. */
export function _resetSettingsRegistrationForTesting(): void {
  teardownInternal();
}
