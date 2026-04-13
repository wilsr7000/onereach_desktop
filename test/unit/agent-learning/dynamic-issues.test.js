/**
 * Dynamic Known Issues Tests
 *
 * Tests the self-growing registry -- learnIssuePattern, getLearnedIssues,
 * and that learned issues participate in runKnownIssueChecks.
 *
 * Run:  npx vitest run test/unit/agent-learning/dynamic-issues.test.js
 */

import { describe, it, expect, beforeEach } from 'vitest';

const {
  runKnownIssueChecks,
  learnIssuePattern,
  getLearnedIssues,
  clearLearnedIssues,
} = require('../../../lib/agent-learning/known-agent-issues');

function makeCtx(overrides = {}) {
  return {
    agent: { estimatedExecutionMs: 5000, memory: { enabled: false }, ...overrides.agent },
    interactions: overrides.interactions || [],
    failureRate: overrides.failureRate ?? 0,
    rephraseRate: overrides.rephraseRate ?? 0,
    uiSpecRate: overrides.uiSpecRate ?? 0,
    routingAccuracy: overrides.routingAccuracy ?? 1.0,
    avgResponseTimeMs: overrides.avgResponseTimeMs ?? 1000,
    memoryWrites: overrides.memoryWrites ?? 0,
  };
}

describe('Dynamic Known Issues', () => {
  beforeEach(() => {
    clearLearnedIssues();
  });

  describe('learnIssuePattern', () => {
    it('creates a new learned issue with KAI-L prefix', () => {
      const id = learnIssuePattern({
        title: 'API returns 503 errors',
        errorPattern: '503.*service unavailable',
        improvementType: 'reliability',
      });

      expect(id).toMatch(/^KAI-L\d{3}$/);
    });

    it('adds the issue to getLearnedIssues', () => {
      learnIssuePattern({
        title: 'Network timeout pattern',
        errorPattern: 'ECONNREFUSED',
        improvementType: 'reliability',
      });

      const learned = getLearnedIssues();
      expect(learned).toHaveLength(1);
      expect(learned[0].title).toBe('Network timeout pattern');
      expect(learned[0].errorPattern).toBe('ECONNREFUSED');
    });

    it('deduplicates identical patterns', () => {
      learnIssuePattern({ title: 'Test', errorPattern: 'same pattern', improvementType: 'prompt' });
      learnIssuePattern({ title: 'Test2', errorPattern: 'same pattern', improvementType: 'prompt' });

      expect(getLearnedIssues()).toHaveLength(1);
    });

    it('rejects empty or invalid patterns', () => {
      expect(learnIssuePattern({ title: '', errorPattern: '', improvementType: 'prompt' })).toBeNull();
      expect(learnIssuePattern({ title: 'test', errorPattern: '[invalid', improvementType: 'prompt' })).toBeNull();
    });
  });

  describe('learned issues in runKnownIssueChecks', () => {
    it('detects learned patterns in agent interactions', () => {
      learnIssuePattern({
        title: 'Custom API failure',
        errorPattern: 'CustomAPI.*failed',
        improvementType: 'reliability',
        minFailureRate: 0.3,
        minOccurrences: 2,
      });

      const ctx = makeCtx({
        failureRate: 0.5,
        interactions: [
          { error: 'CustomAPI request failed with 500', success: false },
          { error: 'CustomAPI call failed unexpectedly', success: false },
          { error: null, success: true },
        ],
      });

      const results = runKnownIssueChecks(ctx);
      const learned = results.find((r) => r.learned);

      expect(learned).toBeTruthy();
      expect(learned.needsEscalation).toBe(true); // learned issues always escalate
    });

    it('does not trigger learned pattern when below threshold', () => {
      learnIssuePattern({
        title: 'Rare error',
        errorPattern: 'rare.*error',
        improvementType: 'prompt',
        minFailureRate: 0.3,
        minOccurrences: 2,
      });

      const ctx = makeCtx({
        failureRate: 0.1, // below threshold
        interactions: [
          { error: 'rare error happened', success: false },
        ],
      });

      const results = runKnownIssueChecks(ctx);
      const learned = results.find((r) => r.learned);
      expect(learned).toBeFalsy();
    });
  });

  describe('clearLearnedIssues', () => {
    it('removes all learned issues', () => {
      learnIssuePattern({ title: 'A', errorPattern: 'pattern a', improvementType: 'prompt' });
      learnIssuePattern({ title: 'B', errorPattern: 'pattern b', improvementType: 'prompt' });
      clearLearnedIssues();
      expect(getLearnedIssues()).toHaveLength(0);
    });

    it('resets ID counter so new issues start fresh', () => {
      learnIssuePattern({ title: 'A', errorPattern: 'pattern a', improvementType: 'prompt' });
      clearLearnedIssues();
      const id = learnIssuePattern({ title: 'B', errorPattern: 'pattern b', improvementType: 'prompt' });
      expect(id).toBe('KAI-L001');
    });
  });
});
