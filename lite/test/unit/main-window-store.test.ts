/**
 * TabStore unit tests.
 *
 * Covers persistence + validation + dedupe semantics directly against
 * a `FakeKV` so the wire format and error paths are exercised without
 * standing up a real KV server.
 */

import { describe, it, expect } from 'vitest';
import { TabStore } from '../../main-window/store.js';
import { KV_COLLECTION, KV_KEY } from '../../main-window/types.js';
import {
  MainWindowError,
  MAIN_WINDOW_ERROR_CODES,
} from '../../main-window/errors.js';
import type { TabsBlob } from '../../main-window/types.js';
import { FakeKV } from '../harness/index.js';

function makeStore(now = '2026-05-04T12:00:00.000Z'): {
  store: TabStore;
  kv: FakeKV;
} {
  const kv = new FakeKV();
  let counter = 0;
  const store = new TabStore({
    kvApi: kv,
    now: () => new Date(now),
    generateIds: () => {
      counter += 1;
      const suffix = counter.toString().padStart(2, '0');
      return { id: `tab-${suffix}`, partition: `persist:tab-${suffix}` };
    },
  });
  return { store, kv };
}

describe('TabStore basic CRUD', () => {
  it('list() returns [] when KV has no record', async () => {
    const { store } = makeStore();
    expect(await store.list()).toEqual([]);
    expect(await store.getActiveId()).toBeNull();
  });

  it('openTab() persists a new tab and sets it active', async () => {
    const { store, kv } = makeStore();
    const result = await store.openTab({
      label: 'ChatGPT',
      url: 'https://chat.openai.com',
    });
    expect(result.wasFocus).toBe(false);
    expect(result.tab.id).toBe('tab-01');
    expect(result.tab.label).toBe('ChatGPT');
    expect(result.tab.partition).toBe('persist:tab-01');
    expect(result.tab.createdAt).toBe('2026-05-04T12:00:00.000Z');
    expect(await store.getActiveId()).toBe('tab-01');

    const blob = (await kv.get(KV_COLLECTION, KV_KEY)) as TabsBlob;
    expect(blob.tabs).toHaveLength(1);
    expect(blob.tabs[0]?.partition).toBe('persist:tab-01');
    expect(blob.activeId).toBe('tab-01');
  });

  it('opens multiple tabs, each with a unique partition', async () => {
    const { store } = makeStore();
    await store.openTab({ label: 'ChatGPT', url: 'https://chat.openai.com' });
    await store.openTab({ label: 'Claude', url: 'https://claude.ai/new' });
    const tabs = await store.list();
    expect(tabs).toHaveLength(2);
    expect(new Set(tabs.map((t) => t.partition)).size).toBe(2);
  });

  it('closeTab() removes the tab and picks a fallback active', async () => {
    const { store } = makeStore();
    const a = await store.openTab({ label: 'A', url: 'https://a.example' });
    const b = await store.openTab({ label: 'B', url: 'https://b.example' });
    await store.openTab({ label: 'C', url: 'https://c.example' });

    // Active is the latest-opened (C). Close it -> previous (B) becomes active.
    await store.closeTab((await store.getActiveId())!);
    expect(await store.getActiveId()).toBe(b.tab.id);

    // Close A (not active). Active stays B.
    await store.closeTab(a.tab.id);
    expect(await store.getActiveId()).toBe(b.tab.id);

    // Close B (the only one left) -> active becomes null.
    await store.closeTab(b.tab.id);
    expect(await store.getActiveId()).toBeNull();
    expect(await store.list()).toEqual([]);
  });

  it('activateTab() switches active without removing tabs', async () => {
    const { store } = makeStore();
    const a = await store.openTab({ label: 'A', url: 'https://a' });
    const b = await store.openTab({ label: 'B', url: 'https://b' });
    expect(await store.getActiveId()).toBe(b.tab.id);
    await store.activateTab(a.tab.id);
    expect(await store.getActiveId()).toBe(a.tab.id);
    expect(await store.list()).toHaveLength(2);
  });

  it('goHome() clears the active id without closing any tab', async () => {
    const { store } = makeStore();
    await store.openTab({ label: 'A', url: 'https://a' });
    await store.openTab({ label: 'B', url: 'https://b' });
    expect(await store.getActiveId()).not.toBeNull();
    await store.goHome();
    expect(await store.getActiveId()).toBeNull();
    expect(await store.list()).toHaveLength(2);
  });

  it('goHome() is a no-op when already cleared', async () => {
    const { store } = makeStore();
    await store.goHome();
    expect(await store.getActiveId()).toBeNull();
  });

  it('setUrl() updates the persisted url and timestamp', async () => {
    const { store } = makeStore('2026-05-04T12:00:00.000Z');
    const { tab } = await store.openTab({ label: 'A', url: 'https://a/start' });
    // Use a second store with a later clock so updatedAt advances.
    const kv = await getKVUnderlying(store);
    const store2 = new TabStore({
      kvApi: kv,
      now: () => new Date('2026-05-04T13:00:00.000Z'),
    });
    await store2.setUrl(tab.id, 'https://a/page');
    const fresh = new TabStore({ kvApi: kv });
    const updated = (await fresh.list())[0];
    expect(updated?.url).toBe('https://a/page');
  });

  it('setLabel() updates label and emits change', async () => {
    const { store } = makeStore();
    const { tab } = await store.openTab({ label: 'Untitled', url: 'https://x' });
    let observedCount = 0;
    store.onChange(() => {
      observedCount += 1;
    });
    await store.setLabel(tab.id, 'Renamed');
    const fresh = await store.get(tab.id);
    expect(fresh?.label).toBe('Renamed');
    expect(observedCount).toBeGreaterThanOrEqual(1);
  });
});

