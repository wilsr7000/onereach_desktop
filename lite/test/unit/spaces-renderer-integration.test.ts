/**
 * Spaces renderer state-integration tests.
 *
 * These cover behaviours that span the pure builders + the DOM the
 * bundle wires up on load -- specifically the Phase 1f search filter
 * (which toggles `.is-hidden` on rows whose names don't match) and
 * the Phase 1d/1e pulse-dot animation (which toggles `.has-count` on
 * the Uncategorized intake dot when the count is positive).
 *
 * The bundle is imported once, which installs the boot listener; the
 * suite manually builds the HTML scaffold and dispatches a
 * DOMContentLoaded so the renderer wires its handlers.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach } from 'vitest';

interface BridgeStub {
  open: () => Promise<{ ok: true }>;
  listSpaces: () => Promise<unknown>;
  getUncategorizedCount: () => Promise<unknown>;
  items: {
    list: () => Promise<unknown>;
    get: () => Promise<unknown>;
  };
  runDiscovery: () => Promise<unknown>;
}

function installNoopBridge(): BridgeStub {
  const bridge: BridgeStub = {
    open: async () => ({ ok: true }),
    listSpaces: async () => ({ ok: true, value: [] }),
    getUncategorizedCount: async () => ({ ok: true, value: 0 }),
    items: {
      list: async () => ({ ok: true, value: [] }),
      get: async () => ({ ok: true, value: null }),
    },
    runDiscovery: async () => ({
      ok: true,
      value: {
        startedAt: '',
        finishedAt: '',
        anyFailures: false,
        gatingFailures: false,
        results: [],
      },
    }),
  };
  (window as unknown as { lite?: { spaces: BridgeStub } }).lite = { spaces: bridge };
  return bridge;
}

function buildScaffold(): void {
  document.body.innerHTML = `
    <nav id="spaces-sidebar" class="spaces-sidebar">
      <div class="spaces-sidebar-search">
        <input
          type="search"
          id="spaces-sidebar-search-input"
          class="spaces-sidebar-search-input"
        />
      </div>
      <div class="spaces-sidebar-section">
        <ul class="spaces-list" id="spaces-list-intake">
          <li class="spaces-row spaces-row-intake" data-scope-id="__uncategorized__">
            <span class="spaces-row-dot spaces-row-dot-intake"></span>
            <span class="spaces-row-name">Uncategorized</span>
            <span class="spaces-row-count" data-count-target="uncategorized">—</span>
          </li>
        </ul>
      </div>
      <div class="spaces-sidebar-section">
        <ul class="spaces-list" id="spaces-list-spaces"></ul>
      </div>
    </nav>
    <main class="spaces-main" id="spaces-main">
      <section id="spaces-items-region" class="spaces-items-region"></section>
    </main>
    <aside class="spaces-detail" id="spaces-detail" hidden></aside>
  `;
}

interface RendererTestHandle {
  reinitForTesting(): Promise<void>;
}

async function bootRenderer(): Promise<void> {
  // Importing the bundle is a one-shot side effect: the IIFE wires
  // event listeners + fires init() on first load. Subsequent tests
  // rebuild the scaffold + bridge and call the test-only
  // `reinitForTesting()` hook to drive a fresh boot against the new
  // DOM / bridge.
  await import('../../spaces/spaces.js');
  const handle = (window as unknown as {
    __spacesRendererForTesting?: RendererTestHandle;
  }).__spacesRendererForTesting;
  if (handle === undefined) {
    throw new Error('renderer escape hatch missing');
  }
  await handle.reinitForTesting();
}

function setSpacesInList(spaces: Array<{ id: string; name: string }>): void {
  const list = document.getElementById('spaces-list-spaces');
  if (list === null) throw new Error('list element missing');
  list.replaceChildren();
  for (const sp of spaces) {
    const li = document.createElement('li');
    li.className = 'spaces-row';
    li.setAttribute('data-scope-id', sp.id);
    const name = document.createElement('span');
    name.className = 'spaces-row-name';
    name.textContent = sp.name;
    li.appendChild(name);
    list.appendChild(li);
  }
}

function fireInput(input: HTMLInputElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

beforeEach(() => {
  document.body.innerHTML = '';
  delete (window as unknown as { lite?: unknown }).lite;
});

describe('Sidebar search filter (Phase 1f)', () => {
  it('hides non-matching rows and keeps Uncategorized when query matches', async () => {
    buildScaffold();
    installNoopBridge();
    await bootRenderer();
    // Inject a few Space rows AFTER the renderer's initial async load
    // settled (which left the list empty thanks to the noop bridge).
    setSpacesInList([
      { id: 'sp-1', name: 'Engineering' },
      { id: 'sp-2', name: 'Sales' },
      { id: 'sp-3', name: 'Q3 Planning' },
    ]);
    const input = document.getElementById(
      'spaces-sidebar-search-input'
    ) as HTMLInputElement;
    fireInput(input, 'plan');
    const rows = Array.from(
      document.querySelectorAll<HTMLElement>('#spaces-list-spaces .spaces-row')
    );
    expect(rows.find((r) => r.getAttribute('data-scope-id') === 'sp-3')
      ?.classList.contains('is-hidden')).toBe(false);
    expect(rows.find((r) => r.getAttribute('data-scope-id') === 'sp-1')
      ?.classList.contains('is-hidden')).toBe(true);
    expect(rows.find((r) => r.getAttribute('data-scope-id') === 'sp-2')
      ?.classList.contains('is-hidden')).toBe(true);
    // Uncategorized hides because "plan" doesn't match it.
    const intake = document.querySelector<HTMLElement>(
      '.spaces-row[data-scope-id="__uncategorized__"]'
    );
    expect(intake?.classList.contains('is-hidden')).toBe(true);
  });

  it('keeps Uncategorized visible when the query is "uncat"', async () => {
    buildScaffold();
    installNoopBridge();
    await bootRenderer();
    setSpacesInList([{ id: 'sp-1', name: 'Engineering' }]);
    const input = document.getElementById(
      'spaces-sidebar-search-input'
    ) as HTMLInputElement;
    fireInput(input, 'uncat');
    const intake = document.querySelector<HTMLElement>(
      '.spaces-row[data-scope-id="__uncategorized__"]'
    );
    expect(intake?.classList.contains('is-hidden')).toBe(false);
    const eng = document.querySelector<HTMLElement>(
      '.spaces-row[data-scope-id="sp-1"]'
    );
    expect(eng?.classList.contains('is-hidden')).toBe(true);
  });

  it('clearing the query restores every row', async () => {
    buildScaffold();
    installNoopBridge();
    await bootRenderer();
    setSpacesInList([
      { id: 'sp-1', name: 'Engineering' },
      { id: 'sp-2', name: 'Sales' },
    ]);
    const input = document.getElementById(
      'spaces-sidebar-search-input'
    ) as HTMLInputElement;
    fireInput(input, 'eng');
    expect(
      document
        .querySelector<HTMLElement>('.spaces-row[data-scope-id="sp-2"]')
        ?.classList.contains('is-hidden')
    ).toBe(true);
    fireInput(input, '');
    expect(
      document
        .querySelector<HTMLElement>('.spaces-row[data-scope-id="sp-2"]')
        ?.classList.contains('is-hidden')
    ).toBe(false);
    expect(
      document
        .querySelector<HTMLElement>('.spaces-row[data-scope-id="__uncategorized__"]')
        ?.classList.contains('is-hidden')
    ).toBe(false);
  });
});

describe('Uncategorized pulse dot (Phase 1d/1e)', () => {
  it('adds has-count when getUncategorizedCount returns > 0', async () => {
    buildScaffold();
    (window as unknown as { lite?: { spaces: BridgeStub } }).lite = {
      spaces: {
        open: async () => ({ ok: true }),
        listSpaces: async () => ({ ok: true, value: [] }),
        getUncategorizedCount: async () => ({ ok: true, value: 7 }),
        items: {
          list: async () => ({ ok: true, value: [] }),
          get: async () => ({ ok: true, value: null }),
        },
        runDiscovery: async () => ({
          ok: true,
          value: {
            startedAt: '',
            finishedAt: '',
            anyFailures: false,
            gatingFailures: false,
            results: [],
          },
        }),
      },
    };
    await bootRenderer();
    const dot = document.querySelector<HTMLElement>(
      '.spaces-row-intake .spaces-row-dot-intake'
    );
    expect(dot?.classList.contains('has-count')).toBe(true);
    const countEl = document.querySelector('[data-count-target="uncategorized"]');
    expect(countEl?.textContent).toBe('7');
  });

  it('does NOT add has-count when count is zero', async () => {
    buildScaffold();
    installNoopBridge();
    await bootRenderer();
    const dot = document.querySelector<HTMLElement>(
      '.spaces-row-intake .spaces-row-dot-intake'
    );
    expect(dot?.classList.contains('has-count')).toBe(false);
    const countEl = document.querySelector('[data-count-target="uncategorized"]');
    expect(countEl?.textContent).toBe('0');
  });

  it('leaves the dash placeholder when the count call fails', async () => {
    buildScaffold();
    (window as unknown as { lite?: { spaces: BridgeStub } }).lite = {
      spaces: {
        open: async () => ({ ok: true }),
        listSpaces: async () => ({ ok: true, value: [] }),
        getUncategorizedCount: async () => ({
          ok: false,
          error: { code: 'SPACES_NETWORK', message: 'boom' },
        }),
        items: {
          list: async () => ({ ok: true, value: [] }),
          get: async () => ({ ok: true, value: null }),
        },
        runDiscovery: async () => ({
          ok: true,
          value: {
            startedAt: '',
            finishedAt: '',
            anyFailures: false,
            gatingFailures: false,
            results: [],
          },
        }),
      },
    };
    await bootRenderer();
    const dot = document.querySelector<HTMLElement>(
      '.spaces-row-intake .spaces-row-dot-intake'
    );
    expect(dot?.classList.contains('has-count')).toBe(false);
    const countEl = document.querySelector('[data-count-target="uncategorized"]');
    expect(countEl?.textContent).toBe('—');
  });
});

// ─── VS Code-style sidebar (WISER parity, 2026-08-07) ──────────────────
//
// The explorer mechanics: every Space row carries an expand chevron,
// toggling it inserts/removes the item-tree holder as the row's
// sibling, and tree rows tag items with a kind glyph. The full fetch
// path is exercised live; these pin the DOM contract a re-render must
// preserve. Default flipped 2026-08-08: trees are OPEN by default
// (collapsedSpaceTrees records explicit folds), so a fresh id's first
// toggle COLLAPSES and the second re-expands.

describe('sidebar explorer trees', () => {
  it('buildSpaceRow renders the expand chevron ahead of the dot', async () => {
    const mod = await import('../../spaces/spaces.js');
    const row = mod.buildSpaceRow(
      { id: 'sp-t', name: 'Tree Space', itemCount: 2 } as never,
      false
    );
    const expand = row.querySelector('.spaces-row-expand');
    expect(expand, 'chevron button missing').not.toBeNull();
    expect(row.firstElementChild).toBe(expand);
  });

  it('toggleSpaceTree folds an open-by-default tree, then re-expands it', async () => {
    const mod = await import('../../spaces/spaces.js');
    document.body.innerHTML = '<ul><li id="row-a" class="spaces-row spaces-row-space is-expanded"></li></ul>';
    const row = document.getElementById('row-a');
    if (row === null) throw new Error('fixture row missing');

    // Fresh id = open by default → first toggle collapses.
    mod.toggleSpaceTree('sp-tree-1', row);
    expect(row.nextElementSibling).toBeNull();
    expect(row.classList.contains('is-expanded')).toBe(false);

    // Second toggle re-expands and inserts the holder.
    mod.toggleSpaceTree('sp-tree-1', row);
    const holder = row.nextElementSibling;
    expect(holder?.classList.contains('spaces-tree-children-holder')).toBe(true);
    expect(row.classList.contains('is-expanded')).toBe(true);
  });

  it('space trees render OPEN by default on the sidebar paint', async () => {
    // "why are assets in spaces loading only when clicked?" — the
    // renderer must append the children holder for every space the
    // user has NOT explicitly folded.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('node:fs') as typeof import('node:fs');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require('node:path') as typeof import('node:path');
    const found = ['spaces/spaces.ts', 'lite/spaces/spaces.ts']
      .map((r) => path.resolve(r))
      .find((f) => fs.existsSync(f));
    const src = fs.readFileSync(found as string, 'utf8');
    expect(src).toMatch(/if \(!collapsedSpaceTrees\.has\(space\.id\)\) \{\s*\n\s*list\.appendChild\(buildSpaceChildren\(space\.id\)\);/);
  });

  it('itemKindGlyph maps known kinds and falls back for unknown ones', async () => {
    const mod = await import('../../spaces/spaces.js');
    expect(mod.itemKindGlyph('ticket')).toBe('◫');
    expect(mod.itemKindGlyph('agent')).toBe('✦');
    expect(mod.itemKindGlyph('never-heard-of-it')).toBe('▪');
  });
});
