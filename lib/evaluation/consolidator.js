/**
 * Evaluation Consolidator with Epistemic Framing
 * Part of the Governed Self-Improving Agent Runtime
 *
 * Merges agent evaluations, calculates weighted scores,
 * detects conflicts, and generates rationales
 */

const { AgentWeightingManager } = require('./weighting');

/**
 * Conflict detection threshold
 */
const CONFLICT_THRESHOLD = 20; // Points spread that indicates conflict

/**
 * Evaluation Consolidator
 * Consolidates multi-agent evaluations with epistemic framing
 */
class EvaluationConsolidator {
  constructor(options = {}) {
    this.weightingManager = options.weightingManager || new AgentWeightingManager();
    this.conflictLearner = options.conflictLearner; // Optional: for learned resolution
  }

  /**
   * Consolidate multiple agent evaluations
   * @param {Object[]} evaluations - Array of agent evaluations
   * @param {Object} context - Evaluation context
   * @returns {Object} Consolidated result with epistemic framing
   */
  async consolidate(evaluations, context = {}) {
    if (!evaluations || evaluations.length === 0) {
      return this.createEmptyResult();
    }

    const { documentType = 'code', weightingMode = 'contextual' } = context;

    // Apply weighting mode if specified
    if (weightingMode && this.weightingManager.setMode) {
      this.weightingManager.setMode(weightingMode);
    }

    // Get weights for the agents
    const agentTypes = evaluations.map((e) => e.agentType);
    const weightResult = this.weightingManager.getWeights(agentTypes, { documentType });
    const weights = weightResult.weights;

    // Calculate weighted scores
    const agentScores = evaluations.map((e) => ({
      agentType: e.agentType,
      agentId: e.agentId,
      agentIcon: e.agentIcon,
      rawScore: e.overallScore,
      weight: weights[e.agentType] || 1.0,
      weightedScore: e.overallScore * (weights[e.agentType] || 1.0),
    }));

    // Calculate aggregate score
    const aggregateScore = this.calculateAggregateScore(agentScores);

    // Consolidate criteria across agents
    const consolidatedCriteria = this.consolidateCriteria(evaluations, weights);

    // Detect conflicts
    const conflicts = await this.detectConflicts(evaluations, consolidatedCriteria);

    // Generate suggestions with provenance
    const suggestions = this.generateSuggestions(evaluations, conflicts);

    // Calculate confidence
    const confidence = this.calculateConfidence(evaluations, conflicts);

    // Generate epistemic rationale
    const rationale = this.generateRationale({
      aggregateScore,
      agentScores,
      consolidatedCriteria,
      conflicts,
      confidence,
    });

    // Identify primary drivers
    const primaryDrivers = this.identifyPrimaryDrivers(consolidatedCriteria);

    // Identify dominant conflicts
    const dominantConflicts = conflicts
      .filter((c) => c.spread >= CONFLICT_THRESHOLD)
      .map((c) => `${c.criterion} between ${c.agents.map((a) => a.agentType).join('/')}`);

    return {
      // Core scores
      aggregateScore: Math.round(aggregateScore * 10) / 10,
      confidence,

      // Per-agent breakdown
      agentScores: agentScores.map((s) => ({
        agentType: s.agentType,
        agentId: s.agentId,
        agentIcon: s.agentIcon,
        score: Math.round(s.rawScore),
        weight: s.weight,
        trend: this.determineTrend(s.rawScore, aggregateScore),
      })),

      // Consolidated criteria
      consolidatedCriteria,

      // Conflicts and resolutions
      conflicts,
      dominantConflicts,

      // Suggestions
      suggestions,

      // Epistemic framing (THE KEY ADDITION)
      epistemicFraming: {
        aggregateScore: Math.round(aggregateScore * 10) / 10,
        confidence,
        primaryDrivers,
        dominantConflicts,
        rationale,

        // Weighting transparency
        weightingMode: weightResult.mode,
        weightingDescription: weightResult.description,

        // Uncertainty indicators
        uncertaintyLevel: this.determineUncertaintyLevel(confidence, conflicts),
        recommendsHumanReview: confidence === 'low' || conflicts.length > 2,
      },

      // Metadata
      evaluatedAt: new Date().toISOString(),
      agentCount: evaluations.length,
      documentType,
    };
  }

  /**
   * Calculate aggregate score from weighted agent scores
   * @param {Object[]} agentScores - Agent scores with weights
   * @returns {number}
   */
  calculateAggregateScore(agentScores) {
    const totalWeight = agentScores.reduce((sum, s) => sum + s.weight, 0);
    const weightedSum = agentScores.reduce((sum, s) => sum + s.weightedScore, 0);
    return totalWeight > 0 ? weightedSum / totalWeight : 0;
  }