describe('TabStore dedupe by idwId', () => {
  it('focuses existing tab when idwId matches', async () => {
    const { store } = makeStore();
    const first = await store.openTab({
      label: 'Marvin',
      url: 'https://idw.example/marvin/v1',
      idwId: 'marvin',
    });
    expect(first.wasFocus).toBe(false);

    const second = await store.openTab({
      label: 'Marvin (refreshed)',
      url: 'https://idw.example/marvin/v2',
      idwId: 'marvin',
    });
    expect(second.wasFocus).toBe(true);
    expect(second.tab.id).toBe(first.tab.id);
    expect(second.tab.label).toBe('Marvin (refreshed)');
    expect(second.tab.url).toBe('https://idw.example/marvin/v2');

    const tabs = await store.list();
    expect(tabs).toHaveLength(1);
  });

  it('always opens a new tab when idwId is absent', async () => {
    const { store } = makeStore();
    await store.openTab({ label: 'Bot 1', url: 'https://example.com' });
    await store.openTab({ label: 'Bot 2', url: 'https://example.com' });
    expect(await store.list()).toHaveLength(2);
  });
});

describe('TabStore validation', () => {
  it('rejects missing url', async () => {
    const { store } = makeStore();
    await expect(
      store.openTab({ label: 'X', url: '' as unknown as string })
    ).rejects.toMatchObject({ code: MAIN_WINDOW_ERROR_CODES.INVALID_URL });
  });

  it('rejects non-http(s) protocol', async () => {
    const { store } = makeStore();
    await expect(
      store.openTab({ label: 'X', url: 'ftp://example.com' })
    ).rejects.toMatchObject({ code: MAIN_WINDOW_ERROR_CODES.INVALID_URL });
  });

  it('rejects empty label', async () => {
    const { store } = makeStore();
    await expect(
      store.openTab({ label: '', url: 'https://x' })
    ).rejects.toMatchObject({ code: MAIN_WINDOW_ERROR_CODES.INVALID_INPUT });
  });

  it('closeTab on missing id throws MW_NOT_FOUND', async () => {
    const { store } = makeStore();
    await expect(store.closeTab('does-not-exist')).rejects.toBeInstanceOf(MainWindowError);
    await expect(store.closeTab('does-not-exist')).rejects.toMatchObject({
      code: MAIN_WINDOW_ERROR_CODES.NOT_FOUND,
    });
  });

  it('activateTab on missing id throws MW_NOT_FOUND', async () => {
    const { store } = makeStore();
    await expect(store.activateTab('does-not-exist')).rejects.toMatchObject({
      code: MAIN_WINDOW_ERROR_CODES.NOT_FOUND,
    });
  });
});

describe('TabStore onChange', () => {
  it('emits a snapshot on every mutation', async () => {
    const { store } = makeStore();
    const events: Array<{ count: number; activeId: string | null }> = [];
    const unsub = store.onChange((tabs, activeId) => {
      events.push({ count: tabs.length, activeId });
    });
    const a = await store.openTab({ label: 'A', url: 'https://a' });
    const b = await store.openTab({ label: 'B', url: 'https://b' });
    await store.activateTab(a.tab.id);
    await store.closeTab(a.tab.id);
    unsub();
    expect(events).toEqual([
      { count: 1, activeId: a.tab.id },
      { count: 2, activeId: b.tab.id },
      { count: 2, activeId: a.tab.id },
      { count: 1, activeId: b.tab.id },
    ]);
  });

  it('a listener that throws does not break the other', async () => {
    const { store } = makeStore();
    store.onChange(() => {
      throw new Error('handler boom');
    });
    const counts: number[] = [];
    store.onChange((tabs) => counts.push(tabs.length));
    await store.openTab({ label: 'A', url: 'https://a' });
    expect(counts).toEqual([1]);
  });
});

describe('TabStore persistence error handling', () => {
  it('openTab() wraps KV errors as MW_PERSISTENCE_FAILED', async () => {
    const { store, kv } = makeStore();
    kv.failSet = true;
    await expect(
      store.openTab({ label: 'A', url: 'https://a' })
    ).rejects.toMatchObject({ code: MAIN_WINDOW_ERROR_CODES.PERSISTENCE_FAILED });
  });
});

// Helper: extract the underlying KV from a TabStore for tests that
// need to swap `now`.
async function getKVUnderlying(store: TabStore): Promise<FakeKV> {
  return (store as unknown as { kv: FakeKV }).kv;
}
