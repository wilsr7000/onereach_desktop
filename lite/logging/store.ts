/**
 * Logging store -- internal class wrapping the lib `LogEventQueue`.
 *
 * Module-internal. Other lite modules MUST NOT import this directly --
 * use `getLoggingApi()` from `./api.ts` (Rule 11 / Rule 12 in
 * lite/LITE-RULES.md, ADR-025 in lite/DECISIONS.md).
 *
 * Contract:
 *
 * - **Logs** (`debug/info/warn/error`) write to the lib queue with a
 *   `category` key. They appear in the log server's `/logs` endpoint
 *   immediately and on the WebSocket stream.
 * - **Events** (`event()`, `start()/Span.finish()/Span.fail()`) write a
 *   richer record (name, spanId, durationMs, error) to BOTH the lib
 *   queue (so they're visible alongside logs) AND a local ring buffer
 *   (so `recent()` can return them synchronously).
 * - **Subscriptions** (`onEvent`) match by glob pattern on the dotted
 *   event name. Backed by a small EventEmitter; cheap.
 *
 * Why a separate ring buffer for events when the lib queue already has
 * one: the lib queue stores all log events including `console.log`
 * mirror entries; filtering it down to "module events" requires shape
 * checks. The local buffer holds only structured events so `recent()`
 * is fast and predictable. Capacity is bounded; oldest evicted first.
 */

import { LiteError } from '../errors.js';
import type { LiteErrorOptions } from '../errors.js';
import {
  Span,
  matchPattern,
  serializeError,
  type EventRecord,
  type LogLevel,
} from './events.js';

/**
 * Category used when the logging module logs about itself (e.g. when a
 * subscriber throws during dispatch, or when a self-protective fallback
 * fires in main-lite's IPC handlers). Re-exported from api.ts so
 * "logging-about-logging" lines route under one consistent category in
 * `/logs?category=logging` rather than ad-hoc string literals.
 */
export const LOGGING_SELF_CATEGORY = 'logging';

/**
 * Stable error codes thrown by the logging module.
 */
export const LOGGING_ERROR_CODES = {
  /** Empty event name, or contains illegal characters. */
  INVALID_EVENT_NAME: 'LOGGING_INVALID_EVENT_NAME',
  /** Subscribe pattern is empty or malformed. */
  INVALID_PATTERN: 'LOGGING_INVALID_PATTERN',
} as const;

export type LoggingErrorCode =
  (typeof LOGGING_ERROR_CODES)[keyof typeof LOGGING_ERROR_CODES];

export interface LoggingErrorOptions extends Omit<LiteErrorOptions, 'code'> {
  code: LoggingErrorCode;
}

/**
 * Structured error from the logging module. See
 * `lite/logging/README.md` "Error catalog".
 */
export class LoggingError extends LiteError {
  constructor(options: LoggingErrorOptions) {
    const baseOptions: LiteErrorOptions = {
      code: options.code,
      message: options.message,
      ...(options.context !== undefined ? { context: options.context } : {}),
      ...(options.remediation !== undefined ? { remediation: options.remediation } : {}),
      ...(options.cause !== undefined ? { cause: options.cause } : {}),
    };
    super(baseOptions);
    this.name = 'LoggingError';
  }
}

/**
 * The lib `LogEventQueue` shape we depend on. Kept narrow so the
 * coupling to `lib/log-event-queue.js` is one type, not the whole
 * surface.
 */
export interface LogEventQueueLike {
  debug(category: string, message: string, data?: unknown): unknown;
  info(category: string, message: string, data?: unknown): unknown;
  warn(category: string, message: string, data?: unknown): unknown;
  error(category: string, message: string, data?: unknown): unknown;
}

export interface LoggingStoreConfig {
  /**
   * Queue to write logs/events into. In production this is the lib
   * `LogEventQueue` singleton (so events show up at port 47392). In
   * tests, inject a fake.
   */
  queue: LogEventQueueLike;
  /**
   * Maximum number of events held in the local ring buffer for
   * `recent()`. Default 1000.
   */
  bufferCapacity?: number;
  /**
   * Function that returns "now" as ms since epoch. Override for tests
   * that want deterministic timestamps. Default `Date.now`.
   */
  now?: () => number;
  /**
   * Function that returns a fresh event id. Override for tests. Default
   * uses `crypto.randomUUID`.
   */
  newId?: () => string;
}

type Subscription = {
  pattern: string;
  handler: (event: EventRecord) => void;
};

const DEFAULT_BUFFER_CAPACITY = 1000;

/**
 * @internal -- consumers go through `getLoggingApi()` from `./api.ts`.
 */
export class LoggingStore {
  private readonly queue: LogEventQueueLike;
  private readonly buffer: EventRecord[] = [];
  private readonly capacity: number;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly subscriptions = new Set<Subscription>();

