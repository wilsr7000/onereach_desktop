/**
 * Cross-Agent Learning Tests
 *
 * Tests pattern propagation, prompt hints, and cross-agent suggestions.
 *
 * Run:  npx vitest run test/unit/agent-learning/cross-agent-learning.test.js
 */

import { describe, it, expect, beforeEach } from 'vitest';

vi.mock('../../../lib/log-event-queue', () => ({
  getLogQueue: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
}));

const { CrossAgentLearning } = require('../../../lib/agent-learning/cross-agent-learning');

describe('CrossAgentLearning', () => {
  let cal;

  beforeEach(() => {
    cal = new CrossAgentLearning();
  });

  describe('recordEffectiveFix', () => {
    it('records error patterns from effective fixes', () => {
      cal.recordEffectiveFix(
        { outcome: 'effective', improvementType: 'prompt', specificIssue: 'fails on city name lookups' },
        { id: 'weather-agent', name: 'Weather' },
        { type: 'prompt', patch: { prompt: 'new prompt' } }
      );

      const stats = cal.getStats();
      expect(stats.fixedErrorPatterns).toBeGreaterThan(0);
    });

    it('ignores non-effective records', () => {
      cal.recordEffectiveFix(
        { outcome: 'ineffective', improvementType: 'prompt', specificIssue: 'test' },
        { id: 'a' },
        { type: 'prompt' }
      );

      expect(cal.getStats().fixedErrorPatterns).toBe(0);
    });

    it('extracts prompt patterns from prompt improvements', () => {
      cal.recordEffectiveFix(
        {
          outcome: 'effective', improvementType: 'prompt',
          specificIssue: 'agent gives wrong answers',
          delta: { failureRate: -0.2 },
        },
        { id: 'agent-a', name: 'Agent A', prompt: 'old prompt' },
        { type: 'prompt', patch: { prompt: 'much more detailed and expanded new prompt text here' } }
      );

      expect(cal.getStats().promptPatterns).toBe(1);
    });
  });

  describe('getSuggestedFixes', () => {
    it('suggests fixes from patterns seen in other agents', () => {
      cal.recordEffectiveFix(
        { outcome: 'effective', improvementType: 'prompt', specificIssue: 'connection timeout failures' },
        { id: 'agent-a', name: 'Agent A' },
        { type: 'prompt' }
      );

      const suggestions = cal.getSuggestedFixes('agent-b', {
        interactions: [
          { success: false, error: 'connection timeout when reaching server' },
          { success: false, error: 'connection timeout on API call' },
          { success: true, error: null },
        ],
      });

      expect(suggestions.length).toBeGreaterThan(0);
      expect(suggestions[0].fixType).toBe('prompt');
      expect(suggestions[0].sourceAgents).toContain('agent-a');
    });

    it('does not suggest fixes already applied to the same agent', () => {
      cal.recordEffectiveFix(
        { outcome: 'effective', improvementType: 'prompt', specificIssue: 'timeout issues' },
        { id: 'agent-a', name: 'Agent A' },
        { type: 'prompt' }
      );

      const suggestions = cal.getSuggestedFixes('agent-a', {
        interactions: [
          { success: false, error: 'timeout issues here' },
          { success: false, error: 'timeout issues again' },
        ],
      });

      expect(suggestions).toHaveLength(0);
    });

    it('returns empty when no patterns match', () => {
      const suggestions = cal.getSuggestedFixes('agent-b', {
        interactions: [{ success: false, error: 'something completely different' }],
      });

      expect(suggestions).toHaveLength(0);
    });
  });

  describe('getPromptHints', () => {
    it('returns null when no patterns exist', () => {
      expect(cal.getPromptHints('agent-b', 'prompt')).toBeNull();
    });

    it('returns hints from effective prompt fixes on other agents', () => {
      cal.recordEffectiveFix(
        {
          outcome: 'effective', improvementType: 'prompt',
          specificIssue: 'poor error handling in responses',
          delta: { failureRate: -0.3 },
        },
        { id: 'agent-a', name: 'Helper Agent', prompt: 'old' },
        { type: 'prompt', patch: { prompt: 'very detailed new prompt' } }
      );

      const hint = cal.getPromptHints('agent-b', 'prompt');
      expect(hint).toBeTruthy();
      expect(hint).toContain('Helper Agent');
    });
  });

  describe('getStats', () => {
    it('returns stats summary', () => {
      const stats = cal.getStats();
      expect(stats).toHaveProperty('fixedErrorPatterns');
      expect(stats).toHaveProperty('promptPatterns');
      expect(stats).toHaveProperty('propagations');
      expect(stats).toHaveProperty('topPatterns');
    });
  });

  describe('clear', () => {
    it('resets all state', () => {
      cal.recordEffectiveFix(
        { outcome: 'effective', improvementType: 'prompt', specificIssue: 'test pattern' },
        { id: 'a', name: 'A' },
        { type: 'prompt', patch: { prompt: 'p' } }
      );
      cal.clear();

      const stats = cal.getStats();
      expect(stats.fixedErrorPatterns).toBe(0);
      expect(stats.promptPatterns).toBe(0);
    });
  });
});
