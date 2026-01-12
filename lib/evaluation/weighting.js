/**
 * Agent Weighting
 * Part of the Governed Self-Improving Agent Runtime
 * 
 * Three weighting modes: Uniform, Contextual, User-biased
 */

/**
 * Default weights by document type
 */
const CONTEXTUAL_WEIGHTS = {
  code: {
    expert: 1.2,
    reviewer: 1.1,
    security: 1.0,
    performance: 0.9,
    beginner: 0.8
  },
  technical: {
    expert: 1.1,
    implementer: 1.0,
    beginner: 1.2,  // Beginner perspective valuable for docs
    writer: 1.0
  },
  recipe: {
    chef: 1.2,
    teacher: 1.1,
    homecook: 1.0,
    safety: 1.1,
    nutritionist: 0.9
  },
  creative: {
    reader: 1.1,
    editor: 1.0,
    critic: 0.9,
    author: 1.0
  },
  api: {
    consumer: 1.2,
    implementer: 1.0,
    security: 1.1,
    documentation: 1.0
  },
  test: {
    tester: 1.2,
    developer: 1.0,
    coverage: 1.1,
    performance: 0.9
  }
};

/**
 * Weighting modes
 */
const WEIGHTING_MODES = {
  UNIFORM: 'uniform',
  CONTEXTUAL: 'contextual',
  USER_BIASED: 'user_biased',
  LEARNED: 'learned'  // Uses agent memory
};

/**
 * Agent Weighting Manager
 */
class AgentWeightingManager {
  constructor(options = {}) {
    this.mode = options.mode || WEIGHTING_MODES.CONTEXTUAL;
    this.userWeights = new Map(); // agentType -> weight
    this.agentMemory = options.agentMemory; // Optional: for learned weighting
    this.contextualWeights = { ...CONTEXTUAL_WEIGHTS, ...options.contextualWeights };
  }

  /**
   * Get weights for a set of agents
   * @param {string[]} agentTypes - Types of agents
   * @param {Object} context - Evaluation context
   * @returns {Object} Agent weights
   */
  getWeights(agentTypes, context = {}) {
    const { documentType = 'code' } = context;
    const weights = {};

    switch (this.mode) {
      case WEIGHTING_MODES.UNIFORM:
        return this.getUniformWeights(agentTypes);
      
      case WEIGHTING_MODES.CONTEXTUAL:
        return this.getContextualWeights(agentTypes, documentType);
      
      case WEIGHTING_MODES.USER_BIASED:
        return this.getUserBiasedWeights(agentTypes, documentType);
      
      case WEIGHTING_MODES.LEARNED:
        return this.getLearnedWeights(agentTypes, context);
      
      default:
        return this.getUniformWeights(agentTypes);
    }
  }

  /**
   * Get uniform weights (all agents equal)
   * @param {string[]} agentTypes - Types of agents
   * @returns {Object} Weights
   */
  getUniformWeights(agentTypes) {
    const weights = {};
    for (const type of agentTypes) {
      weights[type] = 1.0;
    }
    return {
      weights,
      mode: WEIGHTING_MODES.UNIFORM,
      description: 'All agents weighted equally'
    };
  }

  /**
   * Get contextual weights based on document type
   * @param {string[]} agentTypes - Types of agents
   * @param {string} documentType - Document type
   * @returns {Object} Weights
   */
  getContextualWeights(agentTypes, documentType) {
    const typeWeights = this.contextualWeights[documentType] || {};
    const weights = {};

    for (const type of agentTypes) {
      weights[type] = typeWeights[type] ?? 1.0;
    }

    return {
      weights,
      mode: WEIGHTING_MODES.CONTEXTUAL,
      documentType,
      description: `Weights optimized for ${documentType} evaluation`
    };
  }

