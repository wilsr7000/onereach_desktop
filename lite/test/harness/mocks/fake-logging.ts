/**
 * `FakeLogging` -- in-memory `LoggingApi` for tests.
 *
 * Records every log/event/subscription call so tests can assert
 * "this code emitted X events" without standing up the real lib queue.
 *
 * Use for unit tests that consume `getLoggingApi()`. For integration
 * tests that want events to actually flow through the lib queue and
 * appear at the log server, use the real `LoggingStore` with the lib
 * `LogEventQueue` (or a `FakeQueue` you implement inline).
 */

import { Span, matchPattern, serializeError, type EventRecord, type LogLevel, type SerializedEventError, type SpanEmitInput } from '../../../logging/events.js';
import type { LoggingApi } from '../../../logging/api.js';

interface RecordedLog {
  level: LogLevel;
  category: string;
  message: string;
  data?: unknown;
}

interface FakeLoggingOptions {
  /** Optional override for the `now()` source. Default Date.now. */
  now?: () => number;
  /** Optional override for the id source. Default counter-based. */
  newId?: () => string;
}

/**
 * In-memory implementation of `LoggingApi`. All calls are recorded;
 * inspect via the public arrays + `events`.
 */
export class FakeLogging implements LoggingApi {
  /** Every debug/info/warn/error call, in order. */
  public readonly logs: RecordedLog[] = [];
  /** Every event/span event, in order, in a fully-formed EventRecord shape. */
  public readonly events: EventRecord[] = [];

  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly subscriptions: Array<{
    pattern: string;
    handler: (event: EventRecord) => void;
  }> = [];
  private idCounter = 0;

  constructor(options: FakeLoggingOptions = {}) {
    this.now = options.now ?? ((): number => Date.now());
    this.newId =
      options.newId ??
      ((): string => {
        this.idCounter++;
        return `fake-${this.idCounter}`;
      });
  }

  // ─── Log methods ──────────────────────────────────────────────────────

  debug(category: string, message: string, data?: unknown): void {
    this.logs.push({ level: 'debug', category, message, ...(data !== undefined ? { data } : {}) });
  }
  info(category: string, message: string, data?: unknown): void {
    this.logs.push({ level: 'info', category, message, ...(data !== undefined ? { data } : {}) });
  }
  warn(category: string, message: string, data?: unknown): void {
    this.logs.push({ level: 'warn', category, message, ...(data !== undefined ? { data } : {}) });
  }
  error(category: string, message: string, data?: unknown): void {
    this.logs.push({ level: 'error', category, message, ...(data !== undefined ? { data } : {}) });
  }

  // ─── Event methods ────────────────────────────────────────────────────

  event(name: string, data?: unknown, level: LogLevel = 'info'): void {
    this.publish(this.buildRecord({ name, level, ...(data !== undefined ? { data } : {}) }));
  }

  start(name: string, data?: unknown): Span {
    const spanId = this.newId();
    const startedAt = this.now();
    this.publish(
      this.buildRecord({
        name: `${name}.start`,
        level: 'info',
        spanId,
        ...(data !== undefined ? { data } : {}),
      })
    );
    return new Span({
      name,
      spanId,
      startedAt,
      now: this.now,
      emit: (record: SpanEmitInput) => this.publish(this.buildRecord(record)),
      serializeError,
    });
  }

  // ─── Subscription + recent ────────────────────────────────────────────

  onEvent(pattern: string, handler: (event: EventRecord) => void): () => void {
    const sub = { pattern, handler };
    this.subscriptions.push(sub);
    return (): void => {
      const i = this.subscriptions.indexOf(sub);
      if (i >= 0) this.subscriptions.splice(i, 1);
    };
  }

  recent(pattern: string, limit = 50): EventRecord[] {
    const matched: EventRecord[] = [];
    for (let i = this.events.length - 1; i >= 0 && matched.length < limit; i--) {
      const ev = this.events[i];
      if (ev !== undefined && matchPattern(pattern, ev.name)) matched.push(ev);
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
    error?: SerializedEventError;
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
    this.events.push(record);
    for (const sub of this.subscriptions) {
      if (matchPattern(sub.pattern, record.name)) {
        try {
          sub.handler(record);
        } catch {
          // swallow -- tests assert against `events`, not subscriber failures
        }
      }
    }
  }
}
