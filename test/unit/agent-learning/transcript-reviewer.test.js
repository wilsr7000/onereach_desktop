/**
 * Transcript Reviewer tests (Phase 3 self-learning arbitration)
 *
 * Run: npx vitest run test/unit/agent-learning/transcript-reviewer.test.js
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../lib/log-event-queue', () => ({
  getLogQueue: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
}));

const {
  TranscriptReviewer,
  TRANSCRIPTS_SPACE_ID,
  ARBITRATION_SPACE_ID,
  DEFAULT_MAX_PROPOSALS_PER_CYCLE,
  DEFAULT_STALENESS_DAYS,
} = (() => {
  const mod = require('../../../lib/agent-learning/transcript-reviewer');
  // ARBITRATION_SPACE_ID is a private const; redeclare here for test
  // independence from internal exports.
  return { ...mod, ARBITRATION_SPACE_ID: 'arbitration-decisions' };
})();

// ============================================================
// Test harness: fake spaces storage with both arbitration-decisions
// and transcripts-review items.
// ============================================================

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
    updateItemIndex: vi.fn(),
    deleteItem: vi.fn((itemId) => {
      const idx = s.index.items.findIndex((i) => i.id === itemId);
      if (idx === -1) return false;
      s.index.items.splice(idx, 1);
      return true;
    }),
  };
  return s;
}

function makeFakeApi(storage) { return { storage }; }

function makeDecisionItem(overrides = {}, idx = 0) {
  const decision = {
    type: 'arbitration-decision',
    taskId: `task-${idx}`,
    content: 'what time is it and what day is it',
    bids: [
      { agentId: 'time-agent', confidence: 0.85, score: 0.85, reasoning: 'I report time', won: true },
      { agentId: 'calendar-agent', confidence: 0.7, score: 0.7, reasoning: 'I handle calendar including time', won: false },
    ],
    chosenWinner: 'time-agent',
    decisionPath: 'fast-path-dominant',
    executionMode: 'single',
    outcome: { success: true, reflectorScore: 0.9 },
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
  return {
    spaceId: ARBITRATION_SPACE_ID,
    timestamp: decision.createdAt,
    content: JSON.stringify(decision),
  };
}

function makeFakeUserQueue() {
  let nextId = 1;
  const items = [];
  return {
    items,
    addReviewItem: vi.fn((p) => {
      const item = {
        id: `q-${nextId++}`,
        type: 'review',
        text: p.text,
        metadata: p.metadata,
        timestamp: Date.now(),
        resolved: false,
      };
      items.push(item);
      return item;
    }),
    getAllItems: vi.fn(() => items),
    removeItem: vi.fn((id) => {
      const idx = items.findIndex((i) => i.id === id);
      if (idx === -1) return false;
      items.splice(idx, 1);
      return true;
    }),
    resolveItem: vi.fn((id) => {
      const item = items.find((i) => i.id === id);
      if (item) { item.resolved = true; return true; }
      return false;
    }),
  };
}

function makeAi(response) {
  return { json: vi.fn(async () => response) };
}

const NORMAL_LLM_RESPONSE = {
  windowDays: 7,
  decisionsAnalyzed: 12,
  findings: [
    {
      type: 'redundant-bidders',
      severity: 'high',
      description: 'time-agent and calendar-agent co-bid on time queries',
      evidence: ['task-0', 'task-1', 'task-2'],
    },
  ],
  proposedRules: [
    {
      id: 'shrink-cal-on-time',
      type: 'shrink',
      target: 'calendar-agent',
      magnitude: 0.4,
      conditions: { taskClass: 'time' },
      rationale: 'calendar bids on every time question; shrink to defer to time-agent',
    },
  ],
};

// ============================================================
// Tests
// ============================================================

describe('TranscriptReviewer.runOnce', () => {
  let storage;
  let userQueue;

  beforeEach(() => {
    storage = makeFakeStorage();
    userQueue = makeFakeUserQueue();
  });

  function makeReviewer(opts = {}) {
    return new TranscriptReviewer({
      ai: makeAi(opts.aiResponse !== undefined ? opts.aiResponse : NORMAL_LLM_RESPONSE),
      spacesAPI: makeFakeApi(storage),
      userQueue,
      minDecisions: opts.minDecisions !== undefined ? opts.minDecisions : 1,
      maxProposalsPerCycle: opts.maxProposalsPerCycle,
      proposalStalenessDays: opts.proposalStalenessDays,
      checkBudget: opts.checkBudget,
    });
  }

  function seedDecisions(n) {
    for (let i = 0; i < n; i += 1) storage.index.items.push(makeDecisionItem({}, i));
  }

  it('skips when fewer decisions than minDecisions', async () => {
    seedDecisions(2);
    const r = await makeReviewer({ minDecisions: 5 }).runOnce();
    expect(r.skipped).toBe(true);
    expect(r.reason).toBe('insufficient-data');
    expect(userQueue.addReviewItem).not.toHaveBeenCalled();
  });

  it('runs the LLM and queues the proposal when enough decisions exist', async () => {
    seedDecisions(12);
    const r = await makeReviewer().runOnce();
    expect(r.skipped).toBeUndefined();
    expect(r.findings).toHaveLength(1);
    expect(r.proposedRules).toHaveLength(1);
    expect(r.queued).toHaveLength(1);
    expect(r.queued[0].queued).toBe(true);
    expect(userQueue.addReviewItem).toHaveBeenCalledTimes(1);
  });

  it('persists a transcripts-review Space item with the run summary', async () => {
    seedDecisions(12);
    await makeReviewer().runOnce();
    const reviewItems = storage.index.items.filter((i) => i.spaceId === TRANSCRIPTS_SPACE_ID);
    expect(reviewItems).toHaveLength(1);
    const payload = JSON.parse(reviewItems[0].content);
    expect(payload.findings).toHaveLength(1);
    expect(payload.proposedRules).toHaveLength(1);
    expect(payload.queued).toHaveLength(1);
    expect(reviewItems[0].metadata.itemType).toBe('transcripts-review');
  });

  it('caps queued proposals to maxProposalsPerCycle', async () => {
    seedDecisions(12);
    const fiveProposals = {
      ...NORMAL_LLM_RESPONSE,
      findings: [
        { type: 'redundant-bidders', severity: 'high', evidence: ['t1', 't2', 't3'] },
        { type: 'over-confident-bidder', severity: 'medium', evidence: ['t4'] },
        { type: 'under-confident-bidder', severity: 'low', evidence: ['t5'] },
        { type: 'wrong-routing', severity: 'low', evidence: ['t6'] },
        { type: 'redundant-bidders', severity: 'low', evidence: ['t7'] },
      ],
      proposedRules: [
        { id: 'p1', type: 'shrink', target: 'a', magnitude: 0.5, severity: 'high', evidence: ['t1','t2','t3'] },
        { id: 'p2', type: 'shrink', target: 'b', magnitude: 0.5, severity: 'medium', evidence: ['t4'] },
        { id: 'p3', type: 'shrink', target: 'c', magnitude: 0.5, severity: 'low', evidence: ['t5'] },
        { id: 'p4', type: 'shrink', target: 'd', magnitude: 0.5, severity: 'low', evidence: ['t6'] },
        { id: 'p5', type: 'shrink', target: 'e', magnitude: 0.5, severity: 'low', evidence: ['t7'] },
      ],
    };
    const r = await makeReviewer({
      aiResponse: fiveProposals,
      maxProposalsPerCycle: 2,
    }).runOnce();
    const queued = r.queued.filter((q) => q.queued);
    expect(queued).toHaveLength(2);
    // Top-2 by score (severity * evidence) should be p1 and p2.
    expect(queued.map((q) => q.id).sort()).toEqual(['p1', 'p2']);
    // Excess proposals get reason='over-cap' but still appear in queued[].
    const overCap = r.queued.filter((q) => !q.queued);
    expect(overCap).toHaveLength(3);
    expect(overCap.every((q) => q.reason === 'over-cap')).toBe(true);
  });

  it('respects budget gate -- skipped:budget-exhausted', async () => {
    seedDecisions(12);
    const r = await makeReviewer({
      checkBudget: async () => ({ allowed: false, reason: 'daily_budget_slice' }),
    }).runOnce();
    expect(r.skipped).toBe(true);
    expect(r.reason).toBe('budget-exhausted');
    expect(userQueue.addReviewItem).not.toHaveBeenCalled();
  });

  it('returns skipped:llm-error when the LLM throws', async () => {
    seedDecisions(12);
    const reviewer = new TranscriptReviewer({
      ai: { json: vi.fn(async () => { throw new Error('rate limit'); }) },
      spacesAPI: makeFakeApi(storage),
      userQueue,
      minDecisions: 1,
    });
    const r = await reviewer.runOnce();
    expect(r.skipped).toBe(true);
    expect(r.reason).toBe('llm-error');
  });

  it('does not crash on an LLM response with bogus shape', async () => {
    seedDecisions(12);
    const r = await makeReviewer({ aiResponse: 'not an object' }).runOnce();
    expect(r.skipped).toBeUndefined();
    expect(r.findings).toEqual([]);
    expect(r.proposedRules).toEqual([]);
    expect(userQueue.addReviewItem).not.toHaveBeenCalled();
  });

  it('skips arbitration-decisions outside the rolling window', async () => {
    const now = Date.now();
    // 10 days ago -- outside default 7-day window.
    storage.index.items.push(makeDecisionItem({ createdAt: now - 10 * 24 * 60 * 60 * 1000 }, 0));
    storage.index.items[0].timestamp = now - 10 * 24 * 60 * 60 * 1000;
    const reviewer = new TranscriptReviewer({
      ai: makeAi(NORMAL_LLM_RESPONSE),
      spacesAPI: makeFakeApi(storage),
      userQueue,
      minDecisions: 1,
    });
    const r = await reviewer.runOnce({ now });
    expect(r.skipped).toBe(true);
    expect(r.reason).toBe('insufficient-data');
  });
});

// ============================================================
// Stale proposal sweep
// ============================================================

describe('TranscriptReviewer.staleSweep', () => {
  it('auto-rejects proposals older than proposalStalenessDays', async () => {
    const userQueue = makeFakeUserQueue();
    const now = Date.now();
    // Old proposal (40 days ago)
    userQueue.items.push({
      id: 'q-stale',
      type: 'review',
      metadata: {
        type: 'arbitration-rule-proposal',
        proposedAt: now - 40 * 24 * 60 * 60 * 1000,
      },
      timestamp: now - 40 * 24 * 60 * 60 * 1000,
      resolved: false,
    });
    // Fresh proposal (5 days ago)
    userQueue.items.push({
      id: 'q-fresh',
      type: 'review',
      metadata: {
        type: 'arbitration-rule-proposal',
        proposedAt: now - 5 * 24 * 60 * 60 * 1000,
      },
      timestamp: now - 5 * 24 * 60 * 60 * 1000,
      resolved: false,
    });

    const reviewer = new TranscriptReviewer({
      userQueue,
      proposalStalenessDays: DEFAULT_STALENESS_DAYS,
      minDecisions: 100, // forces skipped:insufficient-data so we only test sweep
    });
    const r = await reviewer.runOnce({ now });
    expect(r.stalePruned).toBe(1);
    expect(userQueue.removeItem).toHaveBeenCalledWith('q-stale');
    expect(userQueue.items.find((i) => i.id === 'q-fresh')).toBeDefined();
    expect(userQueue.items.find((i) => i.id === 'q-stale')).toBeUndefined();
  });

  it('only sweeps items with metadata.type=arbitration-rule-proposal', async () => {
    const userQueue = makeFakeUserQueue();
    const now = Date.now();
    userQueue.items.push({
      id: 'q-other',
      type: 'review',
      metadata: { type: 'something-else' },
      timestamp: now - 90 * 24 * 60 * 60 * 1000, // ancient
      resolved: false,
    });
    const reviewer = new TranscriptReviewer({ userQueue, minDecisions: 100 });
    const r = await reviewer.runOnce({ now });
    expect(r.stalePruned).toBe(0);
    expect(userQueue.items.find((i) => i.id === 'q-other')).toBeDefined();
  });
});

// ============================================================
// acceptProposal
// ============================================================

describe('TranscriptReviewer.acceptProposal', () => {
  it('persists an accepted proposal to the rules store', () => {
    const { LearnedArbitrationRulesStore } = require('../../../lib/agent-learning/learned-arbitration-rules');
    const rulesStore = new LearnedArbitrationRulesStore();
    const reviewer = new TranscriptReviewer({ rulesStore });
    const rule = reviewer.acceptProposal({
      id: 'shrink-cal-on-time',
      type: 'shrink',
      target: 'calendar-agent',
      magnitude: 0.4,
      conditions: { taskClass: 'time' },
    });
    expect(rule).toBeDefined();
    expect(rule.acceptedBy).toBe('user');
    expect(rulesStore.listRules()).toHaveLength(1);
  });
});

describe('exports', () => {
  it('uses the documented defaults', () => {
    expect(DEFAULT_MAX_PROPOSALS_PER_CYCLE).toBe(3);
    expect(DEFAULT_STALENESS_DAYS).toBe(30);
  });
});
