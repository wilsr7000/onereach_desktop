/**
 * Shared types for task-exchange and task-agent packages
 */

// =============================================================================
// Task Types
// =============================================================================

export enum TaskStatus {
  PENDING = 'pending',           // Just created, not yet auctioned
  OPEN = 'open',                 // Auction open, collecting bids
  MATCHING = 'matching',         // Auction closed, calculating winner
  ASSIGNED = 'assigned',         // Winner selected, executing
  SETTLED = 'settled',           // Completed successfully
  BUSTED = 'busted',             // Execution failed, cascading
  CANCELLED = 'cancelled',       // User cancelled
  DEAD_LETTER = 'dead_letter',   // All agents failed, needs review
  HALTED = 'halted',             // Circuit breaker triggered
}

export enum TaskPriority {
  URGENT = 1,
  NORMAL = 2,
  LOW = 3,
}

export interface Task {
  id: string;
  content: string;
  metadata: Record<string, unknown>;
  status: TaskStatus;
  priority: TaskPriority;

  // Auction state
  auctionId: string | null;
  auctionAttempt: number;
  maxAuctionAttempts: number;

  // Execution state
  assignedAgent: string | null;
  backupQueue: string[];
  currentBackupIndex: number;

  // Timing
  createdAt: number;
  auctionOpenedAt: number | null;
  auctionClosedAt: number | null;
  assignedAt: number | null;
  timeoutAt: number | null;
  completedAt: number | null;

  // Result
  result: TaskResult | null;
  error: string | null;
}

export interface TaskResult {
  success: boolean;
  data?: unknown;
  error?: string;
  durationMs?: number;
}

// =============================================================================
// Bid Types
// =============================================================================

export type BidTier = 'keyword' | 'cache' | 'llm';

export interface Bid {
  agentId: string;
  agentVersion: string;
  confidence: number;        // 0.05 - 1.0 (tick size: 0.05)
  reasoning: string;
  estimatedTimeMs: number;
  timestamp: number;
  tier: BidTier;
}

export interface EvaluatedBid extends Bid {
  reputation: number;        // 0.1 - 1.0
  score: number;             // confidence × reputation
  rank: number;              // Position in order book (1 = winner)
}

// =============================================================================
// Agent Types
// =============================================================================

export interface AgentInfo {
  id: string;
  name: string;
  version: string;
  categories: string[];
  capabilities: AgentCapabilities;
}

export interface AgentCapabilities {
  quickMatch: boolean;       // Has fast keyword matching
  llmEvaluate: boolean;      // Has LLM evaluation
  maxConcurrent: number;     // How many tasks can run at once
}

export interface ConnectedAgent extends AgentInfo {
  connectedAt: number;
  lastHeartbeat: number;
  healthy: boolean;
  currentTasks: number;
}

// =============================================================================
// Reputation Types
// =============================================================================

export interface AgentReputation {
  agentId: string;
  version: string;
  score: number;
  totalTasks: number;
  successCount: number;
  failCount: number;
  timeoutCount: number;

  // Gaming prevention
  conservativeWins: number;
  versionResetAt: number;
  previousVersionScore: number;

  // Status
  flaggedForReview: boolean;
  flagReason: string | null;
  lastUpdated: number;
  lastDecayAt: number;
}

export interface ReputationConfig {
  initialScore: number;
  successIncrement: number;
  failureDecrement: number;
  timeoutDecrement: number;
  maxScore: number;
  minScore: number;
  flagThreshold: number;
  decayRate: number;
  neutralScore: number;
  versionResetCooldown: number;
  conservativeBidPenalty: number;
  conservativeBidThreshold: number;
}

// =============================================================================
// Protocol Types (WebSocket Messages)
// =============================================================================

export const PROTOCOL_VERSION = '1.0';

// Agent → Exchange
export interface RegisterMessage {
  type: 'register';
  protocolVersion: string;
  agentId: string;
  agentVersion: string;
  categories: string[];
  capabilities: AgentCapabilities;
  apiKey?: string;           // Optional auth
}

// Exchange → Agent
export interface RegisteredMessage {
  type: 'registered';
  protocolVersion: string;
  agentId: string;
  config: {
    heartbeatIntervalMs: number;
    defaultTimeoutMs: number;
  };
}

// Exchange → Agent
export interface BidRequest {
  type: 'bid_request';
  auctionId: string;
  task: Task;
  context: BiddingContext;
  deadline: number;          // Timestamp when bidding closes
}

export interface BiddingContext {
  queueDepth: number;
  conversationHistory: ConversationMessage[];
  participatingAgents: string[];
}

export interface ConversationMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
}

// Agent → Exchange
export interface BidResponse {
  type: 'bid_response';
  auctionId: string;
  agentId: string;
  agentVersion: string;
  bid: {
    confidence: number;
    reasoning: string;
    estimatedTimeMs: number;
    tier: BidTier;
  } | null;                  // null = no bid
}

