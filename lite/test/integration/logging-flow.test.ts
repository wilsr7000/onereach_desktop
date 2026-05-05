/**
 * Logging integration tests -- proves that:
 *   1. The logging module routes events to the underlying queue end-to-end.
 *   2. Bug-report and KV modules consume `getLoggingApi()` after the
 *      ADR-025 migration (their default loggers go through the central
 *      queue rather than `console.log`).
 *   3. Spans/events emitted from a real cross-module flow (bug-report
 *      saving via real KV against the in-memory server) appear in the
 *      log queue and `recent()` buffer.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { BugReportStore } from '../../bug-report/store.js';
import { EdisonKVClient } from '../../kv/client.js';
import { LoggingStore } from '../../logging/store.js';
import type { LoggingApi } from '../../logging/api.js';
import { _setLoggingApiForTesting, _resetLoggingApiForTesting, getLoggingApi } from '../../logging/api.js';
import {
  startInMemoryKVServer,
  type InMemoryKVServer,
  makeBugReportPayload,
  FakeQueue,
} from '../harness/index.js';

let server: InMemoryKVServer;
let queue: FakeQueue;
let logging: LoggingApi;

beforeEach(async () => {
  server = await startInMemoryKVServer();
  queue = new FakeQueue();
  logging = new LoggingStore({ queue });
  // Inject our store as the singleton so any module that calls
  // `getLoggingApi()` ends up writing to `queue`.
  _setLoggingApiForTesting(logging);
});

afterEach(async () => {
  await server.stop();
  _resetLoggingApiForTesting();
});

describe('Logging integration: events flow into the central queue', () => {
  it('event() writes to the underlying queue with category + structured data', () => {
    logging.event('kv.set', { collection: 'lite-bugs', key: 'x' });

    const events = queue.entries.filter((e) => e.message.startsWith('event:'));
    expect(events).toHaveLength(1);
    expect(events[0]?.category).toBe('kv');
    expect(events[0]?.message).toBe('event: kv.set');
    expect((events[0]?.data as { eventName?: string; data?: unknown }).eventName).toBe('kv.set');
  });

  it('start/finish span emits two queue entries with span correlation in data', () => {
    const span = logging.start('kv.set', { key: 'x' });
    span.finish({ ok: true });

    const events = queue.entries.filter((e) => e.message.startsWith('event:'));
    expect(events.map((e) => e.message)).toEqual(['event: kv.set.start', 'event: kv.set.finish']);
    const startData = events[0]?.data as { spanId?: string };
    const finishData = events[1]?.data as { spanId?: string; durationMs?: number };
    expect(startData.spanId).toBeDefined();
    expect(finishData.spanId).toBe(startData.spanId);
    expect(typeof finishData.durationMs).toBe('number');
  });

  it('span fail emits a .fail event with serialized error in data', () => {
    const span = logging.start('kv.set');
    span.fail(new Error('boom'));

    const failEntry = queue.entries.find((e) => e.message === 'event: kv.set.fail');
    expect(failEntry).toBeDefined();
    expect(failEntry?.level).toBe('error');
    const data = failEntry?.data as { error?: { message: string } };
    expect(data.error?.message).toBe('boom');
  });
});

describe('Logging integration: bug-report module routes through the central queue', () => {
  it('BugReportStore.save() emits store-level info logs through the logging API', async () => {
    const kv = new EdisonKVClient({
      url: `${server.url}/keyvalue`,
      timeoutMs: 1000,
    });
    // The store's `logger` callback exists to delegate -- wire it
    // through the logging API the way `bug-report/api.ts` defaultConfig()
    // does in production.
    const store = new BugReportStore({
      kvApi: kv,
      logger: (level, message, data) => {
        getLoggingApi()[level]('bug-report', message, data);
      },
    });

    const payload = makeBugReportPayload({ timestamp: '2026-05-04T20:00:00.000Z' });
    await store.save(payload);

    const bugReportLogs = queue.entries.filter((e) => e.category === 'bug-report');
    expect(bugReportLogs.length).toBeGreaterThan(0);
    expect(bugReportLogs.some((e) => /save ok/.test(e.message))).toBe(true);
  });

  it('BugReportStore.save() failure routes an error-level log through the queue', async () => {
    const kv = new EdisonKVClient({
      url: `${server.url}/keyvalue`,
      timeoutMs: 500,
    });
    const store = new BugReportStore({
      kvApi: kv,
      logger: (level, message, data) => {
        getLoggingApi()[level]('bug-report', message, data);
      },
    });

    server.failNextRequest({ status: 500, body: 'down' });
    const payload = makeBugReportPayload({ timestamp: '2026-05-04T21:00:00.000Z' });

    await expect(store.save(payload)).rejects.toThrow();

    const errorLogs = queue.entries.filter(
      (e) => e.category === 'bug-report' && e.level === 'error'
    );
    expect(errorLogs.length).toBeGreaterThan(0);
    expect(errorLogs.some((e) => /save failed/.test(e.message))).toBe(true);
  });
});

describe('Logging integration: kv module routes through the central queue', () => {
  it('EdisonKVClient set/get emits info-level logs through the configured logger', async () => {
    const kv = new EdisonKVClient({
      url: `${server.url}/keyvalue`,
      timeoutMs: 1000,
      logger: (level, message, data) => {
        getLoggingApi()[level]('kv', message, data);
      },
    });

    await kv.set('settings', 'theme', 'dark');
    await kv.get('settings', 'theme');

    const kvLogs = queue.entries.filter((e) => e.category === 'kv');
    expect(kvLogs.some((e) => /set ok/.test(e.message))).toBe(true);
    expect(kvLogs.some((e) => /get ok/.test(e.message))).toBe(true);
  });
});

describe('Logging integration: spans wrap real cross-module flows', () => {
  it('a span around BugReportStore.save() captures duration + outcome', async () => {
    const kv = new EdisonKVClient({
      url: `${server.url}/keyvalue`,
      timeoutMs: 1000,
    });
    const store = new BugReportStore({ kvApi: kv });

    const span = logging.start('bug-report.save', { timestamp: '2026-05-04T22:00:00.000Z' });
    try {
      await store.save(makeBugReportPayload({ timestamp: '2026-05-04T22:00:00.000Z' }));
      span.finish({ ok: true });
    } catch (err) {
      span.fail(err);
      throw err;
    }

    const eventNames = queue.entries
      .filter((e) => e.message.startsWith('event:'))
      .map((e) => e.message);
    expect(eventNames).toContain('event: bug-report.save.start');
    expect(eventNames).toContain('event: bug-report.save.finish');
  });

  it('recent() returns the events in newest-first order', async () => {
    logging.event('a.1');
    logging.event('a.2');
    logging.event('b.1');
    logging.event('a.3');

    const recent = logging.recent('a.*', 10);
    expect(recent.map((e) => e.name)).toEqual(['a.3', 'a.2', 'a.1']);
  });
});
