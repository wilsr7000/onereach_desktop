/**
 * IDW integration tests.
 *
 * Exercises the IdwStore against the real in-memory KV server (so
 * the wire format is verified), plus the menu-builder + IdwApi
 * together so changes flow through end to end:
 *
 *   add() -> KV write -> in-memory blob -> list() reflects -> menu
 *   builder rebuilds via onChange -> registry shows new entry.
 *
 * The catalog window's renderer + the placeholder browser window
 * require Electron (BrowserWindow), so they're not exercised here --
 * E2E coverage handles those surfaces.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { IdwStore } from '../../idw/store.js';
import {
  initMenuBuilder,
  teardownMenuBuilder,
  TOP_LEVEL_ID,
  MANAGE_ID,
} from '../../idw/menu-builder.js';
import { registry } from '../../menu/registry.js';
import {
  startInMemoryKVServer,
  type InMemoryKVServer,
} from '../harness/index.js';
import { _resetKVApiForTesting, _setKVApiForTesting, getKVApi } from '../../kv/api.js';
import { EdisonKVClient } from '../../kv/client.js';
import type { IdwApi, IdwEntry } from '../../idw/api.js';

let kvServer: InMemoryKVServer;
let store: IdwStore;

beforeEach(async () => {
  _resetKVApiForTesting();
  kvServer = await startInMemoryKVServer();
  _setKVApiForTesting(
    new EdisonKVClient({
      url: `${kvServer.url}/keyvalue`,
      timeoutMs: 1000,
    })
  );
  registry._resetForTesting();
  teardownMenuBuilder();
  store = new IdwStore({ kvApi: getKVApi() });
});

afterEach(async () => {
  teardownMenuBuilder();
  registry._resetForTesting();
  await kvServer.stop();
  _resetKVApiForTesting();
});

describe('IdwStore against real KV', () => {
  it('round-trips entries through KV (add -> list)', async () => {
    await store.add({ kind: 'idw', label: 'Sales', url: 'https://chat.example/sales' });
    await store.add({
      kind: 'external-bot',
      label: 'ChatGPT',
      url: 'https://chat.openai.com',
    });

    // Fresh store reads from the same KV.
    const fresh = new IdwStore({ kvApi: getKVApi() });
    const entries = await fresh.list();
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.label).sort()).toEqual(['ChatGPT', 'Sales']);
  });

  it('store-update path persists merged entry with same id', async () => {
    const first = await store.add({
      kind: 'image-creator',
      label: 'DALL-E',
      url: 'https://labs.openai.com/v1',
      source: 'store',
      storeMetadata: { catalogId: 'cat-dalle', version: '1', installedAt: '2026-01-01T00:00:00Z' },
    });
    const update = await store.add({
      kind: 'image-creator',
      label: 'DALL-E',
      url: 'https://labs.openai.com/v2',
      source: 'store',
      storeMetadata: { catalogId: 'cat-dalle', version: '2', installedAt: '2026-01-02T00:00:00Z' },
    });
    expect(update.wasUpdate).toBe(true);
    expect(update.entry.id).toBe(first.entry.id);

    const fresh = new IdwStore({ kvApi: getKVApi() });
    const entries = await fresh.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.url).toBe('https://labs.openai.com/v2');
  });
});

describe('botType end-to-end (real KV)', () => {
  it('Add -> Edit -> Remove flow for an external-bot with a preset', async () => {
    // ADD: external-bot with botType=chatgpt round-trips through KV.
    const added = await store.add({
      kind: 'external-bot',
      label: 'ChatGPT',
      url: 'https://chat.openai.com',
      source: 'manual',
      botType: 'chatgpt',
    });
    expect(added.entry.botType).toBe('chatgpt');

    // A fresh store reading the same KV sees the field.
    const reader = new IdwStore({ kvApi: getKVApi() });
    const afterAdd = await reader.list();
    expect(afterAdd).toHaveLength(1);
    expect(afterAdd[0]?.botType).toBe('chatgpt');
    expect(afterAdd[0]?.url).toBe('https://chat.openai.com');

    // EDIT: switch the same entry's preset (chatgpt -> claude) and url.
    const edited = await store.update(added.entry.id, {
      botType: 'claude',
      label: 'Claude',
      url: 'https://claude.ai/new',
    });
    expect(edited.botType).toBe('claude');
    expect(edited.label).toBe('Claude');
    expect(edited.url).toBe('https://claude.ai/new');
    // id and createdAt are immutable; updatedAt advances.
    expect(edited.id).toBe(added.entry.id);
    expect(edited.createdAt).toBe(added.entry.createdAt);
    expect(edited.updatedAt).not.toBe(added.entry.createdAt);

    // EDIT again: switch to 'custom' (the explicit no-preset choice
    // round-trips identically).
    const editedCustom = await store.update(added.entry.id, { botType: 'custom' });
    expect(editedCustom.botType).toBe('custom');

    // REMOVE: entry is gone. Use a fresh store -- the existing
    // `reader` instance has a cached blob from earlier and won't
    // refresh until next write. (IdwStore caches per-instance.)
    await store.remove(added.entry.id);
    const postRemoveReader = new IdwStore({ kvApi: getKVApi() });
    const afterRemove = await postRemoveReader.list();
    expect(afterRemove).toHaveLength(0);
  });

  it('drops botType silently when added to a non-external-bot kind', async () => {
    // Sneak botType onto an IDW entry; the store strips it (the form
    // never sends it, but defense-in-depth at the persistence layer).
    const added = await store.add({
      kind: 'idw',
      label: 'Sales',
      url: 'https://sales.example/chat',
      botType: 'chatgpt',
    } as unknown as Parameters<typeof store.add>[0]);
    expect(added.entry.botType).toBeUndefined();

    const reader = new IdwStore({ kvApi: getKVApi() });
    const list = await reader.list();
    expect(list[0]?.botType).toBeUndefined();
  });

  it('drops botType silently when patched onto a non-external-bot entry', async () => {
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

  it('preserves botType across an unrelated update', async () => {
    const { entry } = await store.add({
      kind: 'external-bot',
      label: 'ChatGPT',
      url: 'https://chat.openai.com',
      botType: 'chatgpt',
    });
    // Update only the description; botType must remain.
    const updated = await store.update(entry.id, { description: 'work bot' });
    expect(updated.botType).toBe('chatgpt');
    expect(updated.description).toBe('work bot');
  });

  it('multiple external-bot entries with different botTypes coexist', async () => {
    await store.add({
      kind: 'external-bot',
      label: 'ChatGPT',
      url: 'https://chat.openai.com',
      botType: 'chatgpt',
    });
    await store.add({
      kind: 'external-bot',
      label: 'Claude',
      url: 'https://claude.ai/new',
      botType: 'claude',
    });
    await store.add({
      kind: 'external-bot',
      label: 'My Bot',
      url: 'https://example.com/bot',
      botType: 'custom',
    });

    const reader = new IdwStore({ kvApi: getKVApi() });
    const bots = await reader.listByKind('external-bot');
    expect(bots).toHaveLength(3);
    const byType = new Map(bots.map((b) => [b.botType, b.label]));
    expect(byType.get('chatgpt')).toBe('ChatGPT');
    expect(byType.get('claude')).toBe('Claude');
    expect(byType.get('custom')).toBe('My Bot');
  });
});

describe('IdwApi -> menu-builder cross-wiring', () => {
  it('add via API repaints the menu under top:idw', async () => {
    // Wrap the store as an IdwApi so initMenuBuilder can subscribe.
    const api: IdwApi = {
      list: () => store.list(),
      listByKind: (kind) => store.listByKind(kind),
      get: (id) => store.get(id),
      add: async (input) => store.add(input),
      update: (id, patch) => store.update(id, patch),
      remove: (id) => store.remove(id),
      onChange: (handler) => store.onChange(handler),
      onEvent: (handler) => store.onEvent(handler),
    };

    const onOpenEntry = (): void => undefined;
    const onOpenSettings = (): void => undefined;
    initMenuBuilder({
      api,
      onOpenEntry,
      onOpenSettings,
    });
    // initial-list flush
    await new Promise((r) => setTimeout(r, 5));

    // Tail item is registered.
    expect(registry.has(TOP_LEVEL_ID)).toBe(true);
    expect(registry.has(MANAGE_ID)).toBe(true);

    // Add an entry -> onChange fires -> menu rebuilds.
    const { entry } = await store.add({
      kind: 'idw',
      label: 'Sales',
      url: 'https://chat.example.com/sales',
    });
    // onChange broadcast is synchronous (EventEmitter), so the
    // registry should reflect the new entry immediately.
    expect(registry.has(`idw:idw:${entry.id}`)).toBe(true);

    // Remove -> menu collapses to empty welcoming state.
    await store.remove(entry.id);
    expect(registry.has(`idw:idw:${entry.id}`)).toBe(false);
  });
});

describe('cross-window onChange (simulated)', () => {
  it('two listeners receive every mutation', async () => {
    const a: number[] = [];
    const b: number[] = [];
    const unsubA = store.onChange((entries) => a.push(entries.length));
    const unsubB = store.onChange((entries) => b.push(entries.length));

    await store.add({ kind: 'idw', label: 'A', url: 'https://a' });
    await store.add({ kind: 'idw', label: 'B', url: 'https://b' });

    unsubA();
    unsubB();
    expect(a).toEqual([1, 2]);
    expect(b).toEqual([1, 2]);
  });

  it('a listener that throws does not break the other', async () => {
    const events: number[] = [];
    store.onChange(() => {
      throw new Error('handler boom');
    });
    store.onChange((entries) => events.push(entries.length));

    await store.add({ kind: 'idw', label: 'A', url: 'https://a' });
    expect(events).toEqual([1]);
  });
});

// Bring IdwEntry into runtime so unused-import lints don't trip.
const _typeCheck: IdwEntry | null = null;
void _typeCheck;
