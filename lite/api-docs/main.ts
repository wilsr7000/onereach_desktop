/**
 * API Docs main-process orchestration (ADR-035).
 *
 * Owns:
 *   - The API Reference window factory (single-instance) -- exposed
 *     via the `open()` method on `ApiDocsApi`.
 *   - One IPC channel: `lite:api-docs:open` -- lets any renderer
 *     request open (the Settings "Developer" section's button uses
 *     it).
 *
 * The doc content itself is bundled into the renderer (the
 * `manifest.generated.ts` static module). This module DOES NOT serve
 * the content over IPC -- the renderer imports it directly. Only
 * window control crosses the process boundary.
 *
 * @internal -- consumers go through `getApiDocsApi()`.
 */

import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron';
import {
  _setApiDocsApiForTesting,
  _resetApiDocsApiForTesting,
  type ApiDocsApi,
} from './api.js';
import { openApiDocsWindow, closeApiDocsWindow } from './window.js';

// IPC channel name. Per Rule 3, prefixed `lite:api-docs:`.
export const API_DOCS_IPC = {
  OPEN: 'lite:api-docs:open',
} as const;

export interface InitApiDocsOptions {
  /** Path to the bundled preload-lite.js. */
  preloadPath: string;
  /** Path to the bundled api-docs/index.html. */
  htmlPath: string;
  /** Resolver for the parent window. Called each time the docs window opens. */
  getParentWindow: () => BrowserWindow | null;
  /** Optional logger (defaults to silent). */
  logger?: {
    info: (message: string, data?: unknown) => void;
    warn: (message: string, data?: unknown) => void;
    error: (message: string, data?: unknown) => void;
  };
}

export interface ApiDocsHandle {
  /** Open (or focus) the API Reference window. */
  open(): void;
  /** Tear down IPC handlers + close the window. Idempotent. */
  teardown(): void;
}

let registered = false;
let initOptions: InitApiDocsOptions | null = null;

/**
 * Register IPC handlers and install the BrowserWindow-backed
 * `ApiDocsApi` singleton. Safe to call multiple times -- idempotent.
 */
export function initApiDocs(opts: InitApiDocsOptions): ApiDocsHandle {
  const log = opts.logger ?? {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
  initOptions = opts;

  const handle: ApiDocsHandle = {
    open: () => {
      if (initOptions === null) {
        log.warn('open() called before init', {});
        return;
      }
      try {
        openApiDocsWindow({
          parent: initOptions.getParentWindow(),
          htmlPath: initOptions.htmlPath,
          preloadPath: initOptions.preloadPath,
        });
        log.info('api-docs window opened', {});
      } catch (err) {
        log.error('failed to open api-docs window', { error: (err as Error).message });
      }
    },
    teardown: teardownInternal,
  };

  // Install the real API singleton -- replaces the no-op placeholder
  // that `getApiDocsApi()` returns until init runs.
  const api: ApiDocsApi = { open: handle.open };
  _setApiDocsApiForTesting(api);

  if (registered) return handle;

  ipcMain.handle(API_DOCS_IPC.OPEN, (_event: IpcMainInvokeEvent): { ok: true } => {
    handle.open();
    return { ok: true };
  });

  registered = true;
  log.info('api-docs initialized', {});
  return handle;
}

function teardownInternal(): void {
  if (!registered) return;
  try {
    ipcMain.removeHandler(API_DOCS_IPC.OPEN);
  } catch {
    // best-effort
  }
  registered = false;
  initOptions = null;
  closeApiDocsWindow();
  _resetApiDocsApiForTesting();
}

/** @internal -- exposed for tests. */
export function _isApiDocsRegisteredForTesting(): boolean {
  return registered;
}

/** @internal -- exposed for tests so they can re-init cleanly. */
export function _resetApiDocsRegistrationForTesting(): void {
  teardownInternal();
}
