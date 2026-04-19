/**
 * Council Runner -- Unit Tests
 *
 * Verifies end-to-end council execution with the real
 * EvaluationConsolidator. Bid collection is injected via the `getBids`
 * option rather than mocked so tests are deterministic and fast without
 * fighting CommonJS module resolution.
 */

import { describe, it, expect, vi } from 'vitest';

const { runCouncil, DEFAULT_CONFIDENCE_FLOOR } = require('../../lib/exchange/council-runner');

function _mkAgent(id, overrides = {}) {
  return {
    id,
    name: id.replace(/-/g, ' '),
    executionType: 'informational',
    execute: async (_task) => ({ success: true, message: `executed by ${id}` }),
    ...overrides,
  };
}

function _bidCollector(bids) {
  return async () => bids;
}

describe('runCouncil -- input validation', () => {
  it('throws when task is missing', async () => {
    await expect(runCouncil(null, [])).rejects.toThrow(/task is required/);
  });

  it('returns empty result when no agents eligible', async () => {
    const result = await runCouncil({ id: 't1' }, [], { getBids: _bidCollector([]) });
    expect(result.error).toBeDefined();
    expect(result.bidCount).toBe(0);
    expect(result.aggregateScore).toBe(0);
  });

  it('returns empty result when all bids are below floor', async () => {
    const bids = [
      { agentId: 'a', confidence: 0.1, reasoning: 'nope' },
      { agentId: 'b', confidence: 0.2, reasoning: 'no' },
    ];
    const agents = [_mkAgent('a'), _mkAgent('b')];
    const result = await runCouncil({ id: 't1' }, agents, { getBids: _bidCollector(bids) });
    expect(result.error).toBeDefined();
    expect(result.bidCount).toBe(0);
  });
});

describe('runCouncil -- consolidation', () => {
  it('consolidates qualifying bids into an aggregate score', async () => {
    const bids = [
      { agentId: 'a', confidence: 0.9, reasoning: 'strong match' },
      { agentId: 'b', confidence: 0.7, reasoning: 'ok match' },
      { agentId: 'c', confidence: 0.3, reasoning: 'weak' }, // dropped by floor
    ];
    const agents = [_mkAgent('a'), _mkAgent('b'), _mkAgent('c')];
    const result = await runCouncil({ id: 't1', content: 'evaluate this' }, agents, {
      getBids: _bidCollector(bids),
    });

    expect(result.bidCount).toBe(2);
    expect(result.aggregateScore).toBeGreaterThan(70);
    expect(result.agentScores).toHaveLength(2);
  });

  it('uses uniform weighting by default', async () => {
    const bids = [
      { agentId: 'a', confidence: 0.8 },
      { agentId: 'b', confidence: 0.6 },
    ];
    const agents = [_mkAgent('a'), _mkAgent('b')];
    const result = await runCouncil({ id: 't1' }, agents, {
      getBids: _bidCollector(bids),
    });
    expect(result.weightingMode).toBe('uniform');
    // Uniform: simple average of (80, 60) = 70
    expect(result.aggregateScore).toBeCloseTo(70, 0);
  });

  it('passes weightingMode through to the consolidator', async () => {
    const bids = [{ agentId: 'a', confidence: 0.8 }];
    const agents = [_mkAgent('a')];
    const result = await runCouncil({ id: 't1' }, agents, {
      weightingMode: 'contextual',
      getBids: _bidCollector(bids),
    });
    expect(result.weightingMode).toBe('contextual');
  });

  it('surfaces conflicts when per-criterion scores diverge beyond threshold', async () => {
    // Spread of 30 between agents (confidence 0.9 vs 0.6 -> scores 90 vs
    // 60) exceeds the CONFLICT_THRESHOLD of 20 in the consolidator.
    const bids = [
      { agentId: 'high', confidence: 0.9, reasoning: 'great' },
      { agentId: 'low', confidence: 0.6, reasoning: 'so-so' },
    ];
    const agents = [_mkAgent('high'), _mkAgent('low')];
    const task = {
      id: 't1',
      content: 'evaluate',
      criteria: [{ id: 'clarity', label: 'Clarity' }],
    };
    const result = await runCouncil(task, agents, { getBids: _bidCollector(bids) });
    expect(result.conflicts.length).toBeGreaterThan(0);
    expect(result.conflicts[0].criterion).toBe('clarity');
  });
});

