/**
 * IDW module event types -- per-module typed event surface.
 *
 * Per ADR-032, every module that emits events through the central
 * logging API also exposes:
 *
 *   1. A const-typed constants object (`IDW_EVENTS`) listing every name
 *   2. A discriminated union (`IdwEvent`) of typed event records, one
 *      interface per emitted name
 *   3. An `onEvent(handler)` helper on the public API that subscribes
 *      via `getLoggingApi().onEvent('idw.*', ...)` and casts.
 *
 * Consumers branch via `switch (ev.name)` and TypeScript narrows
 * `ev.data` accordingly. Adding a new event requires updating both
 * the implementation site AND this file -- the `event-name-conformance`
 * meta-test enforces correspondence.
 */

import type { EventRecord } from '../logging/events.js';
import type { SerializedEventError } from '../logging/events.js';
import type { AgentKind } from './types.js';

/** Stable event name catalog. Source-of-truth for what idw/ emits. */
export const IDW_EVENTS = {
  // CRUD spans
  ADD_START: 'idw.add.start',
  ADD_FINISH: 'idw.add.finish',
  ADD_FAIL: 'idw.add.fail',
  UPDATE_START: 'idw.update.start',
  UPDATE_FINISH: 'idw.update.finish',
  UPDATE_FAIL: 'idw.update.fail',
  REMOVE_START: 'idw.remove.start',
  REMOVE_FINISH: 'idw.remove.finish',
  REMOVE_FAIL: 'idw.remove.fail',
  // Activity events (instant)
  CHANGED: 'idw.changed',
  OPENED: 'idw.opened',
  STORE_OPENED: 'idw.store.opened',
  STORE_INSTALLED: 'idw.store.installed',
  STORE_UPDATED: 'idw.store.updated',
  // Browser placeholder window
  BROWSER_LOADING: 'idw.browser.loading',
  BROWSER_LOADED: 'idw.browser.loaded',
  // IPC entry events (per ADR-030)
  IPC_LIST: 'idw.ipc.list',
  IPC_LIST_BY_KIND: 'idw.ipc.list-by-kind',
  IPC_GET: 'idw.ipc.get',
  IPC_ADD: 'idw.ipc.add',
  IPC_UPDATE: 'idw.ipc.update',
  IPC_REMOVE: 'idw.ipc.remove',
  IPC_OPEN: 'idw.ipc.open',
  IPC_OPEN_STORE: 'idw.ipc.open-store',
} as const;

export type IdwEventName = (typeof IDW_EVENTS)[keyof typeof IDW_EVENTS];

/**
 * Common shape on every IDW event. Mirrors `EventRecord` but pins
 * `category` to `'idw'`.
 */
interface IdwEventBase {
  id: string;
  timestamp: string;
  category: 'idw';
}

interface IdwSpanBase extends IdwEventBase {
  spanId: string;
}

// ─── add ──────────────────────────────────────────────────────────────────

interface IdwAddStartData {
  kind: AgentKind;
  /** Whether the call carried an explicit id (vs. one being generated). */
  hasId: boolean;
}

interface IdwAddFinishData {
  id: string;
  kind: AgentKind;
  source: 'manual' | 'store';
  /** True when the add resolved an existing Store entry by catalogId. */
  wasUpdate: boolean;
}

export interface IdwAddStartEvent extends IdwSpanBase {
  name: typeof IDW_EVENTS.ADD_START;
  level: 'info';
  data: IdwAddStartData;
}
export interface IdwAddFinishEvent extends IdwSpanBase {
  name: typeof IDW_EVENTS.ADD_FINISH;
  level: 'info';
  durationMs: number;
  data: IdwAddFinishData;
}
export interface IdwAddFailEvent extends IdwSpanBase {
  name: typeof IDW_EVENTS.ADD_FAIL;
  level: 'error';
  durationMs: number;
  error: SerializedEventError;
}

// ─── update ───────────────────────────────────────────────────────────────

interface IdwUpdateStartData {
  id: string;
  /** Names of the fields the caller wants to update. */
  fields: string[];
}

interface IdwUpdateFinishData {
  id: string;
  kind: AgentKind;
}

export interface IdwUpdateStartEvent extends IdwSpanBase {
  name: typeof IDW_EVENTS.UPDATE_START;
  level: 'info';
  data: IdwUpdateStartData;
}
export interface IdwUpdateFinishEvent extends IdwSpanBase {
  name: typeof IDW_EVENTS.UPDATE_FINISH;
  level: 'info';
  durationMs: number;
  data: IdwUpdateFinishData;
}
export interface IdwUpdateFailEvent extends IdwSpanBase {
  name: typeof IDW_EVENTS.UPDATE_FAIL;
  level: 'error';
  durationMs: number;
  error: SerializedEventError;
}

// ─── remove ───────────────────────────────────────────────────────────────

interface IdwRemoveStartData {
  id: string;
}

