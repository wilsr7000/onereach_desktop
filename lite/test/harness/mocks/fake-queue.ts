/**
 * `FakeQueue` -- in-memory `LogEventQueueLike` for tests.
 *
 * Records every log write (`debug/info/warn/error`) into a public `entries`
 * array so tests can assert "did the central queue see this?" without
 * standing up the lib `LogEventQueue` singleton.
 *
 * Use in two places:
 *
 *   - **`LoggingStore` validation tests** that need a real store (so
 *     `event('')` actually throws) but don't want to load the lib queue
 *     from disk -- inject `new LoggingStore({ queue: new FakeQueue() })`
 *     via `_setLoggingApiForTesting`.
 *   - **Integration tests** that drive cross-module flow through a real
 *     `LoggingStore` and want to inspect what landed on the queue.
 *
 * For unit tests of consumers that only care about the `LoggingApi`
 * surface (events recorded, span events captured), use `FakeLogging`
 * from `./fake-logging.js` instead -- it implements the public API
 * directly and avoids any queue plumbing.
 */

import type { LogEventQueueLike } from '../../../logging/store.js';

export interface FakeQueueEntry {
  level: 'debug' | 'info' | 'warn' | 'error';
  category: string;
  message: string;
  data?: unknown;
}

export class FakeQueue implements LogEventQueueLike {
  public readonly entries: FakeQueueEntry[] = [];

  debug(category: string, message: string, data?: unknown): void {
    this.entries.push({ level: 'debug', category, message, ...(data !== undefined ? { data } : {}) });
  }
  info(category: string, message: string, data?: unknown): void {
    this.entries.push({ level: 'info', category, message, ...(data !== undefined ? { data } : {}) });
  }
  warn(category: string, message: string, data?: unknown): void {
    this.entries.push({ level: 'warn', category, message, ...(data !== undefined ? { data } : {}) });
  }
  error(category: string, message: string, data?: unknown): void {
    this.entries.push({ level: 'error', category, message, ...(data !== undefined ? { data } : {}) });
  }

  /** Drop all recorded entries. */
  clear(): void {
    this.entries.length = 0;
  }
}
