/**
 * 2026-08-12 incident hardening: one KV 500 became a 90 MB/6.5s log
 * storm (rotating away the evidence) and a hung Google sign-in.
 * Three layers, each tested against the incident's exact shape:
 *
 *   1. KV circuit breaker  — 5 consecutive server errors open it 15s;
 *      requests fail fast WITHOUT touching the network.
 *   2. Credentials cache   — graph config resolves from a 60s cache;
 *      during a 10s failure cooldown the last-good record serves stale.
 *   3. Log-flood dedupe    — identical lines beyond 5-in-2s are counted,
 *      not stored, and summarized when the storm breaks.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FlowHttpKVClient } from '../../kv/flow-http-client.js';
import { KVError } from '../../kv/client.js';
import { KVCredentialsProvider } from '../../neon/credentials.js';

// ─── 1. Circuit breaker ──────────────────────────────────────────────

function makeKvClient(fetchImpl: typeof fetch): FlowHttpKVClient {
  return new FlowHttpKVClient({
    refreshUrl: 'https://example.test/refresh_token',
    token: () => 'mult-token-1',
    fetchImpl,
    log: () => undefined,
  } as never);
}

const resp500 = (): Response =>
  new Response('server exploded', { status: 500 });
const respToken = (): Response =>
  new Response(JSON.stringify({ token: 'tok', expiresIn: 3600 }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

describe('KV circuit breaker', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('opens after 5 consecutive 5xx and fails fast without network', async () => {
    let dataCalls = 0;
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes('refresh_token')) return respToken();
      dataCalls += 1;
      return resp500();
    });
    const client = makeKvClient(fetchImpl as never);

    for (let i = 0; i < 5; i++) {
      await expect(client.get('c', 'k')).rejects.toMatchObject({ status: 500 });
    }
    const callsAtOpen = dataCalls;

    // Breaker open: fails fast, the wire is NOT touched.
    await expect(client.get('c', 'k')).rejects.toMatchObject({
      context: expect.objectContaining({ breakerOpen: true }),
    });
    await expect(client.get('c', 'k2')).rejects.toMatchObject({
      context: expect.objectContaining({ breakerOpen: true }),
    });
    expect(dataCalls).toBe(callsAtOpen);
  });

  it('lets a probe through after the cooldown and closes on success', async () => {
    let mode: 'fail' | 'ok' = 'fail';
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes('refresh_token')) return respToken();
      if (mode === 'fail') return resp500();
      return new Response(JSON.stringify({ value: { a: 1 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const client = makeKvClient(fetchImpl as never);
    for (let i = 0; i < 5; i++) {
      await expect(client.get('c', 'k')).rejects.toMatchObject({ status: 500 });
    }
    await expect(client.get('c', 'k')).rejects.toMatchObject({
      context: expect.objectContaining({ breakerOpen: true }),
    });

    vi.advanceTimersByTime(15_100);
    mode = 'ok';
    await expect(client.get('c', 'k')).resolves.toBeTruthy(); // probe passes, breaker closes
    await expect(client.get('c', 'k')).resolves.toBeTruthy();
  });

  it('4xx does NOT count toward the breaker (client errors are not outages)', async () => {
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes('refresh_token')) return respToken();
      return new Response('bad request', { status: 400 });
    });
    const client = makeKvClient(fetchImpl as never);
    for (let i = 0; i < 8; i++) {
      try {
        await client.get('c', 'k');
      } catch {
        /* expected */
      }
    }
    // 9th still reaches the wire — no breaker for 4xx.
    const before = fetchImpl.mock.calls.length;
    await expect(client.get('c', 'k')).rejects.toBeInstanceOf(KVError);
    expect(fetchImpl.mock.calls.length).toBeGreaterThan(before);
  });
});

// ─── 2. Credentials resolution cache ─────────────────────────────────

function makeProvider(kvGet: () => Promise<unknown>): {
  provider: KVCredentialsProvider;
  calls: () => number;
} {
  let calls = 0;
  const provider = new KVCredentialsProvider({
    kvApi: {
      get: async () => {
        calls += 1;
        return kvGet();
      },
    } as never,
    isSignedIn: () => true,
    fallbackRecord: null,
  } as never);
  return { provider, calls: () => calls };
}

const RECORD = { endpoint: 'https://neon.example', uri: 'neo4j+s://db.example', user: 'neo4j', password: 'pw', database: 'neo4j' };

describe('KVCredentialsProvider — 60s cache + stale-while-error', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('resolves from cache inside the TTL (one KV read for many gets)', async () => {
    const { provider, calls } = makeProvider(async () => ({ ...RECORD }));
    for (let i = 0; i < 20; i++) await provider.get();
    expect(calls()).toBe(1);
    vi.advanceTimersByTime(61_000);
    await provider.get();
    expect(calls()).toBe(2);
  });

  it('serves the last-good record during a backend failure (the 08-12 shape)', async () => {
    let failing = false;
    const { provider, calls } = makeProvider(async () => {
      if (failing) throw new KVError({ code: 'KV_HTTP', message: 'HTTP 500', status: 500 } as never);
      return { ...RECORD };
    });
    await provider.get(); // primes the cache
    failing = true;
    vi.advanceTimersByTime(61_000); // TTL expired → next get re-reads → fails → stale serve
    const creds = await provider.get();
    expect(creds).not.toBeNull();
    const after = calls();
    // Failure cooldown: repeated gets do NOT hammer KV.
    for (let i = 0; i < 10; i++) await provider.get();
    expect(calls()).toBe(after);
  });

  it('invalidate() forces a fresh KV read', async () => {
    const { provider, calls } = makeProvider(async () => ({ ...RECORD }));
    await provider.get();
    provider.invalidate();
    await provider.get();
    expect(calls()).toBe(2);
  });
});

// ─── 3. Log-flood dedupe (lib intake) ────────────────────────────────

describe('log-event-queue flood dedupe', () => {
  it('suppresses identical lines beyond 5-in-2s and emits one summary', async () => {
    vi.useRealTimers();
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
    const { LogEventQueue } = require('../../../lib/log-event-queue.js') as {
      LogEventQueue: new () => {
        enqueue(e: object): object | null;
        on(ev: string, fn: (e: { message: string }) => void): void;
      };
    };
    const q = new LogEventQueue();
    const seen: string[] = [];
    q.on('event', (e) => seen.push(e.message));

    for (let i = 0; i < 500; i++) {
      q.enqueue({ level: 'error', category: 'kv', message: 'kv-flow: get failed' });
    }
    // storm breaks: a different line flushes the summary
    q.enqueue({ level: 'info', category: 'kv', message: 'kv-flow: get ok' });

    const identical = seen.filter((m) => m === 'kv-flow: get failed').length;
    expect(identical).toBe(5); // first five pass
    const summary = seen.find((m) => m.includes('log-dedupe: repeated ×495'));
    expect(summary).toBeTruthy();
    expect(seen[seen.length - 1]).toBe('kv-flow: get ok');
  });

  it('normal varied logging is untouched', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
    const { LogEventQueue } = require('../../../lib/log-event-queue.js') as {
      LogEventQueue: new () => { enqueue(e: object): object | null };
    };
    const q = new LogEventQueue();
    let stored = 0;
    (q as unknown as { on(ev: string, fn: () => void): void }).on('event', () => stored++);
    for (let i = 0; i < 50; i++) {
      q.enqueue({ level: 'info', category: 'spaces', message: `distinct line ${i}` });
    }
    expect(stored).toBe(50);
  });
});
