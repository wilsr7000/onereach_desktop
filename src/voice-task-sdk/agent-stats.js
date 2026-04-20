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
    this.timelineFile = null;
    this.stats = {};
    this.bidHistory = [];
    this.taskTimeline = []; // Ring buffer of lifecycle events across tasks
    this.maxHistorySize = 100; // Keep last 100 bid events
    this.maxTimelineSize = 2000; // Keep last 2000 lifecycle events (~100 tasks * ~20 events)
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
      this.timelineFile = path.join(this.statsDir, 'task-timeline.json');

      // Ensure directory exists
      if (!fs.existsSync(this.statsDir)) {
        fs.mkdirSync(this.statsDir, { recursive: true });
      }

      // Load existing stats
      if (fs.existsSync(this.statsFile)) {
        const data = fs.readFileSync(this.statsFile, 'utf8');
        this.stats = JSON.parse(data);
      }

      // Load existing bid history
      if (fs.existsSync(this.historyFile)) {
        const data = fs.readFileSync(this.historyFile, 'utf8');
        this.bidHistory = JSON.parse(data);
      }

      // Load existing task timeline (lifecycle events). Missing file is fine --
      // this file was introduced in Phase 0 of the agent-system upgrade.
      if (fs.existsSync(this.timelineFile)) {
        try {
          const data = fs.readFileSync(this.timelineFile, 'utf8');
          const parsed = JSON.parse(data);
          if (Array.isArray(parsed)) this.taskTimeline = parsed;
        } catch (_err) {
          log.warn('voice', '[AgentStats] Timeline file corrupted, starting fresh');
          this.taskTimeline = [];
        }
      }

      this.initialized = true;
      log.info('voice', '[AgentStats] Initialized', { agentCount: Object.keys(this.stats).length });
    } catch (error) {
      log.error('voice', '[AgentStats] Init error', { error: error });
      this.stats = {};
      this.bidHistory = [];
      this.taskTimeline = [];
      this.initialized = true;
    }
  }

  /**
   * Save stats to disk. No-op when the tracker hasn't been initialized
   * yet (statsFile is null) -- this avoids throwing "path must be a
   * string" every time a caller happens to record before init. In
   * practice init() is awaited during app boot, but tests or library
   * callers that skip it still behave cleanly.
   */
  save() {
    if (!this.statsFile || !this.historyFile) {
      // Not initialized yet -- caller is responsible for calling init()
      // before expecting persistence. In-memory state is still valid.
      return;
    }
    try {
      fs.writeFileSync(this.statsFile, JSON.stringify(this.stats, null, 2));
      fs.writeFileSync(this.historyFile, JSON.stringify(this.bidHistory, null, 2));
      if (this.timelineFile) {
        fs.writeFileSync(this.timelineFile, JSON.stringify(this.taskTimeline, null, 2));
      }
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

  // ==================== TASK TIMELINE (Phase 0) ====================
  // Persisted ring buffer of per-task lifecycle events. Replaces the
  // in-memory-only event bus for consumers that need history -- e.g. the
  // HUD reconstructing a task's bidding trail, the flow-extraction
  // gateway replaying past events for an SSE subscriber.
  //
  // Event shape: { taskId, type, at, data? }
  //   type examples: 'queued' | 'bids-collected' | 'assigned' |
  //     'progress' | 'needs-input' | 'disambiguation' |
  //     'completed' | 'failed' | 'cancelled' | 'consolidation:conflicts'
  //
  // This is append-only; prunes when the buffer exceeds maxTimelineSize.
  // Keep event payloads small -- large data belongs in agent-memory, not
  // here.

  /**
   * Append a lifecycle event for a task.
   *
   * @param {Object} event
   * @param {string} event.taskId - Required. Task id the event belongs to.
   * @param {string} event.type   - Required. Event type (see list above).
   * @param {number} [event.at]   - Timestamp (ms); defaults to Date.now().
   * @param {Object} [event.data] - Optional small JSON-safe payload.
   * @returns {Object|null} The recorded event, or null on validation failure.
   */
  recordTaskLifecycle(event) {
    if (!event || typeof event !== 'object') return null;
    const { taskId, type } = event;
    if (!taskId || typeof taskId !== 'string') return null;
    if (!type || typeof type !== 'string') return null;

    const full = {
      taskId,
      type,
      at: typeof event.at === 'number' ? event.at : Date.now(),
    };
    if (event.data !== undefined) full.data = event.data;

    // Append most-recent-last. Readers typically want chronological order.
    this.taskTimeline.push(full);

    // Trim oldest entries once we exceed the cap.
    if (this.taskTimeline.length > this.maxTimelineSize) {
      const overflow = this.taskTimeline.length - this.maxTimelineSize;
      this.taskTimeline.splice(0, overflow);
    }

    this.save();
    return full;
  }

  /**
   * Get all lifecycle events for a task, oldest-first.
   *
   * @param {string} taskId
   * @returns {Array}
   */
  getTaskTimeline(taskId) {
    if (!taskId) return [];
    return this.taskTimeline.filter((e) => e.taskId === taskId);
  }

  /**
   * Get the most recent lifecycle events across all tasks.
   *
   * @param {number} [limit=100]
   * @returns {Array}
   */
  getRecentLifecycle(limit = 100) {
    if (limit >= this.taskTimeline.length) return [...this.taskTimeline];
    return this.taskTimeline.slice(this.taskTimeline.length - limit);
  }

  /**
   * Clear timeline entries older than the given cutoff.
   * Useful for periodic housekeeping. Returns number removed.
   *
   * @param {number} olderThanMs
   * @returns {number}
   */
  pruneTaskTimeline(olderThanMs) {
    const cutoff = Date.now() - olderThanMs;
    const before = this.taskTimeline.length;
    this.taskTimeline = this.taskTimeline.filter((e) => e.at >= cutoff);
    const removed = before - this.taskTimeline.length;
    if (removed > 0) this.save();
    return removed;
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
    this.taskTimeline = [];
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

/**
 * Test-only: reset the singleton so the next getAgentStats() call
 * produces a fresh tracker that re-reads disk state. Avoids cross-test
 * singleton leakage when tests mock electron's userData path.
 */
function _resetAgentStatsForTests() {
  statsInstance = null;
}

module.exports = {
  AgentStatsTracker,
  getAgentStats,
  _resetAgentStatsForTests,
};
