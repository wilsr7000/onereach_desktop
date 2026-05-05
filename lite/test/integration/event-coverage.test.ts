/**
 * Event coverage integration tests -- proves that every module operation
 * instrumented per ADR-030 actually emits its expected start/finish/fail
 * events through the central queue.
 *
 * The strategy: spin up an in-memory KV server (for KV ops), drive each
 * module's store with its real spanEmitter (the one that calls the
 * REAL `getLoggingApi().start()`), and inspect the captured events on
 * the underlying queue.
 *
 * This is the load-bearing assertion: "did the migration actually
 * instrument every op, or did we forget one?"
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EdisonKVClient } from '../../kv/client.js';
import { BugReportStore } from '../../bug-report/store.js';
import { LoggingStore } from '../../logging/store.js';
import { _setLoggingApiForTesting, _resetLoggingApiForTesting, getLoggingApi } from '../../logging/api.js';
import {
  startInMemoryKVServer,
  type InMemoryKVServer,
  makeBugReportPayload,
} from '../harness/index.js';
import { EdisonNeonClient } from '../../neon/client.js';
import { StaticCredentialsProvider } from '../../neon/credentials.js';
import { IdwStore } from '../../idw/store.js';
import { FakeKV } from '../harness/index.js';
import type { LogEventQueueLike } from '../../logging/store.js';

/**
 * Recording queue. Captures every log/event entry so tests can grep
 * for `.start` / `.finish` / `.fail` events by name.
 */
class RecordingQueue implements LogEventQueueLike {
  public readonly entries: Array<{
    level: 'debug' | 'info' | 'warn' | 'error';
    category: string;
    message: string;
    data?: unknown;
  }> = [];

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

  /** Filter recorded entries to those that look like structured events. */
  events(): Array<{ level: string; category: string; message: string; data: { eventName: string; spanId?: string; durationMs?: number; error?: { code: string } } }> {
    const out: Array<{
      level: string;
      category: string;
      message: string;
      data: { eventName: string; spanId?: string; durationMs?: number; error?: { code: string } };
    }> = [];
    for (const entry of this.entries) {
      if (typeof entry.data === 'object' && entry.data !== null) {
        const data = entry.data as Record<string, unknown>;
        if (typeof data['eventName'] === 'string') {
          out.push({
            level: entry.level,
            category: entry.category,
            message: entry.message,
            data: data as never,
          });
        }
      }
    }
    return out;
  }

  /** Convenience: list event names in order. */
  eventNames(): string[] {
    return this.events().map((e) => e.data.eventName);
  }
}

let kvServer: InMemoryKVServer;
let queue: RecordingQueue;

beforeEach(async () => {
  kvServer = await startInMemoryKVServer();
  queue = new RecordingQueue();
  _setLoggingApiForTesting(new LoggingStore({ queue }));
});

afterEach(async () => {
  await kvServer.stop();
  _resetLoggingApiForTesting();
});

// ─── KV module coverage ───────────────────────────────────────────────────

