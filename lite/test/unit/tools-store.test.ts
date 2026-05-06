/**
 * ToolsStore tests.
 *
 * Covers persistence + validation directly against a `FakeKV` so the
 * wire format and error paths are exercised without standing up a real
 * KV server. Mirrors the IDW store test patterns at lower complexity
 * (no kinds, no presets).
 */

import { describe, it, expect } from 'vitest';
import { ToolsStore, KV_COLLECTION, KV_KEY } from '../../tools/store.js';
import { ToolsError, TOOLS_ERROR_CODES } from '../../tools/errors.js';
import type { ToolEntry } from '../../tools/types.js';
import { FakeKV } from '../harness/index.js';

function makeStore(now = '2026-05-04T12:00:00.000Z'): {
  store: ToolsStore;
  kv: FakeKV;
} {
  const kv = new FakeKV();
  let counter = 0;
  const store = new ToolsStore({
    kvApi: kv,
    now: () => new Date(now),
    generateId: (entry) =>
      `tool-${entry.label.toLowerCase().replace(/\s+/g, '-')}-${++counter}`,
  });
  return { store, kv };
}

describe('ToolsStore basic CRUD', () => {
  it('list() returns [] when KV has no record', async () => {
    const { store } = makeStore();
    expect(await store.list()).toEqual([]);
  });

  it('add() persists a new entry', async () => {
    const { store, kv } = makeStore();
    const entry = await store.add({
      label: 'Notion',
      url: 'https://notion.so',
    });
    expect(entry.id).toBe('tool-notion-1');
    expect(entry.label).toBe('Notion');
    expect(entry.url).toBe('https://notion.so');
    expect(entry.createdAt).toBe('2026-05-04T12:00:00.000Z');

    const blob = await kv.get(KV_COLLECTION, KV_KEY);
    expect(blob).toBeDefined();
    expect((blob as { entries: ToolEntry[] }).entries).toHaveLength(1);
  });

  it('list() reads back what add() wrote', async () => {
    const { store } = makeStore();
    await store.add({ label: 'Notion', url: 'https://notion.so' });
    await store.add({ label: 'Linear', url: 'https://linear.app' });
    const entries = await store.list();
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.label)).toEqual(['Notion', 'Linear']);
  });

  it('get() returns the entry by id; null for missing', async () => {
    const { store } = makeStore();
    const entry = await store.add({ label: 'X', url: 'https://x.example' });
    expect(await store.get(entry.id)).toMatchObject({ label: 'X' });
    expect(await store.get('does-not-exist')).toBeNull();
  });

  it('update() mutates fields and refreshes updatedAt', async () => {
    const { kv } = makeStore('2026-05-04T12:00:00.000Z');
    const store1 = new ToolsStore({
      kvApi: kv,
      now: () => new Date('2026-05-04T12:00:00.000Z'),
      generateId: () => 'tool-x-1',
    });
    const entry = await store1.add({ label: 'X', url: 'https://x.example' });
    const store2 = new ToolsStore({
      kvApi: kv,
      now: () => new Date('2026-05-04T13:00:00.000Z'),
    });
    const updated = await store2.update(entry.id, { label: 'X renamed' });
    expect(updated.label).toBe('X renamed');
    expect(updated.url).toBe('https://x.example');
    expect(updated.createdAt).toBe('2026-05-04T12:00:00.000Z');
    expect(updated.updatedAt).toBe('2026-05-04T13:00:00.000Z');
  });

  it('update() throws TOOLS_NOT_FOUND for unknown id', async () => {
    const { store } = makeStore();
    await expect(store.update('missing', { label: 'X' })).rejects.toMatchObject({
      code: TOOLS_ERROR_CODES.NOT_FOUND,
    });
  });

  it('remove() deletes an entry; throws on missing', async () => {
    const { store } = makeStore();
    const entry = await store.add({ label: 'X', url: 'https://x.example' });
    await store.remove(entry.id);
    expect(await store.list()).toEqual([]);
    await expect(store.remove(entry.id)).rejects.toMatchObject({
      code: TOOLS_ERROR_CODES.NOT_FOUND,
    });
  });
});

