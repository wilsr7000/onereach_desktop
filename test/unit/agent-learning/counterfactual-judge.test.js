/**
 * Counterfactual Judge tests (Phase 2 self-learning arbitration)
 *
 * Run: npx vitest run test/unit/agent-learning/counterfactual-judge.test.js
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'events';

vi.mock('../../../lib/log-event-queue', () => ({
  getLogQueue: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
}));

const {
  CounterfactualJudge,
  VALID_JUDGMENTS,
} = require('../../../lib/agent-learning/counterfactual-judge');

const recorder = require('../../../lib/agent-learning/decision-recorder');

// ============================================================
// Test fixtures
// ============================================================

function makeBids() {
  return [
    {
      agentId: 'time-agent',
      agentName: 'Time Agent',
      confidence: 0.85,
      score: 0.85,
      reasoning: 'I report current time from system clock',
      won: true,
    },
    {
      agentId: 'calendar-agent',
      agentName: 'Calendar Agent',
      confidence: 0.7,
      score: 0.7,
      reasoning: 'I handle calendar queries which often involve current time',
      won: false,
    },
  ];
}

function makeAi(response) {
  return {
    json: vi.fn(async () => response),
  };
}

// ============================================================
// shouldJudge -- synchronous gates
// ============================================================

describe('CounterfactualJudge.shouldJudge', () => {
  it('returns false when fewer than 2 bidders', () => {
    const judge = new CounterfactualJudge({ sampleRate: 1.0 });
    expect(judge.shouldJudge({
      task: { id: 't', content: 'q' },
      bids: [{ agentId: 'a', confidence: 1, reasoning: 'r' }],
      winnerAgentId: 'a',
      winnerAnswer: 'A',
    })).toBe(false);
  });

  it('returns false when no winner answer', () => {
    const judge = new CounterfactualJudge({ sampleRate: 1.0 });
    expect(judge.shouldJudge({
      task: { id: 't', content: 'q' },
      bids: makeBids(),
      winnerAgentId: 'time-agent',
      winnerAnswer: '',
    })).toBe(false);
  });

  it('returns false when sample rate excludes this call', () => {
    const judge = new CounterfactualJudge({
      sampleRate: 0.1,
      random: () => 0.5, // > 0.1, should skip
    });
    expect(judge.shouldJudge({
      task: { id: 't', content: 'q' },
      bids: makeBids(),
      winnerAgentId: 'time-agent',
      winnerAnswer: 'It is 3:14 PM',
    })).toBe(false);
  });

  it('returns true when sample rate includes this call', () => {
    const judge = new CounterfactualJudge({
      sampleRate: 0.5,
      random: () => 0.1, // < 0.5
    });
    expect(judge.shouldJudge({
      task: { id: 't', content: 'q' },
      bids: makeBids(),
      winnerAgentId: 'time-agent',
      winnerAnswer: 'It is 3:14 PM',
    })).toBe(true);
  });
});

// ============================================================
// _pickRunnerUp
// ============================================================

describe('CounterfactualJudge runner-up selection', () => {
  it('picks the highest-confidence non-winning bid with reasoning', async () => {
    const judge = new CounterfactualJudge({
      ai: makeAi({ judgment: 'winner-better', confidence: 0.8, rationale: 'fine' }),
      random: () => 0,
    });
    const bids = [
      { agentId: 'winner', confidence: 0.9, reasoning: 'I won', won: true },
      { agentId: 'low', confidence: 0.5, reasoning: 'I am low', won: false },
      { agentId: 'mid', confidence: 0.7, reasoning: 'I am mid', won: false },
    ];
    const r = await judge.judge({
      task: { id: 't1', content: 'q' },
      bids,
      winnerAgentId: 'winner',
      winnerAnswer: 'an answer',
    });
    expect(r.runnerUpAgentId).toBe('mid');
  });

  it('skips bids with empty reasoning when picking runner-up', async () => {
    const judge = new CounterfactualJudge({
      ai: makeAi({ judgment: 'same', confidence: 0.5, rationale: '' }),
      random: () => 0,
    });
    const bids = [
      { agentId: 'winner', confidence: 0.9, reasoning: 'I won', won: true },
      { agentId: 'empty', confidence: 0.85, reasoning: '', won: false },
      { agentId: 'has-text', confidence: 0.6, reasoning: 'I have reasoning', won: false },
    ];
    const r = await judge.judge({
      task: { id: 't', content: 'q' },
      bids,
      winnerAgentId: 'winner',
      winnerAnswer: 'an answer',
    });
    expect(r.runnerUpAgentId).toBe('has-text');
  });

  it('returns skipped:no-runner-up when all non-winners have empty reasoning', async () => {
    const judge = new CounterfactualJudge({
      ai: makeAi({ judgment: 'winner-better', confidence: 0.8 }),
      random: () => 0,
    });
    const bids = [
      { agentId: 'winner', confidence: 0.9, reasoning: 'I won', won: true },
      { agentId: 'empty', confidence: 0.85, reasoning: '', won: false },
    ];
    const r = await judge.judge({
      task: { id: 't', content: 'q' },
      bids,
      winnerAgentId: 'winner',
      winnerAnswer: 'an answer',
    });
    expect(r.skipped).toBe(true);
    expect(r.reason).toBe('no-runner-up');
  });
});

// ============================================================
// judge() -- happy path + LLM normalization
// ============================================================

describe('CounterfactualJudge.judge', () => {
  it('returns a normalized record on a valid LLM response', async () => {
    const judge = new CounterfactualJudge({
      ai: makeAi({ judgment: 'runner-up-better', confidence: 0.8, rationale: 'better answer' }),
      random: () => 0,
    });
    const r = await judge.judge({
      task: { id: 't1', content: 'what time is it' },
      bids: makeBids(),
      winnerAgentId: 'time-agent',
      winnerAnswer: 'It is 3:14 PM',
    });
    expect(r.skipped).toBeUndefined();
    expect(r.taskId).toBe('t1');
    expect(r.winnerAgentId).toBe('time-agent');
    expect(r.runnerUpAgentId).toBe('calendar-agent');
    expect(r.judgment).toBe('runner-up-better');
    expect(r.confidence).toBe(0.8);
    expect(r.rationale).toBe('better answer');
    expect(typeof r.at).toBe('number');
  });

  it('clamps confidence to [0, 1]', async () => {
    const judge = new CounterfactualJudge({
      ai: makeAi({ judgment: 'winner-better', confidence: 1.5 }),
      random: () => 0,
    });
    const r = await judge.judge({
      task: { id: 't', content: 'q' },
      bids: makeBids(),
      winnerAgentId: 'time-agent',
      winnerAnswer: 'an answer',
    });
    expect(r.confidence).toBe(1);
  });

  it('returns skipped:invalid-llm-output for unknown judgment string', async () => {
    const judge = new CounterfactualJudge({
      ai: makeAi({ judgment: 'maybe', confidence: 0.5 }),
      random: () => 0,
    });
    const r = await judge.judge({
      task: { id: 't', content: 'q' },
      bids: makeBids(),
      winnerAgentId: 'time-agent',
      winnerAnswer: 'an answer',
    });
    expect(r.skipped).toBe(true);
    expect(r.reason).toBe('invalid-llm-output');
  });

  it('returns skipped:llm-error on LLM throw -- never propagates', async () => {
    const ai = { json: vi.fn(async () => { throw new Error('rate limit'); }) };
    const judge = new CounterfactualJudge({ ai, random: () => 0 });
    const r = await judge.judge({
      task: { id: 't', content: 'q' },
      bids: makeBids(),
      winnerAgentId: 'time-agent',
      winnerAnswer: 'an answer',
    });
    expect(r.skipped).toBe(true);
    expect(r.reason).toBe('llm-error');
    expect(r.error).toContain('rate limit');
  });

  it('coalesces concurrent calls for the same taskId', async () => {
    const ai = makeAi({ judgment: 'same', confidence: 0.5, rationale: 'tied' });
    const judge = new CounterfactualJudge({ ai, random: () => 0 });
    const args = {
      task: { id: 'duplicate', content: 'q' },
      bids: makeBids(),
      winnerAgentId: 'time-agent',
      winnerAnswer: 'an answer',
    };
    const [a, b, c] = await Promise.all([
      judge.judge(args),
      judge.judge(args),
      judge.judge(args),
    ]);
    expect(ai.json).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('respects budget gate -- skipped:budget-exhausted', async () => {
    const judge = new CounterfactualJudge({
      ai: makeAi({ judgment: 'winner-better', confidence: 0.8 }),
      random: () => 0,
      checkBudget: async () => ({ allowed: false, reason: 'daily_budget_slice' }),
    });
    const r = await judge.judge({
      task: { id: 't', content: 'q' },
      bids: makeBids(),
      winnerAgentId: 'time-agent',
      winnerAnswer: 'an answer',
    });
    expect(r.skipped).toBe(true);
    expect(r.reason).toBe('budget-exhausted');
  });

  it('continues when budget check throws (treats as allowed)', async () => {
    const judge = new CounterfactualJudge({
      ai: makeAi({ judgment: 'winner-better', confidence: 0.8 }),
      random: () => 0,
      checkBudget: async () => { throw new Error('budget service down'); },
    });
    const r = await judge.judge({
      task: { id: 't', content: 'q' },
      bids: makeBids(),
      winnerAgentId: 'time-agent',
      winnerAnswer: 'an answer',
    });
    expect(r.skipped).toBeUndefined();
    expect(r.judgment).toBe('winner-better');
  });
});

describe('CounterfactualJudge.getStats', () => {
  it('aggregates judgments + average confidence over the rolling window', async () => {
    const judge = new CounterfactualJudge({ random: () => 0 });
    const responses = [
      { judgment: 'runner-up-better', confidence: 0.9 },
      { judgment: 'winner-better', confidence: 0.8 },
      { judgment: 'winner-better', confidence: 0.7 },
      { judgment: 'same', confidence: 0.5 },
    ];
    let i = 0;
    judge._setAi({ json: vi.fn(async () => responses[i++]) });

    for (let n = 0; n < responses.length; n += 1) {
      // Each call needs a unique taskId to avoid coalescing.
      await judge.judge({
        task: { id: `t${n}`, content: 'q' },
        bids: makeBids(),
        winnerAgentId: 'time-agent',
        winnerAnswer: 'an answer',
      });
    }
    const stats = judge.getStats();
    expect(stats.total).toBe(4);
    expect(stats.counts['winner-better']).toBe(2);
    expect(stats.counts['runner-up-better']).toBe(1);
    expect(stats.counts['same']).toBe(1);
    expect(stats.avgConfidence).toBeCloseTo((0.9 + 0.8 + 0.7 + 0.5) / 4, 5);
  });
});

describe('VALID_JUDGMENTS export', () => {
  it('includes the three valid string values', () => {
    expect(VALID_JUDGMENTS.has('runner-up-better')).toBe(true);
    expect(VALID_JUDGMENTS.has('same')).toBe(true);
    expect(VALID_JUDGMENTS.has('winner-better')).toBe(true);
    expect(VALID_JUDGMENTS.size).toBe(3);
  });
});

// ============================================================
// Integration: judge -> emit -> recorder joins
// ============================================================

describe('integration: counterfactual judgment lands on arbitration-decisions item', () => {
  let storage;
  let bus;

  function makeFakeStorage() {
    let nextId = 1;
    const s = {
      index: { spaces: [], items: [] },
      createSpace: vi.fn((space) => { s.index.spaces.push(space); return space; }),
      addItem: vi.fn((item) => {
        const id = `item-${nextId++}`;
        const stored = { ...item, id };
        s.index.items.push(stored);
        return stored;
      }),
      updateItemIndex: vi.fn((itemId, updates) => {
        const item = s.index.items.find((i) => i.id === itemId);
        if (!item) return false;
        if (updates.content !== undefined) item.content = updates.content;
        return true;
      }),
      deleteItem: vi.fn((itemId) => {
        const idx = s.index.items.findIndex((i) => i.id === itemId);
        if (idx === -1) return false;
        s.index.items.splice(idx, 1);
        return true;
      }),
    };
    return s;
  }

  beforeEach(() => {
    recorder._resetForTests();
    storage = makeFakeStorage();
    recorder._setTestDeps({
      spacesAPI: { storage },
      settingsManager: {
        get: vi.fn((k) => ({
          'arbitrationDecisions.enabled': true,
          'arbitrationDecisions.retentionDays': 90,
          'arbitrationDecisions.redactedRecording': false,
        }[k])),
      },
    });
    bus = new EventEmitter();
    recorder.startDecisionRecorder(bus);
  });

  it('decision-recorder updates outcome.counterfactualJudgment when judgment fires', async () => {
    // Step 1: settle a task with two bids -- recorder creates the item.
    bus.emit('learning:interaction', {
      taskId: 'task-1',
      agentId: 'time-agent',
      userInput: 'what time is it',
      success: true,
      durationMs: 800,
      bustCount: 0,
      bustedAgents: [],
      bids: makeBids(),
      executionMode: 'single',
      decisionPath: 'fast-path-dominant',
      timestamp: Date.now(),
    });
    await new Promise((r) => setImmediate(r));
    expect(storage.index.items).toHaveLength(1);
    const decision1 = JSON.parse(storage.index.items[0].content);
    expect(decision1.outcome.counterfactualJudgment).toBeNull();

    // Step 2: judge fires + emits learning:counterfactual-judgment.
    const judge = new CounterfactualJudge({
      ai: makeAi({ judgment: 'winner-better', confidence: 0.85, rationale: 'looks right' }),
      random: () => 0,
    });
    const record = await judge.judge({
      task: { id: 'task-1', content: 'what time is it' },
      bids: makeBids(),
      winnerAgentId: 'time-agent',
      winnerAnswer: 'It is 3:14 PM',
    });
    bus.emit('learning:counterfactual-judgment', {
      taskId: record.taskId,
      judgment: record.judgment,
      confidence: record.confidence,
      rationale: record.rationale,
      winnerAgentId: record.winnerAgentId,
      runnerUpAgentId: record.runnerUpAgentId,
      timestamp: record.at,
    });

    // Step 3: the same item now has the judgment joined onto outcome.
    const decision2 = JSON.parse(storage.index.items[0].content);
    expect(decision2.outcome.counterfactualJudgment).toBe('winner-better');
    expect(decision2.outcome.counterfactualConfidence).toBeCloseTo(0.85, 5);
  });

  it('out-of-order: judgment arriving before learning:interaction is buffered then applied', async () => {
    // Step 1: judgment fires first.
    bus.emit('learning:counterfactual-judgment', {
      taskId: 'task-1',
      judgment: 'runner-up-better',
      confidence: 0.7,
    });
    expect(storage.index.items).toHaveLength(0);

    // Step 2: interaction lands; buffered judgment should now apply.
    bus.emit('learning:interaction', {
      taskId: 'task-1',
      agentId: 'time-agent',
      userInput: 'what time is it',
      success: true,
      durationMs: 500,
      bustCount: 0,
      bustedAgents: [],
      bids: makeBids(),
      executionMode: 'single',
      decisionPath: 'fast-path-dominant',
      timestamp: Date.now(),
    });
    await new Promise((r) => setImmediate(r));

    const decision = JSON.parse(storage.index.items[0].content);
    expect(decision.outcome.counterfactualJudgment).toBe('runner-up-better');
    expect(decision.outcome.counterfactualConfidence).toBeCloseTo(0.7, 5);
  });
});
