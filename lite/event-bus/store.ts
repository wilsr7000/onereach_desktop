/**
 * Event bus store -- the engine.
 *
 * Subscribes once to the central logging queue (`getLoggingApi().onEvent('*')`),
 * runs each raw event through the translator, and:
 *   - pushes the projected `DomainEvent` into an in-memory ring buffer
 *   - fans it out to local subscribers via EventEmitter
 *   - debounces a write to KV (best-effort cross-restart replay)
 *
 * Consumers go through `getEventBusApi()` from `./api.ts` -- this file
 * is module-internal.
 *
 * @internal
 */

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { LiteError } from '../errors.js';
import { getKVApi, KVError } from '../kv/api.js';
import type { KVApi } from '../kv/api.js';
import { getLoggingApi } from '../logging/api.js';
import type { EventRecord } from '../logging/events.js';
import { EventBusError, EVENT_BUS_ERROR_CODES } from './errors.js';
import {
  KV_COLLECTION,
  KV_KEY,
  RING_BUFFER_MAX,
  PERSIST_DEBOUNCE_MS,
  type DomainEvent,
  type DomainEventName,
  type EventBusBlob,
} from './types.js';
import { translate } from './translator.js';
import { EVENT_BUS_EVENTS, isEventBusEvent, type EventBusEvent } from './events.js';

export interface StoreConfig {
  /** Optional KV API override (for tests). */
  kvApi?: KVApi;
  /** Optional logger. */
  logger?: (level: 'info' | 'warn' | 'error', message: string, data?: unknown) => void;
  /** Optional clock for deterministic tests. */
  now?: () => Date;
  /** Optional id generator for deterministic tests. */
  generateId?: () => string;
  /** Override the persistence debounce window (ms). Tests use 0. */
  persistDebounceMs?: number;
  /**
   * If true, the store does NOT subscribe to the logging queue on
   * construction. Tests set this so they can drive the translator
   * by hand via `_ingestForTesting`.
   */
  skipAutoSubscribe?: boolean;
}

/**
 * Internal event bus store. NOT exported to other lite modules --
 * use `getEventBusApi()` from `./api.ts`.
 *
 * @internal
 */
export class EventBusStore {
  private readonly kv: KVApi;
  private readonly log: NonNullable<StoreConfig['logger']>;
  private readonly nowFn: () => Date;
  private readonly genIdFn: () => string;
  private readonly persistDebounceMs: number;
  private readonly emitter = new EventEmitter();
  /** Most-recent-last. Bounded by RING_BUFFER_MAX. */
  private buffer: DomainEvent[] = [];
  private hydrated = false;
  private hydratePromise: Promise<void> | null = null;
  private logSubscription: (() => void) | null = null;
  private persistTimer: NodeJS.Timeout | null = null;
  private dirty = false;

  constructor(config: StoreConfig = {}) {
    this.kv = config.kvApi ?? getKVApi();
    this.log =
      config.logger ??
      ((): void => {
        /* default: silent */
      });
    this.nowFn = config.now ?? ((): Date => new Date());
    this.genIdFn = config.generateId ?? ((): string => randomUUID());
    this.persistDebounceMs = config.persistDebounceMs ?? PERSIST_DEBOUNCE_MS;

    if (config.skipAutoSubscribe !== true) {
      this.attachToLoggingQueue();
    }
  }

  // ─── Public API surface ─────────────────────────────────────────────────

  /**
   * Hydrate the ring buffer from KV. Called once on boot. Coalesces
   * concurrent calls. Soft-fails -- KV miss / parse error logs and
   * continues with an empty buffer.
   */
  hydrate(): Promise<void> {
    if (this.hydrated) return Promise.resolve();
    if (this.hydratePromise !== null) return this.hydratePromise;
    this.hydratePromise = this.runHydrate().finally(() => {
      this.hydratePromise = null;
    });
    return this.hydratePromise;
  }

  /**
   * Return the most-recent-last list of all domain events currently
   * in the buffer (after hydrate). Subscribers that want a slice
   * should filter; the bus stays simple.
   */
  list(): DomainEvent[] {
    return [...this.buffer];
  }

  /**
   * Last N events matching a name, most-recent-last. Pass `undefined`
   * for `name` to read across all names.
   */
  recent(name: DomainEventName | undefined, limit: number): DomainEvent[] {
    const filtered =
      name === undefined ? this.buffer : this.buffer.filter((e) => e.name === name);
    if (limit <= 0) return [];
    return filtered.slice(-limit);
  }

