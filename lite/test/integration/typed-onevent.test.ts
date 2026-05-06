/**
 * Typed onEvent() handler tests (ADR-032).
 *
 * Proves end-to-end that:
 *   1. Each module's `onEvent(handler)` delivers events when the
 *      corresponding op runs.
 *   2. The typed discriminated union narrows on `ev.name` -- a
 *      `case 'kv.set.finish':` branch can read `ev.durationMs` and
 *      `ev.spanId` without casting.
 *   3. Cross-module noise is filtered out (auth's onEvent doesn't
 *      receive kv events, etc.).
 *   4. The unsubscribe function detaches the handler.
 *
 * The narrowing is verified BOTH at compile time (TypeScript narrows
 * the union) and runtime (the test reads narrowed fields and
 * asserts).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EdisonKVClient } from '../../kv/client.js';
import { BugReportStore } from '../../bug-report/store.js';
import { LoggingStore } from '../../logging/store.js';
import {
  _setLoggingApiForTesting,
  _resetLoggingApiForTesting,
  getLoggingApi,
} from '../../logging/api.js';
import {
  startInMemoryKVServer,
  type InMemoryKVServer,
  makeBugReportPayload,
} from '../harness/index.js';
import {
  KV_EVENTS,
  type KvEvent,
} from '../../kv/api.js';
import {
  BUG_REPORT_EVENTS,
  type BugReportEvent,
} from '../../bug-report/api.js';
import {
  NEON_EVENTS,
  type NeonEvent,
} from '../../neon/api.js';
import { EdisonNeonClient } from '../../neon/client.js';
import { StaticCredentialsProvider } from '../../neon/credentials.js';
import { IdwStore as IdwStoreCls } from '../../idw/store.js';
import { IDW_EVENTS as IDW_EVENTS_REF } from '../../idw/api.js';
import { FakeKV as FakeKVCls } from '../harness/index.js';
import {
  getUniversityApi as getUniversityApiRef,
  _resetUniversityApiForTesting as resetUniversityApi,
  UNIVERSITY_EVENTS as UNIVERSITY_EVENTS_REF,
} from '../../university/api.js';
// AI service module pulled (TTS removed); typed-onevent block for
// AiApi removed below. Re-introducing means restoring the imports
// + the describe block.
import {
  getAiRunTimesApi as getAiRunTimesApiRef,
  _resetAiRunTimesApiForTesting as resetAiRunTimesApi,
  AI_RUN_TIMES_EVENTS as ART_EVENTS_REF,
} from '../../ai-run-times/api.js';
import type { LogEventQueueLike } from '../../logging/store.js';

class RecordingQueue implements LogEventQueueLike {
  public readonly entries: Array<{
    level: 'debug' | 'info' | 'warn' | 'error';
    category: string;
    message: string;
    data?: unknown;
  }> = [];
  debug(c: string, m: string, d?: unknown): void {
    this.entries.push({ level: 'debug', category: c, message: m, ...(d !== undefined ? { data: d } : {}) });
  }
  info(c: string, m: string, d?: unknown): void {
    this.entries.push({ level: 'info', category: c, message: m, ...(d !== undefined ? { data: d } : {}) });
  }
  warn(c: string, m: string, d?: unknown): void {
    this.entries.push({ level: 'warn', category: c, message: m, ...(d !== undefined ? { data: d } : {}) });
  }
  error(c: string, m: string, d?: unknown): void {
    this.entries.push({ level: 'error', category: c, message: m, ...(d !== undefined ? { data: d } : {}) });
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

describe('KvApi.onEvent typed narrowing (ADR-032)', () => {
  function makeKv(): EdisonKVClient {
    return new EdisonKVClient({
      url: `${kvServer.url}/keyvalue`,
      timeoutMs: 1000,
      spanEmitter: (name, data) => getLoggingApi().start(name, data),
    });
  }

  it('delivers typed kv events; switch on ev.name narrows ev.data', async () => {
    const kv = makeKv();
    const observed: Array<{ name: string; durationMs?: number; collection?: string }> = [];

    const unsub = kv.onEvent((ev: KvEvent) => {
      // The `name` switch narrows the union. Each branch can access
      // fields that only exist on that variant -- TypeScript validates
      // this at compile time AND we assert runtime values below.
      switch (ev.name) {
        case KV_EVENTS.SET_START:
          // ev.data narrowed to { collection: string; key?: string }
          observed.push({ name: ev.name, collection: ev.data.collection });
          break;
        case KV_EVENTS.SET_FINISH:
          // ev.durationMs narrowed to number (only on finish/fail)
          observed.push({ name: ev.name, durationMs: ev.durationMs });
          break;
        case KV_EVENTS.GET_START:
          observed.push({ name: ev.name, collection: ev.data.collection });
          break;
        case KV_EVENTS.GET_FINISH:
          observed.push({ name: ev.name, durationMs: ev.durationMs });
          break;
        default:
          // any other variant -- intentionally ignored in this test
          break;
      }
    });

    await kv.set('coll', 'k1', { foo: 1 });
    await kv.get('coll', 'k1');
    unsub();

    // Both ops fired their start + finish into the typed handler.
    const names = observed.map((o) => o.name);
    expect(names).toContain(KV_EVENTS.SET_START);
    expect(names).toContain(KV_EVENTS.SET_FINISH);
    expect(names).toContain(KV_EVENTS.GET_START);
    expect(names).toContain(KV_EVENTS.GET_FINISH);

    // Narrowed access to .data.collection on START events
    const setStart = observed.find((o) => o.name === KV_EVENTS.SET_START);
    expect(setStart?.collection).toBe('coll');

    // Narrowed access to .durationMs on FINISH events
    const setFinish = observed.find((o) => o.name === KV_EVENTS.SET_FINISH);
    expect(typeof setFinish?.durationMs).toBe('number');
  });

  it('unsubscribe detaches the handler', async () => {
    const kv = makeKv();
    const received: KvEvent[] = [];
    const unsub = kv.onEvent((ev) => received.push(ev));

    await kv.set('coll', 'a', 1);
    const beforeUnsub = received.length;
    expect(beforeUnsub).toBeGreaterThan(0);

    unsub();
    await kv.set('coll', 'b', 2);
    expect(received.length).toBe(beforeUnsub);
  });

  it('does NOT receive non-kv events (filter scoped to kv.*)', async () => {
    const kv = makeKv();
    const received: KvEvent[] = [];
    kv.onEvent((ev) => received.push(ev));

    // Emit an unrelated event from another category
    getLoggingApi().event('bug-report.test.noise');
    await kv.set('coll', 'a', 1);

    const names = received.map((r) => r.name);
    expect(names.every((n) => n.startsWith('kv.'))).toBe(true);
  });

  it('handler that throws does not crash subsequent dispatch', async () => {
    const kv = makeKv();
    const received: KvEvent[] = [];

    kv.onEvent(() => {
      throw new Error('handler throws');
    });
    kv.onEvent((ev) => {
      received.push(ev);
    });

    await kv.set('coll', 'a', 1);
    expect(received.length).toBeGreaterThan(0);
  });
});

describe('BugReportApi.onEvent typed narrowing', () => {
  function makeStore(): BugReportStore {
    const kv = new EdisonKVClient({
      url: `${kvServer.url}/keyvalue`,
      timeoutMs: 1000,
      spanEmitter: (name, data) => getLoggingApi().start(name, data),
    });
    return new BugReportStore({
      kvApi: kv,
      spanEmitter: (name, data) => getLoggingApi().start(name, data),
    });
  }

  it('delivers typed bug-report events; switch narrows ev.data', async () => {
    const store = makeStore();
    const observed: Array<{ name: string; ts?: string; durationMs?: number }> = [];

    store.onEvent((ev: BugReportEvent) => {
      switch (ev.name) {
        case BUG_REPORT_EVENTS.SAVE_START:
          // ev.data narrowed to { timestamp: string }
          observed.push({ name: ev.name, ts: ev.data.timestamp });
          break;
        case BUG_REPORT_EVENTS.SAVE_FINISH:
          observed.push({ name: ev.name, durationMs: ev.durationMs });
          break;
        default:
          break;
      }
    });

    await store.save(makeBugReportPayload({ timestamp: '2026-05-04T20:00:00.000Z' }));

    const start = observed.find((o) => o.name === BUG_REPORT_EVENTS.SAVE_START);
    const finish = observed.find((o) => o.name === BUG_REPORT_EVENTS.SAVE_FINISH);
    expect(start?.ts).toBe('2026-05-04T20:00:00.000Z');
    expect(typeof finish?.durationMs).toBe('number');
  });

  it('fail variant carries serialized error', async () => {
    const store = makeStore();
    const observed: BugReportEvent[] = [];
    store.onEvent((ev) => observed.push(ev));

    kvServer.failNextRequest({ status: 500, body: 'down' });
    await expect(
      store.save(makeBugReportPayload({ timestamp: '2026-05-04T21:00:00.000Z' }))
    ).rejects.toThrow();

    const failEv = observed.find((e) => e.name === BUG_REPORT_EVENTS.SAVE_FAIL);
    expect(failEv).toBeDefined();
    if (failEv?.name === BUG_REPORT_EVENTS.SAVE_FAIL) {
      // Narrowed -- TypeScript knows ev.error is SerializedEventError.
      // (Span.fail emits error at the top level of the EventRecord, not
      // inside data.)
      expect(failEv.error.code).toBe('BR_SAVE_FAILED');
      expect(typeof failEv.error.message).toBe('string');
    }
  });
});

describe('NeonApi.onEvent typed narrowing (ADR-032)', () => {
  function makeClient(endpoint: string, fetchImpl: typeof fetch): EdisonNeonClient {
    return new EdisonNeonClient({
      credentials: new StaticCredentialsProvider({
        endpoint,
        uri: 'neo4j+s://x.databases.neo4j.io',
        password: 'pw',
      }),
      timeoutMs: 1000,
      fetchImpl,
      spanEmitter: (name, data) => getLoggingApi().start(name, data),
    });
  }

  function makeFakeFetch(records: unknown): typeof fetch {
    const fn = (async () =>
      ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ records }),
      }) as unknown as Response) as unknown as typeof fetch;
    return fn;
  }

  it('delivers typed neon events; switch narrows ev.data', async () => {
    const client = makeClient('https://example.com/neon', makeFakeFetch([{ ok: 1 }]));
    const observed: Array<{ name: string; cypher?: string; recordCount?: number; durationMs?: number }> = [];

    const unsub = client.onEvent((ev: NeonEvent) => {
      switch (ev.name) {
        case NEON_EVENTS.QUERY_START:
          // ev.data narrowed to { cypher: string; paramCount: number }
          observed.push({ name: ev.name, cypher: ev.data.cypher });
          break;
        case NEON_EVENTS.QUERY_FINISH:
          // ev.data narrowed to { recordCount: number }
          observed.push({
            name: ev.name,
            recordCount: ev.data.recordCount,
            durationMs: ev.durationMs,
          });
          break;
        default:
          break;
      }
    });

    await client.query('RETURN 1 AS ok');
    unsub();

    const start = observed.find((o) => o.name === NEON_EVENTS.QUERY_START);
    const finish = observed.find((o) => o.name === NEON_EVENTS.QUERY_FINISH);
    expect(start?.cypher).toBe('RETURN 1 AS ok');
    expect(finish?.recordCount).toBe(1);
    expect(typeof finish?.durationMs).toBe('number');
  });

  it('fail variant carries serialized error', async () => {
    const failingFetch = (() => Promise.reject(new Error('boom'))) as unknown as typeof fetch;
    const client = makeClient('https://example.com/neon', failingFetch);
    const observed: NeonEvent[] = [];
    client.onEvent((ev) => observed.push(ev));

    await expect(client.query('RETURN 1')).rejects.toThrow();

    const failEv = observed.find((e) => e.name === NEON_EVENTS.QUERY_FAIL);
    expect(failEv).toBeDefined();
    if (failEv?.name === NEON_EVENTS.QUERY_FAIL) {
      expect(failEv.error.code).toBe('NEON_NETWORK');
      expect(typeof failEv.error.message).toBe('string');
    }
  });

  it('does NOT receive non-neon events', async () => {
    const client = makeClient('https://example.com/neon', makeFakeFetch([]));
    const received: NeonEvent[] = [];
    client.onEvent((ev) => received.push(ev));

    getLoggingApi().event('kv.test.noise');
    await client.query('RETURN 1');

    const names = received.map((r) => r.name);
    expect(names.every((n) => n.startsWith('neon.'))).toBe(true);
  });
});

describe('IdwApi.onEvent typed narrowing (ADR-032)', () => {
  it('delivers typed idw events on add', async () => {
    const store = new IdwStoreCls({
      kvApi: new FakeKVCls(),
      spanEmitter: (name, data) => getLoggingApi().start(name, data),
    });
    const observed: Array<{ name: string; data?: unknown; durationMs?: number }> = [];
    const unsub = store.onEvent((ev) => {
      switch (ev.name) {
        case IDW_EVENTS_REF.ADD_START:
          observed.push({ name: ev.name, data: ev.data });
          break;
        case IDW_EVENTS_REF.ADD_FINISH:
          observed.push({ name: ev.name, data: ev.data, durationMs: ev.durationMs });
          break;
        case IDW_EVENTS_REF.CHANGED:
          observed.push({ name: ev.name, data: ev.data });
          break;
        default:
          break;
      }
    });
    await store.add({ kind: 'idw', label: 'A', url: 'https://a.example' });
    unsub();
    expect(observed.some((o) => o.name === IDW_EVENTS_REF.ADD_START)).toBe(true);
    expect(observed.some((o) => o.name === IDW_EVENTS_REF.ADD_FINISH)).toBe(true);
    expect(observed.some((o) => o.name === IDW_EVENTS_REF.CHANGED)).toBe(true);
  });

  it('does NOT receive non-idw events', async () => {
    const store = new IdwStoreCls({ kvApi: new FakeKVCls() });
    const received: Array<{ name: string }> = [];
    const unsub = store.onEvent((ev) => received.push({ name: ev.name }));
    getLoggingApi().event('kv.test.noise');
    await store.add({ kind: 'idw', label: 'A', url: 'https://a' });
    unsub();
    expect(received.every((r) => r.name.startsWith('idw.'))).toBe(true);
    const validNames: ReadonlySet<string> = new Set(Object.values(IDW_EVENTS_REF));
    expect(received.some((r) => validNames.has(r.name))).toBe(true);
  });
});

describe('UniversityApi.onEvent typed narrowing (ADR-032)', () => {
  beforeEach(() => {
    resetUniversityApi();
  });

  it('delivers typed university events when an IPC-entry event is emitted', async () => {
    const api = getUniversityApiRef();
    const observed: Array<{ name: string }> = [];
    const unsub = api.onEvent((ev) => {
      switch (ev.name) {
        case UNIVERSITY_EVENTS_REF.IPC_LIST:
          observed.push({ name: ev.name });
          break;
        case UNIVERSITY_EVENTS_REF.OPENED:
          // ev.data narrowed to { id: string; kind: ... }
          observed.push({ name: ev.name });
          break;
        default:
          break;
      }
    });
    // Simulate the entries that happen during an IPC call.
    getLoggingApi().event(UNIVERSITY_EVENTS_REF.IPC_LIST);
    getLoggingApi().event(UNIVERSITY_EVENTS_REF.OPENED, { id: 'lms', kind: 'lms' });
    unsub();
    expect(observed.some((o) => o.name === UNIVERSITY_EVENTS_REF.IPC_LIST)).toBe(true);
    expect(observed.some((o) => o.name === UNIVERSITY_EVENTS_REF.OPENED)).toBe(true);
  });

  it('does NOT receive non-university events', async () => {
    const api = getUniversityApiRef();
    const received: Array<{ name: string }> = [];
    const unsub = api.onEvent((ev) => received.push({ name: ev.name }));
    getLoggingApi().event('kv.test.noise');
    getLoggingApi().event('idw.test.noise');
    getLoggingApi().event(UNIVERSITY_EVENTS_REF.IPC_LIST);
    unsub();
    expect(received.every((r) => r.name.startsWith('university.'))).toBe(true);
    expect(received.length).toBeGreaterThan(0);
  });
});

// AI service module pulled (TTS removed); the `AiApi.onEvent` block
// previously here was deleted.

describe('AiRunTimesApi.onEvent typed narrowing (ADR-032)', () => {
  beforeEach(() => {
    resetAiRunTimesApi();
  });

  it('delivers typed AI Run Times events; ignores non-ART events', () => {
    const api = getAiRunTimesApiRef();
    const observed: Array<{ name: string }> = [];
    const unsub = api.onEvent((ev) => observed.push({ name: ev.name }));
    getLoggingApi().event(ART_EVENTS_REF.IPC_LIST_ARTICLES);
    getLoggingApi().event(ART_EVENTS_REF.WINDOW_OPENED);
    getLoggingApi().event('kv.test.noise');
    unsub();
    expect(observed.some((o) => o.name === ART_EVENTS_REF.IPC_LIST_ARTICLES)).toBe(true);
    expect(observed.some((o) => o.name === ART_EVENTS_REF.WINDOW_OPENED)).toBe(true);
    expect(observed.every((o) => o.name.startsWith('ai-run-times.'))).toBe(true);
  });
});
