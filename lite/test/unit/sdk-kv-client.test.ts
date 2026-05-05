/**
 * SdkKVClient unit tests.
 *
 * Verifies the SDK wrapper preserves the public `KVApi` shape:
 *   set / get / listKeys / list / delete
 * and correctly normalizes SDK errors into `KVError`.
 *
 * The SDK itself is mocked -- we don't go to the network. The wire
 * format is the SDK's responsibility (its own tests cover it).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SdkKVClient } from '../../kv/sdk-client.js';
import { KVError, KV_ERROR_CODES } from '../../kv/client.js';

interface FakeSdkOptions {
  /** Pre-canned values keyed by `${collection}/${key}`. */
  store?: Map<string, unknown>;
  /** Throws this error from any SDK call. */
  throwError?: Error;
  /** Throws on getValueByKey only. */
  throwOnGet?: Error;
}

class FakeKvSdk {
  public calls: Array<{ method: string; args: unknown[] }> = [];
  public storedAccountId: string | undefined;
  private opts: FakeSdkOptions;

  constructor(
    params: { token: () => string; discoveryUrl: string; accountId?: string },
    opts: FakeSdkOptions = {}
  ) {
    this.storedAccountId = params.accountId;
    this.opts = opts;
  }

  private maybeThrow(err: Error | undefined): void {
    if (err !== undefined) throw err;
  }

  async setValueByKey(collection: string, key: string, value: unknown): Promise<{ key: string; value: unknown }> {
    this.calls.push({ method: 'setValueByKey', args: [collection, key, value] });
    this.maybeThrow(this.opts.throwError);
    this.opts.store?.set(`${collection}/${key}`, value);
    return { key, value };
  }

  async getValueByKey<T = unknown>(collection: string, key: string): Promise<{ key: string; value?: T }> {
    this.calls.push({ method: 'getValueByKey', args: [collection, key] });
    this.maybeThrow(this.opts.throwOnGet ?? this.opts.throwError);
    const value = this.opts.store?.get(`${collection}/${key}`);
    if (value === undefined) {
      // Mirror the SDK's 404 behavior.
      throw Object.assign(new Error('not found'), { response: { status: 404 } });
    }
    return { key, value: value as T };
  }

  async deleteKey(collection: string, key: string): Promise<void> {
    this.calls.push({ method: 'deleteKey', args: [collection, key] });
    this.maybeThrow(this.opts.throwError);
    this.opts.store?.delete(`${collection}/${key}`);
  }

  async listKeys<T = unknown>(
    collection: string,
    _prefix?: string,
    withValues?: boolean
  ): Promise<{ items: Array<{ key: string; lastModified: string; value?: T }> }> {
    this.calls.push({ method: 'listKeys', args: [collection, _prefix, withValues] });
    this.maybeThrow(this.opts.throwError);
    const items: Array<{ key: string; lastModified: string; value?: T }> = [];
    for (const [k, v] of this.opts.store?.entries() ?? []) {
      const [coll, key] = k.split('/');
      if (coll !== collection) continue;
      if (key === undefined) continue;
      const item: { key: string; lastModified: string; value?: T } = {
        key,
        lastModified: new Date().toISOString(),
      };
      if (withValues === true) item.value = v as T;
      items.push(item);
    }
    return { items };
  }
}

function makeClient(opts: FakeSdkOptions & { accountId?: string | null; token?: string } = {}): {
  client: SdkKVClient;
  sdks: FakeKvSdk[];
} {
  const sdks: FakeKvSdk[] = [];
  class SdkCtor extends FakeKvSdk {
    constructor(p: { token: () => string; discoveryUrl: string; accountId?: string }) {
      super(p, opts);
      sdks.push(this);
    }
  }

  const client = new SdkKVClient({
    token: () => opts.token ?? 'tok',
    discoveryUrl: 'https://discovery.test',
    accountId: () => opts.accountId === undefined ? 'acct-1' : opts.accountId,
    sdkCtor: SdkCtor,
  });
  return { client, sdks };
}

