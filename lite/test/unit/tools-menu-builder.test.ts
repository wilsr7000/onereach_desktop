/**
 * Tools menu-builder tests.
 *
 * Drives initMenuBuilder against the real menu registry with an
 * injected ToolsApi stub. Verifies:
 *   - top:tools is registered with order 70 on init.
 *   - The empty-state hint item appears when the list is empty.
 *   - Per-tool items render (one per entry) with stable ids.
 *   - Entries are unregistered when removed.
 *   - The "Manage Tools..." tail item is always present.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { registry } from '../../menu/registry.js';
import {
  initMenuBuilder,
  teardownMenuBuilder,
  TOP_LEVEL_ID,
  EMPTY_ITEM_ID,
  MANAGE_ID,
  TAIL_SEPARATOR_ID,
} from '../../tools/menu-builder.js';
import type { ToolsApi, ToolEntry } from '../../tools/api.js';

class FakeToolsApi implements Pick<ToolsApi, 'list' | 'onChange'> {
  public entries: ToolEntry[] = [];
  private listeners: Array<(e: ToolEntry[]) => void> = [];

  list = vi.fn(async (): Promise<ToolEntry[]> => [...this.entries]);
  get = vi.fn(async (id: string): Promise<ToolEntry | null> =>
    this.entries.find((e) => e.id === id) ?? null
  );
  add = vi.fn();
  update = vi.fn();
  remove = vi.fn();
  onChange = (handler: (entries: ToolEntry[]) => void): (() => void) => {
    this.listeners.push(handler);
    return (): void => {
      this.listeners = this.listeners.filter((h) => h !== handler);
    };
  };
  onEvent = vi.fn().mockReturnValue(() => undefined);

  setEntries(entries: ToolEntry[]): void {
    this.entries = [...entries];
    for (const h of this.listeners) {
      try {
        h([...this.entries]);
      } catch {
        // best-effort
      }
    }
  }
}

function makeEntry(partial: Partial<ToolEntry> & Pick<ToolEntry, 'id' | 'label'>): ToolEntry {
  return {
    url: `https://${partial.id}.example`,
    createdAt: '2026-05-04T12:00:00.000Z',
    updatedAt: '2026-05-04T12:00:00.000Z',
    ...partial,
  } as ToolEntry;
}

let api: FakeToolsApi;
const handlers = {
  onOpenEntry: vi.fn(),
  onOpenManager: vi.fn(),
};

async function flush(): Promise<void> {
  // Allow the initMenuBuilder kicked-off `api.list().then(rebuild)` to settle.
  await Promise.resolve();
  await Promise.resolve();
}

describe('Tools menu-builder', () => {
  beforeEach(() => {
    registry._resetForTesting();
    handlers.onOpenEntry.mockClear();
    handlers.onOpenManager.mockClear();
    api = new FakeToolsApi();
  });

  afterEach(() => {
    teardownMenuBuilder();
  });

  it('registers top:tools placeholder with the documented order', () => {
    initMenuBuilder({ ...handlers, api: api as unknown as ToolsApi });
    const top = registry.get(TOP_LEVEL_ID);
    expect(top?.label).toBe('Tools');
    expect(top?.order).toBe(70);
  });

  it('registers the always-present Manage Tools... item', () => {
    initMenuBuilder({ ...handlers, api: api as unknown as ToolsApi });
    const manage = registry.get(MANAGE_ID);
    expect(manage?.label).toBe('Manage Tools...');
    expect(manage?.parentId).toBe(TOP_LEVEL_ID);
    expect(manage?.click).toBeDefined();
    manage?.click?.();
    expect(handlers.onOpenManager).toHaveBeenCalledTimes(1);
  });

  it('shows the empty-state hint when there are no entries', async () => {
    initMenuBuilder({ ...handlers, api: api as unknown as ToolsApi });
    await flush();
    expect(registry.has(EMPTY_ITEM_ID)).toBe(true);
    const empty = registry.get(EMPTY_ITEM_ID);
    expect(empty?.enabled).toBe(false);
  });

  it('renders one menu item per entry once tools exist', async () => {
    initMenuBuilder({ ...handlers, api: api as unknown as ToolsApi });
    await flush();
    api.setEntries([
      makeEntry({ id: 'a', label: 'Notion' }),
      makeEntry({ id: 'b', label: 'Linear' }),
    ]);
    expect(registry.has(EMPTY_ITEM_ID)).toBe(false);
    expect(registry.has('tools:item:a')).toBe(true);
    expect(registry.has('tools:item:b')).toBe(true);
    expect(registry.get('tools:item:a')?.label).toBe('Notion');
    expect(registry.get('tools:item:b')?.label).toBe('Linear');
    expect(registry.has(TAIL_SEPARATOR_ID)).toBe(true);
  });

  it('clicking an entry invokes onOpenEntry with the resolved entry', async () => {
    initMenuBuilder({ ...handlers, api: api as unknown as ToolsApi });
    await flush();
    const entry = makeEntry({ id: 'a', label: 'Notion' });
    api.setEntries([entry]);
    registry.get('tools:item:a')?.click?.();
    expect(handlers.onOpenEntry).toHaveBeenCalledTimes(1);
    expect(handlers.onOpenEntry).toHaveBeenCalledWith(entry);
  });

  it('unregisters items removed since the last rebuild', async () => {
    initMenuBuilder({ ...handlers, api: api as unknown as ToolsApi });
    await flush();
    api.setEntries([makeEntry({ id: 'a', label: 'A' }), makeEntry({ id: 'b', label: 'B' })]);
    expect(registry.has('tools:item:a')).toBe(true);
    expect(registry.has('tools:item:b')).toBe(true);
    api.setEntries([makeEntry({ id: 'b', label: 'B' })]);
    expect(registry.has('tools:item:a')).toBe(false);
    expect(registry.has('tools:item:b')).toBe(true);
  });

  it('teardown unregisters everything it owns', async () => {
    initMenuBuilder({ ...handlers, api: api as unknown as ToolsApi });
    await flush();
    api.setEntries([makeEntry({ id: 'a', label: 'A' })]);
    teardownMenuBuilder();
    expect(registry.has(TOP_LEVEL_ID)).toBe(false);
    expect(registry.has(MANAGE_ID)).toBe(false);
    expect(registry.has(EMPTY_ITEM_ID)).toBe(false);
    expect(registry.has(TAIL_SEPARATOR_ID)).toBe(false);
    expect(registry.has('tools:item:a')).toBe(false);
  });

  it('initMenuBuilder is idempotent', () => {
    initMenuBuilder({ ...handlers, api: api as unknown as ToolsApi });
    expect(() =>
      initMenuBuilder({ ...handlers, api: api as unknown as ToolsApi })
    ).not.toThrow();
  });
});