interface IdwRemoveFinishData {
  id: string;
  kind: AgentKind;
}

export interface IdwRemoveStartEvent extends IdwSpanBase {
  name: typeof IDW_EVENTS.REMOVE_START;
  level: 'info';
  data: IdwRemoveStartData;
}
export interface IdwRemoveFinishEvent extends IdwSpanBase {
  name: typeof IDW_EVENTS.REMOVE_FINISH;
  level: 'info';
  durationMs: number;
  data: IdwRemoveFinishData;
}
export interface IdwRemoveFailEvent extends IdwSpanBase {
  name: typeof IDW_EVENTS.REMOVE_FAIL;
  level: 'error';
  durationMs: number;
  error: SerializedEventError;
}

// ─── activity (instant) ───────────────────────────────────────────────────

export interface IdwChangedEvent extends IdwEventBase {
  name: typeof IDW_EVENTS.CHANGED;
  level: 'info';
  data: { count: number };
}
export interface IdwOpenedEvent extends IdwEventBase {
  name: typeof IDW_EVENTS.OPENED;
  level: 'info';
  data: { id: string; kind: AgentKind };
}
export interface IdwStoreOpenedEvent extends IdwEventBase {
  name: typeof IDW_EVENTS.STORE_OPENED;
  level: 'info';
}
export interface IdwStoreInstalledEvent extends IdwEventBase {
  name: typeof IDW_EVENTS.STORE_INSTALLED;
  level: 'info';
  data: { id: string; kind: AgentKind; catalogId: string };
}
export interface IdwStoreUpdatedEvent extends IdwEventBase {
  name: typeof IDW_EVENTS.STORE_UPDATED;
  level: 'info';
  data: { id: string; kind: AgentKind; catalogId: string };
}

// ─── browser placeholder ──────────────────────────────────────────────────

export interface IdwBrowserLoadingEvent extends IdwEventBase {
  name: typeof IDW_EVENTS.BROWSER_LOADING;
  level: 'info';
  data: { id: string };
}
export interface IdwBrowserLoadedEvent extends IdwEventBase {
  name: typeof IDW_EVENTS.BROWSER_LOADED;
  level: 'info';
  data: { id: string; durationMs: number };
}

// ─── IPC entry events ─────────────────────────────────────────────────────

export interface IdwIpcListEvent extends IdwEventBase {
  name: typeof IDW_EVENTS.IPC_LIST;
  level: 'info';
}
export interface IdwIpcListByKindEvent extends IdwEventBase {
  name: typeof IDW_EVENTS.IPC_LIST_BY_KIND;
  level: 'info';
}
export interface IdwIpcGetEvent extends IdwEventBase {
  name: typeof IDW_EVENTS.IPC_GET;
  level: 'info';
}
export interface IdwIpcAddEvent extends IdwEventBase {
  name: typeof IDW_EVENTS.IPC_ADD;
  level: 'info';
}
export interface IdwIpcUpdateEvent extends IdwEventBase {
  name: typeof IDW_EVENTS.IPC_UPDATE;
  level: 'info';
}
export interface IdwIpcRemoveEvent extends IdwEventBase {
  name: typeof IDW_EVENTS.IPC_REMOVE;
  level: 'info';
}
export interface IdwIpcOpenEvent extends IdwEventBase {
  name: typeof IDW_EVENTS.IPC_OPEN;
  level: 'info';
}
export interface IdwIpcOpenStoreEvent extends IdwEventBase {
  name: typeof IDW_EVENTS.IPC_OPEN_STORE;
  level: 'info';
}

/** Discriminated union -- branch on `ev.name` to narrow `ev.data`. */
export type IdwEvent =
  | IdwAddStartEvent
  | IdwAddFinishEvent
  | IdwAddFailEvent
  | IdwUpdateStartEvent
  | IdwUpdateFinishEvent
  | IdwUpdateFailEvent
  | IdwRemoveStartEvent
  | IdwRemoveFinishEvent
  | IdwRemoveFailEvent
  | IdwChangedEvent
  | IdwOpenedEvent
  | IdwStoreOpenedEvent
  | IdwStoreInstalledEvent
  | IdwStoreUpdatedEvent
  | IdwBrowserLoadingEvent
  | IdwBrowserLoadedEvent
  | IdwIpcListEvent
  | IdwIpcListByKindEvent
  | IdwIpcGetEvent
  | IdwIpcAddEvent
  | IdwIpcUpdateEvent
  | IdwIpcRemoveEvent
  | IdwIpcOpenEvent
  | IdwIpcOpenStoreEvent;

/**
 * Type-guard. Use to narrow a generic `EventRecord` from
 * `getLoggingApi().onEvent('*', ...)` to the typed `IdwEvent` union.
 */
export function isIdwEvent(ev: EventRecord): ev is EventRecord & IdwEvent {
  return Object.values(IDW_EVENTS).includes(ev.name as IdwEventName);
}
