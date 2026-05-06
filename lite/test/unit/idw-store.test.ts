/**
 * IdwStore tests.
 *
 * Covers persistence + validation + Store-update semantics directly
 * against a `FakeKV` so the wire format and error paths are exercised
 * without standing up a real KV server.
 */

import { describe, it, expect, vi } from 'vitest';
import { IdwStore, KV_COLLECTION, KV_KEY } from '../../idw/store.js';
import { IdwError, IDW_ERROR_CODES } from '../../idw/errors.js';
import type { IdwEntry, AgentKind } from '../../idw/types.js';
import { FakeKV } from '../harness/index.js';

function makeStore(now = '2026-05-04T12:00:00.000Z'): {
  store: IdwStore;
  kv: FakeKV;
} {
  const kv = new FakeKV();
  let counter = 0;
  const store = new IdwStore({
    kvApi: kv,
    now: () => new Date(now),
    generateId: (entry) => `${entry.kind}-${entry.label.toLowerCase().replace(/\s+/g, '-')}-${++counter}`,
  });
  return { store, kv };
}

describe('IdwStore basic CRUD', () => {
  it('list() returns [] when KV has no record', async () => {
    const { store } = makeStore();
    expect(await store.list()).toEqual([]);
  });

  it('add() persists a new entry and returns wasUpdate=false', async () => {
    const { store, kv } = makeStore();
    const result = await store.add({
      kind: 'idw',
      label: 'Sales Bot',
      url: 'https://chat.example.com/sales',
    });
    expect(result.wasUpdate).toBe(false);
    expect(result.entry.id).toBe('idw-sales-bot-1');
    expect(result.entry.label).toBe('Sales Bot');
    expect(result.entry.source).toBe('manual');
    expect(result.entry.createdAt).toBe('2026-05-04T12:00:00.000Z');

    // Persisted to KV under the documented key.
    const blob = await kv.get(KV_COLLECTION, KV_KEY);
    expect(blob).toBeDefined();
    expect((blob as { entries: IdwEntry[] }).entries).toHaveLength(1);
  });

  it('list() reads back what add() wrote', async () => {
    const { store } = makeStore();
    await store.add({ kind: 'external-bot', label: 'ChatGPT', url: 'https://chat.openai.com' });
    await store.add({ kind: 'image-creator', label: 'DALL-E', url: 'https://labs.openai.com' });
    const entries = await store.list();
    expect(entries).toHaveLength(2);
    expect(entries[0]?.label).toBe('ChatGPT');
    expect(entries[1]?.label).toBe('DALL-E');
  });

  it('listByKind filters by kind', async () => {
    const { store } = makeStore();
    await store.add({ kind: 'external-bot', label: 'ChatGPT', url: 'https://x' });
    await store.add({ kind: 'idw', label: 'Sales', url: 'https://y' });
    await store.add({ kind: 'external-bot', label: 'Claude', url: 'https://z' });
    const bots = await store.listByKind('external-bot');
    const idws = await store.listByKind('idw');
    expect(bots.map((e) => e.label).sort()).toEqual(['ChatGPT', 'Claude']);
    expect(idws.map((e) => e.label)).toEqual(['Sales']);
  });

  it('get() finds an entry by id; returns null for missing', async () => {
    const { store } = makeStore();
    const { entry } = await store.add({
      kind: 'idw',
      label: 'A',
      url: 'https://a.example',
    });
    expect(await store.get(entry.id)).toMatchObject({ label: 'A' });
    expect(await store.get('does-not-exist')).toBeNull();
  });

  it('update() mutates fields and refreshes updatedAt', async () => {
    const { store } = makeStore('2026-05-04T12:00:00.000Z');
    const { entry } = await store.add({
      kind: 'idw',
      label: 'A',
      url: 'https://a.example',
    });
    // Use a second store with a later clock so updatedAt advances.
    const kv = (store as unknown as { kv: FakeKV }).kv ?? null;
    const store2 = new IdwStore({
      kvApi: (await getKVUnderlying(store)),
      now: () => new Date('2026-05-04T13:00:00.000Z'),
    });
    const updated = await store2.update(entry.id, { label: 'A renamed' });
    expect(updated.label).toBe('A renamed');
    expect(updated.updatedAt).toBe('2026-05-04T13:00:00.000Z');
    expect(updated.createdAt).toBe('2026-05-04T12:00:00.000Z');
    void kv;
  });

  it('remove() deletes by id', async () => {
    const { store } = makeStore();
    const { entry } = await store.add({
      kind: 'idw',
      label: 'A',
      url: 'https://a.example',
    });
    await store.remove(entry.id);
    expect(await store.list()).toHaveLength(0);
  });
});

