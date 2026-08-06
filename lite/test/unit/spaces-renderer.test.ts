/**
 * Spaces renderer unit tests.
 *
 * The renderer is the IIFE bundle that runs inside the Spaces
 * window. Its public-ish surface consists of the pure DOM-builder
 * functions (`buildSpaceRow`, `buildItemCard`, `buildSpaceChip`,
 * `buildDetailPane`) plus the format helpers. These tests exercise
 * the builders directly under jsdom so we lock down:
 *   - sidebar row markup (dot, name, count, active class)
 *   - item card markup (kind pill, title, excerpt, chips, provenance)
 *   - chip markup (dot, name, color override)
 *   - detail pane (title, chips, content, source link, close button)
 *   - relative-time + count formatting edge cases
 *
 * The state-machine glue (fetch envelopes, error banners, scope
 * switching) is left to E2E because it requires the full preload
 * bridge.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach } from 'vitest';

// Importing the renderer for its side effects installs the test
// escape hatch on `window.__spacesRendererForTesting`. We bring it in
// once per test file, and the helpers are read off the same global so
// they reflect the bundle's actual exports.
import '../../spaces/spaces.js';

interface RendererTestHandle {
  buildSpaceRow(space: TestSpace, active: boolean): HTMLLIElement;
  buildItemCard(item: TestItemSummary, active: boolean): HTMLElement;
  buildSpaceChip(chip: TestChip): HTMLElement;
  buildDetailPane(item: TestItem, onClose: () => void): HTMLElement;
  buildBinaryPreview(item: TestItem, url: string): HTMLElement;
  buildItemsToolbar(opts: { busy: boolean }): HTMLElement;
  formatCount(n: number): string;
  formatRelativeTime(iso: string): string;
  normalizeSearchQuery(q: string): string;
  matchesSearchQuery(name: string, query: string): boolean;
  sortSpaces(
    spaces: ReadonlyArray<TestSpace & { updatedAt?: string; createdAt?: string }>,
    mode: 'name' | 'recent'
  ): Array<TestSpace & { updatedAt?: string; createdAt?: string }>;
}

interface TestSpace {
  id: string;
  name: string;
  description?: string;
  color?: string;
  iconKey?: string;
  itemCount?: number;
  kind?: 'user' | 'shared';
}

interface TestChip {
  id: string;
  name: string;
  color?: string;
  iconKey?: string;
}

interface TestProvenance {
  kind: string;
  name: string;
  id: string;
}

interface TestItemSummary {
  id: string;
  title: string;
  kind: string;
  createdAt: string;
  updatedAt: string;
  excerpt?: string;
  sourceUrl?: string;
  fileKey?: string;
  otherSpaces: TestChip[];
  producedBy: TestProvenance | null;
}

interface TestItem extends TestItemSummary {
  content?: string;
  metadata?: Record<string, unknown>;
}

function handle(): RendererTestHandle {
  const w = window as unknown as {
    __spacesRendererForTesting?: RendererTestHandle;
  };
  if (w.__spacesRendererForTesting === undefined) {
    throw new Error('renderer test handle missing — did the bundle import fail?');
  }
  return w.__spacesRendererForTesting;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

// ─── Sidebar rows ────────────────────────────────────────────────────────

describe('buildSpaceRow', () => {
  it('renders id, name, and count for a typical Space', () => {
    const row = handle().buildSpaceRow(
      { id: 'sp-1', name: 'Engineering', itemCount: 12 },
      false
    );
    expect(row.tagName).toBe('LI');
    expect(row.getAttribute('data-scope-id')).toBe('sp-1');
    expect(row.querySelector('.spaces-row-name')?.textContent).toBe('Engineering');
    expect(row.querySelector('.spaces-row-count')?.textContent).toBe('12');
    expect(row.classList.contains('is-active')).toBe(false);
  });

  it('adds is-active when active=true', () => {
    const row = handle().buildSpaceRow(
      { id: 'sp-1', name: 'Engineering' },
      true
    );
    expect(row.classList.contains('is-active')).toBe(true);
  });

  it('applies a custom color to the dot when provided', () => {
    const row = handle().buildSpaceRow(
      { id: 'sp-1', name: 'Eng', color: '#abcdef' },
      false
    );
    const dot = row.querySelector<HTMLElement>('.spaces-row-dot');
    expect(dot?.style.background).toBe('rgb(171, 205, 239)');
  });

  it('falls back to "(unnamed)" when the name is empty', () => {
    const row = handle().buildSpaceRow({ id: 'sp-1', name: '' }, false);
    expect(row.querySelector('.spaces-row-name')?.textContent).toBe('(unnamed)');
  });

  it('omits the count when itemCount is undefined', () => {
    const row = handle().buildSpaceRow({ id: 'sp-1', name: 'X' }, false);
    expect(row.querySelector('.spaces-row-count')?.textContent).toBe('');
  });

  it('is keyboard-focusable (role=button + tabindex=0)', () => {
    const row = handle().buildSpaceRow({ id: 'sp-1', name: 'X' }, false);
    expect(row.getAttribute('role')).toBe('button');
    expect(row.getAttribute('tabindex')).toBe('0');
  });

  it('flags shared spaces with .is-shared + a kind badge (Phase 4)', () => {
    const row = handle().buildSpaceRow(
      { id: 'sp-shared', name: 'Quarterly Audit', kind: 'shared' },
      false
    );
    expect(row.classList.contains('is-shared')).toBe(true);
    const badge = row.querySelector('.spaces-row-kind-badge');
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toBe('AI');
    expect(badge?.getAttribute('aria-label')).toMatch(/AI-managed/i);
  });

  it('user spaces have no shared-flag class or badge', () => {
    const row = handle().buildSpaceRow(
      { id: 'sp-1', name: 'Engineering', kind: 'user' },
      false
    );
    expect(row.classList.contains('is-shared')).toBe(false);
    expect(row.querySelector('.spaces-row-kind-badge')).toBeNull();
  });

  it('treats spaces without a kind field as user-managed (additive)', () => {
    const row = handle().buildSpaceRow({ id: 'sp-1', name: 'X' }, false);
    expect(row.classList.contains('is-shared')).toBe(false);
    expect(row.querySelector('.spaces-row-kind-badge')).toBeNull();
  });
});

// ─── Item cards ──────────────────────────────────────────────────────────

function baseItem(overrides: Partial<TestItemSummary> = {}): TestItemSummary {
  return {
    id: 'i-1',
    title: 'My Item',
    kind: 'document',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: new Date().toISOString(),
    otherSpaces: [],
    producedBy: null,
    ...overrides,
  };
}

describe('buildItemCard (content-forward asset tile)', () => {
  it('renders title, kind label, and time', () => {
    const card = handle().buildItemCard(baseItem({ title: 'A spec doc' }), false);
    expect(card.querySelector('.spaces-card-title')?.textContent).toBe('A spec doc');
    expect(card.querySelector('.spaces-card-kind')?.textContent).toBe('Doc');
    expect(card.querySelector('.spaces-card-time')?.textContent).toMatch(/just now|m ago/);
  });

  it('wraps every tile with a content-shaped preview surface', () => {
    const card = handle().buildItemCard(baseItem(), false);
    const preview = card.querySelector('.spaces-card-preview');
    expect(preview).not.toBeNull();
    // Decorative: the title carries the accessible label, so the
    // preview should be hidden from assistive tech.
    expect(preview?.getAttribute('aria-hidden')).toBe('true');
  });

  it('tags the preview with a kind-specific modifier class', () => {
    const card = handle().buildItemCard(baseItem({ kind: 'image' }), false);
    expect(card.querySelector('.spaces-card-preview-image')).not.toBeNull();
    // Outer card also gets a top-level kind modifier so per-kind hover
    // styling can scope cleanly.
    expect(card.classList.contains('spaces-card-image')).toBe(true);
    expect(card.classList.contains('spaces-card-document')).toBe(false);
  });

  it('renders the doc excerpt as the preview body for text/document kinds', () => {
    const card = handle().buildItemCard(
      baseItem({ excerpt: 'a short excerpt' }),
      false
    );
    // The excerpt now lives inside the preview surface (paper-style
    // tile), not as a separate body block beneath the title.
    const preview = card.querySelector('.spaces-card-preview');
    expect(preview?.querySelector('.spaces-card-excerpt')?.textContent).toBe(
      'a short excerpt'
    );
  });

  it('falls back to a doc glyph when a text tile has no excerpt', () => {
    const card = handle().buildItemCard(baseItem(), false);
    // No excerpt block, but the preview surface still has SOMETHING so
    // the tile reads as "a document," not an empty rectangle.
    expect(card.querySelector('.spaces-card-excerpt')).toBeNull();
    expect(card.querySelector('.spaces-card-glyph-doc')).not.toBeNull();
  });

  it('never prints a base64 data-URL excerpt (legacy inline stubs)', () => {
    const card = handle().buildItemCard(
      baseItem({ excerpt: 'data:image/png;base64,iVBORw0KGgo=' }),
      false
    );
    expect(card.querySelector('.spaces-card-excerpt')).toBeNull();
    expect(card.querySelector('.spaces-card-glyph-doc')).not.toBeNull();
  });

  it('treats whitespace-only excerpts as missing', () => {
    const card = handle().buildItemCard(baseItem({ excerpt: '   \n  ' }), false);
    expect(card.querySelector('.spaces-card-excerpt')).toBeNull();
    expect(card.querySelector('.spaces-card-glyph-doc')).not.toBeNull();
  });

  it('renders an audio waveform + play glyph for audio assets', () => {
    const card = handle().buildItemCard(baseItem({ kind: 'audio' }), false);
    expect(card.querySelector('.spaces-card-preview-audio')).not.toBeNull();
    expect(card.querySelectorAll('.spaces-card-wave-bar').length).toBeGreaterThan(0);
    expect(card.querySelector('.spaces-card-play')).not.toBeNull();
  });

  it('renders a distinct agent tile (violet surface + glyph + OKF snippet)', () => {
    const card = handle().buildItemCard(
      baseItem({ kind: 'agent', excerpt: 'name: Support Bot' }),
      false
    );
    expect(card.querySelector('.spaces-card-preview-agent')).not.toBeNull();
    expect(card.classList.contains('spaces-card-agent')).toBe(true);
    expect(card.querySelector('.spaces-card-glyph-agent')).not.toBeNull();
    expect(card.querySelector('.spaces-card-agent-okf')?.textContent).toBe('name: Support Bot');
    expect(card.querySelector('.spaces-card-kind')?.textContent).toBe('Agent');
  });

  it('renders a large play glyph for video assets', () => {
    const card = handle().buildItemCard(baseItem({ kind: 'video' }), false);
    expect(card.querySelector('.spaces-card-preview-video')).not.toBeNull();
    expect(card.querySelector('.spaces-card-play-large')).not.toBeNull();
  });

  it('renders the URL host on the preview surface for url assets', () => {
    const card = handle().buildItemCard(
      baseItem({ kind: 'url', sourceUrl: 'https://www.example.com/article' }),
      false
    );
    expect(card.querySelector('.spaces-card-url-host')?.textContent).toBe('example.com');
  });

  it('renders ruled lines for playbook assets', () => {
    const card = handle().buildItemCard(baseItem({ kind: 'playbook' }), false);
    expect(card.querySelector('.spaces-card-preview-playbook')).not.toBeNull();
    expect(card.querySelectorAll('.spaces-card-playbook-line').length).toBe(4);
  });

  it('renders a hash tag + excerpt for ticket assets', () => {
    const card = handle().buildItemCard(
      baseItem({ kind: 'ticket', excerpt: 'auth bug in login flow' }),
      false
    );
    expect(card.querySelector('.spaces-card-preview-ticket')).not.toBeNull();
    expect(card.querySelector('.spaces-card-ticket-tag')?.textContent).toBe('#');
    expect(card.querySelector('.spaces-card-excerpt')?.textContent).toBe(
      'auth bug in login flow'
    );
  });

  it('shows a hover-reveal pencil hint next to the title', () => {
    const card = handle().buildItemCard(baseItem(), false);
    // The pencil is a visual hint that the asset is editable (click to
    // open detail pane with inline rename). Aria-hidden so it doesn't
    // interfere with the accessible title.
    const hint = card.querySelector('.spaces-card-edit-hint');
    expect(hint).not.toBeNull();
    expect(hint?.getAttribute('aria-hidden')).toBe('true');
    expect(hint?.textContent).toBe('✎');
  });

  it('drops the Slack-message "Produced by …" line from the tile', () => {
    // The user feedback was explicit: assets shouldn't read as chat
    // rows. The provenance line is no longer rendered on the tile —
    // attribution lives in the detail pane.
    const card = handle().buildItemCard(
      baseItem({
        producedBy: { kind: 'Agent', name: 'Quarterly Audit Agent', id: 'ag-1' },
      }),
      false
    );
    expect(card.querySelector('.spaces-card-provenance')).toBeNull();
  });

  it('drops space chips from the tile (they live in the detail pane)', () => {
    const card = handle().buildItemCard(
      baseItem({
        otherSpaces: [
          { id: 'sp-2', name: 'Sales' },
          { id: 'sp-3', name: 'Marketing' },
        ],
      }),
      false
    );
    expect(card.querySelector('.spaces-card-chips')).toBeNull();
    expect(card.querySelectorAll('.spaces-chip').length).toBe(0);
  });

  it('tags the kind label with a kind-specific class', () => {
    const card = handle().buildItemCard(baseItem({ kind: 'image' }), false);
    expect(card.querySelector('.spaces-card-kind-image')).not.toBeNull();
  });

  it('marks the card active when active=true', () => {
    const card = handle().buildItemCard(baseItem(), true);
    expect(card.classList.contains('is-active')).toBe(true);
  });

  it('generates a "<Kind> · <short-id>" title when the raw title is empty', () => {
    // Updated alongside the calm-spaces pass: an empty title no longer
    // renders the placeholder "(untitled)" -- buildItemCard now calls
    // generateItemTitle(item), which derives a real label from the
    // item's kind + a short prefix of its id.
    const card = handle().buildItemCard(baseItem({ title: '' }), false);
    const rendered = card.querySelector('.spaces-card-title')?.textContent ?? '';
    // Format: "<Kind label> · <short id>"; for `baseItem`'s default
    // kind / id this resolves to "Doc · i1".
    expect(rendered.startsWith('Doc · ')).toBe(true);
    expect(rendered).not.toBe('(untitled)');
  });

  it('exposes the item id via data-item-id for click delegation', () => {
    const card = handle().buildItemCard(baseItem({ id: 'i-42' }), false);
    expect(card.getAttribute('data-item-id')).toBe('i-42');
  });

  it('is an interactive, focusable button with an accessible label', () => {
    // The tile wires its own click → detail pane (there is no grid-level
    // delegation), so it must carry the button role, be keyboard-
    // focusable, and expose the title as its accessible name.
    const card = handle().buildItemCard(baseItem({ title: 'Q3 roadmap' }), false);
    expect(card.getAttribute('role')).toBe('button');
    expect(card.getAttribute('tabindex')).toBe('0');
    expect(card.getAttribute('aria-label')).toBe('Q3 roadmap');
  });

  it('a plain click does not throw without a bridge (detail load is best-effort)', () => {
    const card = handle().buildItemCard(baseItem(), false);
    // No window.lite bridge in this isolated test — loadItemDetail must
    // degrade gracefully rather than throw out of the click handler.
    expect(() => card.dispatchEvent(new MouseEvent('click', { bubbles: true }))).not.toThrow();
  });

  // ── Badges ──────────────────────────────────────────────────────────

  it('shows an AI badge + agent attribution for agent-produced assets', () => {
    const card = handle().buildItemCard(
      baseItem({ producedBy: { kind: 'Agent', name: 'Audit Agent', id: 'ag-1' } }),
      false
    );
    const badge = card.querySelector('.spaces-card-badge-agent');
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toMatch(/AI/);
    // The badge lives in the aria-hidden preview, so the meaning is
    // folded into the card's accessible name instead.
    expect(card.getAttribute('aria-label')).toMatch(/produced by Audit Agent/i);
  });

  it('shows no AI badge for person-produced or unattributed assets', () => {
    expect(
      handle()
        .buildItemCard(baseItem({ producedBy: { kind: 'Person', name: 'Robb', id: 'p-1' } }), false)
        .querySelector('.spaces-card-badge-agent')
    ).toBeNull();
    expect(
      handle().buildItemCard(baseItem({ producedBy: null }), false).querySelector(
        '.spaces-card-badge-agent'
      )
    ).toBeNull();
  });

  it('shows a multi-space indicator (count + names) when cross-filed', () => {
    const card = handle().buildItemCard(
      baseItem({
        otherSpaces: [
          { id: 'sp-2', name: 'Sales' },
          { id: 'sp-3', name: 'Marketing' },
        ],
      }),
      false
    );
    const ind = card.querySelector('.spaces-card-spaces');
    expect(ind?.textContent).toBe('⧉ 2');
    expect(ind?.getAttribute('title')).toContain('Sales');
    expect(ind?.getAttribute('title')).toContain('Marketing');
  });

  it('omits the multi-space indicator when the asset is not cross-filed', () => {
    const card = handle().buildItemCard(baseItem({ otherSpaces: [] }), false);
    expect(card.querySelector('.spaces-card-spaces')).toBeNull();
  });

  it('shows no "New" badge on a fresh profile with no last-visit baseline', () => {
    // jsdom has no persisted last-visit time, so lastVisitMs is null and
    // nothing should read as "new" (otherwise everything would).
    const card = handle().buildItemCard(
      baseItem({ updatedAt: new Date().toISOString() }),
      false
    );
    expect(card.querySelector('.spaces-card-badge-new')).toBeNull();
  });
});


// ─── Chips ───────────────────────────────────────────────────────────────

describe('buildSpaceChip', () => {
  it('renders the name and a dot', () => {
    const chip = handle().buildSpaceChip({ id: 'sp-1', name: 'Engineering' });
    expect(chip.querySelector('.spaces-chip-name')?.textContent).toBe('Engineering');
    expect(chip.querySelector('.spaces-chip-dot')).not.toBeNull();
  });

  it('applies a custom color to the dot when provided', () => {
    const chip = handle().buildSpaceChip({
      id: 'sp-1',
      name: 'X',
      color: '#112233',
    });
    const dot = chip.querySelector<HTMLElement>('.spaces-chip-dot');
    expect(dot?.style.background).toBe('rgb(17, 34, 51)');
  });

  it('falls back to "Unnamed space" when the chip name is empty', () => {
    // Updated alongside the spaces "calm noise" pass: friendlySpaceName
    // returns "Unnamed space" for empty AND hash-shaped names so chips
    // never render a 32-char hex string in place of a human label.
    const chip = handle().buildSpaceChip({ id: 'sp-1', name: '' });
    expect(chip.querySelector('.spaces-chip-name')?.textContent).toBe('Unnamed space');
  });

  it('falls back to "Unnamed space" when the chip name is hash-shaped', () => {
    const chip = handle().buildSpaceChip({
      id: 'sp-1',
      name: '402abae35ea49651576deadbeefcafe11',
    });
    expect(chip.querySelector('.spaces-chip-name')?.textContent).toBe('Unnamed space');
  });

  it('tags the chip with its id for click delegation', () => {
    const chip = handle().buildSpaceChip({ id: 'sp-77', name: 'X' });
    expect(chip.getAttribute('data-chip-id')).toBe('sp-77');
  });
});

// ─── Detail pane ─────────────────────────────────────────────────────────

function baseDetailItem(overrides: Partial<TestItem> = {}): TestItem {
  return {
    id: 'i-1',
    title: 'My Detail Item',
    kind: 'text',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: new Date().toISOString(),
    otherSpaces: [],
    producedBy: null,
    ...overrides,
  };
}

describe('buildDetailPane', () => {
  it('renders the title, kind, and updated meta line', () => {
    const pane = handle().buildDetailPane(
      baseDetailItem({ title: 'A doc', kind: 'document' }),
      () => undefined
    );
    expect(pane.querySelector('.spaces-detail-title')?.textContent).toBe('A doc');
    expect(pane.querySelector('.spaces-card-kind')?.textContent).toBe('Doc');
    expect(pane.querySelector('.spaces-detail-meta')?.textContent).toMatch(
      /Updated/
    );
  });

  it('renders chips for otherSpaces', () => {
    const pane = handle().buildDetailPane(
      baseDetailItem({
        otherSpaces: [
          { id: 'sp-2', name: 'Sales' },
          { id: 'sp-3', name: 'Marketing' },
        ],
      }),
      () => undefined
    );
    expect(pane.querySelectorAll('.spaces-detail-chips .spaces-chip')).toHaveLength(2);
  });

  it('renders content via the Markdown block when present', () => {
    // Phase A3 swapped raw <pre> for a Markdown-rendered body with
    // a "rendered / source" toggle. Plain text without Markdown
    // syntax projects into a single <p> inside `.spaces-markdown`.
    const pane = handle().buildDetailPane(
      baseDetailItem({ content: 'full text body' }),
      () => undefined
    );
    expect(pane.querySelector('.spaces-detail-content-block')).not.toBeNull();
    expect(pane.querySelector('.spaces-markdown p')?.textContent).toBe(
      'full text body'
    );
    // Toggle row is wired with both buttons; default mode is Rendered.
    expect(pane.querySelector('.spaces-detail-toggle-btn.is-active')?.getAttribute('data-mode')).toBe(
      'rendered'
    );
  });

  it('skips content when missing', () => {
    const pane = handle().buildDetailPane(baseDetailItem(), () => undefined);
    expect(pane.querySelector('.spaces-detail-content')).toBeNull();
  });

  it('renders a source link with safe rel + target attrs', () => {
    const pane = handle().buildDetailPane(
      baseDetailItem({ sourceUrl: 'https://example.com/article' }),
      () => undefined
    );
    const link = pane.querySelector<HTMLAnchorElement>('.spaces-detail-source a');
    expect(link?.href).toBe('https://example.com/article');
    expect(link?.target).toBe('_blank');
    expect(link?.rel).toBe('noopener noreferrer');
  });

  it('shows the producer once, in the attribution chip (not duplicated in the meta strip)', () => {
    // Pre-redesign the pane printed the producer twice — once in the
    // attribution chip ("Created by Robb") and again in the meta strip
    // ("Produced by Robb (Person)"). That stacked who/when text read
    // heavy, so the chip now suppresses the meta provenance sub-line.
    const pane = handle().buildDetailPane(
      baseDetailItem({
        producedBy: { kind: 'Person', name: 'Robb', id: 'p-1' },
      }),
      () => undefined
    );
    expect(pane.querySelector('.spaces-detail-attribution-chip')?.textContent).toContain(
      'Robb'
    );
    expect(pane.querySelector('.spaces-detail-meta .spaces-detail-provenance')).toBeNull();
    const occurrences = (pane.textContent ?? '').match(/Robb/g) ?? [];
    expect(occurrences.length).toBe(1);
  });

  it('wires the close button to the onClose callback', () => {
    let closed = false;
    const pane = handle().buildDetailPane(baseDetailItem(), () => {
      closed = true;
    });
    const closeBtn = pane.querySelector<HTMLButtonElement>('.spaces-detail-close');
    expect(closeBtn).not.toBeNull();
    closeBtn?.click();
    expect(closed).toBe(true);
  });
});

// ─── Format helpers ──────────────────────────────────────────────────────

describe('formatCount', () => {
  it('returns plain integer for small counts', () => {
    expect(handle().formatCount(0)).toBe('0');
    expect(handle().formatCount(42)).toBe('42');
    expect(handle().formatCount(999)).toBe('999');
  });

  it('returns 1.5k-style for thousands', () => {
    expect(handle().formatCount(1000)).toBe('1.0k');
    expect(handle().formatCount(1500)).toBe('1.5k');
    expect(handle().formatCount(9999)).toBe('10.0k');
  });

  it('returns floored Xk for tens of thousands', () => {
    expect(handle().formatCount(12_345)).toBe('12k');
    expect(handle().formatCount(100_000)).toBe('100k');
  });

  it('returns empty string for negative or non-finite values', () => {
    expect(handle().formatCount(-1)).toBe('');
    expect(handle().formatCount(NaN)).toBe('');
    expect(handle().formatCount(Infinity)).toBe('');
  });
});

describe('normalizeSearchQuery', () => {
  it('lower-cases + trims whitespace', () => {
    expect(handle().normalizeSearchQuery('  HELLO  ')).toBe('hello');
  });

  it('returns "" for empty / whitespace-only input', () => {
    expect(handle().normalizeSearchQuery('')).toBe('');
    expect(handle().normalizeSearchQuery('   ')).toBe('');
  });

  it('handles unicode-ish input without crashing', () => {
    expect(handle().normalizeSearchQuery('Café Engineering')).toBe(
      'café engineering'
    );
  });
});

describe('matchesSearchQuery', () => {
  it('matches case-insensitively', () => {
    expect(handle().matchesSearchQuery('Engineering', 'eng')).toBe(true);
    expect(handle().matchesSearchQuery('engineering', 'ENG')).toBe(true);
  });

  it('matches anywhere in the name (substring)', () => {
    expect(handle().matchesSearchQuery('Q3 Planning', 'plan')).toBe(true);
    expect(handle().matchesSearchQuery('Audit Workspace', 'space')).toBe(true);
  });

  it('returns true for empty query (filter is off)', () => {
    expect(handle().matchesSearchQuery('anything', '')).toBe(true);
    expect(handle().matchesSearchQuery('anything', '   ')).toBe(true);
  });

  it('returns false when no overlap', () => {
    expect(handle().matchesSearchQuery('Engineering', 'sales')).toBe(false);
  });

  it('matches the Uncategorized intake row when query is "uncat"', () => {
    expect(handle().matchesSearchQuery('Uncategorized', 'uncat')).toBe(true);
  });
});

describe('buildBinaryPreview', () => {
  it('renders an <img> for kind=image', () => {
    const item: TestItem = {
      id: 'i-1',
      title: 'A photo',
      kind: 'image',
      createdAt: '',
      updatedAt: '',
      otherSpaces: [],
      producedBy: null,
      fileKey: 'images/foo.png',
    };
    const preview = handle().buildBinaryPreview(item, 'https://signed.example.com/foo.png');
    const img = preview.querySelector<HTMLImageElement>('img.spaces-detail-image');
    expect(img).not.toBeNull();
    expect(img?.src).toBe('https://signed.example.com/foo.png');
    expect(img?.alt).toBe('A photo');
    expect(img?.loading).toBe('lazy');
  });

  it('falls back to "Item preview" alt when title is empty', () => {
    const item: TestItem = {
      id: 'i-1',
      title: '',
      kind: 'image',
      createdAt: '',
      updatedAt: '',
      otherSpaces: [],
      producedBy: null,
    };
    const preview = handle().buildBinaryPreview(item, 'https://x/y.png');
    expect(preview.querySelector<HTMLImageElement>('img')?.alt).toBe('Item preview');
  });

  it('renders a download link alongside every preview (Sprint 2)', () => {
    for (const kind of ['document', 'audio', 'video', 'other'] as const) {
      const item: TestItem = {
        id: 'i-1',
        title: 'File',
        kind,
        createdAt: '',
        updatedAt: '',
        otherSpaces: [],
        producedBy: null,
      };
      const preview = handle().buildBinaryPreview(item, 'https://x/y');
      const link = preview.querySelector<HTMLAnchorElement>('a.spaces-detail-download');
      expect(link).not.toBeNull();
      expect(link?.target).toBe('_blank');
      expect(link?.rel).toBe('noopener noreferrer');
    }
  });

  it('tags the wrapper with the kind so tests + CSS can branch', () => {
    const item: TestItem = {
      id: 'i-1',
      title: 'F',
      kind: 'video',
      createdAt: '',
      updatedAt: '',
      otherSpaces: [],
      producedBy: null,
    };
    const preview = handle().buildBinaryPreview(item, 'https://x/y');
    expect(preview.getAttribute('data-kind')).toBe('video');
  });

  it('audio kind embeds an <audio controls> player (Sprint 2)', () => {
    const item: TestItem = {
      id: 'i', title: 't', kind: 'audio',
      createdAt: '', updatedAt: '', otherSpaces: [], producedBy: null,
    };
    const audio = handle()
      .buildBinaryPreview(item, 'https://x')
      .querySelector<HTMLAudioElement>('audio.spaces-detail-audio');
    expect(audio).not.toBeNull();
    expect(audio?.controls).toBe(true);
  });

  it('video kind embeds a <video controls> player (Sprint 2)', () => {
    const item: TestItem = {
      id: 'i', title: 't', kind: 'video',
      createdAt: '', updatedAt: '', otherSpaces: [], producedBy: null,
    };
    const video = handle()
      .buildBinaryPreview(item, 'https://x')
      .querySelector<HTMLVideoElement>('video.spaces-detail-video');
    expect(video).not.toBeNull();
    expect(video?.controls).toBe(true);
  });

  it('"other" kind without a recognized MIME falls back to a labeled download row', () => {
    const item: TestItem = {
      id: 'i', title: 't', kind: 'other',
      createdAt: '', updatedAt: '', otherSpaces: [], producedBy: null,
    };
    const preview = handle().buildBinaryPreview(item, 'https://x');
    // No inline player, no PDF embed — just label + download link.
    expect(preview.querySelector('audio')).toBeNull();
    expect(preview.querySelector('video')).toBeNull();
    expect(preview.querySelector('embed')).toBeNull();
    expect(preview.querySelector('a.spaces-detail-download')).not.toBeNull();
    expect(preview.querySelector('.spaces-detail-label')?.textContent).toBe('File');
  });
});

describe('buildItemsToolbar', () => {
  it('renders a refresh button enabled when busy=false', () => {
    const bar = handle().buildItemsToolbar({ busy: false });
    const btn = bar.querySelector<HTMLButtonElement>('button.spaces-items-refresh');
    expect(btn).not.toBeNull();
    expect(btn?.disabled).toBe(false);
    expect(btn?.textContent).toContain('Refresh');
  });

  it('disables and re-labels the refresh button when busy=true', () => {
    const bar = handle().buildItemsToolbar({ busy: true });
    const btn = bar.querySelector<HTMLButtonElement>('button.spaces-items-refresh');
    expect(btn?.disabled).toBe(true);
    expect(btn?.textContent).toBe('Refreshing…');
  });
});

describe('sortSpaces', () => {
  const fixture = [
    { id: 'a', name: 'Engineering', updatedAt: '2026-01-05T00:00:00Z' },
    { id: 'b', name: 'Audit', updatedAt: '2026-01-10T00:00:00Z' },
    { id: 'c', name: 'Sales', updatedAt: '2026-01-01T00:00:00Z' },
  ];

  it('sorts case-insensitively by name when mode=name', () => {
    const out = handle().sortSpaces(fixture, 'name');
    expect(out.map((s) => s.id)).toEqual(['b', 'a', 'c']); // Audit, Engineering, Sales
  });

  it('sorts descending by updatedAt when mode=recent', () => {
    const out = handle().sortSpaces(fixture, 'recent');
    expect(out.map((s) => s.id)).toEqual(['b', 'a', 'c']); // 01-10, 01-05, 01-01
  });

  it('falls back to createdAt when updatedAt is missing', () => {
    const out = handle().sortSpaces(
      [
        { id: 'a', name: 'A', createdAt: '2026-01-10T00:00:00Z' },
        { id: 'b', name: 'B', updatedAt: '2026-01-05T00:00:00Z' },
      ],
      'recent'
    );
    expect(out[0]?.id).toBe('a');
  });

  it('pushes entries with no timestamps to the end in recent mode', () => {
    const out = handle().sortSpaces(
      [
        { id: 'a', name: 'A' }, // no timestamps
        { id: 'b', name: 'B', updatedAt: '2026-01-05T00:00:00Z' },
        { id: 'c', name: 'C', updatedAt: '2026-01-10T00:00:00Z' },
      ],
      'recent'
    );
    expect(out.map((s) => s.id)).toEqual(['c', 'b', 'a']);
  });

  it('does not mutate the input array', () => {
    const before = [...fixture];
    handle().sortSpaces(fixture, 'name');
    expect(fixture).toEqual(before);
  });

  it('returns empty array for empty input regardless of mode', () => {
    expect(handle().sortSpaces([], 'name')).toEqual([]);
    expect(handle().sortSpaces([], 'recent')).toEqual([]);
  });
});

describe('formatRelativeTime', () => {
  it('handles seconds-ago as "just now"', () => {
    const iso = new Date(Date.now() - 5_000).toISOString();
    expect(handle().formatRelativeTime(iso)).toBe('just now');
  });

  it('handles minutes-ago', () => {
    const iso = new Date(Date.now() - 5 * 60_000).toISOString();
    expect(handle().formatRelativeTime(iso)).toBe('5m ago');
  });

  it('handles hours-ago', () => {
    const iso = new Date(Date.now() - 3 * 3_600_000).toISOString();
    expect(handle().formatRelativeTime(iso)).toBe('3h ago');
  });

  it('handles days-ago', () => {
    const iso = new Date(Date.now() - 4 * 86_400_000).toISOString();
    expect(handle().formatRelativeTime(iso)).toBe('4d ago');
  });

  it('falls back to short date for older items', () => {
    const iso = new Date(Date.now() - 60 * 86_400_000).toISOString();
    const out = handle().formatRelativeTime(iso);
    // jsdom locale isn't guaranteed; just assert it's NOT one of the
    // relative-time forms and IS non-empty.
    expect(out).not.toMatch(/just now|m ago|h ago|d ago/);
    expect(out.length).toBeGreaterThan(0);
  });

  it('returns "" for empty / invalid input', () => {
    expect(handle().formatRelativeTime('')).toBe('');
    expect(handle().formatRelativeTime('not-a-date')).toBe('not-a-date');
  });
});
