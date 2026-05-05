/**
 * `FakeKV` -- in-memory `KVApi` implementation for unit tests.
 *
 * Use this when a test wants to drive a module that consumes
 * `getKVApi()` without standing up a real HTTP server. For tests that
 * exercise the actual wire format (JSON shape, HTTP verbs, status
 * handling), use `startInMemoryKVServer()` instead -- it spawns a real
 * `node:http` server.
 *
 * Recording: every call appends to `sets` / `deletes` arrays so tests
 * can assert what was attempted. The full record map is exposed via
 * `store` for integration-style assertions.
 *
 * Failure injection: flip `failSet` / `failGet` / `failListKeys` /
 * `failList` / `failDelete` to make the next call to that op throw a
 * `KVError`. The error is shaped to mirror what a real failure would
 * look like (code, message, context).
 *
 * Why a class implementing `KVApi` rather than mocking the real client:
 * tests should depend on the public interface, not the implementation
 * (per Rule 11 / ADR-019).
 */

import { KVError } from '../../../kv/api.js';
import type { KVApi, KVRecord, KvEvent } from '../../../kv/api.js';

/**
 * In-memory `KVApi` for unit tests. Map-backed under the hood; values
 * are stored as-is (no JSON round-trip), so test code can put any
 * shape in and get the same shape out -- if your test cares about the
 * JSON wire format, use the in-memory HTTP server instead.
 */
export class FakeKV implements KVApi {
  /** Records of every successful `set()` call, in order. */
  public readonly sets: Array<{
    collection: string;
    key: string;
    value: unknown;
  }> = [];
  /** Records of every successful `delete()` call, in order. */
  public readonly deletes: Array<{ collection: string; key: string }> = [];
  /** Stored records, keyed by `${collection}::${key}`. */
  public readonly store = new Map<string, unknown>();

  /** Set true to make the next `set()` call throw. */
  public failSet = false;
  /** Set true to make the next `get()` call throw. */
  public failGet = false;
  /** Set true to make the next `listKeys()` call throw. */
  public failListKeys = false;
  /** Set true to make the next `list()` call throw. */
  public failList = false;
  /** Set true to make the next `delete()` call throw. */
  public failDelete = false;

  async set(collection: string, key: string, value: unknown): Promise<void> {
    if (this.failSet) {
      throw new KVError({
        code: 'KV_HTTP',
        message: 'fake-kv: mock set failure',
        status: 500,
        context: { op: 'set', collection, key },
        remediation: 'Test injected this failure via FakeKV.failSet = true.',
      });
    }
    this.sets.push({ collection, key, value });
    this.store.set(`${collection}::${key}`, value);
  }

  async get(collection: string, key: string): Promise<unknown | null> {
    if (this.failGet) {
      throw new KVError({
        code: 'KV_HTTP',
        message: 'fake-kv: mock get failure',
        status: 500,
        context: { op: 'get', collection, key },
        remediation: 'Test injected this failure via FakeKV.failGet = true.',
      });
    }
    return this.store.get(`${collection}::${key}`) ?? null;
  }

  async listKeys(collection: string): Promise<string[]> {
    if (this.failListKeys || this.failList) {
      throw new KVError({
        code: 'KV_HTTP',
        message: 'fake-kv: mock listKeys failure',
        status: 500,
        context: { op: 'listKeys', collection },
        remediation: 'Test injected this failure via FakeKV.failListKeys = true.',
      });
    }
    const keys: string[] = [];
    for (const k of this.store.keys()) {
      const [coll, key] = k.split('::', 2) as [string, string];
      if (coll === collection) keys.push(key);
    }
    return keys;
  }

  async list(collection: string): Promise<KVRecord[]> {
    if (this.failList) {
      throw new KVError({
        code: 'KV_HTTP',
        message: 'fake-kv: mock list failure',
        status: 500,
        context: { op: 'list', collection },
        remediation: 'Test injected this failure via FakeKV.failList = true.',
      });
    }
    const records: KVRecord[] = [];
    for (const [k, value] of this.store.entries()) {
      const [coll, key] = k.split('::', 2) as [string, string];
      if (coll === collection) records.push({ key, value });
    }
    return records;
  }

  async delete(collection: string, key: string): Promise<void> {
    if (this.failDelete) {
      throw new KVError({
        code: 'KV_HTTP',
        message: 'fake-kv: mock delete failure',
        status: 500,
        context: { op: 'delete', collection, key },
        remediation: 'Test injected this failure via FakeKV.failDelete = true.',
      });
    }
    this.deletes.push({ collection, key });
    this.store.delete(`${collection}::${key}`);
  }

  /**
   * No-op event subscription -- FakeKV doesn't emit events itself.
   * Tests that want to assert on emitted events should override the
   * singleton's spanEmitter or use the FakeLogging mock.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  onEvent(_handler: (event: KvEvent) => void): () => void {
    return (): void => {
      /* no-op -- FakeKV doesn't drive the real event log */
    };
  }
}
