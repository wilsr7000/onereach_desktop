/**
 * Evaluation Consolidator Unit Tests
 * Part of the Governed Self-Improving Agent Runtime
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { EvaluationConsolidator } = require('../../lib/evaluation/consolidator');
const { AgentWeightingManager } = require('../../lib/evaluation/weighting');

describe('EvaluationConsolidator', () => {
  let consolidator;
  let weightingManager;

  beforeEach(() => {
    weightingManager = new AgentWeightingManager({ mode: 'uniform' });
    consolidator = new EvaluationConsolidator({ weightingManager });
  });

  describe('Basic Consolidation', () => {
    it('should consolidate multiple evaluations', async () => {
      const evaluations = [
        {
          agentType: 'expert',
          agentId: 'expert-1',
          overallScore: 80,
          criteria: [{ name: 'clarity', score: 85, weight: 1 }],
          strengths: ['Good structure'],
          concerns: [],
          suggestions: []
        },
        {
          agentType: 'reviewer',
          agentId: 'reviewer-1',
          overallScore: 75,
          criteria: [{ name: 'clarity', score: 70, weight: 1 }],
          strengths: [],
          concerns: ['Some issues'],
          suggestions: []
        }
      ];

      const result = await consolidator.consolidate(evaluations, { documentType: 'code' });

      expect(result.aggregateScore).toBeDefined();
      expect(result.agentScores).toHaveLength(2);
      expect(result.epistemicFraming).toBeDefined();
    });

    it('should return empty result for no evaluations', async () => {
      const result = await consolidator.consolidate([]);

      expect(result.aggregateScore).toBe(0);
      expect(result.confidence).toBe('low');
    });

    it('should calculate weighted average score', async () => {
      const evaluations = [
        { agentType: 'expert', agentId: 'e1', overallScore: 100, criteria: [] },
        { agentType: 'reviewer', agentId: 'r1', overallScore: 50, criteria: [] }
      ];

      const result = await consolidator.consolidate(evaluations);

      // With uniform weights, should be average
      expect(result.aggregateScore).toBe(75);
    });
  });

  describe('Conflict Detection', () => {
    it('should detect conflicts when scores differ significantly', async () => {
      const evaluations = [
        {
          agentType: 'expert',
          agentId: 'e1',
          overallScore: 90,
          criteria: [{ name: 'clarity', score: 90, weight: 1, comment: 'Very clear' }]
        },
        {
          agentType: 'beginner',
          agentId: 'b1',
          overallScore: 50,
          criteria: [{ name: 'clarity', score: 50, weight: 1, comment: 'Hard to understand' }]
        }
      ];

      const result = await consolidator.consolidate(evaluations);

      expect(result.conflicts.length).toBeGreaterThan(0);
      expect(result.conflicts[0].criterion).toBe('clarity');
      expect(result.conflicts[0].spread).toBeGreaterThanOrEqual(20);
    });

    it('should not detect conflicts when scores are similar', async () => {
      const evaluations = [
        {
          agentType: 'expert',
          agentId: 'e1',
          overallScore: 80,
          criteria: [{ name: 'clarity', score: 80, weight: 1 }]
        },
        {
          agentType: 'reviewer',
          agentId: 'r1',
          overallScore: 78,
          criteria: [{ name: 'clarity', score: 78, weight: 1 }]
        }
      ];

      const result = await consolidator.consolidate(evaluations);

      expect(result.conflicts.length).toBe(0);
    });
  });

  describe('Epistemic Framing', () => {
    it('should include rationale in output', async () => {
      const evaluations = [
        { agentType: 'expert', agentId: 'e1', overallScore: 70, criteria: [] }
      ];

      const result = await consolidator.consolidate(evaluations);

      expect(result.epistemicFraming.rationale).toBeDefined();
      expect(typeof result.epistemicFraming.rationale).toBe('string');
    });

    it('should calculate confidence level', async () => {
      const highAgreement = [
        { agentType: 'expert', agentId: 'e1', overallScore: 75, criteria: [] },
        { agentType: 'reviewer', agentId: 'r1', overallScore: 78, criteria: [] },
        { agentType: 'security', agentId: 's1', overallScore: 74, criteria: [] }
      ];

      const result = await consolidator.consolidate(highAgreement);

      expect(result.confidence).toBe('high');
    });

    it('should recommend human review when confidence is low', async () => {
      const lowAgreement = [
        { agentType: 'expert', agentId: 'e1', overallScore: 90, criteria: [] },
        { agentType: 'beginner', agentId: 'b1', overallScore: 30, criteria: [] }
      ];

      const result = await consolidator.consolidate(lowAgreement);

      expect(result.epistemicFraming.recommendsHumanReview).toBe(true);
    });

    it('should identify primary drivers', async () => {
      const evaluations = [
        {
          agentType: 'expert',
          agentId: 'e1',
          overallScore: 70,
          criteria: [
            { name: 'security', score: 40, weight: 1 },
            { name: 'performance', score: 90, weight: 1 }
          ]
        }
      ];

      const result = await consolidator.consolidate(evaluations);

      expect(result.epistemicFraming.primaryDrivers).toBeDefined();
      expect(Array.isArray(result.epistemicFraming.primaryDrivers)).toBe(true);
    });
  });

  describe('Suggestion Consolidation', () => {
    it('should merge similar suggestions from multiple agents', async () => {
      const evaluations = [
        {
          agentType: 'expert',
          agentId: 'e1',
          overallScore: 70,
          criteria: [],
          suggestions: [{ text: 'Add error handling', priority: 'high' }]
        },
        {
          agentType: 'security',
          agentId: 's1',
          overallScore: 65,
          criteria: [],
          suggestions: [{ text: 'Add error handling for edge cases', priority: 'high' }]
        }
      ];

      const result = await consolidator.consolidate(evaluations);

      expect(result.suggestions.length).toBeGreaterThan(0);
      expect(result.suggestions[0].originatingAgents.length).toBeGreaterThanOrEqual(1);
    });

    it('should include confidence in suggestions', async () => {
      const evaluations = [
        {
          agentType: 'expert',
          agentId: 'e1',
          overallScore: 70,
          criteria: [],
          suggestions: [{ text: 'Refactor this function', priority: 'medium' }]
        }
      ];

      const result = await consolidator.consolidate(evaluations);

      expect(result.suggestions[0].confidence).toBeDefined();
    });
  });

  describe('Agent Score Trends', () => {
    it('should mark agents above average as best', async () => {
      const evaluations = [
        { agentType: 'expert', agentId: 'e1', overallScore: 90, criteria: [] },
        { agentType: 'reviewer', agentId: 'r1', overallScore: 60, criteria: [] }
      ];

      const result = await consolidator.consolidate(evaluations);

      const expert = result.agentScores.find(a => a.agentType === 'expert');
      expect(expert.trend).toBe('best');
    });

    it('should mark agents below average as concern', async () => {
      const evaluations = [
        { agentType: 'expert', agentId: 'e1', overallScore: 90, criteria: [] },
        { agentType: 'reviewer', agentId: 'r1', overallScore: 60, criteria: [] }
      ];

      const result = await consolidator.consolidate(evaluations);

      const reviewer = result.agentScores.find(a => a.agentType === 'reviewer');
      expect(reviewer.trend).toBe('concern');
    });
  });
});


