/**
 * Recency organization of a Space's asset grid (2026-08-11): subtle
 * Today / Yesterday / This week / This month / Older rules over the
 * newest-first grid, an explicit "edited … ago" (or "created …") label
 * on every card, and — when the viewer has opened the asset — a
 * "read … ago" fragment from their own VIEWED audit edge.
 */

// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import {
  buildItemCard,
  itemLastEditMs,
  recencyBucketLabel,
  planRecencyRules,
} from '../../spaces/spaces.js';

type SummaryLike = Parameters<typeof buildItemCard>[0];

// Anchor "now" mid-day so day-boundary math is unambiguous.
const NOW = new Date(2026, 7, 11, 12, 0, 0).getTime(); // Aug 11 2026, noon local
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const summary = (over: Partial<SummaryLike>): SummaryLike =>
  ({
    id: 'i1',
    title: 'Note',
    kind: 'text',
    createdAt: new Date(NOW - 30 * DAY).toISOString(),
    updatedAt: new Date(NOW - 2 * HOUR).toISOString(),
    otherSpaces: [],
    producedBy: null,
    ...over,
  }) as SummaryLike;

describe('recencyBucketLabel — calendar-local bands', () => {
  it('maps each band correctly', () => {
    expect(recencyBucketLabel(NOW - HOUR, NOW)).toBe('Today');
    expect(recencyBucketLabel(NOW - 13 * HOUR, NOW)).toBe('Yesterday'); // 23:00 prev day
    expect(recencyBucketLabel(NOW - 3 * DAY, NOW)).toBe('This week');
    expect(recencyBucketLabel(NOW - 20 * DAY, NOW)).toBe('This month');
    expect(recencyBucketLabel(NOW - 90 * DAY, NOW)).toBe('Older');
    expect(recencyBucketLabel(null, NOW)).toBe('Older');
  });

  it('uses calendar days, not 24h windows (early-morning edit is still Today)', () => {
    const eightAm = new Date(2026, 7, 11, 8, 0, 0).getTime();
    // 8am seen from noon is 4h ago — Today even though "yesterday noon" is closer to 24h.
    expect(recencyBucketLabel(eightAm, NOW)).toBe('Today');
  });
});

describe('planRecencyRules', () => {
  it('emits one rule per band change, including index 0', () => {
    const items = [
      { updatedAt: new Date(NOW - HOUR).toISOString() }, // Today
      { updatedAt: new Date(NOW - 2 * HOUR).toISOString() }, // Today
      { updatedAt: new Date(NOW - DAY).toISOString() }, // Yesterday
      { updatedAt: new Date(NOW - 40 * DAY).toISOString() }, // Older
    ];
    expect(planRecencyRules(items, NOW)).toEqual([
      { index: 0, label: 'Today' },
      { index: 2, label: 'Yesterday' },
      { index: 3, label: 'Older' },
    ]);
  });

  it('stays silent when everything falls in one band (no noise)', () => {
    const items = [
      { updatedAt: new Date(NOW - HOUR).toISOString() },
      { updatedAt: new Date(NOW - 2 * HOUR).toISOString() },
    ];
    expect(planRecencyRules(items, NOW)).toEqual([]);
  });

  it('handles an empty list', () => {
    expect(planRecencyRules([], NOW)).toEqual([]);
  });
});

describe('itemLastEditMs', () => {
  it('prefers updatedAt, falls back to createdAt, null when neither parses', () => {
    const u = new Date(NOW - HOUR).toISOString();
    const c = new Date(NOW - DAY).toISOString();
    expect(itemLastEditMs({ updatedAt: u, createdAt: c })).toBe(Date.parse(u));
    expect(itemLastEditMs({ updatedAt: '', createdAt: c })).toBe(Date.parse(c));
    expect(itemLastEditMs({})).toBeNull();
  });
});

describe('buildItemCard — labeled edit/read times', () => {
  it('labels an edited asset "edited … ago"', () => {
    const el = buildItemCard(summary({}), false);
    const time = el.querySelector('.spaces-card-time');
    expect(time?.textContent).toMatch(/^edited /);
    expect(time?.getAttribute('title')).toBeTruthy(); // absolute time on hover
  });

  it('labels a never-edited asset "created …"', () => {
    const stamp = new Date(NOW - 3 * HOUR).toISOString();
    const el = buildItemCard(summary({ createdAt: stamp, updatedAt: stamp }), false);
    expect(el.querySelector('.spaces-card-time')?.textContent).toMatch(/^created /);
  });

  it('shows my last-read fragment only when I have opened it', () => {
    const withRead = buildItemCard(summary({ viewedAtMs: Date.now() - 5 * 60_000 }), false);
    expect(withRead.querySelector('.spaces-card-read')?.textContent).toMatch(/^read /);

    const noRead = buildItemCard(summary({}), false);
    expect(noRead.querySelector('.spaces-card-read')).toBeNull();
  });
});