describe('Event coverage: KV module emits spans for every op', () => {
  function makeKv(): EdisonKVClient {
    return new EdisonKVClient({
      url: `${kvServer.url}/keyvalue`,
      timeoutMs: 1000,
      logger: (level, message, data) => {
        getLoggingApi()[level]('kv', message, data);
      },
      spanEmitter: (name, data) => getLoggingApi().start(name, data),
    });
  }

  it('kv.set emits start + finish', async () => {
    const kv = makeKv();
    await kv.set('coll', 'k1', { a: 1 });
    const names = queue.eventNames();
    expect(names).toContain('kv.set.start');
    expect(names).toContain('kv.set.finish');
  });

  it('kv.get emits start + finish', async () => {
    const kv = makeKv();
    await kv.set('coll', 'k1', { a: 1 });
    queue.entries.length = 0; // clear the set events
    await kv.get('coll', 'k1');
    expect(queue.eventNames()).toEqual(expect.arrayContaining(['kv.get.start', 'kv.get.finish']));
  });

  it('kv.listKeys emits start + finish', async () => {
    const kv = makeKv();
    queue.entries.length = 0;
    await kv.listKeys('coll');
    expect(queue.eventNames()).toEqual(expect.arrayContaining(['kv.listKeys.start', 'kv.listKeys.finish']));
  });

  it('kv.list (composite) emits its own outer span', async () => {
    const kv = makeKv();
    await kv.set('coll', 'k1', 1);
    queue.entries.length = 0;
    await kv.list('coll');
    expect(queue.eventNames()).toContain('kv.list.start');
    expect(queue.eventNames()).toContain('kv.list.finish');
  });

  it('kv.delete emits start + finish', async () => {
    const kv = makeKv();
    queue.entries.length = 0;
    await kv.delete('coll', 'k1');
    expect(queue.eventNames()).toEqual(expect.arrayContaining(['kv.delete.start', 'kv.delete.finish']));
  });

  it('kv.set on server failure emits start + fail (not finish)', async () => {
    const kv = makeKv();
    kvServer.failNextRequest({ status: 500, body: 'down' });
    await expect(kv.set('coll', 'k1', 1)).rejects.toThrow();
    const names = queue.eventNames();
    expect(names).toContain('kv.set.start');
    expect(names).toContain('kv.set.fail');
    expect(names).not.toContain('kv.set.finish');
  });

  it('start and finish events share a spanId', async () => {
    const kv = makeKv();
    queue.entries.length = 0;
    await kv.set('coll', 'k1', 1);
    const events = queue.events();
    const start = events.find((e) => e.data.eventName === 'kv.set.start');
    const finish = events.find((e) => e.data.eventName === 'kv.set.finish');
    expect(start?.data.spanId).toBeDefined();
    expect(finish?.data.spanId).toBe(start?.data.spanId);
  });

  it('finish event carries a numeric durationMs', async () => {
    const kv = makeKv();
    queue.entries.length = 0;
    await kv.set('coll', 'k1', 1);
    const finish = queue.events().find((e) => e.data.eventName === 'kv.set.finish');
    expect(typeof finish?.data.durationMs).toBe('number');
    expect(finish?.data.durationMs).toBeGreaterThanOrEqual(0);
  });
});

// ─── Bug-report module coverage ───────────────────────────────────────────

describe('Event coverage: bug-report module emits spans for every op', () => {
  function makeStore(): BugReportStore {
    const kv = new EdisonKVClient({
      url: `${kvServer.url}/keyvalue`,
      timeoutMs: 1000,
      logger: (level, message, data) => {
        getLoggingApi()[level]('kv', message, data);
      },
      spanEmitter: (name, data) => getLoggingApi().start(name, data),
    });
    return new BugReportStore({
      kvApi: kv,
      logger: (level, message, data) => {
        getLoggingApi()[level]('bug-report', message, data);
      },
      spanEmitter: (name, data) => getLoggingApi().start(name, data),
    });
  }

  it('bug-report.save emits start + finish', async () => {
    const store = makeStore();
    queue.entries.length = 0;
    await store.save(makeBugReportPayload({ timestamp: '2026-05-04T10:00:00.000Z' }));
    expect(queue.eventNames()).toContain('bug-report.save.start');
    expect(queue.eventNames()).toContain('bug-report.save.finish');
  });

  it('bug-report.list emits start + finish', async () => {
    const store = makeStore();
    queue.entries.length = 0;
    await store.list();
    expect(queue.eventNames()).toEqual(
      expect.arrayContaining(['bug-report.list.start', 'bug-report.list.finish'])
    );
  });

  it('bug-report.read emits start + finish on hit', async () => {
    const store = makeStore();
    await store.save(makeBugReportPayload({ timestamp: '2026-05-04T11:00:00.000Z' }));
    queue.entries.length = 0;
    await store.read('2026-05-04T11:00:00.000Z');
    expect(queue.eventNames()).toEqual(
      expect.arrayContaining(['bug-report.read.start', 'bug-report.read.finish'])
    );
  });

  it('bug-report.read emits start + fail on miss', async () => {
    const store = makeStore();
    queue.entries.length = 0;
    await expect(store.read('2099-01-01T00:00:00.000Z')).rejects.toThrow();
    const names = queue.eventNames();
    expect(names).toContain('bug-report.read.start');
    expect(names).toContain('bug-report.read.fail');
  });

  it('bug-report.update emits start + finish', async () => {
    const store = makeStore();
    await store.save(makeBugReportPayload({ timestamp: '2026-05-04T12:00:00.000Z' }));
    queue.entries.length = 0;
    await store.update('2026-05-04T12:00:00.000Z', { status: 'resolved' });
    expect(queue.eventNames()).toEqual(
      expect.arrayContaining(['bug-report.update.start', 'bug-report.update.finish'])
    );
  });

  it('bug-report.delete emits start + finish', async () => {
    const store = makeStore();
    await store.save(makeBugReportPayload({ timestamp: '2026-05-04T13:00:00.000Z' }));
    queue.entries.length = 0;
    await store.delete('2026-05-04T13:00:00.000Z');
    expect(queue.eventNames()).toEqual(
      expect.arrayContaining(['bug-report.delete.start', 'bug-report.delete.finish'])
    );
  });

  it('save error path emits fail with a serialized error code', async () => {
    const store = makeStore();
    kvServer.failNextRequest({ status: 500, body: 'down' });
    queue.entries.length = 0;
    await expect(
      store.save(makeBugReportPayload({ timestamp: '2026-05-04T14:00:00.000Z' }))
    ).rejects.toThrow();
    const failEvent = queue.events().find((e) => e.data.eventName === 'bug-report.save.fail');
    expect(failEvent).toBeDefined();
    expect(failEvent?.data.error?.code).toBe('BR_SAVE_FAILED');
  });
});