// Exchange → Agent
export interface TaskAssignment {
  type: 'task_assignment';
  taskId: string;
  task: Task;
  isBackup: boolean;
  backupIndex: number;
  timeout: number;
  previousErrors: string[];
}

// Agent → Exchange
export interface TaskResultMessage {
  type: 'task_result';
  taskId: string;
  agentId: string;
  result: TaskResult;
}

// Heartbeat
export interface PingMessage {
  type: 'ping';
  timestamp: number;
}

export interface PongMessage {
  type: 'pong';
  timestamp: number;
}

// Errors
export interface ErrorMessage {
  type: 'error';
  code: string;
  message: string;
  details?: unknown;
}

// Union of all protocol messages
export type ProtocolMessage =
  | RegisterMessage
  | RegisteredMessage
  | BidRequest
  | BidResponse
  | TaskAssignment
  | TaskResultMessage
  | PingMessage
  | PongMessage
  | ErrorMessage;

// =============================================================================
// Configuration Types
// =============================================================================

export interface ExchangeConfig {
  port: number;
  transport: 'websocket' | 'local';
  storage: 'memory' | 'file';
  storagePath?: string;
  
  categories: CategoryConfig[];
  
  auction: AuctionConfig;
  reputation: ReputationConfig;
  rateLimit: RateLimitConfig;
  
  marketMaker?: MarketMakerConfig;
  
  heartbeatIntervalMs: number;
  heartbeatTimeoutMs: number;
}

export interface CategoryConfig {
  name: string;
  keywords: string[];
}

export interface AuctionConfig {
  defaultWindowMs: number;
  minWindowMs: number;
  maxWindowMs: number;
  instantWinThreshold: number;
  dominanceMargin: number;
  maxAuctionAttempts: number;
  executionTimeoutMs: number;
}

export interface RateLimitConfig {
  maxTasksPerMinute: number;
  maxTasksPerAgent: number;
  maxConcurrentAuctions: number;
  burstAllowance: number;
}

export interface MarketMakerConfig {
  enabled: boolean;
  confidence: number;
  agentId: string;
}

export interface AgentConfig {
  name: string;
  version: string;
  categories: string[];
  
  exchange: {
    url: string;
    apiKey?: string;
    reconnect: boolean;
    reconnectIntervalMs?: number;
    maxReconnectAttempts?: number;
  };
  
  capabilities?: Partial<AgentCapabilities>;
}

// =============================================================================
// Event Types
// =============================================================================

export interface ExchangeEvents {
  'exchange:started': { port: number };
  'exchange:shutdown_started': {};
  'exchange:shutdown_complete': {};
  'exchange:halt': { task: Task; reason: string };
  
  'agent:connected': { agent: ConnectedAgent };
  'agent:disconnected': { agentId: string; reason: string };
  'agent:unhealthy': { agentId: string };
  'agent:flagged': { agentId: string; version: string; reputation: AgentReputation };
  
  'auction:started': { task: Task; auctionId: string };
  'auction:candidates': { task: Task; categories: string[]; agents: string[] };
  'auction:closed': { task: Task; auctionId: string; bids: EvaluatedBid[] };
  
  'task:queued': { task: Task };
  'task:assigned': { 
    task: Task; 
    winner: EvaluatedBid; 
    backups: EvaluatedBid[];
    masterEvaluation?: {
      executionMode?: string;
      reasoning?: string;
      rejectedBids?: { agentId: string; reason: string }[];
      agentFeedback?: { agentId: string; feedback: string }[];
    } | null;
  };
  'master:evaluated': {
    task: Task;
    evaluation: {
      winners: string[];
      executionMode: string;
      reasoning: string;
      rejectedBids?: { agentId: string; reason: string }[];
      agentFeedback?: { agentId: string; feedback: string }[];
    };
    selectedWinner: EvaluatedBid;
    allBids: EvaluatedBid[];
  };
  'task:executing': { task: Task; agentId: string; attempt: number };
  'task:settled': { task: Task; result: TaskResult; agentId: string; attempt: number };
  'task:busted': { task: Task; agentId: string; error: string; isTimeout: boolean; backupsRemaining: number };
  'task:cancelled': { task: Task; reason?: string };
  'task:dead_letter': { task: Task; reason: string; totalAttempts: number };
  'task:agent_disconnected': { task: Task; agentId: string };
}

export interface AgentEvents {
  'agent:connected': { exchangeUrl: string };
  'agent:disconnected': { reason: string };
  'agent:reconnecting': { attempt: number };
  'agent:registered': { agentId: string };
  
  'bid:requested': { auctionId: string; task: Task };
  'bid:submitted': { auctionId: string; confidence: number };
  'bid:skipped': { auctionId: string; reason: string };
  
  'task:assigned': { task: Task; isBackup: boolean };
  'task:executing': { taskId: string };
  'task:completed': { taskId: string; success: boolean };
  'task:failed': { taskId: string; error: string };
}
