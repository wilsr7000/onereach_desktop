/**
 * Bid Overlap Penalty tests (Phase 4 self-learning arbitration)
 *
 * Run: npx vitest run test/unit/bid-overlap.test.js
 */

import { describe, it, expect } from 'vitest';

const {
  tokenize,
  tokenSetJaccard,
  applyOverlapPenalty,
  wouldChangeWinner,
  DEFAULT_OVERLAP_CONFIG,
  DEFAULT_THRESHOLD,
  DEFAULT_MAX_PENALTY,
  DEFAULT_STOPWORDS,
} = require('../../lib/hud-core/bid-overlap');

describe('tokenize', () => {
  it('lowercases and strips punctuation', () => {
    const t = tokenize('I report current time, from system clock!', new Set());
    expect(t.has('report')).toBe(true);
    expect(t.has('current')).toBe(true);
    expect(t.has('time')).toBe(true);
    expect(t.has('clock')).toBe(true);
    expect(t.has(',')).toBe(false);
    expect(t.has('!')).toBe(false);
  });

  it('removes stopwords', () => {
    const t = tokenize('I have the agent for it', DEFAULT_STOPWORDS);
    expect(t.has('i')).toBe(false);
    expect(t.has('have')).toBe(false);
    expect(t.has('the')).toBe(false);
    expect(t.has('agent')).toBe(false);
    expect(t.has('for')).toBe(false);
    expect(t.has('it')).toBe(false);
  });

  it('returns empty set for non-string / empty input', () => {
    expect(tokenize(null).size).toBe(0);
    expect(tokenize('').size).toBe(0);
    expect(tokenize(42).size).toBe(0);
  });
});

describe('tokenSetJaccard', () => {
  it('returns 1 for identical strings', () => {
    expect(tokenSetJaccard('hello world', 'hello world')).toBe(1);
  });

  it('returns 0 for completely disjoint strings', () => {
    expect(tokenSetJaccard('cat dog mouse', 'apple banana cherry', new Set())).toBe(0);
  });

  it('returns 0 for two empty strings', () => {
    expect(tokenSetJaccard('', '')).toBe(0);
  });

  it('handles partial overlap correctly', () => {
    const j = tokenSetJaccard('cat dog mouse', 'cat fish bird', new Set());
    // intersect={cat}, union={cat,dog,mouse,fish,bird} -> 1/5 = 0.2
    expect(j).toBeCloseTo(0.2, 5);
  });

  it('detects high overlap on same-intent reasonings', () => {
    const a = 'I report current time';
    const b = 'I report the current time of day';
    const j = tokenSetJaccard(a, b, DEFAULT_STOPWORDS);
    expect(j).toBeGreaterThan(0.4);
  });

  it('detects low overlap on disjoint-intent reasonings', () => {
    const a = 'I play music from Spotify';
    const b = 'I check calendar events for today';
    const j = tokenSetJaccard(a, b, DEFAULT_STOPWORDS);
    expect(j).toBeLessThan(0.2);
  });
});

