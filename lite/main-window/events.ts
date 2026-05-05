/**
 * Main window module event types -- per-module typed event surface.
 *
 * Per ADR-032, every module that emits events through the central
 * logging API also exposes:
 *
 *   1. A const-typed constants object (`MAIN_WINDOW_EVENTS`) listing every name
 *   2. A discriminated union (`MainWindowEvent`) of typed event records
 *   3. An `onEvent(handler)` helper on the public API that subscribes
 *      via `getLoggingApi().onEvent('main-window.*', ...)` and casts.
 *
 * Adding a new event requires updating both the implementation site
 * AND this file -- the `event-name-conformance` meta-test enforces
 * correspondence.
 */

import type { EventRecord } from '../logging/events.js';
import type { SerializedEventError } from '../logging/events.js';

/** Stable event name catalog. Source-of-truth for what main-window/ emits. */
export const MAIN_WINDOW_EVENTS = {
  // CRUD spans
  OPEN_TAB_START: 'main-window.open-tab.start',
  OPEN_TAB_FINISH: 'main-window.open-tab.finish',
  OPEN_TAB_FAIL: 'main-window.open-tab.fail',
  CLOSE_TAB_START: 'main-window.close-tab.start',
  CLOSE_TAB_FINISH: 'main-window.close-tab.finish',
  CLOSE_TAB_FAIL: 'main-window.close-tab.fail',
  ACTIVATE_TAB_START: 'main-window.activate-tab.start',
  ACTIVATE_TAB_FINISH: 'main-window.activate-tab.finish',
  ACTIVATE_TAB_FAIL: 'main-window.activate-tab.fail',
  // Activity events (instant)
  CHANGED: 'main-window.changed',
  TAB_NAVIGATED: 'main-window.tab.navigated',
  TAB_LOAD_START: 'main-window.tab.load-start',
  TAB_LOAD_FINISH: 'main-window.tab.load-finish',
  TAB_LOAD_FAIL: 'main-window.tab.load-fail',
  // IPC entry events (per ADR-030)
  IPC_OPEN_TAB: 'main-window.ipc.open-tab',
  IPC_CLOSE_TAB: 'main-window.ipc.close-tab',
  IPC_ACTIVATE_TAB: 'main-window.ipc.activate-tab',
  IPC_LIST_TABS: 'main-window.ipc.list-tabs',
} as const;

export type MainWindowEventName =
  (typeof MAIN_WINDOW_EVENTS)[keyof typeof MAIN_WINDOW_EVENTS];

/** Common shape on every main-window event. */
interface MainWindowEventBase {
  id: string;
  timestamp: string;
  category: 'main-window';
}

interface MainWindowSpanBase extends MainWindowEventBase {
  spanId: string;
}

// ─── open-tab ─────────────────────────────────────────────────────────────

interface OpenTabStartData {
  /** Whether the call is on the dedupe path (idwId set + match exists). */
  isDedupe: boolean;
  hasIdwId: boolean;
}

interface OpenTabFinishData {
  id: string;
  /** True iff the call hit dedupe -- existing tab was focused. */
  wasFocus: boolean;
}

export interface MainWindowOpenTabStartEvent extends MainWindowSpanBase {
  name: typeof MAIN_WINDOW_EVENTS.OPEN_TAB_START;
  level: 'info';
  data: OpenTabStartData;
}
export interface MainWindowOpenTabFinishEvent extends MainWindowSpanBase {
  name: typeof MAIN_WINDOW_EVENTS.OPEN_TAB_FINISH;
  level: 'info';
  durationMs: number;
  data: OpenTabFinishData;
}
export interface MainWindowOpenTabFailEvent extends MainWindowSpanBase {
  name: typeof MAIN_WINDOW_EVENTS.OPEN_TAB_FAIL;
  level: 'error';
  durationMs: number;
  error: SerializedEventError;
}

// ─── close-tab ────────────────────────────────────────────────────────────

interface CloseTabStartData {
  id: string;
}
interface CloseTabFinishData {
  id: string;
}

export interface MainWindowCloseTabStartEvent extends MainWindowSpanBase {
  name: typeof MAIN_WINDOW_EVENTS.CLOSE_TAB_START;
  level: 'info';
  data: CloseTabStartData;
}
export interface MainWindowCloseTabFinishEvent extends MainWindowSpanBase {
  name: typeof MAIN_WINDOW_EVENTS.CLOSE_TAB_FINISH;
  level: 'info';
  durationMs: number;
  data: CloseTabFinishData;
}
export interface MainWindowCloseTabFailEvent extends MainWindowSpanBase {
  name: typeof MAIN_WINDOW_EVENTS.CLOSE_TAB_FAIL;
  level: 'error';
  durationMs: number;
  error: SerializedEventError;
}