  /**
   * Subscribe to one domain event name. Returns unsubscribe.
   *
   * Default: future-only (no replay). Pass `{ replay: true }` to
   * synchronously replay any matching events already in the buffer
   * before any future events.
   */
  on<N extends DomainEventName>(
    name: N,
    handler: (event: Extract<DomainEvent, { name: N }>) => void,
    opts: { replay?: boolean } = {}
  ): () => void {
    const wrapper = (ev: DomainEvent): void => {
      if (ev.name !== name) return;
      try {
        handler(ev as Extract<DomainEvent, { name: N }>);
      } catch (err) {
        this.log('warn', 'event-bus: subscriber threw', {
          name: ev.name,
          error: (err as Error).message,
        });
      }
    };
    this.emitter.on('domain', wrapper);
    if (opts.replay === true) {
      // Walk a snapshot so a handler that re-subscribes mid-replay
      // doesn't get bitten by the live emitter.
      const snapshot = this.buffer.filter((e) => e.name === name);
      for (const ev of snapshot) {
        try {
          handler(ev as Extract<DomainEvent, { name: N }>);
        } catch (err) {
          this.log('warn', 'event-bus: replay handler threw', {
            name,
            error: (err as Error).message,
          });
        }
      }
    }
    return (): void => {
      this.emitter.off('domain', wrapper);
    };
  }

  /**
   * Subscribe to a glob pattern (e.g. `agent.tab.*`, `user.*`,
   * `*.signed-in`). Returns unsubscribe. The handler receives the
   * full discriminated `DomainEvent` so callers can branch on `name`.
   */
  onPattern(
    pattern: string,
    handler: (event: DomainEvent) => void,
    opts: { replay?: boolean } = {}
  ): () => void {
    const matcher = compileGlob(pattern);
    const wrapper = (ev: DomainEvent): void => {
      if (!matcher(ev.name)) return;
      try {
        handler(ev);
      } catch (err) {
        this.log('warn', 'event-bus: pattern subscriber threw', {
          pattern,
          name: ev.name,
          error: (err as Error).message,
        });
      }
    };
    this.emitter.on('domain', wrapper);
    if (opts.replay === true) {
      const snapshot = this.buffer.filter((e) => matcher(e.name));
      for (const ev of snapshot) {
        try {
          handler(ev);
        } catch (err) {
          this.log('warn', 'event-bus: pattern replay handler threw', {
            pattern,
            error: (err as Error).message,
          });
        }
      }
    }
    return (): void => {
      this.emitter.off('domain', wrapper);
    };
  }

  /**
   * Manually emit a domain event. Useful when a translator rule
   * doesn't cover the case (e.g. a one-off signal a feature wants to
   * publish without going through the logging queue first). Goes
   * through the same fanout + persistence path.
   */
  emit(event: Omit<DomainEvent, 'id' | 'ts'>): DomainEvent {
    const enriched = this.enrich(event);
    this.push(enriched);
    return enriched;
  }

  /**
   * Subscribe to the bus's OWN operational events (translated, persist,
   * hydrate, etc.). Distinct from the domain-event subscriptions.
   */
  onEvent(handler: (ev: EventBusEvent) => void): () => void {
    return getLoggingApi().onEvent('event-bus.*', (ev: EventRecord) => {
      if (isEventBusEvent(ev)) handler(ev as unknown as EventBusEvent);
    });
  }

  /** Tear down the logging queue subscription + persist timer. Idempotent. */
  destroy(): void {
    if (this.logSubscription !== null) {
      try {
        this.logSubscription();
      } catch {
        /* best-effort */
      }
      this.logSubscription = null;
    }
    if (this.persistTimer !== null) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.emitter.removeAllListeners('domain');
  }

  // ─── Test hooks ────────────────────────────────────────────────────────

  /** @internal -- ingest a raw EventRecord directly (skipping the logging queue). */
  _ingestForTesting(raw: EventRecord): void {
    this.handleRaw(raw);
  }

  /** @internal -- force the persist timer to fire now. */
  async _flushPersistForTesting(): Promise<void> {
    if (this.persistTimer !== null) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    await this.persistNow();
  }

  /** @internal -- inspect the buffer without copying. */
  _bufferSizeForTesting(): number {
    return this.buffer.length;
  }

  // ─── Internals ──────────────────────────────────────────────────────────

  private attachToLoggingQueue(): void {
    this.logSubscription = getLoggingApi().onEvent('*', (raw) => {
      this.handleRaw(raw);
    });
  }

  private handleRaw(raw: EventRecord): void {
    // Ignore the bus's own events to prevent translation loops.
    if (raw.category === 'event-bus') return;
    const result = translate(raw);
    if (result === null) return;
    const enriched = this.enrich(result.event);
    this.push(enriched);
    getLoggingApi().event(EVENT_BUS_EVENTS.TRANSLATED, {
      rawName: raw.name,
      domainName: enriched.name,
    });
  }

