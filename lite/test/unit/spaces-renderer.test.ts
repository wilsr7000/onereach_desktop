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

describe('buildItemCard', () => {
  it('renders title, kind label, and time', () => {
    const card = handle().buildItemCard(baseItem({ title: 'A spec doc' }), false);
    expect(card.querySelector('.spaces-card-title')?.textContent).toBe('A spec doc');
    expect(card.querySelector('.spaces-card-kind')?.textContent).toBe('Doc');
    expect(card.querySelector('.spaces-card-time')?.textContent).toMatch(/just now|m ago/);
  });

  it('renders the excerpt when present', () => {
    const card = handle().buildItemCard(
      baseItem({ excerpt: 'a short excerpt' }),
      false
    );
    expect(card.querySelector('.spaces-card-excerpt')?.textContent).toBe(
      'a short excerpt'
    );
  });

  it('omits the excerpt block when missing', () => {
    const card = handle().buildItemCard(baseItem(), false);
    expect(card.querySelector('.spaces-card-excerpt')).toBeNull();
  });

  it('renders one chip per otherSpaces entry', () => {
    const card = handle().buildItemCard(
      baseItem({
        otherSpaces: [
          { id: 'sp-2', name: 'Sales' },
          { id: 'sp-3', name: 'Marketing' },
          { id: 'sp-4', name: 'Ops' },
        ],
      }),
      false
    );
    const chips = Array.from(card.querySelectorAll('.spaces-chip'));
    expect(chips).toHaveLength(3);
    expect(chips.map((c) => c.querySelector('.spaces-chip-name')?.textContent)).toEqual([
      'Sales',
      'Marketing',
      'Ops',
    ]);
  });

  it('renders the provenance line when producedBy is set', () => {
    const card = handle().buildItemCard(
      baseItem({
        producedBy: { kind: 'Agent', name: 'Quarterly Audit Agent', id: 'ag-1' },
      }),
      false
    );
    expect(card.querySelector('.spaces-card-provenance')?.textContent).toBe(
      'Produced by Quarterly Audit Agent (Agent)'
    );
  });

  it('skips the provenance line when producedBy is null', () => {
    const card = handle().buildItemCard(baseItem(), false);
    expect(card.querySelector('.spaces-card-provenance')).toBeNull();
  });

  it('tags the kind label with a kind-specific class', () => {
    const card = handle().buildItemCard(baseItem({ kind: 'image' }), false);
    expect(card.querySelector('.spaces-card-kind-image')).not.toBeNull();
  });

  it('marks the card active when active=true', () => {
    const card = handle().buildItemCard(baseItem(), true);
    expect(card.classList.contains('is-active')).toBe(true);
  });

  it('renders "(untitled)" when title is empty', () => {
    const card = handle().buildItemCard(baseItem({ title: '' }), false);
    expect(card.querySelector('.spaces-card-title')?.textContent).toBe('(untitled)');
  });

  it('exposes the item id via data-item-id for click delegation', () => {
    const card = handle().buildItemCard(baseItem({ id: 'i-42' }), false);
    expect(card.getAttribute('data-item-id')).toBe('i-42');
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

  it('falls back to "(unnamed)" when the chip name is empty', () => {
    const chip = handle().buildSpaceChip({ id: 'sp-1', name: '' });
    expect(chip.querySelector('.spaces-chip-name')?.textContent).toBe('(unnamed)');
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

  it('renders content in a <pre> when present', () => {
    const pane = handle().buildDetailPane(
      baseDetailItem({ content: 'full text body' }),
      () => undefined
    );
    expect(pane.querySelector('.spaces-detail-content pre')?.textContent).toBe(
      'full text body'
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

  it('renders provenance when producedBy is set', () => {
    const pane = handle().buildDetailPane(
      baseDetailItem({
        producedBy: { kind: 'Person', name: 'Robb', id: 'p-1' },
      }),
      () => undefined
    );
    expect(pane.querySelector('.spaces-detail-provenance')?.textContent).toBe(
      'Produced by Robb (Person)'
    );
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

  it('renders a download link for non-image binary kinds', () => {
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
      expect(link?.textContent).toBe('Download');
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

  it('labels audio / video / other clearly in the binary-link header', () => {
    const make = (kind: TestItem['kind']): TestItem => ({
      id: 'i',
      title: 't',
      kind,
      createdAt: '',
      updatedAt: '',
      otherSpaces: [],
      producedBy: null,
    });
    expect(
      handle()
        .buildBinaryPreview(make('audio'), 'https://x')
        .querySelector('.spaces-detail-label')?.textContent
    ).toBe('Audio file');
    expect(
      handle()
        .buildBinaryPreview(make('video'), 'https://x')
        .querySelector('.spaces-detail-label')?.textContent
    ).toBe('Video file');
    expect(
      handle()
        .buildBinaryPreview(make('document'), 'https://x')
        .querySelector('.spaces-detail-label')?.textContent
    ).toBe('File');
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
