/**
 * Event bus -- PUBLIC API.
 *
 * The only file other lite modules should import from in this module.
 * Per ADR-019 / Rule 11, cross-module imports go through `<module>/api.ts` --
 * never reach into `store.ts`, `translator.ts`, or any other internal file.
 *
 * The bus projects raw module events (from the central logging queue)
 * into a small typed catalogue of `DomainEvent`s that other systems
 * subscribe to without coupling to module internals. Per ADR-043, the
 * subscription surface (`on`, `onPattern`, `recent`, `emit`) IS the
 * public API -- bridged to renderers via `window.lite.events.*`, and
 * called directly by main-process consumers via `getEventBusApi()`.
 *
 * Usage from another lite module (main process):
 *
 *   import { getEventBusApi } from '../event-bus/api.js';
 *   getEventBusApi().on('user.signed-in', (ev) => {
 *     console.log(ev.data.email);
 *   });
 *
 * Usage from a renderer (window):
 *
 *   window.lite.events.on('agent.tab.opened', (ev) => { ... });
 *   const recent = await window.lite.events.recent('user.signed-in', 5);
 *
 * Tests: `_setEventBusApiForTesting(stub)` to inject a custom
 * implementation, `_resetEventBusApiForTesting()` to clear the singleton.
 */

import { EventBusStore } from './store.js';
import { getLoggingApi } from '../logging/api.js';
import { EventBusError, EVENT_BUS_ERROR_CODES } from './errors.js';

// Re-export the domain catalogue (the public schema).
export type {
  DomainEvent,
  DomainEventName,
  EventBusBlob,
  UserSignedInEvent,
  UserSignedOutEvent,
  AgentTabOpenedEvent,
  AgentTabClosedEvent,
  AgentTabActivatedEvent,
  AgentTabFocusedEvent,
  TokenInjectedEvent,
  UpdateAvailableEvent,
  UpdateDownloadedEvent,
  IdwInstalledEvent,
  BugReportSubmittedEvent,
} from './types.js';
export {
  DOMAIN_EVENT_NAMES,
  RING_BUFFER_MAX,
  EVENT_BUS_MODULE_VERSION,
} from './types.js';

// Re-export the structured error class + code catalog.
export type { EventBusErrorCode, EventBusErrorOptions } from './errors.js';
export { EventBusError, EVENT_BUS_ERROR_CODES };

// Re-export the bus's OWN typed event surface (ADR-032 -- not the
// DomainEvent catalogue, but the operational events the bus itself
// emits: translated, persist-ok/fail, hydrate, ipc.subscribe).
export type {
  EventBusEvent,
  EventBusEventName,
  EventBusTranslatedEvent,
  EventBusPersistOkEvent,
  EventBusPersistFailEvent,
  EventBusHydrateStartEvent,
  EventBusHydrateFinishEvent,
  EventBusHydrateFailEvent,
  EventBusIpcSubscribeEvent,
  EventBusIpcRecentEvent,
} from './events.js';
export { EVENT_BUS_EVENTS, isEventBusEvent } from './events.js';

// Generic LiteError so consumers can branch via `instanceof LiteError`.
export { LiteError, isLiteError } from '../errors.js';

import type { DomainEvent, DomainEventName } from './types.js';
import type { EventBusEvent } from './events.js';

/**
 * Optional subscription options.
 *   - `replay: true`  -- on register, synchronously replay any
 *     matching events already in the buffer (most-recent-last)
 *     before any future events.
 *
 * Default is future-only -- the late-subscriber problem is solved
 * explicitly via `recent(name, limit)` for callers that just want a
 * snapshot, or `replay: true` for callers that want their handler
 * to fire over the historical events too.
 */
export interface SubscribeOptions {
  replay?: boolean;
}

/**
 * The public surface of the event bus.
 *
 * **Subscription contract (per ADR-043):**
 *   - `on(name, handler)`        -- type-narrowed by name; future-only by default
 *   - `onPattern(glob, handler)` -- glob-matched (e.g. `agent.tab.*`); generic union
 *   - `recent(name, limit)`      -- snapshot read; doesn't subscribe
 *   - `emit(event)`              -- publish a domain event manually
 *
 * Subscriber callbacks receive the full domain event including
 * `id` + `ts`. Throws inside a handler are swallowed and logged --
 * a buggy subscriber CANNOT bring down emission.
 *
 * **Renderer surface:** every method except `onEvent` (the bus's own
 * operational events) is bridged via `window.lite.events.*`. The
 * renderer surface is async (Promise-wrapped) for `recent`, while
 * `on` / `onPattern` register a listener that is called directly
 * from preload-side IPC events.
 */