describe('IdwStore validation', () => {
  it('add() rejects invalid kind', async () => {
    const { store } = makeStore();
    await expect(
      store.add({ kind: 'unknown' as AgentKind, label: 'x', url: 'https://x' })
    ).rejects.toMatchObject({ code: IDW_ERROR_CODES.INVALID_INPUT });
  });

  it('add() rejects missing label', async () => {
    const { store } = makeStore();
    await expect(
      store.add({ kind: 'idw', label: '', url: 'https://x' })
    ).rejects.toMatchObject({ code: IDW_ERROR_CODES.INVALID_INPUT });
  });

  it('add() rejects ftp:// URL', async () => {
    const { store } = makeStore();
    await expect(
      store.add({ kind: 'idw', label: 'A', url: 'ftp://nope' })
    ).rejects.toMatchObject({ code: IDW_ERROR_CODES.INVALID_URL });
  });

  it('add() rejects invalid apiUrl', async () => {
    const { store } = makeStore();
    await expect(
      store.add({
        kind: 'image-creator',
        label: 'A',
        url: 'https://x',
        apiUrl: 'not a url',
      })
    ).rejects.toMatchObject({ code: IDW_ERROR_CODES.INVALID_URL });
  });

  it('add() requires audio.subCategory for audio-generator', async () => {
    const { store } = makeStore();
    await expect(
      store.add({
        kind: 'audio-generator',
        label: 'Suno',
        url: 'https://suno.com',
      })
    ).rejects.toMatchObject({ code: IDW_ERROR_CODES.INVALID_INPUT });
  });

  it('add() accepts audio-generator with sub-category', async () => {
    const { store } = makeStore();
    const { entry } = await store.add({
      kind: 'audio-generator',
      label: 'Suno',
      url: 'https://suno.com',
      audio: { subCategory: 'music' },
    });
    expect(entry.audio?.subCategory).toBe('music');
  });

  it('add() rejects an explicit duplicate id', async () => {
    const { store } = makeStore();
    await store.add({
      id: 'fixed-id',
      kind: 'idw',
      label: 'A',
      url: 'https://a',
    });
    await expect(
      store.add({ id: 'fixed-id', kind: 'idw', label: 'B', url: 'https://b' })
    ).rejects.toMatchObject({ code: IDW_ERROR_CODES.DUPLICATE });
  });

  it('update() rejects kind change', async () => {
    const { store } = makeStore();
    const { entry } = await store.add({
      kind: 'idw',
      label: 'A',
      url: 'https://a',
    });
    await expect(
      store.update(entry.id, { kind: 'external-bot' })
    ).rejects.toMatchObject({ code: IDW_ERROR_CODES.KIND_MISMATCH });
  });

  it('update() rejects unknown id', async () => {
    const { store } = makeStore();
    await expect(store.update('unknown', { label: 'x' })).rejects.toMatchObject({
      code: IDW_ERROR_CODES.NOT_FOUND,
    });
  });

  it('remove() rejects unknown id', async () => {
    const { store } = makeStore();
    await expect(store.remove('unknown')).rejects.toMatchObject({
      code: IDW_ERROR_CODES.NOT_FOUND,
    });
  });
});

describe('IdwStore Store-update semantics (catalogId dedupe)', () => {
  it('add() with source=store + matching catalogId updates the existing entry', async () => {
    const { store } = makeStore();
    const first = await store.add({
      kind: 'image-creator',
      label: 'DALL-E v1',
      url: 'https://labs.openai.com/v1',
      source: 'store',
      storeMetadata: {
        catalogId: 'cat-dalle',
        version: '1.0',
        installedAt: '2026-05-04T12:00:00.000Z',
      },
    });
    expect(first.wasUpdate).toBe(false);

    const update = await store.add({
      kind: 'image-creator',
      label: 'DALL-E v2',
      url: 'https://labs.openai.com/v2',
      source: 'store',
      storeMetadata: {
        catalogId: 'cat-dalle',
        version: '2.0',
        installedAt: '2026-05-04T13:00:00.000Z',
      },
    });
    expect(update.wasUpdate).toBe(true);
    expect(update.entry.id).toBe(first.entry.id); // preserved
    expect(update.entry.label).toBe('DALL-E v2');
    expect(update.entry.url).toBe('https://labs.openai.com/v2');
    expect(update.entry.storeMetadata?.version).toBe('2.0');
    // installedAt preserved from first install.
    expect(update.entry.storeMetadata?.installedAt).toBe('2026-05-04T12:00:00.000Z');
    expect(update.entry.storeMetadata?.updatedAt).toBe('2026-05-04T12:00:00.000Z');

    expect(await store.list()).toHaveLength(1);
  });

  it('add() with mismatched kind on existing catalogId rejects with KIND_MISMATCH', async () => {
    const { store } = makeStore();
    await store.add({
      kind: 'image-creator',
      label: 'X',
      url: 'https://x',
      source: 'store',
      storeMetadata: { catalogId: 'cat-x', installedAt: '2026-05-04T12:00:00.000Z' },
    });
    await expect(
      store.add({
        kind: 'video-creator',
        label: 'X',
        url: 'https://x',
        source: 'store',
        storeMetadata: { catalogId: 'cat-x', installedAt: '2026-05-04T13:00:00.000Z' },
      })
    ).rejects.toMatchObject({ code: IDW_ERROR_CODES.KIND_MISMATCH });
  });
});