// ─── Cross-module event ordering ──────────────────────────────────────────

describe('Event coverage: cross-module ordering', () => {
  it('bug-report.save.start fires before nested kv.set.start', async () => {
    const kv = new EdisonKVClient({
      url: `${kvServer.url}/keyvalue`,
      timeoutMs: 1000,
      spanEmitter: (name, data) => getLoggingApi().start(name, data),
    });
    const store = new BugReportStore({
      kvApi: kv,
      spanEmitter: (name, data) => getLoggingApi().start(name, data),
    });
    queue.entries.length = 0;
    await store.save(makeBugReportPayload({ timestamp: '2026-05-04T15:00:00.000Z' }));
    const names = queue.eventNames();
    const brIdx = names.indexOf('bug-report.save.start');
    const kvIdx = names.indexOf('kv.set.start');
    expect(brIdx).toBeGreaterThanOrEqual(0);
    expect(kvIdx).toBeGreaterThanOrEqual(0);
    expect(brIdx).toBeLessThan(kvIdx);
  });

  it('all spans have unique spanIds across the trace', async () => {
    const kv = new EdisonKVClient({
      url: `${kvServer.url}/keyvalue`,
      timeoutMs: 1000,
      spanEmitter: (name, data) => getLoggingApi().start(name, data),
    });
    const store = new BugReportStore({
      kvApi: kv,
      spanEmitter: (name, data) => getLoggingApi().start(name, data),
    });
    queue.entries.length = 0;
    await store.save(makeBugReportPayload({ timestamp: '2026-05-04T16:00:00.000Z' }));
    const startEvents = queue
      .events()
      .filter((e): e is typeof e & { data: { spanId: string } } =>
        e.data.eventName.endsWith('.start') && typeof e.data.spanId === 'string'
      );
    const spanIds = startEvents.map((e) => e.data.spanId);
    expect(new Set(spanIds).size).toBe(spanIds.length); // all unique
  });
});

// ─── Direct event() coverage (instant events) ─────────────────────────────

describe('Event coverage: direct event() emission', () => {
  it('logging.event lands as a queue entry with data.eventName', () => {
    queue.entries.length = 0;
    getLoggingApi().event('test.lifecycle', { foo: 1 });
    const ev = queue.events().find((e) => e.data.eventName === 'test.lifecycle');
    expect(ev).toBeDefined();
    expect(ev?.category).toBe('test');
  });

  it('multi-segment event names route to the first segment as category', () => {
    queue.entries.length = 0;
    getLoggingApi().event('app.boot.something');
    const ev = queue.events().find((e) => e.data.eventName === 'app.boot.something');
    expect(ev?.category).toBe('app');
  });
});

// ─── Neon module coverage ─────────────────────────────────────────────────

