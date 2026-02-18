/**
 * Conflict Resolution Learner
 * Part of the Governed Self-Improving Agent Runtime
 *
 * Every conflict resolution becomes training data
 */

/**
 * Resolution types
 */
const RESOLUTION_TYPES = {
  HUMAN_OVERRIDE: 'human_override',
  ACCEPTED_HIGH: 'accepted_high',
  ACCEPTED_LOW: 'accepted_low',
  COMPROMISE: 'compromise',
  AUTO_RESOLVED: 'auto_resolved',
};

/**
 * Conflict Resolution Learner
 * Learns from how conflicts are resolved
 */
class ConflictResolutionLearner {
  constructor(options = {}) {
    this.storage = options.storage || new Map();
    this.resolutionPatterns = new Map();
    this.minSamplesForPrediction = options.minSamples || 5;
  }

  /**
   * Record how a conflict was resolved
   * @param {Object} conflict - The conflict
   * @param {Object} resolution - Resolution data
   * @returns {Object} Recorded resolution
   */
  async recordResolution(conflict, resolution) {
    const record = {
      id: `resolution-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      conflictId: conflict.id,
      timestamp: new Date().toISOString(),

      // The conflict
      criterion: conflict.criterion,
      agents: conflict.agents.map((a) => ({
        agentType: a.agentType,
        score: a.score,
        reasoning: a.reasoning,
      })),
      spread: conflict.spread,

      // How it was resolved
      resolutionType: resolution.type,
      winner: resolution.winner,
      humanOverride: resolution.humanOverride || false,

      // Context
      documentType: conflict.documentType,

      // The outcome (filled in later)
      outcome: null,
      outcomeTimestamp: null,
    };

    this.storage.set(record.id, record);
    return record;
  }

  /**
   * Update resolution with actual outcome
   * @param {string} resolutionId - Resolution ID
   * @param {Object} outcome - Outcome data
   */
  async recordOutcomeForResolution(resolutionId, outcome) {
    const record = this.storage.get(resolutionId);
    if (!record) return;

    record.outcome = outcome.type; // 'winner_correct', 'winner_wrong', 'both_wrong'
    record.outcomeTimestamp = new Date().toISOString();

    this.storage.set(resolutionId, record);

    // Learn from this
    await this.updatePatterns(record);
  }

  /**
   * Update learned patterns from resolution
   * @param {Object} record - Resolution record
   */
  async updatePatterns(record) {
    if (!record.outcome) return;

    const key = this.getPatternKey(record);

    let pattern = this.resolutionPatterns.get(key) || {
      matchup: this.formatMatchup(record.agents),
      criterion: record.criterion,
      samples: 0,
      agent1Wins: 0,
      agent2Wins: 0,
      agent1WinRate: 0.5,
      contexts: {},
    };

    pattern.samples++;

    // Track which agent was correct
    if (record.outcome === 'winner_correct') {
      if (record.winner === record.agents[0]?.agentType) {
        pattern.agent1Wins++;
      } else {
        pattern.agent2Wins++;
      }
    }

    pattern.agent1WinRate = pattern.agent1Wins / Math.max(pattern.samples, 1);

    // Track by context
    const context = record.documentType || 'unknown';
    if (!pattern.contexts[context]) {
      pattern.contexts[context] = { agent1Wins: 0, agent2Wins: 0, samples: 0 };
    }
    pattern.contexts[context].samples++;
    if (record.outcome === 'winner_correct') {
      if (record.winner === record.agents[0]?.agentType) {
        pattern.contexts[context].agent1Wins++;
      } else {
        pattern.contexts[context].agent2Wins++;
      }
    }

    this.resolutionPatterns.set(key, pattern);
  }

  /**
   * Get pattern key for a conflict
   * @param {Object} record - Resolution record
   * @returns {string}
   */
  getPatternKey(record) {
    const agents = record.agents.map((a) => a.agentType).sort();
    return `${agents.join('-vs-')}:${record.criterion}`;
  }

  /**
   * Format matchup string
   * @param {Object[]} agents - Agents in conflict
   * @returns {string}
   */
  formatMatchup(agents) {
    return agents.map((a) => a.agentType).join(' vs ');
  }

  /**
   * Get prediction for how to resolve a conflict
   * @param {Object} conflict - The conflict
   * @returns {Object} Prediction
   */
  async getPrediction(conflict) {
    const key = this.getPatternKey({
      agents: conflict.agents,
      criterion: conflict.criterion,
    });

    const pattern = this.resolutionPatterns.get(key);

    if (!pattern || pattern.samples < this.minSamplesForPrediction) {
      return {
        confidence: 'low',
        recommendation: null,
        reason: 'Insufficient historical data',
        samples: pattern?.samples || 0,
      };
    }

    const agent1 = conflict.agents[0]?.agentType;
    const agent2 = conflict.agents[1]?.agentType;

    if (pattern.agent1WinRate > 0.65) {
      return {
        confidence: 'high',
        recommendation: agent1,
        reason: `${agent1} is correct ${Math.round(pattern.agent1WinRate * 100)}% of the time on ${conflict.criterion} conflicts`,
        samples: pattern.samples,
        winRate: pattern.agent1WinRate,
      };
    } else if (pattern.agent1WinRate < 0.35) {
      return {
        confidence: 'high',
        recommendation: agent2,
        reason: `${agent2} is correct ${Math.round((1 - pattern.agent1WinRate) * 100)}% of the time on ${conflict.criterion} conflicts`,
        samples: pattern.samples,
        winRate: 1 - pattern.agent1WinRate,
      };
    }

    return {
      confidence: 'low',
      recommendation: null,
      reason: 'Historical outcomes are mixed - human judgment recommended',
      samples: pattern.samples,
      winRate: null,
    };
  }

  /**
   * Get conflicts involving a specific agent
   * @param {string} agentType - Agent type
   * @returns {Object[]}
   */
  getConflictsInvolving(agentType) {
    const results = [];

    for (const record of this.storage.values()) {
      if (record.agents?.some((a) => a.agentType === agentType)) {
        results.push(record);
      }
    }

    return results;
  }

  /**
   * Get all learned patterns
   * @returns {Object[]}
   */
  getAllPatterns() {
    return [...this.resolutionPatterns.values()]
      .filter((p) => p.samples >= this.minSamplesForPrediction)
      .sort((a, b) => b.samples - a.samples);
  }

  /**
   * Get pattern summary
   * @returns {Object}
   */
  getPatternSummary() {
    const patterns = this.getAllPatterns();

    const strongPatterns = patterns.filter((p) => p.agent1WinRate > 0.65 || p.agent1WinRate < 0.35);

    const weakPatterns = patterns.filter((p) => p.agent1WinRate >= 0.35 && p.agent1WinRate <= 0.65);

    return {
      totalPatterns: patterns.length,
      strongPatterns: strongPatterns.length,
      weakPatterns: weakPatterns.length,
      totalResolutions: [...this.storage.values()].length,
      resolutionsWithOutcome: [...this.storage.values()].filter((r) => r.outcome).length,
      patterns: patterns.slice(0, 10).map((p) => ({
        matchup: p.matchup,
        criterion: p.criterion,
        samples: p.samples,
        dominantAgent: p.agent1WinRate > 0.5 ? p.matchup.split(' vs ')[0] : p.matchup.split(' vs ')[1],
        winRate: p.agent1WinRate > 0.5 ? p.agent1WinRate : 1 - p.agent1WinRate,
      })),
    };
  }

  /**
   * Clear all data
   */
  clear() {
    this.storage.clear();
    this.resolutionPatterns.clear();
  }
}

module.exports = ConflictResolutionLearner;
module.exports.ConflictResolutionLearner = ConflictResolutionLearner;
module.exports.RESOLUTION_TYPES = RESOLUTION_TYPES;
