/**
 * Order Book - Collects and ranks bids atomically
 */
import { Mutex } from '../utils/mutex.js';
import type { Bid, EvaluatedBid, AgentReputation } from '../types/index.js';

const TICK_SIZE = 0.05;
const MIN_CONFIDENCE = 0.05;

export interface ReputationProvider {
  get(agentId: string, version: string): Promise<AgentReputation>;
}

export class OrderBook {
  private bids: Map<string, Bid> = new Map();
  private closed = false;
  private mutex = new Mutex();
  private auctionId: string;

  constructor(auctionId: string) {
    this.auctionId = auctionId;
  }

  /**
   * Submit a bid to the order book
   * Returns true if accepted, false if rejected
   */
  async submitBid(bid: Bid): Promise<boolean> {
    return this.mutex.runExclusive(async () => {
      // Reject if order book is closed
      if (this.closed) {
        console.warn(`[OrderBook] Rejected late bid from ${bid.agentId} - auction closed`);
        return false;
      }

      // Validate and normalize tick size
      let confidence = bid.confidence;
      if (confidence % TICK_SIZE !== 0) {
        confidence = Math.round(confidence / TICK_SIZE) * TICK_SIZE;
      }

      // Validate minimum confidence
      if (confidence < MIN_CONFIDENCE) {
        console.warn(`[OrderBook] Rejected bid from ${bid.agentId} - confidence too low: ${confidence}`);
        return false;
      }

      // Validate maximum confidence
      if (confidence > 1.0) {
        confidence = 1.0;
      }

      // Store bid (overwrites any previous bid from same agent)
      this.bids.set(bid.agentId, {
        ...bid,
        confidence,
      });

      console.log(`[OrderBook] Bid accepted: ${bid.agentId} @ ${confidence} (${bid.tier})`);
      return true;
    });
  }

  /**
   * Close the order book - no more bids accepted
   */
  async close(): Promise<void> {
    await this.mutex.runExclusive(() => {
      this.closed = true;
      console.log(`[OrderBook] Closed with ${this.bids.size} bids`);
    });
  }

  /**
   * Check if order book is closed
   */
  isClosed(): boolean {
    return this.closed;
  }

  /**
   * Get bid count
   */
  getBidCount(): number {
    return this.bids.size;
  }

  /**
   * Evaluate all bids and return ranked list
   * Must be called after close()
   */
  async evaluateAndRank(reputationProvider: ReputationProvider): Promise<EvaluatedBid[]> {
    return this.mutex.runExclusive(async () => {
      if (!this.closed) {
        throw new Error('Cannot evaluate - order book not closed');
      }

      const evaluated: EvaluatedBid[] = [];

      // Evaluate each bid
      for (const [agentId, bid] of this.bids) {
        const reputation = await reputationProvider.get(agentId, bid.agentVersion);
        const score = bid.confidence * reputation.score;

        evaluated.push({
          ...bid,
          reputation: reputation.score,
          score,
          rank: 0, // Set below after sorting
        });
      }

      // Sort by score descending
      evaluated.sort((a, b) => {
        // Primary: score descending
        if (b.score !== a.score) {
          return b.score - a.score;
        }
        // Secondary: timestamp ascending (earlier bid wins ties)
        return a.timestamp - b.timestamp;
      });

      // Assign ranks
      evaluated.forEach((bid, index) => {
        bid.rank = index + 1;
      });

      console.log(`[OrderBook] Ranked ${evaluated.length} bids:`);
      evaluated.slice(0, 5).forEach((bid) => {
        console.log(`  #${bid.rank}: ${bid.agentId} - score=${bid.score.toFixed(3)} ` +
          `(conf=${bid.confidence.toFixed(2)} × rep=${bid.reputation.toFixed(2)})`);
      });

      return evaluated;
    });
  }

  /**
   * Get all raw bids (for debugging)
   */
  getBids(): Map<string, Bid> {
    return new Map(this.bids);
  }

  /**
   * Get auction ID
   */
  getAuctionId(): string {
    return this.auctionId;
  }
}