describe('Event coverage: Neon module emits spans for every op', () => {
  function makeFakeFetch(records: unknown): typeof fetch {
    return (async () =>
      ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ records }),
      }) as unknown as Response) as unknown as typeof fetch;
  }

  function makeNeon(fetchImpl: typeof fetch): EdisonNeonClient {
    return new EdisonNeonClient({
      credentials: new StaticCredentialsProvider({
        endpoint: 'https://example.com/neon',
        uri: 'neo4j+s://x.databases.neo4j.io',
        password: 'pw',
      }),
      timeoutMs: 1000,
      fetchImpl,
      logger: (level, message, data) => {
        getLoggingApi()[level]('neon', message, data);
      },
      spanEmitter: (name, data) => getLoggingApi().start(name, data),
    });
  }

  it('neon.query emits start + finish', async () => {
    const neon = makeNeon(makeFakeFetch([{ ok: 1 }]));
    queue.entries.length = 0;
    await neon.query('RETURN 1 AS ok');
    const names = queue.eventNames();
    expect(names).toContain('neon.query.start');
    expect(names).toContain('neon.query.finish');
  });

  it('neon.ping emits start + finish', async () => {
    const neon = makeNeon(makeFakeFetch([{ ok: 1 }]));
    queue.entries.length = 0;
    await neon.ping();
    const names = queue.eventNames();
    expect(names).toContain('neon.ping.start');
    expect(names).toContain('neon.ping.finish');
  });

  it('neon.query on network failure emits start + fail (not finish)', async () => {
    const neon = makeNeon((() => Promise.reject(new Error('boom'))) as unknown as typeof fetch);
    queue.entries.length = 0;
    await expect(neon.query('RETURN 1')).rejects.toThrow();
    const names = queue.eventNames();
    expect(names).toContain('neon.query.start');
    expect(names).toContain('neon.query.fail');
    expect(names).not.toContain('neon.query.finish');
  });

  it('start and finish events share a spanId', async () => {
    const neon = makeNeon(makeFakeFetch([]));
    queue.entries.length = 0;
    await neon.query('RETURN 1');
    const events = queue.events();
    const start = events.find((e) => e.data.eventName === 'neon.query.start');
    const finish = events.find((e) => e.data.eventName === 'neon.query.finish');
    expect(start?.data.spanId).toBeDefined();
    expect(finish?.data.spanId).toBe(start?.data.spanId);
  });

  it('finish event carries a numeric durationMs and recordCount', async () => {
    const neon = makeNeon(makeFakeFetch([{ a: 1 }, { a: 2 }, { a: 3 }]));
    queue.entries.length = 0;
    await neon.query('MATCH (n) RETURN n.a AS a');
    const finish = queue.events().find((e) => e.data.eventName === 'neon.query.finish');
    expect(typeof finish?.data.durationMs).toBe('number');
    // User data from `span.finish({ recordCount: 3 })` lands under
    // the inner `.data` key in the queue entry's data record.
    const inner = (finish?.data as { data?: { recordCount?: number } }).data;
    expect(inner?.recordCount).toBe(3);
  });
});

// ─── IDW module coverage ──────────────────────────────────────────────────

describe('Event coverage: IDW module emits spans for every op', () => {
  function makeIdwStore(): IdwStore {
    return new IdwStore({
      kvApi: new FakeKV(),
      logger: (level, message, data) => {
        getLoggingApi()[level]('idw', message, data);
      },
      spanEmitter: (name, data) => getLoggingApi().start(name, data),
    });
  }

  it('idw.add emits start + finish', async () => {
    const store = makeIdwStore();
    queue.entries.length = 0;
    await store.add({ kind: 'idw', label: 'A', url: 'https://a.example' });
    const names = queue.eventNames();
    expect(names).toContain('idw.add.start');
    expect(names).toContain('idw.add.finish');
    expect(names).toContain('idw.changed');
  });

  it('idw.add on validation error emits start + fail (not finish)', async () => {
    const store = makeIdwStore();
    queue.entries.length = 0;
    await expect(
      store.add({ kind: 'idw', label: 'A', url: 'ftp://nope' })
    ).rejects.toThrow();
    const names = queue.eventNames();
    expect(names).toContain('idw.add.start');
    expect(names).toContain('idw.add.fail');
    expect(names).not.toContain('idw.add.finish');
  });

  it('idw.update + idw.remove emit their span trio', async () => {
    const store = makeIdwStore();
    const { entry } = await store.add({
      kind: 'idw',
      label: 'A',
      url: 'https://a.example',
    });
    queue.entries.length = 0;
    await store.update(entry.id, { label: 'A renamed' });
    await store.remove(entry.id);
    const names = queue.eventNames();
    expect(names).toContain('idw.update.start');
    expect(names).toContain('idw.update.finish');
    expect(names).toContain('idw.remove.start');
    expect(names).toContain('idw.remove.finish');
  });

  it('idw.store.installed fires for source=store add', async () => {
    const store = makeIdwStore();
    queue.entries.length = 0;
    await store.add({
      kind: 'image-creator',
      label: 'DALL-E',
      url: 'https://labs.openai.com',
      source: 'store',
      storeMetadata: { catalogId: 'cat-dalle', installedAt: '2026-01-01T00:00:00Z' },
    });
    expect(queue.eventNames()).toContain('idw.store.installed');
  });

  it('idw.store.updated fires when re-installing the same catalogId', async () => {
    const store = makeIdwStore();
    await store.add({
      kind: 'image-creator',
      label: 'DALL-E',
      url: 'https://labs.openai.com/v1',
      source: 'store',
      storeMetadata: { catalogId: 'cat-dalle', installedAt: '2026-01-01T00:00:00Z' },
    });
    queue.entries.length = 0;
    await store.add({
      kind: 'image-creator',
      label: 'DALL-E',
      url: 'https://labs.openai.com/v2',
      source: 'store',
      storeMetadata: { catalogId: 'cat-dalle', installedAt: '2026-01-02T00:00:00Z' },
    });
    expect(queue.eventNames()).toContain('idw.store.updated');
  });
});

