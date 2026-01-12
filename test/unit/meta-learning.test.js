/**
 * Meta-Learning System Unit Tests
 * Part of the Governed Self-Improving Agent Runtime
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { 
  OutcomeTracker, 
  AgentPerformanceMemory,
  ConflictResolutionLearner,
  MetaLearningGovernance,
  createMetaLearningSystem,
  OUTCOME_TYPES
} = require('../../lib/meta-learning');

describe('OutcomeTracker', () => {
  let tracker;

  beforeEach(() => {
    tracker = new OutcomeTracker();
  });

  it('should record an outcome', async () => {
    const outcome = await tracker.recordOutcome('eval-123', {
      type: OUTCOME_TYPES.ACCEPTED,
      originalEvaluation: {
        aggregateScore: 80,
        agentScores: [{ agentType: 'expert', score: 85 }]
      },
      documentType: 'code'
    });

    expect(outcome.id).toBeDefined();
    expect(outcome.evaluationId).toBe('eval-123');
    expect(outcome.outcome).toBe(OUTCOME_TYPES.ACCEPTED);
  });

  it('should calculate agent accuracy', async () => {
    // Record multiple outcomes
    await tracker.recordOutcome('e1', {
      type: OUTCOME_TYPES.ACCEPTED,
      agentPredictions: [{ agentType: 'expert', score: 80, wasAccurate: 'true_positive' }]
    });
    await tracker.recordOutcome('e2', {
      type: OUTCOME_TYPES.REJECTED,
      agentPredictions: [{ agentType: 'expert', score: 75, wasAccurate: 'false_positive' }]
    });

    const accuracy = tracker.calculateAgentAccuracy('expert');

    expect(accuracy.samples).toBe(2);
    expect(accuracy.accuracy).toBeDefined();
  });

  it('should get stats', () => {
    const stats = tracker.getStats();

    expect(stats.totalOutcomes).toBeDefined();
    expect(stats.byType).toBeDefined();
  });
});

describe('AgentPerformanceMemory', () => {
  let memory;

  beforeEach(() => {
    memory = new AgentPerformanceMemory();
  });

  it('should create default memory for new agent', () => {
    const agentMemory = memory.getMemory('expert');

    expect(agentMemory.agentType).toBe('expert');
    expect(agentMemory.overallAccuracy).toBe(0.5);
    expect(agentMemory.totalEvaluations).toBe(0);
  });

  it('should update memory from outcome', async () => {
    const outcome = {
      agentPredictions: [{ agentType: 'expert', wasAccurate: 'true_positive' }],
      documentType: 'code'
    };

    await memory.updateFromOutcome('expert', outcome);
    const agentMemory = memory.getMemory('expert');

    expect(agentMemory.totalEvaluations).toBe(1);
    expect(agentMemory.overallAccuracy).toBeGreaterThan(0.5);
  });

  it('should track context-specific performance', async () => {
    const outcome = {
      agentPredictions: [{ agentType: 'expert', wasAccurate: 'true_positive' }],
      documentType: 'code'
    };

    await memory.updateFromOutcome('expert', outcome);
    const agentMemory = memory.getMemory('expert');

    expect(agentMemory.contextPerformance.code).toBeDefined();
    expect(agentMemory.contextPerformance.code.samples).toBe(1);
  });

  it('should calculate recommended weight', () => {
    const weight = memory.getRecommendedWeight('expert', 'code');

    // Default should be close to 0.5
    expect(weight).toBeGreaterThanOrEqual(0.5);
    expect(weight).toBeLessThanOrEqual(1.5);
  });

  it('should get agent comparison', () => {
    const comparison = memory.getAgentComparison();

    expect(Array.isArray(comparison)).toBe(true);
  });
});

describe('ConflictResolutionLearner', () => {
  let learner;

  beforeEach(() => {
    learner = new ConflictResolutionLearner();
  });

  it('should record a resolution', async () => {
    const conflict = {
      id: 'conflict-1',
      criterion: 'clarity',
      agents: [
        { agentType: 'expert', score: 90, reasoning: 'Clear' },
        { agentType: 'beginner', score: 50, reasoning: 'Confusing' }
      ],
      spread: 40
    };

    const record = await learner.recordResolution(conflict, {
      type: 'accepted_high',
      winner: 'expert'
    });

    expect(record.id).toBeDefined();
    expect(record.criterion).toBe('clarity');
  });

  it('should learn patterns from resolutions', async () => {
    const conflict = {
      criterion: 'clarity',
      agents: [
        { agentType: 'expert', score: 90 },
        { agentType: 'beginner', score: 50 }
      ]
    };

    // Record multiple resolutions
    for (let i = 0; i < 10; i++) {
      const record = await learner.recordResolution(conflict, {
        type: 'accepted_high',
        winner: 'expert'
      });
      await learner.recordOutcomeForResolution(record.id, { type: 'winner_correct' });
    }

    const patterns = learner.getAllPatterns();

    expect(patterns.length).toBeGreaterThan(0);
  });

  it('should get prediction for conflict', async () => {
    const conflict = {
      criterion: 'clarity',
      agents: [
        { agentType: 'expert' },
        { agentType: 'beginner' }
      ]
    };

    const prediction = await learner.getPrediction(conflict);

    expect(prediction.confidence).toBeDefined();
    // Without enough data, should be low confidence
    expect(prediction.confidence).toBe('low');
  });
});

describe('MetaLearningGovernance', () => {
  let governance;

  beforeEach(() => {
    governance = new MetaLearningGovernance({
      maxWeightChange: 0.1,
      minSamplesForLearning: 20
    });
  });

  it('should validate weight changes within bounds', () => {
    const result = governance.validateWeightChange('expert', 1.0, 1.05);

    expect(result.approved).toBe(true);
    expect(result.weight).toBe(1.05);
  });

  it('should reject weight changes exceeding max change', () => {
    const result = governance.validateWeightChange('expert', 1.0, 1.5);

    expect(result.approved).toBe(false);
    expect(result.boundedWeight).toBeDefined();
    expect(result.boundedWeight).toBeLessThanOrEqual(1.1); // Max 10% change
  });

  it('should enforce absolute weight bounds', () => {
    const result = governance.validateWeightChange('expert', 1.4, 1.6);

    expect(result.approved).toBe(false);
    expect(result.boundedWeight).toBe(1.5); // Max bound
  });

  it('should check learning requirements', () => {
    const result = governance.shouldApplyLearning({
      sampleCount: 10, // Below minimum
      proposedChange: 0.05
    });

    expect(result.apply).toBe(false);
    expect(result.checks.some(c => c.check === 'min_samples' && !c.passed)).toBe(true);
  });

  it('should log audit entries', async () => {
    await governance.logLearningUpdate({
      type: 'accuracy_update',
      agentType: 'expert',
      previous: 0.5,
      new: 0.55,
      samples: 25
    });

    const log = governance.getAuditLog();

    expect(log.length).toBeGreaterThan(0);
    expect(log[0].type).toBe('learning_update');
  });

  it('should get stats', () => {
    const stats = governance.getStats();

    expect(stats.config.maxWeightChange).toBe(0.1);
    expect(stats.config.minSamplesForLearning).toBe(20);
  });
});

describe('createMetaLearningSystem', () => {
  let system;

  beforeEach(() => {
    system = createMetaLearningSystem();
  });

  it('should create all components', () => {
    expect(system.outcomeTracker).toBeDefined();
    expect(system.agentMemory).toBeDefined();
    expect(system.conflictLearner).toBeDefined();
    expect(system.adaptiveStrategy).toBeDefined();
    expect(system.governance).toBeDefined();
  });

  it('should provide recordOutcome method', async () => {
    const result = await system.recordOutcome('eval-1', {
      type: OUTCOME_TYPES.ACCEPTED,
      documentType: 'code'
    });

    expect(result.id).toBeDefined();
  });

  it('should provide getStats method', () => {
    const stats = system.getStats();

    expect(stats.outcomes).toBeDefined();
    expect(stats.agents).toBeDefined();
    expect(stats.conflicts).toBeDefined();
    expect(stats.governance).toBeDefined();
  });

  it('should provide export method', () => {
    const exported = system.exportAll();

    expect(exported.exportedAt).toBeDefined();
    expect(exported.outcomes).toBeDefined();
    expect(exported.agentMemories).toBeDefined();
  });
});

