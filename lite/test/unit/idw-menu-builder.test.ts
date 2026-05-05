/**
 * IDW menu-builder tests.
 *
 * Drives initMenuBuilder against the real menu registry with an
 * injected IDW API (FakeIdwApi). Verifies:
 *   - top:idw is registered with order 60 on init.
 *   - The empty-state welcoming item appears when the entry list is
 *     empty AND no per-kind sections render.
 *   - Sections are partitioned by kind in the order specified by
 *     KIND_ORDER, with section-label items + per-entry items.
 *   - Empty sections are omitted entirely (no orphan labels).
 *   - Audio entries are routed to the right sub-category submenu.
 *   - Entries are unregistered when removed.
 *   - The Manage Agents tail item is always present.
 *
 * Section unit tests for `lite/settings/sections/idws.ts` are
 * intentionally NOT included -- per the plan's review fix, sections
 * aren't unit-tested anywhere in lite today; manual smoke + future
 * E2E covers them.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { registry } from '../../menu/registry.js';
import {
  initMenuBuilder,
  teardownMenuBuilder,
  TOP_LEVEL_ID,
  EMPTY_ITEM_ID,
  MANAGE_ID,
} from '../../idw/menu-builder.js';
import type { IdwApi, IdwEntry, AgentKind } from '../../idw/api.js';

interface ChangeListener {
  (entries: IdwEntry[]): void;
}

class FakeIdwApi implements Pick<IdwApi, 'list' | 'onChange'> {
  public entries: IdwEntry[] = [];
  private listeners: ChangeListener[] = [];

  list = vi.fn(async (): Promise<IdwEntry[]> => [...this.entries]);
  listByKind = vi.fn(async (kind: AgentKind): Promise<IdwEntry[]> => this.entries.filter((e) => e.kind === kind));
  get = vi.fn(async (id: string): Promise<IdwEntry | null> => this.entries.find((e) => e.id === id) ?? null);
  add = vi.fn();
  update = vi.fn();
  remove = vi.fn();
  onChange = (handler: (entries: IdwEntry[]) => void): (() => void) => {
    this.listeners.push(handler);
    return (): void => {
      this.listeners = this.listeners.filter((h) => h !== handler);
    };
  };
  onEvent = vi.fn().mockReturnValue(() => undefined);

  setEntries(entries: IdwEntry[]): void {
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

function makeEntry(partial: Partial<IdwEntry> & Pick<IdwEntry, 'id' | 'kind' | 'label'>): IdwEntry {
  return {
    url: `https://${partial.id}.example`,
    source: 'manual',
    createdAt: '2026-05-04T12:00:00.000Z',
    updatedAt: '2026-05-04T12:00:00.000Z',
    ...partial,
  } as IdwEntry;
}

const handlers = {
  onOpenEntry: vi.fn(),
  onOpenSettings: vi.fn(),
};

beforeEach(() => {
  registry._resetForTesting();
  teardownMenuBuilder();
  for (const fn of Object.values(handlers)) (fn as ReturnType<typeof vi.fn>).mockReset();
});

// Wait for the async list() promise inside initMenuBuilder to resolve.
function flushAsync(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('initMenuBuilder', () => {
  it('registers top:idw with order 60 + Manage Agents tail item synchronously', () => {
    const api = new FakeIdwApi();
    initMenuBuilder({ ...handlers, api: api as unknown as IdwApi });

    const top = registry.get(TOP_LEVEL_ID);
    expect(top).toBeDefined();
    expect(top?.type).toBe('top-level');
    expect(top?.label).toBe('IDW');
    expect(top?.order).toBe(60);

    expect(registry.has(MANAGE_ID)).toBe(true);
    expect(registry.get(MANAGE_ID)?.label).toBe('Manage Agents...');
    // No "Add Custom Agent" item -- the Settings -> IDWs section
    // already exposes that affordance.
    expect(registry.has('idw:add-custom')).toBe(false);
  });

  it('renders the welcoming empty item when no entries', async () => {
    const api = new FakeIdwApi();
    initMenuBuilder({ ...handlers, api: api as unknown as IdwApi });
    await flushAsync();

    const empty = registry.get(EMPTY_ITEM_ID);
    expect(empty).toBeDefined();
    expect(empty?.label).toContain('Start your journey');
    expect(empty?.enabled).toBe(false);
  });

  it('removes the empty item once any entry exists', async () => {
    const api = new FakeIdwApi();
    initMenuBuilder({ ...handlers, api: api as unknown as IdwApi });
    await flushAsync();
    expect(registry.has(EMPTY_ITEM_ID)).toBe(true);

    api.setEntries([makeEntry({ id: 'sales', kind: 'idw', label: 'Sales' })]);
    expect(registry.has(EMPTY_ITEM_ID)).toBe(false);
    expect(registry.has('idw:idw:sales')).toBe(true);
  });
});

describe('section partitioning', () => {
  it('emits section labels only for non-empty kinds', async () => {
    const api = new FakeIdwApi();
    initMenuBuilder({ ...handlers, api: api as unknown as IdwApi });
    api.setEntries([
      makeEntry({ id: 'a', kind: 'external-bot', label: 'ChatGPT' }),
      makeEntry({ id: 'b', kind: 'image-creator', label: 'DALL-E' }),
    ]);

    expect(registry.has('idw:section:external-bot:label')).toBe(true);
    expect(registry.has('idw:section:image-creator:label')).toBe(true);
    // No IDWs / video / audio / ui-design entries -> no section labels.
    expect(registry.has('idw:section:idw:label')).toBe(false);
    expect(registry.has('idw:section:video-creator:label')).toBe(false);
    expect(registry.has('idw:section:audio-generator:label')).toBe(false);
    expect(registry.has('idw:section:ui-design-tool:label')).toBe(false);
  });

  it('places entries under top:idw with stable per-entry ids', async () => {
    const api = new FakeIdwApi();
    initMenuBuilder({ ...handlers, api: api as unknown as IdwApi });
    api.setEntries([makeEntry({ id: 'sales', kind: 'idw', label: 'Sales' })]);

    const entry = registry.get('idw:idw:sales');
    expect(entry).toBeDefined();
    expect(entry?.parentId).toBe(TOP_LEVEL_ID);
    expect(entry?.label).toBe('Sales');
    expect(entry?.click).toBeTypeOf('function');
  });

  it('routes entry click to onOpenEntry', async () => {
    const api = new FakeIdwApi();
    initMenuBuilder({ ...handlers, api: api as unknown as IdwApi });
    const entry = makeEntry({ id: 'sales', kind: 'idw', label: 'Sales' });
    api.setEntries([entry]);

    const menuEntry = registry.get('idw:idw:sales');
    menuEntry?.click?.();
    expect(handlers.onOpenEntry).toHaveBeenCalledWith(entry);
  });
});

describe('audio sub-categories', () => {
  it('groups audio entries into per-sub-category submenus', async () => {
    const api = new FakeIdwApi();
    initMenuBuilder({ ...handlers, api: api as unknown as IdwApi });
    api.setEntries([
      makeEntry({
        id: 'suno',
        kind: 'audio-generator',
        label: 'Suno',
        audio: { subCategory: 'music' },
      }),
      makeEntry({
        id: 'eleven',
        kind: 'audio-generator',
        label: 'ElevenLabs',
        audio: { subCategory: 'narration' },
      }),
    ]);

    const musicSub = registry.get('idw:section:audio-generator:sub:music');
    const narrationSub = registry.get('idw:section:audio-generator:sub:narration');
    expect(musicSub?.label).toBe('Music');
    expect(narrationSub?.label).toBe('Narration');

    const sunoEntry = registry.get('idw:audio-generator:suno');
    const elevenEntry = registry.get('idw:audio-generator:eleven');
    expect(sunoEntry?.parentId).toBe('idw:section:audio-generator:sub:music');
    expect(elevenEntry?.parentId).toBe('idw:section:audio-generator:sub:narration');
  });

  it('omits empty audio sub-categories', async () => {
    const api = new FakeIdwApi();
    initMenuBuilder({ ...handlers, api: api as unknown as IdwApi });
    api.setEntries([
      makeEntry({
        id: 'suno',
        kind: 'audio-generator',
        label: 'Suno',
        audio: { subCategory: 'music' },
      }),
    ]);
    expect(registry.has('idw:section:audio-generator:sub:music')).toBe(true);
    expect(registry.has('idw:section:audio-generator:sub:effects')).toBe(false);
  });
});

describe('always-present tail items', () => {
  it('Manage Agents routes to onOpenSettings', async () => {
    const api = new FakeIdwApi();
    initMenuBuilder({ ...handlers, api: api as unknown as IdwApi });
    const item = registry.get(MANAGE_ID);
    item?.click?.();
    expect(handlers.onOpenSettings).toHaveBeenCalled();
  });
});

describe('teardown', () => {
  it('unregisters everything', () => {
    const api = new FakeIdwApi();
    initMenuBuilder({ ...handlers, api: api as unknown as IdwApi });
    api.setEntries([makeEntry({ id: 'a', kind: 'idw', label: 'A' })]);
    teardownMenuBuilder();

    expect(registry.has(TOP_LEVEL_ID)).toBe(false);
    expect(registry.has(MANAGE_ID)).toBe(false);
    expect(registry.has(EMPTY_ITEM_ID)).toBe(false);
    expect(registry.has('idw:idw:a')).toBe(false);
  });
});
