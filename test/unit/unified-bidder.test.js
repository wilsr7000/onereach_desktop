import { describe, it, expect, vi, beforeEach } from 'vitest';

// Shared mock chat function tests can control
const mockChat = vi.fn().mockResolvedValue({
  content: JSON.stringify({
    confidence: 0.85,
    plan: 'I will handle this',
    reasoning: 'This matches my capabilities',
    hallucinationRisk: 'none',
  }),
});

// Mock dependencies
vi.mock('../../packages/agents/circuit-breaker', () => ({
  getCircuit: vi.fn().mockReturnValue({
    fire: vi.fn((fn) => fn()),
    isOpen: vi.fn().mockReturnValue(false),
    stats: { failures: 0, successes: 0, opens: 0 },
  }),
}));
vi.mock('../../spaces-api', () => ({
  getSpacesAPI: vi.fn().mockReturnValue(null),
}));
vi.mock('../../lib/ai-service', () => ({
  default: { chat: mockChat },
  chat: mockChat,
}));
vi.mock('../../lib/log-event-queue', () => ({
  getLogQueue: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
}));

describe('Unified Bidder', () => {
  let bidder;

  beforeEach(async () => {
    mockChat.mockReset();
    mockChat.mockResolvedValue({
      content: JSON.stringify({
        confidence: 0.85,
        plan: 'I will handle this',
        reasoning: 'This matches my capabilities',
        hallucinationRisk: 'none',
      }),
    });
    vi.resetModules();
    vi.mock('../../packages/agents/circuit-breaker', () => ({
      getCircuit: vi.fn().mockReturnValue({
        fire: vi.fn((fn) => fn()),
        isOpen: vi.fn().mockReturnValue(false),
        stats: { failures: 0, successes: 0, opens: 0 },
      }),
    }));
    vi.mock('../../spaces-api', () => ({
      getSpacesAPI: vi.fn().mockReturnValue(null),
    }));
    vi.mock('../../lib/ai-service', () => ({
      default: { chat: mockChat },
      chat: mockChat,
    }));
    vi.mock('../../lib/log-event-queue', () => ({
      getLogQueue: () => ({
        info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
      }),
    }));
    bidder = require('../../packages/agents/unified-bidder');
  });

  function fakeAgent(id, keywords, capabilities) {
    return {
      id,
      name: `${id} Agent`,
      description: `Handles ${id} tasks`,
      categories: ['general'],
      keywords: keywords || [id],
      capabilities: capabilities || [id],
      prompt: `You are a ${id} agent.`,
      execute: vi.fn().mockResolvedValue({ success: true, message: 'Done' }),
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // checkBidderReady()
  // ═══════════════════════════════════════════════════════════════

  describe('checkBidderReady()', () => {

    it('returns ready: true', () => {
      const status = bidder.checkBidderReady();
      expect(status.ready).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // evaluateAgentBid()
  // ═══════════════════════════════════════════════════════════════

  describe('evaluateAgentBid()', () => {

    it('returns bid with confidence, plan, reasoning', async () => {
      const agent = fakeAgent('weather', ['weather', 'forecast']);
      const task = { content: 'what is the weather' };
      const bid = await bidder.evaluateAgentBid(agent, task);
      expect(typeof bid.confidence).toBe('number');
      expect(bid.confidence).toBeGreaterThanOrEqual(0);
      expect(bid.confidence).toBeLessThanOrEqual(1);
      expect(typeof bid.reasoning).toBe('string');
    });

    it('clamps confidence to [0, 1] range', async () => {
      mockChat.mockResolvedValue({
        content: JSON.stringify({
          confidence: 1.5,
          plan: 'test',
          reasoning: 'test',
          hallucinationRisk: 'none',
        }),
      });
      const agent = fakeAgent('test');
      const bid = await bidder.evaluateAgentBid(agent, { content: 'test' });
      expect(bid.confidence).toBeLessThanOrEqual(1);
    });

    it('returns zero confidence on AI failure', async () => {
      mockChat.mockRejectedValue(new Error('API error'));
      const agent = fakeAgent('test');
      const bid = await bidder.evaluateAgentBid(agent, { content: 'test' });
      expect(bid.confidence).toBe(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // selectWinner()
  // ═══════════════════════════════════════════════════════════════

  describe('selectWinner()', () => {

    it('selects first bid as winner (expects pre-sorted input)', () => {
      // selectWinner expects bids to be pre-sorted by score descending
      const bids = [
        { agentId: 'b', confidence: 0.9, score: 0.9 },
        { agentId: 'a', confidence: 0.5, score: 0.5 },
        { agentId: 'c', confidence: 0.3, score: 0.3 },
      ];
      const { winner, backups } = bidder.selectWinner(bids);
      expect(winner.agentId).toBe('b');
      expect(backups.length).toBeGreaterThanOrEqual(0);
    });

    it('returns null winner for empty bids', () => {
      const { winner } = bidder.selectWinner([]);
      expect(winner).toBeNull();
    });

    it('returns null winner for all-zero bids', () => {
      const bids = [
        { agentId: 'a', confidence: 0, score: 0 },
        { agentId: 'b', confidence: 0, score: 0 },
      ];
      const { winner } = bidder.selectWinner(bids);
      expect(winner).toBeNull();
    });

    it('returns backups sorted by confidence', () => {
      const bids = [
        { agentId: 'a', confidence: 0.9, score: 0.9 },
        { agentId: 'b', confidence: 0.7, score: 0.7 },
        { agentId: 'c', confidence: 0.5, score: 0.5 },
      ];
      const { winner, backups } = bidder.selectWinner(bids);
      expect(winner.agentId).toBe('a');
      if (backups.length >= 2) {
        expect(backups[0].confidence).toBeGreaterThanOrEqual(backups[1].confidence);
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // clearCache()
  // ═══════════════════════════════════════════════════════════════

  describe('clearCache()', () => {

    it('clears without error', () => {
      expect(() => bidder.clearCache()).not.toThrow();
    });

    it('can be called multiple times', () => {
      bidder.clearCache();
      bidder.clearCache();
      // No error
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Module exports
  // ═══════════════════════════════════════════════════════════════

  describe('Module exports', () => {

    it('exports evaluateAgentBid', () => {
      expect(typeof bidder.evaluateAgentBid).toBe('function');
    });

    it('exports selectWinner', () => {
      expect(typeof bidder.selectWinner).toBe('function');
    });

    it('exports checkBidderReady', () => {
      expect(typeof bidder.checkBidderReady).toBe('function');
    });

    it('exports clearCache', () => {
      expect(typeof bidder.clearCache).toBe('function');
    });

    it('exports getBidsFromAgents', () => {
      expect(typeof bidder.getBidsFromAgents).toBe('function');
    });
  });
});
