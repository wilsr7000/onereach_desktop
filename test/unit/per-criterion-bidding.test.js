/**
 * Phase 4 -- Per-criterion bidding + bid-time clarification
 *
 * Verifies:
 *   - agent-registry accepts `expertise` and `canProbeAtBidTime` only in
 *     their documented shapes; typos / bad types reject with a clear
 *     error so agents fail loudly.
 *   - council-adapter uses per-criterion scores from a bid when the bid
 *     provides them (instead of fanning overall score).
 *   - council-runner's bid-time clarification loop: when a bid returns
 *     needsClarification AND an askUser handler is installed, the
 *     runner pauses, asks, enriches the task, re-bids, and continues.
 *   - maxClarifyRounds guards against runaway loops.
 *   - Backward compatibility: bids without criteria/needsClarification
 *     behave exactly like before.
 */

import { describe, it, expect, vi } from 'vitest';

const { validateAgent } = require('../../packages/agents/agent-registry');
const { bidToEvaluation, bidsToEvaluations } = require('../../lib/exchange/council-adapter');
const { runCouncil } = require('../../lib/exchange/council-runner');

function _mkAgent(id, overrides = {}) {
  return {
    id,
    name: id,
    description: 'test',
    categories: ['test'],
    keywords: ['t'],
    execute: async () => ({ success: true, message: 'ok' }),
    executionType: 'informational',
    ...overrides,
  };
}

// ==================== agent-registry: expertise validation ====================

describe('agent-registry validateAgent -- expertise', () => {
  it('accepts a well-formed expertise map', () => {
    const a = _mkAgent('a', { expertise: { clarity: 0.9, risk: 0.3 } });
    const r = validateAgent(a, 'a.js');
    expect(r.valid).toBe(true);
  });

  it('rejects non-object expertise', () => {
    const a = _mkAgent('a', { expertise: 'oops' });
    const r = validateAgent(a, 'a.js');
    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toMatch(/expertise must be an object/);
  });

  it('rejects array expertise', () => {
    const a = _mkAgent('a', { expertise: [0.1, 0.2] });
    const r = validateAgent(a, 'a.js');
    expect(r.valid).toBe(false);
  });

  it('rejects scores outside [0,1]', () => {
    const a = _mkAgent('a', { expertise: { clarity: 1.5 } });
    const r = validateAgent(a, 'a.js');
    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toMatch(/\[0\.0, 1\.0\]/);
  });

  it('rejects non-numeric scores', () => {
    const a = _mkAgent('a', { expertise: { clarity: 'high' } });
    const r = validateAgent(a, 'a.js');
    expect(r.valid).toBe(false);
  });

  it('rejects empty criterion keys', () => {
    const a = _mkAgent('a', { expertise: { '': 0.5 } });
    const r = validateAgent(a, 'a.js');
    expect(r.valid).toBe(false);
  });

  it('accepts canProbeAtBidTime=true', () => {
    const a = _mkAgent('a', { canProbeAtBidTime: true });
    expect(validateAgent(a, 'a.js').valid).toBe(true);
  });

  it('accepts canProbeAtBidTime=false (explicit opt-out)', () => {
    const a = _mkAgent('a', { canProbeAtBidTime: false });
    expect(validateAgent(a, 'a.js').valid).toBe(true);
  });

  it('rejects non-boolean canProbeAtBidTime', () => {
    const a = _mkAgent('a', { canProbeAtBidTime: 'yes' });
    const r = validateAgent(a, 'a.js');
    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toMatch(/canProbeAtBidTime must be a boolean/);
  });
});

// ==================== council-adapter: per-criterion scores ====================

