/**
 * Rate Limiter - Prevents flooding
 */
import type { RateLimitConfig } from '../types/index.js';

const DEFAULT_CONFIG: RateLimitConfig = {
  maxTasksPerMinute: 100,
  maxTasksPerAgent: 20,
  maxConcurrentAuctions: 10,
  burstAllowance: 2,
};

export interface RateLimitResult {
  allowed: boolean;
  retryAfterMs?: number;
  reason?: string;
}

export class RateLimiter {
  private config: RateLimitConfig;
  private taskTimestamps: number[] = [];
  private agentTimestamps: Map<string, number[]> = new Map();
  private activeAuctions = 0;

  constructor(config: Partial<RateLimitConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Check if a task submission is allowed
   */
  canSubmit(agentId?: string): RateLimitResult {
    const now = Date.now();
    const oneMinuteAgo = now - 60000;

    // Clean old timestamps
    this.taskTimestamps = this.taskTimestamps.filter(t => t > oneMinuteAgo);

    // Check global rate
    if (this.taskTimestamps.length >= this.config.maxTasksPerMinute) {
      const oldestInWindow = this.taskTimestamps[0];
      return {
        allowed: false,
        retryAfterMs: oldestInWindow + 60000 - now,
        reason: 'Global rate limit exceeded',
      };
    }

    // Check concurrent auctions
    if (this.activeAuctions >= this.config.maxConcurrentAuctions) {
      return {
        allowed: false,
        retryAfterMs: 100, // Retry soon
        reason: 'Too many concurrent auctions',
      };
    }

    // Check per-agent rate (if specified)
    if (agentId) {
      const agentTs = this.agentTimestamps.get(agentId) ?? [];
      const recentAgentTs = agentTs.filter(t => t > oneMinuteAgo);

      if (recentAgentTs.length >= this.config.maxTasksPerAgent) {
        return {
          allowed: false,
          retryAfterMs: recentAgentTs[0] + 60000 - now,
          reason: `Agent ${agentId} rate limit exceeded`,
        };
      }
    }

    return { allowed: true };
  }

  /**
   * Record a task submission
   */
  recordSubmission(agentId?: string): void {
    const now = Date.now();
    this.taskTimestamps.push(now);

    if (agentId) {
      const agentTs = this.agentTimestamps.get(agentId) ?? [];
      agentTs.push(now);
      this.agentTimestamps.set(agentId, agentTs);
    }
  }

  /**
   * Mark an auction as started
   */
  auctionStarted(): void {
    this.activeAuctions++;
  }

  /**
   * Mark an auction as ended
   */
  auctionEnded(): void {
    this.activeAuctions = Math.max(0, this.activeAuctions - 1);
  }

  /**
   * Get current stats
   */
  getStats(): {
    tasksLastMinute: number;
    activeAuctions: number;
    agentStats: Map<string, number>;
  } {
    const now = Date.now();
    const oneMinuteAgo = now - 60000;

    // Clean and count
    this.taskTimestamps = this.taskTimestamps.filter(t => t > oneMinuteAgo);

    const agentStats = new Map<string, number>();
    for (const [agentId, timestamps] of this.agentTimestamps) {
      const recent = timestamps.filter(t => t > oneMinuteAgo);
      this.agentTimestamps.set(agentId, recent);
      if (recent.length > 0) {
        agentStats.set(agentId, recent.length);
      }
    }

    return {
      tasksLastMinute: this.taskTimestamps.length,
      activeAuctions: this.activeAuctions,
      agentStats,
    };
  }

  /**
   * Reset all limits (for testing)
   */
  reset(): void {
    this.taskTimestamps = [];
    this.agentTimestamps.clear();
    this.activeAuctions = 0;
  }
}
