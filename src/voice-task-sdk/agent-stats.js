/**
 * Agent Statistics Tracker
 *
 * Tracks performance metrics for agents:
 * - Total bids
 * - Wins (selected as winner)
 * - Executions (task assigned)
 * - Successes (task completed successfully)
 * - Failures (execution errors)
 * - Average confidence
 * - Bid history for debugging
 */

const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const { getLogQueue } = require('../../lib/log-event-queue');
const log = getLogQueue();

class AgentStatsTracker {
  constructor() {
    this.statsDir = null;
    this.statsFile = null;
    this.historyFile = null;
    this.stats = {};
    this.bidHistory = [];
    this.maxHistorySize = 100; // Keep last 100 bid events
    this.initialized = false;
  }

  /**
   * Initialize the stats tracker
   */
  async init() {
    if (this.initialized) return;

    try {
      const userDataPath = app?.getPath('userData') || path.join(process.env.HOME, '.gsx-power-user');
      this.statsDir = path.join(userDataPath, 'agents');
      this.statsFile = path.join(this.statsDir, 'agent-stats.json');
      this.historyFile = path.join(this.statsDir, 'bid-history.json');

      // Ensure directory exists
      if (!fs.existsSync(this.statsDir)) {
        fs.mkdirSync(this.statsDir, { recursive: true });
      }

      // Load existing stats
      if (fs.existsSync(this.statsFile)) {
        const data = fs.readFileSync(this.statsFile, 'utf8');
        this.stats = JSON.parse(data);
      }

      // Load existing history
      if (fs.existsSync(this.historyFile)) {
        const data = fs.readFileSync(this.historyFile, 'utf8');
        this.bidHistory = JSON.parse(data);
      }

      this.initialized = true;
      log.info('voice', '[AgentStats] Initialized', { agentCount: Object.keys(this.stats).length });
    } catch (error) {
      log.error('voice', '[AgentStats] Init error', { error: error });
      this.stats = {};
      this.bidHistory = [];
      this.initialized = true;
    }
  }

  /**
   * Save stats to disk
   */
  save() {
    try {
      fs.writeFileSync(this.statsFile, JSON.stringify(this.stats, null, 2));
      fs.writeFileSync(this.historyFile, JSON.stringify(this.bidHistory, null, 2));
    } catch (error) {
      log.error('voice', '[AgentStats] Save error', { error: error });
    }
  }

  /**
   * Get or create stats for an agent
   */
  getOrCreate(agentId) {
    if (!this.stats[agentId]) {
      this.stats[agentId] = {
        totalBids: 0,
        wins: 0,
        executions: 0,
        successes: 0,
        failures: 0,
        totalConfidence: 0,
        totalExecutionTimeMs: 0,
        minExecutionTimeMs: null,
        maxExecutionTimeMs: null,
        lastExecutionTimeMs: null,
        lastActive: null,
        createdAt: new Date().toISOString(),
      };
    }
    // Migration: add execution time fields if missing
    if (this.stats[agentId].totalExecutionTimeMs === undefined) {
      this.stats[agentId].totalExecutionTimeMs = 0;
      this.stats[agentId].minExecutionTimeMs = null;
      this.stats[agentId].maxExecutionTimeMs = null;
      this.stats[agentId].lastExecutionTimeMs = null;
    }
    return this.stats[agentId];
  }

  /**
   * Record a bid
   */
  recordBid(agentId, confidence, _taskContent) {
    const stats = this.getOrCreate(agentId);
    stats.totalBids++;
    stats.totalConfidence += confidence;
    stats.lastActive = new Date().toISOString();
    this.save();
  }

  /**
   * Record a win (agent was selected)
   */
  recordWin(agentId) {
    const stats = this.getOrCreate(agentId);
    stats.wins++;
    stats.lastActive = new Date().toISOString();
    this.save();
  }

  /**
   * Record an execution start
   */
  recordExecution(agentId) {
    const stats = this.getOrCreate(agentId);
    stats.executions++;
    stats.lastActive = new Date().toISOString();
    this.save();
  }

