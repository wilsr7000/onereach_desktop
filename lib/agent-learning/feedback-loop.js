/**
 * Feedback Loop
 *
 * Closes the self-improvement cycle: after deploying a fix, tracks whether
 * the agent's performance actually improved. Builds a memory of which fix
 * types work for which failure patterns, so the system gets better at
 * improving agents over time.
 *
 * Data structure (persisted to Agent Product Manager space):
 *   deploymentRecord = {
 *     id,
 *     agentId,
 *     improvementType,    // 'prompt' | 'ui' | 'routing' | 'reliability' | ...
 *     specificIssue,      // what the evaluator identified
 *     deployedAt,         // timestamp
 *     preMetrics,         // { failureRate, rephraseRate, uiSpecRate, avgResponseTimeMs }
 *     postMetrics,        // same shape, computed after cooldown
 *     outcome,            // 'effective' | 'ineffective' | 'degraded' | 'pending'
 *     delta,              // { failureRate: -0.15, ... } (negative = improved)
 *   }
 */

'use strict';

const { getLogQueue } = require('../log-event-queue');
const log = getLogQueue();

const COOLDOWN_MS = 5 * 60 * 1000;
const MAX_RECORDS = 200;

class FeedbackLoop {
  constructor() {
    this._deployments = [];
    this._fixEffectiveness = new Map();
  }

  /**
   * Record that an improvement was deployed. Captures pre-deployment metrics.
   */
  recordDeployment(params) {
    const { agentId, improvementType, specificIssue, preMetrics } = params;
    const record = {
      id: `deploy-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      agentId,
      improvementType,
      specificIssue: (specificIssue || '').slice(0, 200),
      deployedAt: Date.now(),
      preMetrics: { ...preMetrics },
      postMetrics: null,
      outcome: 'pending',
      delta: null,
    };

    this._deployments.push(record);
    if (this._deployments.length > MAX_RECORDS) {
      this._deployments.shift();
    }

    log.info('agent-learning', 'Deployment recorded for feedback tracking', {
      agentId,
      improvementType,
      recordId: record.id,
    });

    return record.id;
  }

  /**
   * Evaluate pending deployments that have passed the cooldown period.
   * Called periodically by the orchestrator with current window data.
   *
   * @param {Function} getWindowFn - (agentId) => windowData from collector
   */
  evaluatePendingDeployments(getWindowFn) {
    const now = Date.now();
    let evaluated = 0;

    for (const record of this._deployments) {
      if (record.outcome !== 'pending') continue;
      if (now - record.deployedAt < COOLDOWN_MS) continue;

      const windowData = getWindowFn(record.agentId);
      if (!windowData || windowData.interactions.length < 3) continue;

      const postInteractions = windowData.interactions.filter(
        (i) => i.timestamp > record.deployedAt
      );
      if (postInteractions.length < 3) continue;

      const postMetrics = {
        failureRate: windowData.failureRate,
        rephraseRate: windowData.rephraseRate,
        uiSpecRate: windowData.uiSpecRate,
        avgResponseTimeMs: windowData.avgResponseTimeMs,
      };

      const delta = {
        failureRate: postMetrics.failureRate - record.preMetrics.failureRate,
        rephraseRate: postMetrics.rephraseRate - record.preMetrics.rephraseRate,
        uiSpecRate: postMetrics.uiSpecRate - record.preMetrics.uiSpecRate,
        avgResponseTimeMs: postMetrics.avgResponseTimeMs - record.preMetrics.avgResponseTimeMs,
      };

      let outcome;
      if (delta.failureRate < -0.05 || delta.rephraseRate < -0.05) {
        outcome = 'effective';
      } else if (delta.failureRate > 0.1 || delta.rephraseRate > 0.1) {
        outcome = 'degraded';
      } else {
        outcome = 'ineffective';
      }

      record.postMetrics = postMetrics;
      record.delta = delta;
      record.outcome = outcome;
      evaluated++;

      this._updateEffectivenessMemory(record);

      log.info('agent-learning', 'Deployment outcome evaluated', {
        agentId: record.agentId,
        type: record.improvementType,
        outcome,
        failureRateDelta: delta.failureRate.toFixed(3),
      });
    }

    return evaluated;
  }

  /**
   * Update the fix-effectiveness memory. This is what makes the system
   * self-improving: it learns which fix types work for which patterns.
   */
  _updateEffectivenessMemory(record) {
    const key = record.improvementType;
    if (!this._fixEffectiveness.has(key)) {
      this._fixEffectiveness.set(key, {
        type: key,
        attempts: 0,
        effective: 0,
        ineffective: 0,
        degraded: 0,
        patterns: [],
      });
    }

    const mem = this._fixEffectiveness.get(key);
    mem.attempts++;
    mem[record.outcome]++;

    mem.patterns.push({
      issue: record.specificIssue,
      outcome: record.outcome,
      preFailureRate: record.preMetrics.failureRate,
      delta: record.delta?.failureRate || 0,
    });

    if (mem.patterns.length > 50) {
      mem.patterns.shift();
    }
  }

  /**
   * Get effectiveness score for a fix type (0-1). Used by the orchestrator
   * to prioritize fix types that historically work better.
   */
  getEffectivenessScore(improvementType) {
    const mem = this._fixEffectiveness.get(improvementType);
    if (!mem || mem.attempts < 2) return 0.5;
    return mem.effective / mem.attempts;
  }

  /**
   * Get ranked fix types by historical effectiveness.
   * Returns array sorted best-first.
   */
  getRankedFixTypes() {
    const types = Array.from(this._fixEffectiveness.entries())
      .filter(([_, m]) => m.attempts >= 2)
      .map(([type, m]) => ({
        type,
        effectivenessRate: m.effective / m.attempts,
        attempts: m.attempts,
        effective: m.effective,
        degraded: m.degraded,
      }))
      .sort((a, b) => b.effectivenessRate - a.effectivenessRate);
    return types;
  }

  /**
   * Get context about past fixes for a specific issue pattern.
   * Used by the improvement engine to learn from past attempts.
   */
  getPatternContext(improvementType, issueKeywords) {
    const mem = this._fixEffectiveness.get(improvementType);
    if (!mem) return null;

    const keywords = (issueKeywords || '').toLowerCase().split(/\s+/).filter(Boolean);
    if (keywords.length === 0) return null;

    const relevant = mem.patterns.filter((p) =>
      keywords.some((kw) => p.issue.toLowerCase().includes(kw))
    );

    if (relevant.length === 0) return null;

    const effective = relevant.filter((p) => p.outcome === 'effective');
    const degraded = relevant.filter((p) => p.outcome === 'degraded');

    return {
      totalAttempts: relevant.length,
      effectiveCount: effective.length,
      degradedCount: degraded.length,
      successRate: effective.length / relevant.length,
      examples: relevant.slice(-3),
    };
  }

  /**
   * Check if a deployed fix degraded performance and should be rolled back.
   */
  getDegradedDeployments() {
    return this._deployments.filter((r) => r.outcome === 'degraded');
  }

  getPendingCount() {
    return this._deployments.filter((r) => r.outcome === 'pending').length;
  }

  getAllRecords() {
    return this._deployments.slice();
  }

  getEffectivenessMemory() {
    const result = {};
    for (const [key, val] of this._fixEffectiveness) {
      result[key] = { ...val, patterns: val.patterns.length };
    }
    return result;
  }

  clear() {
    this._deployments.length = 0;
    this._fixEffectiveness.clear();
  }
}

module.exports = { FeedbackLoop };
