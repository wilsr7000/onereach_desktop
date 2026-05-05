/**
 * KV integration tests -- end-to-end SdkKVClient + a stand-in for
 * `@or-sdk/key-value-storage`.
 *
 * Per the lite-kv-via-sdk chunk in `lite/PORTING.md`, KV transport
 * moved from the anonymous Edison fetch endpoint to the authenticated
 * SDK. The SDK's own wire format is the SDK team's responsibility --
 * Lite's contract is the public `KVApi` surface and the per-account
 * scoping behavior. These tests exercise:
 *
 *   - set / get / listKeys / list / delete round-trip
 *   - per-account isolation (different accountIds see different data)
 *   - SDK error mapping (HTTP status -> KVError code)
 *   - signed-out gating (no token -> KV_HTTP 401, no SDK call)
 *
 * Slower than unit tests because they exercise the full normalization
 * + caching stack; live in `test/integration/`.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SdkKVClient } from '../../kv/sdk-client.js';
import { KVError, KV_ERROR_CODES } from '../../kv/client.js';

// ─── Fake SDK implementation that mirrors @or-sdk/key-value-storage ───────

class FakeKvService {
  /** The underlying store, keyed by `${accountId}::${collection}::${key}`. */
  public readonly store = new Map<string, unknown>();
  /** Recorded SDK constructor params -- one per FakeKvSdk instance. */
  public readonly constructorParams: Array<{
    accountId: string | undefined;
    discoveryUrl: string;
  }> = [];
  /** Hook to inject errors. Cleared each test. */
  public errorOnNextCall: Error | null = null;

  reset(): void {
    this.store.clear();
    this.constructorParams.length = 0;
    this.errorOnNextCall = null;
  }
}

let service: FakeKvService;

class FakeKvSdk {
  constructor(
    private readonly params: { token: () => string; discoveryUrl: string; accountId?: string }
  ) {
    service.constructorParams.push({
      accountId: params.accountId,
      discoveryUrl: params.discoveryUrl,
    });
  }

  private throwIfArmed(): void {
    if (service.errorOnNextCall !== null) {
      const err = service.errorOnNextCall;
      service.errorOnNextCall = null;
      throw err;
    }
  }

  private storeKey(collection: string, key: string): string {
    return `${this.params.accountId ?? 'unset'}::${collection}::${key}`;
  }

  async setValueByKey(collection: string, key: string, value: unknown): Promise<{ key: string; value: unknown }> {
    this.throwIfArmed();
    service.store.set(this.storeKey(collection, key), value);
    return { key, value };
  }

  async getValueByKey<T = unknown>(collection: string, key: string): Promise<{ key: string; value?: T }> {
    this.throwIfArmed();
    const value = service.store.get(this.storeKey(collection, key));
    if (value === undefined) {
      throw Object.assign(new Error('not found'), { response: { status: 404 } });
    }
    return { key, value: value as T };
  }

  async deleteKey(collection: string, key: string): Promise<void> {
    this.throwIfArmed();
    service.store.delete(this.storeKey(collection, key));
  }

