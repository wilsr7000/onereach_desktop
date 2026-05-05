/**
 * Agentic University module event types -- per-module typed event
 * surface (ADR-032).
 *
 * The University module is mostly read-only and click-driven, so
 * the event surface is smaller than IDW's: a couple of activity
 * events plus the IPC entry events.
 */

import type { EventRecord } from '../logging/events.js';
import type { LearningKind } from './types.js';

/** Stable event name catalog. Source-of-truth for what university/ emits. */
export const UNIVERSITY_EVENTS = {
  // Activity events (instant)
  OPENED: 'university.opened',
  TUTORIALS_OPENED: 'university.tutorials.opened',
  BROWSER_LOADING: 'university.browser.loading',
  BROWSER_LOADED: 'university.browser.loaded',
  // IPC entry events (per ADR-030)
  IPC_LIST: 'university.ipc.list',
  IPC_GET: 'university.ipc.get',
  IPC_OPEN: 'university.ipc.open',
  IPC_OPEN_TUTORIALS: 'university.ipc.open-tutorials',
} as const;

export type UniversityEventName =
  (typeof UNIVERSITY_EVENTS)[keyof typeof UNIVERSITY_EVENTS];

interface UniversityEventBase {
  id: string;
  timestamp: string;
  category: 'university';
}

// ─── activity (instant) ───────────────────────────────────────────────────

export interface UniversityOpenedEvent extends UniversityEventBase {
  name: typeof UNIVERSITY_EVENTS.OPENED;
  level: 'info';
  data: { id: string; kind: LearningKind };
}

export interface UniversityTutorialsOpenedEvent extends UniversityEventBase {
  name: typeof UNIVERSITY_EVENTS.TUTORIALS_OPENED;
  level: 'info';
}

// ─── browser (placeholder) ────────────────────────────────────────────────

export interface UniversityBrowserLoadingEvent extends UniversityEventBase {
  name: typeof UNIVERSITY_EVENTS.BROWSER_LOADING;
  level: 'info';
  data: { id: string };
}
export interface UniversityBrowserLoadedEvent extends UniversityEventBase {
  name: typeof UNIVERSITY_EVENTS.BROWSER_LOADED;
  level: 'info';
  data: { id: string; durationMs: number };
}

// ─── IPC entry events ─────────────────────────────────────────────────────

export interface UniversityIpcListEvent extends UniversityEventBase {
  name: typeof UNIVERSITY_EVENTS.IPC_LIST;
  level: 'info';
}
export interface UniversityIpcGetEvent extends UniversityEventBase {
  name: typeof UNIVERSITY_EVENTS.IPC_GET;
  level: 'info';
}
export interface UniversityIpcOpenEvent extends UniversityEventBase {
  name: typeof UNIVERSITY_EVENTS.IPC_OPEN;
  level: 'info';
}
export interface UniversityIpcOpenTutorialsEvent extends UniversityEventBase {
  name: typeof UNIVERSITY_EVENTS.IPC_OPEN_TUTORIALS;
  level: 'info';
}

/** Discriminated union -- branch on `ev.name` to narrow `ev.data`. */
export type UniversityEvent =
  | UniversityOpenedEvent
  | UniversityTutorialsOpenedEvent
  | UniversityBrowserLoadingEvent
  | UniversityBrowserLoadedEvent
  | UniversityIpcListEvent
  | UniversityIpcGetEvent
  | UniversityIpcOpenEvent
  | UniversityIpcOpenTutorialsEvent;

/**
 * Type-guard. Use to narrow a generic `EventRecord` from
 * `getLoggingApi().onEvent('*', ...)` to the typed `UniversityEvent`
 * union.
 */
export function isUniversityEvent(
  ev: EventRecord
): ev is EventRecord & UniversityEvent {
  return Object.values(UNIVERSITY_EVENTS).includes(ev.name as UniversityEventName);
}
