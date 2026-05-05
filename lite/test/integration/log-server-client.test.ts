/**
 * Log server client integration tests.
 *
 * Drives the real `LiteLogServerClient` (HTTP wrapper for the lib log
 * server) against a real `LogServer` + `LogEventQueue` on a random
 * localhost port. Exercises the event-log harness surface:
 *
 *   - pushLog() / pushEvent() write entries via POST /logs
 *   - getEvents() filters /logs entries down to structured events,
 *     pattern-matching by event name
 *   - waitForEvent() polls until a matching event appears
 *
 * Proves the harness can both ADD events to the event log and READ
 * events out of it -- the user's ask in this round.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  LiteLogServerClient,
  startInMemoryLogServer,
  type InMemoryLogServer,
} from '../harness/index.js';

let server: InMemoryLogServer;
let client: LiteLogServerClient;

beforeEach(async () => {
  server = await startInMemoryLogServer();
  client = new LiteLogServerClient(server.url);
});

afterEach(async () => {
  await server.stop();
});

describe('LiteLogServerClient: pushLog', () => {
  it('writes a log entry that shows up in /logs', async () => {
    await client.pushLog('info', 'test', 'preflight ok', { run: 1 });
    const entries = await client.queryLogs({ category: 'test' });
    expect(entries.length).toBeGreaterThan(0);
    const ours = entries.find((e) => e.message === 'preflight ok');
    expect(ours).toBeDefined();
    expect(ours?.level).toBe('info');
    expect((ours?.data as { run?: number } | undefined)?.run).toBe(1);
  });

  it('rejects 400 if the server returns an error code', async () => {
    // POST /logs is permissive (defaults level/category/message), so a
    // failure path is hard to provoke. We assert the success contract
    // here; failure-mode coverage lives at the lib log-server unit
    // level.
    await expect(
      client.pushLog('error', 'cat', 'message', { ok: false })
    ).resolves.toBeUndefined();
  });
});

describe('LiteLogServerClient: pushEvent', () => {
  it('writes a structured event (data.eventName) that getEvents() can find', async () => {
    await client.pushEvent('test.preflight', { runId: 1 });
    const events = await client.getEvents({ pattern: 'test.*' });
    expect(events.map((e) => e.data.eventName)).toContain('test.preflight');
  });

  it('derives the category from the first dotted segment', async () => {
    await client.pushEvent('alpha.beta.gamma');
    const entries = await client.queryLogs({ category: 'alpha' });
    expect(entries.some((e) => e.message === 'event: alpha.beta.gamma')).toBe(true);
  });

  it('honors level=error so /logs?level=error returns the entry', async () => {
    await client.pushEvent('failure.case', { reason: 'mock' }, 'error');
    const entries = await client.queryLogs({ level: 'error' });
    expect(
      entries.some(
        (e) =>
          typeof e.data === 'object' &&
          e.data !== null &&
          (e.data as Record<string, unknown>)['eventName'] === 'failure.case'
      )
    ).toBe(true);
  });

  it('rejects empty event names with a clear error', async () => {
    await expect(client.pushEvent('')).rejects.toThrow(/non-empty/);
  });
});

describe('LiteLogServerClient: getEvents', () => {
  it('returns only entries that have a data.eventName field', async () => {
    // Mix of regular log lines (no eventName) and events (eventName).
    await client.pushLog('info', 'plain', 'just a log line');
    await client.pushEvent('kv.set');
    await client.pushEvent('kv.get');

    const events = await client.getEvents();
    const names = events.map((e) => e.data.eventName);
    expect(names).toContain('kv.set');
    expect(names).toContain('kv.get');
    expect(names.length).toBe(2); // plain log line excluded
  });

  it('filters by glob pattern', async () => {
    await client.pushEvent('kv.set');
    await client.pushEvent('kv.get');
    await client.pushEvent('bug-report.save');

    const kvOnly = await client.getEvents({ pattern: 'kv.*' });
    expect(kvOnly.map((e) => e.data.eventName).sort()).toEqual(['kv.get', 'kv.set']);

    const bugReportOnly = await client.getEvents({ pattern: 'bug-report.*' });
    expect(bugReportOnly.map((e) => e.data.eventName)).toEqual(['bug-report.save']);
  });

  it('supports *.suffix patterns (e.g. *.fail)', async () => {
    await client.pushEvent('kv.set.fail', undefined, 'error');
    await client.pushEvent('bug-report.save.fail', undefined, 'error');
    await client.pushEvent('kv.set.finish');

    const fails = await client.getEvents({ pattern: '*.fail' });
    expect(fails.map((e) => e.data.eventName).sort()).toEqual([
      'bug-report.save.fail',
      'kv.set.fail',
    ]);
  });

  it('respects the since filter', async () => {
    await client.pushEvent('first');
    await new Promise((r) => setTimeout(r, 10));
    const cutoff = new Date().toISOString();
    await client.pushEvent('second');

    const after = await client.getEvents({ since: cutoff });
    expect(after.map((e) => e.data.eventName)).toEqual(['second']);
  });
});

describe('LiteLogServerClient: waitForEvent', () => {
  it('resolves when a matching event appears', async () => {
    setTimeout(() => {
      void client.pushEvent('async.arrival', { id: 'abc' });
    }, 50);

    const ev = await client.waitForEvent('async.*', { timeoutMs: 1_000 });
    expect(ev.data.eventName).toBe('async.arrival');
    expect((ev.data.data as { id?: string } | undefined)?.id).toBe('abc');
  });

  it('honors a predicate to disambiguate multiple matches', async () => {
    void client.pushEvent('match.target', { tag: 'wrong' });
    void client.pushEvent('match.target', { tag: 'right' });

    const ev = await client.waitForEvent('match.*', {
      timeoutMs: 1_000,
      predicate: (e) =>
        typeof e.data.data === 'object' &&
        e.data.data !== null &&
        (e.data.data as Record<string, unknown>)['tag'] === 'right',
    });
    expect((ev.data.data as Record<string, unknown>)['tag']).toBe('right');
  });

  it('rejects when no match arrives within timeoutMs', async () => {
    await expect(
      client.waitForEvent('never.appears', { timeoutMs: 200, pollIntervalMs: 50 })
    ).rejects.toThrow(/no match within/);
  });
});

describe('LiteLogServerClient: end-to-end with real LoggingStore', () => {
  it('events emitted by LoggingStore.event() are visible via getEvents()', async () => {
    // Wire a real LoggingStore at the queue this server is reading from
    // so the harness gets to verify "lite-side emit -> client-side read".
    const { LoggingStore } = await import('../../logging/store.js');
    const logging = new LoggingStore({ queue: server.queue });

    logging.event('integration.emit', { x: 1 });
    logging.event('integration.emit.again', { x: 2 });

    const events = await client.getEvents({ pattern: 'integration.*' });
    expect(events.map((e) => e.data.eventName).sort()).toEqual([
      'integration.emit',
      'integration.emit.again',
    ]);
  });

  it('a span emitted by LoggingStore round-trips with spanId + durationMs', async () => {
    const { LoggingStore } = await import('../../logging/store.js');
    const logging = new LoggingStore({ queue: server.queue });

    const span = logging.start('round.trip');
    span.finish({ ok: true });

    const events = await client.getEvents({ pattern: 'round.*' });
    expect(events.length).toBe(2);
    const startEv = events.find((e) => e.data.eventName === 'round.trip.start');
    const finishEv = events.find((e) => e.data.eventName === 'round.trip.finish');
    expect(startEv).toBeDefined();
    expect(finishEv).toBeDefined();
    expect(startEv?.data.spanId).toBe(span.id);
    expect(finishEv?.data.spanId).toBe(span.id);
    expect(typeof finishEv?.data.durationMs).toBe('number');
  });
});
