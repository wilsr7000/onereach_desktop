/**
 * KV migration tests.
 *
 * Verifies the one-shot copy from the legacy anonymous KV into the
 * user's authenticated KV. Mocks both the legacy `EdisonKVClient`
 * and the authenticated `KVApi` so the test runs without the
 * network.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  runKvMigration,
  COLLECTIONS_TO_MIGRATE,
  MIGRATION_COLLECTION,
  MIGRATION_SENTINEL_KEY,
} from '../../kv/migration.js';
import { FakeKV } from '../harness/index.js';
import { EdisonKVClient } from '../../kv/client.js';

/**
 * Fake legacy reader -- mimics `EdisonKVClient.get` from a
 * pre-populated map. We use a real `EdisonKVClient` instance whose
 * fetchImpl is overridden to read from this map, so the migration
 * code path through `legacyReader.get()` runs unchanged.
 */
function makeLegacyReader(seed: Record<string, unknown>): EdisonKVClient {
  return new EdisonKVClient({
    url: 'https://legacy.test/keyvalue',
    fetchImpl: ((url: string, init?: RequestInit) => {
      // Parse `?id=collection&key=key`.
      const u = new URL(url);
      const collection = u.searchParams.get('id');
      const key = u.searchParams.get('key');
      const compoundKey = `${collection}/${key}`;
      const method = init?.method ?? 'GET';
      if (method === 'GET') {
        const value = seed[compoundKey];
        if (value === undefined) {
          return Promise.resolve({
            ok: true,
            status: 200,
            text: () => Promise.resolve(JSON.stringify({ Status: 'No data found.' })),
          } as unknown as Response);
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve(JSON.stringify({ value: JSON.stringify(value) })),
        } as unknown as Response);
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(''),
      } as unknown as Response);
    }) as typeof fetch,
  });
}

