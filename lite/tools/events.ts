/**
 * Tools module event types.
 *
 * Per ADR-032, every module that emits events through the central
 * logging API also exposes:
 *   1. A const-typed catalog (`TOOLS_EVENTS`) listing every name
 *   2. A discriminated union (`ToolsEvent`)
 *   3. An `onEvent(handler)` helper on the public API
 */

import type { EventRecord, SerializedEventError } from '../logging/events.js';

/** Stable event name catalog. Source-of-truth for what tools/ emits. */
export const TOOLS_EVENTS = {
  // CRUD spans
  ADD_START: 'tools.add.start',
  ADD_FINISH: 'tools.add.finish',
  ADD_FAIL: 'tools.add.fail',
  UPDATE_START: 'tools.update.start',
  UPDATE_FINISH: 'tools.update.finish',
  UPDATE_FAIL: 'tools.update.fail',
  REMOVE_START: 'tools.remove.start',
  REMOVE_FINISH: 'tools.remove.finish',
  REMOVE_FAIL: 'tools.remove.fail',
  // Activity (instant)
  CHANGED: 'tools.changed',
  OPENED: 'tools.opened',
  MANAGE_OPENED: 'tools.manage.opened',
  // IPC entry events (per ADR-030)
  IPC_LIST: 'tools.ipc.list',
  IPC_GET: 'tools.ipc.get',
  IPC_ADD: 'tools.ipc.add',
  IPC_UPDATE: 'tools.ipc.update',
  IPC_REMOVE: 'tools.ipc.remove',
  IPC_OPEN: 'tools.ipc.open',
  IPC_OPEN_MANAGER: 'tools.ipc.open-manager',
} as const;

export type ToolsEventName = (typeof TOOLS_EVENTS)[keyof typeof TOOLS_EVENTS];

interface ToolsEventBase {
  id: string;
  timestamp: string;
  category: 'tools';
}

interface ToolsSpanBase extends ToolsEventBase {
  spanId: string;
}

// ─── add ──────────────────────────────────────────────────────────────────

interface ToolsAddStartData {
  hasId: boolean;
}
interface ToolsAddFinishData {
  id: string;
}

export interface ToolsAddStartEvent extends ToolsSpanBase {
  name: typeof TOOLS_EVENTS.ADD_START;
  level: 'info';
  data: ToolsAddStartData;
}
export interface ToolsAddFinishEvent extends ToolsSpanBase {
  name: typeof TOOLS_EVENTS.ADD_FINISH;
  level: 'info';
  durationMs: number;
  data: ToolsAddFinishData;
}
export interface ToolsAddFailEvent extends ToolsSpanBase {
  name: typeof TOOLS_EVENTS.ADD_FAIL;
  level: 'error';
  durationMs: number;
  error: SerializedEventError;
}

// ─── update ───────────────────────────────────────────────────────────────

interface ToolsUpdateStartData {
  id: string;
  fields: string[];
}
interface ToolsUpdateFinishData {
  id: string;
}

export interface ToolsUpdateStartEvent extends ToolsSpanBase {
  name: typeof TOOLS_EVENTS.UPDATE_START;
  level: 'info';
  data: ToolsUpdateStartData;
}
export interface ToolsUpdateFinishEvent extends ToolsSpanBase {
  name: typeof TOOLS_EVENTS.UPDATE_FINISH;
  level: 'info';
  durationMs: number;
  data: ToolsUpdateFinishData;
}
export interface ToolsUpdateFailEvent extends ToolsSpanBase {
  name: typeof TOOLS_EVENTS.UPDATE_FAIL;
  level: 'error';
  durationMs: number;
  error: SerializedEventError;
}

// ─── remove ───────────────────────────────────────────────────────────────

interface ToolsRemoveStartData {
  id: string;
}
interface ToolsRemoveFinishData {
  id: string;
}

export interface ToolsRemoveStartEvent extends ToolsSpanBase {
  name: typeof TOOLS_EVENTS.REMOVE_START;
  level: 'info';
  data: ToolsRemoveStartData;
}
export interface ToolsRemoveFinishEvent extends ToolsSpanBase {
  name: typeof TOOLS_EVENTS.REMOVE_FINISH;
  level: 'info';
  durationMs: number;
  data: ToolsRemoveFinishData;
}
export interface ToolsRemoveFailEvent extends ToolsSpanBase {
  name: typeof TOOLS_EVENTS.REMOVE_FAIL;
  level: 'error';
  durationMs: number;
  error: SerializedEventError;
}

// ─── activity (instant) ───────────────────────────────────────────────────

export interface ToolsChangedEvent extends ToolsEventBase {
  name: typeof TOOLS_EVENTS.CHANGED;
  level: 'info';
  data: { count: number };
}
export interface ToolsOpenedEvent extends ToolsEventBase {
  name: typeof TOOLS_EVENTS.OPENED;
  level: 'info';
  data: { id: string };
}
export interface ToolsManageOpenedEvent extends ToolsEventBase {
  name: typeof TOOLS_EVENTS.MANAGE_OPENED;
  level: 'info';
}

// ─── IPC entry events ─────────────────────────────────────────────────────

export interface ToolsIpcListEvent extends ToolsEventBase {
  name: typeof TOOLS_EVENTS.IPC_LIST;
  level: 'info';
}
export interface ToolsIpcGetEvent extends ToolsEventBase {
  name: typeof TOOLS_EVENTS.IPC_GET;
  level: 'info';
}
export interface ToolsIpcAddEvent extends ToolsEventBase {
  name: typeof TOOLS_EVENTS.IPC_ADD;
  level: 'info';
}
export interface ToolsIpcUpdateEvent extends ToolsEventBase {
  name: typeof TOOLS_EVENTS.IPC_UPDATE;
  level: 'info';
}
export interface ToolsIpcRemoveEvent extends ToolsEventBase {
  name: typeof TOOLS_EVENTS.IPC_REMOVE;
  level: 'info';
}
export interface ToolsIpcOpenEvent extends ToolsEventBase {
  name: typeof TOOLS_EVENTS.IPC_OPEN;
  level: 'info';
}
export interface ToolsIpcOpenManagerEvent extends ToolsEventBase {
  name: typeof TOOLS_EVENTS.IPC_OPEN_MANAGER;
  level: 'info';
}

/** Discriminated union -- branch on `ev.name` to narrow `ev.data`. */
export type ToolsEvent =
  | ToolsAddStartEvent
  | ToolsAddFinishEvent
  | ToolsAddFailEvent
  | ToolsUpdateStartEvent
  | ToolsUpdateFinishEvent
  | ToolsUpdateFailEvent
  | ToolsRemoveStartEvent
  | ToolsRemoveFinishEvent
  | ToolsRemoveFailEvent
  | ToolsChangedEvent
  | ToolsOpenedEvent
  | ToolsManageOpenedEvent
  | ToolsIpcListEvent
  | ToolsIpcGetEvent
  | ToolsIpcAddEvent
  | ToolsIpcUpdateEvent
  | ToolsIpcRemoveEvent
  | ToolsIpcOpenEvent
  | ToolsIpcOpenManagerEvent;

export function isToolsEvent(ev: EventRecord): ev is EventRecord & ToolsEvent {
  return Object.values(TOOLS_EVENTS).includes(ev.name as ToolsEventName);
}