  /**
   * Get user-biased weights (user overrides + contextual)
   * @param {string[]} agentTypes - Types of agents
   * @param {string} documentType - Document type
   * @returns {Object} Weights
   */
  getUserBiasedWeights(agentTypes, documentType) {
    const contextual = this.getContextualWeights(agentTypes, documentType);
    const weights = { ...contextual.weights };

    // Apply user overrides
    for (const type of agentTypes) {
      if (this.userWeights.has(type)) {
        weights[type] = this.userWeights.get(type);
      }
    }

    return {
      weights,
      mode: WEIGHTING_MODES.USER_BIASED,
      documentType,
      userOverrides: [...this.userWeights.keys()],
      description: 'User-customized agent weights'
    };
  }

  /**
   * Get learned weights from agent memory
   * @param {string[]} agentTypes - Types of agents
   * @param {Object} context - Evaluation context
   * @returns {Object} Weights
   */
  getLearnedWeights(agentTypes, context) {
    if (!this.agentMemory) {
      // Fall back to contextual if no memory
      return this.getContextualWeights(agentTypes, context.documentType);
    }

    const weights = {};
    const insights = [];

    for (const type of agentTypes) {
      const weight = this.agentMemory.getRecommendedWeight(type, context.documentType);
      weights[type] = weight;

      const memory = this.agentMemory.getMemory(type);
      if (memory) {
        insights.push({
          agent: type,
          weight,
          accuracy: memory.overallAccuracy,
          samples: memory.totalEvaluations,
          trend: memory.performanceTrend
        });
      }
    }

    return {
      weights,
      mode: WEIGHTING_MODES.LEARNED,
      documentType: context.documentType,
      insights,
      description: 'Weights learned from historical performance'
    };
  }

  /**
   * Set weighting mode
   * @param {string} mode - New mode
   */
  setMode(mode) {
    if (Object.values(WEIGHTING_MODES).includes(mode)) {
      this.mode = mode;
    } else {
      throw new Error(`Invalid weighting mode: ${mode}`);
    }
  }

  /**
   * Get current mode
   * @returns {string}
   */
  getMode() {
    return this.mode;
  }

  /**
   * Set user weight override
   * @param {string} agentType - Agent type
   * @param {number} weight - Weight value (0.5 - 1.5)
   */
  setUserWeight(agentType, weight) {
    if (weight < 0.5 || weight > 1.5) {
      throw new Error('Weight must be between 0.5 and 1.5');
    }
    this.userWeights.set(agentType, weight);
  }

  /**
   * Clear user weight override
   * @param {string} agentType - Agent type
   */
  clearUserWeight(agentType) {
    this.userWeights.delete(agentType);
  }

  /**
   * Clear all user weights
   */
  clearAllUserWeights() {
    this.userWeights.clear();
  }

  /**
   * Get available modes
   * @returns {Object}
   */
  getAvailableModes() {
    return WEIGHTING_MODES;
  }

  /**
   * Normalize weights so they sum to agent count
   * @param {Object} weights - Raw weights
   * @returns {Object} Normalized weights
   */
  normalizeWeights(weights) {
    const total = Object.values(weights).reduce((sum, w) => sum + w, 0);
    const count = Object.keys(weights).length;
    const factor = count / total;

    const normalized = {};
    for (const [type, weight] of Object.entries(weights)) {
      normalized[type] = weight * factor;
    }

    return normalized;
  }

  /**
   * Calculate weighted average score
   * @param {Object[]} agentScores - Array of { agentType, score }
   * @param {Object} weights - Agent weights
   * @returns {number} Weighted average
   */
  calculateWeightedAverage(agentScores, weights) {
    let totalWeight = 0;
    let weightedSum = 0;

    for (const { agentType, score } of agentScores) {
      const weight = weights[agentType] ?? 1.0;
      weightedSum += score * weight;
      totalWeight += weight;
    }

    return totalWeight > 0 ? weightedSum / totalWeight : 0;
  }
}

module.exports = AgentWeightingManager;
module.exports.AgentWeightingManager = AgentWeightingManager;
module.exports.WEIGHTING_MODES = WEIGHTING_MODES;
module.exports.CONTEXTUAL_WEIGHTS = CONTEXTUAL_WEIGHTS;

