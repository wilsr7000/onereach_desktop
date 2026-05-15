/**
 * Spaces Home view — end-to-end renderer flow.
 *
 * Drives the renderer bundle against an in-memory bridge stub and
 * asserts the timeline-first Home renders against the DOM. Tests
 * the production code path (renderHome through the unified-timeline
 * orchestrator) without booting Electron or hitting live Neon.
 *
 * The 6 SDK methods are stubbed at the bridge layer; the renderer's
 * expectations against the stable bridge contract (LiteSpacesHomeBridge)
 * are pinned here without coupling to any Cypher detail.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach } from 'vitest';

interface BridgeEnvelopeOk<T> {
  ok: true;
  value: T;
}
interface BridgeEnvelopeErr {
  ok: false;
  error: { code: string; message: string };
}
type Envelope<T> = BridgeEnvelopeOk<T> | BridgeEnvelopeErr;

interface HomeBridgeStub {
  entityCounts: () => Promise<Envelope<unknown>>;
  recentItems: () => Promise<Envelope<unknown[]>>;
  topContributors: () => Promise<Envelope<unknown[]>>;
  recentEvents: () => Promise<Envelope<unknown[]>>;
  agentsSample: () => Promise<Envelope<unknown[]>>;
  permissionSummary: () => Promise<Envelope<unknown>>;
}

interface BridgeStub {
  open: () => Promise<{ ok: true }>;
  listSpaces: () => Promise<Envelope<unknown[]>>;
  getUncategorizedCount: () => Promise<Envelope<number>>;
  items: {
    list: () => Promise<Envelope<unknown[]>>;
    get: () => Promise<Envelope<unknown>>;
    resolveFileUrl: () => Promise<Envelope<string | null>>;
  };
  runDiscovery: () => Promise<Envelope<unknown>>;
  home: HomeBridgeStub;
}

interface RendererTestHandle {
  reinitForTesting(): Promise<void>;
}

function ok<T>(value: T): Envelope<T> {
  return { ok: true, value };
}

function err(code: string, message: string): Envelope<never> {
  return { ok: false, error: { code, message } };
}

function buildScaffold(): void {
  document.body.innerHTML = `
    <nav id="spaces-sidebar" class="spaces-sidebar">
      <div class="spaces-sidebar-section">
        <ul class="spaces-list" id="spaces-list-home">
          <li class="spaces-row spaces-row-home is-active" data-scope-id="__home__">
            <span class="spaces-row-name">Home</span>
          </li>
        </ul>
      </div>
      <div class="spaces-sidebar-search">
        <input type="search" id="spaces-sidebar-search-input" />
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
      <section id="spaces-home-region" class="spaces-home-region"></section>
      <section id="spaces-items-region" class="spaces-items-region" hidden></section>
    </main>
    <aside class="spaces-detail" id="spaces-detail" hidden></aside>
  `;
}

function installBridge(home: Partial<HomeBridgeStub>): BridgeStub {
  const noopHome: HomeBridgeStub = {
    entityCounts: async () => ok({ spaces: 0, assets: 0, people: 0, agents: 0 }),
    recentItems: async () => ok([]),
    topContributors: async () => ok([]),
    recentEvents: async () => ok([]),
    agentsSample: async () => ok([]),
    permissionSummary: async () => ok({ visibleSpaceCount: 0 }),
  };
  const bridge: BridgeStub = {
    open: async () => ({ ok: true }),
    listSpaces: async () => ok([]),
    getUncategorizedCount: async () => ok(0),
    items: {
      list: async () => ok([]),
      get: async () => ok(null),
      resolveFileUrl: async () => ok(null),
    },
    runDiscovery: async () =>
      ok({
        startedAt: '',
        finishedAt: '',
        anyFailures: false,
        gatingFailures: false,
        results: [],
      }),
    home: { ...noopHome, ...home },
  };
  (window as unknown as { lite?: { spaces: BridgeStub } }).lite = { spaces: bridge };
  return bridge;
}

async function bootRenderer(): Promise<void> {
  await import('../../../spaces/spaces.js');
  const handle = (window as unknown as {
    __spacesRendererForTesting?: RendererTestHandle;
  }).__spacesRendererForTesting;
  if (handle === undefined) {
    throw new Error('renderer escape hatch missing');
  }
  await handle.reinitForTesting();
  // Allow the parallel home-load promises to flush.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  document.body.innerHTML = '';
  delete (window as unknown as { lite?: unknown }).lite;
  // Clear localStorage so the welcome card and last-visit hairline
  // behave the same across tests (fresh-install baseline).
  try {
    localStorage.clear();
  } catch {
    /* noop in jsdom */
  }
});

// ─── Populated timeline ─────────────────────────────────────────────────

