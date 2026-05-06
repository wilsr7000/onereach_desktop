/**
 * Tools main-process orchestration.
 *
 * Owns:
 *   - IPC handlers for `lite:tools:list/get/add/update/remove/open/open-manager`
 *   - Broadcast of `lite:tools:changed` events to all windows on
 *     mutations (so the manager renderer updates live).
 *   - Wiring `menu-builder.ts` (registers `top:tools` + per-tool items
 *     + the always-present Manage item).
 *   - Wiring the manager window factory.
 *   - Opening tool URLs in the user's default browser via
 *     `shell.openExternal`.
 *
 * Per ADR-019 / Rule 11, this module is the boundary between Electron
 * IPC and the typed `ToolsApi`. Renderers never see `ToolsStore`
 * directly. Per ADR-030, every handler emits an instant
 * `tools.ipc.<verb>` event on entry so renderer-driven activity is
 * observable in /logs.
 */

import { BrowserWindow, ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import {
  getToolsApi,
  ToolsError,
  TOOLS_ERROR_CODES,
  _resetToolsApiForTesting,
  type ToolEntry,
} from './api.js';
import { TOOLS_EVENTS } from './events.js';
import { initMenuBuilder, teardownMenuBuilder } from './menu-builder.js';
import { openManagerWindow, closeManagerWindow } from './manager-window.js';
import { getLoggingApi } from '../logging/api.js';

// ---------------------------------------------------------------------------
// IPC channel names. All prefixed `lite:tools:` per Rule 3.
// ---------------------------------------------------------------------------

export const TOOLS_IPC = {
  LIST: 'lite:tools:list',
  GET: 'lite:tools:get',
  ADD: 'lite:tools:add',
  UPDATE: 'lite:tools:update',
  REMOVE: 'lite:tools:remove',
  OPEN: 'lite:tools:open',
  OPEN_MANAGER: 'lite:tools:open-manager',
  CHANGED: 'lite:tools:changed',
} as const;

// ---------------------------------------------------------------------------
// Init / teardown
// ---------------------------------------------------------------------------

export interface InitToolsOptions {
  /** Path to the bundled preload-lite.js (used by the manager window). */
  preloadPath: string;
  /** Path to the bundled tools-manager.html. */
  managerHtmlPath: string;
  /** Resolver for the parent window. Called on each manager open. */
  getParentWindow: () => BrowserWindow | null;
  /** Optional logger -- routed through lite logging by default. */
  logger?: {
    info: (message: string, data?: unknown) => void;
    warn: (message: string, data?: unknown) => void;
    error: (message: string, data?: unknown) => void;
  };
}

export interface ToolsHandle {
  /** Tear down IPC handlers, menu subscriptions, and any open windows. Idempotent. */
  teardown(): void;
  /** Open (or focus) the manager window. */
  openManager(): void;
}

let registered = false;
let initOptions: InitToolsOptions | null = null;
let unsubscribeChange: (() => void) | null = null;

export function initTools(opts: InitToolsOptions): ToolsHandle {
  const log = opts.logger ?? {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };

  if (registered) {
    return { teardown: teardownInternal, openManager: openManagerFromHandle };
  }
  initOptions = opts;

  const api = getToolsApi();

  // ── IPC handlers ───────────────────────────────────────────────────────

  ipcMain.handle(TOOLS_IPC.LIST, async (): Promise<ToolEntry[]> => {
    getLoggingApi().event(TOOLS_EVENTS.IPC_LIST);
    return api.list();
  });

  ipcMain.handle(
    TOOLS_IPC.GET,
    async (_event: IpcMainInvokeEvent, payload: { id?: unknown }): Promise<ToolEntry | null> => {
      getLoggingApi().event(TOOLS_EVENTS.IPC_GET);
      const id = validateNonEmptyString(payload?.id, 'id');
      return api.get(id);
    }
  );

  ipcMain.handle(
    TOOLS_IPC.ADD,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<ToolEntry> => {
      getLoggingApi().event(TOOLS_EVENTS.IPC_ADD);
      const input = validateAddPayload(payload);
      try {
        const entry = await api.add(input);
        log.info('add ok', { id: entry.id });
        return entry;
      } catch (err) {
        if (err instanceof ToolsError) {
          log.warn('add rejected', { code: err.code, message: err.message });
          throw new Error(JSON.stringify({ __toolsError: err.toJSON() }));
        }
        log.error('add unexpected error', { error: (err as Error).message });
        throw err;
      }
    }
  );

  ipcMain.handle(
    TOOLS_IPC.UPDATE,
    async (
      _event: IpcMainInvokeEvent,
      payload: { id?: unknown; patch?: unknown }
    ): Promise<ToolEntry> => {
      getLoggingApi().event(TOOLS_EVENTS.IPC_UPDATE);
      const id = validateNonEmptyString(payload?.id, 'id');
      const patch = validatePatchPayload(payload?.patch);
      try {
        const updated = await api.update(id, patch);
        log.info('update ok', { id });
        return updated;
      } catch (err) {
        if (err instanceof ToolsError) {
          log.warn('update rejected', { code: err.code, message: err.message });
          throw new Error(JSON.stringify({ __toolsError: err.toJSON() }));
        }
        log.error('update unexpected error', { error: (err as Error).message });
        throw err;
      }
    }
  );

  ipcMain.handle(
    TOOLS_IPC.REMOVE,
    async (_event: IpcMainInvokeEvent, payload: { id?: unknown }): Promise<{ ok: true }> => {
      getLoggingApi().event(TOOLS_EVENTS.IPC_REMOVE);
      const id = validateNonEmptyString(payload?.id, 'id');
      try {
        await api.remove(id);
        log.info('remove ok', { id });
        return { ok: true };
      } catch (err) {
        if (err instanceof ToolsError) {
          log.warn('remove rejected', { code: err.code, message: err.message });
          throw new Error(JSON.stringify({ __toolsError: err.toJSON() }));
        }
        log.error('remove unexpected error', { error: (err as Error).message });
        throw err;
      }
    }
  );

  ipcMain.handle(
    TOOLS_IPC.OPEN,
    async (_event: IpcMainInvokeEvent, payload: { id?: unknown }): Promise<{ ok: true }> => {
      getLoggingApi().event(TOOLS_EVENTS.IPC_OPEN);
      const id = validateNonEmptyString(payload?.id, 'id');
      const entry = await api.get(id);
      if (entry === null) {
        const err = new ToolsError({
          code: TOOLS_ERROR_CODES.NOT_FOUND,
          message: `Tool not found: ${id}`,
          context: { op: 'open', id },
          remediation: 'Refresh the list -- the tool may have been removed.',
        });
        throw new Error(JSON.stringify({ __toolsError: err.toJSON() }));
      }
      openExternal(entry);
      return { ok: true };
    }
  );

  ipcMain.handle(TOOLS_IPC.OPEN_MANAGER, async (): Promise<{ ok: true }> => {
    getLoggingApi().event(TOOLS_EVENTS.IPC_OPEN_MANAGER);
    openManagerFromHandle();
    return { ok: true };
  });

  // ── Menu builder ───────────────────────────────────────────────────────

  initMenuBuilder({
    onOpenEntry: (entry) => openExternal(entry),
    onOpenManager: () => openManagerFromHandle(),
  });

  // ── Live cross-window updates ──────────────────────────────────────────

  unsubscribeChange = api.onChange((entries) => {
    for (const win of BrowserWindow.getAllWindows()) {
      try {
        if (!win.isDestroyed()) {
          win.webContents.send(TOOLS_IPC.CHANGED, { entries });
        }
      } catch (err) {
        log.warn('broadcast changed failed', {
          windowId: win.id,
          error: (err as Error).message,
        });
      }
    }
  });

  registered = true;
  log.info('tools initialized', {});
  return { teardown: teardownInternal, openManager: openManagerFromHandle };
}

function teardownInternal(): void {
  if (!registered) return;
  try {
    ipcMain.removeHandler(TOOLS_IPC.LIST);
    ipcMain.removeHandler(TOOLS_IPC.GET);
    ipcMain.removeHandler(TOOLS_IPC.ADD);
    ipcMain.removeHandler(TOOLS_IPC.UPDATE);
    ipcMain.removeHandler(TOOLS_IPC.REMOVE);
    ipcMain.removeHandler(TOOLS_IPC.OPEN);
    ipcMain.removeHandler(TOOLS_IPC.OPEN_MANAGER);
  } catch {
    // best-effort
  }
  if (unsubscribeChange !== null) {
    try {
      unsubscribeChange();
    } catch {
      // best-effort
    }
    unsubscribeChange = null;
  }
  try {
    teardownMenuBuilder();
  } catch {
    // best-effort
  }
  try {
    closeManagerWindow();
  } catch {
    // best-effort
  }
  registered = false;
  initOptions = null;
}

function openManagerFromHandle(): void {
  if (initOptions === null) {
    getLoggingApi().warn('tools', 'openManager called before initTools');
    return;
  }
  openManagerWindow({
    parent: initOptions.getParentWindow(),
    htmlPath: initOptions.managerHtmlPath,
    preloadPath: initOptions.preloadPath,
  });
  getLoggingApi().event(TOOLS_EVENTS.MANAGE_OPENED);
}

/** @internal -- exposed for tests. */
export function _isToolsRegisteredForTesting(): boolean {
  return registered;
}

/** @internal -- exposed for tests so they can re-init cleanly. */
export function _resetToolsRegistrationForTesting(): void {
  teardownInternal();
  _resetToolsApiForTesting();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function openExternal(entry: ToolEntry): void {
  void shell.openExternal(entry.url).catch((err: unknown) => {
    getLoggingApi().warn('tools', 'shell.openExternal rejected', {
      id: entry.id,
      error: (err as Error).message,
    });
  });
}

function validateNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function validateAddPayload(value: unknown): Partial<ToolEntry> & Pick<ToolEntry, 'label' | 'url'> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('add payload must be an object');
  }
  const v = value as Record<string, unknown>;
  const label = validateNonEmptyString(v['label'], 'label');
  const url = validateNonEmptyString(v['url'], 'url');
  return { ...(v as Partial<ToolEntry>), label, url };
}

function validatePatchPayload(value: unknown): Partial<ToolEntry> {
  if (value === null || value === undefined) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('patch must be an object');
  }
  return value as Partial<ToolEntry>;
}
