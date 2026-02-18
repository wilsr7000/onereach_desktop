/**
 * Meta-Learning Module
 * Part of the Governed Self-Improving Agent Runtime
 *
 * The "Self-Improving" core - learns how to judge, not just what to judge
 */

const { OutcomeTracker, OUTCOME_TYPES, ACCURACY_TYPES } = require('./outcome-tracker');
const { AgentPerformanceMemory } = require('./agent-memory');
const { ConflictResolutionLearner, RESOLUTION_TYPES } = require('./conflict-learner');
const { AdaptiveEvaluationStrategy, AGENT_TYPES } = require('./adaptive-strategy');
const { MetaLearningGovernance } = require('./governance');

/**
 * Create a complete meta-learning system
 * @param {Object} options - Configuration options
 * @returns {Object} Meta-learning system
 */
function createMetaLearningSystem(options = {}) {
  // Create components
  const outcomeTracker = new OutcomeTracker(options.outcomeTracker);
  const agentMemory = new AgentPerformanceMemory(options.agentMemory);
  const conflictLearner = new ConflictResolutionLearner(options.conflictLearner);
  const governance = new MetaLearningGovernance(options.governance);

  // Create adaptive strategy with references to other components
  const adaptiveStrategy = new AdaptiveEvaluationStrategy({
    agentMemory,
    conflictLearner,
    ...options.adaptiveStrategy,
  });

  // Wire up learning pipeline
  outcomeTracker.addListener(async (event, data) => {
    if (event === 'learning:update') {
      // Update agent memory based on outcome
      for (const prediction of data.agentPredictions || []) {
        // Check governance before applying update
        const validation = governance.shouldApplyLearning({
          sampleCount: agentMemory.getMemory(prediction.agentType).totalEvaluations + 1,
          proposedChange: 0.05, // Simplified
        });

        if (validation.apply) {
          await agentMemory.updateFromOutcome(prediction.agentType, data);

          // Log the update
          await governance.logLearningUpdate({
            type: 'accuracy_update',
            agentType: prediction.agentType,
            previous: null,
            new: null,
            samples: agentMemory.getMemory(prediction.agentType).totalEvaluations,
          });
        }
      }
    }
  });

  return {
    outcomeTracker,
    agentMemory,
    conflictLearner,
    adaptiveStrategy,
    governance,

    /**
     * Record an outcome and trigger learning
     */
    async recordOutcome(evaluationId, outcome) {
      return outcomeTracker.recordOutcome(evaluationId, outcome);
    },

    /**
     * Get optimal agents for evaluation
     */
    async getOptimalAgents(documentType, content, options) {
      return adaptiveStrategy.getOptimalAgents(documentType, content, options);
    },

    /**
     * Get conflict resolution prediction
     */
    async getConflictPrediction(conflict) {
      return conflictLearner.getPrediction(conflict);
    },

    /**
     * Record conflict resolution
     */
    async recordConflictResolution(conflict, resolution) {
      return conflictLearner.recordResolution(conflict, resolution);
    },

    /**
     * Get system statistics
     */
    getStats() {
      return {
        outcomes: outcomeTracker.getStats(),
        agents: agentMemory.getAgentComparison(),
        conflicts: conflictLearner.getPatternSummary(),
        strategy: adaptiveStrategy.getStats(),
        governance: governance.getStats(),
      };
    },

    /**
     * Export all data for backup/analysis
     */
    exportAll() {
      return {
        exportedAt: new Date().toISOString(),
        outcomes: outcomeTracker.getStats(),
        agentMemories: agentMemory.getAllMemories(),
        conflictPatterns: conflictLearner.getAllPatterns(),
        auditLog: governance.exportAuditLog(),
      };
    },

    /**
     * Clear all learning data
     */
    clearAll() {
      outcomeTracker.clear();
      agentMemory.clear();
      conflictLearner.clear();
      adaptiveStrategy.clear();
      governance.clearAuditLog();
    },
  };
}

module.exports = {
  // Classes
  OutcomeTracker,
  AgentPerformanceMemory,
  ConflictResolutionLearner,
  AdaptiveEvaluationStrategy,
  MetaLearningGovernance,

  // Factory
  createMetaLearningSystem,

  // Constants
  OUTCOME_TYPES,
  ACCURACY_TYPES,
  RESOLUTION_TYPES,
  AGENT_TYPES,
};