describe('council-adapter -- per-criterion scores from bid', () => {
  it('uses bid.criteria scores instead of fanning overall', () => {
    const evaluation = bidToEvaluation(
      {
        agentId: 'a',
        confidence: 0.8,
        reasoning: 'overall reasoning',
        criteria: [
          { id: 'clarity', score: 95, rationale: 'crystal clear' },
          { id: 'risk', score: 30, rationale: 'high downside' },
        ],
      },
      {
        criteria: [
          { id: 'clarity', label: 'Clarity' },
          { id: 'risk', label: 'Risk' },
        ],
      }
    );
    const byName = Object.fromEntries(evaluation.criteria.map((c) => [c.name, c]));
    expect(byName.clarity.score).toBe(95);
    expect(byName.clarity.comment).toBe('crystal clear');
    expect(byName.risk.score).toBe(30);
    expect(byName.risk.comment).toBe('high downside');
  });

  it('falls back to overall when bid.criteria missing for a criterion', () => {
    const evaluation = bidToEvaluation(
      {
        agentId: 'a',
        confidence: 0.7,
        reasoning: 'only overall',
        criteria: [{ id: 'clarity', score: 88 }],
      },
      {
        criteria: [
          { id: 'clarity', label: 'Clarity' },
          { id: 'feasibility', label: 'Feasibility' },
        ],
      }
    );
    const byName = Object.fromEntries(evaluation.criteria.map((c) => [c.name, c]));
    expect(byName.clarity.score).toBe(88);
    // feasibility not in bid -> fanned overall (0.7 * 100 = 70)
    expect(byName.feasibility.score).toBe(70);
    expect(byName.feasibility.comment).toBe('only overall');
  });

  it('clamps per-criterion scores to [0,100]', () => {
    const evaluation = bidToEvaluation(
      {
        agentId: 'a',
        confidence: 0.5,
        criteria: [
          { id: 'hot', score: 9999 },
          { id: 'cold', score: -50 },
        ],
      },
      { criteria: [{ id: 'hot' }, { id: 'cold' }] }
    );
    const byName = Object.fromEntries(evaluation.criteria.map((c) => [c.name, c]));
    expect(byName.hot.score).toBe(100);
    expect(byName.cold.score).toBe(0);
  });

  it('ignores bid.criteria entries without an id', () => {
    const evaluation = bidToEvaluation(
      {
        agentId: 'a',
        confidence: 0.8,
        criteria: [{ id: 'clarity', score: 90 }, { score: 10 }, null],
      },
      { criteria: [{ id: 'clarity' }] }
    );
    expect(evaluation.criteria).toHaveLength(1);
    expect(evaluation.criteria[0].score).toBe(90);
  });

  it('backward-compatible: no bid.criteria => fan overall (Phase 1 behavior)', () => {
    const evaluation = bidToEvaluation(
      { agentId: 'a', confidence: 0.72 },
      { criteria: [{ id: 'clarity' }, { id: 'risk' }] }
    );
    for (const c of evaluation.criteria) {
      expect(c.score).toBe(72);
    }
  });
});

// ==================== council-runner: bid-time clarification loop =============

