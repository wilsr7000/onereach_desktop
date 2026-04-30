/**
 * MemoryRetriever tests
 *
 * Focused on the pure scoring function. The cached agent-memory
 * integration is covered via e2e flows.
 *
 * Run: npx vitest run test/unit/agent-learning/memory-retriever.test.js
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../lib/log-event-queue', () => ({
  getLogQueue: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
}));

const { scoreLine, MemoryRetriever } = require('../../../lib/agent-learning/memory-retriever');

describe('scoreLine', () => {
  it('ranks relevant lines above irrelevant ones', () => {
    const qTokens = new Set(['coffee', 'berkeley']);
    const rel = scoreLine('- 2026-04-15: user loves coffee shops in berkeley', qTokens, {});
    const irr = scoreLine('- 2026-04-15: user likes quantum physics', qTokens, {});
    expect(rel.score).toBeGreaterThan(irr.score);
  });

  it('weights recent lines higher than old ones', () => {
    const qTokens = new Set(['coffee']);
    const now = new Date('2026-04-15').getTime();
    const recent = scoreLine('- 2026-04-14: coffee note', qTokens, { now });
    const old = scoreLine('- 2025-04-14: coffee note', qTokens, { now });
    expect(recent.score).toBeGreaterThan(old.score);
  });

  it('pin marker gives a reliable boost', () => {
    const qTokens = new Set(['coffee']);
    const now = new Date('2026-04-15').getTime();
    const baseline = scoreLine('- 2026-04-14: coffee tip', qTokens, { now });
    const pinned = scoreLine('- 2026-04-14: coffee tip [pin]', qTokens, { now });
    expect(pinned.score).toBeGreaterThan(baseline.score);
    expect(pinned.pin).toBe(1);
  });

  it('returns 0 relevance when no query tokens match', () => {
    const qTokens = new Set(['tomato']);
    const r = scoreLine('- 2026-04-14: coffee shops in Berkeley', qTokens, {});
    expect(r.rel).toBe(0);
  });

  it('caps density at 1.0 for very long lines', () => {
    const qTokens = new Set(['coffee']);
    const longLine = Array(60).fill('extra').join(' ') + ' coffee';
    const r = scoreLine(longLine, qTokens, {});
    expect(r.density).toBeLessThanOrEqual(1.0);
  });
});

describe('MemoryRetriever -- cache invalidation', () => {
  it('invalidate clears the per-agent cache', () => {
    const r = new MemoryRetriever();
    r._cache.set('a1', { at: Date.now(), lines: [{ line: 'x', sectionName: 'Notes' }] });
    expect(r._cache.has('a1')).toBe(true);
    r.invalidate('a1');
    expect(r._cache.has('a1')).toBe(false);
  });

  it('invalidate() with no id clears everything', () => {
    const r = new MemoryRetriever();
    r._cache.set('a', { at: Date.now(), lines: [] });
    r._cache.set('b', { at: Date.now(), lines: [] });
    r.invalidate();
    expect(r._cache.size).toBe(0);
  });
});