  /**
   * Consolidate criteria across agents
   * @param {Object[]} evaluations - Agent evaluations
   * @param {Object} weights - Agent weights
   * @returns {Object[]}
   */
  consolidateCriteria(evaluations, weights) {
    const criteriaMap = new Map();

    for (const evaluation of evaluations) {
      const agentWeight = weights[evaluation.agentType] || 1.0;

      for (const criterion of evaluation.criteria || []) {
        const key = criterion.name;

        if (!criteriaMap.has(key)) {
          criteriaMap.set(key, {
            name: key,
            scores: [],
            comments: [],
            primaryAgent: evaluation.agentType,
            contributingAgents: [],
          });
        }

        const entry = criteriaMap.get(key);
        entry.scores.push({
          score: criterion.score,
          weight: agentWeight * (criterion.weight || 1.0),
          agentType: evaluation.agentType,
        });
        entry.comments.push({
          agentType: evaluation.agentType,
          comment: criterion.comment,
        });
        entry.contributingAgents.push(evaluation.agentType);
      }
    }

    // Calculate consolidated score for each criterion
    return [...criteriaMap.values()].map((entry) => {
      const totalWeight = entry.scores.reduce((sum, s) => sum + s.weight, 0);
      const weightedSum = entry.scores.reduce((sum, s) => sum + s.score * s.weight, 0);
      const score = totalWeight > 0 ? weightedSum / totalWeight : 0;

      // Check for conflicts
      const scores = entry.scores.map((s) => s.score);
      const spread = Math.max(...scores) - Math.min(...scores);
      const hasConflict = spread >= CONFLICT_THRESHOLD;

      return {
        name: entry.name,
        score: Math.round(score),
        primaryAgent: entry.primaryAgent,
        contributingAgents: [...new Set(entry.contributingAgents)],
        hasConflict,
        spread,
        comments: entry.comments,
      };
    });
  }

  /**
   * Detect conflicts between agents
   * @param {Object[]} evaluations - Agent evaluations
   * @param {Object[]} consolidatedCriteria - Consolidated criteria
   * @returns {Object[]}
   */
  async detectConflicts(evaluations, consolidatedCriteria) {
    const conflicts = [];

    for (const criterion of consolidatedCriteria) {
      if (!criterion.hasConflict) continue;

      // Find the disagreeing agents
      const agentScores = [];
      for (const evaluation of evaluations) {
        const crit = evaluation.criteria?.find((c) => c.name === criterion.name);
        if (crit) {
          agentScores.push({
            agentType: evaluation.agentType,
            agentId: evaluation.agentId,
            agentIcon: evaluation.agentIcon,
            score: crit.score,
            reasoning: crit.comment,
          });
        }
      }

      // Sort by score to identify extremes
      agentScores.sort((a, b) => b.score - a.score);

      const conflict = {
        criterion: criterion.name,
        spread: criterion.spread,
        agents: agentScores,
        highScorer: agentScores[0],
        lowScorer: agentScores[agentScores.length - 1],
      };

      // Get learned resolution if available
      if (this.conflictLearner) {
        conflict.learnedResolution = await this.conflictLearner.getPrediction(conflict);
      }

      // Generate resolution suggestion
      conflict.resolution = this.generateResolutionSuggestion(conflict);

      conflicts.push(conflict);
    }

    return conflicts;
  }

  /**
   * Generate resolution suggestion for a conflict
   * @param {Object} conflict - Conflict details
   * @returns {string}
   */
  generateResolutionSuggestion(conflict) {
    // Use learned resolution if confident
    if (conflict.learnedResolution?.confidence === 'high') {
      return `Based on historical data, ${conflict.learnedResolution.recommendation} tends to be correct on ${conflict.criterion} conflicts. ${conflict.learnedResolution.reason}`;
    }

    // Generate heuristic suggestion
    const high = conflict.highScorer;
    const low = conflict.lowScorer;

    if (conflict.spread > 30) {
      return `Significant disagreement between ${high.agentType} (${high.score}) and ${low.agentType} (${low.score}). Human review recommended.`;
    }

    return `Consider both perspectives: ${high.agentType} sees "${high.reasoning}" while ${low.agentType} notes "${low.reasoning}".`;
  }

