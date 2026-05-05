/**
 * EventBusStore unit tests.
 *
 * Drives the store directly with a FakeKV. Covers:
 *   - basic ingest -> fanout (synchronous to subscribers)
 *   - ring buffer eviction at RING_BUFFER_MAX
 *   - hydrate from KV on construction
 *   - opt-in replay on subscribe
 *   - glob pattern matching
 *   - subscriber-throws-doesn't-break-fanout
 *   - persist debounce (immediate-write mode)
 *   - persistence soft-fail (KV throws -> store stays operational)
 */

import { describe, it, expect } from 'vitest';
import { EventBusStore } from '../../event-bus/store.js';
import {
  KV_COLLECTION,
  KV_KEY,
  RING_BUFFER_MAX,
  type DomainEvent,
  type EventBusBlob,
} from '../../event-bus/types.js';
import type { EventRecord } from '../../logging/events.js';
import { FakeKV } from '../harness/mocks/fake-kv.js';

function makeRaw(name: string, data?: unknown): EventRecord {
  return {
    id: 'raw-' + Math.random().toString(36).slice(2),
    timestamp: '2026-05-05T00:00:00.000Z',
    name,
    category: name.split('.')[0] ?? '',
    level: 'info',
    ...(data !== undefined ? { data } : {}),
  };
}

function makeStore(opts: { kv?: FakeKV; persistDebounceMs?: number; now?: string } = {}): {
  store: EventBusStore;
  kv: FakeKV;
} {
  const kv = opts.kv ?? new FakeKV();
  let counter = 0;
  const store = new EventBusStore({
    kvApi: kv,
    persistDebounceMs: opts.persistDebounceMs ?? 0, // immediate-write by default for tests
    skipAutoSubscribe: true, // tests drive ingest manually
    now: () => new Date(opts.now ?? '2026-05-05T12:00:00.000Z'),
    generateId: () => `ev-${++counter}`,
  });
  return { store, kv };
}

describe('EventBusStore basic ingest + fanout', () => {
  it('ingests a known raw event and fans it out', async () => {
    const { store } = makeStore();
    const seen: DomainEvent[] = [];
    store.on('user.signed-in', (ev) => seen.push(ev));
    store._ingestForTesting(
      makeRaw('auth.signIn.finish', {
        env: 'edison',
        accountId: 'acct-1',
        email: 'alice@example.com',
      })
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]?.name).toBe('user.signed-in');
    expect((seen[0] as { data: { accountId: string } }).data.accountId).toBe('acct-1');
  });

  it('ignores raw events with no matching translator rule', () => {
    const { store } = makeStore();
    let count = 0;
    store.onPattern('*', () => count++);
    store._ingestForTesting(makeRaw('kv.set.start', { collection: 'x' }));
    expect(count).toBe(0);
    expect(store._bufferSizeForTesting()).toBe(0);
  });

  it('skips bus-self events to avoid translation loops', () => {
    const { store } = makeStore();
    let count = 0;
    store.onPattern('*', () => count++);
    store._ingestForTesting({
      id: 'r1',
      timestamp: 't',
      name: 'event-bus.translated',
      category: 'event-bus',
      level: 'info',
    });
    expect(count).toBe(0);
  });
});

describe('EventBusStore ring buffer + eviction', () => {
  it('evicts oldest events past RING_BUFFER_MAX', () => {
    const { store } = makeStore();
    for (let i = 0; i < RING_BUFFER_MAX + 10; i += 1) {
      store._ingestForTesting(
        makeRaw('main-window.close-tab.finish', { id: `tab-${i}` })
      );
    }
    expect(store._bufferSizeForTesting()).toBe(RING_BUFFER_MAX);
    const all = store.list();
    expect(all[0]?.name).toBe('agent.tab.closed');
    // First retained should be ev-11 (10 evicted from the head).
    expect((all[0] as { data: { tabId: string } }).data.tabId).toBe('tab-10');
  });
});

describe('EventBusStore hydrate from KV', () => {
  it('rehydrates the buffer from a persisted blob', async () => {
    const kv = new FakeKV();
    const blob: EventBusBlob = {
      schemaVersion: 1,
      events: [
        {
          name: 'user.signed-in',
          id: 'persisted-1',
          ts: '2026-05-04T00:00:00.000Z',
          data: { env: 'edison', accountId: 'acct-99' },
        },
      ] as DomainEvent[],
    };
    await kv.set(KV_COLLECTION, KV_KEY, blob);
    const { store } = makeStore({ kv });
    await store.hydrate();
    expect(store._bufferSizeForTesting()).toBe(1);
    const recent = store.recent('user.signed-in', 5);
    expect(recent[0]?.id).toBe('persisted-1');
  });

  it('starts empty when KV has no record', async () => {
    const { store } = makeStore();
    await store.hydrate();
    expect(store._bufferSizeForTesting()).toBe(0);
  });

  it('soft-fails on garbage KV value', async () => {
    const kv = new FakeKV();
    await kv.set(KV_COLLECTION, KV_KEY, 'not-an-object' as unknown as Record<string, unknown>);
    const { store } = makeStore({ kv });
    await store.hydrate();
    expect(store._bufferSizeForTesting()).toBe(0);
  });
});

