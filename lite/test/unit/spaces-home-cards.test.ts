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
  prettyAuthor: (raw: string) => string;
  looksLikeIdString: (value: string) => boolean;
  friendlyObjectForItem: (rawTitle: string, kind: string) => string;
  friendlySpaceName: (rawName: string) => string;
  generateItemTitle: (item: {
    title?: string;
    kind?: string;
    id?: string;
    sourceUrl?: string;
    fileKey?: string;
    excerpt?: string;
  }) => string;
  buildDetailEmptyContentHint: (item: { kind?: string }) => HTMLElement;
  buildPreviewPlaceholder: (item: {
    kind?: string;
    mimeType?: string;
  }) => HTMLElement;
  buildPreviewUnavailable: (
    item: { kind?: string; fileKey?: string; mimeType?: string },
    reason: string | null
  ) => HTMLElement;
  bucketTimelineByDate: (
    rows: ReadonlyArray<TimelineRow>,
    nowMs: number
  ) => Array<{ key: string; label: string; rows: TimelineRow[] }>;
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

// ─── prettyAuthor ───────────────────────────────────────────────────────

describe('prettyAuthor', () => {
  it('returns "Someone" for empty / whitespace-only input', () => {
    expect(renderer.prettyAuthor('')).toBe('Someone');
    expect(renderer.prettyAuthor('   ')).toBe('Someone');
  });

  it('collapses device-shaped identifiers to "Local device"', () => {
    expect(renderer.prettyAuthor('device_mac.lan_mnc5mu8m')).toBe('Local device');
    expect(renderer.prettyAuthor('device-windows-pc')).toBe('Local device');
    expect(renderer.prettyAuthor('Device_mac.lan_xyz')).toBe('Local device');
  });

  it('collapses service-account identifiers', () => {
    expect(renderer.prettyAuthor('service-account.lite.local_abc')).toBe(
      'Service account'
    );
    expect(renderer.prettyAuthor('service_account.foo')).toBe('Service account');
    expect(renderer.prettyAuthor('serviceaccount.bar')).toBe('Service account');
  });

  it('collapses system identifiers', () => {
    expect(renderer.prettyAuthor('system_cron')).toBe('System');
    expect(renderer.prettyAuthor('system-watchdog')).toBe('System');
  });

  it('extracts the local part of an email and strips role tails', () => {
    expect(renderer.prettyAuthor('robb@onereach.com')).toBe('robb');
    expect(renderer.prettyAuthor('robb+admin/onereach@onereach.com')).toBe('robb');
    expect(renderer.prettyAuthor('alice+test@example.com')).toBe('alice');
  });

  it('falls through to the raw author when no rule matches', () => {
    expect(renderer.prettyAuthor('Audit Agent')).toBe('Audit Agent');
    expect(renderer.prettyAuthor('Quarterly Report Bot')).toBe('Quarterly Report Bot');
    expect(renderer.prettyAuthor('robb')).toBe('robb');
  });

  it('does not flag a person email as an agent (looksLikeAgentAuthor still uses RAW)', () => {
    // prettyAuthor is purely cosmetic. The agent detection runs on
    // the raw value so the heuristic isn't fooled by stripped tails.
    expect(renderer.looksLikeAgentAuthor('robb@onereach.com')).toBe(false);
    expect(renderer.looksLikeAgentAuthor('audit-bot@onereach.com')).toBe(true);
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

// ─── looksLikeIdString ──────────────────────────────────────────────────

describe('looksLikeIdString', () => {
  it('flags 32-char hex hashes (md5-shaped)', () => {
    expect(renderer.looksLikeIdString('5b4375227558baa82b0846ff0a8d8490')).toBe(true);
  });

  it('flags 64-char hex hashes (sha256-shaped)', () => {
    expect(renderer.looksLikeIdString('a'.repeat(64))).toBe(true);
  });

  it('flags dashed UUIDs', () => {
    expect(renderer.looksLikeIdString('402abae3-5ea4-9651-5760-deadbeefcafe')).toBe(true);
  });

  it('flags long lowercase alphanumeric blobs', () => {
    expect(renderer.looksLikeIdString('cm8x3jq4k1z2y9wq7r6t5u3p1o2i')).toBe(true);
  });

  it('does NOT flag short strings', () => {
    expect(renderer.looksLikeIdString('hello')).toBe(false);
    expect(renderer.looksLikeIdString('abc123')).toBe(false);
  });

  it('does NOT flag human-typed titles with spaces', () => {
    expect(renderer.looksLikeIdString('Quarterly audit Q4 2026')).toBe(false);
    expect(renderer.looksLikeIdString('Onboarding meeting notes')).toBe(false);
  });

  it('does NOT flag filenames with dots / words', () => {
    expect(renderer.looksLikeIdString('report-final-v2.pdf')).toBe(false);
  });

  it('does NOT flag readable names with vowel runs (e.g. "audit")', () => {
    expect(renderer.looksLikeIdString('quarterlyaudit2026q4')).toBe(false);
  });

  it('returns false for non-string input', () => {
    expect(renderer.looksLikeIdString(undefined as unknown as string)).toBe(false);
    expect(renderer.looksLikeIdString(null as unknown as string)).toBe(false);
    expect(renderer.looksLikeIdString(42 as unknown as string)).toBe(false);
  });
});

// ─── friendlyObjectForItem ──────────────────────────────────────────────

describe('friendlyObjectForItem', () => {
  it('returns the title verbatim when it does not look like an id', () => {
    expect(renderer.friendlyObjectForItem('Quarterly audit', 'document')).toBe(
      'Quarterly audit'
    );
  });

  it('falls back to a kind-aware noun when the title is hash-shaped', () => {
    expect(
      renderer.friendlyObjectForItem('5b4375227558baa82b0846ff0a8d8490', 'image')
    ).toBe('an image');
    expect(
      renderer.friendlyObjectForItem('5b4375227558baa82b0846ff0a8d8490', 'document')
    ).toBe('a document');
    expect(
      renderer.friendlyObjectForItem('5b4375227558baa82b0846ff0a8d8490', 'url')
    ).toBe('a link');
    expect(
      renderer.friendlyObjectForItem('5b4375227558baa82b0846ff0a8d8490', 'audio')
    ).toBe('an audio clip');
    expect(
      renderer.friendlyObjectForItem('5b4375227558baa82b0846ff0a8d8490', 'video')
    ).toBe('a video');
    expect(
      renderer.friendlyObjectForItem('5b4375227558baa82b0846ff0a8d8490', 'text')
    ).toBe('a note');
  });

  it('falls back to generic "an item" for unknown kinds', () => {
    expect(
      renderer.friendlyObjectForItem('5b4375227558baa82b0846ff0a8d8490', 'mystery')
    ).toBe('an item');
  });

  it('falls back to a kind-aware noun for empty titles', () => {
    expect(renderer.friendlyObjectForItem('', 'image')).toBe('an image');
    expect(renderer.friendlyObjectForItem('   ', 'document')).toBe('a document');
  });

  it('trims whitespace from human titles', () => {
    expect(renderer.friendlyObjectForItem('  Audit  ', 'document')).toBe('Audit');
  });
});

// ─── friendlySpaceName ──────────────────────────────────────────────────

describe('friendlySpaceName', () => {
  it('returns the name verbatim when it looks human', () => {
    expect(renderer.friendlySpaceName('Engineering')).toBe('Engineering');
    expect(renderer.friendlySpaceName('Claude Conversations')).toBe('Claude Conversations');
  });

  it('returns "Unnamed space" for hash-shaped names', () => {
    expect(renderer.friendlySpaceName('402abae35ea49651576deadbeefcafe11')).toBe(
      'Unnamed space'
    );
  });

  it('returns "Unnamed space" for dashed UUIDs', () => {
    expect(
      renderer.friendlySpaceName('402abae3-5ea4-9651-5760-deadbeefcafe')
    ).toBe('Unnamed space');
  });

  it('returns "Unnamed space" for empty input', () => {
    expect(renderer.friendlySpaceName('')).toBe('Unnamed space');
    expect(renderer.friendlySpaceName('   ')).toBe('Unnamed space');
  });

  it('trims whitespace from human names', () => {
    expect(renderer.friendlySpaceName('  Eng  ')).toBe('Eng');
  });
});

// ─── bucketTimelineByDate ───────────────────────────────────────────────

describe('bucketTimelineByDate', () => {
  const now = Date.parse('2026-05-18T12:00:00Z');
  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;

  function row(timestamp: string): TimelineRow {
    return {
      kind: 'event',
      id: `event:${timestamp}`,
      author: 'Someone',
      verb: 'added',
      object: 'an item',
      timestamp,
      fromAgent: false,
    };
  }

  it('returns an empty array for empty input', () => {
    expect(renderer.bucketTimelineByDate([], now)).toEqual([]);
  });

  it('drops empty buckets so headers never paint without rows', () => {
    const only_today = renderer.bucketTimelineByDate(
      [row(new Date(now - 2 * HOUR).toISOString())],
      now
    );
    expect(only_today).toHaveLength(1);
    expect(only_today[0]?.key).toBe('today');
    expect(only_today[0]?.label).toBe('Today');
  });

  it('places rows in the right buckets and preserves order', () => {
    const todayRow = row(new Date(now - 3 * HOUR).toISOString());
    const yesterdayRow = row(new Date(now - 30 * HOUR).toISOString()); // ~1.25d
    const thisWeekRow = row(new Date(now - 4 * DAY).toISOString());
    const olderRow = row(new Date(now - 10 * DAY).toISOString());
    const buckets = renderer.bucketTimelineByDate(
      [todayRow, yesterdayRow, thisWeekRow, olderRow],
      now
    );
    expect(buckets.map((b) => b.key)).toEqual([
      'today',
      'yesterday',
      'thisWeek',
      'older',
    ]);
    expect(buckets[0]?.rows).toHaveLength(1);
    expect(buckets[1]?.rows).toHaveLength(1);
    expect(buckets[2]?.rows).toHaveLength(1);
    expect(buckets[3]?.rows).toHaveLength(1);
  });

  it('rows with unparseable timestamps land in "Older"', () => {
    const garbage = row('not-a-timestamp');
    const buckets = renderer.bucketTimelineByDate([garbage], now);
    expect(buckets.map((b) => b.key)).toEqual(['older']);
  });

  it('headers always appear in fixed order (Today before Older)', () => {
    // Even if input is reversed chronologically, output bucket order
    // stays Today -> Yesterday -> ThisWeek -> Older.
    const olderRow = row(new Date(now - 10 * DAY).toISOString());
    const todayRow = row(new Date(now - 1 * HOUR).toISOString());
    const buckets = renderer.bucketTimelineByDate([olderRow, todayRow], now);
    expect(buckets.map((b) => b.key)).toEqual(['today', 'older']);
  });
});

// ─── Integration: mergeTimeline + friendlyObjectForItem ─────────────────

describe('mergeTimeline integrates friendly object labels', () => {
  it('replaces hash-shaped item titles with a generated "<Kind> · <short-id>"', () => {
    // Upgraded from the earlier "an image" fallback. The merged row's
    // object now carries a generated title derived from kind + the
    // first 6 chars of the (dash-stripped) id.
    const rows = renderer.mergeTimeline(
      [],
      [
        {
          id: 'asset-1',
          title: '5b4375227558baa82b0846ff0a8d8490',
          kind: 'image',
          createdAt: '2026-05-15T10:00:00Z',
          updatedAt: '2026-05-15T10:00:00Z',
          otherSpaces: [],
          producedBy: null,
        },
      ]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.object).toBe('Image · asset1');
  });

  it('preserves human-typed titles', () => {
    const rows = renderer.mergeTimeline(
      [],
      [
        {
          id: 'asset-2',
          title: 'Quarterly Audit',
          kind: 'document',
          createdAt: '2026-05-15T10:00:00Z',
          updatedAt: '2026-05-15T10:00:00Z',
          otherSpaces: [],
          producedBy: null,
        },
      ]
    );
    expect(rows[0]?.object).toBe('Quarterly Audit');
  });
});

// ─── generateItemTitle ──────────────────────────────────────────────────

describe('generateItemTitle', () => {
  it('returns the real title when it is human-shaped', () => {
    expect(
      renderer.generateItemTitle({ title: 'Quarterly Audit', kind: 'document' })
    ).toBe('Quarterly Audit');
  });

  it('trims whitespace from real titles', () => {
    expect(
      renderer.generateItemTitle({ title: '  Audit  ', kind: 'document' })
    ).toBe('Audit');
  });

  it('falls back to kind + short id when nothing else is available', () => {
    expect(
      renderer.generateItemTitle({
        title: '5b4375227558baa82b0846ff0a8d8490',
        kind: 'image',
        id: '5b4375227558baa82b0846ff0a8d8490',
      })
    ).toBe('Image · 5b4375');
  });

  it('strips UUID dashes when shortening the id', () => {
    expect(
      renderer.generateItemTitle({
        title: '',
        kind: 'document',
        id: '402abae3-5ea4-9651-5760-deadbeefcafe',
      })
    ).toBe('Doc · 402aba');
  });

  it('derives a title from a URL path segment + host', () => {
    expect(
      renderer.generateItemTitle({
        kind: 'url',
        sourceUrl: 'https://photos.example.com/2026/sunset.jpg',
        id: 'asset-1',
      })
    ).toBe('sunset · photos.example.com');
  });

  it('falls back to "<Kind> · <host>" when the URL path has no meaningful segment', () => {
    expect(
      renderer.generateItemTitle({
        kind: 'url',
        sourceUrl: 'https://claude.ai/',
        id: 'asset-2',
      })
    ).toBe('URL · claude.ai');
  });

  it('strips a leading "www." from the host', () => {
    expect(
      renderer.generateItemTitle({
        kind: 'url',
        sourceUrl: 'https://www.example.com/',
        id: 'asset-x',
      })
    ).toBe('URL · example.com');
  });

  it('walks back through the URL path to skip id-shaped trailing segments', () => {
    // The trailing segment is an id; the prior segment should win.
    expect(
      renderer.generateItemTitle({
        kind: 'url',
        sourceUrl:
          'https://example.com/notes/quarterly-audit/5b4375227558baa82b0846ff0a8d8490',
        id: 'asset-3',
      })
    ).toBe('quarterly audit · example.com');
  });

  it('humanizes a fileKey path segment by stripping extension and separators', () => {
    expect(
      renderer.generateItemTitle({
        title: '',
        kind: 'document',
        fileKey: 'uploads/team/quarterly-audit-q4.pdf',
        id: 'asset-4',
      })
    ).toBe('Quarterly audit q4');
  });

  it('rejects a fileKey whose filename is itself an id', () => {
    // The fileKey segment is hash-shaped; we should fall through to
    // the kind + short id default rather than render the hex string.
    expect(
      renderer.generateItemTitle({
        title: '',
        kind: 'document',
        fileKey: 'uploads/5b4375227558baa82b0846ff0a8d8490.bin',
        id: '5b4375227558baa82b0846ff0a8d8490',
      })
    ).toBe('Doc · 5b4375');
  });

  it('lifts the first ~6 words of an excerpt for text-kind items', () => {
    expect(
      renderer.generateItemTitle({
        kind: 'text',
        excerpt: 'Today we shipped the calmer spaces UI to production.',
        id: 'asset-5',
      })
    ).toBe('Today we shipped the calmer spaces…');
  });

  it('does NOT use excerpt for non-text items (we trust the kind path more)', () => {
    // `asset-6` -> dashes stripped -> 'asset6' -> first 6 chars -> 'asset6'
    expect(
      renderer.generateItemTitle({
        kind: 'image',
        excerpt: 'A nice sunset photo from last summer.',
        id: 'asset-6',
      })
    ).toBe('Image · asset6');
  });

  it('always returns a non-empty string, even with minimal input', () => {
    expect(renderer.generateItemTitle({ kind: 'document' })).toBe('Doc');
    expect(renderer.generateItemTitle({})).toBe('Other');
  });
});

// ─── Integration: generated titles flow through mergeTimeline ───────────

describe('mergeTimeline uses generated titles for hash-shaped items', () => {
  it('renders an item with a hash title as "<Kind> · <short-id>"', () => {
    const rows = renderer.mergeTimeline(
      [],
      [
        {
          id: '5b4375227558baa82b0846ff0a8d8490',
          title: '5b4375227558baa82b0846ff0a8d8490',
          kind: 'image',
          createdAt: '2026-05-15T10:00:00Z',
          updatedAt: '2026-05-15T10:00:00Z',
          otherSpaces: [],
          producedBy: null,
        },
      ]
    );
    expect(rows[0]?.object).toBe('Image · 5b4375');
  });

  it('keeps real titles untouched in the merged row', () => {
    const rows = renderer.mergeTimeline(
      [],
      [
        {
          id: 'asset-7',
          title: 'Quarterly Audit',
          kind: 'document',
          createdAt: '2026-05-15T10:00:00Z',
          updatedAt: '2026-05-15T10:00:00Z',
          otherSpaces: [],
          producedBy: null,
        },
      ]
    );
    expect(rows[0]?.object).toBe('Quarterly Audit');
  });
});

// ─── buildDetailEmptyContentHint ────────────────────────────────────────

describe('buildDetailEmptyContentHint', () => {
  it('returns a section with the spaces-detail-empty class', () => {
    const el = renderer.buildDetailEmptyContentHint({ kind: 'document' });
    expect(el.tagName).toBe('SECTION');
    expect(el.classList.contains('spaces-detail-empty')).toBe(true);
    expect(el.getAttribute('role')).toBe('status');
  });

  it('always emits a non-empty headline and sub-text', () => {
    const kinds = ['document', 'text', 'image', 'video', 'audio', 'url', '', 'unknown'];
    for (const kind of kinds) {
      const el = renderer.buildDetailEmptyContentHint({ kind });
      const headline = el.querySelector('.spaces-detail-empty-headline')?.textContent ?? '';
      const sub = el.querySelector('.spaces-detail-empty-sub')?.textContent ?? '';
      expect(headline.length).toBeGreaterThan(0);
      expect(sub.length).toBeGreaterThan(0);
    }
  });

  it('mentions the right graph property in the kind-specific sub-text', () => {
    // text / document → :Asset.content
    const text = renderer.buildDetailEmptyContentHint({ kind: 'text' });
    expect(text.querySelector('.spaces-detail-empty-sub')?.textContent).toContain(
      ':Asset.content'
    );
    // image → :Asset.url (the fileKey field)
    const image = renderer.buildDetailEmptyContentHint({ kind: 'image' });
    expect(image.querySelector('.spaces-detail-empty-sub')?.textContent).toContain(
      ':Asset.url'
    );
    // url → :Asset.sourceUrl
    const url = renderer.buildDetailEmptyContentHint({ kind: 'url' });
    expect(url.querySelector('.spaces-detail-empty-sub')?.textContent).toContain(
      ':Asset.sourceUrl'
    );
  });

  it('falls back to a generic copy for unknown kinds', () => {
    const el = renderer.buildDetailEmptyContentHint({ kind: 'mystery' });
    const headline = el.querySelector('.spaces-detail-empty-headline')?.textContent ?? '';
    expect(headline).toBe('This asset has no content yet.');
  });
});

// ─── buildPreviewPlaceholder ────────────────────────────────────────────

describe('buildPreviewPlaceholder', () => {
  it('renders with the spaces-detail-preview class so injectBinaryPreview can swap it', () => {
    const el = renderer.buildPreviewPlaceholder({ kind: 'image' });
    expect(el.classList.contains('spaces-detail-preview')).toBe(true);
    expect(el.classList.contains('spaces-detail-preview-loading')).toBe(true);
    expect(el.getAttribute('data-state')).toBe('loading');
  });

  it('uses kind-aware copy in the loading label', () => {
    const samples: Array<[{ kind?: string; mimeType?: string }, string]> = [
      [{ kind: 'image' }, 'Loading image…'],
      [{ kind: 'video' }, 'Loading video…'],
      [{ kind: 'audio' }, 'Loading audio…'],
      [{ kind: 'document', mimeType: 'application/pdf' }, 'Loading PDF…'],
      [{ kind: 'document' }, 'Loading document…'],
      [{ kind: 'mystery' }, 'Loading preview…'],
      [{}, 'Loading preview…'],
    ];
    for (const [input, expected] of samples) {
      const el = renderer.buildPreviewPlaceholder(input);
      expect(el.querySelector('.spaces-detail-preview-loading-label')?.textContent).toBe(
        expected
      );
    }
  });
});

// ─── buildPreviewUnavailable ────────────────────────────────────────────

describe('buildPreviewUnavailable', () => {
  it('renders with the spaces-detail-preview class so it lands in the same slot', () => {
    const el = renderer.buildPreviewUnavailable(
      { kind: 'image', fileKey: 's3://x/y.png' },
      null
    );
    expect(el.classList.contains('spaces-detail-preview')).toBe(true);
    expect(el.classList.contains('spaces-detail-preview-unavailable')).toBe(true);
    expect(el.getAttribute('data-state')).toBe('unavailable');
  });

  it('uses kind-aware headlines', () => {
    expect(
      renderer
        .buildPreviewUnavailable({ kind: 'image', fileKey: 'k' }, null)
        .querySelector('.spaces-detail-preview-unavailable-headline')?.textContent
    ).toBe('Image preview unavailable.');
    expect(
      renderer
        .buildPreviewUnavailable({ kind: 'video', fileKey: 'k' }, null)
        .querySelector('.spaces-detail-preview-unavailable-headline')?.textContent
    ).toBe('Video preview unavailable.');
    expect(
      renderer
        .buildPreviewUnavailable(
          { kind: 'document', mimeType: 'application/pdf', fileKey: 'k' },
          null
        )
        .querySelector('.spaces-detail-preview-unavailable-headline')?.textContent
    ).toBe('PDF preview unavailable.');
    expect(
      renderer
        .buildPreviewUnavailable({ kind: 'mystery', fileKey: 'k' }, null)
        .querySelector('.spaces-detail-preview-unavailable-headline')?.textContent
    ).toBe('File preview unavailable.');
  });

  it('shows the raw fileKey verbatim so producers can see what path failed', () => {
    const el = renderer.buildPreviewUnavailable(
      {
        kind: 'document',
        mimeType: 'application/pdf',
        fileKey: 's3://uxmag-assets/2026-02/design-guide-feb.pdf',
      },
      null
    );
    expect(
      el.querySelector('.spaces-detail-preview-unavailable-key')?.textContent
    ).toBe('s3://uxmag-assets/2026-02/design-guide-feb.pdf');
  });

  it('falls back to a generic explanation when reason is null', () => {
    const el = renderer.buildPreviewUnavailable(
      { kind: 'image', fileKey: 'x' },
      null
    );
    expect(
      el.querySelector('.spaces-detail-preview-unavailable-sub')?.textContent
    ).toContain('Files module returned no URL');
  });

  it('includes the reason text when provided', () => {
    const el = renderer.buildPreviewUnavailable(
      { kind: 'image', fileKey: 'x' },
      'Connection refused'
    );
    expect(
      el.querySelector('.spaces-detail-preview-unavailable-sub')?.textContent
    ).toContain('Connection refused');
  });

  it('omits the fileKey block when fileKey is absent', () => {
    const el = renderer.buildPreviewUnavailable({ kind: 'image' }, null);
    expect(el.querySelector('.spaces-detail-preview-unavailable-key')).toBeNull();
  });
});
