/**
 * Cross-Agent Learning
 *
 * Generalizes insights from individual agent improvements to benefit
 * all agents. When a fix works for agent A, the system checks if
 * similar patterns exist in other agents and proactively suggests
 * or applies the same type of fix.
 *
 * Three mechanisms:
 *   1. Error pattern propagation: if "timeout" fix worked for A, check B/C
 *   2. Prompt pattern transfer: successful prompt structures get reused
 *   3. Effectiveness-weighted prioritization: the orchestrator prioritizes
 *      fix types that have historically worked across all agents
 */

'use strict';

const { getLogQueue } = require('../log-event-queue');
const log = getLogQueue();

const MAX_PROMPT_PATTERNS = 30;

class CrossAgentLearning {
  constructor() {
    // Successful prompt patterns extracted from effective improvements
    this._promptPatterns = [];

    // Error patterns that were successfully fixed, keyed by error regex
    this._fixedErrorPatterns = new Map();

    // Agents that have already been checked for a given pattern
    this._propagatedTo = new Map();
  }

  /**
   * Record that a fix was effective for an agent. Extracts generalizable
   * patterns for cross-agent application.
   *
   * @param {object} record - Feedback loop deployment record
   * @param {object} agent - Agent that was improved
   * @param {object} improvement - The improvement that was applied
   */
  recordEffectiveFix(record, agent, improvement) {
    if (!record || record.outcome !== 'effective') return;

    // Extract error pattern if available
    if (record.specificIssue) {
      const key = this._normalizePattern(record.specificIssue);
      if (key) {
        if (!this._fixedErrorPatterns.has(key)) {
          this._fixedErrorPatterns.set(key, {
            pattern: key,
            fixType: record.improvementType,
            successCount: 0,
            agents: [],
          });
        }
        const entry = this._fixedErrorPatterns.get(key);
        entry.successCount++;
        if (!entry.agents.includes(agent.id)) {
          entry.agents.push(agent.id);
        }
      }
    }

    // Extract prompt pattern from successful prompt improvements
    if (improvement?.type === 'prompt' && improvement.patch?.prompt) {
      this._extractPromptPattern(agent, improvement.patch.prompt, record);
    }

    log.info('agent-learning', 'Cross-agent learning: recorded effective fix', {
      agentId: agent.id,
      type: record.improvementType,
      patterns: this._fixedErrorPatterns.size,
      promptPatterns: this._promptPatterns.length,
    });
  }

  /**
   * Check if any learned patterns apply to a different agent.
   * Returns suggested fixes that worked for other agents with similar issues.
   *
   * @param {string} agentId - Agent to check
   * @param {object} windowData - Interaction window for this agent
   * @returns {Array<{ pattern, fixType, confidence, sourceAgents }>}
   */
  getSuggestedFixes(agentId, windowData) {
    const suggestions = [];
    const errors = windowData.interactions
      .filter((i) => !i.success && i.error)
      .map((i) => i.error);

    for (const [key, entry] of this._fixedErrorPatterns) {
      if (entry.agents.includes(agentId)) continue;

      const propagationKey = `${key}:${agentId}`;
      if (this._propagatedTo.has(propagationKey)) continue;

      const matching = errors.filter((e) => this._matchesPattern(e, key));
      if (matching.length >= 2) {
        suggestions.push({
          pattern: key,
          fixType: entry.fixType,
          confidence: Math.min(0.9, 0.5 + entry.successCount * 0.1),
          sourceAgents: entry.agents.slice(),
          matchingErrors: matching.length,
        });
        this._propagatedTo.set(propagationKey, Date.now());
      }
    }

    return suggestions.sort((a, b) => b.confidence - a.confidence);
  }

  /**
   * Get prompt improvement hints based on patterns that worked for
   * other agents. The improvement engine can use these as additional
   * context when generating prompt fixes.
   *
   * @param {string} agentId - Agent being improved
   * @param {string} failureCategory - Type of failure
   * @returns {string|null} Hint text for the improvement engine
   */
  getPromptHints(agentId, failureCategory) {
    const relevant = this._promptPatterns.filter(
      (p) => p.failureCategory === failureCategory && p.agentId !== agentId
    );

    if (relevant.length === 0) return null;

    const best = relevant.sort((a, b) => b.effectivenessScore - a.effectivenessScore)[0];

    return `A similar issue in the "${best.agentName}" agent was fixed by: ${best.technique}. ` +
      `The key change was: ${best.keyChange}`;
  }

  /**
   * Get overall statistics about cross-agent learning.
   */
  getStats() {
    return {
      fixedErrorPatterns: this._fixedErrorPatterns.size,
      promptPatterns: this._promptPatterns.length,
      propagations: this._propagatedTo.size,
      topPatterns: Array.from(this._fixedErrorPatterns.values())
        .sort((a, b) => b.successCount - a.successCount)
        .slice(0, 5)
        .map((p) => ({ pattern: p.pattern, fixType: p.fixType, successCount: p.successCount })),
    };
  }

  _extractPromptPattern(agent, newPrompt, record) {
    if (this._promptPatterns.length >= MAX_PROMPT_PATTERNS) {
      this._promptPatterns.shift();
    }

    const failureRateDelta = record.delta?.failureRate || 0;

    this._promptPatterns.push({
      agentId: agent.id,
      agentName: agent.name || agent.id,
      failureCategory: record.improvementType,
      technique: record.specificIssue?.slice(0, 100) || 'prompt refinement',
      keyChange: this._summarizePromptChange(agent.prompt, newPrompt),
      effectivenessScore: Math.abs(failureRateDelta),
      timestamp: Date.now(),
    });
  }

  _summarizePromptChange(oldPrompt, newPrompt) {
    if (!oldPrompt || !newPrompt) return 'new prompt added';
    const oldLen = oldPrompt.length;
    const newLen = newPrompt.length;
    if (newLen > oldLen * 1.5) return 'significantly expanded with more detail';
    if (newLen < oldLen * 0.7) return 'simplified and focused';
    return 'refined with targeted adjustments';
  }

  _normalizePattern(issue) {
    if (!issue || issue.length < 10) return null;
    return issue
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80);
  }

  _matchesPattern(errorMsg, pattern) {
    if (!errorMsg || !pattern) return false;
    const normalized = this._normalizePattern(errorMsg);
    if (!normalized) return false;

    const words = pattern.split(' ').filter((w) => w.length > 3);
    if (words.length === 0) return false;

    const matching = words.filter((w) => normalized.includes(w));
    return matching.length / words.length >= 0.5;
  }

  clear() {
    this._promptPatterns.length = 0;
    this._fixedErrorPatterns.clear();
    this._propagatedTo.clear();
  }
}

module.exports = { CrossAgentLearning };
