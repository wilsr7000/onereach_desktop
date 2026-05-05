/**
 * IDW main-process orchestration.
 *
 * Owns:
 *   - IPC handlers for `lite:idw:list/list-by-kind/get/add/update/remove/open/open-store`
 *   - Broadcast of `lite:idw:changed` events to all windows on
 *     mutations (so the catalog renderer + Settings section update
 *     live, ADR-032 review-fix #8)
 *   - Wiring `menu-builder.ts` (registers `top:idw` placeholder +
 *     subscribes to `IdwApi.onChange`)
 *   - Wiring the shared placeholder browser singleton + the catalog
 *     window factory
 *
 * Per ADR-019 / Rule 11, this module is the boundary between Electron
 * IPC and the typed `IdwApi`. Renderers never see `IdwStore` directly.
 *
 * Per ADR-030, every handler emits an instant `idw.ipc.<verb>` event
 * on entry so renderer-driven activity is observable in `/logs`.
 */

import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron';
import {
  getIdwApi,
  IdwError,
  IDW_ERROR_CODES,
  _resetIdwApiForTesting,
  type IdwEntry,
  type AgentKind,
} from './api.js';
import { IDW_EVENTS } from './events.js';
import { initMenuBuilder, teardownMenuBuilder } from './menu-builder.js';
import { openAgentInBrowser, closeAgentBrowser } from './browser-window.js';
import { openCatalogWindow, closeCatalogWindow } from './catalog-window.js';
import { getLoggingApi } from '../logging/api.js';
import { getSettingsApi } from '../settings/api.js';
import { getMainWindowApi } from '../main-window/api.js';

// ---------------------------------------------------------------------------
// IPC channel names. All prefixed `lite:idw:` per Rule 3.
// ---------------------------------------------------------------------------

export const IDW_IPC = {
  LIST: 'lite:idw:list',
  LIST_BY_KIND: 'lite:idw:list-by-kind',
  GET: 'lite:idw:get',
  ADD: 'lite:idw:add',
  UPDATE: 'lite:idw:update',
  REMOVE: 'lite:idw:remove',
  OPEN: 'lite:idw:open',
  OPEN_STORE: 'lite:idw:open-store',
  CHANGED: 'lite:idw:changed',
} as const;

// ---------------------------------------------------------------------------
// Init / teardown
// ---------------------------------------------------------------------------

export interface InitIdwOptions {
  /** Path to the bundled preload-lite.js (used by the catalog window). */
  preloadPath: string;
  /** Path to the bundled idw-store.html (catalog window). */
  catalogHtmlPath: string;
  /** Resolver for the parent window. Called on each catalog open. */
  getParentWindow: () => BrowserWindow | null;
  /** Optional logger -- routed through lite logging by default. */
  logger?: {
    info: (message: string, data?: unknown) => void;
    warn: (message: string, data?: unknown) => void;
    error: (message: string, data?: unknown) => void;
  };
}

export interface IdwHandle {
  /** Tear down IPC handlers, menu subscriptions, and any open windows. Idempotent. */
  teardown(): void;
}

let registered = false;
let initOptions: InitIdwOptions | null = null;
let unsubscribeChange: (() => void) | null = null;

/**
 * Register IPC handlers, register the top:idw menu placeholder, and
 * subscribe the menu builder to IdwApi.onChange. Safe to call
 * multiple times -- subsequent calls are no-ops.
 */
