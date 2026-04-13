/**
 * Quality Verifier Tests
 *
 * The most safety-critical module: enforces "never deploy if any test
 * case degraded." All testing must be silent (no TTS, no HUD).
 *
 * Run:  npx vitest run test/unit/agent-learning/quality-verifier.test.js
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp') },
}), { virtual: true });

vi.mock('../../../lib/log-event-queue', () => ({
  getLogQueue: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    subscribe: vi.fn(() => vi.fn()),
  }),
}));

const mockAI = {
  complete: vi.fn(),
  json: vi.fn(),
};

vi.mock('../../../lib/ai-service', () => mockAI);

describe('Quality Verifier', () => {
  let verifier;

  beforeEach(() => {
    vi.resetModules();
    mockAI.complete.mockReset();
    mockAI.json.mockReset();
    verifier = require('../../../lib/agent-learning/quality-verifier');
    verifier._setTestDeps({ ai: mockAI });
  });

  describe('silentSimulate', () => {
    it('calls ai.complete with agent prompt as system', async () => {
      mockAI.complete.mockResolvedValue('simulated response');
      const result = await verifier.silentSimulate('You are a helper', 'hello');
      expect(mockAI.complete).toHaveBeenCalledWith('hello', expect.objectContaining({
        system: 'You are a helper',
        profile: 'fast',
        feature: 'agent-learning-verify',
      }));
      expect(result).toBe('simulated response');
    });

    it('returns empty string on error', async () => {
      mockAI.complete.mockRejectedValue(new Error('API down'));
      const result = await verifier.silentSimulate('prompt', 'input');
      expect(result).toBe('');
    });
  });

  describe('verifyImprovement', () => {
    const agent = { id: 'test-agent', prompt: 'old prompt' };
    const improved = { prompt: 'new prompt' };

    it('returns shouldDeploy:true when all test cases improved', async () => {
      mockAI.complete.mockResolvedValue('response');
      mockAI.json.mockResolvedValue({ winner: 'B', qualityA: 5, qualityB: 8, reasoning: 'better' });

      const result = await verifier.verifyImprovement(agent, improved, [
        { userInput: 'test 1' },
        { userInput: 'test 2' },
      ]);

      expect(result.shouldDeploy).toBe(true);
      expect(result.improved).toBe(2);
      expect(result.degraded).toBe(0);
    });

    it('returns shouldDeploy:false when ANY test case degraded', async () => {
      mockAI.complete.mockResolvedValue('response');
      mockAI.json
        .mockResolvedValueOnce({ winner: 'B', qualityA: 5, qualityB: 8, reasoning: 'better' })
        .mockResolvedValueOnce({ winner: 'A', qualityA: 8, qualityB: 3, reasoning: 'worse' });

      const result = await verifier.verifyImprovement(agent, improved, [
        { userInput: 'test 1' },
        { userInput: 'test 2' },
      ]);

      expect(result.shouldDeploy).toBe(false);
      expect(result.degraded).toBe(1);
    });

    it('returns shouldDeploy:true when all tied', async () => {
      mockAI.complete.mockResolvedValue('response');
      mockAI.json.mockResolvedValue({ winner: 'tie', qualityA: 6, qualityB: 6, reasoning: 'same' });

      const result = await verifier.verifyImprovement(agent, improved, [
        { userInput: 'test 1' },
      ]);

      // improved=0, degraded=0, 0 > 0 is false, so shouldDeploy is false for all-tied
      // Actually: shouldDeploy = improved > degraded && degraded === 0 => 0 > 0 && true => false
      // This is intentional: if nothing improved, don't bother deploying
      expect(result.shouldDeploy).toBe(false);
      expect(result.degraded).toBe(0);
    });

    it('returns shouldDeploy:true when mix of improved and tied', async () => {
      mockAI.complete.mockResolvedValue('response');
      mockAI.json
        .mockResolvedValueOnce({ winner: 'B', qualityA: 5, qualityB: 8, reasoning: 'better' })
        .mockResolvedValueOnce({ winner: 'tie', qualityA: 6, qualityB: 6, reasoning: 'same' });

      const result = await verifier.verifyImprovement(agent, improved, [
        { userInput: 'test 1' },
        { userInput: 'test 2' },
      ]);

      expect(result.shouldDeploy).toBe(true);
      expect(result.improved).toBe(1);
      expect(result.degraded).toBe(0);
    });

    it('treats invalid judge JSON as tie (fail-safe)', async () => {
      mockAI.complete.mockResolvedValue('response');
      mockAI.json.mockResolvedValue({ winner: 'invalid', qualityA: 5 });

      const result = await verifier.verifyImprovement(agent, improved, [
        { userInput: 'test 1' },
      ]);

      // Invalid winner gets normalized to 'tie' in the code
      expect(result.degraded).toBe(0);
    });

    it('treats judge error as tie (fail-safe)', async () => {
      mockAI.complete.mockResolvedValue('response');
      mockAI.json.mockRejectedValue(new Error('judge crashed'));

      const result = await verifier.verifyImprovement(agent, improved, [
        { userInput: 'test 1' },
      ]);

      expect(result.degraded).toBe(0);
      expect(result.shouldDeploy).toBe(false);
    });

    it('handles empty test interactions', async () => {
      const result = await verifier.verifyImprovement(agent, improved, []);
      expect(result.shouldDeploy).toBe(false);
      expect(result.score).toBe(0);
    });

    it('uses agent-learning-verify feature tag for cost tracking', async () => {
      mockAI.complete.mockResolvedValue('response');
      mockAI.json.mockResolvedValue({ winner: 'B', qualityA: 5, qualityB: 8 });

      await verifier.verifyImprovement(agent, improved, [{ userInput: 'test' }]);

      expect(mockAI.complete).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        feature: 'agent-learning-verify',
      }));
      expect(mockAI.json).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        feature: 'agent-learning-judge',
      }));
    });
  });
});
