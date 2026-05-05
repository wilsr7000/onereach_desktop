/**
 * Discovery module event types -- per-module typed event surface.
 *
 * Per ADR-032 + Rule 12, every module that emits events through the
 * central logging API exposes:
 *
 *   1. A const-typed catalog (`DISCOVERY_EVENTS`) of every name
 *   2. A discriminated union (`DiscoveryEvent`) of typed event records
 *   3. An `onEvent(handler)` helper on the public API
 *
 * Event-name-conformance.test.ts enforces that every literal event
 * name in `discovery/store.ts` lives in this catalog.
 */

import type { EventRecord, SerializedEventError } from '../logging/events.js';

/** Stable event name catalog. Source-of-truth for what discovery/ emits. */
export const DISCOVERY_EVENTS = {
  RESOLVE_START: 'discovery.resolve.start',
  RESOLVE_FINISH: 'discovery.resolve.finish',
  RESOLVE_FAIL: 'discovery.resolve.fail',
  LIST_START: 'discovery.list.start',
  LIST_FINISH: 'discovery.list.finish',
  LIST_FAIL: 'discovery.list.fail',
  CACHE_HIT: 'discovery.cache.hit',
} as const;

export type DiscoveryEventName = (typeof DISCOVERY_EVENTS)[keyof typeof DISCOVERY_EVENTS];

interface DiscoveryEventBase {
  id: string;
  timestamp: string;
  category: 'discovery';
}

interface DiscoverySpanBase extends DiscoveryEventBase {
  spanId: string;
}

// ─── resolve(serviceKey) ──────────────────────────────────────────────────

export interface DiscoveryResolveStartEvent extends DiscoverySpanBase {
  name: typeof DISCOVERY_EVENTS.RESOLVE_START;
  level: 'info';
  data: { serviceKey: string };
}
export interface DiscoveryResolveFinishEvent extends DiscoverySpanBase {
  name: typeof DISCOVERY_EVENTS.RESOLVE_FINISH;
  level: 'info';
  durationMs: number;
  data: { serviceKey: string; cached: boolean };
}
export interface DiscoveryResolveFailEvent extends DiscoverySpanBase {
  name: typeof DISCOVERY_EVENTS.RESOLVE_FAIL;
  level: 'error';
  durationMs: number;
  error: SerializedEventError;
}

// ─── list() ───────────────────────────────────────────────────────────────

export interface DiscoveryListStartEvent extends DiscoverySpanBase {
  name: typeof DISCOVERY_EVENTS.LIST_START;
  level: 'info';
  data?: { type?: string };
}
export interface DiscoveryListFinishEvent extends DiscoverySpanBase {
  name: typeof DISCOVERY_EVENTS.LIST_FINISH;
  level: 'info';
  durationMs: number;
  data: { count: number };
}
export interface DiscoveryListFailEvent extends DiscoverySpanBase {
  name: typeof DISCOVERY_EVENTS.LIST_FAIL;
  level: 'error';
  durationMs: number;
  error: SerializedEventError;
}

// ─── cache hit (instant, not a span) ──────────────────────────────────────

export interface DiscoveryCacheHitEvent extends DiscoveryEventBase {
  name: typeof DISCOVERY_EVENTS.CACHE_HIT;
  level: 'info';
  data: { serviceKey: string };
}

/** Discriminated union -- branch on `ev.name` to narrow `ev.data`. */
export type DiscoveryEvent =
  | DiscoveryResolveStartEvent
  | DiscoveryResolveFinishEvent
  | DiscoveryResolveFailEvent
  | DiscoveryListStartEvent
  | DiscoveryListFinishEvent
  | DiscoveryListFailEvent
  | DiscoveryCacheHitEvent;

/**
 * Type-guard. Use to narrow a generic `EventRecord` to the typed
 * `DiscoveryEvent` union.
 */
export function isDiscoveryEvent(ev: EventRecord): ev is EventRecord & DiscoveryEvent {
  return Object.values(DISCOVERY_EVENTS).includes(ev.name as DiscoveryEventName);
}
