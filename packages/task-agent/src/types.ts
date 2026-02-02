/**
 * Agent-side types
 * 
 * Core types are imported from @onereach/task-exchange/types
 * This file contains agent-specific types
 */

// Re-export from exchange for convenience
export type {
  Task,
  TaskStatus,
  TaskPriority,
  TaskResult,
  Bid,
  BidTier,
  BidRequest,
  BidResponse,
  TaskAssignment,
  TaskResultMessage,
  AgentCapabilities,
  BiddingContext,
  PingMessage,
  PongMessage,
  ErrorMessage,
  ProtocolMessage,
} from '@onereach/task-exchange/types';

export { PROTOCOL_VERSION } from '@onereach/task-exchange/types';

// Import types we need locally
import type { 
  Task, 
  TaskResult, 
  BiddingContext, 
  AgentCapabilities 
} from '@onereach/task-exchange/types';

// Agent-specific types

export interface AgentConfig {
  /** Unique agent identifier */
  name: string;
  
  /** Semantic version (bump to reset reputation) */
  version: string;
  
  /** Categories this agent handles */
  categories: string[];
  
  /** Exchange connection settings */
  exchange: {
    url: string;
    apiKey?: string;
    reconnect?: boolean;
    reconnectIntervalMs?: number;
    maxReconnectAttempts?: number;
  };
  
  /** Agent capabilities */
  capabilities?: Partial<AgentCapabilities>;
}

export interface ExecutionContext {
  /** AbortSignal for cancellation */
  signal: AbortSignal;
  
  /** Timeout in milliseconds */
  timeout: number;
  
  /** Which attempt this is (1 = first) */
  attempt: number;
  
  /** True if executing as backup */
  isBackup: boolean;
  
  /** Errors from previous attempts */
  previousErrors: string[];
}

export interface BidDecision {
  /** Whether to bid */
  shouldBid: boolean;
  
  /** Confidence level (0.05 - 1.0) */
  confidence: number;
  
  /** Reasoning for the bid */
  reasoning: string;
  
  /** Estimated execution time in ms */
  estimatedTimeMs: number;
  
  /** How the decision was made */
  tier: 'keyword' | 'cache' | 'llm';
}

export interface AgentHandlers {
  /**
   * Fast keyword matching (Tier 1)
   * Return 0 to skip, 0.9+ for confident match
   */
  quickMatch?: (task: Task) => number;
  
  /**
   * LLM-based evaluation (Tier 2)
   * Called when quickMatch returns 0 < score < 0.9
   * Return null to skip bidding
   */
  evaluate?: (task: Task, context: BiddingContext) => Promise<BidDecision | null>;
  
  /**
   * Execute the task
   */
  execute: (task: Task, context: ExecutionContext) => Promise<TaskResult>;
}