describe('EventBusStore subscribe with replay', () => {
  it('default subscribe is future-only', () => {
    const { store } = makeStore();
    // Pre-populate
    store._ingestForTesting(
      makeRaw('auth.signIn.finish', { env: 'edison', accountId: 'acct-old' })
    );
    const seen: DomainEvent[] = [];
    store.on('user.signed-in', (ev) => seen.push(ev));
    expect(seen).toHaveLength(0); // future-only
    // Now ingest a new one
    store._ingestForTesting(
      makeRaw('auth.signIn.finish', { env: 'edison', accountId: 'acct-new' })
    );
    expect(seen).toHaveLength(1);
    expect((seen[0] as { data: { accountId: string } }).data.accountId).toBe('acct-new');
  });

  it('replay: true delivers historical events first, then future', () => {
    const { store } = makeStore();
    store._ingestForTesting(
      makeRaw('auth.signIn.finish', { env: 'edison', accountId: 'acct-A' })
    );
    store._ingestForTesting(
      makeRaw('auth.signIn.finish', { env: 'edison', accountId: 'acct-B' })
    );
    const seen: DomainEvent[] = [];
    store.on('user.signed-in', (ev) => seen.push(ev), { replay: true });
    expect(seen).toHaveLength(2);
    expect((seen[0] as { data: { accountId: string } }).data.accountId).toBe('acct-A');
    expect((seen[1] as { data: { accountId: string } }).data.accountId).toBe('acct-B');
    // Future events still arrive.
    store._ingestForTesting(
      makeRaw('auth.signIn.finish', { env: 'edison', accountId: 'acct-C' })
    );
    expect(seen).toHaveLength(3);
  });
});

describe('EventBusStore glob pattern matching', () => {
  it('agent.tab.* matches opened/closed/activated', () => {
    const { store } = makeStore();
    const seen: string[] = [];
    store.onPattern('agent.tab.*', (ev) => seen.push(ev.name));
    store._ingestForTesting(
      makeRaw('main-window.open-tab.finish', { id: 't1', wasFocus: false })
    );
    store._ingestForTesting(makeRaw('main-window.close-tab.finish', { id: 't1' }));
    store._ingestForTesting(makeRaw('main-window.activate-tab.finish', { id: 't1' }));
    expect(seen).toEqual(['agent.tab.opened', 'agent.tab.closed', 'agent.tab.activated']);
  });

  it('* matches every domain event', () => {
    const { store } = makeStore();
    const seen: string[] = [];
    store.onPattern('*', (ev) => seen.push(ev.name));
    store._ingestForTesting(
      makeRaw('auth.signIn.finish', { env: 'edison', accountId: 'a' })
    );
    store._ingestForTesting(makeRaw('main-window.close-tab.finish', { id: 'x' }));
    expect(seen).toEqual(['user.signed-in', 'agent.tab.closed']);
  });

  it('unsubscribe stops future events', () => {
    const { store } = makeStore();
    let count = 0;
    const unsub = store.onPattern('*', () => count++);
    store._ingestForTesting(makeRaw('main-window.close-tab.finish', { id: 't1' }));
    expect(count).toBe(1);
    unsub();
    store._ingestForTesting(makeRaw('main-window.close-tab.finish', { id: 't2' }));
    expect(count).toBe(1);
  });
});

describe('EventBusStore subscriber error isolation', () => {
  it('a throwing handler does not break the others', () => {
    const { store } = makeStore();
    let goodCalls = 0;
    store.on('agent.tab.closed', () => {
      throw new Error('boom');
    });
    store.on('agent.tab.closed', () => {
      goodCalls += 1;
    });
    store._ingestForTesting(makeRaw('main-window.close-tab.finish', { id: 't1' }));
    expect(goodCalls).toBe(1);
  });
});

describe('EventBusStore manual emit', () => {
  it('emit() pushes through fanout + persistence with id+ts enriched', () => {
    const { store } = makeStore();
    const seen: DomainEvent[] = [];
    store.on('agent.tab.activated', (ev) => seen.push(ev));
    const out = store.emit({
      name: 'agent.tab.activated',
      data: { tabId: 'tab-manual' },
    });
    expect(out.id).toBe('ev-1');
    expect(out.ts).toBe('2026-05-05T12:00:00.000Z');
    expect(seen).toHaveLength(1);
  });
});

describe('EventBusStore persistence', () => {
  it('writes the latest snapshot to KV after each push (immediate mode)', async () => {
    const { store, kv } = makeStore();
    store._ingestForTesting(
      makeRaw('auth.signIn.finish', { env: 'edison', accountId: 'a' })
    );
    // Allow the immediate-mode async write to settle.
    await store._flushPersistForTesting();
    const blob = (await kv.get(KV_COLLECTION, KV_KEY)) as EventBusBlob;
    expect(blob.events).toHaveLength(1);
    expect(blob.events[0]?.name).toBe('user.signed-in');
  });

  it('soft-fails when KV write throws (in-memory state authoritative)', async () => {
    const kv = new FakeKV();
    kv.failSet = true;
    const { store } = makeStore({ kv });
    store._ingestForTesting(
      makeRaw('auth.signIn.finish', { env: 'edison', accountId: 'a' })
    );
    await store._flushPersistForTesting();
    // Buffer still has the event despite the persist failure.
    expect(store._bufferSizeForTesting()).toBe(1);
  });
});
