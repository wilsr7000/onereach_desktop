/**
 * Outcome Tracker
 * Part of the Governed Self-Improving Agent Runtime
 *
 * Captures real-world outcomes to create truth signal for learning
 */

/**
 * Outcome types
 */

const { getLogQueue } = require('./../log-event-queue');
const log = getLogQueue();

const OUTCOME_TYPES = {
  // Document/Code outcomes
  ACCEPTED: 'accepted',
  REWORK_REQUIRED: 'rework_required',
  REJECTED: 'rejected',

  // Suggestion outcomes
  SUGGESTION_APPLIED: 'suggestion_applied',
  SUGGESTION_IGNORED: 'suggestion_ignored',
  SUGGESTION_MODIFIED: 'suggestion_modified',

  // Downstream outcomes
  DOWNSTREAM_SUCCESS: 'downstream_success',
  DOWNSTREAM_FAILURE: 'downstream_failure',

  // User feedback
  USER_SATISFIED: 'user_satisfied',
  USER_UNSATISFIED: 'user_unsatisfied',
};

/**
 * Accuracy classifications
 */
const ACCURACY_TYPES = {
  TRUE_POSITIVE: 'true_positive',
  TRUE_NEGATIVE: 'true_negative',
  FALSE_POSITIVE: 'false_positive',
  FALSE_NEGATIVE: 'false_negative',
};

/**
 * Outcome Tracker
 * Tracks real-world outcomes for evaluations
 */
class OutcomeTracker {
  constructor(options = {}) {
    this.storage = options.storage || new Map();
    this.listeners = [];
    this.outcomeHistory = [];
    this.maxHistory = options.maxHistory || 1000;
  }

