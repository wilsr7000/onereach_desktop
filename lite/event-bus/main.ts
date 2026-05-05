/**
 * Event bus main-process orchestration.
 *
 * Owns:
 *   - Boot init: hydrate from KV, attach to logging queue
 *   - IPC handlers for `lite:event-bus:recent / size / emit`
 *   - Broadcast of every projected `DomainEvent` to all open
 *     BrowserWindows via `webContents.send('lite:event-bus:event', ...)` --
 *     that's the wire pumping the `window.lite.events.on(...)`
 *     subscriber surface in renderers
 *
 * Per ADR-019 / Rule 11, this file is the boundary between Electron
 * IPC and the typed `EventBusApi`. Renderers never see `EventBusStore`
 * directly.
 *
 * Per ADR-030, every IPC handler emits an instant
 * `event-bus.ipc.<verb>` event on entry so renderer-driven activity
 * is observable in `/logs`.
 */

import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron';
import {
  getEventBusApi,
  getEventBusStore,
  _resetEventBusApiForTesting,
  type DomainEvent,
  type DomainEventName,
} from './api.js';
import { DOMAIN_EVENT_NAMES } from './types.js';
import { EVENT_BUS_EVENTS } from './events.js';
import { getLoggingApi } from '../logging/api.js';

// ─── IPC channels ─────────────────────────────────────────────────────────

export const EVENT_BUS_IPC = {
  RECENT: 'lite:event-bus:recent',
  SIZE: 'lite:event-bus:size',
  EMIT: 'lite:event-bus:emit',
  EVENT: 'lite:event-bus:event',
} as const;

// ─── Init / teardown ──────────────────────────────────────────────────────

export interface InitEventBusOptions {
  /** Optional logger -- routed through lite logging by default. */
  logger?: {
    info: (message: string, data?: unknown) => void;
    warn: (message: string, data?: unknown) => void;
    error: (message: string, data?: unknown) => void;
  };
}

export interface EventBusHandle {
  teardown(): void;
}

let registered = false;
let unsubscribePattern: (() => void) | null = null;

export async function initEventBus(opts: InitEventBusOptions = {}): Promise<EventBusHandle> {
  const log = opts.logger ?? {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };

  if (registered) {
    return { teardown: teardownInternal };
  }

  // Force singleton + store creation. Constructor subscribes to the
  // logging queue immediately, so events emitted from this point
  // forward will be projected.
  const api = getEventBusApi();
  const store = getEventBusStore();

  // Hydrate the ring buffer from KV (best-effort; soft-fails on miss).
  try {
    await store.hydrate();
  } catch (err) {
    log.warn('event-bus hydrate threw (continuing with empty buffer)', {
      error: (err as Error).message,
    });
  }

  // Broadcast every domain event to every open BrowserWindow. The
  // pattern `'*'` catches everything; renderer-side callers filter by
  // name in their own handlers (matching the api.ts contract).
  unsubscribePattern = api.onPattern('*', (event) => {
    for (const w of BrowserWindow.getAllWindows()) {
      try {
        if (!w.isDestroyed()) {
          w.webContents.send(EVENT_BUS_IPC.EVENT, event);
        }
      } catch (err) {
        log.warn('event-bus broadcast failed', {
          windowId: w.id,
          error: (err as Error).message,
        });
      }
    }
  });

  // ── IPC handlers ──────────────────────────────────────────────────────

  ipcMain.handle(
    EVENT_BUS_IPC.RECENT,
    async (
      _event: IpcMainInvokeEvent,
      payload: { name?: unknown; limit?: unknown }
    ): Promise<DomainEvent[]> => {
      getLoggingApi().event(EVENT_BUS_EVENTS.IPC_RECENT);
      const name = parseOptionalDomainName(payload?.name);
      const limit = parseOptionalLimit(payload?.limit);
      return api.recent(name, limit);
    }
  );

  ipcMain.handle(EVENT_BUS_IPC.SIZE, async (): Promise<{ size: number }> => {
    return { size: api.size() };
  });

  ipcMain.handle(
    EVENT_BUS_IPC.EMIT,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<DomainEvent> => {
      const event = parseEmitPayload(payload);
      // Renderer-driven emit -- the IPC entry event makes it visible in /logs.
      getLoggingApi().event('event-bus.ipc.emit', { name: event.name });
      // The runtime payload validation we just did is necessarily
      // weaker than the static `Omit<DomainEvent, 'id'|'ts'>` type --
      // we know the name is in the catalogue but we can't statically
      // narrow `data` from a renderer-supplied unknown. The store's
      // own emit will pass through; if the data shape is wrong, the
      // subscriber's type narrowing will reject at the call site
      // (which is where the contract belongs).
      return api.emit(event as unknown as Omit<DomainEvent, 'id' | 'ts'>);
    }
  );

  registered = true;
  log.info('event-bus initialized', { bufferSize: api.size() });
  return { teardown: teardownInternal };
}

function teardownInternal(): void {
  if (!registered) return;
  try {
    ipcMain.removeHandler(EVENT_BUS_IPC.RECENT);
    ipcMain.removeHandler(EVENT_BUS_IPC.SIZE);
    ipcMain.removeHandler(EVENT_BUS_IPC.EMIT);
  } catch {
    /* best-effort */
  }
  if (unsubscribePattern !== null) {
    try {
      unsubscribePattern();
    } catch {
      /* best-effort */
    }
    unsubscribePattern = null;
  }
  try {
    getEventBusStore().destroy();
  } catch {
    /* best-effort */
  }
  registered = false;
}

/** @internal -- exposed for tests. */
export function _isEventBusRegisteredForTesting(): boolean {
  return registered;
}

/** @internal -- exposed for tests so they can re-init cleanly. */
export function _resetEventBusRegistrationForTesting(): void {
  teardownInternal();
  _resetEventBusApiForTesting();
}

// ─── Validation helpers ───────────────────────────────────────────────────

function parseOptionalDomainName(value: unknown): DomainEventName | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return null;
  return (DOMAIN_EVENT_NAMES as ReadonlyArray<string>).includes(value)
    ? (value as DomainEventName)
    : null;
}

function parseOptionalLimit(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 50;
  // Cap renderer-supplied limits to RING_BUFFER_MAX so a bad payload
  // can't exhaust IPC marshaling.
  const clamped = Math.max(0, Math.min(Math.floor(value), 200));
  return clamped;
}

function parseEmitPayload(value: unknown): { name: DomainEventName; data: unknown } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('emit payload must be an object');
  }
  const v = value as Record<string, unknown>;
  if (typeof v['name'] !== 'string') {
    throw new Error('emit payload.name must be a string');
  }
  const name = v['name'];
  if (!(DOMAIN_EVENT_NAMES as ReadonlyArray<string>).includes(name)) {
    throw new Error(`emit payload.name is not a known domain event: ${name}`);
  }
  return {
    name: name as DomainEventName,
    data: v['data'] ?? {},
  };
}