describe('ToolsStore validation', () => {
  it('add() rejects empty label', async () => {
    const { store } = makeStore();
    await expect(store.add({ label: '', url: 'https://x.example' })).rejects.toBeInstanceOf(
      ToolsError
    );
    await expect(store.add({ label: '   ', url: 'https://x.example' })).rejects.toMatchObject({
      code: TOOLS_ERROR_CODES.INVALID_INPUT,
    });
  });

  it('add() rejects missing url', async () => {
    const { store } = makeStore();
    await expect(store.add({ label: 'X', url: '' })).rejects.toMatchObject({
      code: TOOLS_ERROR_CODES.INVALID_URL,
    });
  });

  it('add() rejects malformed url', async () => {
    const { store } = makeStore();
    await expect(store.add({ label: 'X', url: 'not a url' })).rejects.toMatchObject({
      code: TOOLS_ERROR_CODES.INVALID_URL,
    });
  });

  it('add() rejects non-http(s) url', async () => {
    const { store } = makeStore();
    await expect(store.add({ label: 'X', url: 'ftp://example.com' })).rejects.toMatchObject({
      code: TOOLS_ERROR_CODES.INVALID_URL,
    });
  });

  it('add() with explicit colliding id throws TOOLS_DUPLICATE', async () => {
    const { store } = makeStore();
    await store.add({ id: 'fixed', label: 'X', url: 'https://x.example' });
    await expect(
      store.add({ id: 'fixed', label: 'Y', url: 'https://y.example' })
    ).rejects.toMatchObject({
      code: TOOLS_ERROR_CODES.DUPLICATE,
    });
  });

  it('update() validates a new url before writing', async () => {
    const { store } = makeStore();
    const entry = await store.add({ label: 'X', url: 'https://x.example' });
    await expect(store.update(entry.id, { url: 'mailto:nope' })).rejects.toMatchObject({
      code: TOOLS_ERROR_CODES.INVALID_URL,
    });
    // Existing entry unchanged.
    expect((await store.get(entry.id))?.url).toBe('https://x.example');
  });

  it('update() validates a new label before writing', async () => {
    const { store } = makeStore();
    const entry = await store.add({ label: 'X', url: 'https://x.example' });
    await expect(store.update(entry.id, { label: '' })).rejects.toMatchObject({
      code: TOOLS_ERROR_CODES.INVALID_INPUT,
    });
  });
});

describe('ToolsStore signed-out behavior', () => {
  it('returns [] from list() when accountId resolver yields null', async () => {
    const kv = new FakeKV();
    const store = new ToolsStore({ kvApi: kv, getActiveAccountId: () => null });
    expect(await store.list()).toEqual([]);
  });

  it('throws TOOLS_PERSISTENCE_FAILED on add() when signed-out', async () => {
    const kv = new FakeKV();
    const store = new ToolsStore({ kvApi: kv, getActiveAccountId: () => null });
    await expect(store.add({ label: 'X', url: 'https://x.example' })).rejects.toMatchObject({
      code: TOOLS_ERROR_CODES.PERSISTENCE_FAILED,
    });
  });
});

describe('ToolsStore onChange', () => {
  it('notifies subscribers after every successful mutation', async () => {
    const { store } = makeStore();
    const events: number[] = [];
    const unsub = store.onChange((entries) => {
      events.push(entries.length);
    });
    const e1 = await store.add({ label: 'A', url: 'https://a.example' });
    await store.add({ label: 'B', url: 'https://b.example' });
    await store.update(e1.id, { label: 'A2' });
    await store.remove(e1.id);
    expect(events).toEqual([1, 2, 2, 1]);
    unsub();
  });
});
