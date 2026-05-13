/**
 * Spaces module -- IPC channel registration.
 *
 * Renderer -> main bridge for the renderer-side `window.lite.spaces.*`
 * surface. Channels are prefixed `lite:spaces:` per the registry rule.
 *
 * Phase 0 ships only `OPEN` (so the menu wiring is complete and the
 * Spaces window can launch). Phase 1 lands `LIST_SPACES`,
 * `UNCATEGORIZED_COUNT`, and `ITEMS_LIST`; Phase 2 lands `ITEMS_GET`.
 *
 * @internal
 */

import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { getSpacesApi } from './api.js';
import type { SpacesError } from './errors.js';
import { resolveSpaceScope } from './scope.js';
import type {
  Item,
  ItemSummary,
  ListOpts,
  Space,
} from './types.js';
import { runDiscovery } from './discovery.js';
import type { DiscoveryResults } from './discovery-format.js';

export const SPACES_IPC = {
  OPEN: 'lite:spaces:open',
  LIST_SPACES: 'lite:spaces:listSpaces',
  UNCATEGORIZED_COUNT: 'lite:spaces:uncategorizedCount',
  ITEMS_LIST: 'lite:spaces:items:list',
  ITEMS_GET: 'lite:spaces:items:get',
  ITEMS_RESOLVE_FILE_URL: 'lite:spaces:items:resolveFileUrl',
  /** Phase 0.5: run the Q1-Q4 verification queries. */
  DISCOVERY_RUN: 'lite:spaces:discovery:run',
} as const;

/**
 * Envelope wrapping the success or failure of an SDK call when the
 * value crosses the IPC boundary. Errors don't serialize through
 * `ipcMain.handle` losslessly, so we project them into a structured
 * envelope the renderer can re-throw.
 */
export type SpacesIpcResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      error: {
        code: string;
        message: string;
        remediation?: string;
        context?: Record<string, unknown>;
      };
    };

interface RegisterOpts {
  /** Called for `OPEN` -- the menu wiring boils down to this. */
  onOpen: () => void;
}

let registered = false;

/**
 * Register every Spaces IPC handler. Idempotent: safe to call across
 * test re-init cycles. Pair with `unregisterSpacesIpc()` on teardown.
 */
export function registerSpacesIpc(opts: RegisterOpts): void {
  if (registered) return;

  ipcMain.handle(SPACES_IPC.OPEN, (_event: IpcMainInvokeEvent): { ok: true } => {
    opts.onOpen();
    return { ok: true };
  });

  ipcMain.handle(
    SPACES_IPC.LIST_SPACES,
    async (_event: IpcMainInvokeEvent): Promise<SpacesIpcResult<Space[]>> => {
      try {
        const value = await getSpacesApi().listSpaces();
        return { ok: true, value };
      } catch (err) {
        return { ok: false, error: serializeError(err) };
      }
    }
  );

  ipcMain.handle(
    SPACES_IPC.UNCATEGORIZED_COUNT,
    async (_event: IpcMainInvokeEvent): Promise<SpacesIpcResult<number>> => {
      try {
        const value = await getSpacesApi().getUncategorizedCount();
        return { ok: true, value };
      } catch (err) {
        return { ok: false, error: serializeError(err) };
      }
    }
  );

  ipcMain.handle(
    SPACES_IPC.ITEMS_LIST,
    async (
      _event: IpcMainInvokeEvent,
      payload?: { scopeId?: unknown; opts?: unknown }
    ): Promise<SpacesIpcResult<ItemSummary[]>> => {
      try {
        const scopeId =
          payload !== undefined && typeof payload.scopeId === 'string'
            ? payload.scopeId
            : '';
        const opts = isListOpts(payload?.opts) ? payload.opts : undefined;
        const scope = resolveSpaceScope(scopeId);
        const value = await getSpacesApi().items.list(scope, opts);
        return { ok: true, value };
      } catch (err) {
        return { ok: false, error: serializeError(err) };
      }
    }
  );

  ipcMain.handle(
    SPACES_IPC.ITEMS_GET,
    async (
      _event: IpcMainInvokeEvent,
      payload?: { id?: unknown }
    ): Promise<SpacesIpcResult<Item | null>> => {
      try {
        const id =
          payload !== undefined && typeof payload.id === 'string'
            ? payload.id
            : '';
        const value = await getSpacesApi().items.get(id);
        return { ok: true, value };
      } catch (err) {
        return { ok: false, error: serializeError(err) };
      }
    }
  );

  ipcMain.handle(
    SPACES_IPC.ITEMS_RESOLVE_FILE_URL,
    async (
      _event: IpcMainInvokeEvent,
      payload?: { key?: unknown }
    ): Promise<SpacesIpcResult<string | null>> => {
      try {
        const key =
          payload !== undefined && typeof payload.key === 'string'
            ? payload.key
            : '';
        const value = await getSpacesApi().items.resolveFileUrl(key);
        return { ok: true, value };
      } catch (err) {
        return { ok: false, error: serializeError(err) };
      }
    }
  );

  // Phase 0.5: discovery. Runs Q1-Q4 via getNeonApi() and returns the
  // structured envelope. runDiscovery() never throws -- per-query
  // failures land in the envelope -- so this handler always returns
  // ok=true. The runner result itself encodes pass/fail per query.
  ipcMain.handle(
    SPACES_IPC.DISCOVERY_RUN,
    async (_event: IpcMainInvokeEvent): Promise<SpacesIpcResult<DiscoveryResults>> => {
      try {
        const value = await runDiscovery();
        return { ok: true, value };
      } catch (err) {
        return { ok: false, error: serializeError(err) };
      }
    }
  );

  registered = true;
}

/** Remove every Spaces IPC handler. Idempotent. */
export function unregisterSpacesIpc(): void {
  if (!registered) return;
  for (const channel of Object.values(SPACES_IPC)) {
    try {
      ipcMain.removeHandler(channel);
    } catch {
      // best-effort
    }
  }
  registered = false;
}

/** @internal -- for tests. */
export function _isSpacesIpcRegisteredForTesting(): boolean {
  return registered;
}

function isListOpts(v: unknown): v is ListOpts {
  if (v === undefined || v === null || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  if ('limit' in o && typeof o['limit'] !== 'number') return false;
  if ('offset' in o && typeof o['offset'] !== 'number') return false;
  return true;
}

function serializeError(err: unknown): {
  code: string;
  message: string;
  remediation?: string;
  context?: Record<string, unknown>;
} {
  if (err !== null && typeof err === 'object' && 'code' in err && 'message' in err) {
    const e = err as SpacesError;
    const out: {
      code: string;
      message: string;
      remediation?: string;
      context?: Record<string, unknown>;
    } = {
      code: typeof e.code === 'string' ? e.code : 'SPACES_UNKNOWN',
      message: typeof e.message === 'string' ? e.message : String(err),
    };
    if (typeof e.remediation === 'string') out.remediation = e.remediation;
    if (e.context !== null && typeof e.context === 'object') {
      out.context = e.context as Record<string, unknown>;
    }
    return out;
  }
  return {
    code: 'SPACES_UNKNOWN',
    message: err instanceof Error ? err.message : String(err),
  };
}