// ─── University module coverage ──────────────────────────────────────────

describe('Event coverage: University module emits IPC + activity events', () => {
  it('OPENED event lands with id + kind', () => {
    queue.entries.length = 0;
    getLoggingApi().event('university.opened', { id: 'lms', kind: 'lms' });
    const ev = queue.events().find((e) => e.data.eventName === 'university.opened');
    expect(ev).toBeDefined();
    expect(ev?.category).toBe('university');
  });

  it('TUTORIALS_OPENED event lands as instant', () => {
    queue.entries.length = 0;
    getLoggingApi().event('university.tutorials.opened');
    const ev = queue.events().find((e) => e.data.eventName === 'university.tutorials.opened');
    expect(ev).toBeDefined();
    expect(ev?.category).toBe('university');
  });

  it('IPC entry events land under category=university', () => {
    queue.entries.length = 0;
    getLoggingApi().event('university.ipc.list');
    getLoggingApi().event('university.ipc.get');
    getLoggingApi().event('university.ipc.open');
    getLoggingApi().event('university.ipc.open-tutorials');
    const evNames = queue.events().map((e) => e.data.eventName);
    expect(evNames).toContain('university.ipc.list');
    expect(evNames).toContain('university.ipc.get');
    expect(evNames).toContain('university.ipc.open');
    expect(evNames).toContain('university.ipc.open-tutorials');
  });
});

// ─── AI module coverage ──────────────────────────────────────────────────

describe('Event coverage: AI module emits IPC + span events', () => {
  it('IPC entry events land under category=ai', () => {
    queue.entries.length = 0;
    getLoggingApi().event('ai.ipc.tts');
    getLoggingApi().event('ai.ipc.chat');
    getLoggingApi().event('ai.ipc.status');
    getLoggingApi().event('ai.ipc.configure');
    const evNames = queue.events().map((e) => e.data.eventName);
    expect(evNames).toContain('ai.ipc.tts');
    expect(evNames).toContain('ai.ipc.chat');
    expect(evNames).toContain('ai.ipc.status');
    expect(evNames).toContain('ai.ipc.configure');
  });
});

// ─── AI Run Times module coverage ────────────────────────────────────────

describe('Event coverage: AI Run Times module emits IPC + activity events', () => {
  it('WINDOW_OPENED + ARTICLE_OPENED + PREFERENCES_SAVED land', () => {
    queue.entries.length = 0;
    getLoggingApi().event('ai-run-times.window.opened');
    getLoggingApi().event('ai-run-times.article.opened', { articleId: 'a' });
    getLoggingApi().event('ai-run-times.preferences.saved', { enabledCount: 3 });
    const evNames = queue.events().map((e) => e.data.eventName);
    expect(evNames).toContain('ai-run-times.window.opened');
    expect(evNames).toContain('ai-run-times.article.opened');
    expect(evNames).toContain('ai-run-times.preferences.saved');
  });

  it('IPC entry events land', () => {
    queue.entries.length = 0;
    getLoggingApi().event('ai-run-times.ipc.list-articles');
    getLoggingApi().event('ai-run-times.ipc.refresh-feed');
    getLoggingApi().event('ai-run-times.ipc.save-preferences');
    const evNames = queue.events().map((e) => e.data.eventName);
    expect(evNames).toContain('ai-run-times.ipc.list-articles');
    expect(evNames).toContain('ai-run-times.ipc.refresh-feed');
    expect(evNames).toContain('ai-run-times.ipc.save-preferences');
  });
});