  /**
   * Generate suggestions with provenance
   * @param {Object[]} evaluations - Agent evaluations
   * @param {Object[]} conflicts - Detected conflicts
   * @returns {Object[]}
   */
  generateSuggestions(evaluations, _conflicts) {
    const suggestions = [];
    const suggestionMap = new Map(); // Group similar suggestions

    for (const evaluation of evaluations) {
      for (const suggestion of evaluation.suggestions || []) {
        const key = suggestion.text.toLowerCase().slice(0, 50);

        if (suggestionMap.has(key)) {
          // Add this agent to existing suggestion
          suggestionMap.get(key).originatingAgents.push(evaluation.agentType);
        } else {
          suggestionMap.set(key, {
            text: suggestion.text,
            priority: suggestion.priority,
            applySuggestion: suggestion.applySuggestion,
            originatingAgents: [evaluation.agentType],
            confidence: 0,
            impactEstimate: 'medium',
          });
        }
      }
    }

    // Calculate confidence and impact for each suggestion
    for (const suggestion of suggestionMap.values()) {
      // More agents = higher confidence
      suggestion.confidence = Math.min(suggestion.originatingAgents.length / evaluations.length + 0.3, 1);

      // High priority from multiple agents = high impact
      if (suggestion.priority === 'high' && suggestion.originatingAgents.length > 1) {
        suggestion.impactEstimate = 'high';
      } else if (suggestion.priority === 'low') {
        suggestion.impactEstimate = 'low';
      }

      suggestions.push(suggestion);
    }

    // Sort by priority and confidence
    suggestions.sort((a, b) => {
      const priorityOrder = { high: 0, medium: 1, low: 2 };
      const priorityDiff = priorityOrder[a.priority] - priorityOrder[b.priority];
      if (priorityDiff !== 0) return priorityDiff;
      return b.confidence - a.confidence;
    });

    return suggestions;
  }

  /**
   * Calculate overall confidence level
   * @param {Object[]} evaluations - Agent evaluations
   * @param {Object[]} conflicts - Detected conflicts
   * @returns {string} 'high' | 'medium' | 'low'
   */
  calculateConfidence(evaluations, conflicts) {
    // High agent agreement = high confidence
    const scores = evaluations.map((e) => e.overallScore);
    const stdDev = this.calculateStdDev(scores);

    // Few conflicts = high confidence
    const conflictRatio = conflicts.length / (evaluations.length || 1);

    if (stdDev < 10 && conflictRatio < 0.2) return 'high';
    if (stdDev < 20 && conflictRatio < 0.5) return 'medium';
    return 'low';
  }

  /**
   * Generate epistemic rationale
   * @param {Object} data - Consolidation data
   * @returns {string}
   */
  generateRationale(data) {
    const { aggregateScore, agentScores, consolidatedCriteria, conflicts, confidence } = data;

    const parts = [];

    // Score explanation
    parts.push(
      `Overall score of ${Math.round(aggregateScore)} reflects weighted consensus of ${agentScores.length} evaluating agents.`
    );

    // Driver explanation
    const lowest = consolidatedCriteria.reduce((min, c) => (c.score < min.score ? c : min), { score: 100 });
    const highest = consolidatedCriteria.reduce((max, c) => (c.score > max.score ? c : max), { score: 0 });

    if (lowest.score < aggregateScore - 10) {
      parts.push(`Score primarily driven down by ${lowest.name} (${lowest.score}).`);
    }
    if (highest.score > aggregateScore + 10) {
      parts.push(`Strong performance in ${highest.name} (${highest.score}).`);
    }

    // Conflict explanation
    if (conflicts.length > 0) {
      parts.push(`${conflicts.length} area(s) of agent disagreement identified.`);
    }

    // Confidence explanation
    if (confidence === 'low') {
      parts.push('Confidence is low due to significant agent disagreement. Human review recommended.');
    }

    return parts.join(' ');
  }

  /**
   * Identify primary drivers of the score
   * @param {Object[]} criteria - Consolidated criteria
   * @returns {string[]}
   */
  identifyPrimaryDrivers(criteria) {
    const sorted = [...criteria].sort((a, b) => Math.abs(50 - a.score) - Math.abs(50 - b.score));
    return sorted.slice(-3).map((c) => c.name);
  }

  /**
   * Determine trend for an agent
   * @param {number} score - Agent score
   * @param {number} average - Aggregate score
   * @returns {string}
   */
  determineTrend(score, average) {
    if (score >= average + 5) return 'best';
    if (score <= average - 5) return 'concern';
    return 'neutral';
  }

  /**
   * Determine uncertainty level
   * @param {string} confidence - Confidence level
   * @param {Object[]} conflicts - Conflicts
   * @returns {string}
   */
  determineUncertaintyLevel(confidence, conflicts) {
    if (confidence === 'high' && conflicts.length === 0) return 'low';
    if (confidence === 'low' || conflicts.length > 3) return 'high';
    return 'moderate';
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
   * Create empty result
   * @returns {Object}
   */
  createEmptyResult() {
    return {
      aggregateScore: 0,
      confidence: 'low',
      agentScores: [],
      consolidatedCriteria: [],
      conflicts: [],
      suggestions: [],
      epistemicFraming: {
        aggregateScore: 0,
        confidence: 'low',
        primaryDrivers: [],
        dominantConflicts: [],
        rationale: 'No evaluations provided',
        uncertaintyLevel: 'high',
        recommendsHumanReview: true,
      },
      evaluatedAt: new Date().toISOString(),
      agentCount: 0,
    };
  }
}

module.exports = EvaluationConsolidator;
module.exports.EvaluationConsolidator = EvaluationConsolidator;
module.exports.CONFLICT_THRESHOLD = CONFLICT_THRESHOLD;
