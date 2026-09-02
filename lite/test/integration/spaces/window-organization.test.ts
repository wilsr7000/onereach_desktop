/**
 * Spaces window organization (2026-09-01 UX pass) — pinned against the
 * REAL spaces.html markup with the renderer booted on top of it.
 *
 * The rules this pins:
 *   - one command bar owns search, refresh and creation (a split button
 *     whose caret opens the other kinds); nothing of that is repeated
 *     in the sidebar, which is navigation only;
 *   - the Recent tier never repeats a pinned Space and stays hidden
 *     until the list is long enough to need a shortcut;
 *   - the Space header is identity → orientation → activity, with the
 *     actions on the title row;
 *   - the assets toolbar is ONE row (search + scope + Ask AI, chips).
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

interface Envelope<T> {
  ok: true;
  value: T;
}
const ok = <T,>(value: T): Envelope<T> => ({ ok: true, value });

interface StubSpace {
  id: string;
  name: string;
  pinned?: boolean;
  lastActivity?: string;
  kind?: 'user' | 'shared';
}

function realMarkup(): string {
  const html = readFileSync(resolve(__dirname, '../../../spaces/spaces.html'), 'utf-8');
  const body = html.slice(html.indexOf('<body>') + '<body>'.length, html.lastIndexOf('</body>'));
  return body.replace(/<script[^>]*><\/script>/g, '');
}

function makeSpaces(count: number, pinnedIds: string[] = []): StubSpace[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `sp-${i + 1}`,
    name: `Space ${i + 1}`,
    pinned: pinnedIds.includes(`sp-${i + 1}`),
    lastActivity: new Date(Date.now() - i * 60_000).toISOString(),
    kind: 'user',
  }));
}

function installBridge(spaces: StubSpace[]): void {
  const noop = async (): Promise<Envelope<unknown[]>> => ok([]);
  (window as unknown as { lite?: unknown }).lite = {
    spaces: {
      open: async () => ({ ok: true }),
      listSpaces: async () => ok(spaces),
      getUncategorizedCount: async () => ok(0),
      onCacheUpdate: () => () => undefined,
      items: { list: noop, get: async () => ok(null), resolveFileUrl: async () => ok(null) },
      runDiscovery: async () =>
        ok({ startedAt: '', finishedAt: '', anyFailures: false, gatingFailures: false, results: [] }),
      home: {
        entityCounts: async () => ok({ spaces: spaces.length, assets: 0, people: 0, agents: 0 }),
        recentItems: noop,
        topContributors: noop,
        recentEvents: noop,
        agentsSample: noop,
        permissionSummary: async () => ok({ visibleSpaceCount: spaces.length }),
      },
      members: { list: noop },
      presence: { inSpace: noop, scope: async () => ok(null) },
    },
  };
}

async function boot(spaces: StubSpace[]): Promise<void> {
  document.body.innerHTML = realMarkup();
  installBridge(spaces);
  await import('../../../spaces/spaces.js');
  const handle = (window as unknown as {
    __spacesRendererForTesting?: { reinitForTesting(): Promise<void> };
  }).__spacesRendererForTesting;
  if (handle === undefined) throw new Error('renderer escape hatch missing');
  await handle.reinitForTesting();
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

beforeEach(() => {
  document.body.innerHTML = '';
  delete (window as unknown as { lite?: unknown }).lite;
  window.localStorage.clear();
});

describe('command bar', () => {
  it('owns the one search box, refresh, and the New Space split button', async () => {
    await boot(makeSpaces(4));
    const header = document.querySelector('.spaces-header');
    expect(header).not.toBeNull();
    expect(header?.querySelector('#spaces-sidebar-search-input')).not.toBeNull();
    expect(header?.querySelector('#spaces-sidebar-search-ai')).not.toBeNull();
    expect(header?.querySelector('#spaces-refresh-button')).not.toBeNull();
    expect(header?.querySelector('#spaces-new-button')).not.toBeNull();
    expect(header?.querySelector('#spaces-new-shared-button')).not.toBeNull();
    // Only ONE search box in the window (the Home header adds none).
    expect(document.querySelectorAll('input[type="search"]')).toHaveLength(1);
    // The beta badge is gone.
    expect(document.querySelector('.spaces-phase-badge')).toBeNull();
  });

  it('the sidebar is navigation only — no brand row, action rows, or search section', async () => {
    await boot(makeSpaces(4));
    const sidebar = document.getElementById('spaces-sidebar');
    expect(sidebar?.querySelector('.spaces-sidebar-toolbar')).toBeNull();
    expect(sidebar?.querySelector('.spaces-sidebar-actions')).toBeNull();
    expect(sidebar?.querySelector('[data-side-section="search"]')).toBeNull();
    expect(sidebar?.querySelector('#spaces-sidebar-search-input')).toBeNull();
    // Collapse-all lives in the Spaces section header now.
    expect(
      sidebar?.querySelector('[data-side-section="spaces"] #spaces-sidebar-collapse-all')
    ).not.toBeNull();
  });

  it('the caret opens the other kinds; Escape and outside clicks close it', async () => {
    await boot(makeSpaces(4));
    const toggle = document.getElementById('spaces-new-menu-toggle') as HTMLButtonElement;
    const menu = document.getElementById('spaces-new-menu') as HTMLElement;
    expect(menu.hidden).toBe(true);
    toggle.click();
    expect(menu.hidden).toBe(false);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(menu.hidden).toBe(true);
    toggle.click();
    expect(menu.hidden).toBe(false);
    document.body.click();
    expect(menu.hidden).toBe(true);
  });
});

describe('sidebar tiers', () => {
  it('Recent hides itself while the full list is a glance away', async () => {
    await boot(makeSpaces(4, ['sp-1']));
    const recent = document.querySelector<HTMLElement>('[data-side-section="recent"]');
    expect(recent?.hidden).toBe(true);
    expect(document.querySelectorAll('#spaces-list-pinned .spaces-row')).toHaveLength(1);
    expect(document.querySelectorAll('#spaces-list-spaces .spaces-row')).toHaveLength(4);
  });

  it('with a long list Recent appears, capped, and never repeats a pinned Space', async () => {
    await boot(makeSpaces(12, ['sp-1', 'sp-2']));
    const recent = document.querySelector<HTMLElement>('[data-side-section="recent"]');
    expect(recent?.hidden).toBe(false);
    const ids = Array.from(
      document.querySelectorAll<HTMLElement>('#spaces-list-recent .spaces-row')
    ).map((r) => r.getAttribute('data-scope-id'));
    expect(ids).toHaveLength(5);
    expect(ids).not.toContain('sp-1');
    expect(ids).not.toContain('sp-2');
    expect(ids[0]).toBe('sp-3');
  });
});

describe('Space page header + toolbar', () => {
  it('is identity → orientation → activity, with the actions on the title row', async () => {
    await boot(makeSpaces(4));
    document.querySelector<HTMLElement>('#spaces-list-spaces [data-scope-id="sp-1"]')?.click();
    for (let i = 0; i < 8; i++) await Promise.resolve();
    const header = document.querySelector('.spaces-view-header');
    expect(header).not.toBeNull();
    const rows = Array.from(header?.children ?? []).map((el) => el.className.split(' ')[0]);
    expect(rows).toEqual([
      'spaces-view-header-top',
      'spaces-view-header-meta',
      'spaces-view-header-activity',
    ]);
    const top = header?.querySelector('.spaces-view-header-top');
    expect(top?.querySelector('.spaces-view-header-title')?.textContent).toBe('Space 1');
    expect(top?.querySelector('.spaces-view-header-actions .spaces-items-new')).not.toBeNull();
    expect(top?.querySelector('.spaces-view-header-actions .spaces-items-refresh')).not.toBeNull();
    const meta = header?.querySelector('.spaces-view-header-meta');
    expect(meta?.querySelector('.spaces-visibility-toggle')).not.toBeNull();
    expect(meta?.querySelector('.spaces-view-header-members')).not.toBeNull();
    expect(meta?.querySelector('#spaces-presence-strip')).not.toBeNull();
  });

  it('the assets toolbar is ONE row: search + scope + Ask AI, then the chips', async () => {
    await boot(makeSpaces(4));
    document.querySelector<HTMLElement>('#spaces-list-spaces [data-scope-id="sp-1"]')?.click();
    for (let i = 0; i < 8; i++) await Promise.resolve();
    const row = document.querySelector('.spaces-items-toolbar-row');
    expect(row).not.toBeNull();
    expect(row?.querySelector('#spaces-items-search-input')).not.toBeNull();
    expect(row?.querySelector('.spaces-items-search-scope')).not.toBeNull();
    expect(row?.querySelector('.spaces-items-search-ask-ai')).not.toBeNull();
    expect(row?.querySelector('.home-filter-chips')).not.toBeNull();
    // The chips row is not repeated anywhere else in the items region
    // (Home keeps its own row in its own, hidden, region).
    expect(document.querySelectorAll('#spaces-items-region .home-filter-chips')).toHaveLength(1);
  });
});