describe('runCouncil -- bid-time clarification', () => {
  function _bidCollector(rounds) {
    // rounds is an array of bid-sets. Each call pops the next one.
    // Lets us simulate a bid round that requests clarification,
    // followed by a rebid after the user answers.
    let i = 0;
    return async (_agents, taskArg) => {
      const round = rounds[Math.min(i, rounds.length - 1)];
      i += 1;
      // Let the test also observe the task at each round by stashing a
      // copy onto the returned array (non-enumerable so downstream code
      // doesn't see it).
      Object.defineProperty(round, '__observedTask', {
        value: taskArg,
        configurable: true,
      });
      return round;
    };
  }

  it('pauses, asks, resumes when a bid returns needsClarification', async () => {
    const askUser = vi.fn(async () => 'I mean the 2025 review');
    const rounds = [
      [
        {
          agentId: 'a',
          confidence: 0.5,
          reasoning: 'ambiguous year',
          needsClarification: { question: 'Which year?' },
        },
      ],
      [{ agentId: 'a', confidence: 0.9, reasoning: 'clarified' }],
    ];
    const getBids = _bidCollector(rounds);
    const events = [];
    const result = await runCouncil(
      { id: 't', content: 'evaluate' },
      [_mkAgent('a')],
      {
        getBids,
        askUser,
        onLifecycle: (e) => events.push(e),
      }
    );
    expect(askUser).toHaveBeenCalledTimes(1);
    expect(askUser.mock.calls[0][0].question).toBe('Which year?');
    expect(result.bidCount).toBe(1);
    expect(result.clarifyRounds).toBe(1);

    const clarifyEvent = events.find((e) => e.type === 'bid:needs-clarification');
    expect(clarifyEvent).toBeTruthy();
    expect(clarifyEvent.fromAgentId).toBe('a');

    // The second collect-bids call should have received a task with
    // the clarification appended.
    const task2 = rounds[1].__observedTask;
    expect(task2.metadata.clarifications).toHaveLength(1);
    expect(task2.metadata.clarifications[0].answer).toBe('I mean the 2025 review');
    expect(task2.metadata.conversationText).toContain('Which year?');
  });

  it('skips clarification when askUser is not provided', async () => {
    const rounds = [
      [{
        agentId: 'a',
        confidence: 0.7,
        reasoning: 'asks a question',
        needsClarification: { question: 'Which year?' },
      }],
    ];
    const getBids = _bidCollector(rounds);
    const result = await runCouncil(
      { id: 't', content: 'evaluate' },
      [_mkAgent('a')],
      { getBids }
    );
    // No askUser -> no pause. Bid is used as-is.
    expect(result.clarifyRounds).toBe(0);
    expect(result.bidCount).toBe(1);
  });

  it('respects maxClarifyRounds (stops after N rounds even if agents keep asking)', async () => {
    const askUser = vi.fn(async () => 'still ambiguous');
    // Every round returns the same clarification request.
    const getBids = async () => [{
      agentId: 'a',
      confidence: 0.7,
      reasoning: 'keeps asking',
      needsClarification: { question: 'Which one?' },
    }];
    const events = [];
    const result = await runCouncil(
      { id: 't', content: 'evaluate' },
      [_mkAgent('a')],
      {
        getBids,
        askUser,
        maxClarifyRounds: 2,
        onLifecycle: (e) => events.push(e),
      }
    );
    expect(askUser).toHaveBeenCalledTimes(2);
    expect(result.clarifyRounds).toBe(2);
    const clarifyEvents = events.filter((e) => e.type === 'bid:needs-clarification');
    expect(clarifyEvents).toHaveLength(2);
  });

  it('breaks out early when askUser returns an empty answer', async () => {
    const askUser = vi.fn(async () => '  ');
    const getBids = async () => [{
      agentId: 'a',
      confidence: 0.6,
      reasoning: 'asks',
      needsClarification: { question: 'Which?' },
    }];
    const result = await runCouncil(
      { id: 't', content: 'x' },
      [_mkAgent('a')],
      { getBids, askUser, maxClarifyRounds: 5 }
    );
    expect(askUser).toHaveBeenCalledTimes(1);
    expect(result.clarifyRounds).toBe(1);
    expect(result.bidCount).toBe(1);
  });

  it('tolerates askUser throwing (treated as no answer)', async () => {
    const askUser = vi.fn(async () => { throw new Error('modal cancelled'); });
    const getBids = async () => [{
      agentId: 'a',
      confidence: 0.6,
      reasoning: 'asks',
      needsClarification: { question: 'Which?' },
    }];
    const result = await runCouncil(
      { id: 't', content: 'x' },
      [_mkAgent('a')],
      { getBids, askUser }
    );
    expect(result.bidCount).toBe(1);
    expect(result.clarifyRounds).toBe(1);
  });

  it('surfaces the clarification-enriched content through to executors', async () => {
    const askUser = async () => 'the answer';
    const rounds = [
      [{
        agentId: 'a',
        confidence: 0.6,
        reasoning: 'ask',
        needsClarification: { question: 'Q?' },
      }],
      [{ agentId: 'a', confidence: 0.9, reasoning: 'clear' }],
    ];
    const getBids = _bidCollector(rounds);

    let execSeenTask = null;
    const execAgent = async (agent, taskArg) => {
      execSeenTask = taskArg;
      return { success: true, message: 'ok' };
    };
    await runCouncil(
      { id: 't', content: 'evaluate' },
      [_mkAgent('a')],
      { getBids, askUser, executeAgent: execAgent }
    );
    expect(execSeenTask.metadata.clarifications).toBeTruthy();
    expect(execSeenTask.metadata.clarifications[0].answer).toBe('the answer');
  });
});
