/**
 * Adaptive Evaluation Strategy
 * Part of the Governed Self-Improving Agent Runtime
 *
 * Evolves agent selection based on learned performance
 */

const { EVALUATION_PROFILES } = require('../evaluation/profiles');

/**
 * Agent types by document category (default)
 */
const AGENT_TYPES = {
  code: ['expert', 'reviewer', 'security', 'performance', 'beginner'],
  technical: ['expert', 'implementer', 'beginner', 'writer'],
  recipe: ['chef', 'teacher', 'homecook', 'safety', 'nutritionist'],
  creative: ['reader', 'editor', 'critic', 'author'],
  api: ['consumer', 'implementer', 'security', 'documentation'],
  test: ['tester', 'developer', 'coverage', 'maintainer'],
};

/**
 * Adaptive Evaluation Strategy
 * Learns optimal agent selection for each context
 */
class AdaptiveEvaluationStrategy {
  constructor(options = {}) {
    this.agentMemory = options.agentMemory;
    this.conflictLearner = options.conflictLearner;
    this.storage = options.storage || new Map();
    this.agentTypes = { ...AGENT_TYPES, ...options.customAgentTypes };
  }

  /**
   * Get optimal agents for evaluation
   * @param {string} documentType - Document type
   * @param {string} content - Content to evaluate
   * @param {Object} options - Options including profile
   * @returns {Object} Selection result
   */
  async getOptimalAgents(documentType, content, options = {}) {
    const { profile = 'standard' } = options;

    // Get base agents for this document type
    const allAgents = this.agentTypes[documentType] || this.agentTypes.code;

    // Get profile constraints
    const evalProfile = EVALUATION_PROFILES[profile] || EVALUATION_PROFILES.standard;
    const maxAgents = evalProfile.maxAgents;

    // Score each agent based on learned performance
    const scoredAgents = await Promise.all(
      allAgents.map(async (agentType) => {
        let score = 0.5; // Base score

        if (this.agentMemory) {
          const memory = this.agentMemory.getMemory(agentType);
          const contextPerf = memory?.contextPerformance?.[documentType];

          // Accuracy score
          const accuracyScore = contextPerf?.accuracy ?? memory?.overallAccuracy ?? 0.5;
          score = accuracyScore;

          // Penalty for high false positive rate
          const falsePositivePenalty = memory?.falsePositiveRate > 0.3 ? 0.2 : 0;
          score -= falsePositivePenalty;

          // Bonus for being reliable on key criteria
          const reliabilityBonus = this.calculateReliabilityBonus(memory, documentType);
          score += reliabilityBonus;
        }

        // Value of disagreement (agents that disagree usefully)
        const disagreementValue = await this.calculateDisagreementValue(agentType, allAgents);
        score += disagreementValue;

        return {
          agentType,
          score,
          accuracyScore: score,
          falsePositivePenalty: 0,
          reliabilityBonus: 0,
          disagreementValue,
        };
      })
    );

    // Sort by score
    scoredAgents.sort((a, b) => b.score - a.score);

    // Select top agents based on profile
    const selected = scoredAgents.slice(0, maxAgents);
    const excluded = scoredAgents.slice(maxAgents);

    // Log the decision
    await this.logAgentSelectionDecision(documentType, selected, scoredAgents);

    return {
      selectedAgents: selected.map((a) => a.agentType),
      reasoning: this.explainSelection(selected, scoredAgents),
      excluded: excluded.map((a) => ({
        agentType: a.agentType,
        reason: this.explainExclusion(a, selected[selected.length - 1]),
      })),
      profile,
      scoredAgents,
    };
  }

  /**
   * Calculate reliability bonus for an agent
   * @param {Object} memory - Agent memory
   * @param {string} documentType - Document type
   * @returns {number}
   */
  calculateReliabilityBonus(memory, documentType) {
    if (!memory?.mostReliableOn?.length) return 0;

    // Criteria that matter for this document type
    const importantCriteria = {
      code: ['correctness', 'security', 'maintainability'],
      technical: ['accuracy', 'clarity', 'completeness'],
      recipe: ['accuracy', 'clarity', 'safety'],
    };

    const relevant = importantCriteria[documentType] || importantCriteria.code;
    const reliableCount = memory.mostReliableOn.filter((c) => relevant.includes(c)).length;

    return reliableCount * 0.05; // 5% bonus per reliable criterion
  }

  /**
   * Calculate how valuable an agent's disagreement is
   * @param {string} agentType - Agent type
   * @param {string[]} allAgents - All agents
   * @returns {number}
   */
  async calculateDisagreementValue(agentType, _allAgents) {
    if (!this.conflictLearner) return 0;

    const conflicts = this.conflictLearner.getConflictsInvolving(agentType);

    if (conflicts.length < 10) return 0;

    // Agent is valuable if their disagreements are often correct
    const correctDisagreements = conflicts.filter((c) => c.outcome === 'winner_correct' && c.winner === agentType);

    return (correctDisagreements.length / conflicts.length) * 0.2;
  }

