import { describe, it, expect, vi, beforeEach } from 'vitest';

// Shared mock chat function that tests can control
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
vi.mock('../../lib/ai-service', () => {
  const svc = {
    chat: (...args) => mockChat(...args),
    json: vi.fn().mockResolvedValue({}),
    complete: vi.fn().mockResolvedValue(''),
    vision: vi.fn().mockResolvedValue({}),
    embed: vi.fn().mockResolvedValue([]),
  };
  return svc;
});
vi.mock('../../lib/log-event-queue', () => ({
  getLogQueue: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
}));

// Load the module once (mocks are already hoisted by vi.mock)
const _mod = require('../../packages/agents/master-orchestrator');
const orchestrator = _mod.default || _mod;

describe('Master Orchestrator', () => {

  beforeEach(() => {
    mockChat.mockReset();
    mockChat.mockResolvedValue({ content: '{}' });
  });

  function makeBid(agentId, confidence, reasoning) {
    return {
      agentId,
      agentName: agentId,
      confidence,
      score: confidence,
      reasoning: reasoning || `I can handle this (${agentId})`,
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // EVALUATE: Zero / Single / Multiple bids
  // ═══════════════════════════════════════════════════════════════

  describe('evaluate() - bid count handling', () => {

    it('returns empty winners for no bids', async () => {
      const result = await orchestrator.evaluate('test task', []);
      expect(result.winners).toEqual([]);
      expect(result.executionMode).toBe('single');
      expect(result.reasoning).toContain('No bids');
    });

    it('throws on undefined bids (no guard)', async () => {
      await expect(orchestrator.evaluate('test task', undefined))
        .rejects.toThrow();
    });

    it('auto-selects single bid as winner', async () => {
      const bids = [makeBid('weather-agent', 0.9, 'I handle weather')];
      const result = await orchestrator.evaluate('what is the weather', bids);
      expect(result.winners).toEqual(['weather-agent']);
      expect(result.executionMode).toBe('single');
      expect(result.reasoning).toContain('Only one');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // EVALUATE: Dominant bid shortcut (gap > 0.3)
  // ═══════════════════════════════════════════════════════════════

  describe('evaluate() - dominant bid shortcut', () => {

    it('skips LLM when top bid dominates by >0.3', async () => {
      const bids = [
        makeBid('weather-agent', 0.95, 'Weather query'),
        makeBid('time-agent', 0.4, 'Maybe time-related'),
      ];
      const result = await orchestrator.evaluate('what is the weather in NYC', bids);
      expect(result.winners).toEqual(['weather-agent']);
      expect(result.executionMode).toBe('single');
      expect(result.reasoning).toContain('gap');
      // AI should NOT have been called (dominant bid shortcut)
      expect(mockChat).not.toHaveBeenCalled();
    });

    it('falls back to top bid when LLM unavailable and gap is small', async () => {
      // Gap 0.1 <= 0.3, so orchestrator attempts LLM call.
      // Without API keys, LLM fails and falls back to highest scorer.
      const bids = [
        makeBid('calendar-agent', 0.8, 'Calendar query'),
        makeBid('time-agent', 0.7, 'Could be time'),
      ];
      const result = await orchestrator.evaluate('what do I have on Monday', bids);
      // Fallback selects highest scoring bid
      expect(result.winners).toContain('calendar-agent');
      expect(result.executionMode).toBe('single');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // EVALUATE: LLM response handling
  // ═══════════════════════════════════════════════════════════════

  describe('evaluate() - LLM response processing', () => {

    it('validates winners exist in bids', async () => {
      mockChat.mockResolvedValue({
        content: JSON.stringify({
          winners: ['nonexistent-agent'],
          executionMode: 'single',
          reasoning: 'Picked wrong agent',
          rejectedBids: [],
          agentFeedback: [],
        }),
      });

      const bids = [
        makeBid('weather-agent', 0.6, 'Weather'),
        makeBid('time-agent', 0.55, 'Time'),
      ];
      const result = await orchestrator.evaluate('what is the weather', bids);
      // Should fallback since LLM winner doesn't match any bid
      expect(result.winners).toHaveLength(1);
      expect(result.winners[0]).toBe('weather-agent'); // fallback to highest
    });

    it('forces single mode when no multi-intent signals', async () => {
      mockChat.mockResolvedValue({
        content: JSON.stringify({
          winners: ['weather-agent', 'time-agent'],
          executionMode: 'parallel',
          reasoning: 'Both relevant',
          rejectedBids: [],
          agentFeedback: [],
        }),
      });

      const bids = [
        makeBid('weather-agent', 0.7, 'Weather'),
        makeBid('time-agent', 0.65, 'Time'),
      ];
      // Simple query with no "and"/"then" -- should force single
      const result = await orchestrator.evaluate('what is the weather', bids);
      expect(result.winners).toHaveLength(1);
      expect(result.executionMode).toBe('single');
    });

    it('selects single winner via fallback for multi-intent when LLM unavailable', async () => {
      // Even with multi-intent text, when LLM is unavailable,
      // fallback always selects a single top winner
      const bids = [
        makeBid('weather-agent', 0.8, 'Weather part'),
        makeBid('calendar-agent', 0.75, 'Calendar part'),
      ];
      const result = await orchestrator.evaluate('check the weather and show my calendar', bids);
      // Fallback always picks single top bid
      expect(result.winners).toHaveLength(1);
      expect(result.winners[0]).toBe('weather-agent');
      expect(result.executionMode).toBe('single');
    });

    it('falls back on LLM error', async () => {
      mockChat.mockRejectedValue(new Error('API timeout'));

      const bids = [
        makeBid('weather-agent', 0.65, 'Weather'),
        makeBid('time-agent', 0.55, 'Time'),
      ];
      // Gap 0.1 < 0.3, so LLM is called, which fails -> fallback
      const result = await orchestrator.evaluate('what is the weather', bids);
      expect(result.winners).toEqual(['weather-agent']);
      expect(result.reasoning).toContain('Fallback');
    });

    it('falls back on empty LLM response', async () => {
      mockChat.mockResolvedValue({ content: '' });

      const bids = [
        makeBid('weather-agent', 0.8, 'Weather'),
        makeBid('time-agent', 0.5, 'Time'),
      ];
      const result = await orchestrator.evaluate('weather please', bids);
      expect(result.winners).toEqual(['weather-agent']);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // FALLBACK SELECTION
  // ═══════════════════════════════════════════════════════════════

  describe('_fallbackSelection()', () => {

    it('selects highest scoring bid', () => {
      const bids = [
        makeBid('agent-a', 0.9),
        makeBid('agent-b', 0.5),
      ];
      const result = orchestrator._fallbackSelection(bids);
      expect(result.winners).toEqual(['agent-a']);
      expect(result.executionMode).toBe('single');
      expect(result.reasoning).toContain('Fallback');
    });
  });
});
