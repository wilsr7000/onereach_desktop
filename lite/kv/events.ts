/**
 * KV module event types -- per-module typed event surface.
 *
 * Per ADR-032, every module that emits events through the central
 * logging API also exposes:
 *
 *   1. A const-typed constants object (`KV_EVENTS`) listing every name
 *   2. A discriminated union (`KvEvent`) of typed event records, one
 *      interface per emitted name
 *   3. An `onEvent(handler)` helper on the public API that subscribes
 *      via `getLoggingApi().onEvent('kv.*', ...)` and casts.
 *
 * Consumers branch via `switch (ev.name)` and TypeScript narrows
 * `ev.data` accordingly. Adding a new event requires updating both
 * the implementation site AND this file -- the meta-test in
 * `lite/test/unit/module-conformance.test.ts` enforces correspondence.
 */

import type { EventRecord } from '../logging/events.js';
import type { SerializedEventError } from '../logging/events.js';

/** Stable event name catalog. Source-of-truth for what kv/ emits. */
export const KV_EVENTS = {
  SET_START: 'kv.set.start',
  SET_FINISH: 'kv.set.finish',
  SET_FAIL: 'kv.set.fail',
  GET_START: 'kv.get.start',
  GET_FINISH: 'kv.get.finish',
  GET_FAIL: 'kv.get.fail',
  LIST_KEYS_START: 'kv.listKeys.start',
  LIST_KEYS_FINISH: 'kv.listKeys.finish',
  LIST_KEYS_FAIL: 'kv.listKeys.fail',
  LIST_START: 'kv.list.start',
  LIST_FINISH: 'kv.list.finish',
  LIST_FAIL: 'kv.list.fail',
  DELETE_START: 'kv.delete.start',
  DELETE_FINISH: 'kv.delete.finish',
  DELETE_FAIL: 'kv.delete.fail',
} as const;

export type KvEventName = (typeof KV_EVENTS)[keyof typeof KV_EVENTS];

/**
 * Common shape on every KV event. Mirrors `EventRecord` but pins
 * `category` to `'kv'` and pulls in only the fields KV emits.
 */
interface KvEventBase {
  id: string;
  timestamp: string;
  category: 'kv';
  spanId: string;
}

interface KvSpanStartData {
  collection: string;
  /** Present for set/get/delete; undefined for listKeys/list. */
  key?: string;
}

interface KvSpanFinishData {
  /** Set on `kv.list.finish` only -- count of records returned. */
  count?: number;
}

// ─── set ──────────────────────────────────────────────────────────────────

export interface KvSetStartEvent extends KvEventBase {
  name: typeof KV_EVENTS.SET_START;
  level: 'info';
  data: KvSpanStartData;
}
export interface KvSetFinishEvent extends KvEventBase {
  name: typeof KV_EVENTS.SET_FINISH;
  level: 'info';
  durationMs: number;
  data?: KvSpanFinishData;
}
export interface KvSetFailEvent extends KvEventBase {
  name: typeof KV_EVENTS.SET_FAIL;
  level: 'error';
  durationMs: number;
  error: SerializedEventError;
}

// ─── get ──────────────────────────────────────────────────────────────────

export interface KvGetStartEvent extends KvEventBase {
  name: typeof KV_EVENTS.GET_START;
  level: 'info';
  data: KvSpanStartData;
}
export interface KvGetFinishEvent extends KvEventBase {
  name: typeof KV_EVENTS.GET_FINISH;
  level: 'info';
  durationMs: number;
  data?: KvSpanFinishData;
}
export interface KvGetFailEvent extends KvEventBase {
  name: typeof KV_EVENTS.GET_FAIL;
  level: 'error';
  durationMs: number;
  error: SerializedEventError;
}

// ─── listKeys ─────────────────────────────────────────────────────────────

export interface KvListKeysStartEvent extends KvEventBase {
  name: typeof KV_EVENTS.LIST_KEYS_START;
  level: 'info';
  data: KvSpanStartData;
}
export interface KvListKeysFinishEvent extends KvEventBase {
  name: typeof KV_EVENTS.LIST_KEYS_FINISH;
  level: 'info';
  durationMs: number;
  data?: KvSpanFinishData;
}
export interface KvListKeysFailEvent extends KvEventBase {
  name: typeof KV_EVENTS.LIST_KEYS_FAIL;
  level: 'error';
  durationMs: number;
  error: SerializedEventError;
}

// ─── list ─────────────────────────────────────────────────────────────────

export interface KvListStartEvent extends KvEventBase {
  name: typeof KV_EVENTS.LIST_START;
  level: 'info';
  data: KvSpanStartData;
}
export interface KvListFinishEvent extends KvEventBase {
  name: typeof KV_EVENTS.LIST_FINISH;
  level: 'info';
  durationMs: number;
  data: { count: number };
}
export interface KvListFailEvent extends KvEventBase {
  name: typeof KV_EVENTS.LIST_FAIL;
  level: 'error';
  durationMs: number;
  error: SerializedEventError;
}

// ─── delete ───────────────────────────────────────────────────────────────

export interface KvDeleteStartEvent extends KvEventBase {
  name: typeof KV_EVENTS.DELETE_START;
  level: 'info';
  data: KvSpanStartData;
}
export interface KvDeleteFinishEvent extends KvEventBase {
  name: typeof KV_EVENTS.DELETE_FINISH;
  level: 'info';
  durationMs: number;
  data?: KvSpanFinishData;
}
export interface KvDeleteFailEvent extends KvEventBase {
  name: typeof KV_EVENTS.DELETE_FAIL;
  level: 'error';
  durationMs: number;
  error: SerializedEventError;
}

/** Discriminated union -- branch on `ev.name` to narrow `ev.data`. */
export type KvEvent =
  | KvSetStartEvent
  | KvSetFinishEvent
  | KvSetFailEvent
  | KvGetStartEvent
  | KvGetFinishEvent
  | KvGetFailEvent
  | KvListKeysStartEvent
  | KvListKeysFinishEvent
  | KvListKeysFailEvent
  | KvListStartEvent
  | KvListFinishEvent
  | KvListFailEvent
  | KvDeleteStartEvent
  | KvDeleteFinishEvent
  | KvDeleteFailEvent;

/**
 * Type-guard. Use to narrow a generic `EventRecord` from
 * `getLoggingApi().onEvent('*', ...)` to the typed `KvEvent` union.
 */
export function isKvEvent(ev: EventRecord): ev is EventRecord & KvEvent {
  return Object.values(KV_EVENTS).includes(ev.name as KvEventName);
}