describe('Home view — populated timeline', () => {
  it('renders item + event rows merged chronologically', async () => {
    buildScaffold();
    installBridge({
      recentEvents: async () =>
        ok([
          {
            id: 'c-1',
            author: 'robb',
            kind: 'item:added',
            timestamp: '2026-05-11T10:00:00Z',
            spaceId: 'sp-1',
            spaceName: 'Finance',
          },
        ]),
      recentItems: async () =>
        ok([
          {
            id: 'a-1',
            title: 'Concept of Spaces for AI Agents',
            kind: 'text',
            createdAt: '2026-05-12T20:05:00Z',
            updatedAt: '2026-05-12T20:05:00Z',
            otherSpaces: [{ id: 'sp-2', name: 'ChatGPT Conversations' }],
            producedBy: null,
            excerpt: 'A note on co-production.',
          },
        ]),
    });
    await bootRenderer();

    const rows = document.querySelectorAll<HTMLElement>('.home-timeline-row');
    expect(rows.length).toBe(2);
    // Item is newer (2026-05-12 > 2026-05-11), should be first
    expect(rows[0]?.querySelector('.home-timeline-object')?.textContent).toBe(
      'Concept of Spaces for AI Agents'
    );
    // Item carries an excerpt
    expect(rows[0]?.querySelector('.home-timeline-excerpt')?.textContent).toBe(
      'A note on co-production.'
    );
    // Event row has the derived verb + object
    expect(rows[1]?.querySelector('.home-timeline-verb')?.textContent?.trim()).toBe(
      'added'
    );
    expect(rows[1]?.querySelector('.home-timeline-object')?.textContent).toBe(
      'an item'
    );
  });

  it('flags agent-authored rows with is-agent class', async () => {
    buildScaffold();
    installBridge({
      recentItems: async () =>
        ok([
          {
            id: 'a-1',
            title: 'Audit_2026Q1.docx',
            kind: 'document',
            createdAt: '2026-05-12T00:00:00Z',
            updatedAt: '2026-05-12T00:00:00Z',
            otherSpaces: [],
            producedBy: { kind: 'Agent', name: 'Audit Agent', id: 'ag-1' },
          },
        ]),
    });
    await bootRenderer();
    const row = document.querySelector<HTMLElement>('.home-timeline-row');
    expect(row?.classList.contains('is-agent')).toBe(true);
  });

  it('renders the end-of-feed tail cue when nothing is filtered out', async () => {
    buildScaffold();
    const items = Array.from({ length: 6 }, (_, i) => ({
      id: `a-${i}`,
      title: `Item ${i}`,
      kind: 'document',
      createdAt: `2026-05-${10 + i}T00:00:00Z`,
      updatedAt: `2026-05-${10 + i}T00:00:00Z`,
      otherSpaces: [],
      producedBy: null,
    }));
    installBridge({ recentItems: async () => ok(items) });
    await bootRenderer();
    expect(document.querySelector('.home-timeline-tail')?.textContent).toBe(
      'You are all caught up.'
    );
  });
});

// ─── Empty + error states ───────────────────────────────────────────────

describe('Home view — empty + error states', () => {
  it('renders a friendly empty state when both queries return zero rows', async () => {
    buildScaffold();
    installBridge({});
    await bootRenderer();
    const empty = document.querySelector('.home-timeline-empty');
    expect(empty?.textContent ?? '').toMatch(/Nothing has happened/i);
  });

  it('renders a filter-specific empty state when a chip filters everything out', async () => {
    buildScaffold();
    installBridge({
      recentItems: async () =>
        ok([
          {
            id: 'a-1',
            title: 'old item',
            kind: 'document',
            createdAt: '2024-01-01T00:00:00Z',
            updatedAt: '2024-01-01T00:00:00Z',
            otherSpaces: [],
            producedBy: null,
          },
        ]),
    });
    await bootRenderer();
    // Switch to "24h" — the only row is from 2024 so the filter should empty out
    const chip = document.querySelector<HTMLButtonElement>(
      '.home-filter-chip[data-filter="24h"]'
    );
    expect(chip).not.toBeNull();
    chip?.click();
    const empty = document.querySelector('.home-timeline-empty');
    expect(empty?.textContent ?? '').toMatch(/24 hours/i);
  });

  it('renders the card-level error when both event + item queries fail', async () => {
    buildScaffold();
    installBridge({
      recentEvents: async () => err('SPACES_NETWORK', 'connection refused'),
      recentItems: async () => err('SPACES_NETWORK', 'connection refused'),
    });
    await bootRenderer();
    expect(
      document.querySelector('.home-timeline .home-card-error')?.textContent ?? ''
    ).toContain('connection refused');
  });
});

// ─── Welcome card + hairline ────────────────────────────────────────────

