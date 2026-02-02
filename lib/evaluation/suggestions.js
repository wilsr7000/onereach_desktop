/**
 * Suggestion Provenance
 * Part of the Governed Self-Improving Agent Runtime
 * 
 * Tracks suggestion origins, confidence, and impact
 */

/**
 * Suggestion priority levels
 */
const PRIORITY_LEVELS = {
  HIGH: 'high',
  MEDIUM: 'medium',
  LOW: 'low'
};

/**
 * Impact estimate levels
 */
const IMPACT_LEVELS = {
  HIGH: 'high',
  MEDIUM: 'medium',
  LOW: 'low',
  UNKNOWN: 'unknown'
};

/**
 * Suggestion Manager
 * Manages suggestions with full provenance tracking
 */
class SuggestionManager {
  constructor(options = {}) {
    this.suggestions = new Map(); // id -> suggestion
    this.appliedSuggestions = [];
    this.ignoredSuggestions = [];
  }

  /**
   * Create a suggestion with provenance
   * @param {Object} data - Suggestion data
   * @returns {Object} Suggestion with provenance
   */
  create(data) {
    const id = `suggestion-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    
    const suggestion = {
      id,
      
      // Core content
      text: data.text,
      category: data.category || 'general',
      priority: data.priority || PRIORITY_LEVELS.MEDIUM,
      
      // Provenance tracking
      originatingAgents: data.originatingAgents || [],
      primaryAgent: data.primaryAgent || data.originatingAgents?.[0],
      
      // Confidence and impact
      confidence: this.calculateConfidence(data),
      impactEstimate: this.estimateImpact(data),
      
      // Apply action
      applySuggestion: data.applySuggestion || null,
      isApplicable: !!data.applySuggestion,
      
      // Context
      criterion: data.criterion || null,
      evidence: data.evidence || [],
      relatedFiles: data.relatedFiles || [],
      
      // Metadata
      createdAt: new Date().toISOString(),
      evaluationId: data.evaluationId,
      documentType: data.documentType,
      
      // Status
      status: 'pending', // pending, applied, ignored, modified
      appliedAt: null,
      modifiedVersion: null
    };

    this.suggestions.set(id, suggestion);
    return suggestion;
  }

  /**
   * Calculate confidence based on agent agreement
   * @param {Object} data - Suggestion data
   * @returns {number} Confidence score 0-1
   */
  calculateConfidence(data) {
    const agentCount = data.originatingAgents?.length || 1;
    const totalAgents = data.totalAgents || 4;
    
    // Base confidence from agent agreement
    let confidence = agentCount / totalAgents;
    
    // Boost for high priority from multiple agents
    if (data.priority === PRIORITY_LEVELS.HIGH && agentCount > 1) {
      confidence += 0.15;
    }
    
    // Boost for specific evidence
    if (data.evidence?.length > 0) {
      confidence += 0.1;
    }
    
    return Math.min(confidence, 1.0);
  }

  /**
   * Estimate the impact of applying the suggestion
   * @param {Object} data - Suggestion data
   * @returns {string} Impact level
   */
  estimateImpact(data) {
    // High priority + multiple agents = high impact
    if (data.priority === PRIORITY_LEVELS.HIGH && (data.originatingAgents?.length || 0) > 1) {
      return IMPACT_LEVELS.HIGH;
    }
    
    // Low priority = low impact
    if (data.priority === PRIORITY_LEVELS.LOW) {
      return IMPACT_LEVELS.LOW;
    }
    
    // Security/performance categories = potentially high impact
    if (['security', 'performance', 'reliability'].includes(data.category)) {
      return IMPACT_LEVELS.HIGH;
    }
    
    return IMPACT_LEVELS.MEDIUM;
  }

  /**
   * Get a suggestion by ID
   * @param {string} id - Suggestion ID
   * @returns {Object|null}
   */
  get(id) {
    return this.suggestions.get(id) || null;
  }

  /**
   * Get all suggestions for an evaluation
   * @param {string} evaluationId - Evaluation ID
   * @returns {Object[]}
   */
  getForEvaluation(evaluationId) {
    return [...this.suggestions.values()]
      .filter(s => s.evaluationId === evaluationId);
  }

  /**
   * Mark a suggestion as applied
   * @param {string} id - Suggestion ID
   * @param {Object} result - Application result
   * @returns {Object} Updated suggestion
   */
  markApplied(id, result = {}) {
    const suggestion = this.suggestions.get(id);
    if (!suggestion) return null;
    
    suggestion.status = 'applied';
    suggestion.appliedAt = new Date().toISOString();
    suggestion.applicationResult = result;
    
    this.appliedSuggestions.push({
      suggestionId: id,
      appliedAt: suggestion.appliedAt,
      result
    });
    
    return suggestion;
  }

  /**
   * Mark a suggestion as ignored
   * @param {string} id - Suggestion ID
   * @param {string} reason - Reason for ignoring
   * @returns {Object} Updated suggestion
   */
  markIgnored(id, reason = '') {
    const suggestion = this.suggestions.get(id);
    if (!suggestion) return null;
    
    suggestion.status = 'ignored';
    suggestion.ignoredAt = new Date().toISOString();
    suggestion.ignoreReason = reason;
    
    this.ignoredSuggestions.push({
      suggestionId: id,
      ignoredAt: suggestion.ignoredAt,
      reason
    });
    
    return suggestion;
  }

  /**
   * Mark a suggestion as modified (partially applied)
   * @param {string} id - Suggestion ID
   * @param {string} modifiedVersion - What was actually applied
   * @returns {Object} Updated suggestion
   */
  markModified(id, modifiedVersion) {
    const suggestion = this.suggestions.get(id);
    if (!suggestion) return null;
    
    suggestion.status = 'modified';
    suggestion.modifiedAt = new Date().toISOString();
    suggestion.modifiedVersion = modifiedVersion;
    
    return suggestion;
  }

  /**
   * Get suggestions grouped by agent
   * @param {string} evaluationId - Evaluation ID
   * @returns {Object} Grouped suggestions
   */
  getGroupedByAgent(evaluationId) {
    const suggestions = this.getForEvaluation(evaluationId);
    const grouped = {};
    
    for (const suggestion of suggestions) {
      for (const agent of suggestion.originatingAgents) {
        if (!grouped[agent]) {
          grouped[agent] = [];
        }
        grouped[agent].push(suggestion);
      }
    }
    
    return grouped;
  }

  /**
   * Get suggestions by priority
   * @param {string} evaluationId - Evaluation ID
   * @returns {Object} Grouped by priority
   */
  getGroupedByPriority(evaluationId) {
    const suggestions = this.getForEvaluation(evaluationId);
    
    return {
      high: suggestions.filter(s => s.priority === PRIORITY_LEVELS.HIGH),
      medium: suggestions.filter(s => s.priority === PRIORITY_LEVELS.MEDIUM),
      low: suggestions.filter(s => s.priority === PRIORITY_LEVELS.LOW)
    };
  }

  /**
   * Get suggestion statistics
   * @param {string} evaluationId - Optional evaluation ID
   * @returns {Object} Statistics
   */
  getStats(evaluationId) {
    const suggestions = evaluationId 
      ? this.getForEvaluation(evaluationId)
      : [...this.suggestions.values()];
    
    const byPriority = {
      high: suggestions.filter(s => s.priority === PRIORITY_LEVELS.HIGH).length,
      medium: suggestions.filter(s => s.priority === PRIORITY_LEVELS.MEDIUM).length,
      low: suggestions.filter(s => s.priority === PRIORITY_LEVELS.LOW).length
    };
    
    const byStatus = {
      pending: suggestions.filter(s => s.status === 'pending').length,
      applied: suggestions.filter(s => s.status === 'applied').length,
      ignored: suggestions.filter(s => s.status === 'ignored').length,
      modified: suggestions.filter(s => s.status === 'modified').length
    };
    
    const avgConfidence = suggestions.length > 0
      ? suggestions.reduce((sum, s) => sum + s.confidence, 0) / suggestions.length
      : 0;
    
    return {
      total: suggestions.length,
      byPriority,
      byStatus,
      avgConfidence,
      applicableCount: suggestions.filter(s => s.isApplicable).length
    };
  }

  /**
   * Convert suggestion to task
   * @param {string} id - Suggestion ID
   * @returns {Object} Task-compatible object
   */
  toTask(id) {
    const suggestion = this.suggestions.get(id);
    if (!suggestion) return null;
    
    return {
      agent: 'aider',
      type: 'implement',
      description: suggestion.text,
      source: 'evaluation',
      sourceAgent: suggestion.primaryAgent,
      priority: suggestion.priority === 'high' ? 0 : suggestion.priority === 'medium' ? 5 : 8,
      context: {
        suggestionId: suggestion.id,
        criterion: suggestion.criterion,
        applySuggestion: suggestion.applySuggestion,
        files: suggestion.relatedFiles,
        originatingAgents: suggestion.originatingAgents,
        confidence: suggestion.confidence,
        impactEstimate: suggestion.impactEstimate
      }
    };
  }

  /**
   * Clear all suggestions
   */
  clear() {
    this.suggestions.clear();
    this.appliedSuggestions = [];
    this.ignoredSuggestions = [];
  }
}

module.exports = SuggestionManager;
module.exports.SuggestionManager = SuggestionManager;
module.exports.PRIORITY_LEVELS = PRIORITY_LEVELS;
module.exports.IMPACT_LEVELS = IMPACT_LEVELS;