  private enrich(event: Omit<DomainEvent, 'id' | 'ts'>): DomainEvent {
    return {
      ...event,
      id: this.genIdFn(),
      ts: this.nowFn().toISOString(),
    } as DomainEvent;
  }

  private push(event: DomainEvent): void {
    this.buffer.push(event);
    if (this.buffer.length > RING_BUFFER_MAX) {
      this.buffer.splice(0, this.buffer.length - RING_BUFFER_MAX);
    }
    this.fanout(event);
    this.markDirty();
  }

  private fanout(event: DomainEvent): void {
    // Snapshot listeners so a subscriber that unsubscribes during
    // dispatch doesn't shift the iteration.
    const listeners = this.emitter.listeners('domain') as Array<(ev: DomainEvent) => void>;
    for (const l of listeners) {
      try {
        l(event);
      } catch (err) {
        this.log('warn', 'event-bus: listener threw during fanout', {
          name: event.name,
          error: (err as Error).message,
        });
      }
    }
  }

  private markDirty(): void {
    this.dirty = true;
    if (this.persistDebounceMs <= 0) {
      // Immediate-write mode (used in tests).
      void this.persistNow();
      return;
    }
    if (this.persistTimer !== null) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.persistNow();
    }, this.persistDebounceMs);
  }

  private async persistNow(): Promise<void> {
    if (!this.dirty) return;
    this.dirty = false;
    const blob: EventBusBlob = {
      schemaVersion: 1,
      events: this.buffer.slice(),
    };
    try {
      await this.kv.set(KV_COLLECTION, KV_KEY, blob);
      getLoggingApi().event(EVENT_BUS_EVENTS.PERSIST_OK, { count: blob.events.length });
    } catch (err) {
      const message = err instanceof KVError ? err.formatForUser() : (err as Error).message;
      this.log('warn', 'event-bus: KV persist failed (in-memory state still authoritative)', {
        error: message,
        ...(err instanceof KVError ? { kvCode: err.code } : {}),
      });
      getLoggingApi().event(
        EVENT_BUS_EVENTS.PERSIST_FAIL,
        { reason: message },
        'error'
      );
      // Mark dirty again so the next push tries again.
      this.dirty = true;
    }
  }

  private async runHydrate(): Promise<void> {
    // Span base name -- the logging API's `.start()` auto-appends
    // `.start` / `.finish` / `.fail`, so pass the bare prefix.
    const span = getLoggingApi().start('event-bus.hydrate');
    try {
      const raw = await this.kv.get(KV_COLLECTION, KV_KEY);
      if (raw === null || raw === undefined) {
        this.hydrated = true;
        span.finish({ count: 0 });
        return;
      }
      if (typeof raw !== 'object' || Array.isArray(raw)) {
        this.log('warn', 'event-bus: unexpected KV blob shape, starting empty', {
          actualType: Array.isArray(raw) ? 'array' : typeof raw,
        });
        this.hydrated = true;
        span.finish({ count: 0 });
        return;
      }
      const blob = raw as Partial<EventBusBlob>;
      const events = Array.isArray(blob.events) ? blob.events.filter(isLikelyDomainEvent) : [];
      // Trim to ring buffer size in case the persisted blob came from a
      // larger limit.
      this.buffer =
        events.length > RING_BUFFER_MAX ? events.slice(-RING_BUFFER_MAX) : events;
      this.hydrated = true;
      span.finish({ count: this.buffer.length });
    } catch (err) {
      span.fail(err);
      this.log('warn', 'event-bus: hydrate failed (continuing with empty state)', {
        error: (err as Error).message,
      });
      this.hydrated = true;
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * Compile a glob pattern (`*` = any chars, `**` not supported -- single
 * `*` already crosses dots). Anchored at both ends. Used by
 * `onPattern`.
 */
function compileGlob(pattern: string): (s: string) => boolean {
  // Escape regex metas except `*`, then turn `*` into `.*`.
  const escaped = pattern.replace(/[-/\\^$+?.()|[\]{}]/g, '\\$&').replace(/\*/g, '.*');
  const re = new RegExp(`^${escaped}$`);
  return (s) => re.test(s);
}

/**
 * Loose runtime check used during blob recovery. Not full validation --
 * the discriminated union enforces shape statically; KV recovery just
 * needs to filter out obvious garbage.
 */
function isLikelyDomainEvent(value: unknown): value is DomainEvent {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['name'] === 'string' &&
    typeof v['id'] === 'string' &&
    typeof v['ts'] === 'string'
  );
}

// Wire LiteError so `EventBusError` shows up alongside other module
// errors when test fixtures iterate `instanceof LiteError`.
void LiteError;
void EventBusError;
void EVENT_BUS_ERROR_CODES;
