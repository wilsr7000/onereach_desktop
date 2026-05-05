/**
 * Onereach Lite Test Harness -- log server HTTP client.
 *
 * Lite's log server (lib/log-server.js, port 47392) exposes the same REST
 * surface as full's. This client wraps the endpoints relevant to tests:
 * /health, /logs, /logs/stats, /logging/level.
 *
 * Borrowed pattern: the snapshotErrors / checkNewErrors / setLogLevel
 * shape from full's test/e2e/helpers/electron-app.js.
 */

import { sleep, LITE_LOG_SERVER } from './launch.js';
import { matchPattern } from '../../logging/events.js';

export interface LogEntry {
  timestamp: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  category: string;
  message: string;
  data?: unknown;
}

/**
 * A `LogEntry` whose `data` field came from a structured event emitted
 * via `LoggingApi.event()` / `Span.finish()` / `Span.fail()`. The
 * `eventName` field is what `getEvents()` and `waitForEvent()` filter on.
 */
export interface EventLogEntry extends LogEntry {
  data: {
    eventName: string;
    spanId?: string;
    parentSpanId?: string;
    durationMs?: number;
    error?: unknown;
    data?: unknown;
  };
}

/** Options for `LiteLogServerClient.getEvents()`. */
export interface GetEventsOptions {
  /** Only return events whose `data.eventName` matches the pattern. */
  pattern?: string;
  /** Only return events at or after this ISO timestamp. */
  since?: string;
  /** Hard cap on the number of returned entries (default 200). */
  limit?: number;
}

/** Options for `LiteLogServerClient.waitForEvent()`. */
export interface WaitForEventOptions {
  /** Total wait deadline (ms). Default 5000. */
  timeoutMs?: number;
  /** Polling interval (ms). Default 200. */
  pollIntervalMs?: number;
  /** Optional secondary predicate run on each candidate match. */
  predicate?: (entry: EventLogEntry) => boolean;
}

export interface LogStats {
  byLevel: Record<string, number>;
  byCategory: Record<string, number>;
  total: number;
}

export interface LogSnapshot {
  /** ISO timestamp of when the snapshot was taken. */
  timestamp: string;
  /** Errors counted at snapshot time. */
  errorCount: number;
  /** Warnings counted at snapshot time. */
  warnCount: number;
}

export interface QueryLogsParams {
  level?: 'debug' | 'info' | 'warn' | 'error';
  category?: string;
  since?: string;
  until?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

export type LogLevel = 'off' | 'error' | 'warn' | 'info' | 'debug';

/**
 * Lite log-server client. Default base URL is http://127.0.0.1:47392.
 * Override only if testing against a non-standard port.
 */
export class LiteLogServerClient {
  constructor(private readonly baseUrl: string = LITE_LOG_SERVER) {}

  async health(): Promise<{
    status: string;
    appVersion?: string;
    uptime?: number;
    [key: string]: unknown;
  }> {
    const res = await fetch(`${this.baseUrl}/health`);
    if (!res.ok) throw new Error(`health failed: ${res.status}`);
    return res.json() as Promise<{
      status: string;
      appVersion?: string;
      uptime?: number;
    }>;
  }

  async getStats(): Promise<LogStats> {
    const res = await fetch(`${this.baseUrl}/logs/stats`);
    if (!res.ok) throw new Error(`stats failed: ${res.status}`);
    const raw = (await res.json()) as Partial<LogStats>;
    return {
      byLevel: raw.byLevel ?? {},
      byCategory: raw.byCategory ?? {},
      total: raw.total ?? 0,
    };
  }