export interface EventBusApi {
  /**
   * Subscribe to a single domain event by name. Type narrows the
   * handler's `event.data` automatically.
   *
   * @example
   * getEventBusApi().on('user.signed-in', (ev) => {
   *   metrics.tag({ accountId: ev.data.accountId });
   * });
   */
  on<N extends DomainEventName>(
    name: N,
    handler: (event: Extract<DomainEvent, { name: N }>) => void,
    opts?: SubscribeOptions
  ): () => void;

  /**
   * Subscribe via a glob pattern (e.g. `agent.tab.*`, `user.*`,
   * `*.signed-in`). The handler receives the full discriminated
   * union; branch on `event.name` to narrow.
   *
   * Pass `'*'` to receive every domain event.
   */
  onPattern(
    pattern: string,
    handler: (event: DomainEvent) => void,
    opts?: SubscribeOptions
  ): () => void;

  /**
   * Snapshot read of the most-recent matching events. Pass `null`
   * for `name` to read across all names. `limit` defaults to 50.
   *
   * Returns events in chronological order (oldest first within the
   * snapshot, which is the same order subscribers see them).
   */
  recent(name: DomainEventName | null, limit?: number): DomainEvent[];

  /** Total count of events currently in the ring buffer. */
  size(): number;

  /**
   * Manually emit a domain event. Useful for tests, for one-off
   * signals that don't map cleanly through the translator, or for
   * domain events that originate outside the logging queue.
   *
   * The store enriches the event with `id` + `ts` before fanout, so
   * callers pass the discriminated `{ name, data }` only. Type
   * safety is enforced by the discriminated union -- TS narrows
   * `data` based on `name` at the call site.
   */
  emit(event: Omit<DomainEvent, 'id' | 'ts'>): DomainEvent;

  /**
   * Subscribe to the bus's OWN operational events (translated,
   * persist-ok/fail, hydrate, ipc.subscribe). Distinct from the
   * domain-event subscriptions -- this surface mirrors every other
   * lite module's `onEvent(handler)` per ADR-032.
   *
   * Main-process callers only -- not bridged to the renderer.
   */
  onEvent(handler: (event: EventBusEvent) => void): () => void;
}

let _instance: EventBusApi | null = null;
let _store: EventBusStore | null = null;

/** Get the singleton bus API. Lazily instantiates on first call. */
export function getEventBusApi(): EventBusApi {
  if (_instance === null) {
    const { api, store } = buildDefault();
    _instance = api;
    _store = store;
  }
  return _instance;
}

/** Get the underlying store -- for `main.ts` boot wiring (hydrate, IPC). */
export function getEventBusStore(): EventBusStore {
  if (_store === null) {
    getEventBusApi(); // forces lazy init of both
  }
  // Non-null after getEventBusApi() runs.
  return _store as EventBusStore;
}

/** Reset the singleton (for tests). */
export function _resetEventBusApiForTesting(): void {
  if (_store !== null) {
    try {
      _store.destroy();
    } catch {
      /* best-effort */
    }
  }
  _instance = null;
  _store = null;
}

/** Override the singleton with a custom implementation (for tests). */
export function _setEventBusApiForTesting(api: EventBusApi): void {
  _instance = api;
}

// ─── default implementation ──────────────────────────────────────────────

function buildDefault(): { api: EventBusApi; store: EventBusStore } {
  const store = new EventBusStore({
    logger: (level, message, data) => {
      const log = getLoggingApi();
      log[level]('event-bus', message, data);
    },
  });
  const api: EventBusApi = {
    on: (name, handler, opts) => store.on(name, handler, opts),
    onPattern: (pattern, handler, opts) => store.onPattern(pattern, handler, opts),
    recent: (name, limit) =>
      store.recent(name === null ? undefined : name, limit ?? 50),
    size: () => store.list().length,
    emit: (event) => store.emit(event),
    onEvent: (handler) => store.onEvent(handler),
  };
  return { api, store };
}
