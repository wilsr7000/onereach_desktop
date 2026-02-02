/**
 * Reputation Store - Manages agent reputation scores
 */
import type { AgentReputation, ReputationConfig, Bid } from '../types/index.js';
import type { StorageAdapter } from '../storage/adapter.js';
import { TypedEventEmitter } from '../utils/events.js';

const DEFAULT_CONFIG: ReputationConfig = {
  initialScore: 1.0,
  successIncrement: 0.05,
  failureDecrement: 0.15,
  timeoutDecrement: 0.20,
  maxScore: 1.0,
  minScore: 0.1,
  flagThreshold: 0.3,
  decayRate: 0.01,
  neutralScore: 0.7,
  versionResetCooldown: 86400000, // 24 hours
  conservativeBidPenalty: 0.02,
  conservativeBidThreshold: 0.3,
};

interface ReputationEvents {
  'agent:flagged': { agentId: string; version: string; reputation: AgentReputation };
  'reputation:updated': { agentId: string; version: string; oldScore: number; newScore: number };
}

export class ReputationStore extends TypedEventEmitter<ReputationEvents> {
  private storage: StorageAdapter;
  private config: ReputationConfig;
  private cache: Map<string, AgentReputation> = new Map();

  constructor(storage: StorageAdapter, config: Partial<ReputationConfig> = {}) {
    super();
    this.storage = storage;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Get reputation for an agent version
   */
  async get(agentId: string, version: string): Promise<AgentReputation> {
    const key = this.getKey(agentId, version);

    // Check cache first
    if (this.cache.has(key)) {
      const cached = this.cache.get(key)!;
      return this.applyDecay(cached);
    }

    // Check storage
    let rep = await this.storage.get<AgentReputation>(key);

    if (!rep) {
      // Check for version reset abuse
      const previousVersion = await this.findPreviousVersion(agentId);
      if (previousVersion) {
        const previousRep = await this.storage.get<AgentReputation>(
          this.getKey(agentId, previousVersion)
        );
        if (previousRep && this.isVersionResetTooSoon(previousRep)) {
          // Carry forward previous score (abuse prevention)
          console.warn(`[Reputation] Version reset too soon for ${agentId}, carrying forward score`);
          rep = this.createRep(agentId, version, previousRep.score);
        }
      }

      // Create fresh reputation if still null
      if (!rep) {
        rep = this.createRep(agentId, version, this.config.initialScore);
      }

      await this.save(rep);
    }

    // Apply decay
    rep = await this.applyDecay(rep);

    // Update cache
    this.cache.set(key, rep);

    return rep;
  }

  /**
   * Record a successful task completion
   */
  async recordSuccess(agentId: string, version: string, bid?: Bid): Promise<void> {
    const rep = await this.get(agentId, version);
    const oldScore = rep.score;

    rep.totalTasks++;
    rep.successCount++;
    rep.score = Math.min(this.config.maxScore, rep.score + this.config.successIncrement);

    // Check for conservative bidding pattern (gaming prevention)
    if (bid && bid.confidence < this.config.conservativeBidThreshold) {
      rep.conservativeWins++;

      // Penalize consistent conservative winning
      const conservativeRatio = rep.conservativeWins / rep.successCount;
      if (rep.conservativeWins > 5 && conservativeRatio > 0.5) {
        rep.score = Math.max(this.config.minScore, rep.score - this.config.conservativeBidPenalty);
        console.warn(`[Reputation] ${agentId} penalized for conservative bidding pattern`);
      }
    }

    rep.lastUpdated = Date.now();
    await this.save(rep);

    this.emit('reputation:updated', { agentId, version, oldScore, newScore: rep.score });
    console.log(`[Reputation] ${agentId} v${version}: success -> ${rep.score.toFixed(3)}`);
  }

  /**
   * Record a task failure
   */
  async recordFailure(
    agentId: string,
    version: string,
    details: { isTimeout: boolean; error: string }
  ): Promise<void> {
    const rep = await this.get(agentId, version);
    const oldScore = rep.score;

    rep.totalTasks++;
    rep.failCount++;

    if (details.isTimeout) {
      rep.timeoutCount++;
      rep.score = Math.max(this.config.minScore, rep.score - this.config.timeoutDecrement);
    } else {
      rep.score = Math.max(this.config.minScore, rep.score - this.config.failureDecrement);
    }

    // Flag for review if below threshold
    if (rep.score < this.config.flagThreshold && !rep.flaggedForReview) {
      rep.flaggedForReview = true;
      rep.flagReason = `Score dropped to ${rep.score.toFixed(2)} after ${rep.failCount} failures`;
      this.emit('agent:flagged', { agentId, version, reputation: rep });
    }

    rep.lastUpdated = Date.now();
    await this.save(rep);

    this.emit('reputation:updated', { agentId, version, oldScore, newScore: rep.score });
    console.log(`[Reputation] ${agentId} v${version}: ${details.isTimeout ? 'timeout' : 'failure'} -> ${rep.score.toFixed(3)}`);
  }

  /**
   * Get all flagged agents
   */
  async getFlaggedAgents(): Promise<AgentReputation[]> {
    const allKeys = await this.storage.list('rep:');
    const flagged: AgentReputation[] = [];

    for (const key of allKeys) {
      const rep = await this.storage.get<AgentReputation>(key);
      if (rep?.flaggedForReview) {
        flagged.push(rep);
      }
    }

    return flagged;
  }

  /**
   * Clear flag for an agent (after review/fix)
   */
  async clearFlag(agentId: string, version: string): Promise<void> {
    const rep = await this.get(agentId, version);
    rep.flaggedForReview = false;
    rep.flagReason = null;
    await this.save(rep);
  }

  /**
   * Get reputation summary for all agents
   */
  async getSummary(): Promise<Map<string, { score: number; tasks: number; flagged: boolean }>> {
    const allKeys = await this.storage.list('rep:');
    const summary = new Map<string, { score: number; tasks: number; flagged: boolean }>();

    for (const key of allKeys) {
      const rep = await this.storage.get<AgentReputation>(key);
      if (rep) {
        summary.set(`${rep.agentId}:${rep.version}`, {
          score: rep.score,
          tasks: rep.totalTasks,
          flagged: rep.flaggedForReview,
        });
      }
    }

    return summary;
  }

  // === Private Methods ===

  private getKey(agentId: string, version: string): string {
    return `rep:${agentId}:${version}`;
  }

  private createRep(agentId: string, version: string, score: number): AgentReputation {
    return {
      agentId,
      version,
      score,
      totalTasks: 0,
      successCount: 0,
      failCount: 0,
      timeoutCount: 0,
      conservativeWins: 0,
      versionResetAt: Date.now(),
      previousVersionScore: score,
      flaggedForReview: false,
      flagReason: null,
      lastUpdated: Date.now(),
      lastDecayAt: Date.now(),
    };
  }

  private async save(rep: AgentReputation): Promise<void> {
    const key = this.getKey(rep.agentId, rep.version);
    await this.storage.set(key, rep);
    this.cache.set(key, rep);
  }

  private async applyDecay(rep: AgentReputation): Promise<AgentReputation> {
    const now = Date.now();
    const daysSinceDecay = (now - rep.lastDecayAt) / 86400000;

    if (daysSinceDecay >= 1) {
      const decayAmount = this.config.decayRate * Math.floor(daysSinceDecay);

      // Decay towards neutral
      if (rep.score > this.config.neutralScore) {
        rep.score = Math.max(this.config.neutralScore, rep.score - decayAmount);
      } else if (rep.score < this.config.neutralScore) {
        rep.score = Math.min(this.config.neutralScore, rep.score + decayAmount);
      }

      rep.lastDecayAt = now;
      await this.save(rep);
    }

    return rep;
  }

  private isVersionResetTooSoon(previousRep: AgentReputation): boolean {
    const timeSinceReset = Date.now() - previousRep.versionResetAt;
    return timeSinceReset < this.config.versionResetCooldown;
  }

  private async findPreviousVersion(agentId: string): Promise<string | null> {
    const prefix = `rep:${agentId}:`;
    const keys = await this.storage.list(prefix);

    if (keys.length === 0) return null;

    // Find the most recent version
    let latest: { key: string; timestamp: number } | null = null;

    for (const key of keys) {
      const rep = await this.storage.get<AgentReputation>(key);
      if (rep && (!latest || rep.versionResetAt > latest.timestamp)) {
        latest = { key, timestamp: rep.versionResetAt };
      }
    }

    if (latest) {
      // Extract version from key: rep:agentId:version
      const parts = latest.key.split(':');
      return parts[2] || null;
    }

    return null;
  }
}