  async queryLogs(params: QueryLogsParams = {}): Promise<LogEntry[]> {
    const qs = new URLSearchParams();
    if (params.level !== undefined) qs.set('level', params.level);
    if (params.category !== undefined) qs.set('category', params.category);
    if (params.since !== undefined) qs.set('since', params.since);
    if (params.until !== undefined) qs.set('until', params.until);
    if (params.search !== undefined) qs.set('search', params.search);
    if (params.limit !== undefined) qs.set('limit', String(params.limit));
    if (params.offset !== undefined) qs.set('offset', String(params.offset));
    const res = await fetch(`${this.baseUrl}/logs?${qs.toString()}`);
    if (!res.ok) throw new Error(`logs query failed: ${res.status}`);
    const data = (await res.json()) as { logs?: LogEntry[]; data?: LogEntry[] };
    return data.logs ?? data.data ?? [];
  }

  /**
   * Snapshot the current error/warn counts. Pair with `errorsSince` to
   * find errors that appeared after a specific moment in a test.
   */
  async snapshot(): Promise<LogSnapshot> {
    const stats = await this.getStats();
    return {
      timestamp: new Date().toISOString(),
      errorCount: stats.byLevel.error ?? 0,
      warnCount: stats.byLevel.warn ?? 0,
    };
  }

  /**
   * Get errors since the snapshot. Convenience wrapper -- equivalent to
   * `queryLogs({ level: 'error', since: snap.timestamp })`.
   */
  async errorsSince(snap: LogSnapshot, limit: number = 50): Promise<LogEntry[]> {
    return this.queryLogs({ level: 'error', since: snap.timestamp, limit });
  }

  /**
   * Wait until a log entry matching the predicate appears, or the timeout
   * elapses. Polls /logs every 200ms.
   */
  async waitForLogEvent(
    predicate: (entry: LogEntry) => boolean,
    opts: { timeoutMs?: number; pollIntervalMs?: number } = {}
  ): Promise<LogEntry> {
    const timeoutMs = opts.timeoutMs ?? 5_000;
    const pollIntervalMs = opts.pollIntervalMs ?? 200;
    const startedAt = new Date().toISOString();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const entries = await this.queryLogs({ since: startedAt, limit: 100 });
      const match = entries.find(predicate);
      if (match !== undefined) return match;
      await sleep(pollIntervalMs);
    }
    throw new Error(`waitForLogEvent: no matching entry within ${timeoutMs}ms`);
  }

