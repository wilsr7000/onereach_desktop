/**
 * unified-bidder.selectWinner -- Learned Weights
 *
 * Verifies the learned-weight multiplier hook (unconditional in v4.9.0;
 * the flag-off path was retired when Agent System v2 became the system).
 *
 *   - With no historical data -> weight is 1.0, effective = raw, winner
 *     selection is identical to the pre-v2 baseline.
 *   - With learning data -> effective = raw * weight, re-sorted, clamped
 *     to [0,1]. Every bid carries raw + effective + weight annotations.
 *   - Graceful degradation when the learning facade throws: falls
 *     through to the raw-confidence path, no annotations.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
const path = require('path');

const { selectWinner } = require('../../packages/agents/unified-bidder');

// Swap the learning facade's getLearnedWeight via require.cache so the
// bidder's lazy require picks up our fake. Matches the pattern used in
// the council-runner / learning-facade tests.
const FACADE_ABS = path.resolve(__dirname, '../../lib/learning/index.js');

function _installLearningFake(weightsById) {
  require.cache[FACADE_ABS] = {
    id: FACADE_ABS,
    filename: FACADE_ABS,
    loaded: true,
    exports: {
      getLearnedWeight: (agentId) => {
        if (weightsById === 'throw') throw new Error('facade exploded');
        return weightsById[agentId] ?? 1.0;
      },
    },
  };
}

beforeEach(() => {
  delete require.cache[FACADE_ABS];
});

afterEach(() => {
  delete require.cache[FACADE_ABS];
});

// ---- Baseline (no learning data) ------------------------------------

describe('selectWinner -- baseline (no learning data)', () => {
  it('picks highest-confidence bid >= 0.5', () => {
    _installLearningFake({}); // all agents return weight=1.0
    const bids = [
      { agentId: 'a', confidence: 0.85 },
      { agentId: 'b', confidence: 0.6 },
      { agentId: 'c', confidence: 0.4 },
    ];
    const { winner, backups } = selectWinner(bids);
    expect(winner.agentId).toBe('a');
    expect(backups.map((b) => b.agentId)).toEqual(['b']);
  });

  it('returns no winner when no bid clears 0.5', () => {
    _installLearningFake({});
    const bids = [
      { agentId: 'a', confidence: 0.45 },
      { agentId: 'b', confidence: 0.3 },
    ];
    const { winner, backups } = selectWinner(bids);
    expect(winner).toBe(null);
    expect(backups).toEqual([]);
  });

  it('empty bids returns null winner', () => {
    expect(selectWinner([])).toEqual({ winner: null, backups: [] });
    expect(selectWinner(null)).toEqual({ winner: null, backups: [] });
  });

  it('annotates bids with weight=1.0 and effective=raw when no data', () => {
    _installLearningFake({}); // no history -> weight 1.0
    const bids = [{ agentId: 'a', confidence: 0.85 }];
    const { winner } = selectWinner(bids);
    expect(winner._learnedWeight).toBe(1.0);
    expect(winner._rawConfidence).toBeCloseTo(0.85, 5);
    expect(winner._effectiveConfidence).toBeCloseTo(0.85, 5);
  });
});

// ---- With learning data ---------------------------------------------

describe('selectWinner -- with learning data', () => {
  it('annotates winners with raw + effective confidence and weight', () => {
    _installLearningFake({ a: 1.2 });
    const bids = [{ agentId: 'a', confidence: 0.6 }];
    const { winner } = selectWinner(bids);
    expect(winner._learnedWeight).toBe(1.2);
    expect(winner._rawConfidence).toBeCloseTo(0.6, 5);
    expect(winner._effectiveConfidence).toBeCloseTo(0.72, 5);
    expect(winner.confidence).toBeCloseTo(0.72, 5);
  });

  it('clamps effective confidence to [0,1]', () => {
    _installLearningFake({ hot: 1.5 });
    const bids = [{ agentId: 'hot', confidence: 0.9 }];
    const { winner } = selectWinner(bids);
    // 0.9 * 1.5 = 1.35 -> clamped to 1.0
    expect(winner._effectiveConfidence).toBe(1);
    expect(winner.confidence).toBe(1);
  });

  it('re-sorts bids when weighting changes relative order', () => {
    // A: raw 0.70 * 0.8 = 0.56; B: raw 0.65 * 1.3 = 0.845
    _installLearningFake({ a: 0.8, b: 1.3 });
    const bids = [
      { agentId: 'a', confidence: 0.7 },
      { agentId: 'b', confidence: 0.65 },
    ];
    const { winner, backups } = selectWinner(bids);
    expect(winner.agentId).toBe('b');
    expect(backups.map((x) => x.agentId)).toEqual(['a']);
  });

  it('drops a bid whose weighted confidence falls below 0.5', () => {
    // 0.55 raw * 0.8 weight = 0.44 effective -> no winner
    _installLearningFake({ a: 0.8 });
    const bids = [{ agentId: 'a', confidence: 0.55 }];
    const { winner } = selectWinner(bids);
    expect(winner).toBe(null);
  });

  it('promotes a marginal bid whose weighted confidence clears 0.5', () => {
    // 0.45 raw * 1.2 weight = 0.54 effective -> clears threshold
    _installLearningFake({ a: 1.2 });
    const bids = [{ agentId: 'a', confidence: 0.45 }];
    const { winner } = selectWinner(bids);
    expect(winner).not.toBe(null);
    expect(winner.agentId).toBe('a');
  });
});

// ---- Graceful degradation -------------------------------------------

describe('selectWinner -- graceful degradation', () => {
  it('falls back to raw-confidence path when the facade throws', () => {
    _installLearningFake('throw');
    const bids = [
      { agentId: 'a', confidence: 0.8 },
      { agentId: 'b', confidence: 0.6 },
    ];
    const { winner, backups } = selectWinner(bids);
    expect(winner.agentId).toBe('a');
    expect(backups.map((b) => b.agentId)).toEqual(['b']);
    // No annotations because the weighting branch failed
    expect(winner._learnedWeight).toBeUndefined();
  });

  it('handles agents whose id lives on bid.agent.id', () => {
    _installLearningFake({ legacy: 1.25 });
    const bids = [
      // Old-style bid shape: { agent: { id }, confidence }
      { agent: { id: 'legacy' }, confidence: 0.6 },
    ];
    const { winner } = selectWinner(bids);
    expect(winner._learnedWeight).toBe(1.25);
    expect(winner._effectiveConfidence).toBeCloseTo(0.75, 5);
  });
});