describe('runCouncil -- execution policy', () => {
  it('executes only informational agents by default', async () => {
    const bids = [
      { agentId: 'info', confidence: 0.9 },
      { agentId: 'action', confidence: 0.9 },
    ];
    const infoExec = vi.fn(async () => ({ success: true, message: 'info ran' }));
    const actionExec = vi.fn(async () => ({ success: true, message: 'action ran' }));
    const agents = [
      _mkAgent('info', { executionType: 'informational', execute: infoExec }),
      _mkAgent('action', { executionType: 'action', execute: actionExec }),
    ];
    await runCouncil({ id: 't1' }, agents, { getBids: _bidCollector(bids) });
    expect(infoExec).toHaveBeenCalledTimes(1);
    expect(actionExec).not.toHaveBeenCalled();
  });

  it('executes action agents when allowActionAgents is true', async () => {
    const bids = [{ agentId: 'action', confidence: 0.9 }];
    const actionExec = vi.fn(async () => ({ success: true, message: 'action ran' }));
    const agents = [_mkAgent('action', { executionType: 'action', execute: actionExec })];
    await runCouncil({ id: 't1' }, agents, {
      allowActionAgents: true,
      getBids: _bidCollector(bids),
    });
    expect(actionExec).toHaveBeenCalledTimes(1);
  });

  it('respects the maxParallel batch size', async () => {
    let active = 0;
    let peak = 0;
    const slow = async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
      return { success: true, message: 'ok' };
    };
    const bids = Array.from({ length: 5 }, (_, i) => ({ agentId: `a${i}`, confidence: 0.9 }));
    const agents = bids.map((b) => _mkAgent(b.agentId, { execute: slow }));
    await runCouncil({ id: 't1' }, agents, {
      maxParallel: 2,
      getBids: _bidCollector(bids),
    });
    expect(peak).toBeLessThanOrEqual(2);
  });

  it('surfaces execution timeouts without aborting the council', async () => {
    const bids = [{ agentId: 'slow', confidence: 0.9 }];
    const slow = async () => new Promise((r) => setTimeout(() => r({ success: true }), 200));
    const agents = [_mkAgent('slow', { execute: slow })];
    const result = await runCouncil({ id: 't1' }, agents, {
      executionTimeoutMs: 20,
      getBids: _bidCollector(bids),
    });
    // Consolidator still gets the bid; timeout is captured internally.
    expect(result.bidCount).toBe(1);
    expect(result.agentScores.map((a) => a.agentId)).toContain('slow');
  });

  it('accepts a custom executeAgent override', async () => {
    const bids = [{ agentId: 'a', confidence: 0.9 }];
    const agents = [_mkAgent('a')];
    const custom = vi.fn(async () => ({ success: true, message: 'custom' }));
    await runCouncil({ id: 't1' }, agents, {
      executeAgent: custom,
      getBids: _bidCollector(bids),
    });
    expect(custom).toHaveBeenCalledTimes(1);
  });
});

describe('runCouncil -- lifecycle emission', () => {
  it('emits bids-collected, execution, and consolidation events', async () => {
    const bids = [
      { agentId: 'a', confidence: 0.9 },
      { agentId: 'b', confidence: 0.7 },
    ];
    const agents = [_mkAgent('a'), _mkAgent('b')];
    const events = [];
    await runCouncil({ id: 't1' }, agents, {
      onLifecycle: (e) => events.push(e.type),
      getBids: _bidCollector(bids),
    });
    expect(events).toContain('bids-collected');
    expect(events).toContain('execution:started');
    expect(events).toContain('execution:done');
    expect(events).toContain('consolidation:done');
  });

  it('emits consolidation:conflicts only when conflicts exist', async () => {
    const bids = [{ agentId: 'a', confidence: 0.9 }];
    const agents = [_mkAgent('a')];
    const events = [];
    await runCouncil({ id: 't1' }, agents, {
      onLifecycle: (e) => events.push(e.type),
      getBids: _bidCollector(bids),
    });
    expect(events).not.toContain('consolidation:conflicts');
  });

  it('swallows errors thrown by the onLifecycle callback', async () => {
    const bids = [{ agentId: 'a', confidence: 0.9 }];
    const agents = [_mkAgent('a')];
    const result = await runCouncil({ id: 't1' }, agents, {
      onLifecycle: () => { throw new Error('observer boom'); },
      getBids: _bidCollector(bids),
    });
    expect(result.error).toBeUndefined();
    expect(result.bidCount).toBe(1);
  });
});

describe('runCouncil -- bid-collection failure', () => {
  it('returns error result when getBids throws', async () => {
    const result = await runCouncil({ id: 't1' }, [_mkAgent('a')], {
      getBids: async () => { throw new Error('circuit breaker open'); },
    });
    expect(result.error).toBeDefined();
    expect(result.error.reason).toContain('circuit breaker open');
    expect(result.bidCount).toBe(0);
  });
});

describe('DEFAULT_CONFIDENCE_FLOOR', () => {
  it('matches the unified-bidder winner threshold (0.5)', () => {
    expect(DEFAULT_CONFIDENCE_FLOOR).toBe(0.5);
  });
});