  /**
   * Explain the agent selection
   * @param {Object[]} selected - Selected agents
   * @param {Object[]} all - All scored agents
   * @returns {string}
   */
  explainSelection(selected, _all) {
    const parts = [];

    parts.push(`Selected ${selected.length} agents based on historical performance.`);

    const topAgent = selected[0];
    if (topAgent) {
      parts.push(`${topAgent.agentType} leads with score ${topAgent.score.toFixed(2)}.`);
    }

    if (this.agentMemory) {
      const improving = selected.filter((a) => {
        const memory = this.agentMemory.getMemory(a.agentType);
        return memory?.performanceTrend === 'improving';
      });
      if (improving.length > 0) {
        parts.push(`${improving.map((a) => a.agentType).join(', ')} showing improvement.`);
      }
    }

    return parts.join(' ');
  }

  /**
   * Explain why an agent was excluded
   * @param {Object} agent - Excluded agent
   * @param {Object} lastSelected - Last selected agent
   * @returns {string}
   */
  explainExclusion(agent, lastSelected) {
    if (!lastSelected) return 'Profile limit reached';

    const scoreDiff = lastSelected.score - agent.score;
    if (scoreDiff > 0.2) {
      return `Score ${agent.score.toFixed(2)} significantly below threshold`;
    }

    return `Score ${agent.score.toFixed(2)} below cutoff (${lastSelected.score.toFixed(2)})`;
  }

  /**
   * Log agent selection decision
   * @param {string} documentType - Document type
   * @param {Object[]} selected - Selected agents
   * @param {Object[]} all - All scored agents
   */
  async logAgentSelectionDecision(documentType, selected, all) {
    const decision = {
      timestamp: new Date().toISOString(),
      documentType,
      selected: selected.map((a) => a.agentType),
      scores: Object.fromEntries(all.map((a) => [a.agentType, a.score])),
    };

    // Store for analysis
    const key = `decision-${Date.now()}`;
    this.storage.set(key, decision);

    // Keep only recent decisions
    const decisions = [...this.storage.entries()];
    if (decisions.length > 100) {
      const oldest = decisions.sort((a, b) => a[0].localeCompare(b[0]))[0];
      this.storage.delete(oldest[0]);
    }
  }

  /**
   * Check if fewer agents would be better
   * @param {string} documentType - Document type
   * @param {Object[]} preliminaryResults - Initial evaluation results
   * @returns {Object}
   */
  shouldReduceAgents(documentType, preliminaryResults) {
    // If all agents strongly agree, additional agents add cost without value
    const scores = preliminaryResults.map((r) => r.overallScore);
    const stdDev = this.calculateStdDev(scores);

    if (stdDev < 5 && scores.length >= 3) {
      return {
        recommend: true,
        reason: 'High agreement detected - additional agents unlikely to add insight',
        suggestedCount: 3,
      };
    }

    return { recommend: false };
  }

  /**
   * Analyze success patterns
   * @returns {Object}
   */
  async analyzeSuccessPatterns() {
    const decisions = [...this.storage.values()];

    if (decisions.length < 10) {
      return { insufficient: true, samples: decisions.length };
    }

    // Analyze which agent combinations work best
    const combinations = {};
    for (const decision of decisions) {
      const key = decision.selected.sort().join(',');
      combinations[key] = (combinations[key] || 0) + 1;
    }

    const sortedCombinations = Object.entries(combinations)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);

    return {
      totalDecisions: decisions.length,
      topCombinations: sortedCombinations.map(([combo, count]) => ({
        agents: combo.split(','),
        frequency: count,
        percentage: Math.round((count / decisions.length) * 100),
      })),
    };
  }

  /**
   * Calculate standard deviation
   * @param {number[]} values - Array of numbers
   * @returns {number}
   */
  calculateStdDev(values) {
    if (values.length === 0) return 0;
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const squaredDiffs = values.map((v) => Math.pow(v - mean, 2));
    return Math.sqrt(squaredDiffs.reduce((a, b) => a + b, 0) / values.length);
  }

  /**
   * Get strategy statistics
   * @returns {Object}
   */
  getStats() {
    const decisions = [...this.storage.values()];

    return {
      totalDecisions: decisions.length,
      agentTypes: Object.keys(this.agentTypes),
      hasAgentMemory: !!this.agentMemory,
      hasConflictLearner: !!this.conflictLearner,
    };
  }

  /**
   * Clear stored decisions
   */
  clear() {
    this.storage.clear();
  }
}

module.exports = AdaptiveEvaluationStrategy;
module.exports.AdaptiveEvaluationStrategy = AdaptiveEvaluationStrategy;
module.exports.AGENT_TYPES = AGENT_TYPES;
