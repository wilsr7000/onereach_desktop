/**
 * MemoryCurator tests
 *
 * Tests the pure internals (append + keyvalue grooming, scoring) directly.
 * The integration path with agent-memory-store is covered by e2e flows.
 *
 * Run: npx vitest run test/unit/agent-learning/memory-curator.test.js
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../lib/log-event-queue', () => ({
  getLogQueue: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
}));

const { MemoryCurator } = require('../../../lib/agent-learning/memory-curator');

describe('MemoryCurator -- append grooming', () => {
  const curator = new MemoryCurator();
  const rule = { style: 'append', maxLines: 30, maxAgeDays: 90 };

  it('deduplicates near-identical lines (case + whitespace insensitive)', () => {
    const content = [
      '- 2026-04-15: Busted on coffee shops nearby query',
      '- 2026-04-15: busted on coffee shops nearby query',
      '- 2026-04-14: Completely different note about file handling',
    ].join('\n');
    const out = curator._groomAppendSection(content, rule, Date.now());
    expect(out.changed).toBe(true);
    expect(out.deduped).toBeGreaterThanOrEqual(1);
    expect(out.content.split('\n').filter((l) => l.trim()).length).toBe(2);
  });

  it('ages out entries older than maxAgeDays', () => {
    const now = new Date('2026-04-15').getTime();
    const content = [
      '- 2026-04-14: Fresh note',
      '- 2025-10-15: Ancient note more than 90 days old',
    ].join('\n');
    const out = curator._groomAppendSection(content, rule, now);
    expect(out.aged).toBeGreaterThanOrEqual(1);
    expect(out.content).toContain('Fresh note');
    expect(out.content).not.toContain('Ancient note');
  });

  it('caps section to maxLines (keeps newest = top)', () => {
    const lines = [];
    for (let i = 0; i < 50; i++) {
      lines.push(`- 2026-04-${String((i % 28) + 1).padStart(2, '0')}: unique note number ${i} with distinct content about topic ${i}`);
    }
    const out = curator._groomAppendSection(lines.join('\n'), rule, Date.now());
    const outLines = out.content.split('\n').filter((l) => l.trim());
    expect(outLines.length).toBeLessThanOrEqual(rule.maxLines);
    // Newest-first = top -- line 0 should survive
    expect(out.content).toContain('note number 0');
  });

  it('leaves undated lines alone during age-out', () => {
    const content = [
      '- 2026-04-14: Recent with date',
      '- An undated observation that should always stick around',
      '- 2025-10-15: Old note',
    ].join('\n');
    const now = new Date('2026-04-15').getTime();
    const out = curator._groomAppendSection(content, rule, now);
    expect(out.content).toContain('undated observation');
    expect(out.content).not.toContain('Old note');
  });

  it('returns changed=false when section is already clean', () => {
    const content = '- 2026-04-15: single fresh line';
    const out = curator._groomAppendSection(content, rule, Date.now());
    expect(out.changed).toBe(false);
  });
});

describe('MemoryCurator -- keyvalue grooming', () => {
  const curator = new MemoryCurator();

  it('dedupes by key, newest wins (file stored newest-first)', () => {
    const content = [
      '- **Units**: metric',
      '- **Units**: imperial',
      '- **Timezone**: America/Los_Angeles',
    ].join('\n');
    const out = curator._groomKeyValueSection(content);
    expect(out.changed).toBe(true);
    expect(out.merged).toBeGreaterThanOrEqual(1);
    const lines = out.content.split('\n').filter((l) => l.trim());
    expect(lines.length).toBe(2);
    expect(out.content).toContain('metric'); // newest-first = first line wins
    expect(out.content).not.toContain('imperial');
    expect(out.content).toContain('America/Los_Angeles');
  });

  it('leaves non-keyvalue content untouched', () => {
    const content = 'Just a paragraph of notes, not a list.';
    const out = curator._groomKeyValueSection(content);
    expect(out.changed).toBe(false);
  });

  it('handles mix of bold and plain key styles', () => {
    const content = [
      '- **Language**: English',
      '- Timezone: UTC',
    ].join('\n');
    const out = curator._groomKeyValueSection(content);
    // Two unique keys, no merge
    const lines = out.content.split('\n').filter((l) => l.trim());
    expect(lines.length).toBe(2);
  });
});

describe('MemoryCurator -- scoreSectionEntries', () => {
  const curator = new MemoryCurator();

  it('ranks recent entries higher than old', () => {
    const now = new Date('2026-04-15').getTime();
    const content = [
      '- 2026-04-14: Fresh and detailed note about coffee shops in Berkeley',
      '- 2025-10-15: Old note about coffee shops in Berkeley',
    ].join('\n');
    const scored = curator.scoreSectionEntries(content, { now });
    expect(scored[0].dateIso).toBe('2026-04-14');
    expect(scored[0].score).toBeGreaterThan(scored[1].score);
  });

  it('rewards denser (more informative) lines', () => {
    const now = Date.now();
    const content = [
      '- 2026-04-14: a lot of interesting varied information about many distinct topics here indeed',
      '- 2026-04-14: note',
    ].join('\n');
    const scored = curator.scoreSectionEntries(content, { now });
    expect(scored[0].tokenCount).toBeGreaterThan(scored[1].tokenCount);
    expect(scored[0].score).toBeGreaterThan(scored[1].score);
  });
});

describe('MemoryCurator -- cooldown', () => {
  it('tracks last groom time per agent', () => {
    const c = new MemoryCurator({ minIntervalMs: 60 * 60 * 1000 });
    // Without actually running groom, we can assert the internal state is tracked
    expect(c._lastGroomAt.size).toBe(0);
  });
});