describe('IdwStore onChange', () => {
  it('emits change event on add/update/remove', async () => {
    const { store } = makeStore();
    const events: number[] = [];
    const unsub = store.onChange((entries) => events.push(entries.length));
    await store.add({ kind: 'idw', label: 'A', url: 'https://a' });
    await store.add({ kind: 'idw', label: 'B', url: 'https://b' });
    const all = await store.list();
    expect(all[0]).toBeDefined();
    await store.update((all[0] as IdwEntry).id, { label: 'A renamed' });
    await store.remove((all[0] as IdwEntry).id);
    unsub();
    expect(events).toEqual([1, 2, 2, 1]);
  });
});

describe('IdwStore refreshAfterAccountChange', () => {
  // Regression coverage: "OAGI store shows agents installed but no
  // menu items." When the user signs in AFTER the IDW menu builder
  // ran its first `list()` (returning [] because signed-out), the
  // menu was never told to re-fetch. The fix: api.ts hooks
  // `auth.onSessionChanged` to call `refreshAfterAccountChange`,
  // which forces a fresh KV read and broadcasts via onChange.
  it('emits the post-account-change entry list to onChange subscribers', async () => {
    let accountId: string | null = null;
    const kv = new FakeKV();
    let counter = 0;
    const store = new IdwStore({
      kvApi: kv,
      now: () => new Date('2026-05-04T12:00:00.000Z'),
      generateId: (entry) => `${entry.kind}-${entry.label.toLowerCase().replace(/\s+/g, '-')}-${++counter}`,
      getActiveAccountId: () => accountId,
    });
    // Pre-populate KV directly (simulating a prior session that
    // installed agents). This bypasses the store -- the store's
    // signed-out add() throws.
    await kv.set('lite-idw-entries', 'default', {
      schemaVersion: 1,
      entries: [
        {
          id: 'idw-marvin-1',
          kind: 'idw',
          label: 'Marvin 2',
          url: 'https://marvin.example',
          source: 'store',
          createdAt: '2026-05-01T00:00:00.000Z',
          updatedAt: '2026-05-01T00:00:00.000Z',
        },
        {
          id: 'idw-myai-1',
          kind: 'idw',
          label: 'My Ai',
          url: 'https://myai.example',
          source: 'store',
          createdAt: '2026-05-02T00:00:00.000Z',
          updatedAt: '2026-05-02T00:00:00.000Z',
        },
      ],
    });

    // Subscribe BEFORE sign-in (mirrors menu-builder's wiring).
    const events: Array<{ count: number; labels: string[] }> = [];
    store.onChange((entries) => {
      events.push({
        count: entries.length,
        labels: entries.map((e) => e.label),
      });
    });

    // Initial list while signed-out: the store gates and returns [].
    expect(await store.list()).toEqual([]);
    expect(events).toHaveLength(0);

    // Simulate auth landing.
    accountId = '35254342-4a2e-475b-aec1-18547e517e29';
    await store.refreshAfterAccountChange();

    // The cache invalidates, the store re-reads KV, and the entries
    // are broadcast through onChange so the menu builder rebuilds.
    expect(events).toHaveLength(1);
    expect(events[0]?.count).toBe(2);
    expect(events[0]?.labels).toEqual(['Marvin 2', 'My Ai']);
  });

  it('emits an empty list on sign-out (refresh after accountId -> null)', async () => {
    let accountId: string | null = '35254342-4a2e-475b-aec1-18547e517e29';
    const kv = new FakeKV();
    const store = new IdwStore({
      kvApi: kv,
      now: () => new Date('2026-05-04T12:00:00.000Z'),
      generateId: (entry) => `idw-${entry.label}-${counter++}`,
      getActiveAccountId: () => accountId,
    });
    let counter = 0;
    await store.add({ kind: 'idw', label: 'A', url: 'https://a.example' });
    expect((await store.list()).length).toBe(1);

    const events: number[] = [];
    store.onChange((entries) => events.push(entries.length));

    accountId = null;
    await store.refreshAfterAccountChange();

    expect(events).toEqual([0]);
  });

  it('still emits even when KV read throws (subscribers never get stuck)', async () => {
    let accountId: string | null = null;
    const kv = new FakeKV();
    // Force the next read to throw a non-KVError, which the store's
    // readBlob doesn't soft-fail. The catch in
    // refreshAfterAccountChange should still emit [].
    const originalGet = kv.get.bind(kv);
    let throwOnNextGet = false;
    kv.get = vi.fn(async (collection: string, key: string) => {
      if (throwOnNextGet) {
        throwOnNextGet = false;
        throw new Error('simulated unexpected error');
      }
      return originalGet(collection, key);
    });
    const store = new IdwStore({ kvApi: kv, getActiveAccountId: () => accountId });
    const events: number[] = [];
    store.onChange((entries) => events.push(entries.length));

    accountId = 'acct-xyz';
    throwOnNextGet = true;
    await store.refreshAfterAccountChange();

    expect(events).toEqual([0]);
  });
});

