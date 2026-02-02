/**
 * Agent Performance Memory
 * Part of the Governed Self-Improving Agent Runtime
 * 
 * Per-agent track record that affects future weighting
 */

/**
 * Agent Performance Memory
 * Tracks historical performance of each agent type
 */
class AgentPerformanceMemory {
  constructor(options = {}) {
    this.storage = options.storage || new Map();
    this.minSamplesForReliability = options.minSamples || 10;
  }

  /**
   * Get default memory structure for a new agent
   * @param {string} agentType - Agent type
   * @returns {Object} Default memory
   */
  getDefaultMemory(agentType) {
    return {
      agentType,
      
      // Overall performance
      totalEvaluations: 0,
      overallAccuracy: 0.5, // Start neutral
      
      // Context-specific performance
      contextPerformance: {},
      // e.g., "code": { accuracy: 0.82, samples: 150 }
      
      // Criterion-specific reliability
      criterionReliability: {},
      // e.g., "clarity": { accuracy: 0.78, falsePositiveRate: 0.12 }
      
      // False positive/negative rates
      falsePositiveRate: 0.5,
      falseNegativeRate: 0.5,
      
      // What this agent is best/worst at
      mostReliableOn: [],
      leastReliableOn: [],
      
      // Conflict performance
      conflictRecord: {},
      // e.g., "beginner": { wins: 45, losses: 32 }
      
      // Trend over time
      performanceTrend: 'stable', // 'improving', 'declining', 'stable'
      recentAccuracy: [], // Last 20 evaluations
      
      // Last updated
      lastUpdated: null,
      createdAt: new Date().toISOString()
    };
  }

  /**
   * Get memory for an agent type
   * @param {string} agentType - Agent type
   * @returns {Object} Agent memory
   */
  getMemory(agentType) {
    if (!this.storage.has(agentType)) {
      const defaultMemory = this.getDefaultMemory(agentType);
      this.storage.set(agentType, defaultMemory);
    }
    return this.storage.get(agentType);
  }

  /**
   * Save memory for an agent type
   * @param {string} agentType - Agent type
   * @param {Object} memory - Memory to save
   */
  saveMemory(agentType, memory) {
    memory.lastUpdated = new Date().toISOString();
    this.storage.set(agentType, memory);
  }

  /**
   * Update agent memory based on outcome
   * @param {string} agentType - Agent type
   * @param {Object} outcome - Outcome data
   * @returns {Object} Updated memory
   */
  async updateFromOutcome(agentType, outcome) {
    const memory = this.getMemory(agentType);
    
    // Find this agent's prediction
    const prediction = outcome.agentPredictions?.find(a => a.agentType === agentType);
    if (!prediction) return memory;

    const wasAccurate = prediction.wasAccurate;
    
    // Update overall accuracy
    memory.totalEvaluations++;
    memory.overallAccuracy = this.updateRunningAccuracy(
      memory.overallAccuracy,
      wasAccurate,
      memory.totalEvaluations
    );

    // Update context-specific performance
    const context = outcome.documentType || 'unknown';
    if (!memory.contextPerformance[context]) {
      memory.contextPerformance[context] = { accuracy: 0.5, samples: 0 };
    }
    memory.contextPerformance[context].samples++;
    memory.contextPerformance[context].accuracy = this.updateRunningAccuracy(
      memory.contextPerformance[context].accuracy,
      wasAccurate,
      memory.contextPerformance[context].samples
    );

    // Update false positive/negative rates
    if (wasAccurate === 'false_positive') {
      memory.falsePositiveRate = this.updateRate(memory.falsePositiveRate, true, memory.totalEvaluations);
    } else {
      memory.falsePositiveRate = this.updateRate(memory.falsePositiveRate, false, memory.totalEvaluations);
    }

    if (wasAccurate === 'false_negative') {
      memory.falseNegativeRate = this.updateRate(memory.falseNegativeRate, true, memory.totalEvaluations);
    } else {
      memory.falseNegativeRate = this.updateRate(memory.falseNegativeRate, false, memory.totalEvaluations);
    }

    // Track recent accuracy for trend
    const isCorrect = ['true_positive', 'true_negative'].includes(wasAccurate);
    memory.recentAccuracy.unshift(isCorrect ? 1 : 0);
    if (memory.recentAccuracy.length > 20) {
      memory.recentAccuracy.pop();
    }

    // Recalculate best/worst
    memory.mostReliableOn = this.findMostReliable(memory.criterionReliability);
    memory.leastReliableOn = this.findLeastReliable(memory.criterionReliability);

    // Update trend
    memory.performanceTrend = this.calculateTrend(memory);

    this.saveMemory(agentType, memory);
    return memory;
  }

