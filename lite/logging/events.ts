/**
 * Logging events -- shared types + Span class + glob pattern matcher.
 *
 * Module-internal (re-exported via `./api.ts`).
 */

import { LiteError } from '../errors.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Serialized form of an underlying error attached to a span's `.fail`
 * event. Consumers can safely JSON.stringify; no circular refs.
 */
export interface SerializedEventError {
  code: string;
  message: string;
  remediation: string;
  /** Frozen context fields from `LiteError`. Truncated for log readability. */
  context?: Record<string, unknown>;
  /** Original `Error.name` so we don't lose the underlying class. */
  name?: string;
}

/**
 * Public event record. Emitted by `event()`, `start()`, `Span.finish()`,
 * `Span.fail()`. Consumed by `onEvent` subscribers and `recent()`.
 */
export interface EventRecord {
  /** Unique id (UUID). */
  id: string;
  /** ISO 8601 timestamp. */
  timestamp: string;
  /** Dotted event name, e.g. `kv.set.start`. */
  name: string;
  /** First dotted segment (`kv` for `kv.set.start`). */
  category: string;
  /** Severity. Default `info` for events; spans use the same default. */
  level: LogLevel;
  /** Caller-supplied payload. Anything JSON-stringify-able. */
  data?: unknown;
  /** Correlation id when this event came from a span (start/finish/fail). */
  spanId?: string;
  /** Parent span correlation id, if any. */
  parentSpanId?: string;
  /** ms elapsed between span start and finish/fail. */
  durationMs?: number;
  /** Serialized error from `Span.fail()`. */
  error?: SerializedEventError;
}

/**
 * Public span handle. Returned by `LoggingApi.start(name, data?)`. Call
 * `.finish()` or `.fail()` exactly once; subsequent calls are ignored
 * (so callers can wrap finish/fail in try/finally without
 * double-emitting).
 */
export class Span {
  public readonly name: string;
  public readonly id: string;
  private readonly startedAt: number;
  private readonly nowFn: () => number;
  private readonly emit: (record: SpanEmitInput) => void;
  private readonly serializeErr: (err: unknown) => SerializedEventError;
  private done = false;

  constructor(opts: SpanConstructorOpts) {
    this.name = opts.name;
    this.id = opts.spanId;
    this.startedAt = opts.startedAt;
    this.nowFn = opts.now;
    this.emit = opts.emit;
    this.serializeErr = opts.serializeError;
  }

  /**
   * Emit `<name>.finish` with elapsed durationMs. Idempotent: subsequent
   * calls (or a finish after a fail) are no-ops, so try/finally is safe.
   */
  finish(data?: unknown): void {
    if (this.done) return;
    this.done = true;
    this.emit({
      name: `${this.name}.finish`,
      level: 'info',
      spanId: this.id,
      durationMs: this.nowFn() - this.startedAt,
      ...(data !== undefined ? { data } : {}),
    });
  }

  /**
   * Emit `<name>.fail` with elapsed durationMs and a serialized error.
   * Idempotent: subsequent calls (or a fail after a finish) are no-ops.
   */
  fail(error: unknown, data?: unknown): void {
    if (this.done) return;
    this.done = true;
    this.emit({
      name: `${this.name}.fail`,
      level: 'error',
      spanId: this.id,
      durationMs: this.nowFn() - this.startedAt,
      error: this.serializeErr(error),
      ...(data !== undefined ? { data } : {}),
    });
  }
}

interface SpanConstructorOpts {
  name: string;
  spanId: string;
  startedAt: number;
  now: () => number;
  emit: (record: SpanEmitInput) => void;
  serializeError: (err: unknown) => SerializedEventError;
}

export interface SpanEmitInput {
  name: string;
  level: LogLevel;
  spanId: string;
  parentSpanId?: string;
  durationMs?: number;
  data?: unknown;
  error?: SerializedEventError;
}

/**
 * Serialize an arbitrary thrown value for inclusion on a `.fail` event.
 * `LiteError` instances surface code/message/remediation/context.
 * Plain Errors fall back to name/message. Non-Error values stringify.
 */
export function serializeError(err: unknown): SerializedEventError {
  if (err instanceof LiteError) {
    return {
      code: err.code,
      message: err.message,
      remediation: err.remediation,
      context: { ...err.context },
      name: err.name,
    };
  }
  if (err instanceof Error) {
    return {
      code: 'UNKNOWN',
      message: err.message,
      remediation: 'See logs for stack trace.',
      name: err.name,
    };
  }
  let stringified: string;
  try {
    stringified = typeof err === 'string' ? err : JSON.stringify(err);
  } catch {
    stringified = String(err);
  }
  return {
    code: 'UNKNOWN',
    message: stringified,
    remediation: 'Non-Error thrown value; review the source of the throw.',
  };
}

/**
 * Glob pattern matcher for event names.
 *
 * Supported syntax:
 *   `*`            matches anything (including empty).
 *   `<prefix>.*`   matches anything that starts with `<prefix>.`.
 *   `*.<suffix>`   matches anything that ends with `.<suffix>`.
 *   `<exact>`      exact match.
 *   `<a>.*.<b>`    `<a>.` prefix + `.<b>` suffix (greedy middle).
 *
 * Doesn't try to be a full glob -- just the patterns we want for log
 * filtering. Tested in `lite/test/unit/logging-events.test.ts`.
 *
 * @example
 * ```typescript
 * matchPattern('kv.*', 'kv.set');           // true
 * matchPattern('kv.*', 'kv.set.start');     // true
 * matchPattern('kv.*', 'bug-report.save');  // false
 * matchPattern('*.fail', 'kv.set.fail');    // true
 * matchPattern('*', 'anything');            // true
 * ```
 */
export function matchPattern(pattern: string, name: string): boolean {
  if (pattern === '*' || pattern === name) return true;

  const starIdx = pattern.indexOf('*');
  if (starIdx === -1) return false; // exact-only pattern, already failed

  // Split pattern around its first star and require name to begin with
  // the prefix and end with the suffix. This handles the three useful
  // shapes (`prefix.*`, `*.suffix`, `prefix.*.suffix`).
  const prefix = pattern.slice(0, starIdx);
  const suffix = pattern.slice(starIdx + 1);
  if (prefix.length > 0 && !name.startsWith(prefix)) return false;
  if (suffix.length > 0 && !name.endsWith(suffix)) return false;
  return name.length >= prefix.length + suffix.length;
}