export function initIdw(opts: InitIdwOptions): IdwHandle {
  const log = opts.logger ?? {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };

  if (registered) {
    return { teardown: teardownInternal };
  }
  initOptions = opts;

  const api = getIdwApi();

  // ── IPC handlers ───────────────────────────────────────────────────────

  ipcMain.handle(IDW_IPC.LIST, async (): Promise<IdwEntry[]> => {
    getLoggingApi().event(IDW_EVENTS.IPC_LIST);
    return api.list();
  });

  ipcMain.handle(
    IDW_IPC.LIST_BY_KIND,
    async (_event: IpcMainInvokeEvent, payload: { kind?: unknown }): Promise<IdwEntry[]> => {
      getLoggingApi().event(IDW_EVENTS.IPC_LIST_BY_KIND);
      const kind = validateKind(payload?.kind);
      return api.listByKind(kind);
    }
  );

  ipcMain.handle(
    IDW_IPC.GET,
    async (_event: IpcMainInvokeEvent, payload: { id?: unknown }): Promise<IdwEntry | null> => {
      getLoggingApi().event(IDW_EVENTS.IPC_GET);
      const id = validateNonEmptyString(payload?.id, 'id');
      return api.get(id);
    }
  );

  ipcMain.handle(
    IDW_IPC.ADD,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<{ entry: IdwEntry; wasUpdate: boolean }> => {
      getLoggingApi().event(IDW_EVENTS.IPC_ADD);
      const input = validateAddPayload(payload);
      try {
        const result = await api.add(input);
        log.info('add ok', { id: result.entry.id, kind: result.entry.kind, wasUpdate: result.wasUpdate });
        return result;
      } catch (err) {
        if (err instanceof IdwError) {
          log.warn('add rejected', { code: err.code, message: err.message });
          throw new Error(JSON.stringify({ __idwError: err.toJSON() }));
        }
        log.error('add unexpected error', { error: (err as Error).message });
        throw err;
      }
    }
  );

  ipcMain.handle(
    IDW_IPC.UPDATE,
    async (
      _event: IpcMainInvokeEvent,
      payload: { id?: unknown; patch?: unknown }
    ): Promise<IdwEntry> => {
      getLoggingApi().event(IDW_EVENTS.IPC_UPDATE);
      const id = validateNonEmptyString(payload?.id, 'id');
      const patch = validatePatchPayload(payload?.patch);
      try {
        const updated = await api.update(id, patch);
        log.info('update ok', { id });
        return updated;
      } catch (err) {
        if (err instanceof IdwError) {
          log.warn('update rejected', { code: err.code, message: err.message });
          throw new Error(JSON.stringify({ __idwError: err.toJSON() }));
        }
        log.error('update unexpected error', { error: (err as Error).message });
        throw err;
      }
    }
  );

  ipcMain.handle(
    IDW_IPC.REMOVE,
    async (_event: IpcMainInvokeEvent, payload: { id?: unknown }): Promise<{ ok: true }> => {
      getLoggingApi().event(IDW_EVENTS.IPC_REMOVE);
      const id = validateNonEmptyString(payload?.id, 'id');
      try {
        await api.remove(id);
        log.info('remove ok', { id });
        return { ok: true };
      } catch (err) {
        if (err instanceof IdwError) {
          log.warn('remove rejected', { code: err.code, message: err.message });
          throw new Error(JSON.stringify({ __idwError: err.toJSON() }));
        }
        log.error('remove unexpected error', { error: (err as Error).message });
        throw err;
      }
    }
  );

  ipcMain.handle(
    IDW_IPC.OPEN,
    async (_event: IpcMainInvokeEvent, payload: { id?: unknown }): Promise<{ ok: true }> => {
      getLoggingApi().event(IDW_EVENTS.IPC_OPEN);
      const id = validateNonEmptyString(payload?.id, 'id');
      const entry = await api.get(id);
      if (entry === null) {
        // Surface as IdwError so the renderer's parseError works.
        const err = new IdwError({
          code: IDW_ERROR_CODES.NOT_FOUND,
          message: `Entry not found: ${id}`,
          context: { op: 'open', id },
          remediation: 'Refresh the list -- the entry may have been removed.',
        });
        throw new Error(JSON.stringify({ __idwError: err.toJSON() }));
      }
      await openEntryAsTab(entry);
      return { ok: true };
    }
  );

  ipcMain.handle(IDW_IPC.OPEN_STORE, async (): Promise<{ ok: true }> => {
    getLoggingApi().event(IDW_EVENTS.IPC_OPEN_STORE);
    if (initOptions === null) {
      throw new Error('initIdw must be called before opening the catalog window');
    }
    openCatalogWindow({
      parent: initOptions.getParentWindow(),
      htmlPath: initOptions.catalogHtmlPath,
      preloadPath: initOptions.preloadPath,
    });
    getLoggingApi().event(IDW_EVENTS.STORE_OPENED);
    return { ok: true };
  });

  // ── Menu builder ───────────────────────────────────────────────────────

  initMenuBuilder({
    onOpenEntry: (entry) => {
      void openEntryAsTab(entry);
    },
    onOpenSettings: () => {
      // Open Settings to the IDWs section. The renderer reads
      // ?section=idws on load and activates that section.
      getSettingsApi().open('idws');
    },
  });

  // ── Live cross-window updates ──────────────────────────────────────────
  //
  // When the store changes, broadcast `lite:idw:changed` to every
  // open BrowserWindow. The catalog renderer + Settings section
  // subscribe (review-fix #8).
  unsubscribeChange = api.onChange((entries) => {
    for (const win of BrowserWindow.getAllWindows()) {
      try {
        if (!win.isDestroyed()) {
          win.webContents.send(IDW_IPC.CHANGED, { entries });
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
  log.info('idw initialized', {});
  return { teardown: teardownInternal };
}

function teardownInternal(): void {
  if (!registered) return;
  try {
    ipcMain.removeHandler(IDW_IPC.LIST);
    ipcMain.removeHandler(IDW_IPC.LIST_BY_KIND);
    ipcMain.removeHandler(IDW_IPC.GET);
    ipcMain.removeHandler(IDW_IPC.ADD);
    ipcMain.removeHandler(IDW_IPC.UPDATE);
    ipcMain.removeHandler(IDW_IPC.REMOVE);
    ipcMain.removeHandler(IDW_IPC.OPEN);
    ipcMain.removeHandler(IDW_IPC.OPEN_STORE);
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
    closeAgentBrowser();
  } catch {
    // best-effort
  }
  try {
    closeCatalogWindow();
  } catch {
    // best-effort
  }
  registered = false;
  initOptions = null;
}

/** @internal -- exposed for tests. */
export function _isIdwRegisteredForTesting(): boolean {
  return registered;
}

/** @internal -- exposed for tests so they can re-init cleanly. */
export function _resetIdwRegistrationForTesting(): void {
  teardownInternal();
  _resetIdwApiForTesting();
}

// ---------------------------------------------------------------------------
// Payload validation
// ---------------------------------------------------------------------------

const VALID_KINDS: ReadonlyArray<AgentKind> = [
  'idw',
  'external-bot',
  'image-creator',
  'video-creator',
  'audio-generator',
  'ui-design-tool',
];

function validateKind(value: unknown): AgentKind {
  if (typeof value !== 'string' || !(VALID_KINDS as readonly string[]).includes(value)) {
    throw new Error(`Invalid kind: ${String(value)}`);
  }
  return value as AgentKind;
}

function validateNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function validateAddPayload(
  value: unknown
): Partial<IdwEntry> & Pick<IdwEntry, 'kind' | 'label' | 'url'> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('add payload must be an object');
  }
  const v = value as Record<string, unknown>;
  const kind = validateKind(v['kind']);
  const label = validateNonEmptyString(v['label'], 'label');
  const url = validateNonEmptyString(v['url'], 'url');
  // Pass the rest through; IdwStore validates per-kind specifics.
  return { ...(v as Partial<IdwEntry>), kind, label, url };
}

function validatePatchPayload(value: unknown): Partial<IdwEntry> {
  if (value === null || value === undefined) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('patch must be an object');
  }
  return value as Partial<IdwEntry>;
}

/**
 * Open an IDW entry as a tab in the main window. Per ADR-038, the
 * main window manages multiple sandboxed agent tabs (replacing the
 * legacy singleton placeholder browser). The main-window API
 * dedupes by `idwId`, so clicking the same IDW menu entry twice
 * focuses the existing tab instead of opening a duplicate.
 *
 * Falls back to the legacy `openAgentInBrowser` path if the main
 * window module rejects (e.g. it's not initialized in a test
 * harness). The fallback keeps the menu functional during the
 * ADR-038 rollout.
 */
async function openEntryAsTab(entry: IdwEntry): Promise<void> {
  try {
    const mainApi = getMainWindowApi();
    const input: { url: string; label: string; idwId?: string; iconName?: string } = {
      url: entry.url,
      label: entry.label,
      idwId: entry.id,
    };
    if (typeof entry.iconName === 'string' && entry.iconName.length > 0) {
      input.iconName = entry.iconName;
    }
    await mainApi.openTab(input);
  } catch (err) {
    getLoggingApi().warn('idw', 'main-window openTab rejected; falling back to placeholder browser', {
      id: entry.id,
      error: (err as Error).message,
    });
    openAgentInBrowser(entry);
  }
}