describe('applyOverlapPenalty', () => {
  function makeBid(agentId, confidence, reasoning) {
    return { agentId, confidence, score: confidence, reasoning };
  }

  it('returns input unchanged when fewer than 2 bids', () => {
    expect(applyOverlapPenalty([])).toEqual([]);
    expect(applyOverlapPenalty([makeBid('a', 0.9, 'r')])).toHaveLength(1);
  });

  it('does not penalise the top-ranked bid', () => {
    const bids = [
      makeBid('a', 0.9, 'I report current time'),
      makeBid('b', 0.8, 'I report current time'), // identical
    ];
    const out = applyOverlapPenalty(bids, { threshold: 0.3, maxPenalty: 0.5 });
    expect(out.find((x) => x.agentId === 'a').confidence).toBe(0.9); // untouched
    expect(out.find((x) => x.agentId === 'a')._overlapAdjustment).toBeUndefined();
  });

  it('penalises a lower-ranked bid with high overlap', () => {
    const bids = [
      makeBid('a', 0.9, 'I report current time'),
      makeBid('b', 0.8, 'I report current time'), // identical -> max overlap
    ];
    const out = applyOverlapPenalty(bids, { threshold: 0.3, maxPenalty: 0.5 });
    const bAdj = out.find((x) => x.agentId === 'b');
    expect(bAdj.confidence).toBeLessThan(0.8);
    expect(bAdj._overlapAdjustment).toBeDefined();
    expect(bAdj._overlapAdjustment.against).toBe('a');
    expect(bAdj._overlapAdjustment.jaccard).toBe(1);
  });

  it('does not penalise when overlap is below threshold', () => {
    const bids = [
      makeBid('a', 0.9, 'I play music from Spotify'),
      makeBid('b', 0.8, 'I check calendar events for today'),
    ];
    const out = applyOverlapPenalty(bids, { threshold: 0.4, maxPenalty: 0.5 });
    expect(out.find((x) => x.agentId === 'a').confidence).toBe(0.9);
    expect(out.find((x) => x.agentId === 'b').confidence).toBe(0.8);
    expect(out.find((x) => x.agentId === 'b')._overlapAdjustment).toBeUndefined();
  });

  it('uses alphabetical tiebreak on equal confidences', () => {
    const bids = [
      makeBid('zebra', 0.8, 'I report current time'),
      makeBid('alpha', 0.8, 'I report current time'),
    ];
    const out = applyOverlapPenalty(bids, { threshold: 0.3, maxPenalty: 0.5 });
    // alpha sorts first -> not penalised; zebra is the lower-ranked.
    expect(out.find((x) => x.agentId === 'alpha')._overlapAdjustment).toBeUndefined();
    expect(out.find((x) => x.agentId === 'zebra')._overlapAdjustment).toBeDefined();
  });

  it('three bids: middle-confidence overlapping bid penalised, distinct one untouched', () => {
    const bids = [
      makeBid('a', 0.9, 'I report current time from system clock'),
      makeBid('b', 0.7, 'I report the current time of day'), // overlaps a
      makeBid('c', 0.6, 'I generate creative writing pieces'), // disjoint
    ];
    const out = applyOverlapPenalty(bids, { threshold: 0.3, maxPenalty: 0.5 });
    expect(out.find((x) => x.agentId === 'b')._overlapAdjustment).toBeDefined();
    expect(out.find((x) => x.agentId === 'c')._overlapAdjustment).toBeUndefined();
  });

  it('preserves score field consistent with confidence multiplier', () => {
    const bids = [
      { agentId: 'a', confidence: 0.9, score: 0.85, reasoning: 'I report time' },
      { agentId: 'b', confidence: 0.8, score: 0.75, reasoning: 'I report time' },
    ];
    const out = applyOverlapPenalty(bids, { threshold: 0.3, maxPenalty: 0.5 });
    const bAdj = out.find((x) => x.agentId === 'b');
    // Score should shrink by the same factor as confidence.
    const factor = bAdj._overlapAdjustment.factor;
    expect(bAdj.confidence).toBeCloseTo(0.8 * factor, 5);
    expect(bAdj.score).toBeCloseTo(0.75 * factor, 5);
  });

  it('handles empty / missing reasoning without crashing', () => {
    const bids = [
      makeBid('a', 0.9, 'time'),
      makeBid('b', 0.8, ''),
      { agentId: 'c', confidence: 0.7 }, // no reasoning field
    ];
    const out = applyOverlapPenalty(bids);
    expect(out).toHaveLength(3);
    // Empty/missing reasoning -> Jaccard=0 -> no penalty.
    expect(out.find((x) => x.agentId === 'b')._overlapAdjustment).toBeUndefined();
    expect(out.find((x) => x.agentId === 'c')._overlapAdjustment).toBeUndefined();
  });

  it('does not mutate the input array or any element', () => {
    const bids = [
      makeBid('a', 0.9, 'I report current time'),
      makeBid('b', 0.8, 'I report current time'),
    ];
    const before = JSON.stringify(bids);
    applyOverlapPenalty(bids, { threshold: 0.3, maxPenalty: 0.5 });
    expect(JSON.stringify(bids)).toBe(before);
  });

  it('clamps config out of range', () => {
    const bids = [
      makeBid('a', 0.9, 'I report current time'),
      makeBid('b', 0.8, 'I report current time'),
    ];
    const out = applyOverlapPenalty(bids, { threshold: 5, maxPenalty: 5 });
    // threshold clamped to 1 -> no overlap above 1 -> no penalty.
    expect(out.find((x) => x.agentId === 'b')._overlapAdjustment).toBeUndefined();
  });

  it('confidence-floor saturation: 0.95 with full overlap and maxPenalty=0.5 lands at 0.475', () => {
    const bids = [
      makeBid('a', 0.95, 'identical reasoning'),
      makeBid('b', 0.95, 'identical reasoning'),
    ];
    const out = applyOverlapPenalty(bids, { threshold: 0.3, maxPenalty: 0.5 });
    // Alphabetical: 'a' wins, 'b' penalised.
    const bAdj = out.find((x) => x.agentId === 'b');
    expect(bAdj.confidence).toBeCloseTo(0.95 * 0.5, 5); // 0.475
    // Threshold=0.3, maxPenalty=0.5, jaccard=1 -> penalty=0.5 -> factor=0.5.
  });
});

describe('wouldChangeWinner', () => {
  function makeBid(agentId, confidence) {
    return { agentId, confidence, score: confidence, reasoning: 'r' };
  }

  it('returns false when top winner is unchanged', () => {
    const raw = [makeBid('a', 0.9), makeBid('b', 0.8)];
    expect(wouldChangeWinner(raw, raw)).toBe(false);
  });

  it('returns true when adjustment flips the top', () => {
    const raw = [makeBid('a', 0.9), makeBid('b', 0.8)];
    const adjusted = [makeBid('a', 0.4), makeBid('b', 0.8)]; // a got shrunk
    expect(wouldChangeWinner(raw, adjusted)).toBe(true);
  });

  it('returns false on empty arrays', () => {
    expect(wouldChangeWinner([], [])).toBe(false);
  });
});

describe('exports', () => {
  it('DEFAULT_OVERLAP_CONFIG is frozen with conservative seed values', () => {
    expect(DEFAULT_THRESHOLD).toBe(0.5);
    expect(DEFAULT_MAX_PENALTY).toBe(0.3);
    expect(Object.isFrozen(DEFAULT_OVERLAP_CONFIG)).toBe(true);
  });
});