  /**
   * Record outcome for an evaluation
   * @param {string} evaluationId - Evaluation identifier
   * @param {Object} outcome - Outcome data
   * @returns {Object} Recorded outcome
   */
  async recordOutcome(evaluationId, outcome) {
    const record = {
      id: `outcome-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      evaluationId,
      timestamp: new Date().toISOString(),

      // What was predicted vs what happened
      outcome: outcome.type,
      predictedScore: outcome.originalEvaluation?.aggregateScore,
      actualOutcome: outcome.type,

      // Per-agent accuracy for this outcome
      agentPredictions: this.calculateAgentPredictions(outcome),

      // Suggestion outcomes
      suggestionOutcomes:
        outcome.suggestions?.map((s) => ({
          suggestionId: s.id,
          wasApplied: s.applied || false,
          wasModified: s.modified || false,
          wasEffective: s.effective,
        })) || [],

      // Context for learning
      documentType: outcome.documentType,
      context: outcome.context || {},

      // User feedback
      userFeedback: outcome.userFeedback || null,
    };

    // Store the record
    this.storage.set(record.id, record);

    // Add to history
    this.outcomeHistory.unshift(record);
    if (this.outcomeHistory.length > this.maxHistory) {
      const _removed = this.outcomeHistory.pop();
      // Keep in storage for lookups
    }

    // Notify listeners
    await this.notifyListeners('outcome:recorded', record);

    // Trigger learning updates
    await this.triggerLearningUpdate(record);

    return record;
  }

  /**
   * Calculate per-agent prediction accuracy
   * @param {Object} outcome - Outcome data
   * @returns {Object[]}
   */
  calculateAgentPredictions(outcome) {
    if (!outcome.originalEvaluation?.agentScores) {
      return [];
    }

    return outcome.originalEvaluation.agentScores.map((agent) => ({
      agentType: agent.agentType,
      predictedScore: agent.score,
      wasAccurate: this.calculateAccuracy(agent.score, outcome.type),
    }));
  }

  /**
   * Calculate accuracy classification
   * @param {number} predictedScore - Agent's predicted score
   * @param {string} outcomeType - Actual outcome
   * @returns {string} Accuracy type
   */
  calculateAccuracy(predictedScore, outcomeType) {
    const isPositivePrediction = predictedScore >= 70;
    const isPositiveOutcome = [
      OUTCOME_TYPES.ACCEPTED,
      OUTCOME_TYPES.DOWNSTREAM_SUCCESS,
      OUTCOME_TYPES.USER_SATISFIED,
    ].includes(outcomeType);

    if (isPositivePrediction && isPositiveOutcome) return ACCURACY_TYPES.TRUE_POSITIVE;
    if (!isPositivePrediction && !isPositiveOutcome) return ACCURACY_TYPES.TRUE_NEGATIVE;
    if (isPositivePrediction && !isPositiveOutcome) return ACCURACY_TYPES.FALSE_POSITIVE;
    return ACCURACY_TYPES.FALSE_NEGATIVE;
  }

  /**
   * Get outcomes for a specific agent
   * @param {string} agentType - Agent type
   * @param {Object} options - Query options
   * @returns {Object[]} Matching outcomes
   */
  getOutcomesForAgent(agentType, options = {}) {
    const { documentType, timeRange, limit = 100 } = options;

    let results = this.outcomeHistory.filter((outcome) => {
      const agentMatch = outcome.agentPredictions?.some((a) => a.agentType === agentType);
      if (!agentMatch) return false;

      if (documentType && outcome.documentType !== documentType) return false;

      if (timeRange) {
        const outcomeTime = new Date(outcome.timestamp);
        if (timeRange.start && outcomeTime < new Date(timeRange.start)) return false;
        if (timeRange.end && outcomeTime > new Date(timeRange.end)) return false;
      }

      return true;
    });

    return results.slice(0, limit);
  }

  /**
   * Get outcomes for an evaluation
   * @param {string} evaluationId - Evaluation ID
   * @returns {Object[]}
   */
  getOutcomesForEvaluation(evaluationId) {
    return this.outcomeHistory.filter((o) => o.evaluationId === evaluationId);
  }

  /**
   * Calculate agent accuracy statistics
   * @param {string} agentType - Agent type
   * @param {Object} options - Options
   * @returns {Object} Accuracy statistics
   */
  calculateAgentAccuracy(agentType, options = {}) {
    const outcomes = this.getOutcomesForAgent(agentType, options);

    if (outcomes.length === 0) {
      return { accuracy: 0.5, samples: 0, insufficient: true };
    }

    const predictions = outcomes.flatMap((o) => o.agentPredictions?.filter((a) => a.agentType === agentType) || []);

    const accuracyCounts = {
      [ACCURACY_TYPES.TRUE_POSITIVE]: 0,
      [ACCURACY_TYPES.TRUE_NEGATIVE]: 0,
      [ACCURACY_TYPES.FALSE_POSITIVE]: 0,
      [ACCURACY_TYPES.FALSE_NEGATIVE]: 0,
    };

    for (const pred of predictions) {
      if (pred.wasAccurate) {
        accuracyCounts[pred.wasAccurate]++;
      }
    }

    const total = predictions.length;
    const correct = accuracyCounts[ACCURACY_TYPES.TRUE_POSITIVE] + accuracyCounts[ACCURACY_TYPES.TRUE_NEGATIVE];

    return {
      accuracy: total > 0 ? correct / total : 0.5,
      samples: total,
      breakdown: accuracyCounts,
      falsePositiveRate: total > 0 ? accuracyCounts[ACCURACY_TYPES.FALSE_POSITIVE] / total : 0,
      falseNegativeRate: total > 0 ? accuracyCounts[ACCURACY_TYPES.FALSE_NEGATIVE] / total : 0,
    };
  }

  /**
   * Trigger learning update based on outcome
   * @param {Object} record - Outcome record
   */
  async triggerLearningUpdate(record) {
    await this.notifyListeners('learning:update', record);
  }

  /**
   * Add listener for outcome events
   * @param {Function} listener - Listener function
   */
  addListener(listener) {
    this.listeners.push(listener);
  }

  /**
   * Remove listener
   * @param {Function} listener - Listener to remove
   */
  removeListener(listener) {
    const index = this.listeners.indexOf(listener);
    if (index > -1) {
      this.listeners.splice(index, 1);
    }
  }

  /**
   * Notify all listeners
   * @param {string} event - Event type
   * @param {Object} data - Event data
   */
  async notifyListeners(event, data) {
    for (const listener of this.listeners) {
      try {
        await listener(event, data);
      } catch (error) {
        log.error('app', 'Listener error:', { error: error });
      }
    }
  }

  /**
   * Get outcome statistics
   * @returns {Object}
   */
  getStats() {
    const outcomes = this.outcomeHistory;

    const byType = {};
    for (const outcome of outcomes) {
      byType[outcome.outcome] = (byType[outcome.outcome] || 0) + 1;
    }

    const suggestionStats = {
      total: 0,
      applied: 0,
      ignored: 0,
      effective: 0,
    };

    for (const outcome of outcomes) {
      for (const s of outcome.suggestionOutcomes || []) {
        suggestionStats.total++;
        if (s.wasApplied) suggestionStats.applied++;
        if (!s.wasApplied && !s.wasModified) suggestionStats.ignored++;
        if (s.wasEffective) suggestionStats.effective++;
      }
    }

    return {
      totalOutcomes: outcomes.length,
      byType,
      suggestionStats,
      oldestOutcome: outcomes[outcomes.length - 1]?.timestamp,
      newestOutcome: outcomes[0]?.timestamp,
    };
  }

  /**
   * Clear all outcomes
   */
  clear() {
    this.storage.clear();
    this.outcomeHistory = [];
  }
}

module.exports = OutcomeTracker;
module.exports.OutcomeTracker = OutcomeTracker;
module.exports.OUTCOME_TYPES = OUTCOME_TYPES;
module.exports.ACCURACY_TYPES = ACCURACY_TYPES;