describe('runKvMigration', () => {
  let authedKv: FakeKV;

  beforeEach(() => {
    authedKv = new FakeKV();
  });

  it('no-op when sentinel is already set', async () => {
    await authedKv.set(MIGRATION_COLLECTION, MIGRATION_SENTINEL_KEY, { migratedAt: 'past' });
    const legacyReader = makeLegacyReader({
      'lite-idw-entries/edison:acct-1': { entries: [{ id: 'idw-1' }] },
    });
    const result = await runKvMigration('acct-1', { authedKv, legacyReader });
    expect(result.alreadyMigrated).toBe(true);
    expect(result.copied).toEqual([]);
    // User KV must NOT have been overwritten.
    const idw = await authedKv.get('lite-idw-entries', 'default');
    expect(idw).toBeNull();
  });

  it('copies legacy per-account blobs into authenticated KV at default key', async () => {
    const legacyReader = makeLegacyReader({
      'lite-idw-entries/edison:acct-1': { entries: [{ id: 'idw-1', label: 'first' }] },
      'lite-main-window-tabs/edison:acct-1': { tabs: [{ id: 'tab-1', label: 'GSX' }] },
    });
    const result = await runKvMigration('acct-1', { authedKv, legacyReader });
    expect(result.alreadyMigrated).toBe(false);
    expect(result.copied.sort()).toEqual(['lite-idw-entries', 'lite-main-window-tabs']);

    expect(await authedKv.get('lite-idw-entries', 'default')).toEqual({
      entries: [{ id: 'idw-1', label: 'first' }],
    });
    expect(await authedKv.get('lite-main-window-tabs', 'default')).toEqual({
      tabs: [{ id: 'tab-1', label: 'GSX' }],
    });

    // Sentinel must be set so the next call is a no-op.
    expect(await authedKv.get(MIGRATION_COLLECTION, MIGRATION_SENTINEL_KEY)).toBeTruthy();
  });

  it('falls back to the legacy global default key when no per-account blob exists', async () => {
    const legacyReader = makeLegacyReader({
      // Old globally-shared layout (pre-account scoping).
      'lite-idw-entries/default': { entries: [{ id: 'old-idw' }] },
    });
    const result = await runKvMigration('acct-1', { authedKv, legacyReader });
    expect(result.copied).toContain('lite-idw-entries');
    expect(await authedKv.get('lite-idw-entries', 'default')).toEqual({
      entries: [{ id: 'old-idw' }],
    });
  });

  it('does NOT overwrite user KV when authenticated value already exists', async () => {
    await authedKv.set('lite-idw-entries', 'default', { entries: [{ id: 'user-data', label: 'mine' }] });
    const legacyReader = makeLegacyReader({
      'lite-idw-entries/edison:acct-1': { entries: [{ id: 'legacy', label: 'old' }] },
    });
    const result = await runKvMigration('acct-1', { authedKv, legacyReader });
    expect(result.copied).not.toContain('lite-idw-entries');
    // User's data preserved.
    expect(await authedKv.get('lite-idw-entries', 'default')).toEqual({
      entries: [{ id: 'user-data', label: 'mine' }],
    });
  });

  it('skips when legacy has no data for any collection (clean install)', async () => {
    const legacyReader = makeLegacyReader({});
    const result = await runKvMigration('acct-1', { authedKv, legacyReader });
    expect(result.copied).toEqual([]);
    // Sentinel still written to prevent retries.
    expect(await authedKv.get(MIGRATION_COLLECTION, MIGRATION_SENTINEL_KEY)).toBeTruthy();
  });

  it('is idempotent (second call after success is a no-op)', async () => {
    const legacyReader = makeLegacyReader({
      'lite-idw-entries/edison:acct-1': { entries: [{ id: 'idw-1' }] },
    });
    await runKvMigration('acct-1', { authedKv, legacyReader });
    const second = await runKvMigration('acct-1', { authedKv, legacyReader });
    expect(second.alreadyMigrated).toBe(true);
    expect(second.copied).toEqual([]);
  });

  it('returns early with no work when accountId is empty', async () => {
    const legacyReader = makeLegacyReader({
      'lite-idw-entries/default': { entries: [{ id: 'whatever' }] },
    });
    const result = await runKvMigration('', { authedKv, legacyReader });
    expect(result.copied).toEqual([]);
    expect(await authedKv.get(MIGRATION_COLLECTION, MIGRATION_SENTINEL_KEY)).toBeNull();
  });

  it('continues across collections when one read fails', async () => {
    // The IDW collection legacy fetch will throw; main-window-tabs
    // succeeds. Migration should write the latter and still set the
    // sentinel.
    let callCount = 0;
    const legacyReader = new EdisonKVClient({
      url: 'https://legacy.test/keyvalue',
      fetchImpl: ((url: string) => {
        callCount += 1;
        const u = new URL(url);
        const collection = u.searchParams.get('id');
        if (collection === 'lite-idw-entries') {
          return Promise.reject(new Error('legacy server hiccup'));
        }
        if (collection === 'lite-main-window-tabs') {
          return Promise.resolve({
            ok: true,
            status: 200,
            text: () =>
              Promise.resolve(JSON.stringify({ value: JSON.stringify({ tabs: [{ id: 't' }] }) })),
          } as unknown as Response);
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve(JSON.stringify({ Status: 'No data found.' })),
        } as unknown as Response);
      }) as typeof fetch,
    });
    const result = await runKvMigration('acct-1', { authedKv, legacyReader });
    expect(callCount).toBeGreaterThan(0);
    expect(result.copied).toContain('lite-main-window-tabs');
    expect(result.failed.map((f) => f.collection)).toContain('lite-idw-entries');
    // Sentinel still written -- failures don't keep the migration retrying.
    expect(await authedKv.get(MIGRATION_COLLECTION, MIGRATION_SENTINEL_KEY)).toBeTruthy();
  });

  it('iterates every collection declared in COLLECTIONS_TO_MIGRATE', async () => {
    expect(COLLECTIONS_TO_MIGRATE.map((c) => c.collection).sort()).toEqual([
      'lite-ai-config',
      'lite-idw-entries',
      'lite-main-window-tabs',
      'lite-neon-config',
    ]);
  });
});