  /**
   * Record a successful execution with optional duration
   * @param {string} agentId
   * @param {number} [durationMs] - Execution time in milliseconds
   */
  recordSuccess(agentId, durationMs) {
    const stats = this.getOrCreate(agentId);
    stats.successes++;
    stats.lastActive = new Date().toISOString();

    // Track execution time if provided
    if (typeof durationMs === 'number' && durationMs >= 0) {
      stats.totalExecutionTimeMs += durationMs;
      stats.lastExecutionTimeMs = durationMs;

      if (stats.minExecutionTimeMs === null || durationMs < stats.minExecutionTimeMs) {
        stats.minExecutionTimeMs = durationMs;
      }
      if (stats.maxExecutionTimeMs === null || durationMs > stats.maxExecutionTimeMs) {
        stats.maxExecutionTimeMs = durationMs;
      }
    }

    this.save();
  }

  /**
   * Record a failed execution with optional duration
   * @param {string} agentId
   * @param {string} error
   * @param {number} [durationMs] - Execution time in milliseconds
   */
  recordFailure(agentId, error, durationMs) {
    const stats = this.getOrCreate(agentId);
    stats.failures++;
    stats.lastActive = new Date().toISOString();
    stats.lastError = error;
    stats.lastErrorAt = new Date().toISOString();

    // Track execution time even for failures
    if (typeof durationMs === 'number' && durationMs >= 0) {
      stats.totalExecutionTimeMs += durationMs;
      stats.lastExecutionTimeMs = durationMs;

      if (stats.minExecutionTimeMs === null || durationMs < stats.minExecutionTimeMs) {
        stats.minExecutionTimeMs = durationMs;
      }
      if (stats.maxExecutionTimeMs === null || durationMs > stats.maxExecutionTimeMs) {
        stats.maxExecutionTimeMs = durationMs;
      }
    }

    this.save();
  }

  /**
   * Record a complete bid event (for debugging)
   */
  recordBidEvent(event) {
    const { taskId, taskContent, bids, winner } = event;

    const bidEvent = {
      taskId,
      taskContent: taskContent?.substring(0, 100),
      timestamp: new Date().toISOString(),
      bids: bids.map((b) => ({
        agentId: b.agentId,
        agentName: b.agentName,
        confidence: b.confidence,
        reasoning: b.reasoning?.substring(0, 200),
        won: b.agentId === winner?.agentId,
      })),
      winnerId: winner?.agentId,
      winnerConfidence: winner?.confidence,
    };

    this.bidHistory.unshift(bidEvent);

    // Trim history
    if (this.bidHistory.length > this.maxHistorySize) {
      this.bidHistory = this.bidHistory.slice(0, this.maxHistorySize);
    }

    this.save();
  }

  /**
   * Get stats for an agent
   */
  getStats(agentId) {
    const stats = this.stats[agentId];
    if (!stats) return null;

    const completedExecutions = (stats.successes || 0) + (stats.failures || 0);

    return {
      ...stats,
      avgConfidence: stats.totalBids > 0 ? stats.totalConfidence / stats.totalBids : 0,
      winRate: stats.totalBids > 0 ? stats.wins / stats.totalBids : 0,
      successRate: stats.executions > 0 ? stats.successes / stats.executions : 0,
      avgExecutionTimeMs: completedExecutions > 0 ? Math.round(stats.totalExecutionTimeMs / completedExecutions) : null,
    };
  }

  /**
   * Get stats for all agents
   */
  getAllStats() {
    const result = {};
    for (const agentId of Object.keys(this.stats)) {
      result[agentId] = this.getStats(agentId);
    }
    return result;
  }

  /**
   * Get recent bid history
   */
  getBidHistory(limit = 50) {
    return this.bidHistory.slice(0, limit);
  }

  /**
   * Get bid history for a specific agent
   */
  getAgentBidHistory(agentId, limit = 20) {
    return this.bidHistory.filter((event) => event.bids.some((b) => b.agentId === agentId)).slice(0, limit);
  }

  /**
   * Clear stats for an agent
   */
  clearStats(agentId) {
    delete this.stats[agentId];
    this.save();
  }

  /**
   * Clear all stats
   */
  clearAllStats() {
    this.stats = {};
    this.bidHistory = [];
    this.save();
  }
}

// Singleton instance
let statsInstance = null;

function getAgentStats() {
  if (!statsInstance) {
    statsInstance = new AgentStatsTracker();
  }
  return statsInstance;
}

module.exports = {
  AgentStatsTracker,
  getAgentStats,
};