  async setLogLevel(level: LogLevel): Promise<void> {
    const res = await fetch(`${this.baseUrl}/logging/level`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ level }),
    });
    if (!res.ok) throw new Error(`setLogLevel failed: ${res.status}`);
  }

  async getLogLevel(): Promise<{ level: LogLevel } & Record<string, unknown>> {
    const res = await fetch(`${this.baseUrl}/logging/level`);
    if (!res.ok) throw new Error(`getLogLevel failed: ${res.status}`);
    return res.json() as Promise<{ level: LogLevel }>;
  }

  // ─── Event log: push + read ───────────────────────────────────────────

  /**
   * Push a raw log entry into the queue via `POST /logs`.
   *
   * @example
   * ```typescript
   * await client.pushLog('info', 'test', 'preflight ok', { run: 1 });
   * ```
   */
  async pushLog(
    level: 'debug' | 'info' | 'warn' | 'error',
    category: string,
    message: string,
    data?: unknown
  ): Promise<void> {
    const res = await fetch(`${this.baseUrl}/logs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        level,
        category,
        message,
        ...(data !== undefined ? { data } : {}),
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`pushLog failed: ${res.status} ${text}`);
    }
  }

  /**
   * Push a structured event into the log queue. Mirrors the shape that
   * `LoggingStore.publish()` produces, so harness-injected events are
   * indistinguishable from real ones at the read side.
   *
   * The first dotted segment of `name` becomes the entry's category
   * (matching the in-process behavior).
   *
   * @example
   * ```typescript
   * await client.pushEvent('test.preflight', { runId: 1 });
   * await client.pushEvent('kv.fail', { reason: 'mock' }, 'error');
   * ```
   */
  async pushEvent(
    name: string,
    data?: unknown,
    level: 'debug' | 'info' | 'warn' | 'error' = 'info'
  ): Promise<void> {
    if (typeof name !== 'string' || name.length === 0) {
      throw new Error('pushEvent: name must be a non-empty string');
    }
    const dotIdx = name.indexOf('.');
    const category = dotIdx >= 0 ? name.slice(0, dotIdx) : name;
    await this.pushLog(level, category, `event: ${name}`, {
      eventName: name,
      ...(data !== undefined ? { data } : {}),
    });
  }

  /**
   * Read structured events back from the log queue. Filters `/logs`
   * entries down to those carrying a `data.eventName` (i.e. emitted via
   * the logging API), optionally pattern-matching the event name.
   *
   * @example
   * ```typescript
   * const kvEvents = await client.getEvents({ pattern: 'kv.*', limit: 50 });
   * const fails = await client.getEvents({ pattern: '*.fail' });
   * ```
   */
  async getEvents(opts: GetEventsOptions = {}): Promise<EventLogEntry[]> {
    const { pattern, since, limit = 200 } = opts;
    const params: QueryLogsParams = { limit };
    if (since !== undefined) params.since = since;
    const entries = await this.queryLogs(params);
    const events: EventLogEntry[] = [];
    for (const entry of entries) {
      if (!isEventEntry(entry)) continue;
      if (pattern !== undefined && !matchPattern(pattern, entry.data.eventName)) continue;
      events.push(entry);
    }
    return events;
  }

  /**
   * Wait until a structured event whose name matches `pattern` appears
   * in the log queue, or `timeoutMs` elapses. Polls every
   * `pollIntervalMs` (default 200).
   *
   * @example
   * ```typescript
   * const finishEv = await client.waitForEvent('kv.set.finish', {
   *   timeoutMs: 3_000,
   *   predicate: (e) => e.data.spanId === expectedSpanId,
   * });
   * ```
   */
  async waitForEvent(
    pattern: string,
    opts: WaitForEventOptions = {}
  ): Promise<EventLogEntry> {
    const timeoutMs = opts.timeoutMs ?? 5_000;
    const pollIntervalMs = opts.pollIntervalMs ?? 200;
    const startedAt = new Date().toISOString();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const events = await this.getEvents({ pattern, since: startedAt, limit: 200 });
      const match =
        opts.predicate !== undefined ? events.find(opts.predicate) : events[0];
      if (match !== undefined) return match;
      await sleep(pollIntervalMs);
    }
    throw new Error(`waitForEvent("${pattern}"): no match within ${timeoutMs}ms`);
  }
}

/**
 * Type-guard: a log entry is an "event entry" iff `data.eventName` is a
 * non-empty string. Mirrors the shape `LoggingStore.publish()` writes.
 */
function isEventEntry(entry: LogEntry): entry is EventLogEntry {
  if (typeof entry.data !== 'object' || entry.data === null) return false;
  const data = entry.data as Record<string, unknown>;
  return typeof data['eventName'] === 'string' && (data['eventName'] as string).length > 0;
}

// ---------------------------------------------------------------------------
// Assertion ergonomics: expectEvent / expectSpan
//
// These wrap waitForEvent / getEvents with the assertion-style API tests
// reach for. They throw on failure with concrete error messages, so a
// vitest test using them gets clear feedback without each test having
// to write its own polling logic.
// ---------------------------------------------------------------------------

/**
 * Assert that an event matching the pattern arrives within the timeout.
 * Throws with a clear message on timeout. Wraps `waitForEvent`.
 *
 * @example
 * ```typescript
 * await expectEvent(client, 'kv.set.start', { timeoutMs: 2_000 });
 * ```
 */
export async function expectEvent(
  client: LiteLogServerClient,
  pattern: string,
  opts: WaitForEventOptions = {}
): Promise<EventLogEntry> {
  return client.waitForEvent(pattern, opts);
}

/**
 * Assert that a span (`<name>.start` followed by `<name>.finish`) was
 * emitted. Returns the start record, the finish record, and the
 * computed `durationMs` for further assertions.
 *
 * - Polls until both records arrive or the timeout fires.
 * - The two records are matched by their `spanId` -- if multiple spans
 *   for the same name are in flight, this picks the first matched pair.
 * - Use `expectSpanFail` for the `.fail` variant.
 *
 * @example
 * ```typescript
 * const { start, finish, durationMs } = await expectSpan(client, 'kv.set');
 * expect(durationMs).toBeGreaterThan(0);
 * ```
 */
export async function expectSpan(
  client: LiteLogServerClient,
  name: string,
  opts: { timeoutMs?: number; pollIntervalMs?: number } = {}
): Promise<{ start: EventLogEntry; finish: EventLogEntry; durationMs: number; spanId: string }> {
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const pollIntervalMs = opts.pollIntervalMs ?? 200;
  const startedAt = new Date().toISOString();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const startEvents = await client.getEvents({
      pattern: `${name}.start`,
      since: startedAt,
      limit: 200,
    });
    for (const startEv of startEvents) {
      const spanId = startEv.data.spanId;
      if (typeof spanId !== 'string') continue;
      // Look for the matching finish.
      const finishEvents = await client.getEvents({
        pattern: `${name}.finish`,
        since: startedAt,
        limit: 200,
      });
      const finishEv = finishEvents.find((e) => e.data.spanId === spanId);
      if (finishEv !== undefined) {
        const durationMs = typeof finishEv.data.durationMs === 'number' ? finishEv.data.durationMs : -1;
        return { start: startEv, finish: finishEv, durationMs, spanId };
      }
    }
    await sleep(pollIntervalMs);
  }
  throw new Error(`expectSpan("${name}"): no matching .start + .finish pair within ${timeoutMs}ms`);
}

/**
 * Assert that a span ended with a `.fail` (not `.finish`). Returns the
 * start record and the fail record (which carries `error: { code, ... }`).
 *
 * @example
 * ```typescript
 * const { fail } = await expectSpanFail(client, 'kv.set');
 * expect(fail.data.error?.code).toBe('KV_TIMEOUT');
 * ```
 */
export async function expectSpanFail(
  client: LiteLogServerClient,
  name: string,
  opts: { timeoutMs?: number; pollIntervalMs?: number } = {}
): Promise<{ start: EventLogEntry; fail: EventLogEntry; durationMs: number; spanId: string }> {
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const pollIntervalMs = opts.pollIntervalMs ?? 200;
  const startedAt = new Date().toISOString();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const startEvents = await client.getEvents({
      pattern: `${name}.start`,
      since: startedAt,
      limit: 200,
    });
    for (const startEv of startEvents) {
      const spanId = startEv.data.spanId;
      if (typeof spanId !== 'string') continue;
      const failEvents = await client.getEvents({
        pattern: `${name}.fail`,
        since: startedAt,
        limit: 200,
      });
      const failEv = failEvents.find((e) => e.data.spanId === spanId);
      if (failEv !== undefined) {
        const durationMs = typeof failEv.data.durationMs === 'number' ? failEv.data.durationMs : -1;
        return { start: startEv, fail: failEv, durationMs, spanId };
      }
    }
    await sleep(pollIntervalMs);
  }
  throw new Error(`expectSpanFail("${name}"): no matching .start + .fail pair within ${timeoutMs}ms`);
}

/**
 * Common benign errors that appear during normal lite kernel boot/teardown
 * and should be filtered out when asserting "no errors". Keep this list
 * small -- the kernel surface is intentionally narrow.
 */
export const BENIGN_LITE_ERROR_PATTERNS: ReadonlyArray<RegExp> = [
  /ResizeObserver loop/i,
  /Content Security Policy/i,
  /violates the following Content Security Policy/i,
];

export function filterBenignLiteErrors(errors: LogEntry[]): LogEntry[] {
  return errors.filter((e) => {
    const msg = e.message ?? '';
    return !BENIGN_LITE_ERROR_PATTERNS.some((p) => p.test(msg));
  });
}