  async listKeys<T = unknown>(
    collection: string,
    _prefix?: string,
    withValues?: boolean
  ): Promise<{ items: Array<{ key: string; lastModified: string; value?: T }> }> {
    this.throwIfArmed();
    const prefix = `${this.params.accountId ?? 'unset'}::${collection}::`;
    const items: Array<{ key: string; lastModified: string; value?: T }> = [];
    for (const [k, v] of service.store.entries()) {
      if (!k.startsWith(prefix)) continue;
      const key = k.slice(prefix.length);
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

function makeClient(opts: { token?: string; accountId?: string | null } = {}): SdkKVClient {
  return new SdkKVClient({
    token: () => opts.token ?? 'tok',
    discoveryUrl: 'https://discovery.test',
    accountId: () => opts.accountId === undefined ? 'acct-1' : opts.accountId,
    sdkCtor: FakeKvSdk,
  });
}

beforeEach(() => {
  service = new FakeKvService();
});

describe('KV integration (SdkKVClient): round-trip', () => {
  it('set + get round-trip preserves complex object shape', async () => {
    const client = makeClient();
    const value = {
      nested: { numbers: [1, 2, 3], string: 'hello' },
      flag: true,
      nullable: null,
    };
    await client.set('coll', 'key-1', value);
    expect(await client.get('coll', 'key-1')).toEqual(value);
  });

  it('get returns null for missing keys (SDK 404 normalization)', async () => {
    const client = makeClient();
    expect(await client.get('coll', 'missing')).toBeNull();
  });

  it('listKeys returns the keys for a collection', async () => {
    const client = makeClient();
    await client.set('coll-a', 'k1', 'a');
    await client.set('coll-a', 'k2', 'b');
    await client.set('coll-b', 'kx', 'c');

    expect((await client.listKeys('coll-a')).sort()).toEqual(['k1', 'k2']);
    expect(await client.listKeys('coll-b')).toEqual(['kx']);
  });

  it('list returns key + value records', async () => {
    const client = makeClient();
    await client.set('coll', 'k1', { foo: 1 });
    await client.set('coll', 'k2', { foo: 2 });
    const records = await client.list('coll');
    expect(records).toHaveLength(2);
    expect(records.map((r) => r.key).sort()).toEqual(['k1', 'k2']);
  });

  it('delete removes the key', async () => {
    const client = makeClient();
    await client.set('coll', 'doomed', 'x');
    expect(await client.get('coll', 'doomed')).toBe('x');
    await client.delete('coll', 'doomed');
    expect(await client.get('coll', 'doomed')).toBeNull();
  });
});

describe('KV integration: per-account isolation (server-side scoping)', () => {
  it('different accountIds see different buckets even with the same collection+key', async () => {
    const aliceClient = makeClient({ accountId: 'alice' });
    const bobClient = makeClient({ accountId: 'bob' });

    await aliceClient.set('coll', 'shared-key', 'alice-data');
    await bobClient.set('coll', 'shared-key', 'bob-data');

    expect(await aliceClient.get('coll', 'shared-key')).toBe('alice-data');
    expect(await bobClient.get('coll', 'shared-key')).toBe('bob-data');
  });
});

describe('KV integration: signed-out gating', () => {
  it('throws KV_HTTP 401 on set when no accountId is available', async () => {
    const client = makeClient({ accountId: null });
    await expect(client.set('coll', 'key', 'value')).rejects.toBeInstanceOf(KVError);
    try {
      await client.set('coll', 'key', 'value');
    } catch (err) {
      expect((err as KVError).status).toBe(401);
      expect((err as KVError).code).toBe(KV_ERROR_CODES.HTTP);
    }
    // Crucially: no SDK was constructed when signed-out.
    expect(service.constructorParams).toHaveLength(0);
  });

  it('throws KV_HTTP 401 on get when no accountId is available', async () => {
    const client = makeClient({ accountId: null });
    await expect(client.get('coll', 'key')).rejects.toBeInstanceOf(KVError);
  });
});

describe('KV integration: SDK error mapping', () => {
  it('maps a 5xx error to KVError with KV_HTTP code', async () => {
    const client = makeClient();
    service.errorOnNextCall = Object.assign(new Error('upstream down'), {
      response: { status: 500 },
    });
    try {
      await client.set('coll', 'key', 'v');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(KVError);
      expect((err as KVError).code).toBe(KV_ERROR_CODES.HTTP);
      expect((err as KVError).status).toBe(500);
    }
  });

  it('maps a 401 error to KVError with KV_HTTP code (token rejected by server)', async () => {
    const client = makeClient();
    service.errorOnNextCall = Object.assign(new Error('unauthorized'), {
      response: { status: 401 },
    });
    try {
      await client.get('coll', 'k');
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as KVError).status).toBe(401);
      expect((err as KVError).remediation).toMatch(/sign out/i);
    }
  });

  it('maps a network error (no response) to KVError with KV_NETWORK', async () => {
    const client = makeClient();
    service.errorOnNextCall = Object.assign(new Error('ECONNREFUSED'), {
      code: 'ECONNREFUSED',
    });
    try {
      await client.delete('coll', 'k');
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as KVError).code).toBe(KV_ERROR_CODES.NETWORK);
    }
  });

  it('attaches structured context (op, collection, key, status) on HTTP errors', async () => {
    const client = makeClient();
    service.errorOnNextCall = Object.assign(new Error('down'), {
      response: { status: 503 },
    });
    try {
      await client.set('my-coll', 'my-key', 'v');
      throw new Error('should have thrown');
    } catch (err) {
      const kv = err as KVError;
      expect(kv.context).toMatchObject({
        op: 'set',
        collection: 'my-coll',
        key: 'my-key',
        status: 503,
      });
    }
  });
});

describe('KV integration: SDK reuse', () => {
  it('reuses the same SDK across calls with the same accountId', async () => {
    const client = makeClient();
    await client.set('coll', 'k1', 'v1');
    await client.set('coll', 'k2', 'v2');
    await client.get('coll', 'k1');
    // SDK ctor called exactly once -- no rebuild on each call.
    expect(service.constructorParams).toHaveLength(1);
    expect(service.constructorParams[0]?.accountId).toBe('acct-1');
  });
});
