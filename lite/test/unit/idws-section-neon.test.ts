/**
 * Settings → IDWs: the "Connected in NEON" card (2026-09-04). The local
 * list stays what it was; NEON's IDWs become installable rows (marked
 * Installed when the menu already has that URL) and the agent catalog
 * shows its totals with a door to the Agent Registry.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mountIdws, neonAgentSourceLabel } from '../../settings/sections/idws.js';

const tick = async (): Promise<void> => {
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
};

function install(initialEntries: LiteIdwEntry[]) {
  const add = vi.fn(async () => ({ entry: {} as unknown as LiteIdwEntry, wasUpdate: false }));
  const openWindow = vi.fn(async () => ({ ok: true, value: { ok: true as const } }));
  const idw = {
    list: vi.fn(async () => [...initialEntries]),
    listByKind: vi.fn(async () => []),
    get: vi.fn(async () => null),
    add,
    update: vi.fn(async () => ({} as unknown as LiteIdwEntry)),
    remove: vi.fn(async () => ({ ok: true as const })),
    openStore: vi.fn(async () => ({ ok: true as const })),
    open: vi.fn(async () => ({ ok: true as const })),
    exportMemory: vi.fn(async () => ({ ok: false, provider: 'ChatGPT', reason: 'stub' })),
    onChange: () => () => undefined,
    parseError: () => null,
  } as unknown as LiteIdwBridge;
  const registry = {
    listIdws: async () => ({ ok: true, value: [
      { id: 'idw_a', name: 'Marvin 2', description: 'Company IDW', status: 'active', url: 'https://idw.example/marvin' },
      { id: 'idw_b', name: 'My AI', description: 'Demo IDW', status: 'active', url: 'https://idw.example/myai' },
    ] }),
    search: async (input: { source?: string; limit?: number }) =>
      input.source === 'GSX-Desktop'
        ? { ok: true, value: { items: [{ id: 'orchestrator-agent', name: 'Orchestrator', description: 'Coordinates agents', type: 'simple', category: 'meta', enabled: true, deleted: false, source: 'GSX-Desktop', owner: 'robb', updatedMs: 1, listing: 'unlisted', builtin: true, isSystem: false, reach: ['mcp'], idwCount: 0, knowledgeCount: 0 }], total: 35, offset: 0, limit: 8, facets: { sources: [], types: [], categories: [] } } }
        : { ok: true, value: { items: [], total: 12079, offset: 0, limit: 1, facets: { sources: [{ value: 'Playbooks', count: 12044 }, { value: 'GSX-Desktop', count: 35 }], types: [], categories: [] } } },
    openWindow,
  };
  (window as unknown as { lite: unknown }).lite = { idw, registry };
  return { add, openWindow };
}

describe('Connected in NEON card', () => {
  let container: HTMLElement;
  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });
  afterEach(() => {
    container.remove();
  });

  it('lists NEON IDWs as installable rows, marks the one already in the menu, and shows the catalog totals', async () => {
    const { add, openWindow } = install([
      { id: 'e1', kind: 'idw', label: 'My AI', url: 'https://idw.example/myai', source: 'store', updatedAt: new Date().toISOString() } as unknown as LiteIdwEntry,
    ]);
    mountIdws(container);
    await tick();
    const card = container.querySelector('#idw-neon-card') as HTMLElement;
    expect(card).not.toBeNull();
    expect(card.querySelector('#idw-neon-summary')?.textContent).toContain('12,079 agents registered in NEON');
    expect(card.querySelector('#idw-neon-summary')?.textContent).toContain('35 library');
    const rows = Array.from(card.querySelectorAll('[data-neon-idw]'));
    expect(rows).toHaveLength(2);
    expect(rows[1]?.textContent).toContain('Installed');
    const addBtn = card.querySelector('[data-action="neon-install"]') as HTMLButtonElement;
    expect(addBtn.getAttribute('data-url')).toBe('https://idw.example/marvin');
    addBtn.click();
    await tick();
    expect(add).toHaveBeenCalledWith(expect.objectContaining({ kind: 'idw', label: 'Marvin 2', url: 'https://idw.example/marvin', source: 'store' }));
    expect(card.querySelector('[data-neon-agent="orchestrator-agent"]')?.textContent).toContain('MCP');
    (card.querySelector('#idw-open-registry') as HTMLButtonElement).click();
    expect(openWindow).toHaveBeenCalled();
  });

  it('renders the card even when the local menu is empty', async () => {
    install([]);
    mountIdws(container);
    await tick();
    expect(container.querySelector('#idw-neon-card')).not.toBeNull();
    expect(neonAgentSourceLabel('GSX-Desktop')).toBe('library');
    expect(neonAgentSourceLabel('Playbooks')).toBe('from Playbooks');
  });
});
