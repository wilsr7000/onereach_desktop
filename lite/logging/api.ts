/**
 * Logging module -- PUBLIC API.
 *
 * The only file other lite modules import from in this module. Per
 * Rule 11 / Rule 12 (LITE-RULES.md) and ADR-019 / ADR-024 / ADR-025
 * (DECISIONS.md), cross-module imports go through `<module>/api.ts`.
 *
 * Surface:
 *
 * - **Logs** (`debug/info/warn/error(category, message, data?)`) --
 *   classic level + category + message lines. Every modules' default
 *   logger (e.g. `[bug-report]`, `[kv]`) routes through here so output
 *   shows up in the lite log server (`/logs` HTTP, WebSocket, recent
 *   buffer).
 *
 * - **Events** (`event(name, data?, level?)`, `start(name, data?)`) --
 *   structured happenings with dotted names. `start()` returns a
 *   `Span` that emits `<name>.start` immediately and `<name>.finish` /
 *   `<name>.fail` when you call `.finish()` / `.fail()`.
 *
 * - **Subscriptions** (`onEvent(pattern, handler)`, `recent(pattern, limit?)`) --
 *   in-process subscribers can match events by glob pattern; the
 *   `recent()` ring buffer lets the bug reporter capture causal
 *   context automatically.
 *
 * @example
 * ```typescript
 * import { getLoggingApi } from '../logging/api.js';
 *
 * const log = getLoggingApi();
 * log.info('settings', 'theme changed', { newTheme: 'dark' });
 *
 * const span = log.start('kv.set', { collection: 'settings', key: 'theme' });
 * try {
 *   await kv.set('settings', 'theme', value);
 *   span.finish();
 * } catch (err) {
 *   span.fail(err);
 *   throw err;
 * }
 *
 * const last = log.recent('kv.*', 20); // last 20 KV events for diagnostics
 * ```
 */

import { LoggingStore } from './store.js';
import type { LogEventQueueLike, LoggingStoreConfig } from './store.js';
import type { EventRecord, LogLevel, Span } from './events.js';

// Re-export the public types and error class so consumers don't need
// to know that the implementation lives in store.ts / events.ts.
export type { EventRecord, LogLevel, SerializedEventError, Span } from './events.js';
export type { LoggingErrorCode, LoggingErrorOptions } from './store.js';
export { LoggingError, LOGGING_ERROR_CODES, LOGGING_SELF_CATEGORY } from './store.js';
// Generic base class -- consumers can also catch via `instanceof LiteError`.
export { LiteError, isLiteError } from '../errors.js';

/**
 * The public surface of the logging module.
 *
 * **Error contract**: `event()`, `start()`, `onEvent()`, `recent()`
 * throw `LoggingError` (extends `LiteError`) on bad input (empty event
 * names, malformed patterns). Log methods (`debug/info/warn/error`)
 * never throw -- they fall back to silent if the underlying queue
 * misbehaves.
 *
 * See `lite/logging/README.md` for the full event taxonomy and error
 * catalog.
 */
export interface LoggingApi {
  /** Write a debug-level log line. */
  debug(category: string, message: string, data?: unknown): void;
  /** Write an info-level log line. */
  info(category: string, message: string, data?: unknown): void;
  /** Write a warn-level log line. */
  warn(category: string, message: string, data?: unknown): void;
  /** Write an error-level log line. */
  error(category: string, message: string, data?: unknown): void;

  /**
   * Emit an instant event. Convention: dotted name `module.action` or
   * `module.action.outcome` (e.g. `kv.set`, `bug-report.save.failed`).
   *
   * @throws {LoggingError} `LOGGING_INVALID_EVENT_NAME` if `name` is
   *   empty or contains whitespace.
   */
  event(name: string, data?: unknown, level?: LogLevel): void;

  /**
   * Start a span. Returns a {@link Span} you finish() or fail(). Auto-emits
   * `<name>.start` now, `<name>.finish` (or `.fail`) when you complete it.
   *
   * @throws {LoggingError} `LOGGING_INVALID_EVENT_NAME` if `name` is
   *   empty or contains whitespace.
   */
  start(name: string, data?: unknown): Span;

  /**
   * Subscribe to events whose name matches `pattern` (glob: `kv.*`,
   * `*.fail`, `*`). Returns an unsubscribe function.
   *
   * @throws {LoggingError} `LOGGING_INVALID_PATTERN` if `pattern` is
   *   empty.
   */
  onEvent(pattern: string, handler: (event: EventRecord) => void): () => void;

  /**
   * Synchronously get the last N matching events from the ring buffer.
   * Returns newest-first.
   *
   * @throws {LoggingError} `LOGGING_INVALID_PATTERN` if `pattern` is
   *   empty.
   */
  recent(pattern: string, limit?: number): EventRecord[];
}

let _instance: LoggingApi | null = null;

/**
 * Get the singleton logging API. Lazily instantiates on first call.
 *
 * Default backing implementation is `LoggingStore` wired to the lib
 * `LogEventQueue` singleton (the same queue that drives the lite log
 * server on port 47392). To override (e.g. for tests, or to wire to a
 * fake queue), use `_setLoggingApiForTesting()` before this is first
 * called, or call `_resetLoggingApiForTesting()` to clear and re-init.
 *
 * @returns The shared `LoggingApi` instance.
 */
export function getLoggingApi(): LoggingApi {
  if (_instance === null) {
    _instance = new LoggingStore(defaultConfig());
  }
  return _instance;
}

/** Reset the singleton (for tests). */
export function _resetLoggingApiForTesting(): void {
  _instance = null;
}

/**
 * Override the singleton with a custom implementation (for tests). The
 * provided value is returned by subsequent `getLoggingApi()` calls
 * until reset.
 */
export function _setLoggingApiForTesting(api: LoggingApi): void {
  _instance = api;
}

/**
 * Default store config -- resolves the lib `LogEventQueue` singleton
 * lazily so production code routes events into the same queue that
 * drives the log server on port 47392.
 *
 * Resolves the lib path the same way `lite/main-lite.ts` does:
 * `path.resolve(__dirname, '..', '..', 'lib')` from `dist-lite/build/`.
 */
function defaultConfig(): LoggingStoreConfig {
  return {
    queue: resolveLibQueue(),
  };
}

function resolveLibQueue(): LogEventQueueLike {
  // Lazy require so the module file itself stays parseable in
  // environments that don't have the lib on disk (e.g. unit tests
  // override the API via `_setLoggingApiForTesting` before the
  // default ever fires).
  // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
  const path = require('node:path') as typeof import('node:path');
  const libDir = path.resolve(__dirname, '..', '..', 'lib');
  // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
  const { getLogQueue } = require(path.join(libDir, 'log-event-queue')) as {
    getLogQueue: () => LogEventQueueLike;
  };
  return getLogQueue();
}