// ─── activate-tab ─────────────────────────────────────────────────────────

interface ActivateTabStartData {
  id: string;
}
interface ActivateTabFinishData {
  id: string;
}

export interface MainWindowActivateTabStartEvent extends MainWindowSpanBase {
  name: typeof MAIN_WINDOW_EVENTS.ACTIVATE_TAB_START;
  level: 'info';
  data: ActivateTabStartData;
}
export interface MainWindowActivateTabFinishEvent extends MainWindowSpanBase {
  name: typeof MAIN_WINDOW_EVENTS.ACTIVATE_TAB_FINISH;
  level: 'info';
  durationMs: number;
  data: ActivateTabFinishData;
}
export interface MainWindowActivateTabFailEvent extends MainWindowSpanBase {
  name: typeof MAIN_WINDOW_EVENTS.ACTIVATE_TAB_FAIL;
  level: 'error';
  durationMs: number;
  error: SerializedEventError;
}

// ─── activity (instant) ───────────────────────────────────────────────────

export interface MainWindowChangedEvent extends MainWindowEventBase {
  name: typeof MAIN_WINDOW_EVENTS.CHANGED;
  level: 'info';
  data: { count: number; activeId: string | null };
}
export interface MainWindowTabNavigatedEvent extends MainWindowEventBase {
  name: typeof MAIN_WINDOW_EVENTS.TAB_NAVIGATED;
  level: 'info';
  data: { id: string; url: string };
}
export interface MainWindowTabLoadStartEvent extends MainWindowEventBase {
  name: typeof MAIN_WINDOW_EVENTS.TAB_LOAD_START;
  level: 'info';
  data: { id: string };
}
export interface MainWindowTabLoadFinishEvent extends MainWindowEventBase {
  name: typeof MAIN_WINDOW_EVENTS.TAB_LOAD_FINISH;
  level: 'info';
  data: { id: string; durationMs: number };
}
export interface MainWindowTabLoadFailEvent extends MainWindowEventBase {
  name: typeof MAIN_WINDOW_EVENTS.TAB_LOAD_FAIL;
  level: 'warn';
  data: { id: string; errorCode: number; errorDescription: string };
}

// ─── IPC entry events ─────────────────────────────────────────────────────

export interface MainWindowIpcOpenTabEvent extends MainWindowEventBase {
  name: typeof MAIN_WINDOW_EVENTS.IPC_OPEN_TAB;
  level: 'info';
}
export interface MainWindowIpcCloseTabEvent extends MainWindowEventBase {
  name: typeof MAIN_WINDOW_EVENTS.IPC_CLOSE_TAB;
  level: 'info';
}
export interface MainWindowIpcActivateTabEvent extends MainWindowEventBase {
  name: typeof MAIN_WINDOW_EVENTS.IPC_ACTIVATE_TAB;
  level: 'info';
}
export interface MainWindowIpcListTabsEvent extends MainWindowEventBase {
  name: typeof MAIN_WINDOW_EVENTS.IPC_LIST_TABS;
  level: 'info';
}

/** Discriminated union -- branch on `ev.name` to narrow `ev.data`. */
export type MainWindowEvent =
  | MainWindowOpenTabStartEvent
  | MainWindowOpenTabFinishEvent
  | MainWindowOpenTabFailEvent
  | MainWindowCloseTabStartEvent
  | MainWindowCloseTabFinishEvent
  | MainWindowCloseTabFailEvent
  | MainWindowActivateTabStartEvent
  | MainWindowActivateTabFinishEvent
  | MainWindowActivateTabFailEvent
  | MainWindowChangedEvent
  | MainWindowTabNavigatedEvent
  | MainWindowTabLoadStartEvent
  | MainWindowTabLoadFinishEvent
  | MainWindowTabLoadFailEvent
  | MainWindowIpcOpenTabEvent
  | MainWindowIpcCloseTabEvent
  | MainWindowIpcActivateTabEvent
  | MainWindowIpcListTabsEvent;

/**
 * Type-guard. Use to narrow a generic `EventRecord` from
 * `getLoggingApi().onEvent('*', ...)` to the typed `MainWindowEvent` union.
 */
export function isMainWindowEvent(ev: EventRecord): ev is EventRecord & MainWindowEvent {
  return Object.values(MAIN_WINDOW_EVENTS).includes(ev.name as MainWindowEventName);
}