describe('IdwStore botType field', () => {
  it('round-trips botType for an external-bot entry', async () => {
    const { store } = makeStore();
    const { entry } = await store.add({
      kind: 'external-bot',
      label: 'ChatGPT',
      url: 'https://chat.openai.com',
      botType: 'chatgpt',
    });
    expect(entry.botType).toBe('chatgpt');

    // Reads back from KV via list() too.
    const fromList = await store.list();
    expect(fromList[0]?.botType).toBe('chatgpt');
  });

  it('drops botType silently for non-external-bot kinds on add', async () => {
    const { store } = makeStore();
    const { entry } = await store.add({
      kind: 'idw',
      label: 'Sales',
      url: 'https://sales.example',
      // Sneak botType onto a non-external-bot kind; the store should drop it.
      botType: 'chatgpt',
    } as unknown as Parameters<typeof store.add>[0]);
    expect(entry.botType).toBeUndefined();
  });

  it('drops botType silently when patched onto a non-external-bot entry', async () => {
    const { store } = makeStore();
    const { entry } = await store.add({
      kind: 'image-creator',
      label: 'DALL-E',
      url: 'https://labs.openai.com',
    });
    const updated = await store.update(entry.id, {
      botType: 'chatgpt',
    } as unknown as Partial<IdwEntry>);
    expect(updated.botType).toBeUndefined();
  });

  it('persists a new botType on update of an external-bot entry', async () => {
    const { store } = makeStore();
    const { entry } = await store.add({
      kind: 'external-bot',
      label: 'ChatGPT',
      url: 'https://chat.openai.com',
      botType: 'chatgpt',
    });
    const updated = await store.update(entry.id, {
      botType: 'claude',
      label: 'Claude',
      url: 'https://claude.ai/new',
    });
    expect(updated.botType).toBe('claude');
    expect(updated.label).toBe('Claude');
  });
});

describe('IdwStore persistence error handling', () => {
  it('add() wraps KV errors as IDW_PERSISTENCE_FAILED', async () => {
    const { store, kv } = makeStore();
    kv.failSet = true;
    await expect(
      store.add({ kind: 'idw', label: 'A', url: 'https://a' })
    ).rejects.toBeInstanceOf(IdwError);
    await expect(
      store.add({ kind: 'idw', label: 'A', url: 'https://a' })
    ).rejects.toMatchObject({ code: IDW_ERROR_CODES.PERSISTENCE_FAILED });
  });
});

// Helper: extract the underlying KV from an IdwStore instance for
// the rare test that needs to swap `now`.
async function getKVUnderlying(store: IdwStore): Promise<FakeKV> {
  // The IdwStore doesn't expose `kv`; we go via the documented
  // collection key. In tests that need this, accept the cost of
  // round-tripping through KV.
  // Reasonable alternative: reach into `(store as any).kv` -- avoided
  // here so this helper documents its own contract.
  return (store as unknown as { kv: FakeKV }).kv;
}