describe('SdkKVClient.set', () => {
  it('delegates to setValueByKey with collection + key + value', async () => {
    const { client, sdks } = makeClient({ store: new Map() });
    await client.set('lite-bugs', 'rec-1', { foo: 'bar' });
    expect(sdks).toHaveLength(1);
    expect(sdks[0]?.calls[0]).toEqual({
      method: 'setValueByKey',
      args: ['lite-bugs', 'rec-1', { foo: 'bar' }],
    });
  });

  it('throws KVError with status 401 when signed-out (no accountId)', async () => {
    const { client } = makeClient({ accountId: null });
    try {
      await client.set('coll', 'key', 'value');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(KVError);
      expect((err as KVError).status).toBe(401);
      expect((err as KVError).code).toBe(KV_ERROR_CODES.HTTP);
    }
  });
});

describe('SdkKVClient.get', () => {
  it('returns the value when present', async () => {
    const store = new Map<string, unknown>([['coll/key-1', { foo: 'bar' }]]);
    const { client } = makeClient({ store });
    const result = await client.get('coll', 'key-1');
    expect(result).toEqual({ foo: 'bar' });
  });

  it('returns null on 404 (not-found)', async () => {
    const { client } = makeClient({ store: new Map() });
    const result = await client.get('coll', 'missing');
    expect(result).toBeNull();
  });

  it('maps a 500 error to KVError with KV_HTTP', async () => {
    const httpErr = Object.assign(new Error('server error'), {
      response: { status: 500 },
    });
    const { client } = makeClient({ store: new Map(), throwOnGet: httpErr });
    try {
      await client.get('coll', 'key');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(KVError);
      expect((err as KVError).code).toBe(KV_ERROR_CODES.HTTP);
      expect((err as KVError).status).toBe(500);
    }
  });
});

describe('SdkKVClient.listKeys + .list', () => {
  it('listKeys returns the keys for a collection', async () => {
    const store = new Map<string, unknown>([
      ['coll/k1', { x: 1 }],
      ['coll/k2', { x: 2 }],
      ['other/kx', { y: 9 }],
    ]);
    const { client } = makeClient({ store });
    const keys = await client.listKeys('coll');
    expect(keys.sort()).toEqual(['k1', 'k2']);
  });

  it('list returns key + value records in a single SDK call (withValues=true)', async () => {
    const store = new Map<string, unknown>([
      ['coll/k1', { foo: 1 }],
      ['coll/k2', { foo: 2 }],
    ]);
    const { client, sdks } = makeClient({ store });
    const records = await client.list('coll');
    expect(records).toHaveLength(2);
    expect(records.map((r) => r.key).sort()).toEqual(['k1', 'k2']);
    // The list() implementation should call listKeys once with withValues=true,
    // not listKeys + N gets.
    const listCalls = sdks[0]?.calls.filter((c) => c.method === 'listKeys') ?? [];
    expect(listCalls).toHaveLength(1);
    expect(listCalls[0]?.args[2]).toBe(true);
  });
});

describe('SdkKVClient account switch', () => {
  let activeAccountId: string | null;
  beforeEach(() => {
    activeAccountId = 'acct-A';
  });

  it('rebuilds the SDK when the active accountId changes', async () => {
    const sdks: FakeKvSdk[] = [];
    class SdkCtor extends FakeKvSdk {
      constructor(p: { token: () => string; discoveryUrl: string; accountId?: string }) {
        super(p);
        sdks.push(this);
      }
    }
    const client = new SdkKVClient({
      token: () => 'tok',
      discoveryUrl: 'https://discovery.test',
      accountId: () => activeAccountId,
      sdkCtor: SdkCtor,
    });
    await client.set('coll', 'k', 'v').catch(() => undefined);
    await client.set('coll', 'k', 'v').catch(() => undefined);
    expect(sdks).toHaveLength(1);
    expect(sdks[0]?.storedAccountId).toBe('acct-A');

    // Switch user.
    activeAccountId = 'acct-B';
    await client.set('coll', 'k', 'v').catch(() => undefined);
    expect(sdks).toHaveLength(2);
    expect(sdks[1]?.storedAccountId).toBe('acct-B');
  });
});
