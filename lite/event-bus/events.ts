/**
 * Event bus's OWN events -- not to be confused with the `DomainEvent`
 * union the bus emits to consumers. These are operational telemetry
 * about the bus itself: when it translated a raw event, when it
 * persisted, when it failed. Per ADR-032.
 */

import type { EventRecord, SerializedEventError } from '../logging/events.js';

export const EVENT_BUS_EVENTS = {
  TRANSLATED: 'event-bus.translated',
  PERSIST_OK: 'event-bus.persist.ok',
  PERSIST_FAIL: 'event-bus.persist.fail',
  HYDRATE_START: 'event-bus.hydrate.start',
  HYDRATE_FINISH: 'event-bus.hydrate.finish',
  HYDRATE_FAIL: 'event-bus.hydrate.fail',
  IPC_SUBSCRIBE: 'event-bus.ipc.subscribe',
  IPC_RECENT: 'event-bus.ipc.recent',
} as const;

export type EventBusEventName =
  (typeof EVENT_BUS_EVENTS)[keyof typeof EVENT_BUS_EVENTS];

interface EventBusEventBase {
  id: string;
  timestamp: string;
  category: 'event-bus';
}

interface EventBusSpanBase extends EventBusEventBase {
  spanId: string;
}

export interface EventBusTranslatedEvent extends EventBusEventBase {
  name: typeof EVENT_BUS_EVENTS.TRANSLATED;
  level: 'info';
  data: { rawName: string; domainName: string };
}
export interface EventBusPersistOkEvent extends EventBusEventBase {
  name: typeof EVENT_BUS_EVENTS.PERSIST_OK;
  level: 'info';
  data: { count: number };
}
export interface EventBusPersistFailEvent extends EventBusEventBase {
  name: typeof EVENT_BUS_EVENTS.PERSIST_FAIL;
  level: 'error';
  data: { reason: string };
}
export interface EventBusHydrateStartEvent extends EventBusSpanBase {
  name: typeof EVENT_BUS_EVENTS.HYDRATE_START;
  level: 'info';
}
export interface EventBusHydrateFinishEvent extends EventBusSpanBase {
  name: typeof EVENT_BUS_EVENTS.HYDRATE_FINISH;
  level: 'info';
  durationMs: number;
  data: { count: number };
}
export interface EventBusHydrateFailEvent extends EventBusSpanBase {
  name: typeof EVENT_BUS_EVENTS.HYDRATE_FAIL;
  level: 'error';
  durationMs: number;
  error: SerializedEventError;
}
export interface EventBusIpcSubscribeEvent extends EventBusEventBase {
  name: typeof EVENT_BUS_EVENTS.IPC_SUBSCRIBE;
  level: 'info';
}
export interface EventBusIpcRecentEvent extends EventBusEventBase {
  name: typeof EVENT_BUS_EVENTS.IPC_RECENT;
  level: 'info';
}

export type EventBusEvent =
  | EventBusTranslatedEvent
  | EventBusPersistOkEvent
  | EventBusPersistFailEvent
  | EventBusHydrateStartEvent
  | EventBusHydrateFinishEvent
  | EventBusHydrateFailEvent
  | EventBusIpcSubscribeEvent
  | EventBusIpcRecentEvent;

export function isEventBusEvent(ev: EventRecord): ev is EventRecord & EventBusEvent {
  return Object.values(EVENT_BUS_EVENTS).includes(ev.name as EventBusEventName);
}
