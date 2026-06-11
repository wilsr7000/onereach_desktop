/**
 * Exchange confidence floor (minWinnerConfidence)
 *
 * When every bid in an auction lands below `auction.minWinnerConfidence`,
 * the Exchange must HALT ('no_confident_bids', ranked bids attached)
 * instead of assigning the task to a low-confidence guess. The halt is
 * what lets the bridge offer alternatives -- rephrasing, or building a
 * new agent for a genuine capability gap.
 *
 * Behavioral tests against the compiled package (the same dist/ the
 * bridge requires), driving the private runAuction directly with
 * collectBids stubbed to inject bids.
 */

import { describe, it, expect } from 'vitest';

const {
  Exchange,
  MemoryStorage,
  TaskPriority,
} = require('../../packages/task-exchange/dist/index.js');

function makeExchange(auctionOverrides = {}) {
  const config = {
    port: 0,
    transport: 'local',
    storage: 'memory',
    categories: [],
    auction: {
      defaultWindowMs: 50,
      minWindowMs: 10,
      maxWindowMs: 100,
      instantWinThreshold: 0.85,
      dominanceMargin: 0.3,
      maxAuctionAttempts: 1,
      executionTimeoutMs: 1000,
      ackTimeoutMs: 100,
      heartbeatExtensionMs: 100,
      ...auctionOverrides,
    },
    heartbeatIntervalMs: 30000,
    heartbeatTimeoutMs: 60000,
  };
  return new Exchange(config, new MemoryStorage());
}

function makeTask(content = 'do something niche') {
  return {
    id: `task_${Math.random().toString(36).slice(2)}`,
    content,
    status: 'queued',
    priority: TaskPriority.NORMAL,
    metadata: {},
    auctionAttempt: 0,
    createdAt: Date.now(),
  };
}

/** Stub bid collection to inject fixed bids into the order book. */
function injectBids(exchange, bids) {
  exchange.collectBids = async (_task, orderBook) => {
    for (const b of bids) {
      await orderBook.submitBid({
        agentId: b.agentId,
        agentVersion: '1.0.0',
        confidence: b.confidence,
        reasoning: 'test bid',
        estimatedTimeMs: 100,
        timestamp: Date.now(),
        tier: 'keyword',
      });
    }
  };
}

function onceEvent(exchange, event) {
  return new Promise((resolve) => exchange.on(event, resolve));
}

describe('Exchange minWinnerConfidence floor', () => {
  it('halts with no_confident_bids when every bid is below the floor', async () => {
    const ex = makeExchange({ minWinnerConfidence: 0.5 });
    injectBids(ex, [
      { agentId: 'weak-agent-a', confidence: 0.3 },
      { agentId: 'weak-agent-b', confidence: 0.2 },
    ]);

    const halt = onceEvent(ex, 'exchange:halt');
    let assigned = false;
    ex.on('task:assigned', () => { assigned = true; });

    const task = makeTask();
    await ex.runAuction(task).catch(() => {});

    const payload = await halt;
    expect(payload.reason).toBe('no_confident_bids');
    expect(task.status).toBe('halted');
    expect(assigned).toBe(false);

    // Ranked bids ride along so the halt handler can explain near-misses
    expect(Array.isArray(payload.bids)).toBe(true);
    expect(payload.bids.length).toBe(2);
    expect(payload.bids[0].agentId).toBe('weak-agent-a');
  });

  it('assigns normally when a bid clears the floor', async () => {
    const ex = makeExchange({ minWinnerConfidence: 0.5 });
    injectBids(ex, [
      { agentId: 'strong-agent', confidence: 0.8 },
      { agentId: 'weak-agent', confidence: 0.2 },
    ]);

    const assigned = onceEvent(ex, 'task:assigned');
    let halted = false;
    ex.on('exchange:halt', () => { halted = true; });

    await ex.runAuction(makeTask()).catch(() => {});

    const payload = await assigned;
    expect(payload.winner.agentId).toBe('strong-agent');
    expect(halted).toBe(false);
  });

  it('floor of 0 (default) preserves legacy top-scorer behavior', async () => {
    const ex = makeExchange(); // no minWinnerConfidence -> default 0
    injectBids(ex, [{ agentId: 'weak-agent', confidence: 0.3 }]);

    const assigned = onceEvent(ex, 'task:assigned');
    let halted = false;
    ex.on('exchange:halt', () => { halted = true; });

    await ex.runAuction(makeTask()).catch(() => {});

    const payload = await assigned;
    expect(payload.winner.agentId).toBe('weak-agent');
    expect(halted).toBe(false);
  });

  it('zero bids still halt with the legacy reason', async () => {
    const ex = makeExchange({ minWinnerConfidence: 0.5 });
    injectBids(ex, []);

    const halt = onceEvent(ex, 'exchange:halt');
    await ex.runAuction(makeTask()).catch(() => {});

    const payload = await halt;
    expect(payload.reason).toBe('No bids received');
  });
});