describe('Home view — welcome + hairline', () => {
  it('renders the welcome card on first visit (no localStorage flag)', async () => {
    buildScaffold();
    installBridge({});
    await bootRenderer();
    expect(document.querySelector('.home-welcome')).not.toBeNull();
  });

  it('hides the welcome card when previously dismissed', async () => {
    try {
      localStorage.setItem('lite-spaces-home.welcome-seen', '1');
    } catch {
      // jsdom should support it; fall through if not.
    }
    buildScaffold();
    installBridge({});
    await bootRenderer();
    expect(document.querySelector('.home-welcome')).toBeNull();
  });

  it('"Got it" click writes the dismissed flag and removes the card', async () => {
    buildScaffold();
    installBridge({});
    await bootRenderer();
    const btn = document.querySelector<HTMLButtonElement>('.home-welcome-dismiss');
    expect(btn).not.toBeNull();
    btn?.click();
    expect(document.querySelector('.home-welcome')).toBeNull();
    expect(localStorage.getItem('lite-spaces-home.welcome-seen')).toBe('1');
  });

  it('renders the since-last-visit hairline when a prior visit is recorded', async () => {
    // 25 hours ago counts as "yesterday".
    const lastVisit = Date.now() - 25 * 60 * 60_000;
    try {
      localStorage.setItem('lite-spaces-home.last-visit', String(lastVisit));
    } catch {
      /* noop */
    }
    buildScaffold();
    installBridge({});
    await bootRenderer();
    const hairline = document.querySelector('.home-hairline');
    expect(hairline).not.toBeNull();
    expect(hairline?.textContent ?? '').toMatch(/Welcome back/i);
  });
});

// ─── Filter chips ───────────────────────────────────────────────────────

describe('Home view — filter chips', () => {
  it('renders all five chips with the default active=all', async () => {
    buildScaffold();
    installBridge({});
    await bootRenderer();
    const chips = document.querySelectorAll<HTMLElement>('.home-filter-chip');
    expect(chips).toHaveLength(5);
    const active = document.querySelector<HTMLElement>('.home-filter-chip.is-active');
    expect(active?.getAttribute('data-filter')).toBe('all');
  });

  it('toggles active state on click + re-renders the timeline', async () => {
    buildScaffold();
    installBridge({
      recentItems: async () =>
        ok([
          {
            id: 'a-1',
            title: 'fresh',
            kind: 'document',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            otherSpaces: [],
            producedBy: { kind: 'Agent', name: 'Bot', id: 'b-1' },
          },
        ]),
    });
    await bootRenderer();
    const peopleChip = document.querySelector<HTMLButtonElement>(
      '.home-filter-chip[data-filter="people"]'
    );
    peopleChip?.click();
    // renderHome() rebuilds the chip row, so re-query for the new node.
    const refreshedActive = document.querySelector<HTMLElement>(
      '.home-filter-chip.is-active'
    );
    expect(refreshedActive?.getAttribute('data-filter')).toBe('people');
    // The agent-authored row should disappear under People filter
    expect(document.querySelectorAll('.home-timeline-row').length).toBe(0);
  });
});

// ─── Context column ─────────────────────────────────────────────────────

describe('Home view — context column', () => {
  it('renders Active-this-week, About-this-view, Agents-peek sections', async () => {
    buildScaffold();
    installBridge({
      entityCounts: async () =>
        ok({ spaces: 4, assets: 9, people: 3, agents: 159 }),
      topContributors: async () =>
        ok([
          {
            author: 'Audit Agent',
            displayName: 'Audit Agent',
            events: 47,
            lastEventAt: String(Date.now() - 5 * 60 * 1000),
          },
        ]),
      agentsSample: async () =>
        ok([{ id: 'ag-1', name: 'Audit Agent', description: 'Quarterly' }]),
      permissionSummary: async () => ok({ visibleSpaceCount: 4 }),
    });
    await bootRenderer();
    const sections = document.querySelectorAll<HTMLElement>('.home-context-section');
    expect(sections.length).toBe(3);
    const titles = Array.from(sections).map(
      (s) => s.querySelector('.home-context-title')?.textContent
    );
    expect(titles).toEqual([
      'Active this week',
      'About this view',
      'Agents in your account',
    ]);
  });

  it('shows the contributor name + count in the Active list', async () => {
    buildScaffold();
    installBridge({
      topContributors: async () =>
        ok([
          {
            author: 'Audit Agent',
            displayName: 'Audit Agent',
            events: 47,
            lastEventAt: String(Date.now() - 5 * 60 * 1000),
          },
        ]),
    });
    await bootRenderer();
    const firstSection = document.querySelector<HTMLElement>('.home-context-section');
    expect(firstSection?.querySelector('.home-context-row-name')?.textContent).toBe(
      'Audit Agent'
    );
    expect(firstSection?.querySelector('.home-context-row-count')?.textContent).toBe(
      '47'
    );
  });

  it('shows the ACL note in About-this-view', async () => {
    buildScaffold();
    installBridge({ permissionSummary: async () => ok({ visibleSpaceCount: 4 }) });
    await bootRenderer();
    const sections = document.querySelectorAll<HTMLElement>('.home-context-section');
    const aboutSection = sections[1];
    expect(aboutSection?.querySelector('.home-context-text')?.textContent ?? '').toContain(
      'You can see all 4 Spaces'
    );
  });
});

// ─── Region toggling ───────────────────────────────────────────────────

describe('Home view — region toggling', () => {
  it('home region is visible at boot and items region is hidden', async () => {
    buildScaffold();
    installBridge({});
    await bootRenderer();
    const homeRegion = document.getElementById('spaces-home-region');
    const itemsRegion = document.getElementById('spaces-items-region');
    expect(homeRegion?.hidden).toBe(false);
    expect(itemsRegion?.hidden).toBe(true);
  });
});
