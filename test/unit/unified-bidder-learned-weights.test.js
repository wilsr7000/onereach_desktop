/**
 * unified-bidder.selectWinner -- Phase 2 Learned Weights
 *
 * Verifies the learned-weight multiplier hook:
 *   - OFF by default (flag off): behavior is bit-for-bit identical to
 *     the pre-Phase-2 selectWinner.
 *   - ON (flag on): effective confidence = rawConfidence * weight,
 *     clamped to [0,1], re-sorted. Bid annotations carry both values.
 *   - Graceful degradation when the learning facade throws: falls
 *     through to the raw-confidence path.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
const path = require('path');

const { selectWinner } = require('../../packages/agents/unified-bidder');

// Swap the learning facade's getLearnedWeight via require.cache so the
// bidder's lazy require picks up our fake. Matches the pattern used in
// the council-runner / learning-facade tests.
const FACADE_REL_FROM_BIDDER = '../../lib/learning';
const FACADE_ABS = path.resolve(__dirname, '../../lib/learning/index.js');
const FLAGS_ABS = path.resolve(__dirname, '../../lib/agent-system-flags.js');

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

function _installFlagsFake(enabled) {
  require.cache[FLAGS_ABS] = {
    id: FLAGS_ABS,
    filename: FLAGS_ABS,
    loaded: true,
    exports: {
      isAgentFlagEnabled: (name) => (name === 'learnedWeights' ? enabled : false),
    },
  };
}

beforeEach(() => {
  delete require.cache[FACADE_ABS];
  delete require.cache[FLAGS_ABS];
});

afterEach(() => {
  delete require.cache[FACADE_ABS];
  delete require.cache[FLAGS_ABS];
});

// ---- Flag off / no weighting (baseline) ------------------------------

describe('selectWinner -- flag off (baseline)', () => {
  it('picks highest-confidence bid >= 0.5', () => {
    _installFlagsFake(false);
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
    _installFlagsFake(false);
    const bids = [
      { agentId: 'a', confidence: 0.45 },
      { agentId: 'b', confidence: 0.3 },
    ];
    const { winner, backups } = selectWinner(bids);
    expect(winner).toBe(null);
    expect(backups).toEqual([]);
  });

  it('empty bids returns null winner', () => {
    _installFlagsFake(false);
    expect(selectWinner([])).toEqual({ winner: null, backups: [] });
    expect(selectWinner(null)).toEqual({ winner: null, backups: [] });
  });

  it('does NOT annotate bids with learned-weight fields when flag is off', () => {
    _installFlagsFake(false);
    const bids = [{ agentId: 'a', confidence: 0.85 }];
    const { winner } = selectWinner(bids);
    expect(winner._learnedWeight).toBeUndefined();
    expect(winner._effectiveConfidence).toBeUndefined();
  });
});

// ---- Flag on / weighted ---------------------------------------------

describe('selectWinner -- flag on (learned weights)', () => {
  it('annotates winners with raw + effective confidence and weight', () => {
    _installFlagsFake(true);
    _installLearningFake({ a: 1.2 });
    const bids = [{ agentId: 'a', confidence: 0.6 }];
    const { winner } = selectWinner(bids);
    expect(winner._learnedWeight).toBe(1.2);
    expect(winner._rawConfidence).toBeCloseTo(0.6, 5);
    expect(winner._effectiveConfidence).toBeCloseTo(0.72, 5);
    expect(winner.confidence).toBeCloseTo(0.72, 5);
  });

  it('clamps effective confidence to [0,1]', () => {
    _installFlagsFake(true);
    _installLearningFake({ hot: 1.5 });
    const bids = [{ agentId: 'hot', confidence: 0.9 }];
    const { winner } = selectWinner(bids);
    // 0.9 * 1.5 = 1.35 -> clamped to 1.0
    expect(winner._effectiveConfidence).toBe(1);
    expect(winner.confidence).toBe(1);
  });

  it('re-sorts bids when weighting changes relative order', () => {
    _installFlagsFake(true);
    // A has slightly higher raw confidence, but B has a much better weight.
    // Raw: A=0.70, B=0.65. Weighted: A=0.70*0.8=0.56, B=0.65*1.3=0.845.
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
    _installFlagsFake(true);
    // 0.55 raw * 0.8 weight = 0.44 effective -> below threshold, no winner.
    _installLearningFake({ a: 0.8 });
    const bids = [{ agentId: 'a', confidence: 0.55 }];
    const { winner } = selectWinner(bids);
    expect(winner).toBe(null);
  });

  it('promotes a marginal bid whose weighted confidence clears 0.5', () => {
    _installFlagsFake(true);
    // 0.45 raw * 1.2 weight = 0.54 effective -> just clears threshold.
    _installLearningFake({ a: 1.2 });
    const bids = [{ agentId: 'a', confidence: 0.45 }];
    const { winner } = selectWinner(bids);
    expect(winner).not.toBe(null);
    expect(winner.agentId).toBe('a');
  });

  it('uses 1.0 weight for agents without historical data', () => {
    _installFlagsFake(true);
    _installLearningFake({}); // no entries -> facade returns 1.0
    const bids = [{ agentId: 'unseen', confidence: 0.8 }];
    const { winner } = selectWinner(bids);
    expect(winner._learnedWeight).toBe(1.0);
    expect(winner.confidence).toBeCloseTo(0.8, 5);
  });
});

// ---- Graceful degradation -------------------------------------------

describe('selectWinner -- graceful degradation', () => {
  it('falls back to raw-confidence path when the facade throws', () => {
    _installFlagsFake(true);
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
    _installFlagsFake(true);
    _installLearningFake({ legacy: 1.25 });
    const bids = [
      // Old-style bid shape that exchange surfaces sometimes: { agent, confidence }
      { agent: { id: 'legacy' }, confidence: 0.6 },
    ];
    const { winner } = selectWinner(bids);
    expect(winner._learnedWeight).toBe(1.25);
    expect(winner._effectiveConfidence).toBeCloseTo(0.75, 5);
  });
});