  constructor(config: LoggingStoreConfig) {
    this.queue = config.queue;
    this.capacity = config.bufferCapacity ?? DEFAULT_BUFFER_CAPACITY;
    this.now = config.now ?? ((): number => Date.now());
    this.newId =
      config.newId ??
      ((): string => {
        if (typeof globalThis.crypto?.randomUUID === 'function') {
          return globalThis.crypto.randomUUID();
        }
        // Fallback for older Node (shouldn't happen on supported runtimes).
        return `id-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
      });
  }

  // ─── Log methods ──────────────────────────────────────────────────────

  debug(category: string, message: string, data?: unknown): void {
    this.queue.debug(category, message, data);
  }

  info(category: string, message: string, data?: unknown): void {
    this.queue.info(category, message, data);
  }

  warn(category: string, message: string, data?: unknown): void {
    this.queue.warn(category, message, data);
  }

  error(category: string, message: string, data?: unknown): void {
    this.queue.error(category, message, data);
  }

  // ─── Event methods ────────────────────────────────────────────────────

  event(name: string, data?: unknown, level: LogLevel = 'info'): void {
    this.assertValidEventName(name);
    const record = this.buildRecord({ name, level, ...(data !== undefined ? { data } : {}) });
    this.publish(record);
  }

  start(name: string, data?: unknown): Span {
    this.assertValidEventName(name);
    const spanId = this.newId();
    const startedAt = this.now();
    // Emit the .start event right away.
    const startRecord = this.buildRecord({
      name: `${name}.start`,
      level: 'info',
      spanId,
      ...(data !== undefined ? { data } : {}),
    });
    this.publish(startRecord);

    return new Span({
      name,
      spanId,
      startedAt,
      now: this.now,
      emit: (childRecord) => {
        // Span emits its finish/fail events through the same publish
        // path so subscriptions catch them.
        const fullRecord = this.buildRecord(childRecord);
        this.publish(fullRecord);
      },
      serializeError,
    });
  }

  // ─── Subscription + recent ────────────────────────────────────────────

  onEvent(pattern: string, handler: (event: EventRecord) => void): () => void {
    if (typeof pattern !== 'string' || pattern.length === 0) {
      throw new LoggingError({
        code: LOGGING_ERROR_CODES.INVALID_PATTERN,
        message: `Invalid subscription pattern: ${JSON.stringify(pattern)}`,
        context: { pattern },
        remediation: 'Pass a non-empty glob pattern (e.g. "kv.*", "*.fail", "*").',
      });
    }
    const sub: Subscription = { pattern, handler };
    this.subscriptions.add(sub);
    return (): void => {
      this.subscriptions.delete(sub);
    };
  }

  recent(pattern: string, limit = 50): EventRecord[] {
    if (typeof pattern !== 'string' || pattern.length === 0) {
      throw new LoggingError({
        code: LOGGING_ERROR_CODES.INVALID_PATTERN,
        message: `Invalid recent() pattern: ${JSON.stringify(pattern)}`,
        context: { pattern },
        remediation: 'Pass a non-empty glob pattern (e.g. "kv.*", "*.fail", "*").',
      });
    }
    const matched: EventRecord[] = [];
    // Buffer is oldest-first; iterate from the end to get newest-first.
    for (let i = this.buffer.length - 1; i >= 0 && matched.length < limit; i--) {
      const ev = this.buffer[i];
      if (ev !== undefined && matchPattern(pattern, ev.name)) {
        matched.push(ev);
      }
    }
    return matched;
  }

  // ─── Internals ────────────────────────────────────────────────────────

  private buildRecord(partial: {
    name: string;
    level: LogLevel;
    data?: unknown;
    spanId?: string;
    parentSpanId?: string;
    durationMs?: number;
    error?: EventRecord['error'];
  }): EventRecord {
    const dotIdx = partial.name.indexOf('.');
    const category = dotIdx >= 0 ? partial.name.slice(0, dotIdx) : partial.name;
    const record: EventRecord = {
      id: this.newId(),
      timestamp: new Date(this.now()).toISOString(),
      name: partial.name,
      category,
      level: partial.level,
      ...(partial.data !== undefined ? { data: partial.data } : {}),
      ...(partial.spanId !== undefined ? { spanId: partial.spanId } : {}),
      ...(partial.parentSpanId !== undefined ? { parentSpanId: partial.parentSpanId } : {}),
      ...(partial.durationMs !== undefined ? { durationMs: partial.durationMs } : {}),
      ...(partial.error !== undefined ? { error: partial.error } : {}),
    };
    return record;
  }

  private publish(record: EventRecord): void {
    // 1. Mirror to the lib queue so the log server / HTTP /logs / WS see it.
    const eventData = {
      eventName: record.name,
      ...(record.spanId !== undefined ? { spanId: record.spanId } : {}),
      ...(record.parentSpanId !== undefined ? { parentSpanId: record.parentSpanId } : {}),
      ...(record.durationMs !== undefined ? { durationMs: record.durationMs } : {}),
      ...(record.error !== undefined ? { error: record.error } : {}),
      ...(record.data !== undefined ? { data: record.data } : {}),
    };
    const message = `event: ${record.name}`;
    const fn = this.queue[record.level];
    if (typeof fn === 'function') {
      fn.call(this.queue, record.category, message, eventData);
    }

    // 2. Append to local ring buffer (newest at end).
    this.buffer.push(record);
    if (this.buffer.length > this.capacity) {
      this.buffer.shift();
    }

    // 3. Notify matching subscribers.
    for (const sub of this.subscriptions) {
      if (matchPattern(sub.pattern, record.name)) {
        try {
          sub.handler(record);
        } catch (err) {
          // Subscriber threw -- isolate the failure. Log via queue;
          // never let a misbehaving subscriber crash the publisher.
          this.queue.warn(LOGGING_SELF_CATEGORY, 'subscriber threw during onEvent dispatch', {
            pattern: sub.pattern,
            eventName: record.name,
            error: (err as Error).message,
          });
        }
      }
    }
  }

  private assertValidEventName(name: string): void {
    if (typeof name !== 'string' || name.length === 0 || /\s/.test(name)) {
      throw new LoggingError({
        code: LOGGING_ERROR_CODES.INVALID_EVENT_NAME,
        message: `Invalid event name: ${JSON.stringify(name)}`,
        context: { name },
        remediation:
          'Use a non-empty dotted name with no whitespace. Convention: "module.action" or "module.action.outcome" (e.g. "kv.set", "bug-report.save.failed").',
      });
    }
  }
}