  /**
   * Update running accuracy with new data point
   * @param {number} currentAccuracy - Current accuracy
   * @param {string} wasAccurate - Accuracy classification
   * @param {number} totalSamples - Total samples
   * @returns {number} New accuracy
   */
  updateRunningAccuracy(currentAccuracy, wasAccurate, totalSamples) {
    const isCorrect = ['true_positive', 'true_negative'].includes(wasAccurate);
    const newValue = isCorrect ? 1 : 0;
    
    // Exponential moving average with more weight on recent
    const alpha = Math.min(0.1, 2 / (totalSamples + 1));
    return currentAccuracy * (1 - alpha) + newValue * alpha;
  }

  /**
   * Update rate with new data point
   * @param {number} currentRate - Current rate
   * @param {boolean} occurred - Whether event occurred
   * @param {number} totalSamples - Total samples
   * @returns {number} New rate
   */
  updateRate(currentRate, occurred, totalSamples) {
    const alpha = Math.min(0.1, 2 / (totalSamples + 1));
    return currentRate * (1 - alpha) + (occurred ? 1 : 0) * alpha;
  }

  /**
   * Find most reliable criteria
   * @param {Object} criterionReliability - Criterion reliability data
   * @returns {string[]}
   */
  findMostReliable(criterionReliability) {
    const sorted = Object.entries(criterionReliability)
      .filter(([_, data]) => data.samples >= this.minSamplesForReliability)
      .sort((a, b) => b[1].accuracy - a[1].accuracy);
    
    return sorted.slice(0, 3).map(([criterion]) => criterion);
  }

  /**
   * Find least reliable criteria
   * @param {Object} criterionReliability - Criterion reliability data
   * @returns {string[]}
   */
  findLeastReliable(criterionReliability) {
    const sorted = Object.entries(criterionReliability)
      .filter(([_, data]) => data.samples >= this.minSamplesForReliability)
      .sort((a, b) => a[1].accuracy - b[1].accuracy);
    
    return sorted.slice(0, 3).map(([criterion]) => criterion);
  }

  /**
   * Calculate performance trend
   * @param {Object} memory - Agent memory
   * @returns {string} Trend classification
   */
  calculateTrend(memory) {
    const recent = memory.recentAccuracy;
    if (recent.length < 10) return 'stable';

    const firstHalf = recent.slice(0, 10).reduce((a, b) => a + b, 0) / 10;
    const secondHalf = recent.slice(10, 20).reduce((a, b) => a + b, 0) / Math.min(10, recent.length - 10);

    if (firstHalf > secondHalf + 0.1) return 'improving';
    if (firstHalf < secondHalf - 0.1) return 'declining';
    return 'stable';
  }

  /**
   * Record conflict outcome
   * @param {string} agentType - This agent
   * @param {string} opponentType - Opposing agent
   * @param {boolean} won - Whether this agent was correct
   */
  recordConflictOutcome(agentType, opponentType, won) {
    const memory = this.getMemory(agentType);
    
    if (!memory.conflictRecord[opponentType]) {
      memory.conflictRecord[opponentType] = { wins: 0, losses: 0 };
    }

    if (won) {
      memory.conflictRecord[opponentType].wins++;
    } else {
      memory.conflictRecord[opponentType].losses++;
    }

    this.saveMemory(agentType, memory);
  }

  /**
   * Get recommended weight based on memory
   * @param {string} agentType - Agent type
   * @param {string} context - Evaluation context (e.g., document type)
   * @returns {number} Recommended weight
   */
  getRecommendedWeight(agentType, context) {
    const memory = this.getMemory(agentType);
    
    // Base weight from overall accuracy
    let weight = memory.overallAccuracy;

    // Adjust for context-specific performance
    const contextPerf = memory.contextPerformance[context];
    if (contextPerf && contextPerf.samples >= this.minSamplesForReliability) {
      weight = (weight + contextPerf.accuracy) / 2;
    }

    // Penalize high false positive rate
    if (memory.falsePositiveRate > 0.3) {
      weight *= 0.8;
    }

    // Boost if improving
    if (memory.performanceTrend === 'improving') {
      weight *= 1.1;
    }

    // Penalize if declining
    if (memory.performanceTrend === 'declining') {
      weight *= 0.9;
    }

    return Math.min(1.5, Math.max(0.5, weight));
  }

  /**
   * Get all agent memories
   * @returns {Object[]}
   */
  getAllMemories() {
    return [...this.storage.values()];
  }

  /**
   * Get agent comparison
   * @returns {Object[]} Agents sorted by accuracy
   */
  getAgentComparison() {
    return this.getAllMemories()
      .filter(m => m.totalEvaluations >= this.minSamplesForReliability)
      .sort((a, b) => b.overallAccuracy - a.overallAccuracy)
      .map(m => ({
        agentType: m.agentType,
        accuracy: m.overallAccuracy,
        samples: m.totalEvaluations,
        trend: m.performanceTrend,
        bestAt: m.mostReliableOn,
        worstAt: m.leastReliableOn
      }));
  }

  /**
   * Clear all memory
   */
  clear() {
    this.storage.clear();
  }
}

module.exports = AgentPerformanceMemory;
module.exports.AgentPerformanceMemory = AgentPerformanceMemory;


