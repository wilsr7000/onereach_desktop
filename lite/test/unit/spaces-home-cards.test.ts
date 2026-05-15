/**
 * Spaces Home view — pure-builder + pure-helper tests.
 *
 * The Home design is timeline-first: a unified feed of `:Commit`
 * events and recently-added `:Asset` items merged chronologically,
 * with filter chips for slice-and-dice and a small context column
 * on the right. The 5-card dashboard + synthesised sparklines were
 * dropped — see commit history.
 *
 * What this file pins:
 *   - `formatBigNumber` / `formatRecency` boundary cases (kept from
 *     the prior dashboard suite; the helpers survived the refactor)
 *   - `formatSinceLastVisit` rules (null, 5-min suppression, friendly
 *     phrasing)
 *   - `countTimelineSince` arithmetic (new-rows-since-cutoff)
 *   - `mergeTimeline` chronological merge + item-rich-over-event dedup
 *   - `filterTimeline` per-filter behavior (all / people / agents /
 *     24h / 7d)
 *   - `looksLikeAgentAuthor` heuristic
 *   - `buildWelcomeCard` markup + dismiss wiring
 *   - `buildFilterChips` rendering + active state
 *   - `buildTimelineRow` for items, events, agent-authored rows
 *
 * The bundle is imported once per file; pure helpers don't need to
 * reset module state between describes.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeAll } from 'vitest';

type HomeFilter = 'all' | 'people' | 'agents' | '24h' | '7d';

interface TimelineRow {
  kind: 'item' | 'event';
  id: string;
  author: string;
  verb: string;
  object: string;
  space?: { id: string; name: string; color?: string };
  timestamp: string;
  excerpt?: string;
  fromAgent: boolean;
  itemId?: string;
  spaceId?: string;
}

interface RendererTestApi {
  buildWelcomeCard: () => HTMLElement;
  buildFilterChips: (active?: HomeFilter) => HTMLElement;
  buildTimelineRow: (row: TimelineRow) => HTMLElement;
  mergeTimeline: (
    events: ReadonlyArray<{
      id: string;
      author: string;
      kind: string;
      timestamp: string;
      spaceId?: string;
      spaceName?: string;
    }>,
    items: ReadonlyArray<{
      id: string;
      title: string;
      kind: string;
      createdAt: string;
      updatedAt: string;
      excerpt?: string;
      otherSpaces: Array<{ id: string; name: string }>;
      producedBy: { kind: string; name: string; id: string } | null;
    }>
  ) => TimelineRow[];
  filterTimeline: (
    rows: ReadonlyArray<TimelineRow>,
    filter: HomeFilter,
    nowMs: number
  ) => TimelineRow[];
  formatSinceLastVisit: (lastVisitMs: number | null, nowMs: number) => string | null;
  countTimelineSince: (rows: ReadonlyArray<TimelineRow>, sinceMs: number) => number;
  looksLikeAgentAuthor: (author: string) => boolean;
  formatBigNumber: (n: number) => string;
  formatRecency: (value: string | number) => string;
  HOME_SCOPE_ID: string;
}

let renderer: RendererTestApi;

beforeAll(async () => {
  await import('../../spaces/spaces.js');
  renderer = (window as unknown as {
    __spacesRendererForTesting: RendererTestApi;
  }).__spacesRendererForTesting;
  expect(renderer).toBeDefined();
});

// ─── formatBigNumber ────────────────────────────────────────────────────

describe('formatBigNumber', () => {
  it('returns 0 for non-finite / negative', () => {
    expect(renderer.formatBigNumber(NaN)).toBe('0');
    expect(renderer.formatBigNumber(-1)).toBe('0');
    expect(renderer.formatBigNumber(Infinity)).toBe('0');
  });
  it('returns plain int below 1000', () => {
    expect(renderer.formatBigNumber(0)).toBe('0');
    expect(renderer.formatBigNumber(42)).toBe('42');
    expect(renderer.formatBigNumber(999)).toBe('999');
  });
  it('returns 1.2k-style for thousands', () => {
    expect(renderer.formatBigNumber(1000)).toBe('1.0k');
    expect(renderer.formatBigNumber(1234)).toBe('1.2k');
  });
  it('returns Xk for tens of thousands', () => {
    expect(renderer.formatBigNumber(12_345)).toBe('12k');
  });
  it('returns 1.2M-style for millions', () => {
    expect(renderer.formatBigNumber(1_234_567)).toBe('1.2M');
  });
});

// ─── formatRecency ──────────────────────────────────────────────────────

describe('formatRecency', () => {
  it('returns "just now" for sub-minute', () => {
    expect(renderer.formatRecency(Date.now() - 5_000)).toBe('just now');
  });
  it('returns "Xm ago" for minutes', () => {
    expect(renderer.formatRecency(Date.now() - 5 * 60_000)).toBe('5m ago');
  });
  it('returns "Xh ago" for hours', () => {
    expect(renderer.formatRecency(Date.now() - 3 * 3_600_000)).toBe('3h ago');
  });
  it('returns "yesterday" for ~1 day', () => {
    expect(renderer.formatRecency(Date.now() - 30 * 3_600_000)).toBe('yesterday');
  });
  it('returns "Xd ago" for days', () => {
    expect(renderer.formatRecency(Date.now() - 4 * 86_400_000)).toBe('4d ago');
  });
  it('returns "Xw ago" for weeks', () => {
    expect(renderer.formatRecency(Date.now() - 14 * 86_400_000)).toBe('2w ago');
  });
  it('returns "" / source for invalid input', () => {
    expect(renderer.formatRecency('')).toBe('');
  });
});

// ─── looksLikeAgentAuthor ───────────────────────────────────────────────

describe('looksLikeAgentAuthor', () => {
  it('matches "agent" substring', () => {
    expect(renderer.looksLikeAgentAuthor('Quarterly Audit Agent')).toBe(true);
    expect(renderer.looksLikeAgentAuthor('agent-42')).toBe(true);
  });
  it('matches "bot" substring', () => {
    expect(renderer.looksLikeAgentAuthor('SlackBot')).toBe(true);
  });
  it('matches .ai TLD suffix', () => {
    expect(renderer.looksLikeAgentAuthor('whisperer.ai')).toBe(true);
  });
  it('does not flag plain human names', () => {
    expect(renderer.looksLikeAgentAuthor('Robb Wilson')).toBe(false);
    expect(renderer.looksLikeAgentAuthor('alice@example.com')).toBe(false);
  });
  it('returns false for empty / non-string', () => {
    expect(renderer.looksLikeAgentAuthor('')).toBe(false);
  });
});

// ─── formatSinceLastVisit ───────────────────────────────────────────────

describe('formatSinceLastVisit', () => {
  it('returns null for first-ever visit', () => {
    expect(renderer.formatSinceLastVisit(null, Date.now())).toBeNull();
  });
  it('suppresses within 5 minutes (rapid re-open)', () => {
    const now = Date.now();
    expect(renderer.formatSinceLastVisit(now - 60_000, now)).toBeNull();
    expect(renderer.formatSinceLastVisit(now - 4 * 60_000, now)).toBeNull();
  });
  it('returns "Welcome back — last here Xh ago" beyond 5 minutes', () => {
    const now = Date.now();
    const out = renderer.formatSinceLastVisit(now - 6 * 60_000, now);
    expect(out).toMatch(/^Welcome back — last here /);
  });
  it('uses friendly recency in the suffix', () => {
    const now = Date.now();
    expect(renderer.formatSinceLastVisit(now - 25 * 3_600_000, now)).toBe(
      'Welcome back — last here yesterday.'
    );
  });
});

// ─── countTimelineSince ─────────────────────────────────────────────────

describe('countTimelineSince', () => {
  function row(timestampMs: number): TimelineRow {
    return {
      kind: 'event',
      id: `e-${timestampMs}`,
      author: 'x',
      verb: 'added',
      object: 'y',
      timestamp: new Date(timestampMs).toISOString(),
      fromAgent: false,
    };
  }
  it('returns 0 for empty input', () => {
    expect(renderer.countTimelineSince([], Date.now())).toBe(0);
  });
  it('counts only rows after the cutoff', () => {
    const now = Date.now();
    const rows = [row(now - 60_000), row(now - 10 * 60_000), row(now - 60 * 60_000)];
    expect(renderer.countTimelineSince(rows, now - 5 * 60_000)).toBe(1);
    expect(renderer.countTimelineSince(rows, now - 30 * 60_000)).toBe(2);
    expect(renderer.countTimelineSince(rows, now - 120 * 60_000)).toBe(3);
  });
});

// ─── mergeTimeline ──────────────────────────────────────────────────────

describe('mergeTimeline', () => {
  it('returns an empty array for empty inputs', () => {
    expect(renderer.mergeTimeline([], [])).toEqual([]);
  });

  it('projects an item into a TimelineRow with verb=added', () => {
    const rows = renderer.mergeTimeline(
      [],
      [
        {
          id: 'i-1',
          title: 'Q3 forecast.pdf',
          kind: 'document',
          createdAt: '2026-05-10T00:00:00Z',
          updatedAt: '2026-05-10T00:00:00Z',
          otherSpaces: [{ id: 'sp-1', name: 'Finance' }],
          producedBy: { kind: 'Person', name: 'Robb', id: 'p-1' },
        },
      ]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'item',
      author: 'Robb',
      verb: 'added',
      object: 'Q3 forecast.pdf',
      spaceId: 'sp-1',
      fromAgent: false,
      itemId: 'i-1',
    });
  });

  it('flags fromAgent=true when producedBy.kind=Agent', () => {
    const rows = renderer.mergeTimeline(
      [],
      [
        {
          id: 'i-1',
          title: 'Audit_2026Q1.docx',
          kind: 'document',
          createdAt: '2026-05-10T00:00:00Z',
          updatedAt: '2026-05-10T00:00:00Z',
          otherSpaces: [],
          producedBy: { kind: 'Agent', name: 'Audit Agent', id: 'a-1' },
        },
      ]
    );
    expect(rows[0]?.fromAgent).toBe(true);
  });

  it('orders rows chronologically (newest first)', () => {
    const rows = renderer.mergeTimeline(
      [],
      [
        {
          id: 'i-old',
          title: 'old',
          kind: 'document',
          createdAt: '2026-05-01T00:00:00Z',
          updatedAt: '2026-05-01T00:00:00Z',
          otherSpaces: [],
          producedBy: null,
        },
        {
          id: 'i-new',
          title: 'new',
          kind: 'document',
          createdAt: '2026-05-12T00:00:00Z',
          updatedAt: '2026-05-12T00:00:00Z',
          otherSpaces: [],
          producedBy: null,
        },
      ]
    );
    expect(rows.map((r) => r.itemId)).toEqual(['i-new', 'i-old']);
  });

  it('translates an event kind into a friendly verb', () => {
    const rows = renderer.mergeTimeline(
      [
        {
          id: 'c-1',
          author: 'robb',
          kind: 'item:added',
          timestamp: '2026-05-10T00:00:00Z',
          spaceId: 'sp-1',
          spaceName: 'Finance',
        },
      ],
      []
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'event',
      author: 'robb',
      verb: 'added',
      object: 'an item',
      spaceId: 'sp-1',
    });
  });

  it('marks event rows as agent when author looks agent-y', () => {
    const rows = renderer.mergeTimeline(
      [
        {
          id: 'c-1',
          author: 'AuditBot',
          kind: 'item:produced',
          timestamp: '2026-05-10T00:00:00Z',
        },
      ],
      []
    );
    expect(rows[0]?.fromAgent).toBe(true);
  });
});

// ─── filterTimeline ─────────────────────────────────────────────────────

describe('filterTimeline', () => {
  function row(opts: { ts: number; fromAgent: boolean }): TimelineRow {
    return {
      kind: 'event',
      id: `r-${opts.ts}`,
      author: opts.fromAgent ? 'bot' : 'alice',
      verb: 'added',
      object: 'x',
      timestamp: new Date(opts.ts).toISOString(),
      fromAgent: opts.fromAgent,
    };
  }
  const now = Date.now();
  const rows: TimelineRow[] = [
    row({ ts: now - 1 * 60_000, fromAgent: false }), // 1m ago, person
    row({ ts: now - 10 * 60 * 60_000, fromAgent: true }), // 10h ago, agent
    row({ ts: now - 3 * 86_400_000, fromAgent: false }), // 3d ago, person
    row({ ts: now - 14 * 86_400_000, fromAgent: true }), // 14d ago, agent
  ];

  it('all returns every row', () => {
    expect(renderer.filterTimeline(rows, 'all', now)).toHaveLength(4);
  });
  it('people filters out agent rows', () => {
    expect(renderer.filterTimeline(rows, 'people', now).every((r) => !r.fromAgent)).toBe(
      true
    );
  });
  it('agents filters out person rows', () => {
    expect(renderer.filterTimeline(rows, 'agents', now).every((r) => r.fromAgent)).toBe(
      true
    );
  });
  it('24h keeps only rows within last 24 hours', () => {
    const out = renderer.filterTimeline(rows, '24h', now);
    expect(out).toHaveLength(2);
  });
  it('7d keeps only rows within last 7 days', () => {
    const out = renderer.filterTimeline(rows, '7d', now);
    expect(out).toHaveLength(3);
  });
});

// ─── buildWelcomeCard ───────────────────────────────────────────────────

describe('buildWelcomeCard', () => {
  it('renders title + body + dismiss button', () => {
    const el = renderer.buildWelcomeCard();
    expect(el.querySelector('.home-welcome-title')?.textContent).toBe(
      'Welcome to Spaces'
    );
    expect(el.querySelector('.home-welcome-body')?.textContent).toMatch(
      /project places/
    );
    const btn = el.querySelector<HTMLButtonElement>('button.home-welcome-dismiss');
    expect(btn).not.toBeNull();
    expect(btn?.textContent).toBe('Got it');
  });

  it('explains the channel-but-better framing in the body', () => {
    const el = renderer.buildWelcomeCard();
    const body = el.querySelector('.home-welcome-body')?.textContent ?? '';
    expect(body).toMatch(/channel/i);
    expect(body).toMatch(/findable forever/i);
  });

  it('is keyboard-accessible (role=region with an aria-label)', () => {
    const el = renderer.buildWelcomeCard();
    expect(el.getAttribute('role')).toBe('region');
    expect(el.getAttribute('aria-label')).toBe('Welcome to Spaces');
  });
});

// ─── buildFilterChips ───────────────────────────────────────────────────

describe('buildFilterChips', () => {
  it('renders one chip per filter mode', () => {
    const el = renderer.buildFilterChips('all');
    const chips = Array.from(el.querySelectorAll<HTMLElement>('.home-filter-chip'));
    expect(chips.map((c) => c.getAttribute('data-filter'))).toEqual([
      'all',
      'people',
      'agents',
      '24h',
      '7d',
    ]);
  });

  it('marks the active chip with is-active + aria-selected', () => {
    const el = renderer.buildFilterChips('agents');
    const active = el.querySelector<HTMLElement>('.home-filter-chip.is-active');
    expect(active?.getAttribute('data-filter')).toBe('agents');
    expect(active?.getAttribute('aria-selected')).toBe('true');
  });

  it('exposes role=tablist for screen readers', () => {
    const el = renderer.buildFilterChips('all');
    expect(el.getAttribute('role')).toBe('tablist');
    expect(el.getAttribute('aria-label')).toBe('Filter timeline');
  });
});

// ─── buildTimelineRow ───────────────────────────────────────────────────

describe('buildTimelineRow', () => {
  const baseRow: TimelineRow = {
    kind: 'item',
    id: 'item:i-1',
    author: 'Robb',
    verb: 'added',
    object: 'Q3 forecast.pdf',
    space: { id: 'sp-1', name: 'Finance' },
    timestamp: new Date(Date.now() - 3 * 60 * 60_000).toISOString(),
    fromAgent: false,
    itemId: 'i-1',
    spaceId: 'sp-1',
  };

  it('renders author, verb, object', () => {
    const el = renderer.buildTimelineRow(baseRow);
    expect(el.querySelector('.home-timeline-author')?.textContent).toBe('Robb');
    expect(el.querySelector('.home-timeline-verb')?.textContent?.trim()).toBe('added');
    expect(el.querySelector('.home-timeline-object')?.textContent).toBe('Q3 forecast.pdf');
  });

  it('renders the Space chip when row.space is set', () => {
    const el = renderer.buildTimelineRow(baseRow);
    const chip = el.querySelector<HTMLElement>('.home-timeline-meta .spaces-chip');
    expect(chip?.textContent).toContain('Finance');
  });

  it('renders the excerpt for item rows when present', () => {
    const row = { ...baseRow, excerpt: 'Preliminary revenue projection.' };
    const el = renderer.buildTimelineRow(row);
    expect(el.querySelector('.home-timeline-excerpt')?.textContent).toBe(
      'Preliminary revenue projection.'
    );
  });

  it('omits the excerpt block when missing', () => {
    const el = renderer.buildTimelineRow(baseRow);
    expect(el.querySelector('.home-timeline-excerpt')).toBeNull();
  });

  it('adds is-agent class when the row is agent-authored', () => {
    const row: TimelineRow = { ...baseRow, fromAgent: true, author: 'AuditBot' };
    const el = renderer.buildTimelineRow(row);
    expect(el.classList.contains('is-agent')).toBe(true);
  });

  it('is keyboard-focusable (tabindex=0 + role=button)', () => {
    const el = renderer.buildTimelineRow(baseRow);
    expect(el.getAttribute('role')).toBe('button');
    expect(el.getAttribute('tabindex')).toBe('0');
  });

  it('falls back to "Someone" when author is empty', () => {
    const el = renderer.buildTimelineRow({ ...baseRow, author: '' });
    expect(el.querySelector('.home-timeline-author')?.textContent).toBe('Someone');
  });

  it('renders event rows with the derived object phrase', () => {
    const eventRow: TimelineRow = {
      ...baseRow,
      kind: 'event',
      id: 'event:c-1',
      object: 'an item',
    };
    const el = renderer.buildTimelineRow(eventRow);
    expect(el.classList.contains('home-timeline-row-event')).toBe(true);
    expect(el.querySelector('.home-timeline-object')?.textContent).toBe('an item');
  });
});
