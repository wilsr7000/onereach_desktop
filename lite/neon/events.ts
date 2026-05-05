/**
 * Neon module event types -- per-module typed event surface.
 *
 * Per ADR-032, every module that emits events through the central
 * logging API also exposes:
 *
 *   1. A const-typed constants object (`NEON_EVENTS`) listing every name
 *   2. A discriminated union (`NeonEvent`) of typed event records, one
 *      interface per emitted name
 *   3. An `onEvent(handler)` helper on the public API that subscribes
 *      via `getLoggingApi().onEvent('neon.*', ...)` and casts.
 *
 * Consumers branch via `switch (ev.name)` and TypeScript narrows
 * `ev.data` accordingly. Adding a new event requires updating both
 * the implementation site AND this file -- the `event-name-conformance`
 * meta-test enforces correspondence.
 */

import type { EventRecord } from '../logging/events.js';
import type { SerializedEventError } from '../logging/events.js';

/** Stable event name catalog. Source-of-truth for what neon/ emits. */
export const NEON_EVENTS = {
  // query span
  QUERY_START: 'neon.query.start',
  QUERY_FINISH: 'neon.query.finish',
  QUERY_FAIL: 'neon.query.fail',
  // ping span (cheap "RETURN 1 AS ok" round-trip)
  PING_START: 'neon.ping.start',
  PING_FINISH: 'neon.ping.finish',
  PING_FAIL: 'neon.ping.fail',
  // configure span (write-through to credentials provider)
  CONFIGURE_START: 'neon.configure.start',
  CONFIGURE_FINISH: 'neon.configure.finish',
  CONFIGURE_FAIL: 'neon.configure.fail',
  // IPC entry markers (ADR-030: handlers emit on entry)
  IPC_QUERY: 'neon.ipc.query',
  IPC_STATUS: 'neon.ipc.status',
  IPC_TEST_CONNECTION: 'neon.ipc.test-connection',
  IPC_CONFIGURE: 'neon.ipc.configure',
} as const;

export type NeonEventName = (typeof NEON_EVENTS)[keyof typeof NEON_EVENTS];

/**
 * Common shape on every Neon event. Mirrors `EventRecord` but pins
 * `category` to `'neon'`.
 */
interface NeonEventBase {
  id: string;
  timestamp: string;
  category: 'neon';
}

interface NeonSpanBase extends NeonEventBase {
  spanId: string;
}

// ─── query ────────────────────────────────────────────────────────────────

interface NeonQueryStartData {
  /** First 200 characters of the Cypher (truncated for log volume). */
  cypher: string;
  /** Number of bound parameters. The values themselves are never logged. */
  paramCount: number;
}

interface NeonQueryFinishData {
  recordCount: number;
}

export interface NeonQueryStartEvent extends NeonSpanBase {
  name: typeof NEON_EVENTS.QUERY_START;
  level: 'info';
  data: NeonQueryStartData;
}
export interface NeonQueryFinishEvent extends NeonSpanBase {
  name: typeof NEON_EVENTS.QUERY_FINISH;
  level: 'info';
  durationMs: number;
  data: NeonQueryFinishData;
}
export interface NeonQueryFailEvent extends NeonSpanBase {
  name: typeof NEON_EVENTS.QUERY_FAIL;
  level: 'error';
  durationMs: number;
  error: SerializedEventError;
}

// ─── ping ─────────────────────────────────────────────────────────────────

export interface NeonPingStartEvent extends NeonSpanBase {
  name: typeof NEON_EVENTS.PING_START;
  level: 'info';
}
export interface NeonPingFinishEvent extends NeonSpanBase {
  name: typeof NEON_EVENTS.PING_FINISH;
  level: 'info';
  durationMs: number;
  data: { ok: boolean };
}
export interface NeonPingFailEvent extends NeonSpanBase {
  name: typeof NEON_EVENTS.PING_FAIL;
  level: 'error';
  durationMs: number;
  error: SerializedEventError;
}

// ─── configure ────────────────────────────────────────────────────────────

interface NeonConfigureStartData {
  /** Which fields the caller asked to update. Values are never logged. */
  fields: string[];
}

export interface NeonConfigureStartEvent extends NeonSpanBase {
  name: typeof NEON_EVENTS.CONFIGURE_START;
  level: 'info';
  data: NeonConfigureStartData;
}
export interface NeonConfigureFinishEvent extends NeonSpanBase {
  name: typeof NEON_EVENTS.CONFIGURE_FINISH;
  level: 'info';
  durationMs: number;
}
export interface NeonConfigureFailEvent extends NeonSpanBase {
  name: typeof NEON_EVENTS.CONFIGURE_FAIL;
  level: 'error';
  durationMs: number;
  error: SerializedEventError;
}

// ─── IPC instant events ───────────────────────────────────────────────────

export interface NeonIpcQueryEvent extends NeonEventBase {
  name: typeof NEON_EVENTS.IPC_QUERY;
  level: 'info';
}
export interface NeonIpcStatusEvent extends NeonEventBase {
  name: typeof NEON_EVENTS.IPC_STATUS;
  level: 'info';
}
export interface NeonIpcTestConnectionEvent extends NeonEventBase {
  name: typeof NEON_EVENTS.IPC_TEST_CONNECTION;
  level: 'info';
}
export interface NeonIpcConfigureEvent extends NeonEventBase {
  name: typeof NEON_EVENTS.IPC_CONFIGURE;
  level: 'info';
}

/** Discriminated union -- branch on `ev.name` to narrow `ev.data`. */
export type NeonEvent =
  | NeonQueryStartEvent
  | NeonQueryFinishEvent
  | NeonQueryFailEvent
  | NeonPingStartEvent
  | NeonPingFinishEvent
  | NeonPingFailEvent
  | NeonConfigureStartEvent
  | NeonConfigureFinishEvent
  | NeonConfigureFailEvent
  | NeonIpcQueryEvent
  | NeonIpcStatusEvent
  | NeonIpcTestConnectionEvent
  | NeonIpcConfigureEvent;

/**
 * Type-guard. Use to narrow a generic `EventRecord` from
 * `getLoggingApi().onEvent('*', ...)` to the typed `NeonEvent` union.
 */
export function isNeonEvent(ev: EventRecord): ev is EventRecord & NeonEvent {
  return Object.values(NEON_EVENTS).includes(ev.name as NeonEventName);
}
