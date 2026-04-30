/**
 * Phase 4 regression fixtures (self-learning arbitration)
 *
 * Run: npx vitest run test/unit/p7-arbitration-fixtures.test.js
 *
 * These fixtures live in test/fixtures/voice-scenarios/p7-arbitration/
 * and represent the behavioural contract for the bid-overlap penalty:
 *
 *   01-roman-empire-single-intent  -> 1 winner (search-agent)
 *   02-time-and-day-single-intent  -> 1 winner (time-agent)
 *   03-jazz-and-calendar-composite -> 2 distinct winners across subtasks
 *
 * The fixtures should pass in 'on' mode after every constant retune
 * and on every CI build. They are the demo/regression cases the plan
 * calls out as the "this is what changed" evidence.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';

const mockChat = vi.fn().mockResolvedValue({ content: '{}' });

vi.mock('../../lib/agent-memory-store', () => ({
  getAgentMemory: vi.fn().mockReturnValue({
    updateFact: vi.fn().mockResolvedValue(true),
    getFacts: vi.fn().mockResolvedValue({}),
  }),
}));
vi.mock('../../lib/ai-providers/openai-adapter', () => ({
  getOpenAIAdapter: vi.fn().mockReturnValue(null),
  estimateTokens: vi.fn().mockReturnValue(100),
}));
vi.mock('../../lib/ai-providers/anthropic-adapter', () => ({
  getAnthropicAdapter: vi.fn().mockReturnValue(null),
}));
vi.mock('../../lib/ai-service', () => ({
  chat: (...args) => mockChat(...args),
  json: vi.fn().mockResolvedValue({}),
  complete: vi.fn().mockResolvedValue(''),
  vision: vi.fn().mockResolvedValue({}),
  embed: vi.fn().mockResolvedValue([]),
}));
vi.mock('../../lib/log-event-queue', () => ({
  getLogQueue: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
}));

const orchestrator = require('../../packages/agents/master-orchestrator');

const FIXTURE_DIR = path.join(
  __dirname, '..', 'fixtures', 'voice-scenarios', 'p7-arbitration',
);

function loadFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8'));
}

describe('Phase 4 arbitration regression fixtures', () => {
  let originalEnv;

  beforeEach(() => {
    originalEnv = process.env.ARBITRATION_OVERLAP_MODE;
    // Reset rules so they don't bleed in from other test files.
    const rulesModule = require('../../lib/agent-learning/learned-arbitration-rules');
    rulesModule._resetSingletonForTests();
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.ARBITRATION_OVERLAP_MODE;
    else process.env.ARBITRATION_OVERLAP_MODE = originalEnv;
  });

  it('01: Roman Empire single-intent -> 1 winner under "on" mode', async () => {
    process.env.ARBITRATION_OVERLAP_MODE = 'on';
    const fx = loadFixture('01-roman-empire-single-intent.json');
    const result = await orchestrator.evaluate(fx.task, fx.bids);
    expect(result.winners).toEqual(fx.expected.winners);
    expect(result.executionMode).toBe(fx.expected.executionMode);
  });

  it('02: time-and-day single-intent -> 1 winner under "on" mode', async () => {
    process.env.ARBITRATION_OVERLAP_MODE = 'on';
    const fx = loadFixture('02-time-and-day-single-intent.json');
    const result = await orchestrator.evaluate(fx.task, fx.bids);
    expect(result.winners).toEqual(fx.expected.winners);
    expect(result.executionMode).toBe(fx.expected.executionMode);
  });

  it('03: jazz-and-calendar composite -> 2 distinct winners across subtasks', async () => {
    process.env.ARBITRATION_OVERLAP_MODE = 'on';
    const fx = loadFixture('03-jazz-and-calendar-composite.json');
    const winners = [];
    for (const sub of fx.subtasks) {
      const result = await orchestrator.evaluate(sub.task, sub.bids);
      expect(result.winners).toEqual(sub.expected.winners);
      winners.push(...result.winners);
    }
    // Composite preserves two DISTINCT winners; overlap penalty did
    // not over-suppress because reasonings were disjoint.
    expect(winners).toEqual(fx.expected.winners);
    expect(new Set(winners).size).toBe(fx.expected.totalDistinctWinners);
  });

  it('off mode: Roman Empire fixture still resolves (via fallback / LLM path)', async () => {
    // Even with overlap off, the fallback path picks the highest-
    // scoring bid as the single winner. The fixture's expected
    // winners (search-agent) is the highest-scoring bid, so this
    // test passes regardless. Documents the contract that off mode
    // is non-regressive.
    process.env.ARBITRATION_OVERLAP_MODE = 'off';
    const fx = loadFixture('01-roman-empire-single-intent.json');
    const result = await orchestrator.evaluate(fx.task, fx.bids);
    expect(result.winners).toEqual(fx.expected.winners);
  });
});
